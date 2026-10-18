"""One native capability browser, then at most two profiled runs; independent freeze and authority."""
import argparse,json,re,shutil,subprocess,tempfile
from pathlib import Path
from run_readiness_wave1 import Wave,WaveFailure
from run_ap06_integration_probe import read,build_products
from run_ap06_r9 import publish,verify_freeze,runtime_environment,freeze_implementation,measure
from run_ap06_r11 import verify_r11_freeze
from run_ap06_r12 import require
from run_ap06_r12_r2 import OUTPUT as FACTORIAL,validate_condition
from ap06_authorities import checked_path,private_permissions,validate_owned_destination,publish_authorities,sha256
from ap06_native import trace_events,aggregate_trace
from ap06_freeze import FreezeFailure

OUTPUT='.quality/readiness-wave12-r2-native'
CAMPAIGN='AP-06-R12-R2-native'
PUBLISHER=Path(__file__).resolve()
TRACE_PREFIX='r12-r2-native'
FACTORIAL_STATUS='R12R2_FACTORIAL_CONFIRMED'

def configure_campaign(output,publisher):
    global OUTPUT,PUBLISHER,CAMPAIGN,TRACE_PREFIX,FACTORIAL,FACTORIAL_STATUS
    match=re.fullmatch(r'\.quality/readiness-wave12-r([3-9]|10|11)-native',output)
    require(match is not None,'R12R3_NATIVE_CAMPAIGN_INVALID')
    round_name=match[1]
    OUTPUT,PUBLISHER=output,Path(publisher).resolve()
    CAMPAIGN,TRACE_PREFIX=f'AP-06-R12-R{round_name}-native',f'r12-r{round_name}-native'
    FACTORIAL=f'.quality/readiness-wave12-r{round_name}-factorial'
    FACTORIAL_STATUS=f'R12R{round_name}_FACTORIAL_CONFIRMED'
    import run_ap06_r12_r2 as factorial
    factorial.configure_campaign(FACTORIAL,PUBLISHER,f'AP-06-R12-R{round_name}-factorial')


def campaign_prefix():
    return 'R12'+CAMPAIGN.split('-')[-2]


def campaign_decision(value):
    return dict(value,status=value['status'].replace('R12R2_',campaign_prefix()+'_'))


def native_budget(budget,previous,requested):
    require(budget.get('approved') is True and budget.get('developmentMaximum')==1 and budget.get('measurementMaximum')==2 and
        budget.get('measurementRetries')==0 and type(previous) is int and 0<=previous<2 and type(requested) is int and requested==1 and
        (TRACE_PREFIX not in ('r12-r6-native','r12-r7-native','r12-r8-native','r12-r9-native','r12-r10-native','r12-r11-native') or (budget.get('globalMaximum')==14 and budget.get('nativeCapabilityMaximum')==1 and
            budget.get('nativeMeasurementMaximum')==2)),'R12R2_NATIVE_BUDGET_EXCEEDED')

def private_trace_path(wave,directory):
    config=read(wave.output/'baseline/authority-config.local.json');authority=Path(config['AP06_AUTHORITY_ROOT'])
    validate_owned_destination(authority,config['identity']);name='capability' if directory==wave.output/'pipeline' else directory.parent.name+'-'+directory.name
    require(re.fullmatch(r'capability|formal-0[56]-r12r2\.[0-3]',name) is not None,'R12R2_NATIVE_TRACE_NAME_INVALID')
    path=checked_path(authority/TRACE_PREFIX/'traces'/(name+'.json'))
    require(not path.exists(),'R12R2_NATIVE_TRACE_ALREADY_EXISTS')
    create=not path.parent.exists();path.parent.mkdir(parents=True,exist_ok=True);private_permissions(path.parent,create=create)
    wave.save(str((directory/'native-trace.json').relative_to(wave.output)),{'authorityRelativePath':path.relative_to(authority).as_posix()})
    return path

def seal_trace(wave,receipt):
    receipt=checked_path(receipt.absolute());require(receipt.is_relative_to(wave.output),'R12R2_NATIVE_RECEIPT_PATH_INVALID')
    registration=read(receipt.parent/'native-trace.json');config=read(wave.output/'baseline/authority-config.local.json');authority=Path(config['AP06_AUTHORITY_ROOT'])
    relative=registration['authorityRelativePath'];path=checked_path(authority/relative)
    require(path.is_relative_to(authority/TRACE_PREFIX/'traces') and path.suffix=='.json','R12R2_NATIVE_TRACE_PATH_INVALID')
    if not path.exists():return {'status':'NO_TRACE_WRITTEN'}
    digest=sha256(path);data=read(receipt);trace=data.get('trace',data)
    if trace.get('sha256') is not None:require(trace['sha256']==digest and trace['bytes']==path.stat().st_size,'R12R2_NATIVE_TRACE_CHECKSUM_CHANGED')
    manifest={'campaign':'AP-06-R10','files':[{'path':relative,'size':path.stat().st_size,'sha256':digest}]}
    # Adopt the sealed stream in place: sensitive trace bytes never enter a worktree or temp publication copy.
    result=publish_authorities(authority,authority,manifest,config['identity'],TRACE_PREFIX+'-trace-'+path.stem)
    wave.save(str((receipt.parent/'native-trace-seal.json').relative_to(wave.output)),dict(result,traceSha256=digest,bytes=path.stat().st_size))
    return result

def parse_trace(wave,receipt):
    data=read(receipt);trace=data.get('trace',data);config=read(wave.output/'baseline/authority-config.local.json')
    path=checked_path(Path(config['AP06_AUTHORITY_ROOT'])/read(receipt.parent/'native-trace.json')['authorityRelativePath'])
    if not path.exists():return {'status':'R12R2_NATIVE_PROFILER_UNAVAILABLE','reason':data.get('failureClass','NATIVE_TRACE_NOT_WRITTEN')}
    require(path.stat().st_size<=512*1024*1024,'R12R2_NATIVE_TRACE_SIZE_LIMIT')
    if trace.get('sha256'):require(sha256(path)==trace['sha256'],'R12R2_NATIVE_TRACE_CHECKSUM_CHANGED')
    try:
        with path.open(encoding='utf-8') as stream:result=aggregate_trace(trace_events(stream),trace)
    except (ValueError,UnicodeError):result={'status':'R12R2_NATIVE_INCONCLUSIVE','reason':'NATIVE_TRACE_INVALID_OR_TRUNCATED'}
    result.update(traceSha256=sha256(path),traceBytes=path.stat().st_size)
    return result

def environment(wave,directory,condition,stage='formal',freeze=None):
    env,assets=runtime_environment(wave,directory,condition,stage,freeze,output=OUTPUT,publisher=PUBLISHER)
    env.update(AP06_R11_KEYS=str(wave.root/'tools/quality/ap06_r11_keys.py'),AP06_R11_AUTHORITY=str(wave.output/'baseline/authority-config.local.json'),
        AP06_R12R2_ATTEMPT=stage+'-'+directory.name,AP06_NATIVE_TRACE=str(private_trace_path(wave,directory)),AP06_NATIVE_RECEIPT=str(directory/'native-receipt.json'))
    if TRACE_PREFIX in ('r12-r9-native','r12-r10-native','r12-r11-native'):env.pop('AP06_R9_PRIVATE_KEYS',None)
    if TRACE_PREFIX in ('r12-r3-native','r12-r4-native','r12-r5-native','r12-r6-native','r12-r7-native','r12-r8-native','r12-r9-native','r12-r10-native','r12-r11-native'):env['AP06_BROWSER_IDENTITY']=str(wave.output/'baseline/browser-identity.json')
    if TRACE_PREFIX in ('r12-r5-native','r12-r6-native','r12-r7-native','r12-r8-native','r12-r9-native','r12-r10-native','r12-r11-native'):env['AP06_R5_PROCESS_HANDLE_AUDIT']='1'
    if TRACE_PREFIX in ('r12-r4-native','r12-r5-native','r12-r6-native','r12-r7-native','r12-r8-native','r12-r9-native','r12-r10-native','r12-r11-native'):
        identity=read(wave.output/'baseline/browser-identity.json');profile_root=checked_path(Path(identity['launchProtocol']['profileRoot']))
        private_permissions(profile_root);env.update(AP06_BROWSER_TEMP_ROOT=str(profile_root),TEMP=str(profile_root),TMP=str(profile_root))
    return env,assets

def verify_identity_freeze(wave,frozen):
    verify_r11_freeze(wave,frozen)
    if TRACE_PREFIX=='r12-r11-native':
        from ap06_freeze import verify_freeze_completion
        verify_freeze_completion(wave,frozen)
    if TRACE_PREFIX=='r12-r11-native' and wave.output.name=='readiness-wave12-r11-factorial':
        import run_ap06_r12_r2 as factorial
        factorial.validate_r11_authority(wave,frozen.get('protocol'));factorial.validate_r8_corpus(wave)
    elif TRACE_PREFIX=='r12-r10-native' and wave.output.name=='readiness-wave12-r10-factorial':
        import run_ap06_r12_r2 as factorial
        factorial.validate_r10_authority(wave,frozen.get('protocol'));factorial.validate_r8_corpus(wave)
    elif TRACE_PREFIX=='r12-r9-native' and wave.output.name=='readiness-wave12-r9-factorial':
        import run_ap06_r12_r2 as factorial
        factorial.validate_r9_authority(wave,frozen.get('protocol'));factorial.validate_r8_corpus(wave)
    elif TRACE_PREFIX=='r12-r8-native' and wave.output.name=='readiness-wave12-r8-factorial':
        import run_ap06_r12_r2 as factorial
        factorial.validate_r8_authority(wave,frozen.get('protocol'));factorial.validate_r8_corpus(wave)
    elif TRACE_PREFIX in ('r12-r6-native','r12-r7-native') and wave.output.name in ('readiness-wave12-r6-factorial','readiness-wave12-r7-factorial'):
        import run_ap06_r12_r2 as factorial
        (factorial.validate_r7_authority if TRACE_PREFIX=='r12-r7-native' else factorial.validate_r6_authority)(wave,frozen.get('protocol'))
        factorial.validate_r6_corpus(wave)
    if TRACE_PREFIX in ('r12-r4-native','r12-r5-native','r12-r6-native','r12-r7-native','r12-r8-native','r12-r9-native','r12-r10-native','r12-r11-native'):
        from ap06_browser_identity import verify_identity
        identity=read(wave.output/'baseline/browser-identity.json')
        prefix=campaign_prefix()
        require(frozen.get('browserIdentity')==identity,prefix+'_BROWSER_FREEZE_CHANGED');verify_identity(identity)

def verify(wave,frozen):
    verify_identity_freeze(wave,frozen)
    gate=read(wave.output/'baseline/factorial-gate.json');factorial=Wave(wave.root);factorial.output=wave.root/FACTORIAL
    require(sha256(factorial.output/'tooling/freeze.json')==gate['factorialFreezeSha256'] and sha256(factorial.output/'final/decision.json')==gate['factorialDecisionSha256'],'R12R2_FACTORIAL_AUTHORITY_CHANGED')
    verify_identity_freeze(factorial,read(factorial.output/'tooling/freeze.json'))

def prepare(wave):
    source=wave.root/FACTORIAL;decision=read(source/'final/decision.json')
    require(decision['status']==FACTORIAL_STATUS and not (wave.output/'baseline/factorial-gate.json').exists(),'R12R2_NATIVE_GATE_NOT_AUTHORIZED_OR_RESTARTED')
    for name in ('baseline','pipeline','tooling','formal','final'):(wave.output/name).mkdir(parents=True,exist_ok=True)
    private_permissions(wave.output,create=True)
    if TRACE_PREFIX=='r12-r11-native':private_permissions(wave.output/'baseline',create=True)
    for directory in ('fixtures','tooling/app','tooling/backend-build'):shutil.copytree(source/directory,wave.output/directory,dirs_exist_ok=False)
    names=('authority-config.local.json','backend-runtime.local.json','player-auth.local.json','backend-authority.json','versions.json','tests.json',
        'task.md','workload.json','historical-r9.json','backend-isolation.json','experimental-backend.json','ci.json','runtime-credentials.dpapi',
        'runtime-credentials-custody.json','custody-readback.json','prechecks.json')
    for name in names:shutil.copyfile(source/'baseline'/name,wave.output/'baseline'/name)
    if TRACE_PREFIX=='r12-r11-native':
        from run_ap06_r12_r2 import security_freeze_files
        for name in security_freeze_files():
            shutil.copyfile(source/name,wave.output/name)
        for name in ('native-production.xml','native-experimental.xml'):
            shutil.copyfile(source/'baseline'/name,wave.output/'baseline'/name)
    if TRACE_PREFIX in ('r12-r8-native','r12-r9-native','r12-r10-native','r12-r11-native'):
        shutil.copyfile(source/'baseline/quality-baseline-ci.json',wave.output/'baseline/quality-baseline-ci.json')
        shutil.copyfile(source/'baseline/dependency-audit.json',wave.output/'baseline/dependency-audit.json')
        for name in ('native-binary-reuse.json','native-tests-summary.json'):
            shutil.copyfile(source/'baseline'/name,wave.output/'baseline'/name)
        shutil.copyfile(source/'baseline/global-quality-r8.json',wave.output/'baseline/global-quality-r8.json')
        for name in ('secret-scan-receipt.json','secret-scan.json'):
            shutil.copyfile(source/'baseline'/name,wave.output/'baseline'/name)
    if TRACE_PREFIX in ('r12-r6-native','r12-r7-native','r12-r8-native','r12-r9-native','r12-r10-native','r12-r11-native'):
        for name in ('task-provenance.json','corpus-provenance.json'):
            shutil.copyfile(source/'baseline'/name,wave.output/'baseline'/name)
    if TRACE_PREFIX in ('r12-r3-native','r12-r4-native','r12-r5-native','r12-r6-native','r12-r7-native','r12-r8-native','r12-r9-native','r12-r10-native','r12-r11-native'):
        shutil.copyfile(source/'baseline/browser-identity.json',wave.output/'baseline/browser-identity.json')
        shutil.copyfile(source/'baseline/browser-identity-publication.json',wave.output/'baseline/browser-identity-publication.json')
    if TRACE_PREFIX in ('r12-r9-native','r12-r10-native','r12-r11-native'):
        for name in ('runtime-credentials-readback.json','offline-ready.json','offline-integration.json',
            *(('playwright-identity-preflight.json',) if TRACE_PREFIX in ('r12-r10-native','r12-r11-native') else ())):
            shutil.copyfile(source/'baseline'/name,wave.output/'baseline'/name)
    shutil.copyfile(source/'tooling/kasumi.cjs',wave.output/'tooling/kasumi.cjs')
    wave.save('baseline/budget.json',{'approved':True,'developmentMaximum':1,'measurementMaximum':2,'measurementRetries':0,
        'globalMaximum':14,'nativeCapabilityMaximum':1,'nativeMeasurementMaximum':2})
    wave.save('baseline/factorial-gate.json',{'status':'PASS','decision':{k:v for k,v in decision.items() if k not in ('results',)},
        'factorialFreezeSha256':sha256(source/'tooling/freeze.json'),'factorialDecisionSha256':sha256(source/'final/decision.json')})
    wave.save('baseline/preregistered-protocol.json',{'campaign':CAMPAIGN,'gate':'One capability browser only after factorial formal confirmation',
        'conditions':read(source/'pipeline/triage-decision.json')['pair'],'measurements':2,'retries':0,
        'sourceProtocolSha256':sha256(source/'baseline/preregistered-protocol.json'),'capture':'CDP MemoryInfra ReturnAsStream JSON, native memlog 16384-byte sampling',
        'checkpoints':['baseline','cycle-6-close','idle-120s','forced-GC-final'],'limits':{'traceBytes':512*1024*1024,'eventBytes':32*1024*1024,'cdpTimeoutMs':30000,'streamTimeoutMs':120000},
        'interpretation':'Sampled live aggregate cohorts only; allocator coverage unproven; no individual lifetime, function culprit or LEAK_CONFIRMED from residual private bytes.'})

def native_freeze_extra_files():
    from run_ap06_r12_r2 import security_freeze_files
    identity_files=('baseline/browser-identity.json','baseline/browser-identity-publication.json','pipeline/native-receipt.json')
    return (*(security_freeze_files() if TRACE_PREFIX=='r12-r11-native' else ()),
            'baseline/factorial-gate.json','baseline/native-capability.json','baseline/preregistered-protocol.json','baseline/backend-isolation.json',
            *(('baseline/task-provenance.json','baseline/corpus-provenance.json') if TRACE_PREFIX in ('r12-r6-native','r12-r7-native','r12-r8-native','r12-r9-native','r12-r10-native','r12-r11-native') else ()),
            'baseline/ci.json',*(('baseline/quality-baseline-ci.json','baseline/dependency-audit.json','baseline/native-binary-reuse.json',
                'baseline/native-tests-summary.json','baseline/global-quality-r8.json','baseline/secret-scan-receipt.json',
                'baseline/secret-scan.json') if TRACE_PREFIX in ('r12-r8-native','r12-r9-native','r12-r10-native','r12-r11-native') else ()),
            *(('baseline/runtime-credentials-readback.json','baseline/offline-ready.json','baseline/offline-integration.json','tooling/app/stats.json',
                'baseline/playwright-identity-preflight.json') if TRACE_PREFIX in ('r12-r10-native','r12-r11-native') else
                ('baseline/runtime-credentials-readback.json','baseline/offline-ready.json','baseline/offline-integration.json','tooling/app/stats.json') if TRACE_PREFIX=='r12-r9-native' else ()),
            'baseline/runtime-credentials.dpapi','baseline/runtime-credentials-custody.json','tooling/backend-build/nanika_ap06_local_server.exe',*identity_files)


def run(wave):
    require(not any((wave.output/p).exists() for p in ('pipeline/capability-reservation.json','final/STOP.json','final/decision.json')),'R12R2_NATIVE_NO_RETRY_OR_RESUME')
    prepare(wave)
    factorial=Wave(wave.root);factorial.output=wave.root/FACTORIAL;frozen=read(factorial.output/'tooling/freeze.json');verify_identity_freeze(factorial,frozen)
    if TRACE_PREFIX=='r12-r11-native':
        from run_ap06_r9 import validate_freeze_readiness
        ready=validate_freeze_readiness(wave,output=OUTPUT,extra_files=native_freeze_extra_files(),extra_publications=('custody',))
        wave.save('baseline/freeze-readiness.json',ready)
    target=wave.output/'pipeline/native-receipt.json'
    with (wave.output/'pipeline/capability-reservation.json').open('x') as stream:json.dump({'maximum':1,'retries':0,'implementationHead':frozen['implementationHead']},stream)
    publish(wave,'capability-reserved',{'evidence/capability-reservation.json':wave.output/'pipeline/capability-reservation.json'})
    env,_=environment(wave,wave.output/'pipeline','r12r2.0');wave.command('native-capability',[wave.node,'tools/ap06-native-capability.mjs'],wave.root/'frontend',env)
    seal_trace(wave,target);record=read(target)
    if TRACE_PREFIX in ('r12-r3-native','r12-r4-native','r12-r5-native','r12-r6-native','r12-r7-native','r12-r8-native','r12-r9-native','r12-r10-native','r12-r11-native'):verify_identity_freeze(factorial,frozen)
    if TRACE_PREFIX in ('r12-r3-native','r12-r4-native','r12-r5-native','r12-r6-native','r12-r7-native','r12-r8-native','r12-r9-native','r12-r10-native','r12-r11-native'):
        from run_ap06_r12_r2 import validate_browser_receipt
        validate_browser_receipt(record,read(wave.output/'baseline/browser-identity.json'),native=True,
            process_samples=record.get('processSamples',()))
    require(record['launchAttempts']==record['browserLaunches']==1 and record['browserClosed'] and record.get('processExitAudit',{}).get('status')=='PASS','R12R2_NATIVE_CAPABILITY_LIFECYCLE_FAILED')
    capability=parse_trace(wave,target);wave.save('baseline/native-capability.json',capability)
    publish(wave,'capability-complete',{'evidence/capability-receipt.json':target,'evidence/capability.json':wave.output/'baseline/native-capability.json'})
    if capability['status']!='R12R2_NATIVE_CAPABILITY_PASS':
        wave.save('final/decision.json',dict(campaign_decision(capability),capabilityChromium=1,measurementChromium=0,retries=0));publish(wave,'decision',{'evidence/decision.json':wave.output/'final/decision.json'});return
    assets,products,workers=build_products(wave.root,OUTPUT);unit=read(factorial.output/'tooling/angular-unit-1.json')
    unit.update(appProducts=products,pageScriptSha256=frozen['pageScriptSha256'],nativeCapabilitySha256=sha256(wave.output/'baseline/native-capability.json'),
        nativeGateBrowserLaunches=1,provenance='Factorial app preflight plus one independent native capability browser, no extra browser')
    wave.save('tooling/angular-unit-1.json',unit)
    identity_files=('baseline/browser-identity.json','baseline/browser-identity-publication.json','pipeline/native-receipt.json') if TRACE_PREFIX in ('r12-r3-native','r12-r4-native','r12-r5-native','r12-r6-native','r12-r7-native','r12-r8-native','r12-r9-native','r12-r10-native','r12-r11-native') else ()
    freeze_implementation(wave,output=OUTPUT,harness='frontend/tools/ap06-r12-r2-native-probe.mjs',runner_path=PUBLISHER,extra_publications=('custody',),
        extra_files=native_freeze_extra_files(),
        protocol={'campaign':CAMPAIGN,**({'browserIdentity':read(wave.output/'baseline/browser-identity.json')} if identity_files else {}),'protocol':read(wave.output/'baseline/preregistered-protocol.json')})
    if identity_files:
        from ap06_browser_identity import verify_identity
        verify_identity(read(wave.output/'baseline/browser-identity.json'))
    frozen=read(wave.output/'tooling/freeze.json');ledger=[];results=[]
    for index,condition in enumerate(read(factorial.output/'pipeline/triage-decision.json')['pair'],5):
        result=measure(wave,condition,'formal',frozen,ledger,requested=1,directory_name=f'{index:02}-{condition}',budget_fn=native_budget,
            verify_fn=verify,environment_fn=environment,validate_fn=validate_condition,probe='tools/ap06-r12-r2-native-probe.mjs')
        receipt=wave.output/'formal'/f'{index:02}-{condition}'/'native-receipt.json';aggregate=parse_trace(wave,receipt)
        wave.save(f'formal/{index:02}-{condition}/native-aggregate.json',aggregate)
        publish(wave,f'aggregate-{index}',{f'evidence/formal/{index:02}-{condition}/aggregate.json':receipt.parent/'native-aggregate.json',f'evidence/formal/{index:02}-{condition}/receipt.json':receipt})
        results.append({'condition':condition,'rawSha256':result['rawSha256'],'rawPath':result['rawPath'],'native':aggregate})
    decision={'status':'R12R2_NATIVE_TRACKED_AGGREGATES_OBSERVED' if all(r['native']['status']=='R12R2_NATIVE_CAPABILITY_PASS' for r in results) else 'R12R2_NATIVE_INCONCLUSIVE',
        'capabilityChromium':1,'measurementChromium':2,'retries':0,'results':results,'causalAttribution':'INCONCLUSIVE: total allocation coverage and individual lifetimes unproven; no function culprit or leak established.'}
    wave.save('final/decision.json',campaign_decision(decision));publish(wave,'decision',{'evidence/decision.json':wave.output/'final/decision.json'})

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--run',action='store_true');parser.add_argument('--verify-freeze',action='store_true')
    parser.add_argument('--seal-trace',action='store_true');parser.add_argument('--receipt',type=Path);parser.add_argument('--publish-raw',type=Path);parser.add_argument('--snapshot')
    args=parser.parse_args();wave=Wave(Path(__file__).resolve().parents[2]);wave.output=wave.root/OUTPUT
    with tempfile.TemporaryDirectory(prefix='ap06-native-') as tmp:
        wave.temp=Path(tmp)
        try:
            if TRACE_PREFIX in ('r12-r3-native','r12-r4-native','r12-r5-native','r12-r6-native','r12-r7-native','r12-r8-native','r12-r9-native','r12-r10-native','r12-r11-native') and args.run and (wave.output/'final/STOP.json').exists():
                prefix=campaign_prefix()
                print(json.dumps({'status':prefix+'_NATIVE_STOP','reason':prefix+'_NATIVE_NO_RETRY_OR_RESUME'}));return 1
            if args.run:run(wave)
            elif args.verify_freeze:verify(wave,read(wave.output/'tooling/freeze.json'))
            elif args.seal_trace:print(json.dumps(seal_trace(wave,args.receipt)))
            elif args.publish_raw:
                path=checked_path(args.publish_raw.absolute());require(path.is_relative_to(wave.output) and re.fullmatch(r'formal-0[56]-r12r2\.[0-3]',args.snapshot or ''),'R12R2_NATIVE_RAW_PATH_INVALID')
                publish(wave,'raw-'+args.snapshot,{f'evidence/raws/{args.snapshot}.json':path})
            else:parser.error('action required')
        except FreezeFailure as error:
            stop=campaign_decision({'status':'R12R2_NATIVE_STOP','reason':error.failure_class,
                'failureStage':error.stage,'failureClass':error.failure_class,'factorialResultPreserved':True})
            wave.save('final/STOP.json',stop)
            publish(wave,'stop',{'evidence/STOP.json':wave.output/'final/STOP.json'});print(json.dumps(stop));return 1
        except (WaveFailure,ValueError,OSError,subprocess.SubprocessError,KeyError,TypeError,IndexError) as error:
            reason=str(error) if re.fullmatch(r'[A-Z][A-Z0-9_:]+',str(error)) else 'R12R2_NATIVE_EXECUTION_FAILED'
            stop=campaign_decision({'status':'R12R2_NATIVE_STOP','reason':reason,'factorialResultPreserved':True});wave.save('final/STOP.json',stop)
            publish(wave,'stop',{'evidence/STOP.json':wave.output/'final/STOP.json'});print(json.dumps(stop));return 1
    return 0

if __name__=='__main__':raise SystemExit(main())
