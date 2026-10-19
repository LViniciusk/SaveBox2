import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import run_ap06_r12_r2 as factorial
import run_ap06_r12_r2_native as native
from run_ap06_r9 import publish
from test_ap06_r12_r2 import complete_raw


class RecoveryTests(unittest.TestCase):
    def receipt(self):
        identity=dict(executableSha256='a'*64,executablePath='C:/owned/chrome-headless-shell.exe',
            chromiumVersion='151.0.7922.34',architecture='x64',mode='headless-shell')
        before=dict(status='PASS',browserPid=123,parentPid=12,parentCreationTime=345,processCreationTime=456,
            expectedSha256='a'*64,observedSha256='a'*64,expectedExecutable=identity['executablePath'],
            observedExecutable=identity['executablePath'],browserMode='headless-shell',launchArgsValidated=True,
            fixedDefaultsValidated=True,experimentalArgumentsValidated=True,profileDirectoryValidated=True,
            imageHashBoundByLease=True,ancestryValidated=True,nativeFlagsValidated=False,identityBeforeWorkload=True,
            chromiumVersion=identity['chromiumVersion'],architecture=identity['architecture'])
        record=dict(browserIdentity=dict(status='PASS',attemptReserved=True,readLease=True,browserLaunchSucceeded=True,
            processExitAudit={'status':'PASS'},before=before,after=dict(before,identityBeforeWorkload=False),closed={'closedHashVerified':True}))
        return identity,record

    def test_r4_receipt_requires_binary_parent_full_arguments_and_closed_lifetime(self):
        identity,record=self.receipt()
        with patch.object(factorial,'CAMPAIGN','AP-06-R12-R4-factorial'):
            factorial.validate_browser_receipt(record,identity)
            for mutate in (
                lambda row:row['browserIdentity'].update(browserLaunchSucceeded=False),
                lambda row:row['browserIdentity']['before'].update(ancestryValidated=False),
                lambda row:row['browserIdentity']['after'].update(parentCreationTime=346),
                lambda row:row['browserIdentity']['before'].update(imageHashBoundByLease=False),
                lambda row:row['browserIdentity']['before'].update(nativeFlagsValidated=True),
                lambda row:row['browserIdentity']['closed'].update(closedHashVerified=False),
                lambda row:row['browserIdentity'].pop('processExitAudit')):
                changed=copy.deepcopy(record);mutate(changed)
                with self.assertRaises(RuntimeError):factorial.validate_browser_receipt(changed,identity)

    def test_r4_full_factorial_validation_binds_first_sample_to_attested_root(self):
        identity,receipt=self.receipt()
        with patch.object(factorial,'CAMPAIGN','AP-06-R12-R4-factorial'):
            for condition in factorial.CONDITIONS:
                raw,freeze,fixtures=complete_raw(condition);freeze['browserIdentity']=identity
                with self.assertRaises(RuntimeError):factorial.validate_condition(raw,condition,'triage',freeze,fixtures)
                pid=next(row['pid'] for row in raw['runs'][0]['samples'][0]['processMemory']['processes'] if row['type']=='browser')
                browser=copy.deepcopy(receipt['browserIdentity'])
                for key in ('before','after'):browser[key]['browserPid']=pid
                raw['runs'][0]['browserIdentity']=browser
                self.assertEqual(factorial.validate_condition(raw,condition,'triage',freeze,fixtures),'R12R2_FACTORIAL_VALID')
                raw['runs'][0]['browserIdentity']['before']['browserPid']=pid+1
                raw['runs'][0]['browserIdentity']['after']['browserPid']=pid+1
                with self.assertRaises(RuntimeError):factorial.validate_condition(raw,condition,'triage',freeze,fixtures)

    def test_campaign_namespaces_and_publishers_are_r4_scoped(self):
        old=(factorial.OUTPUT,factorial.PUBLISHER,factorial.CAMPAIGN,native.OUTPUT,native.PUBLISHER,native.CAMPAIGN,native.TRACE_PREFIX,native.FACTORIAL,native.FACTORIAL_STATUS)
        try:
            factorial.configure_campaign('.quality/readiness-wave12-r4-factorial','r4.py','AP-06-R12-R4-factorial')
            self.assertEqual(factorial.campaign_decision({'status':'R12R2_FACTORIAL_CONFIRMED'})['status'],'R12R4_FACTORIAL_CONFIRMED')
            native.configure_campaign('.quality/readiness-wave12-r4-native','r4-native.py')
            self.assertEqual((native.TRACE_PREFIX,native.FACTORIAL,native.FACTORIAL_STATUS),
                ('r12-r4-native','.quality/readiness-wave12-r4-factorial','R12R4_FACTORIAL_CONFIRMED'))
        finally:
            (factorial.OUTPUT,factorial.PUBLISHER,factorial.CAMPAIGN,native.OUTPUT,native.PUBLISHER,native.CAMPAIGN,
                native.TRACE_PREFIX,native.FACTORIAL,native.FACTORIAL_STATUS)=old

    def test_r5_namespaces_are_private_and_use_r5_publication_prefixes(self):
        old=(factorial.OUTPUT,factorial.PUBLISHER,factorial.CAMPAIGN,native.OUTPUT,native.PUBLISHER,native.CAMPAIGN,
            native.TRACE_PREFIX,native.FACTORIAL,native.FACTORIAL_STATUS)
        try:
            factorial.configure_campaign('.quality/readiness-wave12-r5-factorial','r5.py','AP-06-R12-R5-factorial')
            self.assertEqual(factorial.campaign_decision({'status':'R12R2_FACTORIAL_CONFIRMED'})['status'],'R12R5_FACTORIAL_CONFIRMED')
            native.configure_campaign('.quality/readiness-wave12-r5-native','r5-native.py')
            self.assertEqual((native.TRACE_PREFIX,native.FACTORIAL,native.FACTORIAL_STATUS),
                ('r12-r5-native','.quality/readiness-wave12-r5-factorial','R12R5_FACTORIAL_CONFIRMED'))
        finally:
            (factorial.OUTPUT,factorial.PUBLISHER,factorial.CAMPAIGN,native.OUTPUT,native.PUBLISHER,native.CAMPAIGN,
                native.TRACE_PREFIX,native.FACTORIAL,native.FACTORIAL_STATUS)=old

    def test_r4_freeze_readback_checks_registered_identity(self):
        identity,record=self.receipt()
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp);(output/'baseline').mkdir();(output/'baseline/browser-identity.json').write_text(json.dumps(identity))
            wave=SimpleNamespace(output=output)
            with patch.object(factorial,'CAMPAIGN','AP-06-R12-R4-factorial'),patch.object(factorial,'verify_r11_freeze'),\
                    patch('ap06_browser_identity.verify_identity') as verify:
                factorial.verify_campaign_freeze(wave,{'browserIdentity':identity});verify.assert_called_once_with(identity)
                with self.assertRaises(RuntimeError):factorial.verify_campaign_freeze(wave,{'browserIdentity':{}})

    def test_new_authority_publication_preserves_r2_and_r3_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);authority=root/'authority'
            from ap06_authorities import initialize,sha256,verify_publication
            initialize(authority,'b'*64,campaign='AP-06-R10');source=root/'report.json';source.write_text('{"status":"PASS"}')
            for name in ('readiness-wave12-r2-factorial','readiness-wave12-r3-factorial','readiness-wave12-r3-native',
                'readiness-wave12-r4-factorial','readiness-wave12-r4-native','readiness-wave12-r5-factorial','readiness-wave12-r5-native'):
                output=root/name;(output/'baseline').mkdir(parents=True);(output/'pipeline').mkdir()
                (output/'baseline/authority-config.local.json').write_text(json.dumps({'AP06_AUTHORITY_ROOT':str(authority),'identity':'b'*64}))
                publish(SimpleNamespace(root=root,output=output),'identity',{'evidence/identity.json':source})
            for name in ('r12-r2-factorial-identity','r12-r3-factorial-identity','r12-r3-native-identity',
                'r12-r4-factorial-identity','r12-r4-native-identity','r12-r5-factorial-identity','r12-r5-native-identity'):
                self.assertEqual(verify_publication(authority,'b'*64,name)['files'][0]['sha256'],sha256(source))


if __name__=='__main__':unittest.main()
