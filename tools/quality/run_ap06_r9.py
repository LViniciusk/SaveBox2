"""AP-06-R9-R2: new baseline and immutable transport evidence (no historical worktree dependencies)."""
import argparse
from collections import Counter
import json
import math
import re
from contextlib import nullcontext
from pathlib import Path
import subprocess
import sys
import tempfile

from ap06_authorities import publish_snapshot, verify_publication, sha256
from run_readiness_wave1 import Wave, WaveFailure, owner
from run_ap06_transport_probe import media_server
from run_ap06_integration_probe import (read, build_products, environment, check_budget,
    validate_integration_condition, VERSION, CRYPTO, individual_deltas, REPRODUCES, DOES_NOT)

OUTPUT = '.quality/readiness-wave9-r2'
CONDITIONS = ('r9-r2.0', 'r9-r2.1', 'r9-r2.2')
TRANSPORTS = dict(zip(CONDITIONS, ('xhr', 'angular-fetch', 'direct-fetch')))
PREFIX = 'AP06_R9_R2_'
CHECKPOINTS = ('CORPUS_GENERATED', 'CORPUS_VERIFIED', 'AUTHORITIES_PUBLISHED',
    'AUTHORITIES_READBACK_VERIFIED', 'IMPLEMENTATION_FROZEN', 'READY_FOR_MEASUREMENT')


class AuthorityFailure(WaveFailure):
    pass


def publish(wave, name, files):
    config = read(wave.output/'baseline/authority-config.local.json')
    if wave.output.name == 'readiness-wave10-r3':
        name = name if name.startswith('r10-r3-') else 'r10-r3-'+name
        files = {'r10-r3/'+relative:source for relative,source in files.items()}
    if publication_namespace(wave) and wave.output.name != 'readiness-wave10-r3':
        prefix=wave.output.name.replace('readiness-wave','r')
        name = name if name.startswith(prefix+'-') else prefix+'-'+name
        files = {prefix+'/'+relative:source for relative,source in files.items()}
    try:
        return publish_snapshot(Path(config['AP06_AUTHORITY_ROOT']), config['identity'], name, files, wave.output/'pipeline')
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise AuthorityFailure('R9_AUTHORITY_PUBLICATION_FAILED_' + (str(error) if isinstance(error, ValueError) else type(error).__name__)) from error


def media_files(wave):
    config = read(wave.output/'baseline/authority-config.local.json')
    root = Path(config['AP06_AUTHORITY_ROOT'])
    verify_publication(root, config['identity'], 'corpus-publication')
    return {f'/video-{n}.mp4':root/f'corpus/cipher/video-{n}.bin' for n in range(3)}


def verify_freeze(wave, freeze):
    config = read(wave.output/'baseline/authority-config.local.json')
    for name in ('corpus-publication', freeze.get('implementationPublication','implementation'),
                 freeze.get('freezePublication','freeze'), *freeze.get('extraPublications',[])):
        try: verify_publication(Path(config['AP06_AUTHORITY_ROOT']), config['identity'], name)
        except (OSError, ValueError, subprocess.CalledProcessError) as error:
            raise AuthorityFailure('R9_AUTHORITY_READBACK_FAILED_' + (str(error) if isinstance(error, ValueError) else type(error).__name__)) from error
    for name, digest in freeze['publicationHashes'].items():
        if sha256(Path(config['AP06_AUTHORITY_ROOT'])/'manifests'/f'{name}.json') != digest:
            raise AuthorityFailure('R9_AUTHORITY_MANIFEST_CHANGED')
    for path, digest in freeze['files'].items():
        if sha256(wave.root/path) != digest:
            raise WaveFailure('R9_FROZEN_FILE_CHANGED_' + path)
    if 'runtimeInputs' in freeze:
        from ap06_freeze import runtime_input_manifest
        if runtime_input_manifest(wave)!=freeze['runtimeInputs']:
            raise WaveFailure('R12R11_FREEZE_INTEGRITY_FAILED')
        manifest=verify_publication(Path(config['AP06_AUTHORITY_ROOT']),config['identity'],freeze['implementationPublication'])
        prefix=publication_namespace(wave)+'/tooling/source/'
        if {row['path']:row['sha256'] for row in manifest['files']}!={prefix+name:digest for name,digest in freeze['files'].items()}:
            raise WaveFailure('R12R11_FREEZE_READBACK_FAILED')
    if wave.git('rev-parse', 'HEAD').strip() != freeze['implementationHead']:
        raise WaveFailure('R9_IMPLEMENTATION_HEAD_CHANGED')


def runtime_environment(wave, directory, condition, stage='triage', freeze=None, output=OUTPUT, publisher=None):
    env, assets = environment(wave, directory, 'r8.2', stage, freeze, output=output)
    backend = read(wave.output/'baseline/backend-runtime.local.json')
    config = read(wave.output/'baseline/authority-config.local.json')
    env.update(AP06_EXPERIMENT_ROOT=output, AP06_R6_CONDITION=condition,
        AP06_R9_PRIVATE_KEYS=str(Path(config['privateRuntime'])/'fdks.local.json'),
        AP06_R9_BACKEND_LOG=str(Path(backend['cwd'])/'process.log'),
        AP06_R9_PUBLISHER=str(publisher or wave.root/'tools/quality/run_ap06_r9.py'))
    authority = read(wave.output/'baseline/backend-authority.json')
    env['AP06_R8_FILE_MAPPING'] = json.dumps(authority['fileMapping'])
    return env, assets


def network_sequence(rows):
    return [[row['fixture'], row['range']] for row in rows]


def validate_network(run, condition, expected, fixtures, mapping, expected_type=None):
    data = run['rangeNetwork']; rows = data['requests']
    if (not data['enabledBeforeNavigation'] or not data['listenersDetached'] or not data['sessionDetached'] or
            not data['routingInstalled'] or data['httpCache'] != 'disabled by Playwright routing' or
            data['explicitCacheIntervention'] or data['duplicateRequestIds'] or
            network_sequence(rows) != expected or len({row['requestId'] for row in rows}) != len(rows)):
        raise WaveFailure('R9_CDP_NETWORK_PROTOCOL_INVALID')
    expected_type = expected_type or ('XHR' if condition == CONDITIONS[0] else 'Fetch')
    ids = {row['fixture']: row['fileId'] for row in mapping}
    sizes = {row['id']: row['ciphertextBytes'] for row in fixtures}
    received = 0
    for row in rows:
        start, end = map(int, row['range'].removeprefix('bytes=').split('-'))
        length = end-start+1
        wanted_type=expected_type(row) if callable(expected_type) else expected_type
        if (not 0 <= start <= end < sizes[row['fixture']] or row['fileId'] != ids[row['fixture']] or
                row['status'] != 206 or row['type'] != wanted_type or not row['finished'] or row['failed'] or
                row['fromDiskCache'] is not False or row['fromServiceWorker'] is not False or row['servedFromCache'] or
                type(row['encodedDataLength']) not in (int, float) or not math.isfinite(row['encodedDataLength']) or row['encodedDataLength'] < 0 or
                row['headers'].get('content-range') != f"bytes {start}-{end}/{sizes[row['fixture']]}" or
                row['headers'].get('content-length') != str(length)):
            raise WaveFailure('R9_CDP_RANGE_RESPONSE_INVALID')
        received += length
    traffic = run['backendTraffic']
    if (traffic['pendingGets'] or traffic.get('correlationFailures',0) or Counter((row['fileId'], row['status']) for row in traffic['rows']) !=
            Counter((row['fileId'], 206) for row in rows)):
        raise WaveFailure('R9_BACKEND_CDP_COUNTS_DISAGREE')
    return received


def validate_condition(raw, condition, stage, freeze, fixtures):
    classification = validate_integration_condition(raw, condition, stage, freeze, fixtures, 'backend', condition == CONDITIONS[2])
    if raw.get('transport') != TRANSPORTS[condition]: raise WaveFailure('R9_TRANSPORT_CHANGED')
    for run in raw['runs']:
        expected_proof = {'transport': TRANSPORTS[condition], 'xhrBackend': condition != CONDITIONS[1],
            'fetchBackend': condition == CONDITIONS[1], 'originalRange': condition != CONDITIONS[2],
            'directRange': condition == CONDITIONS[2], 'realAuth': True}
        if run['transportProof'] != expected_proof: raise WaveFailure('R9_TRANSPORT_DI_PROOF_INVALID')
        received = validate_network(run, condition, freeze['workload']['rangesPerCycle']*6, fixtures, freeze['backendFileMapping'])
        for sample in run['samples']:
            c = sample['counters']['observed']; cycle = sample['cycle']
            if (c['rangeRequestsCompleted'] != len(freeze['workload']['rangesPerCycle'])*cycle or
                    c['rangeBytesReceived'] != freeze['workload']['bytesPerCycle']*cycle or
                    c['directAuthorizedRanges'] != (c['rangeRequestsStarted'] if condition == CONDITIONS[2] else 0)):
                raise WaveFailure('R9_FROZEN_WORKLOAD_CLIENT_DISAGREES')
        if received != freeze['workload']['bytesPerCycle']*6: raise WaveFailure('R9_CDP_BYTE_TOTAL_INVALID')
    return classification


def validate_freeze_preflight(wave,unit,output):
    if wave.output.name in ('readiness-wave12-r13-native', 'readiness-wave12-r14-native'):
        if (unit.get('status')!='PASS' or unit.get('preflightMode')!='build-only' or
                unit.get('unitBrowserLaunches')!=0 or unit.get('browserLaunches')!=0):
            raise WaveFailure('R12R13_BUILD_PREFLIGHT_INVALID')
        assets,products,workers=build_products(wave.root,output)
        if products!=unit.get('appProducts') or unit.get('workerHashes')!={kind:row['sha256'] for kind,row in workers.items()}:
            raise WaveFailure('R12R13_APP_PRODUCTS_CHANGED')
        fixture_hash=sha256(wave.output/'fixtures/manifest.json')
        if fixture_hash!=unit.get('fixtureHash'):raise WaveFailure('R12R13_CORPUS_CHANGED_SINCE_PREFLIGHT')
        return assets,products,workers,fixture_hash
    if unit['status'] != 'PASS' or unit['unitBrowserLaunches'] != 1: raise WaveFailure('R9_UNIT_NOT_READY')
    assets, products, workers=build_products(wave.root,output)
    if products != unit['appProducts'] or unit['multiplexedContract']['workerHashes'] != {kind:row['sha256'] for kind,row in workers.items()}:
        raise WaveFailure('R9_APP_CHANGED_SINCE_NATIVE_PREFLIGHT')
    fixture_hash=sha256(wave.output/'fixtures/manifest.json')
    if fixture_hash != unit['multiplexedContract']['fixtureHash']: raise WaveFailure('R9_CORPUS_CHANGED_SINCE_PREFLIGHT')
    return assets,products,workers,fixture_hash


def publication_namespace(wave):
    name=wave.output.name
    if name=='readiness-wave10-r3':return 'r10-r3'
    if re.fullmatch(r'readiness-wave(?:11(?:-r[23])?|12(?:-r(?:[2-9]|1[0-4])-(?:factorial|native))?)',name):
        return name.replace('readiness-wave','r')
    return ''


def validate_freeze_readiness(wave, *, output, extra_files=(), extra_publications=(), preflight_complete=False):
    from ap06_freeze import freeze_stage,validate_freeze_plan
    with freeze_stage('inputs'):
        _,products,_=build_products(wave.root,output)
        files=collect_freeze_inputs(wave,products,extra_files)
    return validate_freeze_plan(wave,files,extra_publications,preflight_complete=preflight_complete)


def collect_freeze_inputs(wave, products, extra_files=()):
    tracked=wave.git('ls-files').splitlines()
    files={path:wave.root/path for path in tracked}
    if publication_namespace(wave):
        header=wave.root/'backend/include/crow_all.h'
        if re.fullmatch(r'readiness-wave12-r(?:8|9|1[0-4])-(factorial|native)',wave.output.name):
            from ap06_freeze import validate_native_build_authority
            backend=validate_native_build_authority(wave)
            if header.is_file():files['backend/include/crow_all.h']=header
        else:files['backend/include/crow_all.h']=header
    for path in products: files[path]=wave.root/path
    for name in ('savebox_server.exe','nanika_e2e_fixture.exe'):
        path=wave.output/'tooling/backend-build'/name;files[path.relative_to(wave.root).as_posix()]=path
    from ap06_freeze import strict_freeze_namespace
    if strict_freeze_namespace(wave.output):
        from ap06_freeze import NATIVE_FILES
        for name in NATIVE_FILES.values():
            path=wave.output/'tooling/backend-build'/name;files[path.relative_to(wave.root).as_posix()]=path
        for name in ('native-production.xml','native-experimental.xml'):
            path=wave.output/'baseline'/name;files[path.relative_to(wave.root).as_posix()]=path
    for path in (wave.output/'fixtures').rglob('*'):
        if path.is_file(): files[path.relative_to(wave.root).as_posix()]=path
    for name in ('baseline/budget.json','baseline/workload.json','baseline/backend-authority.json','baseline/historical-r9.json',
                 'baseline/versions.json','baseline/tests.json','baseline/task.md','tooling/angular-unit-1.json','tooling/kasumi.cjs',*extra_files):
        path=wave.output/name;files[path.relative_to(wave.root).as_posix()]=path
    return files


def freeze_implementation(wave, *, output=OUTPUT, harness='frontend/tools/ap06-r9-probe.mjs', runner_path=None,
                          extra_files=(), extra_publications=(), protocol=None):
    from ap06_freeze import freeze_stage,validate_freeze_plan,strict_freeze_namespace
    strict=strict_freeze_namespace(wave.output)
    stage=lambda name:freeze_stage(name) if strict else nullcontext()
    target=wave.output/'tooling/freeze.json'
    if strict and (wave.output/'pipeline/freeze-attempt.json').exists():
        from ap06_freeze import FreezeFailure
        raise FreezeFailure('integrity','FileExistsError')
    if target.exists() or wave.git('status','--porcelain').strip(): raise WaveFailure('R9_FREEZE_REQUIRES_CLEAN_COMMITTED_IMPLEMENTATION')
    with stage('preflight'):
        unit=read(wave.output/'tooling/angular-unit-1.json')
        assets,products,workers,fixture_hash=validate_freeze_preflight(wave,unit,output)
    with stage('inputs'):
        files=collect_freeze_inputs(wave,products,extra_files)
    if strict:
        ready=validate_freeze_plan(wave,files,extra_publications,preflight_complete=True,include_manifest=True)
        before=read(wave.output/'baseline/freeze-readiness.json')
        with stage('integrity'):
            if before['sourceManifestSha256']!=ready['sourceManifestSha256']:
                raise ValueError('AP06_FREEZE_STATIC_INPUTS_CHANGED')
        with (wave.output/'pipeline/freeze-attempt.json').open('x') as stream:
            json.dump({'implementationHead':wave.git('rev-parse','HEAD'),'retries':0},stream)
    with stage('publication'):
        receipt=publish(wave,'implementation',{'tooling/source/'+name:path for name,path in files.items()})
    if strict:
        with stage('readback'):
            config=read(wave.output/'baseline/authority-config.local.json')
            verify_publication(Path(config['AP06_AUTHORITY_ROOT']),config['identity'],publication_namespace(wave)+'-implementation')
    config=read(wave.output/'baseline/authority-config.local.json');authority=Path(config['AP06_AUTHORITY_ROOT'])
    prefix = publication_namespace(wave)
    prefix = prefix+'-' if prefix else ''
    implementation_name = prefix+'implementation'
    freeze_name = prefix+'freeze'
    freeze={'campaign':'AP-06-R12-R13-native' if wave.output.name=='readiness-wave12-r13-native' else 'AP-06-R9-R2',
        'status':'FROZEN','implementationHead':wave.git('rev-parse','HEAD').strip(),
        'implementationPublication':implementation_name,'freezePublication':freeze_name,
        'sourceHash':owner._tree_sha256(wave.root,'frontend/src'),'fixtureHash':fixture_hash,
        'harnessHash':sha256(wave.root/harness),'runnerHash':sha256(Path(runner_path or __file__)),
        'appProducts':products,'workers':workers,'pageScriptSha256':unit.get('pageScriptSha256'),
        'multiplexedContract':unit.get('multiplexedContract'),'backendAuthoritySha256':sha256(wave.output/'baseline/backend-authority.json'),
        'backendFileMapping':read(wave.output/'baseline/backend-authority.json')['fileMapping'],
        'workload':read(wave.output/'baseline/workload.json'),'files':{row['path']:row['sha256'] for row in ready['inputs']} if strict else {name:sha256(path) for name,path in files.items()},
        'publicationHashes':{'corpus-publication':sha256(authority/'manifests/corpus-publication.json'),implementation_name:receipt['manifestSha256']},
        'chromiumVersion':VERSION,'budget':read(wave.output/'baseline/budget.json'),
        'checkpoints':dict.fromkeys(CHECKPOINTS,'PASS')}
    freeze['extraPublications']=list(extra_publications)
    freeze['publicationHashes'].update({name:sha256(authority/'manifests'/f'{name}.json') for name in extra_publications})
    freeze.update(protocol or {})
    if strict:freeze['runtimeInputs']=ready['runtimeInputs']
    if strict:freeze['status']='SNAPSHOT_AWAITING_READBACK'
    with stage('integrity'):
        wave.save('tooling/freeze.json',freeze)
    with stage('publication'):
        publish(wave,'freeze',{'freeze/freeze.json':target})
    with stage('readback'):
        verify_freeze(wave,freeze)
    if strict:
        with stage('readback'):
            independent=subprocess.run([sys.executable,str(wave.root/'tools/quality/ap06_authorities.py'),
                '--root',str(authority),'--identity',config['identity'],'--expected-freeze-sha256',sha256(target),
                '--freeze-relative',publication_namespace(wave)+'/freeze/freeze.json'],
                capture_output=True,check=True,text=True,timeout=120)
            if json.loads(independent.stdout).get('status')!='PASS':
                raise WaveFailure('R12R11_FREEZE_READBACK_FAILED')
            wave.save('baseline/freeze-complete.json',{'status':'FROZEN','freezeSha256':sha256(target),
                'implementationHead':freeze['implementationHead'],'independentReadback':True})
            publish(wave,'freeze-complete',{'evidence/freeze-complete.json':wave.output/'baseline/freeze-complete.json'})
    print(json.dumps({'status':'READY_FOR_MEASUREMENT','files':len(files),'freezeSha256':sha256(target)}),flush=True)


def following(condition, classification):
    if condition not in CONDITIONS: raise ValueError('R9_INVALID_CONDITION')
    if classification not in (REPRODUCES, DOES_NOT): return None
    if condition == CONDITIONS[0]: return ('triage', CONDITIONS[1]) if classification == REPRODUCES else None
    if condition == CONDITIONS[1] and classification == REPRODUCES: return ('triage', CONDITIONS[2])
    return ('formal', condition)


def formal_status(condition, triage, formal):
    if condition not in CONDITIONS[1:] or triage not in (REPRODUCES, DOES_NOT):
        raise ValueError('R9_INVALID_FORMAL_CONDITION')
    if len(formal) != 3 or any(row['classification'] != triage for row in formal):
        return 'BLOCKED_' + PREFIX + 'FORMAL_DISAGREEMENT'
    result = ('ANGULAR_FETCH_EFFECT_CONFIRMED' if condition == CONDITIONS[1] else
              'DIRECT_FETCH_EFFECT_CONFIRMED') if triage == DOES_NOT else 'NO_TRANSPORT_ISOLATION'
    return 'PASS_' + PREFIX + result


def unit_browser(wave):
    if (wave.output/'tooling/freeze.json').exists(): raise WaveFailure('R9_PREFLIGHT_AFTER_FREEZE_FORBIDDEN')
    target = wave.output/'tooling/angular-unit-1.json'
    if target.exists(): raise WaveFailure('R9_EXISTING_DEVELOPMENT_RECEIPT')
    env, assets = runtime_environment(wave, wave.output/'tooling', CONDITIONS[0])
    env.update(AP06_R9_CHECK='1', AP06_R7_UNIT_OUTPUT=str(target))
    with media_server(media_files(wave), True, 'application/octet-stream', assets, port=42088) as (origin, stats):
        env['AP06_R5_MEDIA_ORIGIN'] = origin
        wave.command('angular-r9-unit-1', [wave.node, 'tools/ap06-angular-integration-check.mjs'], wave.root/'frontend', env)
        wave.save('pipeline/angular-unit-transport.json', stats)
    result = read(target)
    if result['status'] != 'PASS': raise WaveFailure('R9_ANGULAR_PREFLIGHT_FAILED')
    fixtures = read(wave.output/'fixtures/manifest.json')
    authority = read(wave.output/'baseline/backend-authority.json')
    sequences = []
    for condition in CONDITIONS:
        network = result['rangeNetworks'][condition]
        sequence = network_sequence(network['cdp']['requests']); sequences.append(sequence)
        received = validate_network({'rangeNetwork': network['cdp'], 'backendTraffic': network['backend']}, condition,
            sequence, fixtures, authority['fileMapping'])
        if received != result['boundaryCounters'][condition]['rangeBytesReceived']:
            raise WaveFailure('R9_PREFLIGHT_BYTE_COUNTS_DISAGREE')
    if not sequences[0] or not all(row == sequences[0] for row in sequences):
        raise WaveFailure('R9_PREFLIGHT_TRANSPORT_WORKLOAD_DIFFERS')
    wave.save('baseline/workload.json', {'rangesPerCycle': sequences[0], 'requestsPerCycle': len(sequences[0]),
        'bytesPerCycle': received, 'cycles': 6, 'derivedBeforeFreeze': True, 'allThreeTransportsEqual': True})
    print(json.dumps({'status':'PASS','developmentChromium':result['unitBrowserLaunches'], 'checks':len(result['cases'])}), flush=True)


def measure(wave, condition, stage, freeze, ledger, *, requested=None, directory_name=None, budget_fn=check_budget,
            verify_fn=verify_freeze, environment_fn=runtime_environment, validate_fn=validate_condition, probe='tools/ap06-r9-probe.mjs'):
    requested = requested if requested is not None else 3 if stage == 'formal' else 1
    budget_fn(read(wave.output/'baseline/budget.json'), sum(row['reservedAttempts'] for row in ledger), requested)
    verify_fn(wave, freeze)
    name=directory_name or condition
    directory = wave.output/stage/name; directory.mkdir(exist_ok=False)
    entry = {'condition':condition,'stage':stage,'reservedAttempts':requested,'launchAttempts':0,'browserLaunches':0}
    ledger.append(entry); wave.save('pipeline/launch-ledger.json', ledger)
    publish(wave, f'ledger-reserved-{len(ledger)}', {f'evidence/ledger-reserved-{len(ledger)}.json':wave.output/'pipeline/launch-ledger.json'})
    env, assets = environment_fn(wave, directory, condition, stage, freeze)
    failure = None
    with media_server(media_files(wave), True, 'application/octet-stream', assets, port=42088) as (origin, stats):
        env['AP06_R5_MEDIA_ORIGIN'] = origin
        try: wave.command(stage+'-'+name, [wave.node,probe],wave.root/'frontend',env)
        except WaveFailure as error: failure = error
        raw_path = directory/(CRYPTO+'.raw.json')
        if raw_path.exists():
            raw = read(raw_path)
            entry.update(launchAttempts=raw['launchAttempts'],browserLaunches=raw['browserLaunches'],rawSha256=sha256(raw_path))
            publish(wave, stage+'-'+name+'-complete', {f'evidence/{stage}/{name}/complete.raw.json':raw_path})
        else: raise failure or WaveFailure('R9_RAW_MISSING')
        wave.save('pipeline/launch-ledger.json', ledger)
        wave.save(f'{stage}/{name}/transport.json', stats)
    publish(wave, f'ledger-finished-{len(ledger)}', {f'evidence/ledger-finished-{len(ledger)}.json':wave.output/'pipeline/launch-ledger.json'})
    verify_fn(wave, freeze)
    if failure:
        if raw.get('checkpointFailure'):
            reason=raw['checkpointFailure']
            if reason.startswith(('AUTHORITY_', 'R9_AUTHORITY_')): raise AuthorityFailure(reason)
            raise WaveFailure(reason)
        reasons=[run.get('failureClass') for run in raw['runs'] if run.get('failureClass')]
        raise WaveFailure(','.join(reasons) if reasons else str(failure))
    classification = validate_fn(raw, condition, stage, freeze, read(wave.output/'fixtures/manifest.json'))
    result = {'condition':condition,'stage':stage,'status':'VALID','classification':classification,
        'rawSha256':sha256(raw_path),'rawPath':raw_path.relative_to(wave.output).as_posix(),'individualRuns':individual_deltas(raw),'summary':raw['summary']}
    wave.save(f'{stage}/{name}/decision.json',result)
    publish(wave,stage+'-'+name+'-decision',{f'evidence/{stage}/{name}/decision.json':directory/'decision.json'})
    return result


def campaign_run(wave):
    freeze = read(wave.output/'tooling/freeze.json')
    if freeze['checkpoints'] != dict.fromkeys(CHECKPOINTS,'PASS'): raise WaveFailure('R9_CHECKPOINTS_INCOMPLETE')
    started = wave.output/'pipeline/campaign-started.json'
    with started.open('x') as stream: json.dump({'implementationHead':freeze['implementationHead'],'retries':0},stream)
    publish(wave,'campaign-started',{'evidence/campaign-started.json':started})
    ledger, results = [], []
    decision = {'status':'BLOCKED_'+PREFIX+'INVALID_MEASUREMENT','ap06':'OPEN','results':results}
    stage, condition = 'triage', CONDITIONS[0]
    try:
        while True:
            print(json.dumps({'condition':condition,'stage':stage,'state':'STARTED'}),flush=True)
            result = measure(wave,condition,stage,freeze,ledger); results.append(result)
            print(json.dumps({'condition':condition,'classification':result['classification']}),flush=True)
            if stage == 'formal':
                decision['status'] = formal_status(condition,results[-2]['classification'],result['individualRuns']); break
            if condition == CONDITIONS[0] and result['classification'] == DOES_NOT:
                decision['status'] = 'BLOCKED_'+PREFIX+'CONTROL_NOT_REPRODUCED'; break
            next_stage = following(condition,result['classification'])
            if next_stage is None: break
            stage, condition = next_stage
    except Exception as error:
        decision.update(failureClass=str(error) if isinstance(error,(WaveFailure,ValueError)) else type(error).__name__,condition=condition,stage=stage)
        if isinstance(error,AuthorityFailure):
            decision['status'] = 'BLOCKED_'+PREFIX+'AUTHORITY_PERSISTENCE_FAILED'
        elif str(error) == 'R9_CDP_NETWORK_PROTOCOL_INVALID':
            decision['status'] = 'BLOCKED_'+PREFIX+'NETWORK_POLICY_UNVERIFIED'
    decision.update(browserLaunches=sum(row['browserLaunches'] for row in ledger),
        launchAttempts=sum(row['launchAttempts'] for row in ledger),retries=0)
    wave.save('final/decision.json',decision)
    publish(wave,'campaign-decision',{'evidence/campaign-decision.json':wave.output/'final/decision.json'})
    print(json.dumps({key:value for key,value in decision.items() if key!='results'}),flush=True)
    return 0 if decision['status'].startswith('PASS_') else 1


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    actions=parser.add_mutually_exclusive_group(required=True)
    actions.add_argument('--unit-browser',action='store_true')
    actions.add_argument('--validated-campaign',action='store_true')
    actions.add_argument('--publish-raw',type=Path)
    actions.add_argument('--verify-freeze',action='store_true')
    actions.add_argument('--freeze',action='store_true')
    parser.add_argument('--snapshot')
    args=parser.parse_args()
    wave=Wave(Path(__file__).resolve().parents[2]);wave.output=wave.root/OUTPUT
    with tempfile.TemporaryDirectory(prefix='ap06-r9-logs-',dir=wave.output/'pipeline') as temporary:
        wave.temp=Path(temporary)
        if args.freeze: freeze_implementation(wave); return 0
        if args.verify_freeze:
            verify_freeze(wave,read(wave.output/'tooling/freeze.json')); return 0
        if args.publish_raw:
            path=args.publish_raw.absolute()
            if not path.is_relative_to(wave.output) or not args.snapshot: raise ValueError('R9_INVALID_RAW_PUBLICATION')
            publish(wave,'raw-'+args.snapshot,{f'evidence/raws/{args.snapshot}.json':path}); return 0
        if args.unit_browser: unit_browser(wave); return 0
        return campaign_run(wave)


if __name__ == '__main__': raise SystemExit(main())
