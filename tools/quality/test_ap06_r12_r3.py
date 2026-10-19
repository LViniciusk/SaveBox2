import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from ap06_authorities import initialize,sha256,verify_publication
from run_ap06_r9 import publish
import run_ap06_r12_r2 as factorial
import run_ap06_r12_r2_native as native
from test_ap06_r12_r2 import complete_raw


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.campaign_state=(factorial.OUTPUT,factorial.PUBLISHER,factorial.CAMPAIGN)
        factorial.configure_campaign('.quality/readiness-wave12-r3-factorial',
            Path(factorial.__file__).with_name('run_ap06_r12_r3.py'),'AP-06-R12-R3-factorial')

    def tearDown(self):
        factorial.OUTPUT,factorial.PUBLISHER,factorial.CAMPAIGN=self.campaign_state

    def receipt(self):
        identity=dict(executableSha256='a'*64,executablePath='C:/owned/shell.exe',chromiumVersion='151.0.7922.34',architecture='x64')
        before=dict(status='PASS',browserPid=123,processCreationTime=456,expectedSha256='a'*64,observedSha256='a'*64,
            expectedExecutable=identity['executablePath'],observedExecutable=identity['executablePath'],
            headless=True,launchArgsValidated=True,identityBeforeWorkload=True,chromiumVersion=identity['chromiumVersion'],architecture='x64')
        record=dict(browserIdentity=dict(status='PASS',readLease=True,launchSucceeded=True,processExitAudit={'status':'PASS'},before=before,
            after=dict(before,identityBeforeWorkload=False),closed=dict(closedHashVerified=True)))
        return identity,record

    def test_real_receipt_validator_rejects_each_missing_gate(self):
        identity,record=self.receipt();factorial.validate_browser_receipt(record,identity)
        mutations=[lambda r:r['browserIdentity'].update(status='STOP'),lambda r:r['browserIdentity']['before'].update(identityBeforeWorkload=False),
            lambda r:r['browserIdentity']['after'].update(browserPid=124),lambda r:r['browserIdentity']['after'].update(processCreationTime=457),
            lambda r:r['browserIdentity']['after'].update(observedSha256='b'*64),lambda r:r['browserIdentity']['after'].update(observedExecutable='C:/wrong/shell.exe'),
            lambda r:r['browserIdentity']['closed'].update(closedHashVerified=False),lambda r:r['browserIdentity'].pop('before')]
        for mutate in mutations:
            changed=copy.deepcopy(record);mutate(changed)
            with self.assertRaises(RuntimeError):factorial.validate_browser_receipt(changed,identity)

    def test_complete_factorial_raw_requires_attestation_and_sample_pid(self):
        identity,record=self.receipt()
        with patch.object(factorial,'CAMPAIGN','AP-06-R12-R3-factorial'):
            for condition in factorial.CONDITIONS:
                raw,freeze,fixtures=complete_raw(condition);freeze['browserIdentity']=identity
                with self.assertRaises(RuntimeError):factorial.validate_condition(raw,condition,'triage',freeze,fixtures)
                pid=next(p['pid'] for p in raw['runs'][0]['samples'][0]['processMemory']['processes'] if p['type']=='browser')
                receipt=copy.deepcopy(record['browserIdentity'])
                for key in ('before','after'):receipt[key]['browserPid']=pid
                raw['runs'][0]['browserIdentity']=receipt
                self.assertEqual(factorial.validate_condition(raw,condition,'triage',freeze,fixtures),'R12R2_FACTORIAL_VALID')
                raw['runs'][0]['browserIdentity']['before']['browserPid']=pid+1
                raw['runs'][0]['browserIdentity']['after']['browserPid']=pid+1
                with self.assertRaises(RuntimeError):factorial.validate_condition(raw,condition,'triage',freeze,fixtures)

    def test_new_publications_preserve_historical_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);authority=root/'authority';initialize(authority,'b'*64,campaign='AP-06-R10')
            source=root/'source';source.write_text('immutable source')
            old=None
            for name in ('readiness-wave12-r2-factorial','readiness-wave12-r3-factorial','readiness-wave12-r3-native'):
                output=root/name;(output/'baseline').mkdir(parents=True);(output/'pipeline').mkdir()
                (output/'baseline/authority-config.local.json').write_text(json.dumps({'AP06_AUTHORITY_ROOT':str(authority),'identity':'b'*64}))
                publish(SimpleNamespace(root=root,output=output),'identity',{'evidence/identity.json':source})
                if old is None:old=sha256(authority/'manifests/r12-r2-factorial-identity.json')
            self.assertEqual(sha256(authority/'manifests/r12-r2-factorial-identity.json'),old)
            for prefix in ('r12-r3-factorial','r12-r3-native'):self.assertEqual(len(verify_publication(authority,'b'*64,prefix+'-identity')['files']),1)

    def test_decisions_translate_only_campaign_names_and_native_gate_is_formal(self):
        with patch.object(factorial,'CAMPAIGN','AP-06-R12-R3-factorial'):
            for status in ('CONTROL_NOT_REPRODUCED','FACTORIAL_INCONCLUSIVE','FORMAL_DISAGREEMENT','FACTORIAL_CONFIRMED'):
                self.assertEqual(factorial.campaign_decision({'status':'R12R2_'+status})['status'],'R12R3_'+status)
        with tempfile.TemporaryDirectory() as tmp,patch.object(native,'FACTORIAL','.quality/readiness-wave12-r3-factorial'),patch.object(native,'FACTORIAL_STATUS','R12R3_FACTORIAL_CONFIRMED'):
            root=Path(tmp);source=root/native.FACTORIAL;(source/'final').mkdir(parents=True)
            for status in ('R12R2_FACTORIAL_CONFIRMED','R12R3_CANDIDATE','R12R3_FORMAL_DISAGREEMENT'):
                (source/'final/decision.json').write_text(json.dumps({'status':status}))
                with self.assertRaises(RuntimeError):native.prepare(SimpleNamespace(root=root,output=root/'native'))


if __name__=='__main__':unittest.main()
