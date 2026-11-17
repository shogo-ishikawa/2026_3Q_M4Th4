"""Licensed history windows, bounded backfill and retained multi-year observations."""
import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock
import urllib.error

PROJECT=Path(__file__).resolve().parents[1]
def load(name):
    spec=importlib.util.spec_from_file_location(name,PROJECT/'scripts'/f'{name}.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

history=load('bootstrap_wait_history');archive=load('archive_wait_history')

class HistoryAccessTests(unittest.TestCase):
    def test_requested_period_never_exceeds_actual_entitlement_or_coverage(self):
        today=dt.date(2026,11,17)
        coverage={'summary':{'archiveFrom':'2021-07-04','retrievableThrough':'2026-11-17'}}
        self.assertEqual(history.accessible_window(today,today,coverage=coverage), (dt.date(2026,11,11),today))
        free={'historyDays':30,'historyEarliestDate':'2026-10-19','historyAllArchive':False}
        self.assertEqual(history.accessible_window(today,today,account=free,coverage=coverage,days=400)[0],dt.date(2026,10,19))
        self.assertEqual(history.accessible_window(today,today,account={'historyAllArchive':True},coverage=coverage)[0],dt.date(2021,7,4))
        self.assertEqual(history.accessible_window(today,today,account={'historyAllArchive':True},coverage=coverage,start_date='2024-01-01')[0],dt.date(2024,1,1))
        with self.assertRaises(ValueError):history.accessible_window(today,today,account={'historyAllArchive':True})
        with self.assertRaises(ValueError):history.accessible_window(today,today+dt.timedelta(days=1))
        with self.assertRaises(ValueError):history.accessible_window(today,today,account={'historyDays':True})

    def test_provider_budget_is_respected_and_unknown_budget_does_not_guess(self):
        self.assertEqual(history.request_budget(None,1000),54)
        self.assertEqual(history.request_budget({'historyRateLimit':{'remaining':10}},1000),6)
        self.assertEqual(history.request_budget({'historyRateLimit':{'remaining':1}},1000),0)
        self.assertEqual(history.request_budget({'historyRateLimit':{}},1000),0)
        self.assertEqual(history.request_budget({'historyRateLimit':{'unmetered':True}},1000),1000)

    def test_existing_input_excludes_unknown_future_closed_and_malformed_records(self):
        good={'date':'2021-07-04','activityId':'land-a','time':600,'wait':20,'weather':'rain','weatherSource':'observed'}
        catalogue={'parks':[{'activities':[{'id':'land-a'}]}]}
        rows=history.eligible_input([good,None,{}, {**good,'date':'bad'},{**good,'time':True},{**good,'wait':False},{**good,'date':'2026-11-18'},{**good,'isOpen':False},{**good,'activityId':'unknown'}],catalogue,dt.date(2026,11,17))
        self.assertEqual(rows,[good])

    def test_entitlement_error_stops_new_calls_without_exposing_a_key(self):
        park={'id':'land','activities':[]};stop=threading.Event();calls=[]
        def forbidden(url):
            calls.append(url);raise urllib.error.HTTPError(url,403,'History window',{},None)
        with tempfile.TemporaryDirectory() as directory:
            first=history.fetch_day(park,{},'2026-11-01',Path(directory),fetcher=forbidden,stop=stop)
            second=history.fetch_day(park,{},'2026-10-31',Path(directory),fetcher=forbidden,stop=stop)
        self.assertEqual(len(calls),1);self.assertEqual(first[1]['status'],'HTTP 403')
        self.assertEqual(second[1]['status'],'deferred-after-provider-limit')
        with self.assertRaises(ValueError):history.request_json('https://example.test/data',api_key='must-not-send')

    def test_default_archive_retains_all_collected_years_but_never_private_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);folder=root/'history';folder.mkdir()
            old={'date':'2021-07-04','activityId':'land-a','time':600,'wait':20,'source':'queue-times'}
            (folder/'2021-07.json').write_text(json.dumps([old,{**old,'source':'themeparks-wiki'}]))
            (root/'observations.json').write_text('[]')
            result=archive.update_archive(root,dt.date(2026,11,17))
            self.assertIsNone(result['retentionMonths']);self.assertEqual(result['samples'],1)
            self.assertEqual(json.loads((folder/'2021-07.json').read_text()),[old])
            archive.update_archive(root,dt.date(2026,11,17),retain_months=24)
            self.assertFalse((folder/'2021-07.json').exists())

    def test_bounded_runs_resume_cached_days_and_keep_input_weather(self):
        today=dt.datetime.now(history.JST).date();calls=[]
        parks=[{'id':pid,'activities':[{'id':pid+'-attraction-1','category':'attraction','windows':[[540,1260]]}],'events':[]} for pid in ['land','sea']]
        def response(url,**kwargs):
            if url.endswith('/me'):return {'historyDays':30,'historyAllArchive':False,'historyRateLimit':{'remaining':600}}
            if url.endswith('/children'):return {'children':[{'id':'ride','externalId':'1','entityType':'ATTRACTION'}]}
            if url.endswith('/coverage'):return {'summary':{'archiveFrom':'2021-07-04','retrievableThrough':today.isoformat(),'recordedTo':(today-dt.timedelta(days=3)).isoformat()}}
            if 'historical-forecast-api' in url:return {'hourly':{'time':[]}}
            calls.append(url)
            pid=next(pid for pid,uuid in history.PARK_IDS.items() if uuid in url);day=url.rsplit('=',1)[1]
            return {'id':history.PARK_IDS[pid],'timezone':'Asia/Tokyo','range':{'from':day,'to':day},'entities':[{'id':'ride','history':[{'time':day+'T00:05:00Z','status':'OPERATING','queue':{'STANDBY':{'waitTime':20}}}]}]}
        fitted=[]
        def fit(rows,catalogue,*args):
            fitted.append(rows)
            return {'updatedAt':today.isoformat()+'T12:00:00Z','parks':[{'parkId':pid,'status':'insufficient-data','usable':False} for pid in ['land','sea']]}
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'catalogue.json').write_text(json.dumps({'parks':parks}))
            old={'date':'2020-01-01','activityId':'land-attraction-1','time':600,'wait':30,'weather':'rain','temperature':5,'weatherSource':'observed','source':'queue-times'}
            (root/'owned.json').write_text(json.dumps([old]));private=root/'private';private.mkdir()
            args=SimpleNamespace(catalogue=root/'catalogue.json',calendar=None,end_date=today.isoformat(),days=None,start_date=None,max_history_requests=6,history_dir=None,existing_observations=root/'owned.json',model_module=PROJECT/'web/wait-model.js',fallback_model=None,private_dir=private)
            with mock.patch.dict('os.environ',{'THEMEPARKS_API_KEY':'fixture-key'}),mock.patch.object(history,'request_json',side_effect=response),mock.patch.object(history,'fit_models',side_effect=fit):
                first=history.bootstrap(args,private);first_dates={row['date'] for row in fitted[-1]}
                second=history.bootstrap(args,private);second_dates={row['date'] for row in fitted[-1]}
            self.assertEqual(len(calls),12);self.assertTrue(first_dates<second_dates)
            self.assertTrue(any(row==old for row in fitted[-1]));self.assertGreater(first['parks'][0]['bootstrap']['historyRequestsPending'],0)
            self.assertGreater(second['parks'][0]['bootstrap']['observedDays'],first['parks'][0]['bootstrap']['observedDays'])
            self.assertNotIn('fixture-key',json.dumps(second))
            def limited(url,**kwargs):
                if '/history?' in url:raise urllib.error.HTTPError(url,429,'History limit',{},None)
                return response(url,**kwargs)
            with mock.patch.dict('os.environ',{'THEMEPARKS_API_KEY':'fixture-key'}),mock.patch.object(history,'request_json',side_effect=limited),mock.patch.object(history,'fit_models',side_effect=fit):
                blocked=history.bootstrap(args,private)
            self.assertGreater(blocked['parks'][0]['bootstrap']['historyRequestsPending'],0)
            self.assertTrue(second_dates.issubset({row['date'] for row in fitted[-1]}))

if __name__=='__main__':unittest.main()
