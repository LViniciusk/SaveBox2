"""R10: Range-only Fetch, auxiliary renderer metrics and recoverable synthetic custody."""
import argparse
import json
import math
import re
from pathlib import Path
import sys
import tempfile

from run_readiness_wave1 import Wave, WaveFailure
from run_ap06_integration_probe import read, validate_integration_condition, REPRODUCES, DOES_NOT
from run_ap06_r9 import (publish, verify_freeze, freeze_implementation, runtime_environment, media_files,
    validate_network, network_sequence, measure, CHECKPOINTS)
from run_ap06_transport_probe import media_server

OUTPUT='.quality/readiness-wave10'
CONDITIONS={'r10.0':{'transport':'xhr','rangeType':'XHR','otherType':'XHR'},
    'r10.1':{'transport':'range-fetch','rangeType':'Fetch','otherType':'XHR'},
    'r10.2':{'transport':'global-fetch','rangeType':'Fetch','otherType':'Fetch'}}
FORMAL_ORDER=('r10.0','r10.1','r10.1','r10.0','r10.0','r10.1')
SCHEDULE=tuple(('triage',condition) for condition in CONDITIONS)+tuple(('formal',condition) for condition in FORMAL_ORDER)


def check_r10_budget(previous):
    if type(previous) is not int or not 0 <= previous < 9: raise ValueError('R10_BROWSER_BUDGET_EXCEEDED')


def budget_check(budget,previous,requested):
    if budget.get('approved') is not True or budget.get('measurementMaximum') != 9 or budget.get('measurementRetries') != 0 or requested != 1:
        raise ValueError('R10_INVALID_BUDGET')
    check_r10_budget(previous)


def decide(triage,formal):
    if triage.get('r10.0') == DOES_NOT: return {'status':'BLOCKED_AP06_R10_CONTROL_NOT_REPRODUCED'}
    if set(triage) != set(CONDITIONS) or triage.get('r10.0') != REPRODUCES or any(value not in (REPRODUCES,DOES_NOT) for value in triage.values()):
        return {'status':'BLOCKED_AP06_R10_INVALID_MEASUREMENT'}
    reference='GLOBAL_PROVIDER_EFFECT_SUSPECTED' if triage['r10.1']==REPRODUCES and triage['r10.2']==DOES_NOT else None
    if any(len(formal.get(condition,[]))!=3 or any(value!=triage[condition] for value in formal[condition]) for condition in ('r10.0','r10.1')):
        return {'status':'BLOCKED_AP06_R10_FORMAL_DISAGREEMENT','reference':reference}
    return {'status':'PASS_AP06_R10_RANGE_FETCH_EFFECT_CONFIRMED' if triage['r10.1']==DOES_NOT else
            'PASS_AP06_R10_RANGE_FETCH_NO_OWNERSHIP_SHIFT','reference':reference}


def environment(wave,directory,condition,stage='triage',freeze=None):
    env,assets=runtime_environment(wave,directory,condition,stage,freeze,output=OUTPUT,publisher=Path(__file__))
    env['AP06_R10_ATTEMPT']=stage+'-'+directory.name
    return env,assets


def expected_proof(condition):
    return {'xhrBackend':condition=='r10.0','fetchBackend':condition=='r10.2','selectiveBackend':condition=='r10.1',
        'xhrDelegate':condition=='r10.1','fetchDelegate':condition=='r10.1','originalRange':True,'realAuth':True}


def validate_bootstrap_network(data,condition):
    rows=data.get('bootstrapRequests',[])
    ids=[row.get('requestId') for row in rows+data.get('requests',[])]
    if sorted(row.get('kind') for row in rows)!=['auth','pending','tree'] or any(
        row.get('type')!=CONDITIONS[condition]['otherType'] or row.get('status')!=200 or row.get('finished') is not True or
        row.get('failed') or row.get('fromDiskCache') is not False or row.get('fromServiceWorker') is not False or
        row.get('method')!=('POST' if row.get('kind')=='auth' else 'GET') or row.get('servedFromCache') is not False or
        type(row.get('encodedDataLength')) not in (int,float) or not math.isfinite(row['encodedDataLength']) or row['encodedDataLength']<0
        for row in rows) or len(ids)!=len(set(ids)) or any(not isinstance(value,str) or not value for value in ids):
        raise WaveFailure('R10_AUTH_STORE_TRANSPORT_NOT_PROVEN')


def validate_auxiliary(sample):
    fields={'heap':('usedSize','totalSize','embedderHeapUsedSize','backingStorageSize'),'dom':('documents','nodes','jsEventListeners')}
    for kind,names in fields.items():
        row=sample.get('rendererMemory',{}).get(kind,{})
        missing=[]
        for name in names:
            value=row.get(name)
            if value is None:
                if row.get('unavailable',{}).get(name) not in ('FIELD_NOT_SUPPORTED','API_NOT_SUPPORTED'):
                    raise WaveFailure('R10_AUXILIARY_MISSING_REASON')
                missing.append(name)
            elif type(value) not in (int,float) or not math.isfinite(value) or value<0 or kind=='dom' and type(value) is not int:
                raise WaveFailure('R10_AUXILIARY_INVALID_NUMBER')
        expected='UNAVAILABLE' if len(missing)==len(names) else 'PARTIAL' if missing else 'AVAILABLE'
        if row.get('status')!=expected or set(row.get('unavailable',{}))!=set(missing): raise WaveFailure('R10_AUXILIARY_STATUS_INCOHERENT')
    dom=sample['rendererMemory']['dom']
    heap=sample['rendererMemory']['heap']
    if heap['usedSize'] is not None and heap['totalSize'] is not None and heap['usedSize']>heap['totalSize']:
        raise WaveFailure('R10_AUXILIARY_HEAP_INCOHERENT')
    if any(sample['metrics'].get(metric)!=dom[field] for metric,field in [('Nodes','nodes'),('Documents','documents'),('eventListeners','jsEventListeners')]):
        raise WaveFailure('R10_DOM_METRICS_DISAGREE')


def validate_process_totals(sample):
    memory=sample['processMemory'];categories=memory['byCategory']
    for kind in ('browser','renderer','gpu-process','utility'):
        value=categories.get(kind,{}).get('privateBytes')
        if type(value) not in (int,float) or not math.isfinite(value) or value<0: raise WaveFailure('R10_PROCESS_CATEGORY_UNAVAILABLE')
    if (sum(row['privateBytes'] for row in categories.values())!=memory['privateBytes'] or
            sum(row['privateBytes'] for row in memory['processes'])!=memory['privateBytes'] or
            any(categories[kind]['privateBytes']!=memory['byType'][kind]['privateBytes'] for kind in ('browser','renderer'))):
        raise WaveFailure('R10_PROCESS_TOTALS_INCOHERENT')


def validate_condition(raw,condition,stage,freeze,fixtures):
    classification=validate_integration_condition(raw,condition,stage,freeze,fixtures,'backend',expected_runs=1)
    if raw.get('transport')!=CONDITIONS[condition]['transport']: raise WaveFailure('R10_TRANSPORT_IDENTITY_CHANGED')
    run=raw['runs'][0]
    match=re.fullmatch(r'(triage|formal)-(\d{2})-(r10\.[012])',run['runId'])
    if not match or match[1]!=stage or match[3]!=condition or not 1<=int(match[2])<=len(SCHEDULE) or SCHEDULE[int(match[2])-1]!=(stage,condition):
        raise WaveFailure('R10_FROZEN_ATTEMPT_ORDER_CHANGED')
    if run['transportProof']!=expected_proof(condition): raise WaveFailure('R10_DI_PROOF_INVALID')
    validate_bootstrap_network(run['rangeNetwork'],condition)
    body_bytes=validate_network(run,condition,freeze['workload']['rangesPerCycle']*6,fixtures,
        freeze['backendFileMapping'],expected_type=CONDITIONS[condition]['rangeType'])
    if body_bytes!=freeze['workload']['bytesPerCycle']*6: raise WaveFailure('R10_CDP_BYTE_TOTAL_INVALID')
    for sample in run['samples']:
        validate_auxiliary(sample)
        validate_process_totals(sample)
        counters=sample['counters']['observed'];cycle=sample['cycle']
        if (counters['rangeRequestsCompleted']!=freeze['workload']['requestsPerCycle']*cycle or
                counters['rangeBytesReceived']!=freeze['workload']['bytesPerCycle']*cycle or
                counters.get('workerTransferBytesSent')!=freeze['workload']['workerTransferBytesSentPerCycle']*cycle):
            raise WaveFailure('R10_CLIENT_WORKLOAD_DISAGREES')
    return classification


def unit_browser(wave):
    target=wave.output/'tooling/angular-unit-1.json'
    if target.exists() or (wave.output/'tooling/freeze.json').exists(): raise WaveFailure('R10_DEVELOPMENT_BROWSER_LIMIT')
    env,assets=environment(wave,wave.output/'tooling','r10.0')
    env.update(AP06_R10_CHECK='1',AP06_R7_UNIT_OUTPUT=str(target))
    with media_server(media_files(wave),True,'application/octet-stream',assets,port=42088) as (origin,stats):
        env['AP06_R5_MEDIA_ORIGIN']=origin
        wave.command('angular-r10-unit',[wave.node,'tools/ap06-angular-integration-check.mjs'],wave.root/'frontend',env)
        wave.save('pipeline/angular-unit-transport.json',stats)
    unit=read(target)
    if unit['status']!='PASS' or unit['unitBrowserLaunches']!=1: raise WaveFailure('R10_PREFLIGHT_FAILED')
    fixtures=read(wave.output/'fixtures/manifest.json');mapping=read(wave.output/'baseline/backend-authority.json')['fileMapping']
    sequences=[];totals=[];transfer_totals=[]
    for condition in CONDITIONS:
        network=unit['rangeNetworks'][condition];data=network['cdp'];sequence=network_sequence(data['requests'])
        if unit['transportProofs'][condition]!=expected_proof(condition): raise WaveFailure('R10_PREFLIGHT_DI_INVALID')
        validate_bootstrap_network(data,condition)
        totals.append(validate_network({'rangeNetwork':data,'backendTraffic':network['backend']},condition,sequence,fixtures,mapping,
            expected_type=CONDITIONS[condition]['rangeType']))
        sequences.append(sequence)
        transfer_totals.append(unit['boundaryCounters'][condition]['workerTransferBytesSent'])
    if not sequences[0] or any(value!=sequences[0] for value in sequences) or len(set(totals))!=1 or len(set(transfer_totals))!=1 or transfer_totals[0]<=0:
        raise WaveFailure('R10_TRANSPORT_WORKLOAD_DIFFERS')
    wave.save('baseline/workload.json',{'rangesPerCycle':sequences[0],'requestsPerCycle':len(sequences[0]),'bytesPerCycle':totals[0],
        'cycles':6,'workerTransferBytesSentPerCycle':transfer_totals[0],'derivedBeforeFreeze':True,'allThreeTransportsEqual':True})
    print(json.dumps({'status':'PASS','developmentChromium':1,'checks':len(unit['cases'])}),flush=True)


def freeze(wave):
    if read(wave.output/'baseline/custody-readback.json')['status']!='PASS': raise WaveFailure('R10_CUSTODY_NOT_READY')
    freeze_implementation(wave,output=OUTPUT,harness='frontend/tools/ap06-r10-probe.mjs',runner_path=__file__,
        extra_files=('baseline/custody-readback.json','baseline/formal-order.json','baseline/native-reuse.json','baseline/red-node.txt','baseline/red-python.txt','baseline/custody-preflight-correction.json'),
        extra_publications=('custody','custody-tooling-correction'),protocol={'campaign':'AP-06-R10','conditions':CONDITIONS,
            'formalOrder':list(FORMAL_ORDER),'measurementOrder':[list(row) for row in SCHEDULE]})


def campaign_run(wave):
    frozen=read(wave.output/'tooling/freeze.json')
    if (frozen['checkpoints']!=dict.fromkeys(CHECKPOINTS,'PASS') or frozen['formalOrder']!=list(FORMAL_ORDER) or
            frozen['measurementOrder']!=[list(row) for row in SCHEDULE]): raise WaveFailure('R10_PROTOCOL_NOT_READY')
    with (wave.output/'pipeline/campaign-started.json').open('x') as stream:json.dump({'implementationHead':frozen['implementationHead'],'retries':0},stream)
    publish(wave,'campaign-started',{'evidence/campaign-started.json':wave.output/'pipeline/campaign-started.json'})
    ledger=[];results=[];triage={};formal={'r10.0':[],'r10.1':[]};decision={'status':'BLOCKED_AP06_R10_INVALID_MEASUREMENT'}
    try:
        for number,(stage,condition) in enumerate(SCHEDULE,1):
            print(json.dumps({'attempt':number,'condition':condition,'stage':stage,'state':'STARTED'}),flush=True)
            result=measure(wave,condition,stage,frozen,ledger,requested=1,directory_name=f'{number:02}-{condition}',
                budget_fn=budget_check,environment_fn=environment,validate_fn=validate_condition,probe='tools/ap06-r10-probe.mjs')
            results.append(result);classification=result['classification']
            print(json.dumps({'attempt':number,'condition':condition,'classification':classification}),flush=True)
            if stage=='triage':
                triage[condition]=classification
                if condition=='r10.0' and classification==DOES_NOT:decision=decide(triage,formal);break
                if classification not in (REPRODUCES,DOES_NOT): raise WaveFailure('R10_TRIAGE_INCONCLUSIVE')
            else:
                formal[condition].append(classification)
                if classification!=triage[condition]:
                    decision={'status':'BLOCKED_AP06_R10_FORMAL_DISAGREEMENT','reason':result['rawPath']};break
        else:decision=decide(triage,formal)
    except Exception as error:
        decision={'status':'BLOCKED_AP06_R10_INVALID_MEASUREMENT','reason':str(error) if isinstance(error,(ValueError,WaveFailure)) else type(error).__name__}
    decision.update(ap06='OPEN',results=results,triage=triage,formal=formal,retries=0,
        browserLaunches=sum(row['browserLaunches'] for row in ledger),launchAttempts=sum(row['launchAttempts'] for row in ledger))
    wave.save('final/decision.json',decision);publish(wave,'campaign-decision',{'evidence/campaign-decision.json':wave.output/'final/decision.json'})
    print(json.dumps({key:value for key,value in decision.items() if key not in ('results','triage','formal')}),flush=True)
    return 0 if decision['status'].startswith('PASS_') else 1


def main():
    parser=argparse.ArgumentParser(description=__doc__);actions=parser.add_mutually_exclusive_group(required=True)
    for option in ('unit-browser','freeze','verify-freeze','validated-campaign'):actions.add_argument('--'+option,action='store_true')
    actions.add_argument('--publish-raw',type=Path);parser.add_argument('--snapshot');args=parser.parse_args()
    wave=Wave(Path(__file__).resolve().parents[2]);wave.output=wave.root/OUTPUT
    with tempfile.TemporaryDirectory(prefix='r10-logs-',dir=wave.output/'pipeline') as temporary:
        wave.temp=Path(temporary)
        if args.unit_browser:unit_browser(wave);return 0
        if args.freeze:freeze(wave);return 0
        if args.verify_freeze:verify_freeze(wave,read(wave.output/'tooling/freeze.json'));return 0
        if args.publish_raw:
            path=args.publish_raw.absolute()
            if not path.is_relative_to(wave.output) or not args.snapshot: raise ValueError('R10_INVALID_RAW_PUBLICATION')
            publish(wave,'raw-'+args.snapshot,{f'evidence/raws/{args.snapshot}.json':path});return 0
        return campaign_run(wave)


if __name__=='__main__':raise SystemExit(main())
