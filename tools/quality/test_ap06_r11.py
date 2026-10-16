import copy
import unittest
from run_ap06_r11 import check_budget, validate_memory, reserve_development
from run_ap06_r11 import validate_process_lifecycle, validate_condition, AUDIO_SERVICE
from run_ap06_r9 import verify_freeze
from ap06_authorities import sha256
from unittest.mock import patch
from types import SimpleNamespace
from pathlib import Path
import json
import tempfile


def timeline(audio=False):
    rows=[{'pid':i+1,'type':kind,'privateBytes':10} for i,kind in enumerate(('browser','renderer','GPU','network.mojom.NetworkService'))]
    if audio:rows.append({'pid':5,'type':AUDIO_SERVICE,'privateBytes':3})
    samples=[]
    for phase,cycle in [('baseline',0),('cycle-1-close',1),('cycle-2-close',2),('idle-30s',6),('forced-GC-final',6)]:
        samples.append({'phase':phase,'cycle':cycle,'processMemory':{'processes':copy.deepcopy(rows)}})
    return samples


def add_audio(samples,start=1):
    for sample in samples[start:]:sample['processMemory']['processes'].append({'pid':5,'type':AUDIO_SERVICE,'privateBytes':3})


def r11_complete_raw(condition="r11.0"):
    from test_ap06_r10 import r10_raw
    from test_run_ap06_transmux_probe import summary
    raw,freeze,fixtures=r10_raw("r10.0" if condition=="r11.0" else "r10.1")
    full=condition in ('r11.0','r11.1');workers=condition!='r11.2'
    growths=(20,1) if condition=='r11.0' else (1,400)
    raw['summary']=summary(*growths)
    raw.update(condition=condition,transport='xhr' if condition=='r11.0' else 'fetch',httpWorkloadEquivalent=True,
        cryptoWorkloadEquivalent=workers,transmuxWorkloadEquivalent=workers,mseWorkloadEquivalent=full,playbackFunctional=full,
        videoPlayerComponentUsed=full,videoStreamServiceUsed=workers)
    run=raw['runs'][0];run['runId']=f'triage-{int(condition[-1])+1:02}-{condition}'
    sequence=[[n,'bytes=0-3'] for n in range(3) for _ in range(3)]
    freeze['workload'].update(rangesPerCycle=sequence,bytesPerCycle=36,requestsPerCycle=9)
    rows=run['rangeNetwork']['requests']
    run['rangeNetwork']['requests']=[dict(rows[0],requestId=str(i),fixture=n,fileId=100+n,range=value) for i,(n,value) in enumerate(sequence*6)]
    run['backendTraffic']['rows']=[{'fileId':r['fileId'],'status':206} for r in run['rangeNetwork']['requests']]
    original=run['samples'];run['samples']=original[:7]+[copy.deepcopy(original[6]),copy.deepcopy(original[6]),original[7]]
    run['samples'][7]['phase']='post-teardown-settled';run['samples'][8]['phase']='idle-30s'
    raw['processSampleCalls']=len(run['samples'])
    for index,sample in enumerate(run['samples']):
        sample['timestamp']=f'2026-10-16T00:{index:02}:00Z'
        sample['counters']['r11']={'sessionsStarted':3*sample['cycle'],'sessionsCompleted':3*sample['cycle'],
            'sessionsFailed':0,'materializationsPending':0,'materializationsFailed':0,'workerProtocolFailures':0,
            'blobCount':9*sample['cycle'],'blobBytes':36*sample['cycle'],'arrayBufferCount':6*sample['cycle'],
            'arrayBufferBytes':24*sample['cycle'],'transferredBuffers':int(workers)*6*sample['cycle'],
            'detachedBuffers':int(workers)*6*sample['cycle'],'transferBytes':int(workers)*12345*sample['cycle'],
            'workerOutputBytes':int(workers)*123*sample['cycle'],'segmentBytes':int(workers)*12*sample['cycle']}
        c=sample['counters']['observed'];c.update(rangeRequestsStarted=9*sample['cycle'],rangeRequestsCompleted=9*sample['cycle'],
            rangeBytesReceived=36*sample['cycle'],http206Validated=9*sample['cycle'],jwtRangesValidated=9*sample['cycle'])
        memory=sample['processMemory']
        if not full:
            for key in ('mediaSourcesCreated','mediaSourcesClosed','sourceBuffersCreated','sourceBuffersReleased','bytesAppended','playbackStarted','playbackCompleted'):
                c[key]=0
        if not workers:
            for key in ('workersCreated','workersTerminated','workerTransferBytesSent','workerMessagesSent','workerMessagesReceived','detachedTransfers'):
                c[key]=0
        for kind,growth in zip(('browser','renderer'),growths):
            value=100*1048576+int(growth*1048576*sample['cycle']/6)
            memory['byCategory'][kind]['privateBytes']=value
            memory['processes'][0 if kind=='browser' else 1]['privateBytes']=value
        for row,kind in zip(memory['processes'],('browser','renderer','GPU','network.mojom.NetworkService')):row['type']=kind
        if index and full:memory['processes'].append({'pid':5,'type':AUDIO_SERVICE,'privateBytes':0})
        memory['byType']={r['type']:{'privateBytes':r['privateBytes']} for r in memory['processes']}
        memory['byCategory']['utility']['privateBytes']=sum(r['privateBytes'] for r in memory['processes'] if 'Service' in r['type'])
        memory['privateBytes']=sum(r['privateBytes'] for r in memory['processes'])
    run['processExitAudit']['ownedPids']=[1,2,3,4,5] if full else [1,2,3,4]
    if not workers:raw['network']['workerRequests']={}
    # The shared fixture gives a coherent positive browser ownership classification.
    natural=next(p for p in raw['summary']['phases'] if p['phase']=='cycle-6-close')
    for kind in ('browser','renderer'):
        before=run['samples'][0]['processMemory']['byCategory'][kind]['privateBytes']
        end=run['samples'][6]['processMemory']['byCategory'][kind]['privateBytes']
        natural['processTypes'][kind]['privateBytes']['signedDelta']=dict(min=end-before,median=end-before,max=end-before)
    return raw,freeze,fixtures


class R11LifecycleTests(unittest.TestCase):
    def test_expected_activation_and_baseline_audio(self):
        samples=timeline();add_audio(samples)
        for condition in ('r11.0','r11.1'):validate_process_lifecycle(samples,condition)
        for condition in ('r11.0','r11.1','r11.2','r11.3'):validate_process_lifecycle(timeline(True),condition)

    def test_lifecycle_failures_have_specific_reasons(self):
        cases=[]
        s=timeline();add_audio(s);s[-1]['processMemory']['processes'].pop();cases.append((s,'r11.0','R11_AUDIO_LIFECYCLE_CHANGED'))
        s=timeline();add_audio(s);s[2]['processMemory']['processes'][-1]['pid']=6;cases.append((s,'r11.0','R11_AUDIO_LIFECYCLE_CHANGED'))
        s=timeline();add_audio(s,2);cases.append((s,'r11.0','R11_AUDIO_LIFECYCLE_CHANGED'))
        for c in ('r11.2','r11.3'):
            s=timeline();add_audio(s);cases.append((s,c,'R11_UNEXPECTED_AUDIO_LIFECYCLE'))
        for index in range(4):
            s=timeline();s[1]['processMemory']['processes'][index]['pid']=99;cases.append((s,'r11.0','R11_PROCESS_IDENTITY_CHANGED'))
        s=timeline();s[1]['processMemory']['processes'][1]['type']='other';cases.append((s,'r11.0','R11_PROCESS_IDENTITY_CHANGED'))
        s=timeline();s[1]['processMemory']['processes'].append({'pid':9,'type':'unknown.Service','privateBytes':1});cases.append((s,'r11.0','R11_PROCESS_IDENTITY_CHANGED'))
        s=timeline(True);s[1]['processMemory']['processes'].append({'pid':6,'type':AUDIO_SERVICE,'privateBytes':1});cases.append((s,'r11.0','R11_MULTIPLE_AUDIO_SERVICES'))
        for pid in (0,-1,True,'5',1):
            s=timeline();s[1]['processMemory']['processes'].append({'pid':pid,'type':AUDIO_SERVICE,'privateBytes':1});cases.append((s,'r11.0','R11_INVALID_PROCESS_IDENTITY'))
        s=timeline();s[1]['phase']='cycle-2-close';cases.append((s,'r11.0','R11_INVALID_PROCESS_TIMELINE'))
        s=timeline();s[0]['processMemory']['processes'].pop();cases.append((s,'r11.0','R11_MISSING_CORE_PROCESS'))
        s=timeline();s[1]['processMemory']['processes'][0]['type']=None;cases.append((s,'r11.0','R11_INVALID_PROCESS_TYPE'))
        s=timeline(True);s[1]['processMemory']['processes'].pop();cases.append((s,'r11.0','R11_UNEXPECTED_AUDIO_LIFECYCLE'))
        for samples,condition,reason in cases:
            with self.subTest(reason=reason),self.assertRaisesRegex(ValueError,'^'+reason+'$'):validate_process_lifecycle(samples,condition)

    def test_complete_validation_path_with_audio_and_renderer_replacement(self):
        raw,freeze,fixtures=r11_complete_raw()
        self.assertEqual(validate_condition(raw,'r11.0','triage',freeze,fixtures),'TRANSMUX_MSE_REPRODUCES_BROWSER_PROCESS_OWNERSHIP')
        raw['runs'][0]['samples'][3]['processMemory']['processes'][1]['pid']=99
        with self.assertRaisesRegex(ValueError,'^R11_PROCESS_IDENTITY_CHANGED$'):validate_condition(raw,'r11.0','triage',freeze,fixtures)

    def test_numeric_totals_types_and_audio_utility(self):
        raw,_,_=r11_complete_raw();original=raw['runs'][0]['samples'][1]
        validate_memory(original,raw['runs'][0]['samples'][0])
        cases=[]
        for value in (float('nan'),float('inf'),-1):
            s=copy.deepcopy(original);s['processMemory']['processes'][0]['privateBytes']=value;cases.append((s,'R11_INVALID_PRIVATE_BYTES'))
        s=copy.deepcopy(original);s['processMemory']['privateBytes']+=1;cases.append((s,'R11_PROCESS_TOTAL_MISMATCH'))
        s=copy.deepcopy(original);s['processMemory']['processes'][-1]['privateBytes']=3;s['processMemory']['privateBytes']+=3
        # Keep category sums coherent but move AudioService memory to the wrong category.
        s['processMemory']['byCategory']['browser']['privateBytes']+=3;cases.append((s,'R11_CATEGORY_TOTAL_MISMATCH'))
        s=copy.deepcopy(original);s['processMemory']['byType'][AUDIO_SERVICE]['privateBytes']=3;cases.append((s,'R11_TYPE_TOTAL_MISMATCH'))
        for sample,reason in cases:
            with self.subTest(reason=reason),self.assertRaisesRegex(ValueError,'^'+reason+'$'):validate_memory(sample,original)

    def test_full_validator_rejects_attempt_order_before_measurement(self):
        raw,freeze,fixtures=r11_complete_raw();raw['runs'][0]['runId']='triage-02-r11.0'
        with self.assertRaisesRegex(RuntimeError,'^R11_ATTEMPT_IDENTITY_CHANGED$'):validate_condition(raw,'r11.0','triage',freeze,fixtures)

    def test_full_validator_requires_ten_actual_native_samples(self):
        raw,freeze,fixtures=r11_complete_raw()
        for calls in (8,9,11):
            raw['processSampleCalls']=calls
            with self.assertRaisesRegex(RuntimeError,'^R11_PROCESS_SAMPLE_COUNT_CHANGED$'):validate_condition(raw,'r11.0','triage',freeze,fixtures)


class R11Tests(unittest.TestCase):
    def test_budget(self):
        for previous in range(10): check_budget({'approved':True,'measurementMaximum':10,'measurementRetries':0},previous,1)
        for previous in (-1,10,True):
            with self.assertRaises(ValueError): check_budget({'approved':True,'measurementMaximum':10,'measurementRetries':0},previous,1)

    def test_memory_identity_signed_delta_and_totals(self):
        sample={'processMemory':{'status':'AVAILABLE','privateBytes':40,'byCategory':{k:{'privateBytes':10} for k in ('browser','renderer','gpu-process','utility')},
            'processes':[{'pid':i+1,'type':k,'privateBytes':10} for i,k in enumerate(('browser','renderer','GPU','Service'))]}}
        sample['processMemory']['byType']={r['type']:{'privateBytes':10} for r in sample['processMemory']['processes']}
        validate_memory(sample,sample)
        for change in ('duplicate','missing','nan','total','type'):
            bad=copy.deepcopy(sample)
            p=bad['processMemory']
            if change=='duplicate': p['processes'][0]['pid']=2
            if change=='missing': p['processes'].pop()
            if change=='nan': p['processes'][0]['privateBytes']=float('nan')
            if change=='total': p['privateBytes']=41
            if change=='type': p['processes'][0]['type']='renderer'
            reason={'duplicate':'R11_INVALID_PROCESS_IDENTITY','missing':'R11_PROCESS_TOTAL_MISMATCH','nan':'R11_INVALID_PRIVATE_BYTES',
                'total':'R11_PROCESS_TOTAL_MISMATCH','type':'R11_CATEGORY_TOTAL_MISMATCH'}[change]
            with self.assertRaisesRegex(ValueError,'^'+reason+'$'):validate_memory(bad,sample)

    def test_development_has_no_retry(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'reservation.json'
            reserve_development(path,'a'*40)
            with self.assertRaises(FileExistsError):reserve_development(path,'a'*40)

    def test_authority_head_hash_manifest_and_ownership_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);out=root/'out';(out/'baseline').mkdir(parents=True)
            (out/'baseline/authority-config.local.json').write_text(json.dumps({'AP06_AUTHORITY_ROOT':str(root/'authority'),'identity':'unit'}))
            source=root/'code.py';source.write_text('before')
            freeze={'files':{'code.py':sha256(source)},'publicationHashes':{},'implementationHead':'head'}
            wave=SimpleNamespace(root=root,output=out,git=lambda *args:'head')
            with patch('run_ap06_r9.verify_publication') as publication:
                verify_freeze(wave,freeze)
                source.write_text('changed')
                with self.assertRaisesRegex(RuntimeError,'FROZEN_FILE_CHANGED'):verify_freeze(wave,freeze)
                source.write_text('before');wave.git=lambda *args:'other'
                with self.assertRaisesRegex(RuntimeError,'HEAD_CHANGED'):verify_freeze(wave,freeze)
                wave.git=lambda *args:'head'
                for failure in (ValueError('AUTHORITY_OWNERSHIP_MISMATCH'),FileNotFoundError('manifest')):
                    publication.side_effect=failure
                    with self.assertRaisesRegex(RuntimeError,'READBACK_FAILED'):verify_freeze(wave,freeze)



class R11R3ContractTests(unittest.TestCase):
    def test_projection_is_pure_and_has_eight_samples(self):
        import run_ap06_r11 as r11
        for condition,alias in [('r11.0','r10.0'),('r11.1','r10.1')]:
            raw,_,_=r11_complete_raw(condition);before=json.dumps(raw,sort_keys=True)
            projected=r11.project_r11_to_r10(raw,alias)
            self.assertEqual(json.dumps(raw,sort_keys=True),before)
            self.assertEqual(projected['processSampleCalls'],8)
            self.assertEqual(len(projected['runs'][0]['samples']),8)
            projected['runs'][0]['samples'][0]['phase']='modified'
            self.assertEqual(json.dumps(raw,sort_keys=True),before)
        for alias in ('r10.2','r11.0',None):
            with self.assertRaisesRegex(ValueError,'R11_INVALID_R10_ALIAS'):r11.project_r11_to_r10(raw,alias)
        raw['runs'][0]['samples'].pop()
        with self.assertRaisesRegex(ValueError,'R11_R10_PROJECTION_INVALID'):r11.project_r11_to_r10(raw,'r10.1')

    def test_complete_validator_all_four_arms_and_formal_projection(self):
        for condition in ('r11.0','r11.1','r11.2','r11.3'):
            raw,freeze,fixtures=r11_complete_raw(condition)
            before=json.dumps(raw,sort_keys=True)
            self.assertIsInstance(validate_condition(raw,condition,'triage',freeze,fixtures),str)
            self.assertEqual(json.dumps(raw,sort_keys=True),before)
            for index in (5,6,7,8,9,10):
                raw['stage']='formal';raw['runs'][0]['runId']=f'formal-{index:02}-{condition}'
                self.assertIsInstance(validate_condition(raw,condition,'formal',freeze,fixtures),str)

    def test_checkpoint_count_and_gc_idle_contract(self):
        for count in (8,9,11):
            raw,freeze,fixtures=r11_complete_raw();samples=raw['runs'][0]['samples']
            samples[:]=samples[:count] if count<10 else samples+[copy.deepcopy(samples[-1])]
            raw['processSampleCalls']=count
            with self.assertRaisesRegex(RuntimeError,'R11_PROCESS_SAMPLE_COUNT_CHANGED'):validate_condition(raw,'r11.0','triage',freeze,fixtures)
        for change in (lambda s:s[2].update(gc='forced-diagnostic'),lambda s:s[8].update(timestamp=s[7]['timestamp']),lambda s:s[5].update(cycle=4)):
            raw,freeze,fixtures=r11_complete_raw();change(raw['runs'][0]['samples'])
            with self.assertRaises((ValueError,RuntimeError)):validate_condition(raw,'r11.0','triage',freeze,fixtures)

    def test_integrated_negative_contracts_in_every_arm(self):
        changes=[lambda r:r.update(fixtureManifestSha256='changed'),lambda r:r.update(cryptoWorkerBundleSha256='changed'),
            lambda r:r['runs'][0]['samples'][1].update(sourceHash='changed'),
            lambda r:r['runs'][0]['rangeNetwork']['requests'][0].update(type='Other'),
            lambda r:r['runs'][0]['rangeNetwork']['requests'][0].update(status=200),
            lambda r:r['runs'][0]['rangeNetwork']['requests'][0].update(range='bytes=1-3'),
            lambda r:r['runs'][0]['rangeNetwork']['requests'][0]['headers'].update({'content-length':'3'}),
            lambda r:r['runs'][0]['samples'][1]['counters']['observed'].update(jwtRangesValidated=0),
            lambda r:r['runs'][0]['samples'][1]['counters']['observed'].update(http206Validated=0),
            lambda r:r['runs'][0]['samples'][1]['counters']['observed'].update(rangeBytesReceived=0),
            lambda r:r['runs'][0]['samples'][1]['ownership'].update(pendingFetches=1),
            lambda r:r['runs'][0]['processExitAudit'].update(ownedPids=[999]),
            lambda r:r['runs'][0]['samples'][1]['counters']['r11'].update(sessionsFailed=1),
            lambda r:r['runs'][0]['samples'][1]['counters']['r11'].update(arrayBufferCount=0)]
        for condition in ('r11.0','r11.1','r11.2','r11.3'):
            for index,change in enumerate(changes):
                raw,freeze,fixtures=r11_complete_raw(condition);change(raw)
                with self.subTest(condition=condition,change=index),self.assertRaises((ValueError,RuntimeError)):
                    validate_condition(raw,condition,'triage',freeze,fixtures)

    def test_partial_stage_guards(self):
        for condition in ('r11.2','r11.3'):
            for key in ('mediaSourcesCreated','bytesAppended','workersCreated') if condition=='r11.2' else ('mediaSourcesCreated','bytesAppended','workerTransferBytesSent'):
                raw,freeze,fixtures=r11_complete_raw(condition)
                raw['runs'][0]['samples'][1]['counters']['observed'][key]=1
                with self.subTest(condition=condition,key=key),self.assertRaises(RuntimeError):validate_condition(raw,condition,'triage',freeze,fixtures)

    def test_missing_memory_and_unclassified_contract_are_distinct(self):
        raw,freeze,fixtures=r11_complete_raw();del raw['runs'][0]['samples'][1]['processMemory']
        with self.assertRaisesRegex((ValueError,RuntimeError),'R11_PROCESS_UNAVAILABLE'):validate_condition(raw,'r11.0','triage',freeze,fixtures)
        raw,freeze,fixtures=r11_complete_raw();del raw['runs'][0]['rangeNetwork']
        with self.assertRaisesRegex(RuntimeError,'R11_VALIDATION_CONTRACT_FAILED'):validate_condition(raw,'r11.0','triage',freeze,fixtures)

    def test_preflight_rejects_outside_authority_paths_without_reading_them(self):
        import run_ap06_r11 as r11
        root=Path(__file__).resolve().parents[2]
        for path in (root/'outside.json',root/r11.OUTPUT/'../outside.json'):
            with patch('sys.argv',['runner','--validate-processes',str(path),'--condition','r11.0']):
                with self.assertRaisesRegex(ValueError,'R11_PREFLIGHT_PATH_INVALID|AUTHORITY_ABSOLUTE_PATH_REQUIRED'):r11.main()

    def test_followup_predicate_is_dynamic(self):
        import run_ap06_r11 as r11
        for campaign,expected in [('AP-06-R11',False),('AP-06-R11-R2',True),('AP-06-R11-R3',True)]:
            with patch.object(r11,'CAMPAIGN',campaign):self.assertIs(r11.is_r11_followup(),expected)

    def test_both_followup_publications_are_isolated_and_verified(self):
        import secrets
        import ap06_authorities as a
        from run_ap06_r9 import publish
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);authority=root/'authority';identity=secrets.token_hex(32);a.initialize(authority,identity,campaign='AP-06-R10')
            source=root/'receipt';source.write_text('original')
            a.publish_snapshot(authority,identity,'old',{'evidence/original':source},root)
            original=sha256(authority/'manifests/old.json')
            for suffix in ('r2','r3'):
                output=root/f'.quality/readiness-wave11-{suffix}';(output/'baseline').mkdir(parents=True);(output/'pipeline').mkdir()
                (output/'baseline/authority-config.local.json').write_text(json.dumps({'AP06_AUTHORITY_ROOT':str(authority),'identity':identity}))
                publish(SimpleNamespace(output=output),'test',{'evidence/test':source})
                a.verify_publication(authority,identity,f'r11-{suffix}-test')
                self.assertEqual((authority/f'r11-{suffix}/evidence/test').read_text(),'original')
            self.assertEqual(sha256(authority/'manifests/old.json'),original)
            (authority/'r11-r3/evidence/test').write_text('changed')
            with self.assertRaisesRegex(ValueError,'AUTHORITY_HASH_OR_SIZE_MISMATCH'):a.verify_publication(authority,identity,'r11-r3-test')

if __name__=='__main__':unittest.main()
