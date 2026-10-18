import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ap06_authorities import initialize, private_permissions, publish_snapshot, sha256, verify_publication
from ap06_freeze import load_native_budget, validate_test_receipt
from prepare_ap06_r12_r13 import NATIVE_BUDGET, verify_all_publications_once
import run_ap06_r12_r14_native as r14
from run_ap06_r12_r13_native import validate_budget
from run_ap06_r9 import publication_namespace, validate_freeze_preflight
import run_ap06_r12_r2_native as native

CAMPAIGN = 'AP-06-R12-R14-native'
OUTPUT = '.quality/readiness-wave12-r14-native'


class R12R14PreparationTests(unittest.TestCase):
    def test_native_budget_is_exact_and_requires_task_approval(self):
        budget = {'approved': True, **NATIVE_BUDGET, 'approvedByTaskSha256': 'a' * 64}
        validate_budget(budget)
        for field, value in [('approved', False), ('maximum', 4), ('retries', 1), ('capability', 2), ('profiledA', 0)]:
            changed = dict(budget, **{field: value})
            with self.assertRaises(ValueError):
                validate_budget(changed)

    def test_load_native_budget_bom_tolerance(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'budget.json'
            task_sha = 'a' * 64
            budget_data = {'approved': True, **NATIVE_BUDGET, 'approvedByTaskSha256': task_sha}
            path.write_bytes(b'\xef\xbb\xbf' + json.dumps(budget_data).encode('utf-8'))
            loaded = load_native_budget(path, NATIVE_BUDGET, task_sha)
            self.assertEqual(loaded['approved'], True)

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
            root = Path(temporary); output = root / OUTPUT
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

    def test_r14_freeze_requires_five_lanes(self):
        output = Path(OUTPUT)
        tests = {'status': 'PASS', **{name: {'status': 'PASS'} for name in
            ('python', 'node', 'typescript', 'angularBuild', 'native')}}
        validate_test_receipt(output, tests)
        tests['native'] = {'status': 'FAIL'}
        with self.assertRaisesRegex(ValueError, 'AP06_FREEZE_TEST_AUTHORITY_INVALID'):
            validate_test_receipt(output, tests)

    def test_trace_receipt_uses_r14_authority_campaign(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); output = root / 'output'; authority = root / 'authority'
            (output / 'baseline').mkdir(parents=True); (output / 'pipeline').mkdir()
            identity = 'a' * 64
            initialize(authority, identity, campaign=CAMPAIGN)
            (output / 'baseline/authority-config.local.json').write_text(json.dumps(
                {'AP06_AUTHORITY_ROOT': str(authority), 'identity': identity}), encoding='utf-8')
            wave = type('Wave', (), {'output': output, 'save': lambda _self, name, value:
                (output / name).write_text(json.dumps(value), encoding='utf-8')})()
            with patch.object(native, 'TRACE_PREFIX', 'r12-r14-native'), patch.object(native, 'CAMPAIGN', CAMPAIGN):
                trace = native.private_trace_path(wave, output / 'pipeline')
                trace.write_text('{"traceEvents":[]}', encoding='utf-8')
                receipt = output / 'pipeline/native-receipt.json'
                receipt.write_text(json.dumps({'trace': {'sha256': sha256(trace), 'bytes': trace.stat().st_size}}),
                    encoding='utf-8')
                native.seal_trace(wave, receipt)
            manifest = verify_publication(authority, identity, 'r12-r14-native-trace-capability')
            self.assertEqual(manifest['campaign'], CAMPAIGN)

    def test_execution_state_accounting(self):
        with tempfile.TemporaryDirectory() as temporary:
            out = Path(temporary)
            pipeline = out / 'pipeline'; pipeline.mkdir()
            formal = out / 'formal'; formal.mkdir()

            s0 = r14.execution_state(out)
            self.assertEqual(s0['browserLaunches'], 0)
            self.assertEqual(s0['launchAttempts'], 0)
            self.assertFalse(s0['unverifiedConsumption'])

            (pipeline / 'capability-reservation.json').write_text('{}')
            s1 = r14.execution_state(out)
            self.assertEqual(s1['launchAttempts'], 1)
            self.assertEqual(s1['browserLaunches'], 0)
            self.assertTrue(s1['unverifiedConsumption'])

            (pipeline / 'native-receipt.json').write_text(json.dumps({
                'launchAttempts': 1, 'browserLaunches': 1, 'retries': 0
            }))
            s2 = r14.execution_state(out)
            self.assertEqual(s2['launchAttempts'], 1)
            self.assertEqual(s2['browserLaunches'], 1)
            self.assertEqual(s2['capabilityChromium'], 1)
            self.assertFalse(s2['unverifiedConsumption'])

    def test_backend_cleanup_verification_states(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); authority = base / 'authority'; identity = 'a' * 64
            initialize(authority, identity, campaign=CAMPAIGN)
            out = base / 'output'; (out / 'pipeline').mkdir(parents=True); (out / 'baseline').mkdir(parents=True)
            (out / 'baseline/authority-config.local.json').write_text(json.dumps(
                {'AP06_AUTHORITY_ROOT': str(authority), 'identity': identity}), encoding='utf-8')
            wave = type('Wave', (), {'output': out, 'save': lambda _self, name, value:
                (out / name).write_text(json.dumps(value), encoding='utf-8')})()

            # Missing cleanup receipt
            with patch('socket.create_connection', side_effect=ConnectionRefusedError):
                res = r14.stop_and_verify_backend_cleanup(wave)
                self.assertEqual(res['status'], 'UNVERIFIED')
                self.assertEqual(res['reason'], 'BACKEND_CLEANUP_RECEIPT_MISSING')

            # Cleaned up runtime and valid receipt -> PASS
            cleanup_file = out / 'pipeline/backend-runtime-cleanup.json'
            cleanup_file.write_text(json.dumps({'status': 'PASS'}))
            with patch('socket.create_connection', side_effect=ConnectionRefusedError):
                res = r14.stop_and_verify_backend_cleanup(wave)
                self.assertEqual(res['status'], 'PASS')
                manifest = verify_publication(authority, identity, 'backend-cleanup')
                self.assertEqual(manifest['campaign'], CAMPAIGN)

    def test_record_durable_stop(self):
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
            (out / 'pipeline/backend-runtime-cleanup.json').write_text(json.dumps({'status': 'PASS'}))

            payload = r14.record_durable_stop(wave, 'CAPABILITY_EXECUTION_FAILED', stage='capability')
            self.assertEqual(payload['status'], 'STOP')
            self.assertEqual(payload['failureStage'], 'capability')
            self.assertEqual(payload['failureClass'], 'CAPABILITY_EXECUTION_FAILED')
            self.assertTrue(payload['reservationCreated'])
            self.assertEqual(payload['scientificChromium'], 'UNVERIFIED')
            self.assertEqual(payload['publicationStatus'], 'PASS')
            self.assertTrue((out / 'final/STOP.json').is_file())

    def test_completed_statuses_classification(self):
        from run_ap06_r12_r13_native import COMPLETED_STATUSES
        self.assertIn('PASS', COMPLETED_STATUSES)
        self.assertIn('NATIVE_CAPABILITY_PASS', COMPLETED_STATUSES)
        self.assertIn('R12R14_NATIVE_TRACKED_AGGREGATES_OBSERVED', COMPLETED_STATUSES)
        self.assertIn('R12R14_NATIVE_ALLOCATION_COVERAGE_INSUFFICIENT', COMPLETED_STATUSES)
        self.assertIn('R12R14_NATIVE_CAPABILITY_INCONCLUSIVE', COMPLETED_STATUSES)

    def test_offline_runner_simulation_lifecycle(self):
        from ap06_native import PHASES
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            authority = root / 'authority'
            identity = 'a' * 64
            initialize(authority, identity, campaign=CAMPAIGN)

            output = root / OUTPUT
            baseline = output / 'baseline'; baseline.mkdir(parents=True)
            pipeline = output / 'pipeline'; pipeline.mkdir(parents=True)
            final = output / 'final'; final.mkdir(parents=True)

            task_file = baseline / 'task.md'
            task_file.write_text('# AP-06-R12-R14 Task\n', encoding='utf-8')
            task_sha = sha256(task_file)

            # 1. Budget with BOM
            budget_bytes = b'\xef\xbb\xbf' + json.dumps({'approved': True, **NATIVE_BUDGET, 'approvedByTaskSha256': task_sha}).encode('utf-8')
            (baseline / 'native-budget.json').write_bytes(budget_bytes)

            (baseline / 'authority-config.local.json').write_text(json.dumps({
                'AP06_AUTHORITY_ROOT': str(authority),
                'identity': identity,
                'privateRuntime': str(pipeline / 'key-runtime'),
                'scientificCampaign': CAMPAIGN,
            }), encoding='utf-8')

            browser_id = {
                'browser': 'chromium', 'mode': 'headless-shell', 'chromiumVersion': '152.0.0.0',
                'executableSha256': 'a' * 64, 'playwrightVersion': '1.62.1'
            }
            (baseline / 'browser-identity.json').write_text(json.dumps(browser_id), encoding='utf-8')

            def save_fn(rel, val):
                p = output / rel; p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(json.dumps(val), encoding='utf-8')

            wave = type('Wave', (), {
                'root': root,
                'output': output,
                'node': 'node',
                'save': lambda _s, n, v: save_fn(n, v),
                'git': lambda _s, *args: 'a' * 40,
                'command': lambda _s, name, cmd, cwd, env=None: None,
            })()

            # Mock Playwright execution to produce trace without heaps_v2 and valid identity proof
            def fake_capability_command(_name, _cmd, _cwd, env=None):
                receipt_p = output / 'pipeline/native-receipt.json'
                # Generate valid trace events without heaps_v2
                events = [{'ph': 'M', 'pid': 42, 'name': 'process_name', 'args': {'name': 'Renderer'}}]
                for i in range(4):
                    events.append({
                        'ph': 'v', 'pid': 42, 'ts': (i + 1) * 100, 'id': hex(i + 1),
                        'cat': ['disabled-by-default-memory-infra'], 'name': 'explicitly_triggered',
                        'args': {'dumps': {'level_of_detail': 'detailed', 'allocators': {'malloc': {'attrs': {'size': {'type': 'scalar', 'units': 'bytes', 'value': '100'}}}}}}
                    })
                trace_content = json.dumps({'traceEvents': events})
                # Private trace path inside authority
                traces_dir = authority / 'r12-r14-native' / 'traces'
                traces_dir.mkdir(parents=True, exist_ok=True)
                private_permissions(traces_dir, create=True)
                trace_path = traces_dir / 'r12-r14-native-trace-capability.json'
                trace_path.write_text(trace_content, encoding='utf-8')

                rec = {
                    'status': 'CAPTURED',
                    'tracingStarted': True, 'memoryInfraCategoryAvailable': True,
                    'complete': True, 'streamEof': True, 'dataLossOccurred': False,
                    'activatedBeforeWorkload': True, 'rendererPid': 42,
                    'launchAttempts': 1, 'browserLaunches': 1, 'retries': 0, 'browserClosed': True,
                    'flags': ['--memlog=all', '--memlog-stack-mode=native', '--memlog-sampling-rate=16384', '--memlog-keep-small-allocations'],
                    'checkpoints': [{'phase': p, 'dumpGuid': hex(i + 1), 'success': True, 'timestamp': i + 1} for i, p in enumerate(PHASES)],
                    'trace': {'sha256': sha256(trace_path), 'bytes': trace_path.stat().st_size},
                    'processExitAudit': {'status': 'PASS', 'method': 'retained-win32-process-handles', 'processes': [{'pid': 42, 'creationTime': 100, 'roles': ['renderer']}]},
                    'processSamples': [{'phase': p, 'processes': [{'pid': 42, 'type': 'renderer'}]} for p in PHASES],
                    'handleRelease': {'status': 'PASS', 'processHandles': {'releasedProcessHandles': 1, 'closeFailures': 0}},
                    'browserIdentity': {'before': {'nativeFlagsValidated': True}, 'browserClosed': True, 'cleanupStatus': 'PASS'},
                }
                receipt_p.write_text(json.dumps(rec), encoding='utf-8')
                (output / 'pipeline/native-trace.json').write_text(json.dumps({
                    'authorityRelativePath': 'r12-r14-native/traces/r12-r14-native-trace-capability.json'
                }), encoding='utf-8')

            wave.command = fake_capability_command

            frozen_mock = {'status': 'FROZEN', 'implementationHead': 'a' * 40}
            with patch('run_ap06_r12_r13_native.verify_frozen_campaign', return_value=frozen_mock):
                with patch('run_ap06_r12_r2.validate_browser_receipt', return_value=None):
                    with patch('run_ap06_r12_r2_native.environment', return_value=({}, [])):
                        decision = r14.run_capability(wave, root / 'historical')

            # Verify conclusive handling: heaps_v2 not emitted -> INCONCLUSIVE decision, 0 A/B launches
            self.assertEqual(decision['status'], 'R12R14_NATIVE_CAPABILITY_INCONCLUSIVE')
            self.assertEqual(decision['capabilityChromium'], 1)
            self.assertEqual(decision['measurementChromium'], 0)
            self.assertFalse(decision['abAuthorized'])
            self.assertTrue((final / 'decision.json').is_file())
            manifest = verify_publication(authority, identity, 'r12-r14-native-decision')
            self.assertEqual(manifest['campaign'], CAMPAIGN)

            # Reexecution forbidden
            with self.assertRaisesRegex(ValueError, 'R12R14_NATIVE_NO_RETRY_OR_RESUME'):
                r14.run_capability(wave, root / 'historical')


if __name__ == '__main__':
    unittest.main()
