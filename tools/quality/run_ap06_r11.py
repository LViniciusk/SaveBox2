"""R11: fixed renderer attribution protocol, existing collectors, zero retries."""
import argparse
import copy
import json
import math
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile

from run_readiness_wave1 import Wave, WaveFailure
from run_ap06_integration_probe import read, audit_closed_pids, VERSION
from run_ap06_r9 import (publish, media_files, runtime_environment, freeze_implementation,
    verify_freeze, measure, validate_network)
from run_ap06_r10 import validate_condition as validate_r10, validate_auxiliary, validate_bootstrap_network, expected_proof
from run_ap06_transport_probe import media_server
from ap06_authorities import sha256, checked_path

OUTPUT='.quality/readiness-wave11'
CAMPAIGN='AP-06-R11'
PUBLISHER=Path(__file__)
CONDITIONS=('r11.0','r11.1','r11.2','r11.3')
MIB=1024**2
AUDIO_SERVICE='audio.mojom.AudioService'
PLAYBACK_CONDITIONS=frozenset(('r11.0','r11.1'))
EXPECTED_PHASES=('baseline',*[f'cycle-{i}-close' for i in range(1,7)],
    'post-teardown-settled','idle-30s','forced-GC-final')


def is_r11_followup():
    return CAMPAIGN in ('AP-06-R11-R2','AP-06-R11-R3')


def project_r11_to_r10(raw,alias):
    if alias not in ('r10.0','r10.1'):raise ValueError('R11_INVALID_R10_ALIAS')
    adapted=copy.deepcopy(raw)
    adapted.update(condition=alias,stage='triage',transport='xhr' if alias=='r10.0' else 'range-fetch')
    run=adapted['runs'][0]
    run['runId']='triage-01-r10.0' if alias=='r10.0' else 'triage-02-r10.1'
    run['samples']=[s for s in run['samples'] if s['phase'] not in ('post-teardown-settled','idle-30s')]
    if len(run['samples'])!=8:raise ValueError('R11_R10_PROJECTION_INVALID')
    adapted['processSampleCalls']=len(run['samples'])
    return adapted


def process_types(sample):
    result={}
    if not sample.get('processMemory',{}).get('processes'):
        raise ValueError('R11_PROCESS_UNAVAILABLE')
    for row in sample['processMemory']['processes']:
        pid=row['pid'];kind=row['type']
        if type(pid) is not int or pid<=0 or pid in result:raise ValueError('R11_INVALID_PROCESS_IDENTITY')
        if not isinstance(kind,str) or not kind:raise ValueError('R11_INVALID_PROCESS_TYPE')
        result[pid]=kind
    if not result:raise ValueError('R11_PROCESS_UNAVAILABLE')
    return result


def validate_process_lifecycle(samples,condition):
    if (condition not in CONDITIONS or len(samples)<2 or samples[0].get('phase')!='baseline' or samples[0].get('cycle')!=0 or
            samples[1].get('phase')!='cycle-1-close' or samples[1].get('cycle')!=1):
        raise ValueError('R11_INVALID_PROCESS_TIMELINE')
    def split(sample):
        processes=process_types(sample)
        return {pid:kind for pid,kind in processes.items() if kind!=AUDIO_SERVICE},{pid for pid,kind in processes.items() if kind==AUDIO_SERVICE}
    stable,baseline_audio=split(samples[0])
    if len(baseline_audio)>1:raise ValueError('R11_MULTIPLE_AUDIO_SERVICES')
    if any(list(stable.values()).count(kind)!=1 for kind in ('browser','renderer','network.mojom.NetworkService')) or sum(kind in ('GPU','gpu-process') for kind in stable.values())!=1:
        raise ValueError('R11_MISSING_CORE_PROCESS')
    expected_audio=baseline_audio
    for index,sample in enumerate(samples[1:],1):
        current,audio=split(sample)
        if current!=stable:raise ValueError('R11_PROCESS_IDENTITY_CHANGED')
        if len(audio)>1:raise ValueError('R11_MULTIPLE_AUDIO_SERVICES')
        if index==1:
            if audio!=baseline_audio and (condition not in PLAYBACK_CONDITIONS or baseline_audio or len(audio)!=1):
                raise ValueError('R11_UNEXPECTED_AUDIO_LIFECYCLE')
            expected_audio=audio
        elif audio!=expected_audio:raise ValueError('R11_AUDIO_LIFECYCLE_CHANGED')


def check_budget(budget,previous,requested):
    if (budget.get('approved') is not True or budget.get('measurementMaximum')!=10 or budget.get('measurementRetries')!=0 or
            type(previous) is not int or not 0<=previous<10 or type(requested) is not int or requested!=1):
        raise ValueError('R11_BROWSER_BUDGET_EXCEEDED')


def reserve_development(path,head):
    with path.open('x',encoding='utf-8') as stream:
        json.dump({'campaign':CAMPAIGN,'implementationHead':head,'developmentMaximum':1,'measurementMaximum':10,'retries':0},stream)


def validate_memory(sample,baseline):
    memory=sample.get('processMemory',{})
    if memory.get('status')!='AVAILABLE':raise ValueError('R11_PROCESS_UNAVAILABLE')
    process_types(sample)
    rows=memory['processes']
    categories=memory['byCategory']
    if any(k not in categories for k in ('browser','renderer','gpu-process','utility')):raise ValueError('R11_PROCESS_MISSING')
    values=[memory['privateBytes'],*[r['privateBytes'] for r in rows],*[r['privateBytes'] for r in categories.values()]]
    if any(type(v) not in (int,float) or not math.isfinite(v) or v<0 for v in values):raise ValueError('R11_INVALID_PRIVATE_BYTES')
    if sum(r['privateBytes'] for r in rows)!=memory['privateBytes'] or sum(r['privateBytes'] for r in categories.values())!=memory['privateBytes']:
        raise ValueError('R11_PROCESS_TOTAL_MISMATCH')
    for kind,category in categories.items():
        selected=[r for r in rows if ('browser' if r['type']=='browser' else 'renderer' if r['type']=='renderer' else
            'gpu-process' if r['type'] in ('GPU','gpu-process') else 'utility' if 'Service' in r['type'] or 'utility' in r['type'] else 'other')==kind]
        if sum(r['privateBytes'] for r in selected)!=category['privateBytes']:raise ValueError('R11_CATEGORY_TOTAL_MISMATCH')
    types=memory.get('byType',{})
    if set(types)!={r['type'] for r in rows} or any(type(v.get('privateBytes')) not in (int,float) or
            not math.isfinite(v['privateBytes']) or v['privateBytes']<0 or
            v['privateBytes']!=sum(r['privateBytes'] for r in rows if r['type']==kind) for kind,v in types.items()):
        raise ValueError('R11_TYPE_TOTAL_MISMATCH')


def environment(wave,directory,condition,stage='triage',freeze=None):
    env,assets=runtime_environment(wave,directory,condition,stage,freeze,output=OUTPUT,publisher=PUBLISHER)
    env.update(AP06_R11_KEYS=str(wave.root/'tools/quality/ap06_r11_keys.py'),
        AP06_R11_AUTHORITY=str(wave.output/'baseline/authority-config.local.json'),
        AP06_R11_PROCESS_VALIDATOR=str(PUBLISHER) if is_r11_followup() else '',
        AP06_R11_ATTEMPT=stage+'-'+directory.name)
    return env,assets


def verify_r11_freeze(wave,freeze):
    try:verify_freeze(wave,freeze)
    except WaveFailure as error:raise WaveFailure('R11_RAW_AUTHORITY_CHANGED') from error
    versions=read(wave.output/'baseline/versions.json')
    checks=[(Path(versions['chromium']['executablePath']),versions['chromium']['sha256']),
        (Path(versions['nodeExecutable']),versions['nodeSha256']),
        (Path(versions['postgres']['bin'])/'postgres.exe',versions['postgres']['serverSha256'])]
    isolation=read(wave.output/'baseline/backend-isolation.json')
    runtime=Path(read(wave.output/'baseline/backend-runtime.local.json')['cwd'])
    checks.extend([(runtime/'pg/postgresql.conf',isolation['postgresConfigSha256']),
        (runtime/'pg/pg_hba.conf',isolation['pgHbaSha256'])])
    if any(sha256(path)!=digest for path,digest in checks):raise WaveFailure('R11_RUNTIME_BINARY_OR_CONFIG_CHANGED')


def validate_condition(raw,condition,stage,freeze,fixtures):
    try:return _validate_condition(raw,condition,stage,freeze,fixtures)
    except (KeyError,IndexError,TypeError) as error:
        raise WaveFailure('R11_VALIDATION_CONTRACT_FAILED') from error
    except WaveFailure as error:
        if str(error).startswith('R11_'):raise
        raise WaveFailure('R11_VALIDATION_CONTRACT_FAILED:'+str(error)) from error


def _validate_condition(raw,condition,stage,freeze,fixtures):
    run=raw['runs'][0];alias='r10.0' if condition=='r11.0' else 'r10.1'
    attempt=re.fullmatch(r'(triage|formal)-(\d{2})-(r11\.[0-3])',run['runId'])
    if (condition not in CONDITIONS or not attempt or attempt[1]!=stage or attempt[3]!=condition or
            (int(attempt[2])!=CONDITIONS.index(condition)+1 if stage=='triage' else not 5<=int(attempt[2])<=10)):
        raise WaveFailure('R11_ATTEMPT_IDENTITY_CHANGED')
    full=condition in ('r11.0','r11.1');workers=condition!='r11.2'
    proof={'httpWorkloadEquivalent':True,'cryptoWorkloadEquivalent':workers,'transmuxWorkloadEquivalent':workers,
        'mseWorkloadEquivalent':full,'playbackFunctional':full,'videoPlayerComponentUsed':full,'videoStreamServiceUsed':workers}
    if any(raw.get(k) is not v for k,v in proof.items()):raise WaveFailure('R11_STAGE_EQUIVALENCE_CHANGED')
    if (raw.get('fixtureManifestSha256')!=freeze['fixtureHash'] or raw.get('experimentalAppProducts')!=freeze['appProducts'] or
            raw.get('pageScriptSha256')!=freeze['pageScriptSha256'] or raw.get('backendAuthoritySha256')!=freeze['backendAuthoritySha256'] or
            raw.get('backendFileMapping')!=freeze['backendFileMapping'] or
            raw.get('workerBundleSha256')!=freeze['workers']['transmux']['sha256'] or
            raw.get('cryptoWorkerBundleSha256')!=freeze['workers']['crypto']['sha256']):raise WaveFailure('R11_RAW_AUTHORITY_CHANGED')
    if (raw['condition']!=condition or raw['stage']!=stage or raw['browserLaunches']!=1 or raw['launchAttempts']!=1 or raw['retries']!=0 or
            raw['transport']!=('xhr' if condition=='r11.0' else 'fetch') or len(raw['runs'])!=1 or
            run['functionalStatus']!='PASS' or run['cleanupStatus']!='PASS' or run['processExitAudit']['status']!='PASS' or
            run['browserVersion']!=VERSION or run['playbackSessions']!=18 or raw.get('pageErrors') or raw.get('recoveryWarnings') or
            any(raw['network'][k] for k in ('externalRequests','unexpectedRequests','rejectedRequests'))):
        raise WaveFailure('R11_RUN_IDENTITY_OR_FUNCTIONAL_FAILURE')
    samples=run['samples']
    if len(samples)!=10 or raw.get('processSampleCalls')!=10:raise WaveFailure('R11_PROCESS_SAMPLE_COUNT_CHANGED')
    if tuple(s['phase'] for s in samples)!=EXPECTED_PHASES or any(s['gc']!=('forced-diagnostic' if s['phase']=='forced-GC-final' else 'natural') for s in run['samples']):
        raise WaveFailure('R11_CHECKPOINTS_CHANGED')
    from datetime import datetime
    if [s['cycle'] for s in samples]!=[0,1,2,3,4,5,6,6,6,6]:raise WaveFailure('R11_CHECKPOINTS_CHANGED')
    for sample in samples:validate_memory(sample,samples[0])
    validate_process_lifecycle(samples,condition)
    if (datetime.fromisoformat(samples[-2]['timestamp'].replace('Z','+00:00'))-datetime.fromisoformat(samples[-3]['timestamp'].replace('Z','+00:00'))).total_seconds()<30:
        raise WaveFailure('R11_IDLE_TOO_SHORT')
    if run['transportProof']!=expected_proof(alias):raise WaveFailure('R11_DI_CHANGED')
    validate_bootstrap_network(run['rangeNetwork'],alias)
    received=validate_network(run,condition,freeze['workload']['rangesPerCycle']*6,fixtures,freeze['backendFileMapping'],
        expected_type='XHR' if condition=='r11.0' else 'Fetch')
    if received!=freeze['workload']['bytesPerCycle']*6:raise WaveFailure('R11_HTTP_WORKLOAD_CHANGED')
    identities=[{key:f[key] for key in ('id','name','bytes','sha256')} for f in fixtures]
    if (raw.get('fixtureIdentities')!=identities or raw.get('orchestratorHash')!=freeze['runnerHash']):
        raise WaveFailure('R11_RAW_AUTHORITY_CHANGED')
    pids=sorted({r['pid'] for s in samples for r in s['processMemory']['processes']})
    if run['processExitAudit']!={'status':'PASS','ownedPids':pids,'aliveOwnedPids':[]}:
        raise WaveFailure('R11_PROCESS_IDENTITY_CHANGED')
    requested=raw['network']['workerRequests'];allowed={v['name'] for v in freeze['workers'].values()}
    if set(requested)-allowed or (any(requested.get(name,0)==0 for name in allowed) if workers else bool(requested)):
        raise WaveFailure('R11_RAW_AUTHORITY_CHANGED')
    for sample in samples:
        validate_auxiliary(sample)
        if sample.get('browserVersion')!=VERSION or sample.get('functionalStatus')!='PASS' or sample.get('cleanupStatus')!='PASS':
            raise WaveFailure('R11_VALIDATION_CONTRACT_FAILED')
        for key,value in {'sourceHash':freeze['sourceHash'],'fixtureHash':freeze['fixtureHash'],'harnessHash':freeze['harnessHash'],
                'orchestratorHash':freeze['runnerHash'],'workerBundleHash':freeze['workers']['transmux']['sha256'],
                'cryptoWorkerBundleHash':freeze['workers']['crypto']['sha256']}.items():
            if sample.get(key)!=value:raise WaveFailure('R11_RAW_AUTHORITY_CHANGED')
        c=sample['counters']['observed'];cycle=sample['cycle']
        if (any(sample['ownership'].values()) or sample['mediaNodes'] or
                c['rangeRequestsCompleted']!=9*cycle or c['rangeBytesReceived']!=freeze['workload']['bytesPerCycle']*cycle or
                sample['counters']['r11']['sessionsCompleted']!=3*cycle):raise WaveFailure('R11_WORKLOAD_OR_CLEANUP_CHANGED')
        if (c.get('rangeRequestsStarted')!=c['rangeRequestsCompleted'] or c.get('jwtRangesValidated')!=9*cycle or
                c.get('http206Validated')!=9*cycle or c.get('workerMessagesSent')!=c.get('workerMessagesReceived') or
                c.get('workersCreated')!=c.get('workersTerminated') or any(c.get(k)!=0 for k in
                ('rangeRequestsFailed','rangeRequestsAborted','workerErrors','transferFailures','unhandledRejections',
                 'pendingOperations','pendingAppends','activeRanges','workerMessagesCancelled'))):
            raise WaveFailure('R11_WORKLOAD_OR_CLEANUP_CHANGED')
        r11=sample['counters']['r11']
        if (any(type(v) not in (int,float) or not math.isfinite(v) or v<0 for v in r11.values()) or
                r11.get('sessionsStarted')!=3*cycle or any(r11.get(k)!=0 for k in
                ('sessionsFailed','materializationsPending','materializationsFailed','workerProtocolFailures')) or
                r11.get('transferredBuffers')!=r11.get('detachedBuffers')):
            raise WaveFailure('R11_WORKLOAD_OR_CLEANUP_CHANGED')
        if cycle and (not r11.get('blobCount') or not r11.get('arrayBufferCount')):raise WaveFailure('R11_MATERIALIZATION_MISSING')
        if condition=='r11.2' and (r11.get('workerOutputBytes') or r11.get('transferBytes') or c['workersCreated'] or c['mediaSourcesCreated'] or c['bytesAppended']):raise WaveFailure('R11_ARRAYBUFFER_STAGE_ESCAPED')
        if condition=='r11.3' and (c['workersCreated']!=6*cycle or cycle and (not r11.get('workerOutputBytes') or not r11.get('segmentBytes')) or c['mediaSourcesCreated'] or c['bytesAppended'] or c['workerTransferBytesSent']!=freeze['workload']['workerTransferBytesSentPerCycle']*cycle):
            raise WaveFailure('R11_WORKER_STAGE_ESCAPED')
    if condition in ('r11.0','r11.1'):
        adapted=project_r11_to_r10(raw,alias)
        classification=validate_r10(adapted,alias,'triage',freeze,fixtures)
        if condition=='r11.0' and classification!='TRANSMUX_MSE_REPRODUCES_BROWSER_PROCESS_OWNERSHIP':
            raise WaveFailure('R11_XHR_CONTROL_NOT_REPRODUCED')
    else: classification='ATTRIBUTION_STAGE_VALID'
    return classification


def renderer_delta(raw):
    samples=raw['runs'][0]['samples']
    return (samples[6]['processMemory']['byCategory']['renderer']['privateBytes']-samples[0]['processMemory']['byCategory']['renderer']['privateBytes'])/MIB


def formal_scalars(results):
    if not isinstance(results,(list,tuple)) or len(results)!=6:raise ValueError('R11_INVALID_FORMAL_COUNT')
    projected=[]
    for result in results:
        if (not isinstance(result,dict) or result.get('condition') not in CONDITIONS or
                type(result.get('rendererPrivateDeltaMiB')) not in (int,float) or not math.isfinite(result['rendererPrivateDeltaMiB'])):
            raise ValueError('R11_INVALID_FORMAL_SCALAR')
        projected.append({k:result[k] for k in ('condition','rendererPrivateDeltaMiB')})
    return projected


def validate_classifier_result(result,mode,candidate=None):
    pairs={'H1':['r11.0','r11.2'],'H2':['r11.2','r11.3'],'H3':['r11.3','r11.1']}
    if isinstance(result,dict):
        status=result.get('status')
        if status in ('R11_CANDIDATE','R11_ATTRIBUTION_CONFIRMED'):
            if (set(result)=={'status','hypothesis','pair'} and isinstance(result['hypothesis'],str) and
                    result['pair']==pairs.get(result['hypothesis']) and result['hypothesis'] in pairs):
                if mode=='triage' and status=='R11_CANDIDATE':return result
                if mode=='formal' and status=='R11_ATTRIBUTION_CONFIRMED' and all(result[k]==candidate[k] for k in ('hypothesis','pair')):return result
        if status=='R11_INCONCLUSIVE' and (set(result)=={'status'} or mode=='formal' and
                result=={'status':'R11_INCONCLUSIVE','reason':'FORMAL_DISAGREEMENT'}):return result
        if mode=='triage' and result=={'status':'R11_CONTROL_NOT_REPRODUCED'}:return result
    raise WaveFailure('R11_CLASSIFIER_BRIDGE_FAILED')


def invoke_classifier(node,cwd,payload):
    try:serialized=json.dumps(payload,allow_nan=False,separators=(',',':'))
    except (TypeError,ValueError):raise ValueError('R11_CLASSIFIER_INVALID_INPUT') from None
    if len(serialized.encode('utf-8'))>4096:raise ValueError('R11_CLASSIFIER_INPUT_TOO_LARGE')
    try:
        result=subprocess.run([node,'tools/ap06-r11-classifier.mjs'],input=serialized,capture_output=True,
            text=True,encoding='utf-8',cwd=cwd,timeout=30,check=True)
        if len(result.stdout.encode('utf-8'))>4096:raise ValueError('R11_CLASSIFIER_OUTPUT_TOO_LARGE')
        decoded=json.loads(result.stdout)
        return validate_classifier_result(decoded,payload['mode'],payload.get('candidate'))
    except (OSError,subprocess.SubprocessError,json.JSONDecodeError,UnicodeError,KeyError,TypeError):
        raise WaveFailure('R11_CLASSIFIER_BRIDGE_FAILED') from None


def classify(wave,values,formal=None,candidate=None):
    if (not isinstance(values,dict) or set(values)!=set(CONDITIONS) or
            any(type(v) not in (int,float) or not math.isfinite(v) for v in values.values())):
        raise ValueError('R11_CLASSIFIER_INVALID_INPUT')
    payload={'mode':'triage','values':values}
    if formal is not None:
        validate_classifier_result(candidate,'triage')
        if candidate['status']!='R11_CANDIDATE':raise ValueError('R11_CLASSIFIER_INVALID_CANDIDATE')
        payload={'mode':'formal','candidate':candidate,'control':values['r11.1'],'formal':formal_scalars(formal)}
    return invoke_classifier(wave.node,wave.root/'frontend',payload)


def unit_browser(wave):
    if wave.git('status','--porcelain').strip() or read(wave.output/'baseline/prechecks.json')['status']!='PASS':raise WaveFailure('R11_PRECHECKS_REQUIRED')
    reservation=wave.output/'pipeline/development-reservation.json'
    reserve_development(reservation,wave.git('rev-parse','HEAD').strip())
    publish(wave,'development-reserved',{'evidence/development-reservation.json':reservation})
    env,assets=environment(wave,wave.output/'tooling','r11.0')
    env['AP06_R7_UNIT_OUTPUT']=str(wave.output/'tooling/angular-unit-1.json')
    failure=None
    with media_server(media_files(wave),True,'application/octet-stream',assets,port=42088) as (origin,stats):
        env['AP06_R5_MEDIA_ORIGIN']=origin
        try:wave.command('r11-preflight',[wave.node,'tools/ap06-r11-preflight.mjs'],wave.root/'frontend',env)
        except WaveFailure as error:failure=error
        finally:
            target=wave.output/'tooling/angular-unit-1.json'
            if target.exists():publish(wave,'preflight-complete',{'evidence/preflight.raw.json':target})
            wave.save('pipeline/preflight-transport.json',stats)
    unit=read(target)
    if failure or unit['status']!='PASS' or unit['unitBrowserLaunches']!=1:raise WaveFailure('R11_PREFLIGHT_FAILED')
    if is_r11_followup():
        for case in unit['cases']:
            validate_process_lifecycle(case['processSamples'],case['condition'])
            for sample in case['processSamples']:validate_memory(sample,case['processSamples'][0])
    sequences=[]
    fixtures=read(wave.output/'fixtures/manifest.json');mapping=read(wave.output/'baseline/backend-authority.json')['fileMapping']
    workload=read(wave.output/'baseline/workload.json')
    for condition in CONDITIONS:
        network=unit['rangeNetworks'][condition];alias='r10.0' if condition=='r11.0' else 'r10.1'
        if unit['transportProofs'][condition]!=expected_proof(alias):raise WaveFailure('R11_PREFLIGHT_DI_INVALID')
        validate_bootstrap_network(network['cdp'],alias)
        received=validate_network({'rangeNetwork':network['cdp'],'backendTraffic':network['backend']},condition,workload['rangesPerCycle'],fixtures,mapping,
            expected_type='XHR' if condition=='r11.0' else 'Fetch')
        if received!=workload['bytesPerCycle']:raise WaveFailure('R11_PREFLIGHT_BYTES_CHANGED')
    wave.save('baseline/preflight-ready.json',{'status':'PASS','developmentChromium':1,'retries':0})
    publish(wave,'preflight-ready',{'evidence/preflight-ready.json':wave.output/'baseline/preflight-ready.json'})


def freeze(wave):
    if read(wave.output/'baseline/preflight-ready.json')['status']!='PASS':raise WaveFailure('R11_PREFLIGHT_NOT_READY')
    extra=('baseline/history.json','baseline/prechecks.json','baseline/experimental-backend.json','baseline/listener-isolation.json',
        'baseline/network-spoof-guard.json','baseline/postgres-toolchain.json','baseline/custody-readback.json','baseline/preregistered-protocol.json','baseline/backend-isolation.json',
        'tooling/backend-build/nanika_ap06_local_server.exe','tooling/backend-build/CMakeCache.txt','tooling/backend-build/compile_commands.json')
    if CAMPAIGN=='AP-06-R11-R3':extra+=('baseline/retrospective-replay.json','baseline/ci.json','baseline/native-tests.json',
        'baseline/preflight-ready.json','pipeline/development-reservation.json','baseline/red-python.txt',
        'tooling/prepare.py','tooling/prechecks.py','tooling/replay.py','tooling/retrospective.py',
        'tooling/cleanup.py','tooling/readback.py','tooling/native-tests.py','tooling/backend-build/nanika_ap06_tests.exe')
    if is_r11_followup():extra+=('baseline/lifecycle-replay.json','baseline/runtime-credentials.dpapi','baseline/runtime-credentials-custody.json',
        'baseline/original-fdks.dpapi','baseline/original-custody.json','baseline/typescript.txt','baseline/acl-readback.json')
    freeze_implementation(wave,output=OUTPUT,harness='frontend/tools/ap06-r11-probe.mjs',runner_path=PUBLISHER,extra_files=extra,
        extra_publications=('custody',) if is_r11_followup() else (),
        protocol={'campaign':CAMPAIGN,'protocol':read(wave.output/'baseline/preregistered-protocol.json'),
            'readiness':dict.fromkeys(('units','angularIntegration','build','preflight','integrity','secretScan'),'PASS')})


def campaign_run(wave):
    freeze=read(wave.output/'tooling/freeze.json')
    if (wave.output/'pipeline/launch-ledger.json').exists():raise WaveFailure('R11_NO_RETRY_OR_RESUME')
    ledger=[];results=[];values={};formal=[]
    def one(condition,stage):
        index=len(ledger)+1
        result=measure(wave,condition,stage,freeze,ledger,requested=1,directory_name=f'{index:02}-{condition}',
            budget_fn=check_budget,verify_fn=verify_r11_freeze,environment_fn=environment,validate_fn=validate_condition,probe='tools/ap06-r11-probe.mjs')
        raw=read(wave.output/result['rawPath']);result['rendererPrivateDeltaMiB']=renderer_delta(raw)
        results.append(result);wave.save('pipeline/results.json',results)
        return result
    for condition in CONDITIONS:
        result=one(condition,'triage');values[condition]=result['rendererPrivateDeltaMiB']
        if condition=='r11.1' and values[condition]<300:raise WaveFailure('R11_CONTROL_NOT_REPRODUCED')
    candidate=classify(wave,values)
    wave.save('pipeline/triage-decision.json',candidate)
    publish(wave,'triage-decision',{'evidence/triage-decision.json':wave.output/'pipeline/triage-decision.json'})
    decision=candidate
    if candidate['status']=='R11_CANDIDATE':
        a,b=candidate['pair']
        for condition in (a,b,b,a,a,b):formal.append(one(condition,'formal'))
        decision=classify(wave,values,formal,candidate)
    wave.save('final/decision.json',dict(decision,results=results,chromiumMeasurement=len(ledger),retries=0,ap06='OPEN'))
    publish(wave,'campaign-decision',{'evidence/campaign-decision.json':wave.output/'final/decision.json'})
    return 0


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for flag in ('unit-browser','freeze','run','verify-freeze'):parser.add_argument('--'+flag,action='store_true')
    parser.add_argument('--publish-raw',type=Path);parser.add_argument('--snapshot')
    parser.add_argument('--validate-processes',type=Path);parser.add_argument('--condition',choices=CONDITIONS)
    args=parser.parse_args();wave=Wave(Path(__file__).resolve().parents[2]);wave.output=wave.root/OUTPUT
    if args.validate_processes:
        path=checked_path(args.validate_processes.absolute())
        if not path.is_relative_to(wave.output):raise ValueError('R11_PREFLIGHT_PATH_INVALID')
        case=next(c for c in read(path)['cases'] if c['condition']==args.condition)
        samples=case['processSamples'];validate_process_lifecycle(samples,args.condition)
        for sample in samples:validate_memory(sample,samples[0])
        print(json.dumps({'status':'PASS','condition':args.condition,'samples':len(samples)}));return 0
    with tempfile.TemporaryDirectory(prefix='ap06-r11-') as tmp:
        wave.temp=Path(tmp)
        try:
            if args.unit_browser:unit_browser(wave)
            elif args.freeze:freeze(wave)
            elif args.verify_freeze:verify_r11_freeze(wave,read(wave.output/'tooling/freeze.json'))
            elif args.publish_raw:
                path=checked_path(args.publish_raw.absolute())
                if not path.is_relative_to(wave.output) or not args.snapshot:raise ValueError('R11_RAW_PATH_INVALID')
                publish(wave,'raw-'+args.snapshot,{f'evidence/raws/{args.snapshot}.json':path})
            elif args.run:return campaign_run(wave)
            else:parser.error('action required')
        except (WaveFailure,ValueError) as error:
            stop={'status':'BLOCKED_'+CAMPAIGN.replace('-','_'),'reason':str(error),'ap06':'OPEN'}
            wave.save('final/STOP.json',stop)
            publish(wave,'stop-'+('preflight' if args.unit_browser else 'campaign'),{'evidence/STOP-'+('preflight' if args.unit_browser else 'campaign')+'.json':wave.output/'final/STOP.json'})
            print(json.dumps(stop));return 1
    return 0


if __name__=='__main__':raise SystemExit(main())
