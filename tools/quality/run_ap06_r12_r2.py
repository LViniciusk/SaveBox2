"""R12-R2 factorial: strict mixed routing, shared HTTP samples and immutable measurement helpers."""
import argparse,json,math,re,subprocess,tempfile,sys
from contextlib import contextmanager
from pathlib import Path
import socket
from urllib.parse import urlsplit
from run_readiness_wave1 import Wave,WaveFailure,owner
from run_ap06_integration_probe import read,build_products,VERSION
from run_ap06_r9 import publish,media_files,runtime_environment,freeze_implementation,measure,validate_network
from run_ap06_r10 import expected_proof,validate_bootstrap_network
from run_ap06_r11 import verify_r11_freeze,renderer_delta,validate_process_lifecycle,validate_memory
from run_ap06_r12 import require,validate_scalars,validate_http_samples
from run_ap06_transport_probe import media_server
from run_test_matrix import npm_command
from ap06_authorities import checked_path,private_permissions,sha256

OUTPUT='.quality/readiness-wave12-r2-factorial'
CAMPAIGN='AP-06-R12-R2-factorial'
PUBLISHER=Path(__file__).resolve()

def configure_campaign(output,publisher,campaign):
    global OUTPUT,PUBLISHER,CAMPAIGN
    require((output,campaign) in (('.quality/readiness-wave12-r3-factorial','AP-06-R12-R3-factorial'),
        ('.quality/readiness-wave12-r4-factorial','AP-06-R12-R4-factorial'),
        ('.quality/readiness-wave12-r5-factorial','AP-06-R12-R5-factorial'),
        ('.quality/readiness-wave12-r6-factorial','AP-06-R12-R6-factorial'),
        ('.quality/readiness-wave12-r7-factorial','AP-06-R12-R7-factorial'),
        ('.quality/readiness-wave12-r8-factorial','AP-06-R12-R8-factorial'),
        ('.quality/readiness-wave12-r9-factorial','AP-06-R12-R9-factorial'),
        ('.quality/readiness-wave12-r10-factorial','AP-06-R12-R10-factorial')),'R12R3_CAMPAIGN_INVALID')
    OUTPUT,PUBLISHER,CAMPAIGN=output,Path(publisher).resolve(),campaign

def campaign_prefix():
    return {'AP-06-R12-R10-factorial':'R12R10_','AP-06-R12-R9-factorial':'R12R9_','AP-06-R12-R8-factorial':'R12R8_','AP-06-R12-R7-factorial':'R12R7_','AP-06-R12-R6-factorial':'R12R6_','AP-06-R12-R5-factorial':'R12R5_',
        'AP-06-R12-R4-factorial':'R12R4_','AP-06-R12-R3-factorial':'R12R3_'}.get(CAMPAIGN,'R12R2_')

def campaign_decision(value):
    prefix=campaign_prefix()
    if prefix!='R12R2_':return dict(value,status=value['status'].replace('R12R2_',prefix))
    return value

def validate_campaign_authority(wave,campaign,task_path,round_name,frozen_protocol=None):
    task=wave.root/task_path;private_task=wave.output/'baseline/task.md'
    provenance=read(wave.output/'baseline/task-provenance.json');protocol=read(wave.output/'baseline/preregistered-protocol.json')
    require(task.is_file() and private_task.is_file(),round_name+'_TASK_AUTHORITY_MISSING')
    content=task.read_bytes();digest=sha256(task)
    require(content and content==private_task.read_bytes() and digest==provenance.get('sourceSha256')==protocol.get('authoritySha256') and
        task.stat().st_size==provenance.get('sourceBytes')==protocol.get('authorityBytes'),round_name+'_TASK_AUTHORITY_HASH_MISMATCH')
    text=content.decode('utf-8')
    formal_order='A,B,B,A,A,B' if campaign.endswith(('R8-factorial','R9-factorial','R10-factorial')) else 'A, B, B, A, A, B'
    required=(f'AP-06 {round_name.replace("R12", "R12-").replace("R12--", "R12-")}',
        '25.559.136','393.216','25.165.920','HTTP 206',formal_order,'300 MiB','150 MiB','MemoryInfra')
    if campaign.endswith('R6-factorial'):required+=('127.0.0.2','127.0.0.3')
    require(all(value in text for value in required),round_name+'_TASK_SEMANTICS_MISSING')
    require('14 Chromium no m\u00e1ximo; zero retries.' in text if campaign.endswith('R9-factorial') else
        'Máximo de 14 Chromium; zero retries.' in text if campaign.endswith('R10-factorial') else
        '14 Chromium, zero retries.' in text if campaign.endswith('R7-factorial') else
        '14 Chromium. Zero retries.' in text,round_name+'_TASK_BUDGET_INVALID')
    fields={'campaign','implementationHead','hypotheses','conditions','triageOrder','formalOrder','corpus','metrics','thresholds','order','budget',
        'httpContract','security','cleanup','stop','publication','nativeProfiling','authoritySha256','authorityBytes'}
    expected_conditions={key:CONDITIONS[key] for key in CONDITIONS}
    expected_order=[list(pair) for pair in PAIRS]
    expected_ranges=[[0,'bytes=0-131071'],[0,'bytes=114-4194433'],[0,'bytes=4194434-8388753'],
        [1,'bytes=0-131071'],[1,'bytes=117-4194436'],[1,'bytes=4194437-8388756'],
        [2,'bytes=0-131071'],[2,'bytes=114-4194433'],[2,'bytes=4194434-8388753']]
    expected_fields=fields|({'offlinePreflight'} if campaign.endswith(('R8-factorial','R9-factorial','R10-factorial')) else set())
    if campaign.endswith('R10-factorial'):expected_fields.add('playwrightIdentityPreflight')
    require(isinstance(protocol,dict) and set(protocol)==expected_fields and protocol['campaign']==campaign and
        isinstance(protocol['implementationHead'],str) and re.fullmatch(r'[0-9a-f]{40}',protocol['implementationHead']) and
        protocol['implementationHead']==wave.git('rev-parse','HEAD').strip() and protocol['conditions']==expected_conditions and
        protocol['triageOrder']==list(CONDITIONS) and protocol['formalOrder']=='A,B,B,A,A,B' and
        protocol['budget']=={'preflight':1,'triage':4,'formal':6,'nativeCapability':1,'nativeMeasurements':2,'maximum':14,'retries':0} and
        isinstance(protocol['hypotheses'],str) and protocol['hypotheses'] and
        protocol['metrics'].get('primary')=='renderer-private-delta-cycle-6' and protocol['metrics'].get('secondary')=='total-chromium-private-delta' and
        protocol['thresholds'].get('controlMiB')==300 and protocol['thresholds'].get('triageMiB')==150 and
        protocol['thresholds'].get('formalSeparationMiB')==150 and protocol['order']==expected_order and
        protocol['corpus'].get('bytesPerCycle')==25559136 and protocol['corpus'].get('metadataBytesPerCycle')==393216 and
        protocol['corpus'].get('payloadBytesPerCycle')==25165920 and protocol['corpus'].get('fixtureCount')==3 and
        protocol['corpus'].get('rangesPerCycle')==expected_ranges and protocol['httpContract'].get('status')==206 and
        protocol['httpContract'].get('jwt') is True and protocol['httpContract'].get('contentRange') is True and
        protocol['httpContract'].get('contentLength') is True and protocol['httpContract'].get('rangeCountPerCycle')==9 and
        protocol['httpContract'].get('noWorkerMseMediaOrPlayback') is True and protocol['httpContract'].get('blobOnly') is True and
        protocol['security'].get('loopbackBind')=='127.0.0.1' and protocol['security'].get('testedRealPeers')==['127.0.0.2','127.0.0.3'] and
        protocol['security'].get('spoofHeadersIgnored') is True and protocol['security'].get('productionBypassOrEndpoint') is False and
        protocol['security'].get('endpointExperimentalOnly') is True and protocol['security'].get('externalAccessDenied') is True and
        protocol['cleanup'].get('accountAndFileCleanup') is True and protocol['cleanup'].get('readOnlyBanReadback') is True and
        protocol['stop'].get('noRetry') is True and protocol['stop'].get('stopOnGateFailure') is True and
        protocol['publication'].get('draftOnly') is True and protocol['publication'].get('merge') is False and
        protocol['nativeProfiling'].get('onlyAfterFormalConfirmation') is True and protocol['nativeProfiling'].get('capabilityBrowsers')==1 and
        protocol['nativeProfiling'].get('measurementBrowsers')==2 and protocol['nativeProfiling'].get('idleSeconds')==120 and
        protocol['nativeProfiling'].get('samplingBytes')==16384 and protocol['nativeProfiling'].get('traceBytesMax')==536870912 and
        protocol['nativeProfiling'].get('eventBytesMax')==33554432 and protocol['nativeProfiling'].get('cdpTimeoutMs')==30000 and
        protocol['nativeProfiling'].get('streamTimeoutMs')==120000 and
        protocol['nativeProfiling'].get('checkpoints')==['baseline','cycle-6-close','idle-120s','forced-GC-final'],
        round_name+'_PROTOCOL_SCHEMA_INVALID')
    if campaign.endswith(('R8-factorial','R9-factorial','R10-factorial')):
        gate=protocol.get('offlinePreflight',{})
        suffix='r10' if campaign.endswith('R10-factorial') else round_name[-2:].lower()
        require(gate.get('angularProject')=='ap06-r7' and gate.get('output')==f'.quality/readiness-wave12-{suffix}-factorial/tooling/app' and
            gate.get('buildBeforeReservation') is True and gate.get('environmentBeforeReservation') is True and
            gate.get('mediaServerReadyBeforeReservation') is True and gate.get('zeroReservationOnOfflineFailure') is True,
            round_name+'_OFFLINE_PREFLIGHT_SCHEMA_INVALID')
    if campaign.endswith('R10-factorial'):
        gate=protocol.get('playwrightIdentityPreflight',{})
        require(gate=={'resolver':'resolveBrowserIdentity','environmentBuilder':'environment()','sameNodeAndCwd':True,
            'sameTempAndHelper':True,'manifestHashPinned':True,'launchesChromium':False,'beforeReservation':True},
            round_name+'_PLAYWRIGHT_PREFLIGHT_SCHEMA_INVALID')
    if frozen_protocol is not None:
        require(frozen_protocol==protocol,round_name+'_PROTOCOL_FREEZE_MISMATCH')
    return digest

def validate_r6_authority(wave,frozen_protocol=None):
    return validate_campaign_authority(wave,'AP-06-R12-R6-factorial','quality/prompt.md','R12-R6',frozen_protocol)

def validate_r7_authority(wave,frozen_protocol=None):
    return validate_campaign_authority(wave,'AP-06-R12-R7-factorial','quality/ap06-r12-r7.md','R12-R7',frozen_protocol)

def validate_r8_authority(wave,frozen_protocol=None):
    return validate_campaign_authority(wave,'AP-06-R12-R8-factorial','quality/ap06-r12-r8.md','R12-R8',frozen_protocol)

def validate_r6_corpus(wave):
    manifest=wave.output/'fixtures/manifest.json';receipt=read(wave.output/'baseline/corpus-provenance.json')
    workload=read(wave.output/'baseline/workload.json');fixtures=read(manifest)
    expected_ranges=[[0,'bytes=0-131071'],[0,'bytes=114-4194433'],[0,'bytes=4194434-8388753'],
        [1,'bytes=0-131071'],[1,'bytes=117-4194436'],[1,'bytes=4194437-8388756'],
        [2,'bytes=0-131071'],[2,'bytes=114-4194433'],[2,'bytes=4194434-8388753']]
    require(manifest.is_file() and sha256(manifest)==receipt.get('manifestSha256') and
        workload==receipt.get('workload') and receipt.get('referenceCampaigns')==['AP-06-R12','AP-06-R12-R2','AP-06-R12-R4'] and
        receipt.get('historicalR6Identity')=='NOT_PROVEN_NEW_R12R6_BASELINE' and receipt.get('metadataBytesPerCycle')==393216 and
        receipt.get('payloadBytesPerCycle')==25165920 and isinstance(fixtures,list) and len(fixtures)==3 and
        receipt.get('fixtures')==[{'id':row.get('id'),'plainBytes':row.get('bytes'),'plainSha256':row.get('sha256'),
            'cipherBytes':row.get('ciphertextBytes'),'cipherSha256':row.get('ciphertextSha256'),'chunkBytes':row.get('chunkBytes'),
            'chunkCount':row.get('chunkCount'),'lastChunkBytes':row.get('lastChunkBytes')} for row in fixtures],
        'R12R6_CORPUS_BASELINE_MISMATCH')
    require(workload.get('bytesPerCycle')==25559136 and workload.get('cycles')==6 and workload.get('requestsPerCycle')==9 and
        workload.get('rangesPerCycle')==expected_ranges and sum(int(r[1].split('=')[1].split('-')[1])-int(r[1].split('=')[1].split('-')[0])+1 for r in expected_ranges)==workload['bytesPerCycle'],
        'R12R6_WORKLOAD_CHANGED')
    for row in fixtures:
        plain=wave.output/'fixtures/plain'/row['path'];cipher=wave.output/'fixtures/cipher'/f"video-{row['id']}.bin"
        require(row.get('chunkBytes')==4194304 and row.get('chunkCount')==3 and row.get('authenticatedMetadata') is True and
            plain.is_file() and plain.stat().st_size==row['bytes'] and sha256(plain)==row['sha256'] and
            cipher.is_file() and cipher.stat().st_size==row['ciphertextBytes'] and sha256(cipher)==row['ciphertextSha256'],
            'R12R6_FIXTURE_HASH_OR_SIZE_MISMATCH')
    return receipt

def validate_r9_authority(wave,frozen_protocol=None):
    return validate_campaign_authority(wave,'AP-06-R12-R9-factorial','quality/ap06-r12-r9.md','R12-R9',frozen_protocol)

def validate_r10_authority(wave,frozen_protocol=None):
    return validate_campaign_authority(wave,'AP-06-R12-R10-factorial','quality/ap06-r12-r10.md','R12-R10',frozen_protocol)

def current_authority_validator():
    return validate_r10_authority if CAMPAIGN.endswith('R10-factorial') else validate_r9_authority if CAMPAIGN.endswith('R9-factorial') else validate_r8_authority

def validate_r8_corpus(wave):
    try:
        receipt=validate_r6_corpus(wave)
    except (WaveFailure,OSError,ValueError,KeyError,TypeError):
        raise WaveFailure('R12R8_CORPUS_INVALID') from None
    require(receipt.get('reusedFromCampaign')=='AP-06-R12-R7-factorial' and
        receipt.get('sourceManifestSha256')==receipt.get('manifestSha256')=='d7fd432cefac1fa57a03d67dbda980799e6905e04a9ca0e2ed9b3b9d45bdae0b',
        'R12R8_CORPUS_INVALID')
    return receipt

class R8PreflightFailure(WaveFailure):
    def __init__(self,stage,failure_class,reservation_created=False,launch_attempts=0,browser_launches=0,
            cleanup_status='NOT_REQUIRED',cleanup_failure_class=None):
        super().__init__(failure_class)
        self.stage=stage;self.failure_class=failure_class;self.reservation_created=reservation_created
        self.launch_attempts=launch_attempts;self.browser_launches=browser_launches
        self.cleanup_status=cleanup_status;self.cleanup_failure_class=cleanup_failure_class

R9_FAILURES={
    'offline-authority':'R12R9_AUTHORITY_INVALID','offline-corpus':'R12R9_CORPUS_INVALID',
    'offline-dpapi-custody':'R12R9_DPAPI_CUSTODY_MISMATCH','offline-dpapi-unseal':'R12R9_DPAPI_UNSEAL_FAILED',  # gitleaks:allow public failure codes
    'offline-app-build':'R12R9_APP_PRODUCTS_INVALID','offline-backend':'R12R9_BACKEND_NOT_READY',
    'offline-browser-identity':'R12R9_BROWSER_IDENTITY_INVALID','offline-media-server':'R12R9_BACKEND_NOT_READY',
    'offline-environment':'R12R9_PREFLIGHT_CONTRACT_INVALID','offline-ci':'R12R9_AUTHORITY_INVALID',
    'preflight-execution':'R12R9_PREFLIGHT_CONTRACT_INVALID','preflight-validation':'R12R9_PREFLIGHT_CONTRACT_INVALID'}

def r9_failure(stage,error):
    reason=str(error)
    if reason=='MEDIA_SERVER_CLEANUP_FAILED':
        failure=R9_FAILURES.get(stage,'R12R9_PREFLIGHT_CONTRACT_INVALID') if error.__context__ else 'R12R9_CLEANUP_FAILED'
        return R8PreflightFailure(stage,failure,cleanup_status='FAIL',cleanup_failure_class='R12R9_CLEANUP_FAILED')
    failure=reason if reason in set(R9_FAILURES.values()) else R9_FAILURES.get(stage,'R12R9_PREFLIGHT_CONTRACT_INVALID')
    return R8PreflightFailure(stage,failure)

R10_FAILURES={**R9_FAILURES,'offline-authority':'R12R10_AUTHORITY_INVALID','offline-corpus':'R12R10_CORPUS_INVALID',
    'offline-dpapi-custody':'R12R10_DPAPI_CUSTODY_MISMATCH','offline-dpapi-unseal':'R12R10_DPAPI_UNSEAL_FAILED',  # gitleaks:allow public failure codes
    'offline-app-build':'R12R10_APP_PRODUCTS_INVALID','offline-backend':'R12R10_BACKEND_NOT_READY',
    'offline-browser-identity':'R12R10_BROWSER_IDENTITY_INVALID','offline-playwright-identity':'R12R10_PLAYWRIGHT_IDENTITY_INVALID',
    'offline-media-server':'R12R10_BACKEND_NOT_READY','offline-environment':'R12R10_PREFLIGHT_CONTRACT_INVALID',
    'offline-ci':'R12R10_AUTHORITY_INVALID','preflight-execution':'R12R10_PREFLIGHT_CONTRACT_INVALID',
    'preflight-validation':'R12R10_PREFLIGHT_CONTRACT_INVALID'}

def r10_failure(stage,error):
    reason=str(error)
    if reason=='MEDIA_SERVER_CLEANUP_FAILED':
        failure=R10_FAILURES.get(stage,'R12R10_PREFLIGHT_CONTRACT_INVALID') if error.__context__ else 'R12R10_CLEANUP_FAILED'
        return R8PreflightFailure(stage,failure,cleanup_status='FAIL',cleanup_failure_class='R12R10_CLEANUP_FAILED')
    failure=reason if reason in set(R10_FAILURES.values()) else R10_FAILURES.get(stage,'R12R10_PREFLIGHT_CONTRACT_INVALID')
    return R8PreflightFailure(stage,failure)

@contextmanager
def r9_stage(stage):
    try:yield
    except R8PreflightFailure:raise
    except (RuntimeError,OSError,ValueError,KeyError,TypeError,IndexError,subprocess.SubprocessError) as error:
        raise r9_failure(stage,error) from None

@contextmanager
def r10_stage(stage):
    try:yield
    except R8PreflightFailure:raise
    except (RuntimeError,OSError,ValueError,KeyError,TypeError,IndexError,subprocess.SubprocessError) as error:
        raise r10_failure(stage,error) from None

def tracked_tree_sha(wave):
    import hashlib
    rows={name:sha256(wave.root/name) for name in wave.git('ls-files').splitlines() if (wave.root/name).is_file()}
    return hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest()

def verify_r10_playwright_identity_preflight(wave,env):
    expected=read(wave.output/'baseline/browser-identity.json');head=wave.git('rev-parse','HEAD').strip()
    command_env=dict(env,AP06_R12R10_HEAD=head)
    output=wave.command('r12-r10-playwright-identity',[wave.node,'tools/ap06-r12-identity-preflight.mjs'],
        wave.root/'frontend',command_env,check=False)
    try:receipt=json.loads(output.strip().splitlines()[-1])
    except (ValueError,IndexError):raise WaveFailure('R12R10_PLAYWRIGHT_IDENTITY_INVALID') from None
    wave.save('baseline/playwright-identity-preflight.json',receipt)
    require(receipt.get('status')=='PASS' and receipt.get('head')==head and
        receipt.get('manifestSha256')==sha256(wave.output/'baseline/browser-identity.json') and
        receipt.get('playwrightVersion')==expected.get('playwrightVersion') and
        receipt.get('chromiumVersion')==expected.get('chromiumVersion') and
        receipt.get('scientificChromium')==0 and receipt.get('reservationCreated') is False and
        receipt.get('launchAttempts')==receipt.get('retries')==0,
        'R12R10_PLAYWRIGHT_IDENTITY_INVALID')
    return receipt

def verify_r10_offline_ready(wave,env,identity):
    ready=read(wave.output/'baseline/offline-ready.json');head=wave.git('rev-parse','HEAD').strip()
    require(ready.get('status')=='R12R10_OFFLINE_READY' and ready.get('implementationHead')==head and
        ready.get('appProductsSha256')==sha256(wave.output/'tooling/app-products.json') and
        ready.get('reservationCreated') is False and ready.get('launchAttempts')==ready.get('browserLaunches')==ready.get('retries')==0,
        'R12R10_PREFLIGHT_CONTRACT_INVALID')
    from ap06_browser_identity import verify_identity
    current=read(wave.output/'baseline/browser-identity.json')
    require(current==identity,'R12R10_BROWSER_IDENTITY_INVALID')
    verify_identity(current)
    receipt=verify_r10_playwright_identity_preflight(wave,env)
    require(sha256(wave.output/'baseline/playwright-identity-preflight.json')==ready.get('playwrightIdentityPreflightSha256'),
        'R12R10_PLAYWRIGHT_IDENTITY_INVALID')
    return receipt

def prepare_scientific_preflight(wave,require_ci=True,publish_identity=False):
    r10=CAMPAIGN=='AP-06-R12-R10-factorial';r9=CAMPAIGN=='AP-06-R12-R9-factorial'
    require(r9 or r10,'R12R9_AUTHORITY_INVALID')
    stage_context=r10_stage if r10 else r9_stage
    authority_validator=validate_r10_authority if r10 else validate_r9_authority
    prefix='R12R10' if r10 else 'R12R9'
    with stage_context('offline-authority'):
        authority_validator(wave)
        require(not any((wave.output/p).exists() for p in ('final/STOP.json','pipeline/development-reservation.json',
            'pipeline/preflight-started.json','tooling/freeze.json')),'R12R9_AUTHORITY_INVALID')
    with stage_context('offline-corpus'):validate_r8_corpus(wave);files=media_files(wave)
    with stage_context('offline-browser-identity'):
        from ap06_browser_identity import verify_identity
        identity=read(wave.output/'baseline/browser-identity.json');validate_r8_browser_identity(identity,verify_identity(identity))
    with stage_context('offline-app-build'):prepare_preflight_assets(wave)
    with stage_context('offline-environment'):env,assets=environment(wave,wave.output/'tooling','r12r2.0')
    identity=verify_preflight_dependencies(wave,env,assets,files,publish_identity)
    with stage_context('offline-backend'):
        from urllib.request import Request,urlopen
        backend=read(wave.output/'baseline/backend-runtime.local.json');auth=read(wave.output/'baseline/player-auth.local.json')
        require(read(wave.output/'baseline/network-spoof-guard.json').get('status')=='PASS','R12R9_BACKEND_NOT_READY')
        require(read(wave.output/'baseline/listener-isolation.json').get('status')=='PASS','R12R9_BACKEND_NOT_READY')
        request=Request(backend['backendOrigin']+'/login',data=json.dumps({k:auth[k] for k in ('username','password')}).encode(),
            headers={'Content-Type':'application/json'},method='POST')
        with urlopen(request,timeout=10) as response:login=json.load(response)
        require(isinstance(login.get('token'),str) and bool(login['token']),'R12R9_BACKEND_NOT_READY')
        del login
    with stage_context('offline-media-server'):
        with media_server(files,True,'application/octet-stream',assets,port=42088) as (origin,stats):
            with urlopen(origin+'/',timeout=5) as response:require(response.status==200,'R12R9_BACKEND_NOT_READY')
    playwright_receipt=None
    if r10:
        with r10_stage('offline-playwright-identity'):playwright_receipt=verify_r10_playwright_identity_preflight(wave,env)
    if require_ci:
        with stage_context('offline-ci'):validate_r8_preflight_authority(wave)
    wave.save('baseline/offline-ready.json',{'status':f'{prefix}_OFFLINE_READY' if require_ci else 'DEVELOPMENT_READY',
        'implementationHead':wave.git('rev-parse','HEAD').strip(),'reservationCreated':False,'launchAttempts':0,
        'browserLaunches':0,'retries':0,'ciValidated':require_ci,'cleanupStatus':'PASS',
        'appProductsSha256':sha256(wave.output/'tooling/app-products.json'),
        'runtimeCustodySha256':sha256(wave.output/'baseline/runtime-credentials-readback.json'),
        **({'playwrightIdentityPreflightSha256':sha256(wave.output/'baseline/playwright-identity-preflight.json')} if playwright_receipt else {})})
    return env,assets,files,identity

def preflight_build_inputs(root):
    return {'angularJson':sha256(root/'frontend/angular.json'),'packageJson':sha256(root/'frontend/package.json'),
        'packageLock':sha256(root/'frontend/package-lock.json'),
        'projectSource':owner._tree_sha256(root,'frontend/experiments/ap06-r7'),
        'appSource':owner._tree_sha256(root,'frontend/src')}

def prepare_preflight_assets(wave):
    app=wave.output/'tooling/app'
    try:
        require(wave.output.resolve()==(wave.root/OUTPUT).resolve() and CAMPAIGN in ('AP-06-R12-R8-factorial','AP-06-R12-R9-factorial','AP-06-R12-R10-factorial') and
            not (wave.output/'tooling/freeze.json').exists() and
            not (wave.output/'final/STOP.json').exists(),'R12R8_APP_BUILD_FAILED')
        checked_path(app.absolute());private_permissions(wave.output)
        inputs=preflight_build_inputs(wave.root)
    except (WaveFailure,OSError,ValueError,subprocess.SubprocessError):
        raise WaveFailure('R12R8_APP_BUILD_FAILED') from None
    receipt_path=wave.output/'tooling/app-products.json'
    if app.exists():
        try:
            command=read(wave.output/('pipeline/commands/'+campaign_prefix().lower().removesuffix('_').replace('r12r','r12-r')+'-angular-build.json'));receipt=read(receipt_path)
            require(command.get('status')=='PASS' and command.get('exitCode')==0 and receipt.get('inputs')==inputs,
                'R12R8_APP_BUILD_FAILED')
        except (WaveFailure,OSError,ValueError,TypeError):
            raise WaveFailure('R12R8_APP_BUILD_FAILED') from None
        assets,products,workers=build_products(wave.root,OUTPUT)
        validate_r8_product_receipt(receipt,products,workers)
        return assets,products,workers
    try:
        wave.command(campaign_prefix().lower().removesuffix('_').replace('r12r','r12-r')+'-angular-build',[npm_command(),'run','build','--','ap06-r7',
            '--output-path=../'+OUTPUT+'/tooling/app'],wave.root/'frontend')
    except (WaveFailure,OSError,ValueError,subprocess.SubprocessError):
        raise WaveFailure('R12R8_APP_BUILD_FAILED') from None
    assets,products,workers=build_products(wave.root,OUTPUT)
    require(set(workers)=={'crypto','transmux'},'R12R8_WORKER_PRODUCTS_INVALID')
    receipt={'status':'PASS','project':'ap06-r7','output':OUTPUT+'/tooling/app',
        'inputs':inputs,'products':products,'workers':workers}
    wave.save('tooling/app-products.json',receipt)
    return assets,products,workers

def validate_r8_product_receipt(receipt,products,workers):
    require(isinstance(receipt,dict) and receipt.get('status')=='PASS','R12R8_APP_PRODUCTS_MISSING')
    require(receipt.get('workers')==workers,'R12R8_WORKER_HASH_MISMATCH')
    require(receipt.get('products')==products,'R12R8_APP_PRODUCTS_MISSING')

def validate_r8_native_tests(wave):
    try:
        summary=read(wave.output/'baseline/native-tests-summary.json');reuse=read(wave.output/'baseline/native-binary-reuse.json')
        backend=read(wave.output/'baseline/experimental-backend.json');artifacts=reuse.get('artifacts',{});suites=summary.get('suites',{})
        require(summary.get('status')=='PASS' and summary.get('seed')==60102 and set(suites)=={'production','experimental'} and
            all(row.get('status')=='PASS' and row.get('assertionsFailed')==row.get('casesFailed')==row.get('expectedFailures')==0 and
                type(row.get('assertionsPassed')) is int and row['assertionsPassed']>0 and type(row.get('casesPassed')) is int and
                row['casesPassed']>0 and row.get('xmlSha256')==sha256(wave.output/'baseline'/f'native-{kind}.xml')
                for kind,row in suites.items()),'R12R8_PREFLIGHT_NOT_READY')
        require(reuse.get('status')=='PASS' and backend.get('status')=='PASS' and
            artifacts.get('server')==backend.get('binarySha256') and artifacts.get('compileCommands')==backend.get('compileCommandsSha256') and
            artifacts.get('cmakeCache')==backend.get('cmakeCacheSha256') and backend.get('crowHeaderSha256') and
            ((wave.root/'backend/include/crow_all.h').is_file() and sha256(wave.root/'backend/include/crow_all.h')==backend.get('crowHeaderSha256') or
                not (wave.root/'backend/include/crow_all.h').exists() and backend.get('crowHeaderSource','').startswith('reused R7 build receipt')) and
            all(artifacts.get(name)==sha256(wave.output/'tooling/backend-build'/path) for name,path in (
                ('server','nanika_ap06_local_server.exe'),('compileCommands','compile_commands.json'),('cmakeCache','CMakeCache.txt'),
                ('productionTests','savebox_tests.exe'),('experimentalTests','nanika_ap06_tests.exe'))),
            'R12R8_PREFLIGHT_NOT_READY')
        return summary
    except (WaveFailure,OSError,ValueError,KeyError,TypeError,AttributeError):
        raise WaveFailure('R12R8_PREFLIGHT_NOT_READY') from None

def validate_r8_global_quality(wave):
    known=('docs/arquitetura/visao-geral.md','docs/arquitetura/frontend.md','docs/arquitetura/backend.md','docs/arquitetura/deployment.md')
    try:
        record=read(wave.output/'baseline/global-quality-r8.json')
        require(record.get('status')=='DOCUMENTED_EXCEPTION' and type(record.get('tests')) is int and record['tests']>0 and
            record.get('failures')==4 and record.get('errors')==0 and record.get('failureClass')=='preexisting documentation boundaries' and
            record.get('failureFiles')==list(known) and record.get('historicalFailureDocumentsUnchanged') is True and
            isinstance(record.get('snapshotSha256'),str) and re.fullmatch(r'[0-9a-f]{64}',record['snapshotSha256']) is not None,
            'R12R8_PREFLIGHT_NOT_READY')
        return record
    except (WaveFailure,OSError,ValueError,KeyError,TypeError,AttributeError):
        raise WaveFailure('R12R8_PREFLIGHT_NOT_READY') from None

def validate_r8_dependency_audit(wave):
    try:
        audit=read(wave.output/'baseline/dependency-audit.json');reports=audit.get('reports',{})
        all_report=reports.get('all',{});runtime=reports.get('runtime',{})
        require(audit.get('status')=='RECORDED_NO_UPGRADES' and audit.get('upgradePerformed') is False and
            audit.get('packageLockSha256')==sha256(wave.root/'frontend/package-lock.json') and
            all_report.get('status')=='PASS' and all_report.get('counts')=={'info':0,'low':0,'moderate':7,'high':20,'critical':3,'total':30} and
            len(all_report.get('findings',[]))==30 and runtime.get('status')=='PASS' and
            runtime.get('counts')=={'info':0,'low':0,'moderate':0,'high':1,'critical':0,'total':1} and
            len(runtime.get('findings',[]))==1 and runtime['findings'][0].get('package')=='@angular/router' and
            runtime['findings'][0].get('severity')=='high','R12R8_PREFLIGHT_NOT_READY')
        return audit
    except (WaveFailure,OSError,ValueError,KeyError,TypeError,AttributeError):
        raise WaveFailure('R12R8_PREFLIGHT_NOT_READY') from None

def validate_r8_secret_scan(wave):
    try:
        receipt=read(wave.output/'baseline/secret-scan-receipt.json')
        findings=read(wave.output/'baseline/secret-scan.json')
        require(receipt.get('status')=='PASS' and receipt.get('scanner')=='gitleaks' and receipt.get('version')=='v8.30.1' and
            receipt.get('findings')==0 and (receipt.get('trackedTreeSha256')==tracked_tree_sha(wave) if CAMPAIGN.endswith(('R9-factorial','R10-factorial')) else receipt.get('stagedFiles')==10) and findings==[],'R12R8_PREFLIGHT_NOT_READY')
        return receipt
    except (WaveFailure,OSError,ValueError,KeyError,TypeError,AttributeError):
        raise WaveFailure('R12R8_PREFLIGHT_NOT_READY') from None

def validate_r8_browser_identity(identity,observed):
    require(isinstance(identity,dict) and isinstance(observed,dict) and observed.get('status')=='PASS' and 'productVersion' in observed and
        observed['productVersion'] in (None,VERSION) and identity.get('chromiumVersion')==VERSION,
        'R12R8_PREFLIGHT_NOT_READY')

def verify_preflight_dependencies(wave,env,assets,files,publish_identity=True):
    stage='offline-browser-identity'
    try:
        identity=read(wave.output/'baseline/browser-identity.json')
        from ap06_browser_identity import verify_identity
        observed=verify_identity(identity)
        validate_r8_browser_identity(identity,observed)
        stage='offline-app-build'
        require(set(assets)>= {'/'} and all(path.is_file() and not path.is_symlink() for path,_ in assets.values()),
            'R12R8_PREFLIGHT_NOT_READY')
        receipt=read(wave.output/'tooling/app-products.json')
        _,products,workers=build_products(wave.root,OUTPUT)
        validate_r8_product_receipt(receipt,products,workers)
        stage='offline-authority'
        config=read(wave.output/'baseline/authority-config.local.json')
        authority=Path(config['AP06_AUTHORITY_ROOT'])
        from ap06_authorities import validate_owned_destination
        validate_owned_destination(authority,config['identity'],campaign='AP-06-R10')
        stage='offline-backend'
        backend=read(wave.output/'baseline/backend-runtime.local.json')
        live=read(wave.output/'pipeline/backend-live.json')
        runtime=checked_path(Path(backend['cwd']).absolute());storage=checked_path(Path(backend['storagePath']).absolute())
        origin=urlsplit(backend['backendOrigin'])
        require(runtime.resolve().is_relative_to(wave.output.resolve()) and storage==runtime/'storage' and
            (runtime/'.owned-r10_r3').read_text()==backend['storageId'] and
            (storage/'.nanika-e2e-storage-id').read_text()==backend['storageId'] and
            Path(backend['executable']).is_file() and (runtime/'process.log').is_file() and
            origin.scheme=='http' and origin.hostname=='127.0.0.1' and origin.port==42187 and
            live.get('status')=='READY' and live.get('isolated') is True and live.get('backendOrigin')==backend['backendOrigin'] and
            type(live.get('backendPid')) is int and type(live.get('postgresPid')) is int,
            'R12R8_PREFLIGHT_NOT_READY')
        if CAMPAIGN.endswith(('R9-factorial','R10-factorial')):
            from ap06_local_backend import verify_listener
            verify_listener(live['backendPid'])
            isolation=read(wave.output/'baseline/backend-isolation.json')
            require(isolation.get('status')=='PASS' and isolation.get('backendPid')==live['backendPid'] and
                isolation.get('postgresPid')==live['postgresPid'] and isolation.get('trustProxyHeaders') is False and
                isolation.get('postgresConfigSha256')==sha256(runtime/'pg/postgresql.conf') and
                isolation.get('pgHbaSha256')==sha256(runtime/'pg/pg_hba.conf'),'R12R9_BACKEND_NOT_READY')
        with socket.create_connection((origin.hostname,origin.port),timeout=3):pass
        for relative in ('baseline/player-auth.local.json','baseline/backend-runtime.local.json',
                'baseline/backend-authority.json','baseline/experimental-backend.json','baseline/backend-isolation.json',
                'baseline/runtime-credentials.dpapi','baseline/runtime-credentials-custody.json',
                'tooling/backend-build/nanika_ap06_local_server.exe','tooling/backend-build/CMakeCache.txt',
                'tooling/backend-build/compile_commands.json'):
            path=checked_path((wave.output/relative).absolute())
            require(path.is_file(),'R12R8_PREFLIGHT_NOT_READY')
        stage='offline-dpapi-custody'
        custody=read(wave.output/'baseline/runtime-credentials-custody.json')
        readback=read(wave.output/'baseline/runtime-credentials-readback.json')
        if CAMPAIGN in ('AP-06-R12-R9-factorial','AP-06-R12-R10-factorial'):
            from ap06_key_custody import verify_runtime_key_custody
            verify_runtime_key_custody(wave.output/'baseline/runtime-credentials.dpapi',custody,readback,
                validate_r8_corpus(wave)['manifestSha256'],config['identity'],CAMPAIGN,
                {name:read(wave.output/'baseline'/name) for name in
                    ('accounts.local.json','player-auth.local.json','backend-runtime.local.json')})
        else:
            require(custody.get('manifestSha256')==validate_r8_corpus(wave)['manifestSha256'] and
                custody.get('protectedSha256')==sha256(wave.output/'baseline/runtime-credentials.dpapi') and
                readback.get('status')=='PASS' and readback.get('identity')==config['identity'] and
                readback.get('manifestSha256')==custody['manifestSha256'] and readback.get('plaintextPersisted') is False,
                'R12R8_PREFLIGHT_NOT_READY')
        stage='offline-dpapi-unseal'
        # Validate current-user DPAPI access in memory; never persist or print the recovered synthetic keys.
        result=subprocess.run([sys.executable,str(wave.root/'tools/quality/ap06_r11_keys.py'),
            str(wave.output/'baseline/authority-config.local.json')],cwd=wave.root,capture_output=True,check=True)
        keys=json.loads(result.stdout)
        require(isinstance(keys,dict) and len(keys)==3,'R12R8_PREFLIGHT_NOT_READY')
        del keys,result
        stage='offline-corpus'
        expected={f'/video-{row["id"]}.mp4':row for row in validate_r8_corpus(wave)['fixtures']}
        require(set(files)==set(expected),'R12R8_CORPUS_INVALID')
        for url,path in files.items():
            checked_path(path.absolute())
            row=expected[url]
            require(path.is_file() and sha256(path)==row['cipherSha256'] and path.stat().st_size==row['cipherBytes'],
                'R12R8_CORPUS_INVALID')
        stage='offline-environment'
        key_names=('AP06_R11_KEYS','AP06_R11_AUTHORITY') if CAMPAIGN.endswith(('R9-factorial','R10-factorial')) else ('AP06_R9_PRIVATE_KEYS',)
        for name in ('AP06_R5_FIXTURE_MANIFEST',*key_names,'AP06_R9_BACKEND_LOG',
                'AP06_R7_APP_PRODUCTS','AP06_BROWSER_IDENTITY'):
            require(bool(env.get(name)),'R12R8_PREFLIGHT_NOT_READY')
        require(Path(env['AP06_R5_FIXTURE_MANIFEST']).is_file() and (CAMPAIGN in ('AP-06-R12-R9-factorial','AP-06-R12-R10-factorial') or Path(env['AP06_R9_PRIVATE_KEYS']).is_file()) and
            Path(env['AP06_BROWSER_IDENTITY']).is_file(),'R12R8_PREFLIGHT_NOT_READY')
        if publish_identity:
            receipt=publish(wave,'browser-identity',{'evidence/browser-identity.json':wave.output/'baseline/browser-identity.json'})
            wave.save('baseline/browser-identity-publication.json',{'status':'PASS','publication':wave.output.name.replace('readiness-wave','r')+'-browser-identity',
                'manifestSha256':receipt['manifestSha256'],'identitySha256':sha256(wave.output/'baseline/browser-identity.json')})
        return identity
    except R8PreflightFailure:
        raise
    except WaveFailure as error:
        if CAMPAIGN.endswith('R10-factorial'):raise r10_failure(stage,error) from None
        if CAMPAIGN.endswith('R9-factorial'):raise r9_failure(stage,error) from None
        if str(error).startswith(('R12R8_','R12R9_')):raise
        raise WaveFailure('R12R8_PREFLIGHT_NOT_READY') from None
    except (OSError,ValueError,TypeError,KeyError,subprocess.SubprocessError) as error:
        if CAMPAIGN.endswith('R10-factorial'):raise r10_failure(stage,error) from None
        if CAMPAIGN.endswith('R9-factorial'):raise r9_failure(stage,error) from None
        raise WaveFailure('R12R8_PREFLIGHT_NOT_READY') from None

def validate_r8_preflight_authority(wave):
    try:
        current_authority_validator()(wave);validate_r8_corpus(wave)
        require(not wave.git('status','--porcelain').strip(),'R12R8_PREFLIGHT_NOT_READY')
        checks=read(wave.output/'baseline/prechecks.json')
        require(all(checks.get(key)=='PASS' for key in ('status','secretScan','angularBuild','typescript','syntax','diff','nativeTests')) and
            checks.get('globalTests')=='DOCUMENTED_EXCEPTION' and checks.get('dependencyAudit')=='PASS',
            'R12R8_PREFLIGHT_NOT_READY')
        validate_r8_native_tests(wave)
        validate_r8_global_quality(wave)
        validate_r8_dependency_audit(wave)
        validate_r8_secret_scan(wave)
        if CAMPAIGN.endswith(('R9-factorial','R10-factorial')):
            integration=read(wave.output/'baseline/offline-integration.json')
            require(integration.get('status')=='PASS' and integration.get('realDpapiBuildBackendMediaOs') is True and
                integration.get('receiptRoundtrip')==integration.get('freezeConsumerRoundtrip')=='PASS' and
                integration.get('trackedTreeSha256')==tracked_tree_sha(wave),'R12R9_PREFLIGHT_CONTRACT_INVALID')
        if CAMPAIGN.endswith('R10-factorial'):
            identity=read(wave.output/'baseline/browser-identity.json')
            receipt=read(wave.output/'baseline/playwright-identity-preflight.json')
            require(receipt.get('status')=='PASS' and receipt.get('head')==wave.git('rev-parse','HEAD').strip() and
                receipt.get('manifestSha256')==sha256(wave.output/'baseline/browser-identity.json') and
                receipt.get('playwrightVersion')==identity.get('playwrightVersion') and
                receipt.get('chromiumVersion')==identity.get('chromiumVersion') and receipt.get('scientificChromium')==0 and
                receipt.get('reservationCreated') is False and receipt.get('launchAttempts')==receipt.get('retries')==0,
                'R12R10_PLAYWRIGHT_IDENTITY_INVALID')
        budget=read(wave.output/'baseline/budget.json')
        require(budget.get('approved') is True and budget.get('developmentMaximum')==1 and
            budget.get('globalMaximum')==14 and budget.get('triageMaximum')==4 and budget.get('formalMaximum')==6 and
            budget.get('nativeCapabilityMaximum')==1 and budget.get('nativeMeasurementMaximum')==2 and
            budget.get('measurementRetries')==0,'R12R8_PREFLIGHT_NOT_READY')
        ci=read(wave.output/'baseline/ci.json');head=wave.git('rev-parse','HEAD').strip()
        require(ci.get('headSha')==head and ci.get('conclusion')=='success' and len(ci.get('jobs',[]))==3 and
            all(job.get('conclusion')=='success' for job in ci['jobs']),'R12R8_PREFLIGHT_NOT_READY')
        quality=read(wave.output/'baseline/quality-baseline-ci.json')
        require(quality.get('headSha')==head and quality.get('conclusion')=='success','R12R8_PREFLIGHT_NOT_READY')
        require(not (wave.output/'final/STOP.json').exists() and
            not (wave.output/'pipeline/development-reservation.json').exists() and
            not (wave.output/'tooling/freeze.json').exists(),'R12R8_PREFLIGHT_NOT_READY')
    except (WaveFailure,OSError,ValueError,KeyError,TypeError):
        raise WaveFailure('R12R8_PREFLIGHT_NOT_READY') from None

def unit_browser_r8(wave):
    reservation=wave.output/'pipeline/development-reservation.json';target=wave.output/'tooling/angular-unit-1.json'
    started=wave.output/'pipeline/preflight-started.json'
    reservation_created=False;launch_attempts=browser_launches=0;cleanup_status='NOT_REQUIRED';cleanup_failure=None
    stage='offline-authority'
    try:
        prepared=prepare_scientific_preflight(wave,publish_identity=True) if CAMPAIGN.endswith(('R9-factorial','R10-factorial')) else None
        if CAMPAIGN.endswith('R10-factorial'):
            stage='offline-playwright-identity'
            with r10_stage(stage):verify_r10_offline_ready(wave,prepared[0],prepared[3])
        started.parent.mkdir(parents=True,exist_ok=True)
        with started.open('x',encoding='utf-8') as stream:
            json.dump({'campaign':CAMPAIGN,'head':wave.git('rev-parse','HEAD'),'retries':0},stream)
        if prepared:
            env,assets,files,identity=prepared
            env['AP06_R7_UNIT_OUTPUT']=str(target)
        else:
            validate_r8_preflight_authority(wave)
            stage='offline-app-build'
            assets,products,workers=prepare_preflight_assets(wave)
            stage='offline-environment'
            env,assets=environment(wave,wave.output/'tooling','r12r2.0')
            env['AP06_R7_UNIT_OUTPUT']=str(target)
            files=media_files(wave)
            identity=verify_preflight_dependencies(wave,env,assets,files)
        stage='offline-media-server'
        primary=None;server_started=False
        try:
            with media_server(files,True,'application/octet-stream',assets,port=42088) as (origin,stats):
                server_started=True;cleanup_status='PASS';env['AP06_R5_MEDIA_ORIGIN']=origin
                try:
                    parsed=urlsplit(origin)
                    with socket.create_connection((parsed.hostname,parsed.port),timeout=3):pass
                    require(not reservation.exists(),'R12R8_PREFLIGHT_NOT_READY')
                    reservation.parent.mkdir(parents=True,exist_ok=True)
                    with reservation.open('x',encoding='utf-8') as stream:
                        json.dump({'campaign':CAMPAIGN,'head':wave.git('rev-parse','HEAD'),'maximum':1,'retries':0,
                            'appProductsSha256':sha256(wave.output/'tooling/app-products.json')},stream)
                    reservation_created=True
                    publish(wave,'development-reserved',{'evidence/development-reservation.json':reservation})
                    stage='preflight-execution'
                    try:
                        wave.command(campaign_prefix().lower().removesuffix('_').replace('r12r','r12-r')+'-preflight',[wave.node,'tools/ap06-r12-r2-preflight.mjs' if prepared else 'tools/ap06-r12-preflight.mjs'],wave.root/'frontend',env)
                    except (WaveFailure,OSError,subprocess.SubprocessError):
                        primary=R8PreflightFailure(stage,'R12R8_PREFLIGHT_EXECUTION_FAILED',True,0,0,cleanup_status)
                    if target.exists():
                        raw=read(target);launch_attempts=raw.get('unitBrowserLaunchAttempts',0);browser_launches=raw.get('unitBrowserLaunches',0)
                        publish(wave,'preflight-complete',{'evidence/preflight.raw.json':target})
                    wave.save('pipeline/preflight-transport.json',stats)
                except (WaveFailure,OSError,ValueError,TypeError,KeyError,subprocess.SubprocessError) as error:
                    if primary is None:
                        failure='R12R8_PREFLIGHT_NOT_READY' if not reservation_created else 'R12R8_PREFLIGHT_EXECUTION_FAILED'
                        primary=R8PreflightFailure(stage,failure,reservation_created,launch_attempts,browser_launches,cleanup_status)
                if primary is not None:
                    primary.launch_attempts=launch_attempts;primary.browser_launches=browser_launches
        except (OSError,ValueError,RuntimeError,WaveFailure) as error:
            if primary is None:
                failure='R12R8_PREFLIGHT_NOT_READY' if not reservation_created else 'R12R8_PREFLIGHT_EXECUTION_FAILED'
                primary=R8PreflightFailure(stage,failure,reservation_created,launch_attempts,browser_launches,
                    'FAIL' if server_started else 'NOT_STARTED',
                    'MEDIA_SERVER_CLEANUP_FAILED' if server_started and 'CLEANUP' in str(error) else None)
            else:
                primary.cleanup_status='FAIL';primary.cleanup_failure_class='MEDIA_SERVER_CLEANUP_FAILED'
        if primary is not None:
            if prepared:
                r10=CAMPAIGN.endswith('R10-factorial');prefix='R12R10' if r10 else 'R12R9'
                primary.failure_class=(R10_FAILURES if r10 else R9_FAILURES).get(primary.stage,prefix+'_PREFLIGHT_CONTRACT_INVALID')
                if target.is_file():
                    observed=read(target)
                    if observed.get('cleanupFailureClass'):
                        primary.cleanup_failure_class=prefix+'_CLEANUP_FAILED';primary.cleanup_status='FAIL'
                        if observed.get('failureClass') in (None,observed.get('cleanupFailureClass')):primary.failure_class=prefix+'_CLEANUP_FAILED'
                    primary.secondary_failure_class=observed.get('failureClass')
                if primary.cleanup_failure_class:primary.cleanup_failure_class=prefix+'_CLEANUP_FAILED'
            raise primary
        stage='preflight-validation'
        unit=read(target);validate_preflight_receipt(wave,unit,identity)
        ready={'status':'PASS','developmentChromium':1,'retries':0,'reservationCreated':True,
            'launchAttempts':launch_attempts,'browserLaunches':browser_launches,'cleanupStatus':cleanup_status,
            'appProductsSha256':sha256(wave.output/'tooling/app-products.json')}
        wave.save('baseline/preflight-ready.json',ready)
        publish(wave,'preflight-ready',{'evidence/preflight-ready.json':wave.output/'baseline/preflight-ready.json'})
    except R8PreflightFailure:
        raise
    except (WaveFailure,OSError,ValueError,RuntimeError,subprocess.SubprocessError,KeyError,TypeError,IndexError) as error:
        reason=str(error)
        failure=reason if reason.startswith('R12R8_') else (
            'R12R8_PREFLIGHT_EXECUTION_FAILED' if reservation_created else 'R12R8_PREFLIGHT_NOT_READY')
        if stage=='offline-app-build' and failure=='R12R8_PREFLIGHT_NOT_READY':failure='R12R8_APP_BUILD_FAILED'
        if stage=='offline-media-server' and failure=='R12R8_PREFLIGHT_NOT_READY':failure='R12R8_PREFLIGHT_NOT_READY'
        if CAMPAIGN.endswith('R10-factorial'):failure=r10_failure(stage,error).failure_class
        elif CAMPAIGN.endswith('R9-factorial'):failure=r9_failure(stage,error).failure_class
        raise R8PreflightFailure(stage,failure,reservation_created,launch_attempts,browser_launches,cleanup_status,cleanup_failure) from None

def validate_preflight_receipt(wave,unit,identity):
    require(unit.get('status')=='PASS' and unit.get('unitBrowserLaunchAttempts')==unit.get('unitBrowserLaunches')==1 and
        unit.get('browserClosed') is True and unit.get('processExitAudit',{}).get('status')=='PASS' and
        unit.get('browserIdentity',{}).get('before',{}).get('browserPid')==unit.get('browserIdentity',{}).get('after',{}).get('browserPid') and
        unit.get('browserIdentity',{}).get('before',{}).get('processCreationTime')==unit.get('browserIdentity',{}).get('after',{}).get('processCreationTime'),
        'R12R8_PREFLIGHT_EXECUTION_FAILED')
    validate_browser_receipt(unit,identity,process_samples=[sample for case in unit['cases'] for sample in case.get('processSamples',())])
    workload=read(wave.output/'baseline/workload.json');fixtures=read(wave.output/'fixtures/manifest.json')
    mapping=read(wave.output/'baseline/backend-authority.json')['fileMapping']
    for condition in CONDITIONS:
        network=unit['rangeNetworks'][condition]
        require(unit['transportProofs'][condition]==expected_proof('r10.1'),'R12R8_PREFLIGHT_EXECUTION_FAILED')
        require(validate_mixed_network({'rangeNetwork':network['cdp'],'backendTraffic':network['backend']},condition,
            workload['rangesPerCycle'],fixtures,mapping)==workload['bytesPerCycle'],'R12R8_PREFLIGHT_EXECUTION_FAILED')
        validate_scalars(unit['scalarCounters'][condition],'r12.0',3,workload['bytesPerCycle'])
        require(unit['routingCounters'][condition]==transport_counts(condition,3),'R12R8_PREFLIGHT_EXECUTION_FAILED')
    require(len(unit.get('cases',[]))==5 and all(row.get('status')=='PASS' and row.get('contextClosed') for row in unit['cases']),
        'R12R8_PREFLIGHT_EXECUTION_FAILED')
    if CAMPAIGN.endswith(('R9-factorial','R10-factorial')):
        require([row.get('condition') for row in unit['cases']]==[*CONDITIONS,'cancel-r12r2.3'],
            campaign_prefix()+'PREFLIGHT_CONTRACT_INVALID')
    return True

def validate_browser_receipt(record,identity,native=False,process_samples=None):
    receipt=record.get('browserIdentity',{})
    r5=CAMPAIGN in ('AP-06-R12-R5-factorial','AP-06-R12-R6-factorial','AP-06-R12-R7-factorial','AP-06-R12-R8-factorial','AP-06-R12-R9-factorial','AP-06-R12-R10-factorial')
    r4=CAMPAIGN in ('AP-06-R12-R4-factorial','AP-06-R12-R5-factorial','AP-06-R12-R6-factorial','AP-06-R12-R7-factorial','AP-06-R12-R8-factorial','AP-06-R12-R9-factorial','AP-06-R12-R10-factorial');prefix=campaign_prefix()
    launched=(receipt.get('browserLaunchSucceeded') is True and receipt.get('attemptReserved') is True) if r4 else receipt.get('launchSucceeded') is True
    require(receipt.get('status')=='PASS' and receipt.get('readLease') is True and launched,prefix+'BROWSER_IDENTITY_REQUIRED')
    before,after=receipt.get('before',{}),receipt.get('after',{})
    if r5:
        if process_samples is None:
            process_samples=record.get('processSamples',record.get('samples'))
            if process_samples is None:
                process_samples=[sample for case in record.get('cases',()) for sample in case.get('processSamples',())]
        audit=record.get('processExitAudit');validate_process_audit_receipt(audit,process_samples)
        require(receipt.get('processExitAudit')==audit and any(row['pid']==before.get('browserPid') and 'browser' in row['roles']
            for row in audit['processes']),prefix+'BROWSER_PROCESS_AUDIT_MISSING_ROOT')
        release=record.get('handleRelease');process_handles=release.get('processHandles',{}) if isinstance(release,dict) else {}
        executable_handles=release.get('executableHandles',{}) if isinstance(release,dict) else {}
        require(receipt.get('handleRelease')==release and isinstance(release,dict) and set(release)=={'status','processHandles','executableHandles'} and
            release.get('status')=='PASS' and set(process_handles)=={'releasedProcessHandles','closeFailures'} and
            type(process_handles.get('releasedProcessHandles')) is int and process_handles.get('releasedProcessHandles')==audit['registeredProcessCount'] and
            type(process_handles.get('closeFailures')) is int and process_handles.get('closeFailures')==0 and
            set(executable_handles)=={'releasedExecutableHandles','closeFailures'} and
            type(executable_handles.get('releasedExecutableHandles')) is int and
            executable_handles.get('releasedExecutableHandles')==1+len(identity.get('installationFiles',{})) and
            type(executable_handles.get('closeFailures')) is int and executable_handles.get('closeFailures')==0,
            prefix+'PROCESS_HANDLES_NOT_RELEASED')
    process_audit=record.get('processExitAudit') if r5 else receipt.get('processExitAudit',{})
    require((process_audit.get('status')=='PASS') and before.get('identityBeforeWorkload') is True and after.get('identityBeforeWorkload') is False and
        before.get('browserPid')==after.get('browserPid') and before.get('processCreationTime')==after.get('processCreationTime') and
        (not r4 or (before.get('parentPid')==after.get('parentPid') and before.get('parentCreationTime')==after.get('parentCreationTime') and
            before.get('ancestryValidated') is True and after.get('ancestryValidated') is True)) and
        receipt.get('closed',{}).get('closedHashVerified') is True,prefix+'BROWSER_LIFETIME_UNPROVEN')
    for row in (before,after):
        require(row.get('status')=='PASS' and row.get('expectedSha256')==row.get('observedSha256')==identity['executableSha256'] and
            row.get('expectedExecutable')==row.get('observedExecutable')==identity['executablePath'] and
            row.get('launchArgsValidated') is True and row.get('chromiumVersion')==identity['chromiumVersion'] and row.get('architecture')==identity['architecture'] and
            (not r4 or (row.get('browserMode')=='headless-shell' and row.get('fixedDefaultsValidated') is True and
                row.get('experimentalArgumentsValidated') is True and row.get('profileDirectoryValidated') is True and row.get('nativeFlagsValidated') is native and
                row.get('imageHashBoundByLease') is True)),
            prefix+'BROWSER_RECEIPT_INVALID')

def validate_process_audit_receipt(receipt,process_samples=()):
    keys={'status','method','registeredProcessCount','closedProcessCount','timedOutProcessCount','waitFailedProcessCount',
        'reusedPidCount','deadlineMs','elapsedMs','closedHashVerified','processes'}
    require(isinstance(receipt,dict) and set(receipt)==keys and isinstance(receipt['processes'],list) and receipt['status']=='PASS' and
        receipt['method']=='retained-win32-process-handles' and receipt['closedHashVerified'] is True and
        type(receipt['deadlineMs']) is int and receipt['deadlineMs']==10000 and type(receipt['elapsedMs']) is int and 0<=receipt['elapsedMs']<=10000 and
        all(type(receipt[k]) is int and receipt[k]>=0 for k in ('registeredProcessCount','closedProcessCount',
            'timedOutProcessCount','waitFailedProcessCount','reusedPidCount')) and
        receipt['registeredProcessCount']==receipt['closedProcessCount']==len(receipt['processes']) and
        receipt['registeredProcessCount']>0 and receipt['timedOutProcessCount']==receipt['waitFailedProcessCount']==0 and
        receipt['reusedPidCount']<=receipt['registeredProcessCount'],
        campaign_prefix()+'PROCESS_AUDIT_RECEIPT_INVALID')
    require(isinstance(process_samples,(list,tuple)) and len(process_samples)>0,campaign_prefix()+'PROCESS_AUDIT_RAW_SAMPLES_MISSING')
    identities=set();observed=set()
    for row in receipt['processes']:
        require(isinstance(row,dict) and set(row)=={'pid','creationTime','roles'} and type(row['pid']) is int and row['pid']>0 and
            type(row['creationTime']) is int and row['creationTime']>0 and isinstance(row['roles'],list) and row['roles'] and
            all(isinstance(role,str) and role and role.replace('_','').replace('-','').replace('.','').isalnum() for role in row['roles']) and
            row['roles']==sorted(set(row['roles'])),
            campaign_prefix()+'PROCESS_AUDIT_RECEIPT_INVALID')
        identity=(row['pid'],row['creationTime']);require(identity not in identities,campaign_prefix()+'PROCESS_AUDIT_RECEIPT_INVALID')
        identities.add(identity);observed.add((row['pid'],frozenset(row['roles'])))
    for sample in process_samples:
        processes=sample.get('processes',sample.get('processMemory',{}).get('processes',()))
        require(isinstance(processes,(list,tuple)) and len(processes)>0,campaign_prefix()+'PROCESS_AUDIT_RAW_SAMPLES_MISSING')
        for row in processes:
            require(any(pid==row.get('pid') and row.get('type') in roles for pid,roles in observed),
                campaign_prefix()+'PROCESS_AUDIT_RAW_PID_UNCOVERED')
    return True
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
        if CAMPAIGN in ('AP-06-R12-R3-factorial','AP-06-R12-R4-factorial','AP-06-R12-R5-factorial','AP-06-R12-R6-factorial','AP-06-R12-R7-factorial','AP-06-R12-R8-factorial','AP-06-R12-R9-factorial','AP-06-R12-R10-factorial'):
            validate_browser_receipt(run,freeze['browserIdentity'],process_samples=run.get('samples',()))
            require(run['browserIdentity']['before']['browserPid']==next(p['pid'] for p in run['samples'][0]['processMemory']['processes'] if p['type']=='browser'),
                campaign_prefix()+'BROWSER_SAMPLE_PID_MISMATCH')
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
        budget.get('measurementRetries')==0 and type(previous) is int and 0<=previous<10 and type(requested) is int and requested==1 and
        (CAMPAIGN not in ('AP-06-R12-R6-factorial','AP-06-R12-R7-factorial','AP-06-R12-R8-factorial','AP-06-R12-R9-factorial','AP-06-R12-R10-factorial') or (budget.get('globalMaximum')==14 and budget.get('triageMaximum')==4 and
            budget.get('formalMaximum')==6 and budget.get('nativeCapabilityMaximum')==1 and budget.get('nativeMeasurementMaximum')==2)),
        campaign_prefix()+'BROWSER_BUDGET_EXCEEDED')

def environment(wave,directory,condition,stage='triage',freeze=None):
    env,assets=runtime_environment(wave,directory,condition,stage,freeze,output=OUTPUT,publisher=PUBLISHER)
    env.update(AP06_R11_KEYS=str(wave.root/'tools/quality/ap06_r11_keys.py'),AP06_R11_AUTHORITY=str(wave.output/'baseline/authority-config.local.json'),
        AP06_R12R2_ATTEMPT=stage+'-'+directory.name)
    if CAMPAIGN.endswith(('R9-factorial','R10-factorial')):env.pop('AP06_R9_PRIVATE_KEYS',None)
    if CAMPAIGN in ('AP-06-R12-R3-factorial','AP-06-R12-R4-factorial','AP-06-R12-R5-factorial','AP-06-R12-R6-factorial','AP-06-R12-R7-factorial','AP-06-R12-R8-factorial','AP-06-R12-R9-factorial','AP-06-R12-R10-factorial'):
        env['AP06_BROWSER_IDENTITY']=str(wave.output/'baseline/browser-identity.json')
    if CAMPAIGN in ('AP-06-R12-R5-factorial','AP-06-R12-R6-factorial','AP-06-R12-R7-factorial','AP-06-R12-R8-factorial','AP-06-R12-R9-factorial','AP-06-R12-R10-factorial'):env['AP06_R5_PROCESS_HANDLE_AUDIT']='1'
    if CAMPAIGN in ('AP-06-R12-R4-factorial','AP-06-R12-R5-factorial','AP-06-R12-R6-factorial','AP-06-R12-R7-factorial','AP-06-R12-R8-factorial','AP-06-R12-R9-factorial','AP-06-R12-R10-factorial'):
        profile_root=checked_path((wave.output/'tooling/browser-temp').absolute());create=not profile_root.exists();profile_root.mkdir(exist_ok=True);private_permissions(profile_root,create=create)
        env.update(AP06_BROWSER_TEMP_ROOT=str(profile_root),TEMP=str(profile_root),TMP=str(profile_root))
    return env,assets

def verify_campaign_freeze(wave,frozen):
    verify_r11_freeze(wave,frozen)
    if CAMPAIGN in ('AP-06-R12-R8-factorial','AP-06-R12-R9-factorial','AP-06-R12-R10-factorial'):
        current_authority_validator()(wave,frozen.get('protocol'))
        validate_r8_corpus(wave)
    if CAMPAIGN in ('AP-06-R12-R6-factorial','AP-06-R12-R7-factorial'):
        (validate_r7_authority if CAMPAIGN.endswith('R7-factorial') else validate_r6_authority)(wave,frozen.get('protocol'))
        validate_r6_corpus(wave)
    if CAMPAIGN in ('AP-06-R12-R4-factorial','AP-06-R12-R5-factorial','AP-06-R12-R6-factorial','AP-06-R12-R7-factorial','AP-06-R12-R8-factorial','AP-06-R12-R9-factorial','AP-06-R12-R10-factorial'):
        from ap06_browser_identity import verify_identity
        identity=read(wave.output/'baseline/browser-identity.json')
        prefix=campaign_prefix().removesuffix('_')
        require(frozen.get('browserIdentity')==identity,prefix+'_BROWSER_FREEZE_CHANGED')
        verify_identity(identity)

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
    if CAMPAIGN in ('AP-06-R12-R8-factorial','AP-06-R12-R9-factorial','AP-06-R12-R10-factorial'):
        return unit_browser_r8(wave)
    if CAMPAIGN in ('AP-06-R12-R6-factorial','AP-06-R12-R7-factorial'):
        (validate_r7_authority if CAMPAIGN.endswith('R7-factorial') else validate_r6_authority)(wave)
        validate_r6_corpus(wave)
    checks=read(wave.output/'baseline/prechecks.json')
    require(not wave.git('status','--porcelain').strip() and all(checks.get(k)=='PASS' for k in ('status','secretScan','angularBuild','typescript','syntax','diff')),'R12R2_PRECHECKS_REQUIRED')
    if CAMPAIGN in ('AP-06-R12-R3-factorial','AP-06-R12-R4-factorial','AP-06-R12-R5-factorial','AP-06-R12-R6-factorial','AP-06-R12-R7-factorial'):
        ci=read(wave.output/'baseline/ci.json')
        require(ci['headSha']==wave.git('rev-parse','HEAD').strip() and ci['conclusion']=='success' and len(ci['jobs'])==3 and
            all(job['conclusion']=='success' for job in ci['jobs']),campaign_prefix()+'CI_REQUIRED')
    reservation=wave.output/'pipeline/development-reservation.json'
    with reservation.open('x') as stream:json.dump({'campaign':CAMPAIGN,'head':wave.git('rev-parse','HEAD'),'maximum':1,'retries':0},stream)
    publish(wave,'development-reserved',{'evidence/development-reservation.json':reservation})
    env,assets=environment(wave,wave.output/'tooling','r12r2.0');target=wave.output/'tooling/angular-unit-1.json';env['AP06_R7_UNIT_OUTPUT']=str(target)
    with media_server(media_files(wave),True,'application/octet-stream',assets,port=42088) as (origin,stats):
        env['AP06_R5_MEDIA_ORIGIN']=origin
        try:wave.command('r12r2-preflight',[wave.node,'tools/ap06-r12-r2-preflight.mjs'],wave.root/'frontend',env)
        finally:
            if target.exists():publish(wave,'preflight-complete',{'evidence/preflight.raw.json':target})
            wave.save('pipeline/preflight-transport.json',stats)
    unit=read(target);require(unit['status']=='PASS' and unit['unitBrowserLaunchAttempts']==unit['unitBrowserLaunches']==1 and unit['browserClosed'] and unit['processExitAudit']['status']=='PASS','R12R2_PREFLIGHT_FAILED')
    if CAMPAIGN in ('AP-06-R12-R3-factorial','AP-06-R12-R4-factorial','AP-06-R12-R5-factorial','AP-06-R12-R6-factorial','AP-06-R12-R7-factorial'):
        samples=[sample for case in unit['cases'] for sample in case.get('processSamples',())]
        validate_browser_receipt(unit,read(wave.output/'baseline/browser-identity.json'),process_samples=samples)
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
    if CAMPAIGN in ('AP-06-R12-R8-factorial','AP-06-R12-R9-factorial','AP-06-R12-R10-factorial'):
        current_authority_validator()(wave);validate_r8_corpus(wave)
    elif CAMPAIGN in ('AP-06-R12-R6-factorial','AP-06-R12-R7-factorial'):
        (validate_r7_authority if CAMPAIGN.endswith('R7-factorial') else validate_r6_authority)(wave)
        validate_r6_corpus(wave)
    identity_files=()
    if CAMPAIGN in ('AP-06-R12-R3-factorial','AP-06-R12-R4-factorial','AP-06-R12-R5-factorial','AP-06-R12-R6-factorial','AP-06-R12-R7-factorial','AP-06-R12-R8-factorial','AP-06-R12-R9-factorial','AP-06-R12-R10-factorial'):
        from ap06_browser_identity import verify_identity
        identity=read(wave.output/'baseline/browser-identity.json');verify_identity(identity)
        validate_browser_receipt(read(wave.output/'tooling/angular-unit-1.json'),identity)
        ci=read(wave.output/'baseline/ci.json');require(ci['headSha']==wave.git('rev-parse','HEAD').strip() and ci['conclusion']=='success',
            campaign_prefix()+'CI_REQUIRED')
        identity_files=('baseline/browser-identity.json','baseline/browser-identity-publication.json')
    freeze_implementation(wave,output=OUTPUT,harness='frontend/tools/ap06-r12-r2-probe.mjs',runner_path=PUBLISHER,
        extra_publications=('custody',wave.output.name.replace('readiness-wave','r')+'-browser-identity') if CAMPAIGN in ('AP-06-R12-R8-factorial','AP-06-R12-R9-factorial','AP-06-R12-R10-factorial') else ('custody',),
        extra_files=('baseline/prechecks.json','baseline/preregistered-protocol.json','baseline/custody-readback.json','baseline/backend-isolation.json',
            *(('baseline/task-provenance.json','baseline/corpus-provenance.json','tooling/app-products.json','pipeline/preflight-started.json') if CAMPAIGN in ('AP-06-R12-R8-factorial','AP-06-R12-R9-factorial','AP-06-R12-R10-factorial') else
                ('baseline/task-provenance.json','baseline/corpus-provenance.json') if CAMPAIGN in ('AP-06-R12-R6-factorial','AP-06-R12-R7-factorial') else ()),
            'baseline/experimental-backend.json','baseline/ci.json',*(('baseline/quality-baseline-ci.json','baseline/dependency-audit.json',
                'baseline/native-binary-reuse.json','baseline/native-tests-summary.json','baseline/global-quality-r8.json',
                'baseline/secret-scan-receipt.json','baseline/secret-scan.json') if CAMPAIGN in ('AP-06-R12-R8-factorial','AP-06-R12-R9-factorial','AP-06-R12-R10-factorial') else ()),
            'baseline/preflight-ready.json','baseline/prior-publications.json','pipeline/development-reservation.json',
            'tooling/backend-build/nanika_ap06_local_server.exe','tooling/backend-build/CMakeCache.txt','tooling/backend-build/compile_commands.json',
            'baseline/runtime-credentials.dpapi','baseline/runtime-credentials-custody.json',
            *(('baseline/runtime-credentials-readback.json','baseline/offline-ready.json','baseline/offline-integration.json','tooling/app/stats.json',
                'baseline/playwright-identity-preflight.json') if CAMPAIGN.endswith('R10-factorial') else
                ('baseline/runtime-credentials-readback.json','baseline/offline-ready.json','baseline/offline-integration.json','tooling/app/stats.json') if CAMPAIGN.endswith('R9-factorial') else ()),*identity_files),
        protocol={'campaign':CAMPAIGN,**({'browserIdentity':identity} if identity_files else {}),'protocol':read(wave.output/'baseline/preregistered-protocol.json'),
            'readiness':dict.fromkeys(('units','angularIntegration','build','preflight','integrity','secretScan'),'PASS')})
    if identity_files:verify_campaign_freeze(wave,read(wave.output/'tooling/freeze.json'))

def campaign_run(wave):
    require(not any((wave.output/p).exists() for p in ('pipeline/launch-ledger.json','pipeline/campaign-started.json','final/STOP.json')),'R12R2_NO_RETRY_OR_RESUME')
    frozen=read(wave.output/'tooling/freeze.json');verify_campaign_freeze(wave,frozen)
    with (wave.output/'pipeline/campaign-started.json').open('x') as stream:json.dump({'head':frozen['implementationHead'],'retries':0},stream)
    ledger=[];results=[];values={}
    def one(condition,stage):
        result=measure(wave,condition,stage,frozen,ledger,requested=1,directory_name=f'{len(ledger)+1:02}-{condition}',budget_fn=check_budget,
            verify_fn=verify_campaign_freeze,environment_fn=environment,validate_fn=validate_condition,probe='tools/ap06-r12-r2-probe.mjs')
        result['rendererPrivateDeltaMiB']=renderer_delta(read(wave.output/result['rawPath']));results.append(result);wave.save('pipeline/results.json',results);return result
    for condition in CONDITIONS:values[condition]=one(condition,'triage')['rendererPrivateDeltaMiB']
    decision=classify(wave,values);wave.save('pipeline/triage-decision.json',campaign_decision(decision));publish(wave,'triage-decision',{'evidence/triage-decision.json':wave.output/'pipeline/triage-decision.json'})
    if decision['status']=='R12R2_CANDIDATE':
        a,b=decision['pair'];formal=[one(c,'formal') for c in (a,b,b,a,a,b)];decision=classify(wave,values,formal,decision)
    wave.save('final/decision.json',dict(campaign_decision(decision),results=results,triageValues=values,chromiumMeasurement=len(ledger),retries=0,ap06='OPEN'))
    publish(wave,'campaign-decision',{'evidence/campaign-decision.json':wave.output/'final/decision.json'})

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for action in ('unit-browser','freeze','run','verify-freeze','offline-ready'):parser.add_argument('--'+action,action='store_true')
    parser.add_argument('--publish-raw',type=Path);parser.add_argument('--snapshot');parser.add_argument('--validate-processes',type=Path);parser.add_argument('--condition',choices=CONDITIONS)
    args=parser.parse_args();wave=Wave(Path(__file__).resolve().parents[2]);wave.output=wave.root/OUTPUT
    with tempfile.TemporaryDirectory(prefix='ap06-r12r2-') as tmp:
        wave.temp=Path(tmp)
        try:
            if CAMPAIGN in ('AP-06-R12-R8-factorial','AP-06-R12-R9-factorial','AP-06-R12-R10-factorial'):
                stop_path=wave.output/'final/STOP.json';reservation=wave.output/'pipeline/development-reservation.json'
                started=wave.output/'pipeline/preflight-started.json';ready=wave.output/'baseline/preflight-ready.json'
                terminal=stop_path.exists() or (args.unit_browser and (reservation.exists() or started.exists())) or (
                    args.run and reservation.exists() and (not ready.is_file() or read(ready).get('status')!='PASS'))
                if terminal:
                    if stop_path.is_file():
                        print(json.dumps({'status':campaign_prefix()+'STOP','reason':campaign_prefix()+'NO_RETRY_OR_RESUME',
                            'reservationCreated':reservation.exists()}));return 1
                    raw=wave.output/'tooling/angular-unit-1.json';receipt=read(raw) if raw.is_file() else {}
                    stop={'status':campaign_prefix()+'STOP','reason':campaign_prefix()+'NO_RETRY_OR_RESUME','failureStage':'retry-guard',
                        'failureClass':campaign_prefix()+'NO_RETRY_OR_RESUME','reservationCreated':reservation.exists(),
                        'launchAttempts':receipt.get('unitBrowserLaunchAttempts',0),'browserLaunches':receipt.get('unitBrowserLaunches',0),
                        'cleanupStatus':receipt.get('browserIdentity',{}).get('cleanupStatus','NOT_REQUIRED'),'retries':0}
                    wave.save('final/STOP.json',stop)
                    publish(wave,'stop-retry-guard',{'evidence/STOP-retry-guard.json':stop_path})
                    print(json.dumps(stop));return 1
            if CAMPAIGN in ('AP-06-R12-R3-factorial','AP-06-R12-R4-factorial','AP-06-R12-R5-factorial','AP-06-R12-R6-factorial','AP-06-R12-R7-factorial') and (args.unit_browser or args.freeze or args.run) and (wave.output/'final/STOP.json').exists():
                prefix=campaign_prefix().removesuffix('_')
                print(json.dumps({'status':prefix+'_STOP','reason':prefix+'_NO_RETRY_OR_RESUME'}));return 1
            if args.validate_processes:
                path=checked_path(args.validate_processes.absolute());require(path.is_relative_to(wave.output),'R12R2_PREFLIGHT_PATH_INVALID')
                samples=next(c for c in read(path)['cases'] if c['condition']==args.condition)['processSamples'];validate_process_lifecycle(samples,'r11.2')
                for sample in samples:validate_memory(sample,samples[0])
                print(json.dumps({'status':'PASS','samples':len(samples)}))
            elif args.offline_ready:prepare_scientific_preflight(wave)
            elif args.unit_browser:unit_browser(wave)
            elif args.freeze:freeze(wave)
            elif args.run:campaign_run(wave)
            elif args.verify_freeze:verify_campaign_freeze(wave,read(wave.output/'tooling/freeze.json'))
            elif args.publish_raw:
                path=checked_path(args.publish_raw.absolute());require(path.is_relative_to(wave.output) and re.fullmatch(r'(triage|formal)-\d{2}-r12r2\.[0-3]',args.snapshot or ''),'R12R2_RAW_PATH_INVALID')
                publish(wave,'raw-'+args.snapshot,{f'evidence/raws/{args.snapshot}.json':path})
            else:parser.error('action required')
        except R8PreflightFailure as error:
            stop={'status':campaign_prefix()+'STOP','reason':error.failure_class,'failureStage':error.stage,'failureClass':error.failure_class,'primaryFailureClass':error.failure_class,
                'reservationCreated':error.reservation_created,'launchAttempts':error.launch_attempts,
                'browserLaunches':error.browser_launches,'cleanupStatus':error.cleanup_status,'retries':0}
            if error.cleanup_failure_class:stop['cleanupFailureClass']=error.cleanup_failure_class
            secondary=getattr(error,'secondary_failure_class',None)
            if isinstance(secondary,str) and re.fullmatch(r'[A-Z][A-Z0-9_]+',secondary):stop['secondaryFailureClass']=secondary
            if args.offline_ready:
                wave.save('baseline/offline-ready.json',stop);print(json.dumps(stop));return 1
            wave.save('final/STOP.json',stop)
            publish(wave,'stop-'+error.stage,{'evidence/STOP-'+error.stage+'.json':wave.output/'final/STOP.json'})
            print(json.dumps(stop));return 1
        except (WaveFailure,ValueError,OSError,subprocess.SubprocessError,KeyError,TypeError,IndexError) as error:
            reason=str(error) if re.fullmatch(r'[A-Z][A-Z0-9_:]+',str(error)) else 'R12R2_EXECUTION_FAILED'
            phase='preflight' if args.unit_browser else 'campaign'
            if CAMPAIGN in ('AP-06-R12-R8-factorial','AP-06-R12-R9-factorial','AP-06-R12-R10-factorial'):
                raw=wave.output/'tooling/angular-unit-1.json';receipt=read(raw) if raw.is_file() else {}
                reservation=(wave.output/'pipeline/development-reservation.json').exists()
                stop={'status':campaign_prefix()+'STOP','reason':reason,'failureStage':phase,'failureClass':reason,
                    'reservationCreated':reservation,'launchAttempts':receipt.get('unitBrowserLaunchAttempts',0),
                    'browserLaunches':receipt.get('unitBrowserLaunches',0),
                    'cleanupStatus':receipt.get('browserIdentity',{}).get('cleanupStatus','NOT_REQUIRED'),'retries':0}
            else:stop=campaign_decision({'status':'R12R2_STOP','reason':reason,'ap06':'OPEN'})
            if args.offline_ready:
                wave.save('baseline/offline-ready.json',stop);print(json.dumps(stop));return 1
            wave.save('final/STOP.json',stop)
            publish(wave,'stop-'+phase,{'evidence/STOP-'+phase+'.json':wave.output/'final/STOP.json'});print(json.dumps(stop));return 1
    return 0

if __name__=='__main__':raise SystemExit(main())
