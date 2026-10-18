"""Complete R12 consumers and explicitly opted-in disposable producer integration."""
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from ap06_authorities import sha256
from run_ap06_transport_probe import media_server
import run_ap06_r12_r2 as factorial
import run_ap06_r12_r2_native as native
import run_ap06_r9 as freezer
from test_ap06_r12_r11 import retained_measurement
import test_ap06_r12_r11 as r11tests


def corruptions():
    return {
        'browser_pid':lambda r:r['runs'][0]['browserIdentity']['after'].update(browserPid=999),
        'creation_time':lambda r:r['runs'][0]['browserIdentity']['after'].update(processCreationTime=999),
        'missing_process':lambda r:r['runs'][0]['processExitAudit']['processes'].pop(),
        'process_handle':lambda r:r['runs'][0]['handleRelease']['processHandles'].update(closeFailures=1),
        'executable_handle':lambda r:r['runs'][0]['handleRelease']['executableHandles'].update(closeFailures=1),
        'process_timeout':lambda r:r['runs'][0]['processExitAudit'].update(timedOutProcessCount=1),
        'legacy_schema':lambda r:r['runs'][0].update(processExitAudit={'status':'PASS','ownedPids':[],'aliveOwnedPids':[]}),
        'closed_hash':lambda r:r['runs'][0]['processExitAudit'].update(closedHashVerified=False),
        'native_flags_in_common':lambda r:r['runs'][0]['browserIdentity']['before'].update(nativeFlagsValidated=True),
        'executable_hash':lambda r:r['runs'][0]['browserIdentity']['after'].update(observedSha256='0'*64),
        'range':lambda r:r['runs'][0]['rangeNetwork']['requests'][0].update(range='bytes=0-0'),
        'content_length':lambda r:r['runs'][0]['rangeNetwork']['requests'][0]['headers'].update({'content-length':'0'}),
        'routing_count':lambda r:r['runs'][0]['samples'][1]['counters']['routing'].update(metadataxhrCount=999),
        'status_200':lambda r:r['runs'][0]['rangeNetwork']['requests'][0].update(status=200),
        'payload_transport':lambda r:r.update(payloadTransport='invalid'),
        'metadata_transport':lambda r:r.update(metadataTransport='invalid'),
        'nonfinite_memory':lambda r:r['runs'][0]['samples'][1]['processMemory'].update(privateBytes=float('nan')),
    }


def validate_negative_measurements(test,raw,frozen,fixtures):
    for name,mutate in corruptions().items():
        invalid=copy.deepcopy(raw);mutate(invalid)
        with test.subTest(field=name),test.assertRaises(RuntimeError):
            factorial.validate_condition(invalid,raw['condition'],raw['stage'],frozen,fixtures)


def validate_classifier(test,wave):
    values=dict(zip(factorial.CONDITIONS,(500,500,100,350)));candidate=factorial.classify(wave,values)
    test.assertEqual(candidate['pair'],['r12r2.0','r12r2.2'])
    a,b=candidate['pair'];formal=[{'condition':c,'rendererPrivateDeltaMiB':values[c]} for c in (a,b,b,a,a,b)]
    confirmed=factorial.classify(wave,values,formal,candidate);test.assertEqual(confirmed['status'],'R12R2_FACTORIAL_CONFIRMED')
    wrong=copy.deepcopy(formal);wrong[1]['condition']=a
    test.assertEqual(factorial.classify(wave,values,wrong,candidate)['status'],'R12R2_FORMAL_DISAGREEMENT')
    wrong=copy.deepcopy(formal);wrong[1]['rendererPrivateDeltaMiB']=450
    test.assertEqual(factorial.classify(wave,values,wrong,candidate)['status'],'R12R2_FORMAL_DISAGREEMENT')
    with test.assertRaises(RuntimeError):factorial.classify(wave,values,formal,dict(candidate,contrast=999))
    test.assertEqual(factorial.classify(wave,dict.fromkeys(factorial.CONDITIONS,10))['status'],'R12R2_CONTROL_NOT_REPRODUCED')
    test.assertEqual(factorial.classify(wave,dict.fromkeys(factorial.CONDITIONS,350))['status'],'R12R2_FACTORIAL_INCONCLUSIVE')
    return confirmed


class CompleteConsumerTests(unittest.TestCase):
    def test_r12_complete_triage_formal_native_and_each_negative(self):
        with patch.object(factorial,'CAMPAIGN','AP-06-R12-R12-factorial'):
            for index,condition in enumerate(factorial.CONDITIONS):
                raw,frozen,fixtures=retained_measurement(condition)
                self.assertEqual(factorial.validate_condition(raw,condition,'triage',frozen,fixtures),'R12R2_FACTORIAL_VALID')
                validate_negative_measurements(self,raw,frozen,fixtures)
                raw['stage']='formal';raw['runs'][0]['runId']=f'formal-{5+index:02}-'+condition
                self.assertEqual(factorial.validate_condition(raw,condition,'formal',frozen,fixtures),'R12R2_FACTORIAL_VALID')
                with self.assertRaises(RuntimeError):native.validate_condition(raw,condition,'formal',frozen,fixtures)
                for point in ('before','after'):raw['runs'][0]['browserIdentity'][point]['nativeFlagsValidated']=True
                self.assertEqual(native.validate_condition(raw,condition,'formal',frozen,fixtures),'R12R2_FACTORIAL_VALID')

    def test_campaign_capabilities_preserve_old_boundaries(self):
        for number in range(2,13):
            with patch.object(factorial,'CAMPAIGN',f'AP-06-R12-R{number}-factorial'):
                self.assertEqual(factorial.retained_process_audit(),number>=5)
                for feature in (3,4,5,6,8,9,10,11,12):self.assertEqual(factorial.campaign_since(feature),number>=feature)
                self.assertEqual(factorial.campaign_prefix(),f'R12R{number}_')
        with patch.object(factorial,'CAMPAIGN','AP-06-R12-R12-factorial'):
            from run_readiness_wave1 import Wave
            wave=Wave(Path(__file__).resolve().parents[2]);validate_classifier(self,wave)


@unittest.skipUnless(os.name=='nt' and os.environ.get('AP06_R12_LIVE_INTEGRATION')=='1',
    'Explicitly opt in to the fresh R12 laboratory; no Chromium is launched')
class R12LivePipelineTests(r11tests.LiveFreezePipelineTests):
    __unittest_skip__=False
    round_number=12

    def validate_measurements(self,lab,frozen,unit,identity,directory):
        original=Path(__file__).resolve().parents[2]
        for name in ('ap06-r12-r2-probe.mjs','ap06-transmux-probe.mjs','ap06-browser-identity.mjs','ap06-r9-network.mjs'):
            relative='frontend/tools/'+name;self.assertEqual(sha256(original/relative),frozen['files'][relative])
        target=Path(tempfile.mkdtemp(prefix='measurement-producer-',dir=directory))
        scenarios=[{'condition':condition,'stage':stage,'native':profiled,'name':f'{label}-{condition}',
            'runId':f'{stage}-{index+1 if stage=="triage" else index+5:02}-{condition}'}
            for label,stage,profiled in [('triage','triage',False),('formal','formal',False),('native','formal',True)]
            for index,condition in enumerate(factorial.CONDITIONS)]
        confirmation=('r12r2.0','r12r2.2','r12r2.2','r12r2.0','r12r2.0','r12r2.2')
        scenarios.extend({'condition':condition,'stage':'formal','native':False,'name':f'confirmation-{index:02}-{condition}',
            'runId':f'formal-{index:02}-{condition}'} for index,condition in enumerate(confirmation,5))
        config=target/'config.json';result=target/'result.json'
        config.write_text(json.dumps({'identity':str(lab.output/'baseline/browser-identity.json'),'output':str(target),
            'result':str(result),'conditions':factorial.CONDITIONS,'ranges':frozen['workload']['rangesPerCycle'],
            'proof':factorial.expected_proof('r10.1'),'scenarios':scenarios}),encoding='utf-8')
        env,assets=factorial.environment(lab,lab.output/'tooling','r12r2.0','triage',frozen)
        env['AP06_R12_SIMULATION']=str(config)
        freezer.verify_freeze(lab,frozen)
        with media_server(freezer.media_files(lab),True,'application/octet-stream',assets,port=42088) as (origin,_):
            env['AP06_R5_MEDIA_ORIGIN']=origin
            process=subprocess.run([lab.node,'--test','tools/ap06-r12-r12-pipeline.test.mjs'],cwd=original/'frontend',
                env=env,capture_output=True,text=True,encoding='utf-8',timeout=600)
        (target/'node.log').write_text(process.stdout+process.stderr,encoding='utf-8')
        self.assertEqual(process.returncode,0,(process.stdout+process.stderr)[-5000:])
        produced=json.loads(result.read_text(encoding='utf-8'));self.assertEqual(len(produced['scenarios']),18)
        fixtures=factorial.read(lab.output/'fixtures/manifest.json');hashes={}
        for scenario,row in zip(scenarios,produced['scenarios']):
            raw=factorial.read(Path(row['path']));self.assertTrue(raw['syntheticContractFixture'])
            consumer=native.validate_condition if scenario['native'] else factorial.validate_condition
            self.assertEqual(consumer(raw,scenario['condition'],scenario['stage'],frozen,fixtures),'R12R2_FACTORIAL_VALID')
            hashes[scenario['name']]=sha256(Path(row['path']))
            if not scenario['native'] and scenario['stage']=='triage':validate_negative_measurements(self,raw,frozen,fixtures)
            freezer.publish(lab,'synthetic-consumer-'+scenario['name'],{'evidence/offline-consumers/'+scenario['name']+'.json':Path(row['path'])})
        self.assertEqual(validate_classifier(self,lab)['status'],'R12R2_FACTORIAL_CONFIRMED')
        freezer.verify_freeze(lab,frozen)
        actual_git=lab.git
        with patch.object(lab,'git',side_effect=lambda *args:'0'*40 if args==('rev-parse','HEAD') else actual_git(*args)):
            with self.assertRaises(RuntimeError):factorial.verify_campaign_freeze(lab,frozen)
        proof={'status':'PASS','producer':produced['producer'],'implementationHead':frozen['implementationHead'],
            'conditions':list(factorial.CONDITIONS),'triageConsumers':4,'formalConsumers':4,'nativeConsumers':4,
            'formalConfirmationRuns':6,'formalConfirmationOrder':list(confirmation),
            'negativeMutationKinds':len(corruptions()),'realWindowsHandles':True,'realAuthenticatedBackendRanges':True,
            'classifierConfirmedAndRejectedCorrectly':True,'differentHeadRejected':True,'rawHashes':hashes,
            'simulatedBrowserCdp':True,'scientificChromium':0}
        path=directory/'measurement-consumers.json';path.write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8')
        self.measurement_result={'completeMeasurementConsumers':'PASS','measurementConsumerReceiptSha256':sha256(path)}


if __name__=='__main__':unittest.main()
