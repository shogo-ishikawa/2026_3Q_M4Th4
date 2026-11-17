#!/usr/bin/env python3
"""Choose a canonically validated fallback before any remote history request.

This publishes model coefficients and aggregate validation metadata only. Raw
training records are neither accepted nor copied by this helper.
"""
import argparse
import json
from pathlib import Path
import subprocess

PROJECT=Path(__file__).resolve().parents[1]


def select_models(bundled,published,module):
    script='''import {validateWaitModel} from MODULE;
let raw='';for await(const part of process.stdin)raw+=part;const data=JSON.parse(raw);
const valid=m=>validateWaitModel(m);
function score(model){return [Number(model.status==='trained'&&model.usable),Number(model.days)||0,model.lastDate||''];}
function choose(current,candidate){
 if(!valid(current))return valid(candidate)?candidate:null;
 if(!valid(candidate))return current;
 const a=score(current),b=score(candidate);
 for(let i=0;i<a.length;i++){if(a[i]!==b[i])return b[i]>a[i]?candidate:current;}
 const sameTest=current.validation?.testFrom===candidate.validation?.testFrom&&current.validation?.testThrough===candidate.validation?.testThrough;
 if(sameTest&&candidate.validation?.modelMae!==current.validation?.modelMae)return candidate.validation?.modelMae<current.validation?.modelMae?candidate:current;
 return Date.parse(candidate.trainedAt)>Date.parse(current.trainedAt)?candidate:current;
}
const models=value=>Array.isArray(value?.parks)?value.parks:[];
const parks=['land','sea'].map(id=>choose(models(data.published).find(m=>m?.parkId===id),models(data.bundled).find(m=>m?.parkId===id)));
if(parks.some(m=>!m))throw Error('No validated fallback is available for both parks');
console.log(JSON.stringify({schemaVersion:2,updatedAt:new Date().toISOString(),parks}));'''.replace('MODULE',json.dumps(Path(module).resolve().as_uri()))
    process=subprocess.run(['node','--input-type=module','-e',script],input=json.dumps({'bundled':bundled,'published':published}),text=True,capture_output=True,check=True)
    return json.loads(process.stdout)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundled',type=Path,default=PROJECT/'web/data/wait-model.json')
    parser.add_argument('--published',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    original=json.loads(args.bundled.read_text())
    try:
        previous=json.loads(args.published.read_text()) if args.published.exists() else {}
    except (OSError,ValueError):
        previous={}
        print('Published model is unreadable; using the validated bundled fallback.')
    if not isinstance(previous,dict):previous={}
    result=select_models(original,previous,PROJECT/'web/wait-model.js')
    if result['parks']==previous.get('parks') and args.output==args.published:
        print('Kept the existing validated prediction models.');return
    args.output.parent.mkdir(parents=True,exist_ok=True)
    temporary=args.output.with_suffix(args.output.suffix+'.tmp')
    temporary.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');temporary.replace(args.output)
    print('Prepared validated fallback models before requesting provider history.')


if __name__=='__main__':main()
