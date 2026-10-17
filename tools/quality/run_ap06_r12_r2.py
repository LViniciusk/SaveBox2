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
from ap06_authorities import checked_path,private_permissions,sha256

OUTPUT='.quality/readiness-wave12-r2-factorial'
CAMPAIGN='AP-06-R12-R2-factorial'
PUBLISHER=Path(__file__).resolve()

def configure_campaign(output,publisher,campaign):
    global OUTPUT,PUBLISHER,CAMPAIGN
    require((output,campaign) in (('.quality/readiness-wave12-r3-factorial','AP-06-R12-R3-factorial'),
        ('.quality/readiness-wave12-r4-factorial','AP-06-R12-R4-factorial'),
        ('.quality/readiness-wave12-r5-factorial','AP-06-R12-R5-factorial'),
        ('.quality/readiness-wave12-r6-factorial','AP-06-R12-R6-factorial')),'R12R3_CAMPAIGN_INVALID')
    OUTPUT,PUBLISHER,CAMPAIGN=output,Path(publisher).resolve(),campaign

def campaign_prefix():
    return {'AP-06-R12-R6-factorial':'R12R6_','AP-06-R12-R5-factorial':'R12R5_',
        'AP-06-R12-R4-factorial':'R12R4_','AP-06-R12-R3-factorial':'R12R3_'}.get(CAMPAIGN,'R12R2_')

def campaign_decision(value):
    prefix=campaign_prefix()
    if prefix!='R12R2_':return dict(value,status=value['status'].replace('R12R2_',prefix))
    return value

def validate_r6_authority(wave, frozen_protocol=None):
    task=wave.root/'quality/prompt.md';private_task=wave.output/'baseline/task.md'
    provenance=read(wave.output/'baseline/task-provenance.json');protocol=read(wave.output/'baseline/preregistered-protocol.json')
    require(task.is_file() and private_task.is_file(),'R12R6_TASK_AUTHORITY_MISSING')
    content=task.read_bytes();digest=sha256(task)
    require(content and content==private_task.read_bytes() and digest==provenance.get('sourceSha256')==protocol.get('authoritySha256') and
        task.stat().st_size==provenance.get('sourceBytes')==protocol.get('authorityBytes'),'R12R6_TASK_AUTHORITY_HASH_MISMATCH')
    text=content.decode('utf-8')
    required=('AP-06 R12-R6','25.559.136','393.216','25.165.920','HTTP 206','127.0.0.2','127.0.0.3',
        'Máximo: 14 Chromium. Zero retries.','A, B, B, A, A, B','≥300 MiB','150 MiB','MemoryInfra','120 segundos')
    require(all(value in text for value in required),'R12R6_TASK_SEMANTICS_MISSING')
    fields={'campaign','implementationHead','hypotheses','conditions','triageOrder','formalOrder','corpus','metrics','thresholds','order','budget',
        'httpContract','security','cleanup','stop','publication','nativeProfiling','authoritySha256','authorityBytes'}
    expected_conditions={key:CONDITIONS[key] for key in CONDITIONS}
    expected_order=[list(pair) for pair in PAIRS]
    expected_ranges=[[0,'bytes=0-131071'],[0,'bytes=114-4194433'],[0,'bytes=4194434-8388753'],
        [1,'bytes=0-131071'],[1,'bytes=117-4194436'],[1,'bytes=4194437-8388756'],
        [2,'bytes=0-131071'],[2,'bytes=114-4194433'],[2,'bytes=4194434-8388753']]
    require(isinstance(protocol,dict) and set(protocol)==fields and protocol['campaign']=='AP-06-R12-R6-factorial' and
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
        'R12R6_PROTOCOL_SCHEMA_INVALID')
    if frozen_protocol is not None:
        require(frozen_protocol==protocol,'R12R6_PROTOCOL_FREEZE_MISMATCH')
    return digest

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

def validate_browser_receipt(record,identity,native=False,process_samples=None):
    receipt=record.get('browserIdentity',{})
    r5=CAMPAIGN in ('AP-06-R12-R5-factorial','AP-06-R12-R6-factorial')
    r4=CAMPAIGN in ('AP-06-R12-R4-factorial','AP-06-R12-R5-factorial','AP-06-R12-R6-factorial');prefix=campaign_prefix()
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
        if CAMPAIGN in ('AP-06-R12-R3-factorial','AP-06-R12-R4-factorial','AP-06-R12-R5-factorial','AP-06-R12-R6-factorial'):
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
        (CAMPAIGN!='AP-06-R12-R6-factorial' or (budget.get('globalMaximum')==14 and budget.get('triageMaximum')==4 and
            budget.get('formalMaximum')==6 and budget.get('nativeCapabilityMaximum')==1 and budget.get('nativeMeasurementMaximum')==2)),
        campaign_prefix()+'BROWSER_BUDGET_EXCEEDED')

def environment(wave,directory,condition,stage='triage',freeze=None):
    env,assets=runtime_environment(wave,directory,condition,stage,freeze,output=OUTPUT,publisher=PUBLISHER)
    env.update(AP06_R11_KEYS=str(wave.root/'tools/quality/ap06_r11_keys.py'),AP06_R11_AUTHORITY=str(wave.output/'baseline/authority-config.local.json'),
        AP06_R12R2_ATTEMPT=stage+'-'+directory.name)
    if CAMPAIGN in ('AP-06-R12-R3-factorial','AP-06-R12-R4-factorial','AP-06-R12-R5-factorial','AP-06-R12-R6-factorial'):
        env['AP06_BROWSER_IDENTITY']=str(wave.output/'baseline/browser-identity.json')
    if CAMPAIGN in ('AP-06-R12-R5-factorial','AP-06-R12-R6-factorial'):env['AP06_R5_PROCESS_HANDLE_AUDIT']='1'
    if CAMPAIGN in ('AP-06-R12-R4-factorial','AP-06-R12-R5-factorial','AP-06-R12-R6-factorial'):
        profile_root=checked_path((wave.output/'tooling/browser-temp').absolute());create=not profile_root.exists();profile_root.mkdir(exist_ok=True);private_permissions(profile_root,create=create)
        env.update(AP06_BROWSER_TEMP_ROOT=str(profile_root),TEMP=str(profile_root),TMP=str(profile_root))
    return env,assets

def verify_campaign_freeze(wave,frozen):
    verify_r11_freeze(wave,frozen)
    if CAMPAIGN=='AP-06-R12-R6-factorial':
        validate_r6_authority(wave,frozen.get('protocol'))
        validate_r6_corpus(wave)
    if CAMPAIGN in ('AP-06-R12-R4-factorial','AP-06-R12-R5-factorial','AP-06-R12-R6-factorial'):
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
    if CAMPAIGN=='AP-06-R12-R6-factorial':
        validate_r6_authority(wave)
        validate_r6_corpus(wave)
    checks=read(wave.output/'baseline/prechecks.json')
    require(not wave.git('status','--porcelain').strip() and all(checks.get(k)=='PASS' for k in ('status','secretScan','angularBuild','typescript','syntax','diff')),'R12R2_PRECHECKS_REQUIRED')
    if CAMPAIGN in ('AP-06-R12-R3-factorial','AP-06-R12-R4-factorial','AP-06-R12-R5-factorial','AP-06-R12-R6-factorial'):
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
    if CAMPAIGN in ('AP-06-R12-R3-factorial','AP-06-R12-R4-factorial','AP-06-R12-R5-factorial','AP-06-R12-R6-factorial'):
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
    if CAMPAIGN=='AP-06-R12-R6-factorial':
        validate_r6_authority(wave)
        validate_r6_corpus(wave)
    identity_files=()
    if CAMPAIGN in ('AP-06-R12-R3-factorial','AP-06-R12-R4-factorial','AP-06-R12-R5-factorial','AP-06-R12-R6-factorial'):
        from ap06_browser_identity import verify_identity
        identity=read(wave.output/'baseline/browser-identity.json');verify_identity(identity)
        validate_browser_receipt(read(wave.output/'tooling/angular-unit-1.json'),identity)
        ci=read(wave.output/'baseline/ci.json');require(ci['headSha']==wave.git('rev-parse','HEAD').strip() and ci['conclusion']=='success',
            campaign_prefix()+'CI_REQUIRED')
        identity_files=('baseline/browser-identity.json','baseline/browser-identity-publication.json')
    freeze_implementation(wave,output=OUTPUT,harness='frontend/tools/ap06-r12-r2-probe.mjs',runner_path=PUBLISHER,extra_publications=('custody',),
        extra_files=('baseline/prechecks.json','baseline/preregistered-protocol.json','baseline/custody-readback.json','baseline/backend-isolation.json',
            *(('baseline/task-provenance.json','baseline/corpus-provenance.json') if CAMPAIGN=='AP-06-R12-R6-factorial' else ()),
            'baseline/experimental-backend.json','baseline/ci.json','baseline/preflight-ready.json','baseline/prior-publications.json','pipeline/development-reservation.json',
            'tooling/backend-build/nanika_ap06_local_server.exe','tooling/backend-build/CMakeCache.txt','tooling/backend-build/compile_commands.json',
            'baseline/runtime-credentials.dpapi','baseline/runtime-credentials-custody.json',*identity_files),
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
    for action in ('unit-browser','freeze','run','verify-freeze'):parser.add_argument('--'+action,action='store_true')
    parser.add_argument('--publish-raw',type=Path);parser.add_argument('--snapshot');parser.add_argument('--validate-processes',type=Path);parser.add_argument('--condition',choices=CONDITIONS)
    args=parser.parse_args();wave=Wave(Path(__file__).resolve().parents[2]);wave.output=wave.root/OUTPUT
    with tempfile.TemporaryDirectory(prefix='ap06-r12r2-') as tmp:
        wave.temp=Path(tmp)
        try:
            if CAMPAIGN in ('AP-06-R12-R3-factorial','AP-06-R12-R4-factorial','AP-06-R12-R5-factorial','AP-06-R12-R6-factorial') and (args.unit_browser or args.freeze or args.run) and (wave.output/'final/STOP.json').exists():
                prefix=campaign_prefix().removesuffix('_')
                print(json.dumps({'status':prefix+'_STOP','reason':prefix+'_NO_RETRY_OR_RESUME'}));return 1
            if args.validate_processes:
                path=checked_path(args.validate_processes.absolute());require(path.is_relative_to(wave.output),'R12R2_PREFLIGHT_PATH_INVALID')
                samples=next(c for c in read(path)['cases'] if c['condition']==args.condition)['processSamples'];validate_process_lifecycle(samples,'r11.2')
                for sample in samples:validate_memory(sample,samples[0])
                print(json.dumps({'status':'PASS','samples':len(samples)}))
            elif args.unit_browser:unit_browser(wave)
            elif args.freeze:freeze(wave)
            elif args.run:campaign_run(wave)
            elif args.verify_freeze:verify_campaign_freeze(wave,read(wave.output/'tooling/freeze.json'))
            elif args.publish_raw:
                path=checked_path(args.publish_raw.absolute());require(path.is_relative_to(wave.output) and re.fullmatch(r'(triage|formal)-\d{2}-r12r2\.[0-3]',args.snapshot or ''),'R12R2_RAW_PATH_INVALID')
                publish(wave,'raw-'+args.snapshot,{f'evidence/raws/{args.snapshot}.json':path})
            else:parser.error('action required')
        except (WaveFailure,ValueError,OSError,subprocess.SubprocessError,KeyError,TypeError,IndexError) as error:
            reason=str(error) if re.fullmatch(r'[A-Z][A-Z0-9_:]+',str(error)) else 'R12R2_EXECUTION_FAILED'
            phase='preflight' if args.unit_browser else 'campaign';stop=campaign_decision({'status':'R12R2_STOP','reason':reason,'ap06':'OPEN'});wave.save('final/STOP.json',stop)
            publish(wave,'stop-'+phase,{'evidence/STOP-'+phase+'.json':wave.output/'final/STOP.json'});print(json.dumps(stop));return 1
    return 0

if __name__=='__main__':raise SystemExit(main())
