"""R11: fixed renderer attribution protocol, existing collectors, zero retries."""
import argparse
import copy
import json
import math
import os
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
from ap06_authorities import sha256

OUTPUT='.quality/readiness-wave11'
CONDITIONS=('r11.0','r11.1','r11.2','r11.3')
MIB=1024**2


def check_budget(budget,previous,requested):
    if (budget.get('approved') is not True or budget.get('measurementMaximum')!=10 or budget.get('measurementRetries')!=0 or
            type(previous) is not int or not 0<=previous<10 or type(requested) is not int or requested!=1):
        raise ValueError('R11_BROWSER_BUDGET_EXCEEDED')


def reserve_development(path,head):
    with path.open('x',encoding='utf-8') as stream:
        json.dump({'campaign':'AP-06-R11','implementationHead':head,'developmentMaximum':1,'measurementMaximum':10,'retries':0},stream)


def validate_memory(sample,baseline):
    memory=sample['processMemory'];before=baseline['processMemory']
    if memory['status']!='AVAILABLE':raise ValueError('R11_PROCESS_UNAVAILABLE')
    rows=memory['processes'];ids=[r['pid'] for r in rows]
    if (len(ids)!=len(set(ids)) or not rows or any(type(pid) is not int or pid<=0 for pid in ids) or
            {(r['pid'],r['type']) for r in rows}!={(r['pid'],r['type']) for r in before['processes']}):
        raise ValueError('R11_PROCESS_IDENTITY_CHANGED')
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


def environment(wave,directory,condition,stage='triage',freeze=None):
    env,assets=runtime_environment(wave,directory,condition,stage,freeze,output=OUTPUT,publisher=Path(__file__))
    env.update(AP06_R11_KEYS=str(wave.root/'tools/quality/ap06_r11_keys.py'),
        AP06_R11_AUTHORITY=str(wave.output/'baseline/authority-config.local.json'),
        AP06_R11_ATTEMPT=stage+'-'+directory.name)
    return env,assets


def verify_r11_freeze(wave,freeze):
    verify_freeze(wave,freeze)
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
    run=raw['runs'][0];alias='r10.0' if condition=='r11.0' else 'r10.1'
    if condition not in CONDITIONS or not run['runId'].startswith(stage+'-') or run['runId'].split('-',2)[-1]!=condition:
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
    phases=['baseline',*[f'cycle-{i}-close' for i in range(1,7)],'post-teardown-settled','idle-30s','forced-GC-final']
    if [s['phase'] for s in run['samples']]!=phases or any(s['gc']!=('forced-diagnostic' if s['phase']=='forced-GC-final' else 'natural') for s in run['samples']):
        raise WaveFailure('R11_CHECKPOINTS_CHANGED')
    from datetime import datetime
    samples=run['samples']
    if (datetime.fromisoformat(samples[-2]['timestamp'].replace('Z','+00:00'))-datetime.fromisoformat(samples[-3]['timestamp'].replace('Z','+00:00'))).total_seconds()<30:
        raise WaveFailure('R11_IDLE_TOO_SHORT')
    if run['transportProof']!=expected_proof(alias):raise WaveFailure('R11_DI_CHANGED')
    validate_bootstrap_network(run['rangeNetwork'],alias)
    received=validate_network(run,condition,freeze['workload']['rangesPerCycle']*6,fixtures,freeze['backendFileMapping'],
        expected_type='XHR' if condition=='r11.0' else 'Fetch')
    if received!=freeze['workload']['bytesPerCycle']*6:raise WaveFailure('R11_HTTP_WORKLOAD_CHANGED')
    for sample in samples:
        validate_memory(sample,samples[0]);validate_auxiliary(sample)
        for key,value in {'sourceHash':freeze['sourceHash'],'fixtureHash':freeze['fixtureHash'],'harnessHash':freeze['harnessHash'],
                'orchestratorHash':freeze['runnerHash'],'workerBundleHash':freeze['workers']['transmux']['sha256'],
                'cryptoWorkerBundleHash':freeze['workers']['crypto']['sha256']}.items():
            if sample.get(key)!=value:raise WaveFailure('R11_SAMPLE_AUTHORITY_CHANGED')
        c=sample['counters']['observed'];cycle=sample['cycle']
        if (any(sample['ownership'].values()) or sample['mediaNodes'] or
                c['rangeRequestsCompleted']!=9*cycle or c['rangeBytesReceived']!=freeze['workload']['bytesPerCycle']*cycle or
                sample['counters']['r11']['sessionsCompleted']!=3*cycle):raise WaveFailure('R11_WORKLOAD_OR_CLEANUP_CHANGED')
        if condition=='r11.2' and (c['workersCreated'] or c['mediaSourcesCreated'] or c['bytesAppended']):raise WaveFailure('R11_ARRAYBUFFER_STAGE_ESCAPED')
        if condition=='r11.3' and (c['mediaSourcesCreated'] or c['bytesAppended'] or c['workerTransferBytesSent']!=freeze['workload']['workerTransferBytesSentPerCycle']*cycle):
            raise WaveFailure('R11_WORKER_STAGE_ESCAPED')
    if condition in ('r11.0','r11.1'):
        adapted=copy.deepcopy(raw);adapted.update(condition=alias,stage='triage',transport='xhr' if condition=='r11.0' else 'range-fetch')
        adapted['runs'][0]['runId']='triage-01-r10.0' if alias=='r10.0' else 'triage-02-r10.1'
        adapted['runs'][0]['samples']=[s for s in adapted['runs'][0]['samples'] if s['phase'] not in ('post-teardown-settled','idle-30s')]
        classification=validate_r10(adapted,alias,'triage',freeze,fixtures)
        if condition=='r11.0' and classification!='TRANSMUX_MSE_REPRODUCES_BROWSER_PROCESS_OWNERSHIP':
            raise WaveFailure('R11_XHR_CONTROL_NOT_REPRODUCED')
    else: classification='ATTRIBUTION_STAGE_VALID'
    return classification


def renderer_delta(raw):
    samples=raw['runs'][0]['samples']
    return (samples[6]['processMemory']['byCategory']['renderer']['privateBytes']-samples[0]['processMemory']['byCategory']['renderer']['privateBytes'])/MIB


def classify(wave,values,formal=None,candidate=None):
    script="import{classifyStages,confirmFormal}from'./tools/ap06-r11-contract.mjs';const v=JSON.parse(process.argv[1]);console.log(JSON.stringify(v.formal?confirmFormal(v.candidate,v.control,v.formal):classifyStages(v.values)))"
    payload={'values':values} if formal is None else {'candidate':candidate,'control':values['r11.1'],'formal':formal}
    return json.loads(subprocess.check_output([wave.node,'--input-type=module','-e',script,json.dumps(payload)],cwd=wave.root/'frontend',text=True))


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
    freeze_implementation(wave,output=OUTPUT,harness='frontend/tools/ap06-r11-probe.mjs',runner_path=__file__,extra_files=extra,
        protocol={'campaign':'AP-06-R11','protocol':read(wave.output/'baseline/preregistered-protocol.json'),
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
    args=parser.parse_args();wave=Wave(Path(__file__).resolve().parents[2]);wave.output=wave.root/OUTPUT
    with tempfile.TemporaryDirectory(prefix='ap06-r11-') as tmp:
        wave.temp=Path(tmp)
        try:
            if args.unit_browser:unit_browser(wave)
            elif args.freeze:freeze(wave)
            elif args.verify_freeze:verify_r11_freeze(wave,read(wave.output/'tooling/freeze.json'))
            elif args.publish_raw:
                path=args.publish_raw.absolute()
                if not path.is_relative_to(wave.output) or not args.snapshot:raise ValueError('R11_RAW_PATH_INVALID')
                publish(wave,'raw-'+args.snapshot,{f'evidence/raws/{args.snapshot}.json':path})
            elif args.run:return campaign_run(wave)
            else:parser.error('action required')
        except (WaveFailure,ValueError) as error:
            stop={'status':'BLOCKED_AP06_R11','reason':str(error),'ap06':'OPEN'}
            wave.save('final/STOP.json',stop)
            publish(wave,'stop-'+('preflight' if args.unit_browser else 'campaign'),{'evidence/STOP-'+('preflight' if args.unit_browser else 'campaign')+'.json':wave.output/'final/STOP.json'})
            print(json.dumps(stop));return 1
    return 0


if __name__=='__main__':raise SystemExit(main())
