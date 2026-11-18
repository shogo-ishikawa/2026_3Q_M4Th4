#!/usr/bin/env python3
"""Train on every available owned record and the history allowed by the API key.

Without a key the API permits seven days. THEMEPARKS_API_KEY is read only from the
environment; /me determines its actual window and remaining budget. Raw history
stays outside the checkout. Reusing --private-dir resumes a licensed backfill.
Only derived models and protected statistics belong in public output.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

PROJECT = Path(__file__).resolve().parents[1]
API = 'https://api.themeparks.wiki/v1'
JST = dt.timezone(dt.timedelta(hours=9))
PARK_IDS = {'land': '3cc919f1-d16d-43e0-8c3f-1dd269bd1a42',
            'sea': '67b290d5-3478-4f23-b601-2f8fb71ba803'}
SOURCES = [{'name': 'ThemeParks.wiki', 'url': 'https://www.themeparks.wiki/',
            'kind': 'permitted-historical-waits', 'attribution': 'Powered by ThemeParks.wiki',
            'termsUrl': 'https://www.themeparks.wiki/terms'},
           {'name': 'Open-Meteo', 'url': 'https://open-meteo.com/',
            'kind': 'past-weather-forecast', 'attribution': 'Weather data by Open-Meteo.com',
            'licenceUrl': 'https://creativecommons.org/licenses/by/4.0/'}]


def request_json(url: str, *, api_key: str | None = None) -> dict:
    headers={'User-Agent': 'ParkItineraryLab/1.4 (educational forecast training)'}
    if api_key:
        if not url.startswith(API+'/'):
            raise ValueError('API credentials are restricted to the documented API origin.')
        headers['X-API-Key']=api_key
    request = urllib.request.Request(url, headers=headers)
    class OriginBoundRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, message, response_headers, new_url):
            if api_key and not new_url.startswith(API+'/'):
                raise ValueError('Refusing to forward API credentials to another origin.')
            return super().redirect_request(request,fp,code,message,response_headers,new_url)
    with urllib.request.build_opener(OriginBoundRedirect()).open(request, timeout=25) as response:
        raw = response.read(16_000_001)
    if len(raw) > 16_000_000:
        raise ValueError('Response is larger than the permitted training input.')
    return json.loads(raw)


def accessible_window(today: dt.date, end: dt.date, *, account=None, coverage=None,
                      days=None, start_date=None) -> tuple[dt.date, dt.date]:
    """Intersect requested dates, the key entitlement, and actually held coverage."""
    if end>today:raise ValueError('History cannot include a future date.')
    if account is None:
        earliest=today-dt.timedelta(days=6)
    elif account.get('historyAllArchive') is True:
        first=(coverage or {}).get('summary',{}).get('archiveFrom')
        if not first:raise ValueError('Full-history access requires the provider coverage start.')
        earliest=dt.date.fromisoformat(first)
    else:
        count=account.get('historyDays')
        if not isinstance(count,int) or isinstance(count,bool) or not 1<=count<=100000:
            raise ValueError('The API did not return a valid history entitlement.')
        earliest=today-dt.timedelta(days=count-1)
        # The API's UTC boundary may be one day more restrictive around Tokyo midnight.
        if account.get('historyEarliestDate'):
            earliest=max(earliest,dt.date.fromisoformat(account['historyEarliestDate']))
    first=(coverage or {}).get('summary',{}).get('archiveFrom')
    last=(coverage or {}).get('summary',{}).get('retrievableThrough')
    if first:earliest=max(earliest,dt.date.fromisoformat(first))
    if last:end=min(end,dt.date.fromisoformat(last))
    if days is not None:earliest=max(earliest,end-dt.timedelta(days=days-1))
    if start_date:earliest=max(earliest,dt.date.fromisoformat(start_date))
    return earliest,end


def request_budget(account, requested):
    if account is None:return min(requested,54) # Reserve coverage requests within the anonymous 60/h.
    budget=account.get('historyRateLimit',{})
    if budget.get('unmetered') is True:return requested
    remaining=budget.get('remaining')
    if not isinstance(remaining,int) or isinstance(remaining,bool):return 0
    return max(0,min(requested,remaining-4))


def timestamp(value: object) -> dt.datetime | None:
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return parsed if parsed.tzinfo else None
    except (ValueError, TypeError):
        return None


def entity_mapping(children: dict, park: dict) -> dict[str, str]:
    """The provider externalId is the official TDR facility ID, not a fuzzy name match."""
    activities = {item['id']: item for item in park['activities']}
    result = {}
    for entity in children.get('children', []):
        if entity.get('entityType') != 'ATTRACTION':
            continue
        local_id = f"{park['id']}-attraction-{entity.get('externalId')}"
        if local_id in activities and activities[local_id].get('category') == 'attraction':
            result[entity['id']] = local_id
    return result


def opening_minute(park: dict, date: str) -> int:
    values = []
    for activity in park['activities']:
        schedule = activity.get('dailySchedules', {}).get(date, {})
        windows = schedule.get('windows') or activity.get('windows', [])
        if schedule.get('closed'):
            continue
        values.extend(pair[0] for pair in windows if len(pair) == 2 and isinstance(pair[0], int) and 360 <= pair[0] <= 720)
    return min(values, default=540)


def normalise_history(payload: dict, park: dict, mapping: dict[str, str], date: str,
                      *, now: dt.datetime | None = None, keep_changes: bool = False) -> list[dict]:
    """Use observed changes only; never manufacture a zero or fill an absent day."""
    now = now or dt.datetime.now(dt.timezone.utc)
    if payload.get('id') != PARK_IDS[park['id']] or payload.get('timezone') != 'Asia/Tokyo':
        raise ValueError('History is for another park or timezone.')
    if payload.get('range', {}).get('from') != date or payload.get('range', {}).get('to') != date:
        raise ValueError('History date does not match the requested day.')
    if payload.get('next'):
        raise ValueError('A park-day response unexpectedly requires pagination.')
    opening = opening_minute(park, date)
    buckets = {}
    for entity in payload.get('entities', []):
        activity_id = mapping.get(entity.get('id'))
        if not activity_id:
            continue
        events = list(entity.get('history', []))
        carried = entity.get('opening') or {}
        # Opening can carry a value from weeks ago. Only a same-day actual observation is eligible.
        by_kind = carried.get('observedAtByKind')
        observed = timestamp(by_kind.get('queue.STANDBY') if isinstance(by_kind, dict) else carried.get('observedAt'))
        if not carried.get('degraded') and observed and observed.astimezone(JST).date().isoformat() == date:
            events.append({**carried, 'time': observed.isoformat()})
        for event in events:
            # A history row contains the whole ride state. A change to another
            # queue or to the operating status does not timestamp the standby wait.
            if 'changed' in event:
                changed = event['changed']
                if not isinstance(changed, list) or 'queue.STANDBY.waitTime' not in changed:
                    continue
            at = timestamp(event.get('time'))
            wait = ((event.get('queue') or {}).get('STANDBY') or {}).get('waitTime')
            if (not at or at > now or at.astimezone(JST).date().isoformat() != date
                    or event.get('status') != 'OPERATING' or not isinstance(wait, (int, float))
                    or isinstance(wait, bool) or not math.isfinite(wait) or not 0 <= wait <= 600):
                continue
            local = at.astimezone(JST)
            minute = local.hour * 60 + local.minute
            width = 10 if opening <= minute < opening + 90 else 30
            key = (activity_id, at) if keep_changes else (activity_id, minute // width, width)
            row = {'date': date, 'activityId': activity_id, 'time': minute, 'wait': wait,
                   'openingMinute': opening, 'weather': '', 'temperature': None, 'precipitation': None,
                   'event': '|'.join(item['id'] for item in park.get('events', [])
                                    if item['startDate'] <= date <= item['endDate']),
                   'source': 'themeparks-wiki', 'observedAt': at.isoformat().replace('+00:00', 'Z')}
            if key not in buckets or row['observedAt'] > buckets[key]['observedAt']:
                buckets[key] = row
    return sorted(buckets.values(), key=lambda item: (item['date'], item['time'], item['activityId']))


def weather_lookup(payload: dict) -> dict[str, dict]:
    hourly = payload.get('hourly') or {}
    result = {}
    for index, time in enumerate(hourly.get('time', [])):
        def value(key):
            values = hourly.get(key) or []
            number = values[index] if index < len(values) else None
            return number if isinstance(number, (int, float)) and not isinstance(number, bool) and math.isfinite(number) else None
        code = value('weather_code')
        result[time[:13]] = {'weather': '' if code is None else 'sun' if code == 0 else 'cloud' if code <= 3 or code in (45, 48) else 'rain',
                            'temperature': value('temperature_2m'), 'precipitation': value('precipitation'),
                            'weatherSource': 'open-meteo-past-forecast'}
    return result


def enrich_weather(rows: list[dict], lookup: dict[str, dict]) -> list[dict]:
    return [{**row, **lookup.get(row['date'] + 'T' + str(row['time'] // 60).zfill(2), {})} for row in rows]


def eligible_input(rows, catalogue, end):
    known={activity['id'] for park in catalogue['parks'] for activity in park['activities']}
    result=[]
    for row in rows:
        if not isinstance(row,dict) or not isinstance(row.get('activityId'),str) or row['activityId'] not in known:continue
        try:day=dt.date.fromisoformat(row.get('date',''))
        except (ValueError,TypeError):continue
        minute=row.get('time');wait=row.get('wait')
        if day>end or not isinstance(minute,int) or isinstance(minute,bool) or not 0<=minute<1440:continue
        if not isinstance(wait,(int,float)) or isinstance(wait,bool) or not math.isfinite(wait) or not 0<=wait<=600 or row.get('isOpen') is False or row.get('status') in ('CLOSED','DOWN','REFURBISHMENT'):continue
        result.append(row)
    return result


def fetch_day(park: dict, mapping: dict, date: str, private_dir: Path, *, fetcher=request_json,
              refresh=False, stop=None) -> tuple[list[dict], dict]:
    cache = private_dir / f"{park['id']}-history-{date}.json"
    url = f"{API}/entity/{PARK_IDS[park['id']]}/history?date={date}"
    try:
        cached=cache.exists() and not refresh
        if not cached and stop is not None and stop.is_set():
            return [], {'parkId':park['id'],'date':date,'samples':0,'status':'deferred-after-provider-limit'}
        payload = json.loads(cache.read_text()) if cached else fetcher(url)
        rows = normalise_history(payload, park, mapping, date)
        cache.write_text(json.dumps(payload, ensure_ascii=False))
        return rows, {'parkId': park['id'], 'date': date, 'samples': len(rows), 'status': 'ok','cached':cached}
    except urllib.error.HTTPError as error:
        # Do not bypass authentication/window restrictions or spin on a spent hourly budget.
        if error.code in (401,403,429) and stop is not None:stop.set()
        return [], {'parkId': park['id'], 'date': date, 'samples': 0, 'status': f'HTTP {error.code}'}
    except (OSError, ValueError, TypeError, KeyError) as error:
        return [], {'parkId': park['id'], 'date': date, 'samples': 0, 'status': type(error).__name__}


def choose_model(candidate: dict, prior: dict | None) -> dict:
    if not prior:
        return candidate
    # A brief outage or a shorter new history must not destroy a useful existing predictor.
    if prior.get('usable') and (not candidate.get('usable')
            or str(candidate.get('lastDate', '')) < str(prior.get('lastDate', ''))
            or candidate.get('days', 0) < prior.get('days', 0)
            or (str(candidate.get('firstDate', '')) > str(prior.get('firstDate', ''))
                and str(candidate.get('lastDate', '')) <= str(prior.get('lastDate', '')))):
        return {**prior, 'lastBootstrapAttempt': candidate.get('bootstrap')}
    return candidate


def fit_models(rows: list[dict], catalogue: dict, calendar: dict | None, before_date: str,
               model_module: Path, sources=None) -> dict:
    script = ('import {trainWaitModel} from ' + json.dumps(model_module.as_uri()) + ';'
              "let raw='';for await(const c of process.stdin)raw+=c;const d=JSON.parse(raw);"
              "console.log(JSON.stringify({schemaVersion:2,updatedAt:new Date().toISOString(),parks:d.parks.map(p=>trainWaitModel(d.rows,p,{beforeDate:d.beforeDate,calendarData:d.calendar,dataSources:d.sources,sampleLimit:null}))}));")
    output = subprocess.run(['node', '--input-type=module', '-e', script], input=json.dumps({'rows': rows, 'parks': catalogue['parks'], 'calendar': calendar, 'beforeDate': before_date, 'sources': SOURCES if sources is None else sources}), text=True, capture_output=True, check=True)
    return json.loads(output.stdout)


def bootstrap(args, private_dir: Path) -> dict:
    catalogue = json.loads(args.catalogue.read_text())
    calendar = json.loads(args.calendar.read_text()) if args.calendar and args.calendar.exists() else None
    end = dt.date.fromisoformat(args.end_date)
    today=dt.datetime.now(JST).date()
    api_key=os.environ.get('THEMEPARKS_API_KEY') or None
    direct_fetch=lambda url:request_json(url,api_key=api_key)
    # An invalid key fails explicitly. Do not quietly fall back to anonymous access.
    account=direct_fetch(API+'/me') if api_key else None
    rate=(account or {}).get('rateLimit',{})
    limit=rate.get('limit',300);window=rate.get('windowSeconds',60)
    interval=max(.05,window/limit*1.25) if isinstance(limit,int) and limit>0 and isinstance(window,int) and window>0 else .25
    if interval>30:raise ValueError('The provider request budget requires a later backfill attempt.')
    request_lock=threading.Lock();next_request=[0.]
    def fetcher(url):
        # Bound aggregate request starts across workers, rather than multiplying the rate by four.
        with request_lock:
            delay=max(0,next_request[0]-time.monotonic())
            if delay:time.sleep(delay)
            next_request[0]=time.monotonic()+interval
        return direct_fetch(url)
    budget=request_budget(account,getattr(args,'max_history_requests',120))
    rows,reports,jobs=[],[],[]
    coverage_reports=[]
    for park in catalogue['parks']:
        cache=private_dir/f"{park['id']}-children.json"
        try:
            children=fetcher(f"{API}/entity/{PARK_IDS[park['id']]}/children")
            cache.write_text(json.dumps(children,ensure_ascii=False))
        except (OSError,ValueError):
            if not cache.exists():raise
            children=json.loads(cache.read_text())
        mapping=entity_mapping(children,park)
        try:coverage=fetcher(f"{API}/entity/{PARK_IDS[park['id']]}/history/coverage")
        except (OSError,ValueError):coverage={}
        start,last=accessible_window(today,end,account=account,coverage=coverage,
            days=getattr(args,'days',None),start_date=getattr(args,'start_date',None))
        coverage_reports.append({'parkId':park['id'],'accessibleFrom':start.isoformat(),
            'throughDate':last.isoformat(),'archiveFrom':coverage.get('summary',{}).get('archiveFrom'),
            'archiveRecordedThrough':coverage.get('summary',{}).get('recordedTo')})
        # Reuse ALL previously downloaded private days, including days now outside a rolling window.
        cached_dates=set()
        for path in sorted(private_dir.glob(f"{park['id']}-history-????-??-??.json")):
            day=path.stem[-10:]
            try:parsed_day=dt.date.fromisoformat(day)
            except ValueError:continue
            if parsed_day>end:continue
            # Keep cached rows during outages; the newest days may be refreshed below.
            observations,report=fetch_day(park,mapping,day,private_dir,fetcher=fetcher)
            rows.extend(observations);reports.append(report)
            if report['status']=='ok' and parsed_day<today-dt.timedelta(days=2):cached_dates.add(day)
        cursor=start
        while cursor<=last:
            day=cursor.isoformat()
            if day not in cached_dates:
                jobs.append((park,mapping,day,private_dir,cursor>=today-dt.timedelta(days=2)))
            cursor+=dt.timedelta(days=1)
    # Recent days keep a daily prediction current; remaining budget fills the oldest missing days.
    jobs.sort(key=lambda job:(0 if job[2]==end.isoformat() else 1,job[2],job[0]['id']))
    requested=len(jobs);selected=jobs[:budget];stop=threading.Event()
    def run(job):
        park,mapping,day,directory,refresh=job
        return fetch_day(park,mapping,day,directory,fetcher=fetcher,refresh=refresh,stop=stop)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for observations,report in pool.map(run,selected):
            rows.extend(observations);reports.append(report)
    existing=[];input_sources=[]
    if args.history_dir and args.history_dir.exists():
        for month in sorted(args.history_dir.glob('????-??.json')):
            if month.is_symlink():continue
            archived=json.loads(month.read_text())
            existing.extend(archived if isinstance(archived,list) else archived.get('observations',[]))
            if isinstance(archived,dict):input_sources.extend(archived.get('dataSources',[]))
    if args.existing_observations and args.existing_observations.exists():
        payload=json.loads(args.existing_observations.read_text())
        existing.extend(payload if isinstance(payload,list) else payload.get('observations',[]))
        if isinstance(payload,dict):input_sources.extend(payload.get('dataSources',[]))
    # The canonical fitter keeps the last row in each facility/time bucket.
    # Give directly collected observations priority when both sources overlap.
    rows=eligible_input(rows+existing,catalogue,end)
    weather={}
    # Request only months that have actual observations, preserving all older input dates.
    dates=sorted({row.get('date') for row in rows if isinstance(row,dict) and isinstance(row.get('date'),str) and row['date']<=end.isoformat()})
    months={day[:7] for day in dates}
    for month in sorted(months):
        month_dates=[day for day in dates if day.startswith(month)]
        weather_cache=private_dir/f'past-weather-{month}.json'
        try:
            query=urllib.parse.urlencode({'latitude':35.632,'longitude':139.883,
                'hourly':'temperature_2m,precipitation,weather_code','start_date':month_dates[0],
                'end_date':month_dates[-1],'timezone':'Asia/Tokyo'})
            cached=json.loads(weather_cache.read_text()) if weather_cache.exists() else None
            # Do not mistake a previous partial-month weather response for complete coverage.
            cached_times=(cached or {}).get('hourly',{}).get('time',[])
            if cached_times and cached_times[0][:10]<=month_dates[0] and cached_times[-1][:10]>=month_dates[-1]:payload=cached
            else:
                payload=request_json('https://historical-forecast-api.open-meteo.com/v1/forecast?'+query)
                weather_cache.write_text(json.dumps(payload))
            weather.update(weather_lookup(payload))
        except (OSError,ValueError,IndexError):pass
    # Existing measured/user weather wins. Unknowns remain unknown after provider failures.
    rows=[{**row,**{key:value for key,value in weather.get(row['date']+'T'+str(row['time']//60).zfill(2),{}).items()
           if row.get(key) in (None,'') and value not in (None,'')}} for row in rows
           if isinstance(row,dict) and isinstance(row.get('time'),int) and isinstance(row.get('date'),str)]
    (private_dir/'normalised-history.json').write_text(json.dumps(rows,ensure_ascii=False))
    before=(end+dt.timedelta(days=1)).isoformat()
    sources=list(SOURCES)+input_sources
    if any(row.get('source')=='queue-times' for row in rows):sources.append({'name':'Queue-Times.com','url':'https://queue-times.com/','kind':'collected-live-observations','attribution':'Powered by Queue-Times.com'})
    sources=list({json.dumps(source,sort_keys=True):source for source in sources if isinstance(source,dict)}.values())
    result=fit_models(rows,catalogue,calendar,before,args.model_module.resolve(),sources)
    previous=json.loads(args.fallback_model.read_text()) if args.fallback_model and args.fallback_model.exists() else {}
    latest_reports={(report['parkId'],report['date']):report for report in reports}
    pending=sum(latest_reports.get((job[0]['id'],job[2]),{}).get('status')!='ok' for job in jobs)
    for index,model in enumerate(result['parks']):
        park_rows=[row for row in rows if row['activityId'].startswith(model['parkId']+'-')]
        park_dates={row['date'] for row in park_rows}
        model['bootstrap']={'provider':'themeparks-wiki','accessMode':'key-entitlement' if account else 'anonymous',
            'attemptedAt':result['updatedAt'],'requestedDays':getattr(args,'days',None),
            'observedDays':len(park_dates),'lastObservedDate':max(park_dates,default=None),
            'historySamples':sum(row.get('source')=='themeparks-wiki' for row in park_rows),
            'historyRequestsSelected':len(selected),'historyRequestsPending':pending,
            'coverage':next(item for item in coverage_reports if item['parkId']==model['parkId']),
            'weatherProvenance':'past-weather-forecast' if weather else 'unavailable',
            'failedDays':sum(report['status']!='ok' for report in latest_reports.values() if report['parkId']==model['parkId']),
            'privateCacheRetained':bool(args.private_dir)}
        prior=next((item for item in previous.get('parks',[]) if item.get('parkId')==model['parkId']),None)
        result['parks'][index]=choose_model(model,prior)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalogue', type=Path, default=PROJECT / 'web/data/parks.json')
    parser.add_argument('--calendar', type=Path)
    parser.add_argument('--existing-observations', type=Path)
    parser.add_argument('--history-dir', type=Path, help='Monthly Queue-Times history, not private provider data')
    parser.add_argument('--output-model', type=Path, required=True)
    parser.add_argument('--fallback-model', type=Path)
    parser.add_argument('--private-dir', type=Path)
    parser.add_argument('--days',type=int,help='Optional requested length; omitted uses the full entitled window')
    parser.add_argument('--start-date',type=dt.date.fromisoformat,help='Optional requested earliest day, clamped to coverage and entitlement')
    parser.add_argument('--max-history-requests',type=int,default=120,help='Bound requests per run; provider remaining budget is also enforced')
    parser.add_argument('--end-date', default=dt.datetime.now(JST).date().isoformat())
    parser.add_argument('--model-module', type=Path, default=PROJECT / 'web/wait-model.js')
    args = parser.parse_args()
    if args.days is not None and not 1<=args.days<=100000:parser.error('--days must be positive')
    if not 1<=args.max_history_requests<=10000:parser.error('--max-history-requests must be between 1 and 10000')
    if args.start_date:args.start_date=args.start_date.isoformat()
    with tempfile.TemporaryDirectory(prefix='park-history-') as temporary:
        private_dir = args.private_dir.resolve() if args.private_dir else Path(temporary)
        # Raw provider data must not become a public asset or a tracked source file.
        repository = PROJECT.parents[1]
        if private_dir.is_relative_to(repository):
            raise ValueError('--private-dir must be outside the repository; only derived models may be published.')
        private_dir.mkdir(parents=True, exist_ok=True)
        result = bootstrap(args, private_dir)
    args.output_model.parent.mkdir(parents=True, exist_ok=True)
    output=args.output_model.with_suffix(args.output_model.suffix+'.tmp')
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    output.replace(args.output_model)
    for model in result['parks']:
        print(f"{model['parkId']}: {model['status']}, {model['days']} days, {model['samples']} samples, usable={model['usable']}")


if __name__ == '__main__':
    main()
