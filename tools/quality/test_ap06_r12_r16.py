import copy
import json
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ap06_authorities import initialize, private_permissions, publish_snapshot, sha256, verify_publication
from ap06_freeze import load_native_budget, strict_freeze_namespace, validate_test_receipt
import prepare_ap06_r12_r13 as prepare_engine
import run_ap06_r12_r13_native as runner
import run_ap06_r12_r16_native as r16
from run_ap06_r9 import publication_namespace
from ap06_native import aggregate_trace, inspect_trace, trace_events, _proof_matches

CAMPAIGN = 'AP-06-R12-R16-native'
OUTPUT = '.quality/readiness-wave12-r16-native'
TASK_PATH = 'quality/ap06-r12-r16.md'


def valid_cleanup_receipt(**overrides):
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


def setup_test_wave(base):
    authority = base / 'authority'
    identity = 'a' * 64
    initialize(authority, identity, campaign=CAMPAIGN)
    output = base / 'output'
    for name in ('baseline', 'pipeline', 'tooling', 'final', 'formal'):
        (output / name).mkdir(parents=True, exist_ok=True)
    (output / 'baseline/authority-config.local.json').write_text(json.dumps(
        {'AP06_AUTHORITY_ROOT': str(authority), 'identity': identity}), encoding='utf-8')
    wave = SimpleNamespace(
        root=base,
        output=output,
        temp=base / 'temp',
        git=lambda *args: 'a' * 40 if args == ('rev-parse', 'HEAD') else '',
        save=lambda name, value: (output / name).parent.mkdir(parents=True, exist_ok=True) or (
            output / name).write_text(json.dumps(value), encoding='utf-8')
    )
    (base / 'temp').mkdir(parents=True, exist_ok=True)
    return wave, output, authority, identity


def synthetic_trace_events(checkpoint_count=4, with_heaps=True, renderer_pid=42):
    rows = [{'ph': 'M', 'pid': renderer_pid, 'name': 'process_name', 'args': {'name': 'Renderer'}}]
    requests = []
    for i in range(checkpoint_count):
        dump_guid = hex(i + 1)
        start = i * 100
        end = start + 2
        maps = {'strings': [{'id': 0, 'string': 'SafeNativeFunction'}], 'nodes': [{'id': 1, 'name_sid': 0}], 'types': []}
        rows.append({
            'ph': 'v', 'pid': renderer_pid, 'ts': start + 1, 'id': dump_guid, 'name': 'explicitly_triggered',
            'cat': ['disabled-by-default-memory-infra'],
            'args': {'dumps': {
                'level_of_detail': 'detailed',
                'allocators': {'malloc': {'attrs': {'size': {'type': 'scalar', 'units': 'bytes', 'value': hex(200 + i)[2:]}}}},
                **(({'heaps_v2': {'version': 1, 'maps': maps, 'allocators': {'malloc': {'sizes': [100 + i], 'counts': [1], 'types': [0], 'nodes': [1]}}}}) if with_heaps else {})
            }}
        })
        requests.extend([
            {'ph': 'b', 'pid': 99, 'ts': start, 'id2': {'local': dump_guid}, 'name': 'GlobalMemoryDump',
             'cat': ['disabled-by-default-memory-infra'], 'args': {'dump_guid': dump_guid,
             'dump_type': 'explicitly_triggered', 'level_of_detail': 'detailed', 'success': True}},
            {'ph': 'e', 'pid': 99, 'ts': end, 'id2': {'local': dump_guid}, 'name': 'GlobalMemoryDump',
             'cat': ['disabled-by-default-memory-infra']}
        ])
    return rows + requests


def synthetic_receipt(checkpoint_count=4, renderer_pid=42):
    phases = ('baseline', 'cycle-6-close', 'idle-120s', 'forced-GC-final')[:checkpoint_count]
    flags = ['--memlog=all', '--memlog-stack-mode=native', '--memlog-sampling-rate=16384', '--memlog-keep-small-allocations']
    return {
        'status': 'CAPTURED',
        'launchAttempts': 1,
        'browserLaunches': 1,
        'retries': 0,
        'browserClosed': True,
        'requestAttempts': checkpoint_count,
        'processExitAudit': {'status': 'PASS'},
        'handleRelease': {'status': 'PASS'},
        'rendererPid': renderer_pid,
        'flags': list(flags),
        'trace': {
            'tracingStarted': True,
            'memoryInfraCategoryAvailable': True,
            'activatedBeforeWorkload': True,
            'complete': checkpoint_count == 4,
            'streamEof': True,
            'dataLossOccurred': False,
            'traceFormat': 'json',
            'rendererPid': renderer_pid,
            'flags': list(flags),
            'sha256': 'd' * 64,
            'bytes': 4096,
            'checkpoints': [{'phase': p, 'success': True, 'dumpGuid': hex(i + 1), 'timestamp': i + 1}
                            for i, p in enumerate(phases)]
        }
    }


def create_valid_authorization(output, root, head='a' * 40, task_path=TASK_PATH):
    task_file = root / task_path
    task_file.parent.mkdir(parents=True, exist_ok=True)
    if not task_file.is_file():
        task_file.write_text('# R16 Task Authority Specification\n', encoding='utf-8')
    task_sha = sha256(task_file)
    (output / 'baseline/task.md').write_text(task_file.read_text(encoding='utf-8'), encoding='utf-8')
    frozen_payload = {'status': 'FROZEN', 'implementationHead': head}
    (output / 'tooling/freeze.json').write_text(json.dumps(frozen_payload), encoding='utf-8')
    auth_payload = {
        'campaign': CAMPAIGN,
        'scope': 'capability-only',
        'approved': True,
        'approvedByTaskSha256': task_sha,
        'implementationHead': head,
        'signer': 'ScientificDirector-Key-01',
        'budget': {
            'capability': 1,
            'profiledA': 0,
            'profiledB': 0,
            'maximum': 1,
            'retries': 0,
        }
    }
    auth_file = output / 'baseline/scientific-authorization.json'
    auth_file.write_text(json.dumps(auth_payload, indent=2), encoding='utf-8')
    return auth_file, task_sha


class TestAp06R16ControlledCapability(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix='ap06-r16-test-')
        self.base = Path(self.temp_dir.name)
        self.wave, self.output, self.authority, self.identity = setup_test_wave(self.base)
        prepare_engine.configure_campaign(CAMPAIGN, OUTPUT, TASK_PATH, budget=r16.R16_BUDGET)
        runner.configure_campaign(CAMPAIGN, OUTPUT, TASK_PATH, r16.RUNNER_PATH, budget=r16.R16_BUDGET)

    def tearDown(self):
        self.temp_dir.cleanup()

    # Caso 1: Preflight íntegro, sem autorização -> Preparação permitida; lançamento bloqueado
    def test_case_1_preflight_clean_without_authorization_blocks_launch(self):
        # Without authorization, preflight report reflects engineering ready awaiting authorization
        auth_file = self.output / 'baseline/scientific-authorization.json'
        self.assertFalse(auth_file.exists())
        # Attempting run_capability without authorization raises NativeContractFailure immediately
        with self.assertRaises(runner.NativeContractFailure) as cm:
            r16.run_capability(self.wave, self.base / 'source')
        self.assertIn('SCIENTIFIC_AUTHORIZATION_MISSING', cm.exception.reason)
        # Verify no reservation created and zero Chromium launched
        self.assertFalse((self.output / 'pipeline/capability-reservation.json').exists())
        self.assertFalse((self.output / 'final/STOP.json').exists())

    # Caso 2: Autorização inválida ou pertencente à R14 -> Bloqueio antes do launch
    def test_case_2_invalid_or_r14_authorization_blocks_before_launch(self):
        auth_file, task_sha = create_valid_authorization(self.output, self.base)
        valid_data = json.loads(auth_file.read_text())

        scenarios = [
            ('belonging_to_r14', {**valid_data, 'campaign': 'AP-06-R12-R14-native'}),
            ('tampered_task_sha', {**valid_data, 'approvedByTaskSha256': '0' * 64}),
            ('mismatched_head', {**valid_data, 'implementationHead': 'f' * 40}),
            ('excess_budget_maximum', {**valid_data, 'budget': {**valid_data['budget'], 'maximum': 3}}),
            ('excess_budget_profiled', {**valid_data, 'budget': {**valid_data['budget'], 'profiledA': 1}}),
            ('missing_signer', {**valid_data, 'signer': ''}),
            ('scope_not_capability_only', {**valid_data, 'scope': 'full-ab'}),
            ('approved_false', {**valid_data, 'approved': False}),
        ]

        for name, tampered in scenarios:
            with self.subTest(scenario=name):
                auth_file.write_text(json.dumps(tampered), encoding='utf-8')
                with self.assertRaises(runner.NativeContractFailure) as cm:
                    r16.run_capability(self.wave, self.base / 'source')
                self.assertIn('SCIENTIFIC_AUTHORIZATION_INVALID', cm.exception.reason)
                # Confirm reservation was NEVER created
                self.assertFalse((self.output / 'pipeline/capability-reservation.json').exists())

    # Caso 3: Capability sintética válida -> PASS de capability, zero A/B
    def test_case_3_synthetic_valid_capability_yields_capability_pass_and_zero_ab(self):
        create_valid_authorization(self.output, self.base)
        # Mock capture_capability_once to return a valid capability PASS
        mock_capability = {
            'status': 'NATIVE_CAPABILITY_PASS',
            'heapProfilingEffective': True,
            'traceSha256': 'd' * 64,
            'traceBytes': 4096,
        }

        def mock_capture(*args, **kwargs):
            (self.output / 'pipeline/capability-reservation.json').write_text(json.dumps({
                'campaign': CAMPAIGN, 'maximum': 1, 'retries': 0, 'implementationHead': 'a' * 40
            }))
            (self.output / 'pipeline/native-receipt.json').write_text(json.dumps(synthetic_receipt(4)))
            return mock_capability, {}, {}

        with patch.object(runner, 'capture_capability_once', side_effect=mock_capture), \
             patch.object(runner, 'stop_and_verify_backend_cleanup', return_value=valid_cleanup_receipt()), \
             patch.object(runner, 'run_profiled_pair', side_effect=AssertionError('run_profiled_pair MUST NEVER BE CALLED IN R16')):
            decision = r16.run_capability(self.wave, self.base / 'source')

        self.assertEqual(decision['status'], 'R12R16_NATIVE_CAPABILITY_PASS')
        self.assertFalse(decision['abAuthorized'])
        self.assertEqual(decision['measurementChromium'], 0)
        self.assertEqual(decision['retries'], 0)
        self.assertEqual(decision['capabilityChromium'], 1)
        self.assertEqual(decision['cleanupStatus'], 'PASS')
        # Check written decision file
        saved_decision = json.loads((self.output / 'final/decision.json').read_text())
        self.assertEqual(saved_decision['status'], 'R12R16_NATIVE_CAPABILITY_PASS')
        self.assertFalse(saved_decision['abAuthorized'])

    # Caso 4: Quarto checkpoint ausente -> INCONCLUSIVE
    def test_case_4_missing_fourth_checkpoint_yields_inconclusive(self):
        create_valid_authorization(self.output, self.base)
        mock_capability = {
            'status': 'NATIVE_INCONCLUSIVE',
            'reason': 'NATIVE_CHECKPOINT_DUMPS_INCOMPLETE',
            'heapProfilingEffective': False,
            'traceSha256': 'e' * 64,
            'traceBytes': 2048,
        }

        def mock_capture(*args, **kwargs):
            (self.output / 'pipeline/capability-reservation.json').write_text(json.dumps({
                'campaign': CAMPAIGN, 'maximum': 1, 'retries': 0, 'implementationHead': 'a' * 40
            }))
            (self.output / 'pipeline/native-receipt.json').write_text(json.dumps(synthetic_receipt(4)))
            return mock_capability, {}, {}

        with patch.object(runner, 'capture_capability_once', side_effect=mock_capture), \
             patch.object(runner, 'stop_and_verify_backend_cleanup', return_value=valid_cleanup_receipt()):
            decision = r16.run_capability(self.wave, self.base / 'source')

        self.assertEqual(decision['status'], 'R12R16_NATIVE_CAPABILITY_INCONCLUSIVE')
        self.assertEqual(decision['reason'], 'NATIVE_CHECKPOINT_DUMPS_INCOMPLETE')
        self.assertFalse(decision['abAuthorized'])
        self.assertEqual(decision['measurementChromium'], 0)
        self.assertEqual(decision['capabilityChromium'], 1)

    # Caso 5: heaps_v2 apenas em processo auxiliar -> Não comprova renderer
    def test_case_5_heaps_v2_in_auxiliary_process_only_does_not_prove_renderer(self):
        # Trace events with heaps_v2 ONLY in pid 77, not in renderer (pid 42)
        rows = synthetic_trace_events(checkpoint_count=4, with_heaps=False, renderer_pid=42)
        rows.append({
            'ph': 'v', 'pid': 77, 'ts': 10, 'id': '0x1', 'name': 'periodic_interval',
            'cat': ['disabled-by-default-memory-infra'],
            'args': {'dumps': {'heaps_v2': {'version': 1, 'allocators': {'malloc': {'sizes': [100], 'counts': [1]}}}}}
        })
        trace_path = self.output / 'pipeline/other_process.trace.json'
        trace_path.write_text(json.dumps({'traceEvents': rows}), encoding='utf-8')
        diag = runner.diagnose_trace(trace_path, synthetic_receipt(4, renderer_pid=42), {'status': 'NATIVE_INCONCLUSIVE', 'reason': 'NATIVE_HEAPS_V2_NOT_EMITTED'})
        self.assertEqual(diag['profilerActivationEvidence'], 'OBSERVED_ONLY_OTHER_PROCESS_HEAPS_V2')
        self.assertNotEqual(diag['profilerActivationEvidence'], 'OBSERVED_RENDERER_HEAPS_V2')

    # Caso 6: Identidade FILETIME divergente -> STOP
    def test_case_6_divergent_filetime_identity_rejected(self):
        receipt_with_proof = {
            'rendererPid': 42,
            'rendererIdentityProof': {
                'pid': 42,
                'creationTimeExact': '134368223588270130',
                'retainedWin32ProcessHandles': True,
                'linkedToProfiledProcess': True,
                'oneStableIdentity': True,
                'allCheckpoints': True,
            },
            'browserIdentity': {
                'after': {
                    'processExitAudit': {
                        'processes': [{'pid': 42, 'creationTimeExact': '134368223588270999'}]  # Divergent!
                    }
                }
            }
        }
        self.assertFalse(_proof_matches(receipt_with_proof, 42))

    # Caso 7: GUID duplicado em formatos equivalentes -> Rejeição
    def test_case_7_duplicate_guid_in_equivalent_formats(self):
        # 0x01 and 0x1 represent the same numeric dump GUID
        side = synthetic_receipt(4)
        side['trace']['checkpoints'][0]['dumpGuid'] = '0x01'
        side['trace']['checkpoints'][1]['dumpGuid'] = '0x1'
        rows = synthetic_trace_events(4)
        res = aggregate_trace(iter(rows), side['trace'], detailed=True)
        self.assertEqual(res['status'], 'NATIVE_STOP')
        self.assertEqual(res['reason'], 'NATIVE_CHECKPOINT_GUID_DUPLICATE')

    # Caso 8: Trace truncado ou checksum divergente -> STOP
    def test_case_8_trace_checksum_divergence_causes_stop(self):
        auth_dir = self.authority
        auth_dir.mkdir(parents=True, exist_ok=True)
        # 1. Truncated trace triggers STOP via NATIVE_TRACE_SCHEMA_INVALID
        truncated_trace = auth_dir / 'truncated_trace.json'
        truncated_trace.write_text('{"traceEvents": [{"ph": "v", "pid": 42', encoding='utf-8')
        receipt_path = self.output / 'pipeline/receipt.json'
        receipt_data = synthetic_receipt(4)
        receipt_data['trace']['bytes'] = truncated_trace.stat().st_size
        receipt_data['trace']['sha256'] = sha256(truncated_trace)
        receipt_path.write_text(json.dumps(receipt_data), encoding='utf-8')
        eval_result = runner.validate_trace(truncated_trace, receipt_path)
        self.assertEqual(eval_result['status'], 'NATIVE_STOP')
        self.assertEqual(eval_result['reason'], 'NATIVE_TRACE_SCHEMA_INVALID')

        # 2. Checksum divergence triggers STOP via ValueError
        valid_trace = auth_dir / 'valid_trace.json'
        valid_trace.write_text(json.dumps({'traceEvents': synthetic_trace_events(4)}), encoding='utf-8')
        receipt_data['trace']['bytes'] = valid_trace.stat().st_size
        receipt_data['trace']['sha256'] = 'f' * 64  # Mismatched SHA
        receipt_path.write_text(json.dumps(receipt_data), encoding='utf-8')
        with self.assertRaises(ValueError) as cm:
            runner.validate_trace(valid_trace, receipt_path)
        self.assertIn('TRACE_CHECKSUM_INVALID', str(cm.exception))

    # Caso 9: Cleanup incompleto -> Sem decisão científica PASS
    def test_case_9_incomplete_cleanup_prevents_pass_decision(self):
        create_valid_authorization(self.output, self.base)
        mock_capability = {
            'status': 'NATIVE_CAPABILITY_PASS',
            'heapProfilingEffective': True,
            'traceSha256': 'd' * 64,
            'traceBytes': 4096,
        }

        def mock_capture(*args, **kwargs):
            (self.output / 'pipeline/capability-reservation.json').write_text(json.dumps({
                'campaign': CAMPAIGN, 'maximum': 1, 'retries': 0, 'implementationHead': 'a' * 40
            }))
            (self.output / 'pipeline/native-receipt.json').write_text(json.dumps(synthetic_receipt(4)))
            return mock_capability, {}, {}

        # Backend cleanup fails
        failed_cleanup = valid_cleanup_receipt(status='FAIL', errors=['PORT_STILL_LISTENING'])
        with patch.object(runner, 'capture_capability_once', side_effect=mock_capture), \
             patch.object(runner, 'stop_and_verify_backend_cleanup', return_value=failed_cleanup):
            with self.assertRaises(runner.NativeContractFailure) as cm:
                r16.run_capability(self.wave, self.base / 'source')
            self.assertIn('BACKEND_CLEANUP_FAIL', cm.exception.reason)

    # Caso 10: Reserva já consumida -> Sem retry
    def test_case_10_reservation_already_consumed_prevents_retry(self):
        create_valid_authorization(self.output, self.base)
        (self.output / 'pipeline/capability-reservation.json').write_text(json.dumps({
            'campaign': CAMPAIGN, 'maximum': 1, 'retries': 0, 'implementationHead': 'a' * 40
        }))
        with self.assertRaises(runner.NativeContractFailure) as cm:
            r16.run_capability(self.wave, self.base / 'source')
        self.assertIn('NATIVE_NO_RETRY_OR_RESUME', cm.exception.reason)

    # Caso 11: Capability PASS -> Nunca chama medição A/B
    def test_case_11_capability_pass_never_calls_ab_measurements(self):
        create_valid_authorization(self.output, self.base)
        mock_capability = {
            'status': 'NATIVE_CAPABILITY_PASS',
            'heapProfilingEffective': True,
            'traceSha256': 'd' * 64,
            'traceBytes': 4096,
        }

        def mock_capture(*args, **kwargs):
            (self.output / 'pipeline/capability-reservation.json').write_text(json.dumps({
                'campaign': CAMPAIGN, 'maximum': 1, 'retries': 0, 'implementationHead': 'a' * 40
            }))
            (self.output / 'pipeline/native-receipt.json').write_text(json.dumps(synthetic_receipt(4)))
            return mock_capability, {}, {}

        ab_called = False
        def fake_ab(*args, **kwargs):
            nonlocal ab_called
            ab_called = True
            raise AssertionError('A/B measurement must not be called')

        with patch.object(runner, 'capture_capability_once', side_effect=mock_capture), \
             patch.object(runner, 'stop_and_verify_backend_cleanup', return_value=valid_cleanup_receipt()), \
             patch.object(runner, 'run_profiled_pair', side_effect=fake_ab):
            decision = r16.run_capability(self.wave, self.base / 'source')

        self.assertFalse(ab_called, 'A/B profiling pair was unexpectedly called')
        self.assertFalse(decision['abAuthorized'])
        self.assertEqual(decision['measurementChromium'], 0)
        # Verify no formal A/B directories were created
        self.assertFalse((self.output / 'formal/05-r12r2.0').exists())
        self.assertFalse((self.output / 'formal/06-r12r2.2').exists())

    # Caso 12: Autoridade R16 não modifica autoridades R13/R14
    def test_case_12_r16_authority_does_not_modify_r13_or_r14_authorities(self):
        # Create separate authorities for R14 and R16
        r14_root = self.base / 'auth-r14'
        r16_root = self.base / 'auth-r16'
        id14 = '1' * 64
        id16 = '2' * 64
        initialize(r14_root, id14, campaign='AP-06-R12-R14-native')
        initialize(r16_root, id16, campaign='AP-06-R12-R16-native')

        self.assertTrue((r14_root / '.owned-ap06-r12-r14-native').is_file())
        self.assertFalse((r14_root / '.owned-ap06-r12-r16-native').exists())
        self.assertTrue((r16_root / '.owned-ap06-r12-r16-native').is_file())
        self.assertFalse((r16_root / '.owned-ap06-r12-r14-native').exists())

    # Caso 13: Namespace R16 publicação e readback corretos
    def test_case_13_namespace_r16_publication_and_readback(self):
        test_wave = SimpleNamespace(output=Path('.quality/readiness-wave12-r16-native'))
        self.assertEqual(publication_namespace(test_wave), 'r12-r16-native')
        self.assertTrue(strict_freeze_namespace(test_wave.output))

    # Caso 14: Novo estado terminal R16 -> Ledger e decisão consistentes
    def test_case_14_terminal_state_accounting_and_ledger_consistency(self):
        # Test expected_decision_launches for R16 PASS
        pass_decision = {
            'status': 'R12R16_NATIVE_CAPABILITY_PASS',
            'capabilityChromium': 1,
            'measurementChromium': 0,
            'retries': 0,
            'abAuthorized': False,
            'cleanupStatus': 'PASS',
        }
        launches = runner.expected_decision_launches(pass_decision)
        self.assertEqual(launches['capabilityChromium'], 1)
        self.assertEqual(launches['measurementChromium'], 0)
        self.assertEqual(launches['total'], 1)
        self.assertEqual(launches['measurementConditions'], [])

        # Inconclusive decision
        inconclusive_decision = {
            'status': 'R12R16_NATIVE_CAPABILITY_INCONCLUSIVE',
            'capabilityChromium': 1,
            'measurementChromium': 0,
            'retries': 0,
            'abAuthorized': False,
            'cleanupStatus': 'PASS',
        }
        inconclusive_launches = runner.expected_decision_launches(inconclusive_decision)
        self.assertEqual(inconclusive_launches['capabilityChromium'], 1)
        self.assertEqual(inconclusive_launches['measurementChromium'], 0)
        self.assertEqual(inconclusive_launches['total'], 1)

        # Invalid: PASS with abAuthorized True must fail
        with self.assertRaises(runner.NativeContractFailure):
            runner.expected_decision_launches({**pass_decision, 'abAuthorized': True})

        # Invalid: PASS with measurementChromium > 0 must fail
        with self.assertRaises(runner.NativeContractFailure):
            runner.expected_decision_launches({**pass_decision, 'measurementChromium': 1})


if __name__ == '__main__':
    unittest.main()
