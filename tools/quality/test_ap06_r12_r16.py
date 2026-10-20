import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ap06_authorities import initialize, private_permissions, publish_snapshot, sha256, verify_publication
from ap06_freeze import load_native_budget, strict_freeze_namespace, validate_test_receipt
import prepare_ap06_r12_r13 as prepare_engine
import run_ap06_r12_r13_native as runner

# Save initial state before importing r16 module (which sets globals on import)
_initial_runner_state = (
    runner.CAMPAIGN, runner.OUTPUT, runner.TASK_PATH,
    getattr(runner, 'RUNNER_PATH', None), runner.COMPLETED_STATUSES, runner.NATIVE_BUDGET
)
_initial_prepare_state = (
    prepare_engine.CAMPAIGN, prepare_engine.OUTPUT,
    prepare_engine.TASK_PATH, prepare_engine.NATIVE_BUDGET
)

import run_ap06_r12_r16_native as r16

# Restore immediately so importing test_ap06_r12_r16 does not pollute any other module
(
    runner.CAMPAIGN, runner.OUTPUT, runner.TASK_PATH,
    runner.RUNNER_PATH, runner.COMPLETED_STATUSES, runner.NATIVE_BUDGET
) = _initial_runner_state
(
    prepare_engine.CAMPAIGN, prepare_engine.OUTPUT,
    prepare_engine.TASK_PATH, prepare_engine.NATIVE_BUDGET
) = _initial_prepare_state

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
    output = base / OUTPUT
    for name in ('baseline', 'pipeline', 'tooling', 'final', 'formal'):
        (output / name).mkdir(parents=True, exist_ok=True)
    (output / 'baseline/authority-config.local.json').write_text(json.dumps(
        {'AP06_AUTHORITY_ROOT': str(authority), 'identity': identity}), encoding='utf-8')
    wave = SimpleNamespace(
        root=base,
        output=output,
        temp=base / 'temp',
        node='node',
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


_LOCK_WORKER_CODE = """
import sys
from pathlib import Path
from types import SimpleNamespace
import run_ap06_r12_r13_native as runner

output_dir = Path(sys.argv[1])
cmd = sys.argv[2]
wave = SimpleNamespace(output=output_dir)

if cmd == 'hold':
    try:
        with runner.execution_lock(wave):
            print("ACQUIRED", flush=True)
            line = sys.stdin.readline()
            if line.strip() == "RELEASE":
                sys.exit(0)
            sys.exit(1)
    except runner.NativeContractFailure as e:
        print(f"REJECTED:{e.reason}", flush=True)
        sys.exit(42)
    except Exception as e:
        print(f"ERROR:{type(e).__name__}", flush=True)
        sys.exit(99)

elif cmd == 'try':
    try:
        with runner.execution_lock(wave):
            print("ACQUIRED", flush=True)
            sys.exit(0)
    except runner.NativeContractFailure as e:
        print(f"REJECTED:{e.reason}", flush=True)
        sys.exit(42)
    except Exception as e:
        print(f"ERROR:{type(e).__name__}", flush=True)
        sys.exit(99)

elif cmd == 'barrier':
    sys.stdin.readline()
    try:
        with runner.execution_lock(wave):
            print("ACQUIRED", flush=True)
            import time
            time.sleep(0.3)
            sys.exit(0)
    except runner.NativeContractFailure as e:
        print(f"REJECTED:{e.reason}", flush=True)
        sys.exit(42)
    except Exception as e:
        print(f"ERROR:{type(e).__name__}", flush=True)
        sys.exit(99)
"""


class TestAp06R16ControlledCapability(unittest.TestCase):
    def setUp(self):
        self._prev_runner_state = (
            runner.CAMPAIGN, runner.OUTPUT, runner.TASK_PATH,
            getattr(runner, 'RUNNER_PATH', None), runner.COMPLETED_STATUSES, runner.NATIVE_BUDGET
        )
        self._prev_prepare_state = (
            prepare_engine.CAMPAIGN, prepare_engine.OUTPUT,
            prepare_engine.TASK_PATH, prepare_engine.NATIVE_BUDGET
        )
        self.temp_dir = tempfile.TemporaryDirectory(prefix='ap06-r16-test-')
        self.base = Path(self.temp_dir.name)
        self.wave, self.output, self.authority, self.identity = setup_test_wave(self.base)
        prepare_engine.configure_campaign(CAMPAIGN, OUTPUT, TASK_PATH, budget=r16.R16_BUDGET)
        runner.configure_campaign(CAMPAIGN, OUTPUT, TASK_PATH, r16.RUNNER_PATH, budget=r16.R16_BUDGET)

    def tearDown(self):
        (
            runner.CAMPAIGN, runner.OUTPUT, runner.TASK_PATH,
            runner.RUNNER_PATH, runner.COMPLETED_STATUSES, runner.NATIVE_BUDGET
        ) = self._prev_runner_state
        (
            prepare_engine.CAMPAIGN, prepare_engine.OUTPUT,
            prepare_engine.TASK_PATH, prepare_engine.NATIVE_BUDGET
        ) = self._prev_prepare_state
        self.temp_dir.cleanup()

    # Caso 1: Execução offline sem chave ou fingerprint
    def test_case_1_offline_execution_without_keys_or_fingerprints(self):
        auth_file = self.output / 'baseline/scientific-authorization.json'
        anchor_file = self.output / 'baseline/scientific-trust-anchor.json'
        self.assertFalse(auth_file.exists())
        self.assertFalse(anchor_file.exists())

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
             patch.object(runner, 'stop_and_verify_backend_cleanup', return_value=valid_cleanup_receipt()):
            decision = r16.run_capability(self.wave, self.base / 'source')

        self.assertEqual(decision['status'], 'R12R16_NATIVE_CAPABILITY_PASS')
        self.assertEqual(decision['capabilityChromium'], 1)
        self.assertEqual(decision['measurementChromium'], 0)
        self.assertFalse(decision['abAuthorized'])

    # Caso 2: Preflight e freeze sem lançar Chromium nem criar reserva
    def test_case_2_preflight_and_freeze_without_launching_chromium(self):
        freeze_file = self.output / 'tooling/freeze.json'
        reservation_file = self.output / 'pipeline/capability-reservation.json'
        self.assertFalse(freeze_file.exists())
        self.assertFalse(reservation_file.exists())

        head = self.wave.git('rev-parse', 'HEAD').strip()
        (self.output / 'baseline/ci.json').write_text(json.dumps({'headSha': head}))
        (self.output / 'baseline/browser-identity.json').write_text('{}')
        (self.output / 'baseline/preregistered-protocol.json').write_text('{}')
        (self.output / 'baseline/historical-factorial-gate.json').write_text('{}')

        def mock_freeze_impl(*args, **kwargs):
            self.output.joinpath('tooling/freeze.json').write_text(json.dumps({
                'status': 'FROZEN', 'implementationHead': head
            }))

        with patch.object(runner, 'validate_freeze_readiness', return_value={'status': 'PASS'}), \
             patch.object(runner, 'freeze_implementation', side_effect=mock_freeze_impl), \
             patch.object(runner, 'verify_freeze'), \
             patch.object(runner, 'verify_freeze_completion'), \
             patch('ap06_key_custody.readback', return_value={'status': 'PASS'}), \
             patch.object(runner, 'capture_capability_once', side_effect=AssertionError('Chromium must not be launched during freeze')):
            freeze_res = runner.freeze_campaign(self.wave)

        self.assertTrue(freeze_file.exists())
        self.assertFalse(reservation_file.exists())
        self.assertEqual(freeze_res.get('status'), 'FROZEN')

    # Caso 3: Capability sintética válida -> PASS de capability, zero A/B
    def test_case_3_synthetic_valid_capability_yields_capability_pass_and_zero_ab(self):
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
        self.assertTrue(decision['capability']['heapProfilingEffective'])
        self.assertEqual(decision['capability']['traceSha256'], 'd' * 64)

        saved_decision = json.loads((self.output / 'final/decision.json').read_text())
        self.assertEqual(saved_decision['status'], 'R12R16_NATIVE_CAPABILITY_PASS')
        self.assertFalse(saved_decision['abAuthorized'])

    # Caso 4: Quarto checkpoint ausente -> INCONCLUSIVE
    def test_case_4_missing_fourth_checkpoint_yields_inconclusive(self):
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
                        'processes': [{'pid': 42, 'creationTimeExact': '134368223588270999'}]
                    }
                }
            }
        }
        self.assertFalse(_proof_matches(receipt_with_proof, 42))

    # Caso 7: GUID duplicado em formatos equivalentes -> Rejeição
    def test_case_7_duplicate_guid_in_equivalent_formats(self):
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

        valid_trace = auth_dir / 'valid_trace.json'
        valid_trace.write_text(json.dumps({'traceEvents': synthetic_trace_events(4)}), encoding='utf-8')
        receipt_data['trace']['bytes'] = valid_trace.stat().st_size
        receipt_data['trace']['sha256'] = 'f' * 64
        receipt_path.write_text(json.dumps(receipt_data), encoding='utf-8')
        with self.assertRaises(ValueError) as cm:
            runner.validate_trace(valid_trace, receipt_path)
        self.assertIn('TRACE_CHECKSUM_INVALID', str(cm.exception))

    # Caso 9: Cleanup incompleto -> Sem decisão científica PASS
    def test_case_9_incomplete_cleanup_prevents_pass_decision(self):
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

        failed_cleanup = valid_cleanup_receipt(status='FAIL', errors=['PORT_STILL_LISTENING'])
        with patch.object(runner, 'capture_capability_once', side_effect=mock_capture), \
             patch.object(runner, 'stop_and_verify_backend_cleanup', return_value=failed_cleanup):
            with self.assertRaises(runner.NativeContractFailure) as cm:
                r16.run_capability(self.wave, self.base / 'source')
            self.assertIn('BACKEND_CLEANUP_FAIL', cm.exception.reason)

    # Caso 10: Reserva já consumida -> Sem retry
    def test_case_10_reservation_already_consumed_prevents_retry(self):
        (self.output / 'pipeline/capability-reservation.json').write_text(json.dumps({
            'campaign': CAMPAIGN, 'maximum': 1, 'retries': 0, 'implementationHead': 'a' * 40
        }))
        with self.assertRaises((runner.NativeContractFailure, ValueError)) as cm:
            r16.run_capability(self.wave, self.base / 'source')
        reason = getattr(cm.exception, 'reason', str(cm.exception))
        self.assertIn('NATIVE_NO_RETRY_OR_RESUME', reason)

    # Caso 11: Capability PASS -> Nunca chama medição A/B
    def test_case_11_capability_pass_never_calls_ab_measurements(self):
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
        self.assertFalse((self.output / 'formal/05-r12r2.0').exists())
        self.assertFalse((self.output / 'formal/06-r12r2.2').exists())

    # Caso 12: Autoridade R16 não modifica autoridades R13/R14
    def test_case_12_r16_authority_does_not_modify_r13_or_r14_authorities(self):
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

        # Invalid: R16 rejecting A/B decisions
        ab_decision = {
            'status': 'R12R16_NATIVE_TRACKED_AGGREGATES_OBSERVED',
            'capabilityChromium': 1,
            'measurementChromium': 2,
            'retries': 0,
            'abAuthorized': True,
            'results': [{'condition': 'r12r2.0', 'native': {'status': 'NATIVE_CAPABILITY_PASS'}},
                        {'condition': 'r12r2.2', 'native': {'status': 'NATIVE_CAPABILITY_PASS'}}],
            'cleanupStatus': 'PASS',
        }
        with self.assertRaises(runner.NativeContractFailure):
            runner.expected_decision_launches(ab_decision)

    # Caso 15: R13/R14 rejeitam status exclusivo de PASS da R16
    def test_case_15_r13_r14_reject_r16_capability_pass(self):
        # Configure runner as R14
        runner.configure_campaign('AP-06-R12-R14-native', '.quality/readiness-wave12-r14-native', 'quality/ap06-r12-r14.md')
        decision = {
            'status': 'R12R16_NATIVE_CAPABILITY_PASS',
            'capabilityChromium': 1,
            'measurementChromium': 0,
            'retries': 0,
            'abAuthorized': False,
            'cleanupStatus': 'PASS',
        }
        with self.assertRaises(runner.NativeContractFailure) as cm:
            runner.expected_decision_launches(decision)
        self.assertEqual(cm.exception.reason, 'NATIVE_DECISION_STATUS_INVALID')

        # Also R14 capability pass decision function check
        with self.assertRaises(runner.NativeContractFailure):
            runner.publish_capability_pass_decision(self.wave, {'status': 'NATIVE_CAPABILITY_PASS', 'heapProfilingEffective': True, 'traceSha256': 'a' * 64})

    # Caso 16: Erros de pré-lançamento produzem erro de engenharia SEM STOP científico
    def test_case_16_prelaunch_errors_produce_engineering_blocked_report_without_stop(self):
        def mock_prelaunch_failure(*args, **kwargs):
            raise runner.NativeContractFailure('R16_PRELAUNCH_ENVIRONMENT_INVALID')

        with patch.object(runner, 'OUTPUT', str(self.output.relative_to(self.base))), \
             patch.object(runner, 'CAMPAIGN', CAMPAIGN), \
             patch.object(runner, 'capture_capability_once', side_effect=mock_prelaunch_failure), \
             patch('sys.argv', ['run_ap06_r12_r16_native.py', '--run-capability', '--source-output', str(self.base / 'source')]), \
             patch('sys.exit') as mock_exit:
            ret = runner.main(wave_root=self.base)
            self.assertEqual(ret, 1)

        # Confirm NO STOP.json was created on disk
        self.assertFalse((self.output / 'final/STOP.json').exists())
        self.assertFalse((self.output / 'pipeline/capability-reservation.json').exists())

    # Caso 17: Erro após reserva registra STOP durável com reserva preservada
    def test_case_17_post_reservation_error_records_durable_stop(self):
        def mock_capture_with_error(*args, **kwargs):
            # Create reservation first
            (self.output / 'pipeline/capability-reservation.json').write_text(json.dumps({
                'campaign': CAMPAIGN, 'maximum': 1, 'retries': 0, 'implementationHead': 'a' * 40
            }))
            # Then simulate execution error
            raise runner.NativeContractFailure('NATIVE_TRACE_CHECKSUM_INVALID')

        with patch.object(runner, 'OUTPUT', str(self.output.relative_to(self.base))), \
             patch.object(runner, 'CAMPAIGN', CAMPAIGN), \
             patch.object(runner, 'capture_capability_once', side_effect=mock_capture_with_error), \
             patch('sys.argv', ['run_ap06_r12_r16_native.py', '--run-capability', '--source-output', str(self.base / 'source')]):
            ret = runner.main(wave_root=self.base)
            self.assertEqual(ret, 1)

        # Reservation is preserved and STOP.json IS recorded
        self.assertTrue((self.output / 'pipeline/capability-reservation.json').exists())
        self.assertTrue((self.output / 'final/STOP.json').exists())
        stop_data = json.loads((self.output / 'final/STOP.json').read_text())
        self.assertEqual(stop_data['status'], 'STOP')
        self.assertTrue(stop_data['reservationCreated'])

    # Caso 18: Preflight relata pronto para capability sem exigir autorização
    def test_case_18_offline_preflight_reports_ready_for_capability_without_authorization(self):
        auth_file = self.output / 'baseline/scientific-authorization.json'
        self.assertFalse(auth_file.exists())

        source_dir = self.base / 'source'
        (source_dir / 'final').mkdir(parents=True, exist_ok=True)
        (source_dir / 'final/decision.json').write_text(json.dumps({
            'status': 'R12R12_FACTORIAL_CONFIRMED', 'campaign': 'AP-06-R12-R12-factorial'
        }))
        (source_dir / 'tooling').mkdir(parents=True, exist_ok=True)
        (source_dir / 'tooling/kasumi.cjs').write_text('// kasumi')

        # Mock necessary baseline files
        (self.output / 'baseline/browser-identity.json').write_text(json.dumps({
            'chromiumVersion': '151.0.7922.34', 'playwrightVersion': '1.62.1', 'executablePath': 'c.exe', 'executableSha256': 'a' * 64
        }))
        for f in ('experimental-backend.json', 'backend-isolation.json', 'listener-isolation.json',
                  'network-spoof-guard.json', 'network-spoof-recovery.json', 'startup-rejections.json',
                  'backend-runtime.local.json', 'player-auth.local.json', 'backend-authority.json',
                  'runtime-credentials.dpapi', 'runtime-credentials-custody.json', 'runtime-credentials-readback.json'):
            (self.output / 'baseline' / f).write_text(json.dumps({'crowHeaderSha256': 'a' * 64}))
        for name in ('native-production.xml', 'native-experimental.xml'):
            (self.output / 'baseline' / name).write_text('<catch></catch>')
        task_file = self.base / TASK_PATH
        task_file.parent.mkdir(parents=True, exist_ok=True)
        task_file.write_text('synthetic')
        (self.output / 'baseline/task.md').write_text('synthetic')
        (self.output / 'baseline/task-provenance.json').write_text(json.dumps({'sourceSha256': sha256(task_file)}))
        (self.output / 'baseline/historical-factorial-gate.json').write_text(json.dumps({'status': 'PASS'}))
        (self.output / 'fixtures/manifest.json').parent.mkdir(parents=True, exist_ok=True)
        (self.output / 'fixtures/manifest.json').write_text('{}')
        (self.base / 'docs/qualidade').mkdir(parents=True, exist_ok=True)
        (self.base / 'docs/qualidade/ap06-r9-r2.json').write_text('{}')

        backend_build = self.output / 'tooling/backend-build'
        backend_build.mkdir(parents=True, exist_ok=True)
        from ap06_freeze import NATIVE_FILES
        for name in NATIVE_FILES.values():
            (backend_build / name).write_text('dummy')

        def fake_command(name, *args, **kwargs):
            self.wave.save(f'pipeline/commands/{name}.json', {'name': name, 'exitCode': 0, 'status': 'PASS'})
        self.wave.command = fake_command

        with patch('ap06_browser_identity.verify_identity', return_value={'status': 'PASS'}), \
             patch('run_backend_shards.parse_catch_report', return_value={'assertion_failures': 0, 'case_failures': 0, 'expected_failures': 0, 'assertion_successes': 1, 'case_successes': 1}), \
             patch.object(runner, 'validate_native_build_authority'), \
             patch('run_ap06_r12_r2.validate_r8_native_tests'), \
             patch.object(runner, 'native_source_files', return_value={}), \
             patch('run_ap06_integration_probe.build_products', return_value=([], {}, {})), \
             patch.object(runner, 'verify_historical_factorial'), \
             patch('ap06_key_custody.readback', return_value={'status': 'PASS'}), \
             patch('sys.platform', 'win32'), patch('os.name', 'nt'):
            res = runner.offline_preflight(self.wave, source_dir)

        self.assertEqual(res['status'], 'PASS')
        self.assertEqual(res['classification'], 'R16_ENGINEERING_READY_FOR_CAPABILITY')
        self.assertEqual(res['scientificChromium'], 0)
        self.assertFalse(res['reservationCreated'])
        self.assertNotIn('scientificAuthorizationPresent', res)
        self.assertNotIn('authorizationVerified', res)
        self.assertFalse((self.output / 'pipeline/capability-reservation.json').exists())
        tests_data = json.loads((self.output / 'baseline/tests.json').read_text(encoding='utf-8'))
        self.assertEqual(tests_data.get('global', {}).get('status'), 'PASS')
        self.assertIn('receiptSha256', tests_data.get('global', {}))

    # Caso 19: CLI separa --run e --run-capability e exige --source-output
    def test_case_19_cli_action_separation_and_arguments(self):
        # In R16, --run is rejected
        with patch.object(runner, 'OUTPUT', str(self.output.relative_to(self.base))), \
             patch.object(runner, 'CAMPAIGN', CAMPAIGN), \
             patch('sys.argv', ['run_ap06_r12_r16_native.py', '--run', '--source-output', str(self.base / 'source')]):
            ret = runner.main(wave_root=self.base)
            self.assertEqual(ret, 1)
        self.assertFalse((self.output / 'final/STOP.json').exists())

        # In R14, --run-capability is rejected
        runner.configure_campaign('AP-06-R12-R14-native', '.quality/readiness-wave12-r14-native', 'quality/ap06-r12-r14.md')
        with patch.object(runner, 'OUTPUT', str(self.output.relative_to(self.base))), \
             patch.object(runner, 'CAMPAIGN', 'AP-06-R12-R14-native'), \
             patch('sys.argv', ['run_ap06_r12_r13_native.py', '--run-capability', '--source-output', str(self.base / 'source')]):
            ret = runner.main(wave_root=self.base)
            self.assertEqual(ret, 1)

    # Caso 20: Freeze global gate estrito na R16
    def test_case_20_freeze_global_gate_strict_in_r16(self):
        r16_out = Path('.quality/readiness-wave12-r16-native')
        valid_tests = {
            'status': 'PASS',
            'python': {'status': 'PASS'},
            'node': {'status': 'PASS'},
            'typescript': {'status': 'PASS'},
            'angularBuild': {'status': 'PASS'},
            'native': {'status': 'PASS'},
        }
        # In R16, missing global gate MUST BE REJECTED
        with self.assertRaises(ValueError) as cm:
            validate_test_receipt(r16_out, valid_tests)
        self.assertIn('AP06_FREEZE_TEST_AUTHORITY_INVALID', str(cm.exception))

        # If global is present with PASS -> accepted
        tests_with_global_pass = copy.deepcopy(valid_tests)
        tests_with_global_pass['global'] = {'status': 'PASS'}
        validate_test_receipt(r16_out, tests_with_global_pass)

        # If global is present with DOCUMENTED_EXCEPTION -> REJECTED in R16!
        tests_with_global_ex = copy.deepcopy(valid_tests)
        tests_with_global_ex['global'] = {'status': 'DOCUMENTED_EXCEPTION'}
        with self.assertRaises(ValueError) as cm:
            validate_test_receipt(r16_out, tests_with_global_ex)
        self.assertIn('AP06_FREEZE_TEST_AUTHORITY_INVALID', str(cm.exception))

        # In R11/R12, DOCUMENTED_EXCEPTION for global is accepted
        r11_out = Path('.quality/readiness-wave12-r11-factorial')
        validate_test_receipt(r11_out, tests_with_global_ex)

        # In R13 and R14, global is not required at all (historical preservation)
        r13_out = Path('.quality/readiness-wave12-r13-native')
        r14_out = Path('.quality/readiness-wave12-r14-native')
        validate_test_receipt(r13_out, valid_tests)
        validate_test_receipt(r14_out, valid_tests)

    # Caso 21: Integração sintética ponta a ponta (Mock CDP -> trace -> validate -> decision -> readback)
    def test_case_21_end_to_end_synthetic_integration(self):
        # 1. Generate 4-checkpoint trace under temp dir
        temp_dir = Path(tempfile.mkdtemp(prefix='ap06-e2e-trace-'))
        try:
            trace_file = temp_dir / 'synthetic_e2e.trace.json'
            trace_rows = synthetic_trace_events(checkpoint_count=4, with_heaps=True, renderer_pid=42)
            trace_file.write_text(json.dumps({'traceEvents': trace_rows}), encoding='utf-8')

            receipt = synthetic_receipt(checkpoint_count=4, renderer_pid=42)
            receipt['trace']['bytes'] = trace_file.stat().st_size
            receipt['trace']['sha256'] = sha256(trace_file)
            receipt_path = temp_dir / 'receipt.json'
            receipt_path.write_text(json.dumps(receipt), encoding='utf-8')

            # 2. Validate trace
            cap = runner.validate_trace(trace_file, receipt_path, synthetic=True)
            self.assertEqual(cap['status'], 'NATIVE_CAPABILITY_PASS')
            self.assertTrue(cap['heapProfilingEffective'])
            self.assertEqual(cap['traceSha256'], sha256(trace_file))

            # 3. Record reservation and simulated execution state
            (self.output / 'pipeline/capability-reservation.json').write_text(json.dumps({
                'campaign': CAMPAIGN, 'maximum': 1, 'retries': 0, 'implementationHead': 'a' * 40
            }))
            (self.output / 'pipeline/native-receipt.json').write_text(json.dumps(receipt), encoding='utf-8')

            # 4. Publish decision
            with patch.object(runner, 'stop_and_verify_backend_cleanup', return_value=valid_cleanup_receipt()):
                decision = runner.publish_capability_pass_decision(self.wave, cap)

            self.assertEqual(decision['status'], 'R12R16_NATIVE_CAPABILITY_PASS')
            self.assertEqual(decision['capabilityChromium'], 1)
            self.assertEqual(decision['measurementChromium'], 0)
            self.assertFalse(decision['abAuthorized'])

            # 5. Verify publication readback from authority
            config = json.loads((self.output / 'baseline/authority-config.local.json').read_text())
            manifest = verify_publication(self.authority, config['identity'], 'r12-r16-native-decision')
            entry = next((f for f in manifest.get('files', []) if f.get('path') == 'r12-r16-native/evidence/decision.json'), None)
            self.assertIsNotNone(entry)
            self.assertEqual(entry['sha256'], sha256(self.output / 'final/decision.json'))
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    # Caso 22: Múltiplos cenários de integração real Node (Mock CDP -> NativeTrace -> Trace stream -> Python)
    def test_case_22_real_node_producer_integration_scenarios(self):
        temp_dir = Path(tempfile.mkdtemp(prefix='ap06-node-prod-'))
        try:
            producer_script = Path(__file__).resolve().parent / 'produce_synthetic_native_trace.mjs'
            node_exe = getattr(self.wave, 'node', 'node')

            # 22.1 Scenario: valid (4 dumps with heaps_v2) -> PASS
            t1 = temp_dir / 'valid.trace.json'
            r1 = temp_dir / 'valid.receipt.json'
            res = subprocess.run([str(node_exe), str(producer_script), str(t1), str(r1), 'valid'],
                                 capture_output=True, text=True, check=True)
            self.assertIn('"status":"PRODUCED"', res.stdout)
            cap1 = runner.validate_trace(t1, r1, synthetic=True)
            self.assertEqual(cap1['status'], 'NATIVE_CAPABILITY_PASS')
            self.assertTrue(cap1['heapProfilingEffective'])

            # 22.2 Scenario: missing-dump-4 -> INCONCLUSIVE
            t2 = temp_dir / 'missing4.trace.json'
            r2 = temp_dir / 'missing4.receipt.json'
            subprocess.run([str(node_exe), str(producer_script), str(t2), str(r2), 'missing-dump-4'],
                           capture_output=True, text=True, check=True)
            cap2 = runner.validate_trace(t2, r2, synthetic=True)
            self.assertEqual(cap2['status'], 'NATIVE_INCONCLUSIVE')
            self.assertEqual(cap2.get('reason'), 'NATIVE_HEAPS_V2_INCOMPLETE')

            # 22.3 Scenario: other-process-heaps -> INCONCLUSIVE (does not prove renderer)
            t3 = temp_dir / 'otherproc.trace.json'
            r3 = temp_dir / 'otherproc.receipt.json'
            subprocess.run([str(node_exe), str(producer_script), str(t3), str(r3), 'other-process-heaps'],
                           capture_output=True, text=True, check=True)
            cap3 = runner.validate_trace(t3, r3, synthetic=True)
            self.assertEqual(cap3['status'], 'NATIVE_INCONCLUSIVE')

            # 22.4 Scenario: divergent-filetime -> STOP
            t4 = temp_dir / 'divergent.trace.json'
            r4 = temp_dir / 'divergent.receipt.json'
            subprocess.run([str(node_exe), str(producer_script), str(t4), str(r4), 'divergent-filetime'],
                           capture_output=True, text=True, check=True)
            cap4 = runner.validate_trace(t4, r4, synthetic=True)
            self.assertEqual(cap4['status'], 'NATIVE_INCONCLUSIVE')
            self.assertEqual(cap4.get('reason'), 'NATIVE_RENDERER_METADATA_MISSING')

            # 22.5 Scenario: stream-interrupted -> producer fails and cleans up partial trace
            t5 = temp_dir / 'interrupted.trace.json'
            r5 = temp_dir / 'interrupted.receipt.json'
            res5 = subprocess.run([str(node_exe), str(producer_script), str(t5), str(r5), 'stream-interrupted'],
                                  capture_output=True, text=True)
            self.assertNotEqual(res5.returncode, 0)
            self.assertFalse(t5.exists())

            # 22.6 Scenario: duplicate-guids -> NativeTrace.dump rejects duplicate GUID in receipt
            t6 = temp_dir / 'dup.trace.json'
            r6 = temp_dir / 'dup.receipt.json'
            res6 = subprocess.run([str(node_exe), str(producer_script), str(t6), str(r6), 'duplicate-guids'],
                                  capture_output=True, text=True)
            self.assertNotEqual(res6.returncode, 0)
            self.assertIn('NATIVE_DUMP_RECEIPT_INVALID', res6.stderr)

            # 22.7 Scenario: timeout-checkpoint-3 -> checkpoint timeout triggers controlled failure
            t7 = temp_dir / 'timeout.trace.json'
            r7 = temp_dir / 'timeout.receipt.json'
            res7 = subprocess.run([str(node_exe), str(producer_script), str(t7), str(r7), 'timeout-checkpoint-3'],
                                  capture_output=True, text=True)
            self.assertNotEqual(res7.returncode, 0)
            self.assertIn('NATIVE_CDP_TIMEOUT', res7.stderr)

            # 22.8 Scenario: trace-size-limit -> chunk exceeds bounds, writeTraceStream aborts & unlinks partial
            t8 = temp_dir / 'limit.trace.json'
            r8 = temp_dir / 'limit.receipt.json'
            res8 = subprocess.run([str(node_exe), str(producer_script), str(t8), str(r8), 'trace-size-limit'],
                                  capture_output=True, text=True)
            self.assertNotEqual(res8.returncode, 0)
            self.assertFalse(t8.exists())
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    # Caso 23: Exclusão mútua entre processos, liberação normal e segurança de erros (Cenários A, B, E)
    def test_case_23_process_mutual_exclusion_and_normal_release(self):
        tools_dir = Path(__file__).resolve().parent
        env = os.environ.copy()
        env['PYTHONPATH'] = str(tools_dir) + os.pathsep + env.get('PYTHONPATH', '')
        env['PYTHONUNBUFFERED'] = '1'

        lock_file = self.output / 'pipeline/.execution.lock'
        self.assertFalse(lock_file.exists())
        procs_to_cleanup = []

        try:
            # --- Cenário A: Exclusão entre processos ---
            # 1. Processo A abre e adquire o lock
            proc_a = subprocess.Popen(
                [sys.executable, '-c', _LOCK_WORKER_CODE, str(self.output), 'hold'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, env=env
            )
            procs_to_cleanup.append(proc_a)

            # 2. A confirma a aquisição por um sinal observável
            line = proc_a.stdout.readline().strip()
            self.assertEqual(line, 'ACQUIRED')
            self.assertTrue(lock_file.exists())

            # 3. Processo B tenta adquirir o mesmo lock
            proc_b = subprocess.Popen(
                [sys.executable, '-c', _LOCK_WORKER_CODE, str(self.output), 'try'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, env=env
            )
            procs_to_cleanup.append(proc_b)
            out_b, _ = proc_b.communicate(timeout=10)

            # 4. B recebe R16_CONCURRENT_INVOCATION_REJECTED
            self.assertEqual(proc_b.returncode, 42)
            self.assertIn('REJECTED:R16_CONCURRENT_INVOCATION_REJECTED', out_b)

            # 5. B não entra na seção crítica
            self.assertNotIn('ACQUIRED', out_b)

            # 6. A permanece com a posse até ser liberado
            self.assertIsNone(proc_a.poll())

            # --- Cenário B: Liberação normal ---
            # 1. A libera o lock e encerra
            proc_a.stdin.write('RELEASE\n')
            proc_a.stdin.flush()
            proc_a.communicate(timeout=10)
            self.assertEqual(proc_a.returncode, 0)

            # 2. Outro processo adquire o mesmo arquivo com sucesso
            proc_c = subprocess.Popen(
                [sys.executable, '-c', _LOCK_WORKER_CODE, str(self.output), 'try'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, env=env
            )
            procs_to_cleanup.append(proc_c)
            out_c, _ = proc_c.communicate(timeout=10)
            self.assertEqual(proc_c.returncode, 0)
            self.assertIn('ACQUIRED', out_c)

            # 3. Confirmar que .execution.lock continua existindo
            self.assertTrue(lock_file.exists())

            # 4. Confirmar ausência de processos remanescentes
            for p in (proc_a, proc_b, proc_c):
                self.assertIsNotNone(p.poll())

            # --- Cenário E: Erros e recuperação ---
            # Erro dentro do bloco protegido deve liberar o lock
            try:
                with runner.execution_lock(self.wave):
                    raise RuntimeError("simulated_protected_failure")
            except RuntimeError as exc:
                self.assertEqual(str(exc), "simulated_protected_failure")

            # Tentativa posterior válida adquire e libera com sucesso
            with runner.execution_lock(self.wave):
                pass
            self.assertTrue(lock_file.exists())

            # Falha de abertura (ex: lock_file como diretório) não relata sucesso
            # e levanta OSError em vez de NativeContractFailure
            sub_td = tempfile.mkdtemp(dir=str(self.base))
            err_output = Path(sub_td)
            fake_lock_dir = err_output / 'pipeline/.execution.lock'
            fake_lock_dir.mkdir(parents=True, exist_ok=True)
            err_wave = SimpleNamespace(output=err_output)
            with self.assertRaises(OSError) as ctx:
                with runner.execution_lock(err_wave):
                    pass
            self.assertNotIsInstance(ctx.exception, runner.NativeContractFailure)
        finally:
            for p in procs_to_cleanup:
                for pipe in (p.stdin, p.stdout, p.stderr):
                    if pipe and not pipe.closed:
                        try:
                            pipe.close()
                        except Exception:
                            pass
                if p.poll() is None:
                    try:
                        p.kill()
                        p.wait(timeout=5)
                    except Exception:
                        pass

    # Caso 24: Estado científico existente distinguido de erro de pré-lançamento
    def test_case_24_existing_scientific_state_distinguished_from_prelaunch(self):
        # Pre-create a durable reservation from a previous attempt
        (self.output / 'pipeline/capability-reservation.json').write_text(json.dumps({
            'campaign': CAMPAIGN, 'maximum': 1, 'retries': 0, 'implementationHead': 'a' * 40
        }))
        # Also create a simulated receipt with 1 launch attempt
        (self.output / 'pipeline/native-receipt.json').write_text(json.dumps({
            'launchAttempts': 1, 'browserLaunches': 1, 'unverifiedConsumption': True
        }))

        with patch.object(runner, 'OUTPUT', str(self.output.relative_to(self.base))), \
             patch.object(runner, 'CAMPAIGN', CAMPAIGN), \
             patch('sys.argv', ['run_ap06_r12_r16_native.py', '--run-capability', '--source-output', str(self.base / 'source')]), \
             patch('builtins.print') as mock_print:
            ret = runner.main(wave_root=self.base)
            self.assertEqual(ret, 1)

        # Confirm output reports existing scientific state without presuming zero consumption
        printed_reports = [json.loads(call.args[0]) for call in mock_print.call_args_list if call.args]
        self.assertTrue(len(printed_reports) >= 1)
        rep = printed_reports[-1]
        self.assertEqual(rep['classification'], 'R16_EXISTING_SCIENTIFIC_STATE')
        self.assertTrue(rep['reservationCreated'])
        self.assertFalse(rep['newLaunchAuthorized'])
        self.assertFalse(rep['newLaunchPerformed'])
        self.assertEqual(rep['scientificChromium'], 'UNVERIFIED')

    # Caso 25: Recuperação de crash, disputa simultânea e irreversibilidade científica (Cenários C, D, F)
    def test_case_25_crash_recovery_and_simultaneous_contention(self):
        tools_dir = Path(__file__).resolve().parent
        env = os.environ.copy()
        env['PYTHONPATH'] = str(tools_dir) + os.pathsep + env.get('PYTHONPATH', '')
        env['PYTHONUNBUFFERED'] = '1'

        lock_file = self.output / 'pipeline/.execution.lock'
        procs_to_cleanup = []

        try:
            # --- Cenário C: Recuperação após crash ---
            # 1. A adquire o lock
            proc_a = subprocess.Popen(
                [sys.executable, '-c', _LOCK_WORKER_CODE, str(self.output), 'hold'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, env=env
            )
            procs_to_cleanup.append(proc_a)
            line = proc_a.stdout.readline().strip()
            self.assertEqual(line, 'ACQUIRED')
            self.assertTrue(lock_file.exists())

            # 2. O processo pai encerra A abruptamente com kill()
            proc_a.kill()
            # 3. Após wait(), B tenta adquirir o lock
            proc_a.wait(timeout=5)
            self.assertIsNotNone(proc_a.poll())
            for pipe in (proc_a.stdin, proc_a.stdout, proc_a.stderr):
                if pipe and not pipe.closed:
                    try:
                        pipe.close()
                    except Exception:
                        pass

            # 4. B obtém posse sem excluir, substituir ou recriar o arquivo
            proc_b = subprocess.Popen(
                [sys.executable, '-c', _LOCK_WORKER_CODE, str(self.output), 'try'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, env=env
            )
            procs_to_cleanup.append(proc_b)
            out_b, _ = proc_b.communicate(timeout=10)
            self.assertEqual(proc_b.returncode, 0)
            self.assertIn('ACQUIRED', out_b)

            # 5. Nenhum PID é consultado, arquivo permanece no disco
            self.assertTrue(lock_file.exists())

            # --- Cenário D: Disputa simultânea ---
            # Iniciar 3 subprocessos competindo pelo mesmo caminho, liberados por uma barreira
            sim_procs = [
                subprocess.Popen(
                    [sys.executable, '-c', _LOCK_WORKER_CODE, str(self.output), 'barrier'],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True, env=env
                )
                for _ in range(3)
            ]
            procs_to_cleanup.extend(sim_procs)

            for p in sim_procs:
                p.stdin.write('GO\n')
                p.stdin.flush()

            results = []
            for p in sim_procs:
                out, _ = p.communicate(timeout=15)
                results.append((p.returncode, out.strip()))

            acquired_count = sum(1 for code, out in results if code == 0 and 'ACQUIRED' in out)
            rejected_count = sum(1 for code, out in results if code == 42 and 'REJECTED:R16_CONCURRENT_INVOCATION_REJECTED' in out)

            # Exatamente um entra na seção crítica por vez; os demais são rejeitados
            self.assertEqual(acquired_count, 1)
            self.assertEqual(rejected_count, 2)
            self.assertTrue(lock_file.exists())

            # --- Cenário F: Irreversibilidade científica ---
            # Criar uma reserva científica sintética já persistida em disco
            reservation_file = self.output / 'pipeline/capability-reservation.json'
            reservation_file.parent.mkdir(parents=True, exist_ok=True)
            reservation_file.write_text(json.dumps({
                'campaign': CAMPAIGN,
                'maximum': 1,
                'retries': 0,
                'implementationHead': 'a' * 40,
            }), encoding='utf-8')

            # Demonstrar que mesmo com o lock completamente livre, a reserva durável impede repetir a capability
            with self.assertRaises(ValueError) as cm:
                r16.run_capability(self.wave, self.base / 'source')
            self.assertIn('NATIVE_NO_RETRY_OR_RESUME', str(cm.exception))

            # Confirmar que o lock foi adquirido e liberado normalmente sem travar o arquivo
            with runner.execution_lock(self.wave):
                pass
            self.assertTrue(lock_file.exists())

        finally:
            for p in procs_to_cleanup:
                for pipe in (p.stdin, p.stdout, p.stderr):
                    if pipe and not pipe.closed:
                        try:
                            pipe.close()
                        except Exception:
                            pass
                if p.poll() is None:
                    try:
                        p.kill()
                        p.wait(timeout=5)
                    except Exception:
                        pass

    # Caso 22: Falha na suíte global bloqueia offline_preflight na R16
    def test_case_22_global_suite_failure_blocks_offline_preflight(self):
        source_dir = self.base / 'source'
        (source_dir / 'final').mkdir(parents=True, exist_ok=True)
        (source_dir / 'final/decision.json').write_text(json.dumps({
            'status': 'R12R12_FACTORIAL_CONFIRMED', 'campaign': 'AP-06-R12-R12-factorial'
        }))
        (source_dir / 'tooling').mkdir(parents=True, exist_ok=True)
        (source_dir / 'tooling/kasumi.cjs').write_text('// kasumi')

        (self.output / 'baseline/browser-identity.json').write_text(json.dumps({
            'chromiumVersion': '151.0.7922.34', 'playwrightVersion': '1.62.1', 'executablePath': 'c.exe', 'executableSha256': 'a' * 64
        }))
        for f in ('experimental-backend.json', 'backend-isolation.json', 'listener-isolation.json',
                  'network-spoof-guard.json', 'network-spoof-recovery.json', 'startup-rejections.json',
                  'backend-runtime.local.json', 'player-auth.local.json', 'backend-authority.json',
                  'runtime-credentials.dpapi', 'runtime-credentials-custody.json', 'runtime-credentials-readback.json'):
            (self.output / 'baseline' / f).write_text(json.dumps({'crowHeaderSha256': 'a' * 64}))
        for name in ('native-production.xml', 'native-experimental.xml'):
            (self.output / 'baseline' / name).write_text('<catch></catch>')
        task_file = self.base / TASK_PATH
        task_file.parent.mkdir(parents=True, exist_ok=True)
        task_file.write_text('synthetic')
        (self.output / 'baseline/task.md').write_text('synthetic')
        (self.output / 'baseline/task-provenance.json').write_text(json.dumps({'sourceSha256': sha256(task_file)}))
        (self.output / 'baseline/historical-factorial-gate.json').write_text(json.dumps({'status': 'PASS'}))
        (self.output / 'fixtures/manifest.json').parent.mkdir(parents=True, exist_ok=True)
        (self.output / 'fixtures/manifest.json').write_text('{}')
        (self.base / 'docs/qualidade').mkdir(parents=True, exist_ok=True)
        (self.base / 'docs/qualidade/ap06-r9-r2.json').write_text('{}')

        backend_build = self.output / 'tooling/backend-build'
        backend_build.mkdir(parents=True, exist_ok=True)
        from ap06_freeze import NATIVE_FILES
        for name in NATIVE_FILES.values():
            (backend_build / name).write_text('dummy')

        def fake_failing_command(name, *args, **kwargs):
            if 'global-suite' in name:
                self.wave.save(f'pipeline/commands/{name}.json', {'name': name, 'exitCode': 1, 'status': 'FAIL'})
            else:
                self.wave.save(f'pipeline/commands/{name}.json', {'name': name, 'exitCode': 0, 'status': 'PASS'})
        self.wave.command = fake_failing_command

        with patch('ap06_browser_identity.verify_identity', return_value={'status': 'PASS'}), \
             patch('run_backend_shards.parse_catch_report', return_value={'assertion_failures': 0, 'case_failures': 0, 'expected_failures': 0, 'assertion_successes': 1, 'case_successes': 1}), \
             patch.object(runner, 'validate_native_build_authority'), \
             patch('run_ap06_r12_r2.validate_r8_native_tests'), \
             patch.object(runner, 'native_source_files', return_value={}), \
             patch('run_ap06_integration_probe.build_products', return_value=([], {}, {})), \
             patch.object(runner, 'verify_historical_factorial'), \
             patch('ap06_key_custody.readback', return_value={'status': 'PASS'}), \
             patch('sys.platform', 'win32'), patch('os.name', 'nt'):
            with self.assertRaises(ValueError) as cm:
                runner.offline_preflight(self.wave, source_dir)
            self.assertIn('R16_GLOBAL_TESTS_FAILED', str(cm.exception))

    # Caso 23: scan_staged_changes cobertura de clean-checkout, staged e tratamento de conflitos
    def test_case_23_secret_scan_coverage_contracts(self):
        gitleaks_path = self.base / 'fake-gitleaks.exe'
        gitleaks_path.write_text('binary')
        gitleaks_version = 'mod github.com/zricethezav/gitleaks/v8 v8.30.1\n'

        # Cenário 1: Checkout limpo -> escopo tracked-head sobre todos os arquivos rastreados
        def fake_git_clean(cmd, *args):
            if cmd == 'diff' and '--cached' in args:
                return ''
            if cmd == 'status' and '--porcelain' in args:
                return ''
            if cmd == 'ls-files':
                return 'README.md\npackage.json\n'
            return ''

        self.wave.git = fake_git_clean
        (self.base / 'README.md').write_text('# SaveBox2')
        (self.base / 'package.json').write_text('{"name": "savebox2"}')

        with patch('subprocess.run') as mock_run:
            def side_effect(cmd, *a, **kw):
                if cmd[0] == 'go':
                    return subprocess.CompletedProcess(cmd, 0, stdout=gitleaks_version)
                report_path = self.output / 'baseline/secret-scan.json'
                report_path.parent.mkdir(parents=True, exist_ok=True)
                report_path.write_text('[]')
                return subprocess.CompletedProcess(cmd, 0, stdout='')
            mock_run.side_effect = side_effect

            res = runner.scan_staged_changes(self.wave, executable=gitleaks_path)
            self.assertEqual(res['status'], 'PASS')
            self.assertEqual(res['scanScope'], 'tracked-head')
            self.assertEqual(res['scannedFiles'], 2)
            self.assertEqual(res['scannedStagedFiles'], 0)
            self.assertEqual(res['findings'], 0)

        # Cenário 2: Alterações staged sem divergência local -> escopo staged
        def fake_git_staged(cmd, *args):
            if cmd == 'diff' and '--cached' in args:
                return 'README.md\n'
            if cmd == 'diff' and '--name-only' in args:
                return ''
            if cmd == 'ls-files':
                return 'README.md\npackage.json\n'
            return ''

        self.wave.git = fake_git_staged
        with patch('subprocess.run') as mock_run:
            mock_run.side_effect = side_effect
            res_staged = runner.scan_staged_changes(self.wave, executable=gitleaks_path)
            self.assertEqual(res_staged['status'], 'PASS')
            self.assertEqual(res_staged['scanScope'], 'staged')
            self.assertEqual(res_staged['scannedFiles'], 1)
            self.assertEqual(res_staged['scannedStagedFiles'], 1)

        # Cenário 3: Alterações staged com alterações unstaged conflitantes -> rejeita divergência
        def fake_git_conflict(cmd, *args):
            if cmd == 'diff' and '--cached' in args:
                return 'README.md\n'
            if cmd == 'diff' and '--name-only' in args:
                return 'README.md\n'
            return ''

        self.wave.git = fake_git_conflict
        with patch('subprocess.run') as mock_run:
            mock_run.side_effect = side_effect
            with self.assertRaises(ValueError) as cm:
                runner.scan_staged_changes(self.wave, executable=gitleaks_path)
            self.assertIn('R16_SECRET_SCAN_STAGED_WORKING_DIVERGENCE', str(cm.exception))

        # Cenário 4: Checkout sujo sem staged changes -> rejeita dirty checkout
        def fake_git_dirty(cmd, *args):
            if cmd == 'diff' and '--cached' in args:
                return ''
            if cmd == 'status' and '--porcelain' in args:
                return ' M untracked_or_modified.txt\n'
            return ''

        self.wave.git = fake_git_dirty
        with patch('subprocess.run') as mock_run:
            mock_run.side_effect = side_effect
            with self.assertRaises(ValueError) as cm:
                runner.scan_staged_changes(self.wave, executable=gitleaks_path)
            self.assertIn('R16_SECRET_SCAN_DIRTY_CHECKOUT', str(cm.exception))

        # Cenário 5: Scanner detecta findings -> rejeita com R12R13_GITLEAKS_FINDINGS
        self.wave.git = fake_git_clean
        with patch('subprocess.run') as mock_run:
            def side_effect_findings(cmd, *a, **kw):
                if cmd[0] == 'go':
                    return subprocess.CompletedProcess(cmd, 0, stdout=gitleaks_version)
                report_path = self.output / 'baseline/secret-scan.json'
                report_path.parent.mkdir(parents=True, exist_ok=True)
                report_path.write_text('[{"Description": "generic-api-key"}]')
                return subprocess.CompletedProcess(cmd, 1, stdout='leak found')
            mock_run.side_effect = side_effect_findings
            with self.assertRaises(ValueError) as cm:
                runner.scan_staged_changes(self.wave, executable=gitleaks_path)
            self.assertIn('R12R13_GITLEAKS_FINDINGS', str(cm.exception))

        # Cenário 6: Caminho malicioso ou tentativa de traversal -> rejeita com R12R13_GITLEAKS_INPUT_INVALID
        def fake_git_traversal(cmd, *args):
            if cmd == 'diff' and '--cached' in args:
                return '../outside.txt\n'
            if cmd == 'diff' and '--name-only' in args:
                return ''
            return ''

        self.wave.git = fake_git_traversal
        with patch('subprocess.run') as mock_run:
            mock_run.side_effect = side_effect
            with self.assertRaises(ValueError) as cm:
                runner.scan_staged_changes(self.wave, executable=gitleaks_path)
            self.assertIn('R12R13_GITLEAKS_INPUT_INVALID', str(cm.exception))


    # Caso 24: validate_freeze_preflight aceita preflight build-only para R16 sem browser
    def test_case_24_r16_freeze_preflight_validation(self):
        from run_ap06_r9 import validate_freeze_preflight
        unit = {
            'status': 'PASS',
            'preflightMode': 'build-only',
            'unitBrowserLaunches': 0,
            'browserLaunches': 0,
            'appProducts': ['app.js'],
            'workerHashes': {'worker': 'hash123'},
            'fixtureHash': 'fixhash123'
        }
        (self.output / 'fixtures').mkdir(parents=True, exist_ok=True)
        (self.output / 'fixtures/manifest.json').write_text('[]')
        manifest_hash = sha256(self.output / 'fixtures/manifest.json')
        unit['fixtureHash'] = manifest_hash

        with patch('run_ap06_r9.build_products', return_value=([], ['app.js'], {'worker': {'sha256': 'hash123'}})):
            assets, products, workers, fixture_hash = validate_freeze_preflight(self.wave, unit, str(self.output))
            self.assertEqual(products, ['app.js'])
            self.assertEqual(fixture_hash, manifest_hash)



if __name__ == '__main__':
    unittest.main()


