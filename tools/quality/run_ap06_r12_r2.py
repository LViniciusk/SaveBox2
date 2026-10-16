"""R12-R2 factorial: strict mixed routing, shared HTTP samples and immutable measurement helpers."""
import argparse,json,math,re,subprocess,tempfile
from pathlib import Path
from run_readiness_wave1 import Wave,WaveFailure
from run_ap06_integration_probe import read,VERSION
from run_ap06_r9 import publish,media_files,runtime_environment,freeze_implementation,measure,validate_network
from run_ap06_r10 import expected_proof,validate_bootstrap_network
from run_ap06_r11 import verify_r11_freeze,renderer_delta,validate_process_lifecycle,validate_memory
from run_ap06_r12 import require,validate_scalars,validate_http_samples
from run_ap06_transport_probe import media_server
from ap06_authorities import checked_path

OUTPUT='.quality/readiness-wave12-r2-factorial'
CONDITIONS=dict(zip((f'r12r2.{i}' for i in range(4)),({'metadata':m,'payload':p} for m,p in (('xhr','xhr'),('fetch','xhr'),('xhr','fetch'),('fetch','fetch')))))
PAIRS=(('r12r2.0','r12r2.2'),('r12r2.1','r12r2.3'),('r12r2.0','r12r2.1'),('r12r2.2','r12r2.3'))

def transport_counts(condition,sessions):
    selected=CONDITIONS[condition]
    return {kind+transport+unit:(sessions*(1 if kind=='metadata' else 2) if unit=='Count' else sessions*(131072 if kind=='metadata' else 8388640)) if selected[kind]==transport else 0
        for kind in ('metadata','payload') for transport in ('xhr','fetch') for unit in ('Count','Bytes')}

def validate_mixed_network(run,condition,expected,fixtures,mapping):
    selected=CONDITIONS[condition]
    def expected_type(row):
        require(row['method']=='GET' and row['url']==f"http://127.0.0.1:42187/files/{row['fileId']}/download",'R12R2_RANGE_REQUEST_CHANGED')
        kind='metadata' if row['range']=='bytes=0-131071' else 'payload'
        return 'XHR' if selected[kind]=='xhr' else 'Fetch'
    validate_bootstrap_network(run['rangeNetwork'],'r10.1')
    return validate_network(run,condition,expected,fixtures,mapping,expected_type=expected_type)

def validate_condition(raw,condition,stage,freeze,fixtures):
    try:
        require(condition in CONDITIONS and stage in ('triage','formal') and len(raw['runs'])==1,'R12R2_RUN_IDENTITY_CHANGED')
        run=raw['runs'][0];attempt=re.fullmatch(r'(triage|formal)-(\d{2})-(r12r2\.[0-3])',run['runId'])
        require(attempt and attempt[1]==stage and attempt[3]==condition and
            (int(attempt[2])==list(CONDITIONS).index(condition)+1 if stage=='triage' else 5<=int(attempt[2])<=10),'R12R2_ATTEMPT_ORDER_CHANGED')
        identity={'videoPlayerComponentUsed':False,'videoStreamServiceUsed':False,'attributionDriverUsed':True,'httpWorkloadEquivalent':True,
            'metadataCommon':True,'workersUsed':False,'mseUsed':False,'playbackFunctional':False,'angularOrBackendUsed':True,'backendUsed':True,
            'driveStoreUsed':True,'playwrightRoutingInstalled':True,'localRequestsIntercepted':False,'fullKasumiContainer':True,'fetchInterceptionInstalled':False}
        require(all(raw.get(k) is v for k,v in identity.items()),'R12R2_STAGE_BOUNDARY_CHANGED')
        require(raw['condition']==condition and raw['stage']==stage and raw['transport']=='factorial' and raw['payload']=='blob' and
            raw['metadataTransport']==CONDITIONS[condition]['metadata'] and raw['payloadTransport']==CONDITIONS[condition]['payload'] and
            raw['browserLaunches']==raw['launchAttempts']==1 and raw['retries']==0 and raw['processSampleCalls']==11 and
            run['browserVersion']==VERSION and run['functionalStatus']==run['cleanupStatus']=='PASS' and run['playbackSessions']==18 and
            not raw['pageErrors'] and not raw['recoveryWarnings'] and not any(raw['network'][k] for k in ('externalRequests','unexpectedRequests','rejectedRequests','workerRequests')),'R12R2_FUNCTIONAL_OR_NETWORK_FAILURE')
        require(run['transportProof']==expected_proof('r10.1'),'R12R2_DI_CHANGED')
        received=validate_mixed_network(run,condition,freeze['workload']['rangesPerCycle']*6,fixtures,freeze['backendFileMapping'])
        require(received==freeze['workload']['bytesPerCycle']*6,'R12R2_HTTP_WORKLOAD_CHANGED')
        validate_http_samples(raw,freeze,fixtures,'r12r2',lambda c,s:validate_scalars(c,'r12.0',s,freeze['workload']['bytesPerCycle']))
        for sample in run['samples']:
            require(sample['counters']['routing']==transport_counts(condition,sample['cycle']*3),'R12R2_TRANSPORT_COUNTERS_CHANGED')
        return 'R12R2_FACTORIAL_VALID'
    except (KeyError,IndexError,TypeError,ValueError):raise WaveFailure('R12R2_RAW_CONTRACT_INVALID') from None

def check_budget(budget,previous,requested):
    require(budget.get('approved') is True and budget.get('developmentMaximum')==1 and budget.get('measurementMaximum')==10 and
        budget.get('measurementRetries')==0 and type(previous) is int and 0<=previous<10 and type(requested) is int and requested==1,'R12R2_BROWSER_BUDGET_EXCEEDED')

def environment(wave,directory,condition,stage='triage',freeze=None):
    env,assets=runtime_environment(wave,directory,condition,stage,freeze,output=OUTPUT,publisher=Path(__file__).resolve())
    env.update(AP06_R11_KEYS=str(wave.root/'tools/quality/ap06_r11_keys.py'),AP06_R11_AUTHORITY=str(wave.output/'baseline/authority-config.local.json'),
        AP06_R12R2_ATTEMPT=stage+'-'+directory.name)
    return env,assets

def validate_classifier_result(result,mode,candidate=None):
    require(isinstance(result,dict),'R12R2_CLASSIFIER_BRIDGE_FAILED')
    if mode=='triage':
        descriptive=result.get('effects');require(isinstance(descriptive,dict) and set(descriptive)=={'payloadWithXhrMetadata','payloadWithFetchMetadata','metadataWithXhrPayload','metadataWithFetchPayload','interaction'} and
            all(type(v) in (int,float) and math.isfinite(v) for v in descriptive.values()),'R12R2_CLASSIFIER_BRIDGE_FAILED')
    core={k:v for k,v in result.items() if k!='effects'}
    if mode=='triage' and core in ({'status':'R12R2_CONTROL_NOT_REPRODUCED'},{'status':'R12R2_FACTORIAL_INCONCLUSIVE'}):return result
    if mode=='formal' and core=={'status':'R12R2_FORMAL_DISAGREEMENT'}:return result
    keys={'status','contrast','pair','highCondition','lowCondition'}|({'separationMiB'} if mode=='formal' else set())
    require(set(core)==keys and type(core['contrast']) is int and 1<=core['contrast']<=4 and core['pair']==list(PAIRS[core['contrast']-1]) and
        {core['highCondition'],core['lowCondition']}==set(core['pair']),'R12R2_CLASSIFIER_BRIDGE_FAILED')
    require(core['status']==('R12R2_CANDIDATE' if mode=='triage' else 'R12R2_FACTORIAL_CONFIRMED'),'R12R2_CLASSIFIER_BRIDGE_FAILED')
    if mode=='formal':require(all(core[k]==candidate[k] for k in ('contrast','pair','highCondition','lowCondition')) and
        type(core['separationMiB']) in (int,float) and math.isfinite(core['separationMiB']) and core['separationMiB']>=150,'R12R2_CLASSIFIER_BRIDGE_FAILED')
    return result

def classify(wave,values,formal=None,candidate=None):
    require(isinstance(values,dict) and set(values)==set(CONDITIONS) and all(type(v) in (int,float) and math.isfinite(v) for v in values.values()),'R12R2_INVALID_DELTAS')
    payload={'mode':'triage','values':values}
    if formal is not None:
        validate_classifier_result(candidate,'triage');require(candidate['status']=='R12R2_CANDIDATE' and isinstance(formal,(list,tuple)) and len(formal)==6,'R12R2_INVALID_FORMAL')
        projected=[]
        for row in formal:
            require(isinstance(row,dict) and row.get('condition') in CONDITIONS and type(row.get('rendererPrivateDeltaMiB')) in (int,float) and math.isfinite(row['rendererPrivateDeltaMiB']),'R12R2_INVALID_FORMAL')
            projected.append({k:row[k] for k in ('condition','rendererPrivateDeltaMiB')})
        payload={'mode':'formal','candidate':{k:v for k,v in candidate.items() if k!='effects'},'control':values['r12r2.3'],'formal':projected}
    serialized=json.dumps(payload,allow_nan=False,separators=(',',':'));require(len(serialized.encode())<=4096,'R12R2_CLASSIFIER_INPUT_TOO_LARGE')
    try:
        process=subprocess.run([wave.node,'tools/ap06-r12-r2-classifier.mjs'],input=serialized,capture_output=True,text=True,encoding='utf-8',cwd=wave.root/'frontend',timeout=30,check=True)
        require(len(process.stdout.encode())<=4096,'R12R2_CLASSIFIER_BRIDGE_FAILED')
        return validate_classifier_result(json.loads(process.stdout),payload['mode'],candidate)
    except (OSError,subprocess.SubprocessError,UnicodeError,ValueError,KeyError,TypeError):raise WaveFailure('R12R2_CLASSIFIER_BRIDGE_FAILED') from None

def unit_browser(wave):
    checks=read(wave.output/'baseline/prechecks.json')
    require(not wave.git('status','--porcelain').strip() and all(checks.get(k)=='PASS' for k in ('status','secretScan','angularBuild','typescript','syntax','diff')),'R12R2_PRECHECKS_REQUIRED')
    reservation=wave.output/'pipeline/development-reservation.json'
    with reservation.open('x') as stream:json.dump({'campaign':'AP-06-R12-R2-factorial','head':wave.git('rev-parse','HEAD'),'maximum':1,'retries':0},stream)
    publish(wave,'development-reserved',{'evidence/development-reservation.json':reservation})
    env,assets=environment(wave,wave.output/'tooling','r12r2.0');target=wave.output/'tooling/angular-unit-1.json';env['AP06_R7_UNIT_OUTPUT']=str(target)
    with media_server(media_files(wave),True,'application/octet-stream',assets,port=42088) as (origin,stats):
        env['AP06_R5_MEDIA_ORIGIN']=origin
        try:wave.command('r12r2-preflight',[wave.node,'tools/ap06-r12-r2-preflight.mjs'],wave.root/'frontend',env)
        finally:
            if target.exists():publish(wave,'preflight-complete',{'evidence/preflight.raw.json':target})
            wave.save('pipeline/preflight-transport.json',stats)
    unit=read(target);require(unit['status']=='PASS' and unit['unitBrowserLaunchAttempts']==unit['unitBrowserLaunches']==1 and unit['browserClosed'] and unit['processExitAudit']['status']=='PASS','R12R2_PREFLIGHT_FAILED')
    workload=read(wave.output/'baseline/workload.json');fixtures=read(wave.output/'fixtures/manifest.json');mapping=read(wave.output/'baseline/backend-authority.json')['fileMapping']
    for condition in CONDITIONS:
        network=unit['rangeNetworks'][condition];require(unit['transportProofs'][condition]==expected_proof('r10.1'),'R12R2_PREFLIGHT_DI_CHANGED')
        require(validate_mixed_network({'rangeNetwork':network['cdp'],'backendTraffic':network['backend']},condition,workload['rangesPerCycle'],fixtures,mapping)==workload['bytesPerCycle'],'R12R2_PREFLIGHT_BYTES_CHANGED')
        validate_scalars(unit['scalarCounters'][condition],'r12.0',3,workload['bytesPerCycle'])
        require(unit['routingCounters'][condition]==transport_counts(condition,3),'R12R2_PREFLIGHT_ROUTING_CHANGED')
    require(len(unit['cases'])==5 and all(c['status']=='PASS' and c['contextClosed'] for c in unit['cases']),'R12R2_PREFLIGHT_CASES_MISSING')
    wave.save('baseline/preflight-ready.json',{'status':'PASS','developmentChromium':1,'retries':0});publish(wave,'preflight-ready',{'evidence/preflight-ready.json':wave.output/'baseline/preflight-ready.json'})

def freeze(wave):
    require(read(wave.output/'baseline/preflight-ready.json')['status']=='PASS','R12R2_PREFLIGHT_REQUIRED')
    freeze_implementation(wave,output=OUTPUT,harness='frontend/tools/ap06-r12-r2-probe.mjs',runner_path=Path(__file__),extra_publications=('custody',),
        extra_files=('baseline/prechecks.json','baseline/preregistered-protocol.json','baseline/custody-readback.json','baseline/backend-isolation.json',
            'baseline/experimental-backend.json','baseline/ci.json','baseline/preflight-ready.json','baseline/prior-publications.json','pipeline/development-reservation.json',
            'tooling/backend-build/nanika_ap06_local_server.exe','tooling/backend-build/CMakeCache.txt','tooling/backend-build/compile_commands.json',
            'baseline/runtime-credentials.dpapi','baseline/runtime-credentials-custody.json'),
        protocol={'campaign':'AP-06-R12-R2-factorial','protocol':read(wave.output/'baseline/preregistered-protocol.json'),
            'readiness':dict.fromkeys(('units','angularIntegration','build','preflight','integrity','secretScan'),'PASS')})

def campaign_run(wave):
    require(not any((wave.output/p).exists() for p in ('pipeline/launch-ledger.json','pipeline/campaign-started.json','final/STOP.json')),'R12R2_NO_RETRY_OR_RESUME')
    frozen=read(wave.output/'tooling/freeze.json');verify_r11_freeze(wave,frozen)
    with (wave.output/'pipeline/campaign-started.json').open('x') as stream:json.dump({'head':frozen['implementationHead'],'retries':0},stream)
    ledger=[];results=[];values={}
    def one(condition,stage):
        result=measure(wave,condition,stage,frozen,ledger,requested=1,directory_name=f'{len(ledger)+1:02}-{condition}',budget_fn=check_budget,
            verify_fn=verify_r11_freeze,environment_fn=environment,validate_fn=validate_condition,probe='tools/ap06-r12-r2-probe.mjs')
        result['rendererPrivateDeltaMiB']=renderer_delta(read(wave.output/result['rawPath']));results.append(result);wave.save('pipeline/results.json',results);return result
    for condition in CONDITIONS:values[condition]=one(condition,'triage')['rendererPrivateDeltaMiB']
    decision=classify(wave,values);wave.save('pipeline/triage-decision.json',decision);publish(wave,'triage-decision',{'evidence/triage-decision.json':wave.output/'pipeline/triage-decision.json'})
    if decision['status']=='R12R2_CANDIDATE':
        a,b=decision['pair'];formal=[one(c,'formal') for c in (a,b,b,a,a,b)];decision=classify(wave,values,formal,decision)
    wave.save('final/decision.json',dict(decision,results=results,triageValues=values,chromiumMeasurement=len(ledger),retries=0,ap06='OPEN'))
    publish(wave,'campaign-decision',{'evidence/campaign-decision.json':wave.output/'final/decision.json'})

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for action in ('unit-browser','freeze','run','verify-freeze'):parser.add_argument('--'+action,action='store_true')
    parser.add_argument('--publish-raw',type=Path);parser.add_argument('--snapshot');parser.add_argument('--validate-processes',type=Path);parser.add_argument('--condition',choices=CONDITIONS)
    args=parser.parse_args();wave=Wave(Path(__file__).resolve().parents[2]);wave.output=wave.root/OUTPUT
    with tempfile.TemporaryDirectory(prefix='ap06-r12r2-') as tmp:
        wave.temp=Path(tmp)
        try:
            if args.validate_processes:
                path=checked_path(args.validate_processes.absolute());require(path.is_relative_to(wave.output),'R12R2_PREFLIGHT_PATH_INVALID')
                samples=next(c for c in read(path)['cases'] if c['condition']==args.condition)['processSamples'];validate_process_lifecycle(samples,'r11.2')
                for sample in samples:validate_memory(sample,samples[0])
                print(json.dumps({'status':'PASS','samples':len(samples)}))
            elif args.unit_browser:unit_browser(wave)
            elif args.freeze:freeze(wave)
            elif args.run:campaign_run(wave)
            elif args.verify_freeze:verify_r11_freeze(wave,read(wave.output/'tooling/freeze.json'))
            elif args.publish_raw:
                path=checked_path(args.publish_raw.absolute());require(path.is_relative_to(wave.output) and re.fullmatch(r'(triage|formal)-\d{2}-r12r2\.[0-3]',args.snapshot or ''),'R12R2_RAW_PATH_INVALID')
                publish(wave,'raw-'+args.snapshot,{f'evidence/raws/{args.snapshot}.json':path})
            else:parser.error('action required')
        except (WaveFailure,ValueError,OSError,subprocess.SubprocessError) as error:
            reason=str(error) if re.fullmatch(r'[A-Z][A-Z0-9_:]+',str(error)) else 'R12R2_EXECUTION_FAILED'
            phase='preflight' if args.unit_browser else 'campaign';stop={'status':'R12R2_STOP','reason':reason,'ap06':'OPEN'};wave.save('final/STOP.json',stop)
            publish(wave,'stop-'+phase,{'evidence/STOP-'+phase+'.json':wave.output/'final/STOP.json'});print(json.dumps(stop));return 1
    return 0

if __name__=='__main__':raise SystemExit(main())
