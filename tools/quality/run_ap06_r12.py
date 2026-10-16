"""AP-06 R12: five HTTP materialization arms; one preflight, at most eleven measurements, no retries."""
import argparse
from datetime import datetime
import json
import math
from pathlib import Path
import re
import subprocess
import tempfile

from run_readiness_wave1 import Wave,WaveFailure
from run_ap06_integration_probe import read,VERSION
from run_ap06_r9 import (publish,media_files,runtime_environment,freeze_implementation,measure,validate_network)
from run_ap06_r10 import expected_proof,validate_bootstrap_network,validate_auxiliary
from run_ap06_r11 import validate_memory,validate_process_lifecycle,renderer_delta,verify_r11_freeze
from run_ap06_transport_probe import media_server
from ap06_authorities import checked_path

OUTPUT='.quality/readiness-wave12'
CONDITIONS=tuple(f'r12.{i}' for i in range(5))
FETCH=frozenset(('r12.1','r12.3','r12.4'))
PAIRS=(('r12.0','r12.1'),('r12.1','r12.3'),('r12.2','r12.3'),('r12.3','r12.4'))
PHASES=('baseline',*[f'cycle-{i}-close' for i in range(1,7)],'post-teardown-settled','idle-30s','idle-120s','forced-GC-final')
COUNTERS=('payloadBlobCount','payloadBlobBytes','payloadArrayBufferCount','payloadArrayBufferBytes','metadataBytes','metadataCompleted',
    'pendingOperations','completedOperations','failedOperations','cancelledOperations','activeReferences','sessionsStarted','sessionsCompleted','sessionsFailed','obtainMs','materializeMs')


def require(condition,reason):
    if not condition:raise WaveFailure(reason)


def check_budget(budget,previous,requested):
    require(budget.get('approved') is True and budget.get('developmentMaximum')==1 and budget.get('measurementMaximum')==11 and
        budget.get('measurementRetries')==0 and type(previous) is int and 0<=previous<11 and type(requested) is int and requested==1,'R12_BROWSER_BUDGET_EXCEEDED')


def environment(wave,directory,condition,stage='triage',freeze=None):
    env,assets=runtime_environment(wave,directory,condition,stage,freeze,output=OUTPUT,publisher=Path(__file__).resolve())
    env.update(AP06_R11_KEYS=str(wave.root/'tools/quality/ap06_r11_keys.py'),
        AP06_R11_AUTHORITY=str(wave.output/'baseline/authority-config.local.json'),AP06_R12_ATTEMPT=stage+'-'+directory.name)
    return env,assets


def validate_scalars(c,condition,sessions,bytes_per_cycle):
    require(set(c)==set(COUNTERS) and all(type(v) in (int,float) and math.isfinite(v) and v>=0 for v in c.values()),'R12_SCALAR_INVALID')
    payload=sessions*2*(4194304+16);blob=condition!='r12.4';buffer=condition not in ('r12.0','r12.1')
    expected={'payloadBlobCount':sessions*2 if blob else 0,'payloadBlobBytes':payload if blob else 0,
        'payloadArrayBufferCount':sessions*2 if buffer else 0,'payloadArrayBufferBytes':payload if buffer else 0,
        'metadataBytes':sessions*131072,'metadataCompleted':sessions,'pendingOperations':0,'completedOperations':sessions*3,
        'failedOperations':0,'cancelledOperations':0,'activeReferences':0,'sessionsStarted':sessions,'sessionsCompleted':sessions,'sessionsFailed':0}
    require(all(c.get(k)==v for k,v in expected.items()) and payload+sessions*131072==bytes_per_cycle*sessions/3,'R12_SCALAR_WORKLOAD_CHANGED')


def validate_condition(raw,condition,stage,freeze,fixtures):
    try:return _validate_condition(raw,condition,stage,freeze,fixtures)
    except (KeyError,IndexError,TypeError,ValueError):raise WaveFailure('R12_RAW_CONTRACT_INVALID') from None


def _validate_condition(raw,condition,stage,freeze,fixtures):
    require(condition in CONDITIONS and stage in ('triage','formal') and len(raw['runs'])==1,'R12_RUN_IDENTITY_CHANGED')
    run=raw['runs'][0];match=re.fullmatch(r'(triage|formal)-(\d{2})-(r12\.[0-4])',run['runId'])
    require(match and match[1]==stage and match[3]==condition and
        (int(match[2])==CONDITIONS.index(condition)+1 if stage=='triage' else 6<=int(match[2])<=11),'R12_ATTEMPT_ORDER_CHANGED')
    identity={'videoPlayerComponentUsed':False,'videoStreamServiceUsed':False,'attributionDriverUsed':True,'httpWorkloadEquivalent':True,
        'metadataCommon':True,'workersUsed':False,'mseUsed':False,'playbackFunctional':False,'angularOrBackendUsed':True,'backendUsed':True,
        'driveStoreUsed':True,'playwrightRoutingInstalled':True,'localRequestsIntercepted':False,'fullKasumiContainer':True,'fetchInterceptionInstalled':False}
    require(all(raw.get(k) is v for k,v in identity.items()),'R12_STAGE_BOUNDARY_CHANGED')
    require(raw['condition']==condition and raw['stage']==stage and raw['transport']==('fetch' if condition in FETCH else 'xhr') and
        raw['payload']==('blob' if condition in ('r12.0','r12.1') else 'direct-arraybuffer' if condition=='r12.4' else 'blob-arraybuffer') and
        raw['browserLaunches']==raw['launchAttempts']==1 and raw['retries']==0 and raw['processSampleCalls']==11 and
        run['browserVersion']==VERSION and run['functionalStatus']==run['cleanupStatus']=='PASS' and run['playbackSessions']==18 and
        not raw['pageErrors'] and not raw['recoveryWarnings'] and not any(raw['network'][k] for k in ('externalRequests','unexpectedRequests','rejectedRequests')) and not raw['network']['workerRequests'],'R12_FUNCTIONAL_OR_NETWORK_FAILURE')
    alias='r10.1' if condition in FETCH else 'r10.0'
    require(run['transportProof']==expected_proof(alias),'R12_DI_CHANGED');validate_bootstrap_network(run['rangeNetwork'],alias)
    received=validate_network(run,condition,freeze['workload']['rangesPerCycle']*6,fixtures,freeze['backendFileMapping'],expected_type='Fetch' if condition in FETCH else 'XHR')
    require(received==freeze['workload']['bytesPerCycle']*6,'R12_HTTP_WORKLOAD_CHANGED')
    validate_http_samples(raw,freeze,fixtures,'r12',lambda counters,sessions:validate_scalars(counters,condition,sessions,freeze['workload']['bytesPerCycle']))
    return 'R12_MATERIALIZATION_VALID'


def validate_http_samples(raw,freeze,fixtures,counter_name,validate_counter):
    run=raw['runs'][0]
    for key,value in {'fixtureManifestSha256':freeze['fixtureHash'],'orchestratorHash':freeze['runnerHash'],
        'experimentalAppProducts':freeze['appProducts'],'pageScriptSha256':freeze['pageScriptSha256'],
        'backendAuthoritySha256':freeze['backendAuthoritySha256'],'backendFileMapping':freeze['backendFileMapping'],
        'workerBundleSha256':freeze['workers']['transmux']['sha256'],'cryptoWorkerBundleSha256':freeze['workers']['crypto']['sha256'],
        'fixtureIdentities':[{k:f[k] for k in ('id','name','bytes','sha256')} for f in fixtures]}.items():
        require(raw.get(key)==value,'R12_RAW_AUTHORITY_CHANGED')
    samples=run['samples']
    require(len(samples)==11 and tuple(s['phase'] for s in samples)==PHASES and [s['cycle'] for s in samples]==[0,1,2,3,4,5,6,6,6,6,6] and
        all(s['gc']==('forced-diagnostic' if i==10 else 'natural') for i,s in enumerate(samples)),'R12_CHECKPOINTS_CHANGED')
    # The no-playback R11 lifecycle contract rejects any new AudioService and conserves every PID/type.
    validate_process_lifecycle(samples,'r11.2')
    at=lambda index:datetime.fromisoformat(samples[index]['timestamp'].replace('Z','+00:00'))
    require((at(8)-at(7)).total_seconds()>=30 and (at(9)-at(8)).total_seconds()>=90 and
        (at(9)-at(7)).total_seconds()>=120 and all(at(i)>=at(i-1) for i in range(1,11)),'R12_IDLE_TOO_SHORT')
    pids=sorted({r['pid'] for s in samples for r in s['processMemory']['processes']})
    require(run['processExitAudit']=={'status':'PASS','ownedPids':pids,'aliveOwnedPids':[]},'R12_PROCESS_NOT_CLOSED')
    for sample in samples:
        validate_memory(sample,samples[0]);validate_auxiliary(sample)
        require(sample['browserVersion']==VERSION and sample['functionalStatus']==sample['cleanupStatus']=='PASS' and
            not any(sample['ownership'].values()) and sample['mediaNodes']==0,'R12_CLEANUP_FAILED')
        for key,value in {'sourceHash':freeze['sourceHash'],'fixtureHash':freeze['fixtureHash'],'harnessHash':freeze['harnessHash'],
            'orchestratorHash':freeze['runnerHash'],'workerBundleHash':freeze['workers']['transmux']['sha256'],'cryptoWorkerBundleHash':freeze['workers']['crypto']['sha256']}.items():
            require(sample.get(key)==value,'R12_SAMPLE_AUTHORITY_CHANGED')
        c=sample['counters']['observed'];cycle=sample['cycle'];sessions=3*cycle
        require(all(c.get(k)==0 for k in ('workersCreated','workersTerminated','workerMessagesSent','workerMessagesReceived','workerErrors','workerMessagesCancelled',
            'mediaSourcesCreated','sourceBuffersCreated','bytesAppended','playbackStarted','playbackCompleted','rangeRequestsFailed','rangeRequestsAborted','pendingOperations',
            'activeRanges','pendingAppends','transferFailures','unhandledRejections','unexpectedPeripheralOperations','outstandingSubscriptions')) and
            all(c.get(k)==9*cycle for k in ('rangeRequestsStarted','rangeRequestsCompleted','jwtRangesValidated','http206Validated')) and
            c['metadataRequests']==sessions and c['rangeBytesReceived']==freeze['workload']['bytesPerCycle']*cycle,'R12_WORKLOAD_OR_PIPELINE_CHANGED')
        validate_counter(sample['counters'][counter_name],sessions)
    require(all(s['counters'][counter_name]==samples[6]['counters'][counter_name] for s in samples[7:]),'R12_IDLE_WORKLOAD_CHANGED')


def validate_classifier_result(result,mode,candidate=None):
    if isinstance(result,dict):
        if result in ({'status':'R12_CONTROL_NOT_REPRODUCED'},{'status':'R12_INCONCLUSIVE'}) and mode=='triage':return result
        if result=={'status':'R12_FORMAL_DISAGREEMENT'} and mode=='formal':return result
        keys={'status','contrast','pair','highCondition','lowCondition'}
        if mode=='formal':keys.add('separationMiB')
        if set(result)==keys and type(result['contrast']) is int and 1<=result['contrast']<=4:
            pair=list(PAIRS[result['contrast']-1])
            if result['pair']==pair and {result['highCondition'],result['lowCondition']}==set(pair):
                if mode=='triage' and result['status']=='R12_CANDIDATE':return result
                if mode=='formal' and result['status']=='R12_CONTRAST_CONFIRMED' and all(result[k]==candidate[k] for k in keys-{'status','separationMiB'}) and type(result['separationMiB']) in (int,float) and math.isfinite(result['separationMiB']):return result
    raise WaveFailure('R12_CLASSIFIER_BRIDGE_FAILED')


def classify(wave,values,formal=None,candidate=None):
    require(isinstance(values,dict) and set(values)==set(CONDITIONS) and all(type(v) in (int,float) and math.isfinite(v) for v in values.values()),'R12_INVALID_DELTAS')
    payload={'mode':'triage','values':values}
    if formal is not None:
        validate_classifier_result(candidate,'triage');require(candidate['status']=='R12_CANDIDATE','R12_INVALID_CANDIDATE')
        require(isinstance(formal,(list,tuple)) and len(formal)==6,'R12_INVALID_FORMAL_COUNT')
        projected=[]
        for row in formal:
            require(isinstance(row,dict) and row.get('condition') in CONDITIONS and type(row.get('rendererPrivateDeltaMiB')) in (int,float) and math.isfinite(row['rendererPrivateDeltaMiB']),'R12_INVALID_FORMAL_SCALAR')
            projected.append({k:row[k] for k in ('condition','rendererPrivateDeltaMiB')})
        payload={'mode':'formal','candidate':candidate,'control':values['r12.3'],'formal':projected}
    serialized=json.dumps(payload,allow_nan=False,separators=(',',':'))
    require(len(serialized.encode())<=4096,'R12_CLASSIFIER_INPUT_TOO_LARGE')
    try:
        process=subprocess.run([wave.node,'tools/ap06-r12-classifier.mjs'],input=serialized,capture_output=True,text=True,encoding='utf-8',cwd=wave.root/'frontend',timeout=30,check=True)
        require(len(process.stdout.encode())<=4096,'R12_CLASSIFIER_OUTPUT_TOO_LARGE')
        return validate_classifier_result(json.loads(process.stdout),payload['mode'],candidate)
    except (OSError,subprocess.SubprocessError,UnicodeError,ValueError,KeyError,TypeError):raise WaveFailure('R12_CLASSIFIER_BRIDGE_FAILED') from None


def unit_browser(wave):
    checks=read(wave.output/'baseline/prechecks.json')
    require(not wave.git('status','--porcelain').strip() and all(checks.get(k)=='PASS' for k in
        ('status','secretScan','angularBuild','typescript','syntax','diff')),'R12_PRECHECKS_REQUIRED')
    reservation=wave.output/'pipeline/development-reservation.json'
    with reservation.open('x',encoding='utf-8') as stream:json.dump({'campaign':'AP-06-R12','head':wave.git('rev-parse','HEAD'),'maximum':1,'retries':0},stream)
    publish(wave,'development-reserved',{'evidence/development-reservation.json':reservation})
    env,assets=environment(wave,wave.output/'tooling','r12.0');target=wave.output/'tooling/angular-unit-1.json';env['AP06_R7_UNIT_OUTPUT']=str(target)
    failure=None
    with media_server(media_files(wave),True,'application/octet-stream',assets,port=42088) as (origin,stats):
        env['AP06_R5_MEDIA_ORIGIN']=origin
        try:wave.command('r12-preflight',[wave.node,'tools/ap06-r12-preflight.mjs'],wave.root/'frontend',env)
        except WaveFailure as error:failure=error
        finally:
            if target.exists():publish(wave,'preflight-complete',{'evidence/preflight.raw.json':target})
            wave.save('pipeline/preflight-transport.json',stats)
    unit=read(target)
    require(not failure and unit['status']=='PASS' and unit['unitBrowserLaunches']==unit['unitBrowserLaunchAttempts']==1 and unit['browserClosed'] and unit['processExitAudit']['status']=='PASS','R12_PREFLIGHT_FAILED')
    workload=read(wave.output/'baseline/workload.json');fixtures=read(wave.output/'fixtures/manifest.json');mapping=read(wave.output/'baseline/backend-authority.json')['fileMapping']
    for condition in CONDITIONS:
        alias='r10.1' if condition in FETCH else 'r10.0';network=unit['rangeNetworks'][condition]
        require(unit['transportProofs'][condition]==expected_proof(alias),'R12_PREFLIGHT_DI_INVALID')
        validate_bootstrap_network(network['cdp'],alias)
        require(validate_network({'rangeNetwork':network['cdp'],'backendTraffic':network['backend']},condition,workload['rangesPerCycle'],fixtures,mapping,expected_type='Fetch' if condition in FETCH else 'XHR')==workload['bytesPerCycle'],'R12_PREFLIGHT_BYTES_CHANGED')
        case=next(c for c in unit['cases'] if c['condition']==condition)
        validate_process_lifecycle(case['processSamples'],'r11.2')
        for sample in case['processSamples']:validate_memory(sample,case['processSamples'][0])
        validate_scalars(unit['scalarCounters'][condition],condition,3,workload['bytesPerCycle'])
    require(len(unit['cases'])==6 and all(c['status']=='PASS' and c['contextClosed'] for c in unit['cases']),'R12_PREFLIGHT_CASES_MISSING')
    wave.save('baseline/preflight-ready.json',{'status':'PASS','developmentChromium':1,'retries':0})
    publish(wave,'preflight-ready',{'evidence/preflight-ready.json':wave.output/'baseline/preflight-ready.json'})


def freeze(wave):
    require(read(wave.output/'baseline/preflight-ready.json')['status']=='PASS','R12_PREFLIGHT_REQUIRED')
    freeze_implementation(wave,output=OUTPUT,harness='frontend/tools/ap06-r12-probe.mjs',runner_path=Path(__file__),extra_publications=('custody',),
        extra_files=('baseline/prechecks.json','baseline/preregistered-protocol.json','baseline/custody-readback.json','baseline/backend-isolation.json',
            'baseline/experimental-backend.json','baseline/ci.json','baseline/preflight-ready.json','baseline/prior-publications.json','pipeline/development-reservation.json',
            'tooling/backend-build/nanika_ap06_local_server.exe','tooling/backend-build/CMakeCache.txt','tooling/backend-build/compile_commands.json',
            'baseline/runtime-credentials.dpapi','baseline/runtime-credentials-custody.json'),
        protocol={'campaign':'AP-06-R12','protocol':read(wave.output/'baseline/preregistered-protocol.json'),
            'readiness':dict.fromkeys(('units','angularIntegration','build','preflight','integrity','secretScan'),'PASS')})


def campaign_run(wave):
    freeze=read(wave.output/'tooling/freeze.json')
    require(not (wave.output/'pipeline/launch-ledger.json').exists() and not (wave.output/'pipeline/campaign-started.json').exists(),'R12_NO_RETRY_OR_RESUME')
    verify_r11_freeze(wave,freeze)
    with (wave.output/'pipeline/campaign-started.json').open('x') as stream:json.dump({'head':freeze['implementationHead'],'retries':0},stream)
    ledger=[];results=[];values={}
    def one(condition,stage):
        result=measure(wave,condition,stage,freeze,ledger,requested=1,directory_name=f'{len(ledger)+1:02}-{condition}',budget_fn=check_budget,
            verify_fn=verify_r11_freeze,environment_fn=environment,validate_fn=validate_condition,probe='tools/ap06-r12-probe.mjs')
        result['rendererPrivateDeltaMiB']=renderer_delta(read(wave.output/result['rawPath']));results.append(result);wave.save('pipeline/results.json',results);return result
    for condition in CONDITIONS:
        values[condition]=one(condition,'triage')['rendererPrivateDeltaMiB']
        if condition=='r12.3' and values[condition]<300:
            decision={'status':'R12_CONTROL_NOT_REPRODUCED'};break
    else:
        decision=classify(wave,values);wave.save('pipeline/triage-decision.json',decision)
        publish(wave,'triage-decision',{'evidence/triage-decision.json':wave.output/'pipeline/triage-decision.json'})
        if decision['status']=='R12_CANDIDATE':
            a,b=decision['pair'];formal=[one(c,'formal') for c in (a,b,b,a,a,b)];decision=classify(wave,values,formal,decision)
    wave.save('final/decision.json',dict(decision,results=results,chromiumMeasurement=len(ledger),retries=0,ap06='OPEN'))
    publish(wave,'campaign-decision',{'evidence/campaign-decision.json':wave.output/'final/decision.json'});return 0


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for action in ('unit-browser','freeze','run','verify-freeze'):parser.add_argument('--'+action,action='store_true')
    parser.add_argument('--publish-raw',type=Path);parser.add_argument('--snapshot');parser.add_argument('--validate-processes',type=Path);parser.add_argument('--condition',choices=CONDITIONS)
    args=parser.parse_args();wave=Wave(Path(__file__).resolve().parents[2]);wave.output=wave.root/OUTPUT
    if args.validate_processes:
        path=checked_path(args.validate_processes.absolute());require(path.is_relative_to(wave.output),'R12_PREFLIGHT_PATH_INVALID')
        samples=next(c for c in read(path)['cases'] if c['condition']==args.condition)['processSamples'];validate_process_lifecycle(samples,'r11.2')
        for sample in samples:validate_memory(sample,samples[0])
        print(json.dumps({'status':'PASS','condition':args.condition,'samples':len(samples)}));return 0
    with tempfile.TemporaryDirectory(prefix='ap06-r12-') as tmp:
        wave.temp=Path(tmp)
        try:
            if args.unit_browser:unit_browser(wave)
            elif args.freeze:freeze(wave)
            elif args.verify_freeze:verify_r11_freeze(wave,read(wave.output/'tooling/freeze.json'))
            elif args.run:return campaign_run(wave)
            elif args.publish_raw:
                path=checked_path(args.publish_raw.absolute());require(path.is_relative_to(wave.output) and re.fullmatch(r'(triage|formal)-\d{2}-r12\.[0-4]',args.snapshot or ''),'R12_RAW_PATH_INVALID')
                publish(wave,'raw-'+args.snapshot,{f'evidence/raws/{args.snapshot}.json':path})
            else:parser.error('action required')
        except (WaveFailure,ValueError,OSError,subprocess.SubprocessError) as error:
            reason=str(error) if re.fullmatch(r'[A-Z][A-Z0-9_:]+',str(error)) else 'R12_EXECUTION_FAILED'
            stop={'status':'R12_BLOCKED','reason':reason,'ap06':'OPEN'};wave.save('final/STOP.json',stop)
            publish(wave,'stop-'+('preflight' if args.unit_browser else 'campaign'),{'evidence/STOP-'+('preflight' if args.unit_browser else 'campaign')+'.json':wave.output/'final/STOP.json'})
            print(json.dumps(stop));return 1
    return 0


if __name__=='__main__':raise SystemExit(main())
