#!/usr/bin/env python3
"""Keep monthly archives of observations collected from the public Queue-Times API.

Private bootstrap input is never read by this command. Each archive is an array;
only rows whose source is exactly ``queue-times`` can enter the public history.
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
import math
from pathlib import Path
import re

JST=dt.timezone(dt.timedelta(hours=9))
MONTH_FILE=re.compile(r'\d{4}-(?:0[1-9]|1[0-2])\.json')
PUBLIC_FIELDS={'date','activityId','time','wait','weather','event','source','observedAt','temperature','precipitation','openingMinute','holiday','holidayName','weatherSource','weatherTime','weatherFetchedAt'}


def bucket(row):
    minute=row['time'];opening=row.get('openingMinute')
    width=10 if isinstance(opening,int) and not isinstance(opening,bool) and 0<=minute-opening<90 else 30
    return minute//width*width


def valid_row(row,today):
    if not isinstance(row,dict) or row.get('source')!='queue-times':return False
    if row.get('isOpen') is False or row.get('status') in ('CLOSED','DOWN','REFURBISHMENT'):return False
    try:day=dt.date.fromisoformat(row.get('date',''))
    except (ValueError,TypeError):return False
    minute=row.get('time');wait=row.get('wait')
    return day<=today and isinstance(row.get('activityId'),str) and row['activityId'].startswith(('land-','sea-')) and len(row['activityId'])<=100 and isinstance(minute,int) and not isinstance(minute,bool) and 0<=minute<1440 and isinstance(wait,(int,float)) and not isinstance(wait,bool) and math.isfinite(wait) and 0<=wait<=600


def month_number(value):
    return value.year*12+value.month-1


def atomic_json(path,value):
    temporary=path.with_suffix(path.suffix+'.tmp');temporary.write_text(json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8');temporary.replace(path)


def update_archive(data_dir,today,retain_months=None):
    data_dir=Path(data_dir);directory=data_dir/'history'
    if directory.is_symlink():raise ValueError('History directory must not be a symbolic link')
    directory.mkdir(parents=True,exist_ok=True)
    earliest=month_number(today)-retain_months+1 if retain_months is not None else None
    months={}
    for path in directory.iterdir():
        if not MONTH_FILE.fullmatch(path.name) or path.is_symlink() or not path.is_file():continue
        month=dt.date.fromisoformat(path.stem+'-01')
        if earliest is not None and month_number(month)<earliest:path.unlink();continue
        rows=json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(rows,list):raise ValueError(f'Archive is not a record array: {path.name}')
        months[path.stem]=[row for row in rows if valid_row(row,today) and row['date'].startswith(path.stem)]
    recent=data_dir/'observations.json'
    rows=json.loads(recent.read_text(encoding='utf-8')) if recent.exists() else []
    if not isinstance(rows,list):raise ValueError('Recent observations must be a record array')
    for row in rows:
        if not valid_row(row,today):continue
        if earliest is None or month_number(dt.date.fromisoformat(row['date']))>=earliest:months.setdefault(row['date'][:7],[]).append(row)
    files=[]
    for month,values in sorted(months.items()):
        merged={}
        for row in values:merged[(row['date'],row['activityId'],bucket(row))]={key:value for key,value in row.items() if key in PUBLIC_FIELDS and isinstance(value,(str,int,float,bool))}
        values=sorted(merged.values(),key=lambda row:(row['date'],row['time'],row['activityId']))
        path=directory/(month+'.json');atomic_json(path,values)
        files.append({'file':'history/'+path.name,'month':month,'samples':len(values),'firstDate':values[0]['date'] if values else None,'lastDate':values[-1]['date'] if values else None})
    index={'schemaVersion':1,'updatedAt':dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00','Z'),'source':'queue-times','attribution':'Powered by Queue-Times.com','attributionUrl':'https://queue-times.com/','retentionMonths':retain_months,'files':files,'samples':sum(item['samples'] for item in files)}
    atomic_json(data_dir/'history-index.json',index)
    return index


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir',type=Path,required=True)
    parser.add_argument('--date',type=dt.date.fromisoformat,default=dt.datetime.now(JST).date())
    parser.add_argument('--retain-months',type=int,help='Explicit retention limit; omit to keep every collected month')
    args=parser.parse_args()
    if args.retain_months is not None and args.retain_months<1:parser.error('--retain-months must be positive')
    index=update_archive(args.data_dir,args.date,args.retain_months)
    print(f"Archived {index['samples']} Queue-Times observations in {len(index['files'])} months.")


if __name__=='__main__':main()
