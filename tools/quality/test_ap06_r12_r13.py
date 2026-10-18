import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from ap06_authorities import initialize, publish_snapshot, sha256, verify_publication
from ap06_freeze import validate_test_receipt
from prepare_ap06_r12_r13 import CAMPAIGN, NATIVE_BUDGET, verify_all_publications_once
import run_ap06_r12_r13_native as r13
from run_ap06_r12_r13_native import validate_budget
from run_ap06_r9 import CRYPTO, validate_freeze_preflight
import run_ap06_r12_r2_native as native


class R12R13PreparationTests(unittest.TestCase):
    def test_native_budget_is_exact_and_requires_task_approval(self):
        budget = {'approved': True, **NATIVE_BUDGET, 'approvedByTaskSha256': 'a' * 64}
        validate_budget(budget)
        for field, value in [('approved', False), ('maximum', 4), ('retries', 1), ('capability', 2), ('profiledA', 0)]:
            changed = dict(budget, **{field: value})
            with self.assertRaises(ValueError): validate_budget(changed)

    def test_independent_authority_publication_readback(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); authority = base / 'authority'; identity = 'a' * 64
            initialize(authority, identity, campaign=CAMPAIGN)
            source = base / 'source.json'; source.write_text(json.dumps({'status': 'PASS'}))
            publish_snapshot(authority, identity, 'sample', {'evidence/sample.json': source}, base)
            count, rows = verify_all_publications_once(authority, identity, CAMPAIGN)
            self.assertEqual(count, 1)
            self.assertEqual(rows[0]['path'], 'evidence/sample.json')
            (authority / 'extra.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'PATH_SET_INVALID'):
                verify_all_publications_once(authority, identity, CAMPAIGN)

    def test_build_only_freeze_preflight_rejects_any_browser_launch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); output = root / '.quality/readiness-wave12-r13-native'
            (output / 'fixtures').mkdir(parents=True)
            (output / 'fixtures/manifest.json').write_text('[]', encoding='utf-8')
            products = {'app.js': 'a' * 64}; workers = {'crypto': {'sha256': 'b' * 64}}
            unit = {'status': 'PASS', 'preflightMode': 'build-only', 'unitBrowserLaunches': 0,
                'browserLaunches': 0, 'appProducts': products, 'workerHashes': {'crypto': 'b' * 64},
                'fixtureHash': sha256(output / 'fixtures/manifest.json')}
            wave = type('Wave', (), {'root': root, 'output': output})()
            with patch('run_ap06_r9.build_products', return_value=({}, products, workers)):
                self.assertEqual(validate_freeze_preflight(wave, unit, output)[1], products)
                with self.assertRaisesRegex(RuntimeError, 'R12R13_BUILD_PREFLIGHT_INVALID'):
                    validate_freeze_preflight(wave, {**unit, 'unitBrowserLaunches': 1}, output)

    def test_r13_freeze_requires_five_lanes_without_historical_global_suite(self):
        output = Path('.quality/readiness-wave12-r13-native')
        tests = {'status': 'PASS', **{name: {'status': 'PASS'} for name in
            ('python', 'node', 'typescript', 'angularBuild', 'native')}}
        validate_test_receipt(output, tests)
        tests['native'] = {'status': 'FAIL'}
        with self.assertRaisesRegex(ValueError, 'AP06_FREEZE_TEST_AUTHORITY_INVALID'):
            validate_test_receipt(output, tests)

    def test_freeze_resolves_private_custody_readback(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary); (output / 'baseline').mkdir()
            (output / 'baseline/ci.json').write_text(json.dumps({'headSha': 'a' * 40}), encoding='utf-8')
            wave = type('Wave', (), {'output': output, 'git': lambda _self, *_args: 'a' * 40})()
            with patch.object(r13, 'validate_freeze_readiness', side_effect=RuntimeError('PREFLIGHT_REACHED')):
                with self.assertRaisesRegex(RuntimeError, 'PREFLIGHT_REACHED'):
                    r13.freeze_r13(wave)

    def test_trace_receipt_uses_the_new_authority_campaign(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); output = root / 'output'; authority = root / 'authority'
            (output / 'baseline').mkdir(parents=True); (output / 'pipeline').mkdir()
            identity = 'a' * 64
            initialize(authority, identity, campaign=CAMPAIGN)
            (output / 'baseline/authority-config.local.json').write_text(json.dumps(
                {'AP06_AUTHORITY_ROOT': str(authority), 'identity': identity}), encoding='utf-8')
            wave = type('Wave', (), {'output': output, 'save': lambda _self, name, value:
                (output / name).write_text(json.dumps(value), encoding='utf-8')})()
            with patch.object(native, 'TRACE_PREFIX', 'r12-r13-native'), patch.object(native, 'CAMPAIGN', CAMPAIGN):
                trace = native.private_trace_path(wave, output / 'pipeline')
                trace.write_text('{"traceEvents":[]}', encoding='utf-8')
                receipt = output / 'pipeline/native-receipt.json'
                receipt.write_text(json.dumps({'trace': {'sha256': sha256(trace), 'bytes': trace.stat().st_size}}),
                    encoding='utf-8')
                native.seal_trace(wave, receipt)
            manifest = verify_publication(authority, identity, 'r12-r13-native-trace-capability')
            self.assertEqual(manifest['campaign'], CAMPAIGN)

    @patch.object(r13, 'CAMPAIGN', CAMPAIGN)
    def test_execution_state_accounting(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary)
            pipeline = out / 'pipeline'; pipeline.mkdir()
            formal = out / 'formal'; formal.mkdir()

            # Empty state
            s0 = r13.execution_state(out)
            self.assertEqual(s0['browserLaunches'], 0)
            self.assertEqual(s0['launchAttempts'], 0)
            self.assertFalse(s0['unverifiedConsumption'])

            # Reservation created without receipt -> unverified consumption, cannot declare 0
            (pipeline / 'capability-reservation.json').write_text('{}')
            s1 = r13.execution_state(out)
            self.assertEqual(s1['launchAttempts'], 1)
            self.assertEqual(s1['browserLaunches'], 0)
            self.assertTrue(s1['unverifiedConsumption'])

            # Receipt present
            (pipeline / 'capability-reservation.json').write_text(json.dumps({
                'campaign': CAMPAIGN, 'maximum': 1, 'retries': 0, 'implementationHead': 'a' * 40
            }))
            (pipeline / 'native-receipt.json').write_text(json.dumps({
                'status': 'CAPTURED', 'launchAttempts': 1, 'browserLaunches': 1, 'retries': 0,
                'browserClosed': True, 'processExitAudit': {'status': 'PASS'},
                'handleRelease': {'status': 'PASS'},
                'trace': {'tracingStarted': True, 'memoryInfraCategoryAvailable': True,
                    'activatedBeforeWorkload': True, 'complete': True, 'streamEof': True,
                    'dataLossOccurred': False, 'traceFormat': 'json', 'rendererPid': 42,
                    'sha256': 'b' * 64, 'bytes': 256,
                    'checkpoints': [{'phase': phase, 'success': True, 'dumpGuid': hex(i + 1)}
                        for i, phase in enumerate(('baseline', 'cycle-6-close', 'idle-120s', 'forced-GC-final'))]}
            }))
            s2 = r13.execution_state(out)
            self.assertEqual(s2['launchAttempts'], 1)
            self.assertEqual(s2['browserLaunches'], 1)
            self.assertEqual(s2['capabilityChromium'], 1)
            self.assertFalse(s2['unverifiedConsumption'])

            # Ledger and independent raw/trace receipts prove each formal launch.
            ledger = []
            for index, (condition, directory) in enumerate((('r12r2.0', '05-r12r2.0'),
                    ('r12r2.2', '06-r12r2.2'))):
                mdir = formal / directory; mdir.mkdir()
                raw = {'condition': condition, 'stage': 'formal', 'launchAttempts': 1,
                    'browserLaunches': 1, 'retries': 0, 'runs': [{}]}
                raw_path = mdir / f'{CRYPTO}.raw.json'
                raw_path.write_text(json.dumps(raw))
                (mdir / 'native-receipt.json').write_text(json.dumps({'trace': {
                    'tracingStarted': True, 'memoryInfraCategoryAvailable': True,
                    'activatedBeforeWorkload': True, 'complete': True, 'streamEof': True,
                    'dataLossOccurred': False, 'traceFormat': 'json', 'rendererPid': 42,
                    'sha256': 'b' * 64, 'bytes': 256,
                    'checkpoints': [{'phase': phase, 'success': True, 'dumpGuid': hex(i + 1)}
                        for i, phase in enumerate(('baseline', 'cycle-6-close', 'idle-120s', 'forced-GC-final'))]
                }}))
                ledger.append({'condition': condition, 'stage': 'formal', 'reservedAttempts': 1,
                    'launchAttempts': 1, 'browserLaunches': 1, 'rawSha256': sha256(raw_path)})
            (pipeline / 'launch-ledger.json').write_text(json.dumps(ledger))
            s3 = r13.execution_state(out)
            self.assertEqual(s3['launchAttempts'], 3)
            self.assertEqual(s3['browserLaunches'], 3)
            self.assertEqual(s3['measurementChromium'], 2)
            self.assertFalse(s3['unverifiedConsumption'])

    def test_backend_cleanup_verification_states(self):
        def valid_receipt(**overrides):
            receipt = {
                'status': 'PASS',
                'ownedServerStopped': True,
                'ownedPostgresStopped': True,
                'ownedClusterStorageAndDotenvRemoved': True,
                'runtimePreservedForResume': False,
                'personalServicesTouched': False,
                'failureClass': None,
                'errors': [],
            }
            receipt.update(overrides)
            return receipt

        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); authority = base / 'authority'; identity = 'a' * 64
            initialize(authority, identity, campaign=CAMPAIGN)
            out = base / 'output'; (out / 'pipeline').mkdir(parents=True); (out / 'baseline').mkdir(parents=True)
            (out / 'baseline/authority-config.local.json').write_text(json.dumps(
                {'AP06_AUTHORITY_ROOT': str(authority), 'identity': identity}), encoding='utf-8')
            wave = type('Wave', (), {'output': out, 'save': lambda _self, name, value:
                (out / name).write_text(json.dumps(value), encoding='utf-8')})()

            # Backend never started -> PASS, no listener probe
            with patch('socket.create_connection', side_effect=AssertionError('probe forbidden')):
                res = r13.stop_and_verify_backend_cleanup(wave)
            self.assertEqual(res['status'], 'PASS')
            self.assertFalse(res['backendStarted'])
            self.assertEqual(res['reason'], 'BACKEND_NOT_STARTED')

            # Start evidence present, runtime config missing -> UNVERIFIED
            (out / 'pipeline/backend-live.json').write_text(json.dumps(
                {'status': 'READY', 'isolated': True, 'backendOrigin': 'http://127.0.0.1:49999'}),
                encoding='utf-8')
            with patch('socket.create_connection', side_effect=ConnectionRefusedError):
                res = r13.stop_and_verify_backend_cleanup(wave)
            self.assertEqual(res['status'], 'UNVERIFIED')
            self.assertEqual(res['reason'], 'BACKEND_RUNTIME_CONFIG_MISSING')

            # Corrupt runtime config -> UNVERIFIED
            (out / 'baseline/backend-runtime.local.json').write_text('bad json', encoding='utf-8')
            with patch('socket.create_connection', side_effect=ConnectionRefusedError):
                res = r13.stop_and_verify_backend_cleanup(wave)
            self.assertEqual(res['status'], 'UNVERIFIED')
            self.assertEqual(res['reason'], 'BACKEND_RUNTIME_CONFIG_CORRUPT')

            # Foreign origin -> FAIL before any listener probe
            runtime = out / 'pipeline' / ('runtime-' + 'b' * 16)
            config = {
                'executable': str(out / 'tooling/backend-build/nanika_e2e_fixture.exe'),
                'cwd': str(runtime),
                'storagePath': str(runtime / 'storage'),
                'storageId': 'c' * 64,
                'backendOrigin': 'http://127.0.0.1:49999',
            }
            (out / 'baseline/backend-runtime.local.json').write_text(json.dumps(
                dict(config, backendOrigin='http://192.168.0.1:49999')), encoding='utf-8')
            with patch('socket.create_connection', side_effect=AssertionError('probe forbidden')):
                res = r13.stop_and_verify_backend_cleanup(wave)
            self.assertEqual(res['status'], 'FAIL')
            self.assertEqual(res['reason'], 'BACKEND_RUNTIME_ORIGIN_INVALID')

            (out / 'baseline/backend-runtime.local.json').write_text(json.dumps(config), encoding='utf-8')

            # Missing cleanup receipt -> UNVERIFIED
            with patch('socket.create_connection', side_effect=ConnectionRefusedError):
                res = r13.stop_and_verify_backend_cleanup(wave)
            self.assertEqual(res['status'], 'UNVERIFIED')
            self.assertEqual(res['reason'], 'BACKEND_CLEANUP_RECEIPT_MISSING')

            # Corrupted cleanup receipt -> UNVERIFIED
            cleanup_file = out / 'pipeline/backend-runtime-cleanup.json'
            cleanup_file.write_text('bad json', encoding='utf-8')
            with patch('socket.create_connection', side_effect=ConnectionRefusedError):
                res = r13.stop_and_verify_backend_cleanup(wave)
            self.assertEqual(res['status'], 'UNVERIFIED')
            self.assertEqual(res['reason'], 'BACKEND_CLEANUP_RECEIPT_CORRUPT')

            # Incomplete receipt -> FAIL
            cleanup_file.write_text(json.dumps({'status': 'PASS'}), encoding='utf-8')
            with patch('socket.create_connection', side_effect=ConnectionRefusedError):
                res = r13.stop_and_verify_backend_cleanup(wave)
            self.assertEqual(res['status'], 'FAIL')
            self.assertEqual(res['reason'], 'BACKEND_CLEANUP_RECEIPT_INVALID')

            # Complete receipt reporting FAIL -> FAIL
            cleanup_file.write_text(json.dumps(valid_receipt(
                status='FAIL', failureClass='POSTGRES_STOP_FAILED',
                ownedPostgresStopped=False)), encoding='utf-8')
            with patch('socket.create_connection', side_effect=ConnectionRefusedError):
                res = r13.stop_and_verify_backend_cleanup(wave)
            self.assertEqual(res['status'], 'FAIL')
            self.assertEqual(res['reason'], 'BACKEND_CLEANUP_FAILED')

            # Runtime still exists -> FAIL
            cleanup_file.write_text(json.dumps(valid_receipt()), encoding='utf-8')
            runtime.mkdir()
            with patch('socket.create_connection', side_effect=ConnectionRefusedError):
                res = r13.stop_and_verify_backend_cleanup(wave)
            self.assertEqual(res['status'], 'FAIL')
            self.assertEqual(res['reason'], 'BACKEND_RUNTIME_STILL_EXISTS')

            # Cleaned up runtime and valid receipt -> PASS with verified publication
            runtime.rmdir()
            with patch('socket.create_connection', side_effect=ConnectionRefusedError):
                res = r13.stop_and_verify_backend_cleanup(wave)
            self.assertEqual(res['status'], 'PASS')
            self.assertEqual(res['reason'], 'BACKEND_CLEANUP_VERIFIED')
            manifest = verify_publication(authority, identity, 'backend-cleanup')
            self.assertEqual(manifest['campaign'], CAMPAIGN)

    def test_record_durable_stop_persists_publishes_and_reads_back(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); authority = base / 'authority'; identity = 'a' * 64
            initialize(authority, identity, campaign=CAMPAIGN)
            out = base / 'output'; (out / 'pipeline').mkdir(parents=True); (out / 'baseline').mkdir(parents=True)
            (out / 'final').mkdir(parents=True)
            (out / 'baseline/authority-config.local.json').write_text(json.dumps(
                {'AP06_AUTHORITY_ROOT': str(authority), 'identity': identity}), encoding='utf-8')
            wave = type('Wave', (), {'output': out, 'save': lambda _self, name, value:
                (out / name).write_text(json.dumps(value), encoding='utf-8')})()

            (out / 'pipeline/capability-reservation.json').write_text('{}')
            runtime = out / 'pipeline' / ('runtime-' + 'b' * 16)
            (out / 'baseline/backend-runtime.local.json').write_text(json.dumps({
                'executable': str(out / 'tooling/backend-build/nanika_e2e_fixture.exe'),
                'cwd': str(runtime),
                'storagePath': str(runtime / 'storage'),
                'storageId': 'c' * 64,
                'backendOrigin': 'http://127.0.0.1:49999',
            }), encoding='utf-8')
            (out / 'pipeline/backend-live.json').write_text(json.dumps({
                'status': 'READY', 'isolated': True,
                'backendOrigin': 'http://127.0.0.1:49999'}), encoding='utf-8')
            (out / 'pipeline/backend-runtime-cleanup.json').write_text(json.dumps({
                'status': 'PASS',
                'ownedServerStopped': True,
                'ownedPostgresStopped': True,
                'ownedClusterStorageAndDotenvRemoved': True,
                'runtimePreservedForResume': False,
                'personalServicesTouched': False,
                'failureClass': None,
                'errors': [],
            }), encoding='utf-8')

            with patch('socket.create_connection', side_effect=ConnectionRefusedError):
                payload = r13.record_durable_stop(wave, 'INTEGRITY_CHECK_FAILED', stage='preflight')
            self.assertEqual(payload['status'], 'STOP')
            self.assertEqual(payload['reason'], 'INTEGRITY_CHECK_FAILED')
            self.assertEqual(payload['failureStage'], 'preflight')
            self.assertEqual(payload['failureClass'], 'INTEGRITY_CHECK_FAILED')
            self.assertTrue(payload['reservationCreated'])
            self.assertEqual(payload['scientificChromium'], 'UNVERIFIED')
            self.assertEqual(payload['cleanupStatus'], 'PASS')
            self.assertEqual(payload['publicationStatus'], 'PASS')

            # Verify published file
            manifest = verify_publication(authority, identity, 'stop')
            self.assertEqual(manifest['campaign'], CAMPAIGN)
            self.assertTrue((out / 'final/STOP.json').is_file())


if __name__ == '__main__': unittest.main()
