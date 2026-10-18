"""R11 contract integration. Disposable publications are never scientific evidence."""
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from ap06_authorities import checked_path, private_permissions, sha256
from ap06_key_custody import seal_runtime_credentials
from ap06_freeze import verify_freeze_completion
from prepare_ap06_r12_r11 import prepare as prepare_authority
from run_readiness_wave1 import Wave
import run_ap06_r9 as freezer
import run_ap06_r12_r2 as factorial
import run_ap06_r12_r2_native as native
from test_ap06_r12_r9 import simulate_preflight


@unittest.skipUnless(os.name=='nt' and os.environ.get('AP06_R11_LIVE_INTEGRATION')=='1',
    'Opt in to the owned R11 laboratory; no Chromium is launched')
class LiveFreezePipelineTests(unittest.TestCase):
    def test_real_environment_simulated_preflight_disposable_freeze_and_measurement_preparation(self):
        root=Path(__file__).resolve().parents[2]
        previous=factorial.OUTPUT,factorial.PUBLISHER,factorial.CAMPAIGN
        previous_native=(native.OUTPUT,native.PUBLISHER,native.CAMPAIGN,native.TRACE_PREFIX,native.FACTORIAL,native.FACTORIAL_STATUS)
        factorial.configure_campaign('.quality/readiness-wave12-r11-factorial',root/'tools/quality/run_ap06_r12_r11.py','AP-06-R12-R11-factorial')
        wave=Wave(root);wave.output=root/factorial.OUTPUT
        directory=wave.output/'tooling/offline-simulation';directory.mkdir(exist_ok=True)
        try:
            with tempfile.TemporaryDirectory(prefix='r11-contract-',dir=wave.output/'pipeline') as temporary:
                temporary=Path(temporary);private_permissions(temporary,create=True);wave.temp=temporary
                env,assets,files,_=factorial.prepare_scientific_preflight(wave,require_ci=False,publish_identity=True)
                identity_root=temporary/'identity';identity_root.mkdir();private_permissions(identity_root,create=True)
                unit,identity=simulate_preflight(wave,env,assets,files,directory,identity_root)
                factorial.validate_preflight_receipt(wave,unit,identity)
                for mutation in (lambda r:r['cases'].pop(),lambda r:r.pop('handleRelease'),
                        lambda r:r['browserIdentity']['after'].update(processCreationTime=0),
                        lambda r:r['routingCounters']['r12r2.0'].update(payloadxhrCount=0)):
                    invalid=copy.deepcopy(unit);mutation(invalid)
                    with self.assertRaises((RuntimeError,ValueError)):
                        factorial.validate_preflight_receipt(wave,invalid,identity)
                _,products,_=factorial.build_products(root,factorial.OUTPUT)
                inputs=freezer.collect_freeze_inputs(wave,products,factorial.freeze_extra_files())
                lab_root=temporary/'source';lab_root.mkdir();private_permissions(lab_root,create=True)
                lab=Wave(lab_root);lab.output=lab_root/factorial.OUTPUT;lab.temp=temporary
                lab.git=lambda *args:'' if args==('status','--porcelain') else wave.git(*args)
                for name in ('baseline','pipeline','tooling','fixtures','final','triage','formal'):
                    (lab.output/name).mkdir(parents=True,exist_ok=True)
                private_permissions(lab.output,create=True);private_permissions(lab.output/'baseline',create=True)
                for name,source in inputs.items():
                    if not source.is_file():continue
                    source=checked_path(source.absolute());target=lab_root/name
                    target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
                for name in ('accounts.local.json','player-auth.local.json','backend-runtime.local.json'):
                    shutil.copyfile(wave.output/'baseline'/name,lab.output/'baseline'/name)
                prepare_authority(lab,wave.output)
                config=factorial.read(lab.output/'baseline/authority-config.local.json')
                for name in ('runtime-credentials.dpapi','runtime-credentials-custody.json','runtime-credentials-readback.json'):
                    path=lab.output/'baseline'/name
                    if path.exists():path.unlink()
                credentials={name:factorial.read(lab.output/'baseline'/name) for name in
                    ('accounts.local.json','player-auth.local.json','backend-runtime.local.json')}
                seal_runtime_credentials(lab.output/'baseline',config['identity'],sha256(Path(config['AP06_AUTHORITY_ROOT'])/'manifests/corpus.json'),
                    'AP-06-R12-R11-factorial',credentials)
                lab.save('baseline/browser-identity.json',identity)
                versions=factorial.read(lab.output/'baseline/versions.json')
                versions['chromium']={'executablePath':identity['executablePath'],
                    'sha256':identity['executableSha256'],'version':identity['chromiumVersion'],
                    'syntheticContractFixture':True}
                lab.save('baseline/versions.json',versions)
                receipt=freezer.publish(lab,'browser-identity',{'evidence/browser-identity.json':lab.output/'baseline/browser-identity.json'})
                lab.save('baseline/browser-identity-publication.json',receipt)
                # These explicitly synthetic records exist only in the disposable authority.
                lab.save('baseline/ci.json',{'headSha':wave.git('rev-parse','HEAD'),'conclusion':'success','syntheticContractFixture':True})
                lab.save('baseline/offline-integration.json',{'status':'SYNTHETIC_CONTRACT_FIXTURE','scientificChromium':0})
                lab.save('tooling/offline-simulation/result.json',{'status':'SYNTHETIC_CONTRACT_FIXTURE','scientificChromium':0})
                ready=freezer.validate_freeze_readiness(lab,output=factorial.OUTPUT,
                    extra_files=factorial.freeze_extra_files(),extra_publications=factorial.freeze_publications(lab))
                lab.save('baseline/freeze-readiness.json',ready)
                lab.save('tooling/angular-unit-1.json',dict(unit,syntheticContractFixture=True))
                for name in ('baseline/preflight-ready.json','pipeline/preflight-started.json','pipeline/development-reservation.json','baseline/offline-ready.json'):
                    lab.save(name,{'status':'PASS','syntheticContractFixture':True,'scientificChromium':0})
                factorial.freeze(lab)
                frozen=factorial.read(lab.output/'tooling/freeze.json')
                verify_freeze_completion(lab,frozen);factorial.verify_campaign_freeze(lab,frozen)
                attempt=lab.output/'triage/01-r12r2.0';attempt.mkdir()
                prepared,_=factorial.environment(lab,attempt,'r12r2.0','triage',frozen)
                self.assertEqual(Path(prepared['AP06_BROWSER_IDENTITY']),lab.output/'baseline/browser-identity.json')
                values=dict(zip(factorial.CONDITIONS,(500,500,100,350)))
                candidate=factorial.classify(lab,values)
                self.assertEqual(candidate['pair'],['r12r2.0','r12r2.2'])
                formal=[{'condition':c,'rendererPrivateDeltaMiB':values[c]} for c in
                    ('r12r2.0','r12r2.2','r12r2.2','r12r2.0','r12r2.0','r12r2.2')]
                confirmed=factorial.classify(lab,values,formal,candidate)
                self.assertEqual(confirmed['status'],'R12R2_FACTORIAL_CONFIRMED')
                lab.save('pipeline/triage-decision.json',dict(candidate,pair=candidate['pair']))
                native.configure_campaign('.quality/readiness-wave12-r11-native',lab_root/'tools/quality/run_ap06_r12_r11_native.py')
                native_wave=Wave(lab_root);native_wave.output=lab_root/native.OUTPUT;native_wave.temp=temporary
                native_wave.git=lab.git
                lab.save('final/decision.json',{'status':'R12R11_FORMAL_DISAGREEMENT','syntheticContractFixture':True})
                with self.assertRaises(RuntimeError):native.prepare(native_wave)
                lab.save('final/decision.json',dict(confirmed,status='R12R11_FACTORIAL_CONFIRMED',syntheticContractFixture=True))
                native.prepare(native_wave)
                native_ready=freezer.validate_freeze_readiness(native_wave,output=native.OUTPUT,
                    extra_files=native.native_freeze_extra_files(),extra_publications=('custody',))
                self.assertEqual(native_ready['status'],'PASS')
                real_config=factorial.read(wave.output/'baseline/authority-config.local.json')
                manifests=Path(real_config['AP06_AUTHORITY_ROOT'])/'manifests'
                snapshots=sum((manifests/('r12-r11-factorial-'+name+'.json')).exists()
                    for name in ('implementation','freeze','freeze-complete'))
                self.assertEqual(snapshots,0)
                self.assertFalse((wave.output/'pipeline/development-reservation.json').exists())
                result={'status':'PASS','simulatedChromiumCdp':True,'cases':len(unit['cases']),
                    'realWindowsProcessHandles':True,'preflightReceipt':'PASS','disposablePublicationReadback':'PASS',
                    'freezeVerified':'PASS','triagePrepared':True,'nativePrepared':True,'negativeReceiptsRejected':4,
                    'scientificChromium':0,'reservationCreated':False,'scientificAuthoritySnapshots':snapshots}
                wave.save('tooling/offline-simulation/result.json',result)
            wave.save('baseline/offline-integration.json',dict(result,realDpapiBuildBackendMediaOs=True,
                receiptRoundtrip='PASS',freezeConsumerRoundtrip='PASS',trackedTreeSha256=factorial.tracked_tree_sha(wave),
                contractResultSha256=sha256(directory/'result.json'),implementationHead=wave.git('rev-parse','HEAD')))
        finally:
            factorial.OUTPUT,factorial.PUBLISHER,factorial.CAMPAIGN=previous
            native.OUTPUT,native.PUBLISHER,native.CAMPAIGN,native.TRACE_PREFIX,native.FACTORIAL,native.FACTORIAL_STATUS=previous_native


class NativeGateTests(unittest.TestCase):
    def test_insufficient_capability_never_calls_profiled_measurement(self):
        previous=(native.OUTPUT,native.PUBLISHER,native.CAMPAIGN,native.TRACE_PREFIX,native.FACTORIAL,native.FACTORIAL_STATUS)
        previous_factorial=factorial.OUTPUT,factorial.PUBLISHER,factorial.CAMPAIGN
        native.configure_campaign('.quality/readiness-wave12-r11-native',__file__)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                wave=Wave(Path(tmp));wave.output=wave.root/'.quality/readiness-wave12-r11-native'
                (wave.output/'pipeline').mkdir(parents=True);(wave.output/'baseline').mkdir();(wave.output/'final').mkdir()
                record={'launchAttempts':1,'browserLaunches':1,'browserClosed':True,'processExitAudit':{'status':'PASS'}}
                with patch.object(native,'prepare'),patch.object(native,'verify_identity_freeze'),\
                        patch.object(freezer,'validate_freeze_readiness',return_value={'status':'PASS'}),\
                        patch.object(native,'read',side_effect=lambda p:record if Path(p).name=='native-receipt.json' else {'implementationHead':'1'*40}),\
                        patch.object(native,'environment',return_value=({},{})),patch.object(wave,'command'),\
                        patch.object(native,'seal_trace'),patch.object(native,'publish'),\
                        patch.object(factorial,'validate_browser_receipt'),\
                        patch.object(native,'parse_trace',return_value={'status':'R12R2_NATIVE_PROFILER_UNAVAILABLE'}),\
                        patch.object(native,'measure') as measure:
                    native.run(wave)
                    measure.assert_not_called()
        finally:
            native.OUTPUT,native.PUBLISHER,native.CAMPAIGN,native.TRACE_PREFIX,native.FACTORIAL,native.FACTORIAL_STATUS=previous
            factorial.OUTPUT,factorial.PUBLISHER,factorial.CAMPAIGN=previous_factorial


class SecretScanReviewTests(unittest.TestCase):
    def test_review_only_accepts_unchanged_historical_hash_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            wave=Wave(Path(tmp));wave.output=wave.root/'.quality/readiness-wave12-r11-factorial'
            (wave.output/'baseline').mkdir(parents=True)
            relative='docs/qualidade/historical.json';source=wave.root/relative;source.parent.mkdir(parents=True)
            line='"r10-r2-auth-timing": "'+'a'*64+'"';source.write_text(line,encoding='utf-8')
            finding={'RuleID':'generic-api-key','File':'scan/secret-scan-target/'+relative,'StartLine':1}
            wave.save('baseline/secret-scan.json',[finding])
            receipt={'status':'PASS','scanner':'gitleaks','version':'v8.30.1','actionableFindings':0,
                'trackedTreeSha256':'c'*64,'rawReportSha256':sha256(wave.output/'baseline/secret-scan.json'),'findings':1,
                'reviewedFalsePositives':[{'file':relative,'line':1,'classification':'historical-artifact-sha256',
                    'sourceLineSha256':hashlib.sha256(line.encode()).hexdigest()}]}
            wave.save('baseline/secret-scan-receipt.json',receipt)
            with patch.object(factorial,'CAMPAIGN','AP-06-R12-R11-factorial'),\
                    patch.object(factorial,'tracked_tree_sha',return_value='c'*64),patch.object(wave,'git',return_value='historical-blob') as git:
                factorial.validate_r8_secret_scan(wave)
                git.side_effect=lambda *args:'modified-blob' if args[0]=='hash-object' else 'historical-blob'
                with self.assertRaises(RuntimeError):factorial.validate_r8_secret_scan(wave)
                git.side_effect=None;source.write_text('changed token value',encoding='utf-8')
                with self.assertRaises(RuntimeError):factorial.validate_r8_secret_scan(wave)
                source.write_text(line,encoding='utf-8')
                wave.save('baseline/secret-scan.json',[dict(finding,RuleID='aws-access-token')])
                with self.assertRaises(RuntimeError):factorial.validate_r8_secret_scan(wave)


if __name__=='__main__':unittest.main()
