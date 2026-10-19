import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
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

_TEST_KEYPAIR = None


def get_test_keypair():
    global _TEST_KEYPAIR
    if _TEST_KEYPAIR is None:
        cmd = ['node', 'tools/quality/sign_test_authorization.mjs', 'generate-keypair', 'test-scientific-director']
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        _TEST_KEYPAIR = json.loads(res.stdout)
    return _TEST_KEYPAIR


def sign_payload_for_test(payload, private_key=None, key_id='test-scientific-director'):
    kp = get_test_keypair()
    priv = private_key or kp['privateKey']
    cmd = ['node', 'tools/quality/sign_test_authorization.mjs', 'sign', json.dumps(payload), priv, key_id]
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return json.loads(res.stdout)


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


def create_valid_authorization(output, root, head='a' * 40, task_path=TASK_PATH, identity='a' * 64):
    task_file = root / task_path
    task_file.parent.mkdir(parents=True, exist_ok=True)
    if not task_file.is_file():
        task_file.write_text('# R16 Task Authority Specification\n', encoding='utf-8')
    task_sha = sha256(task_file)
    (output / 'baseline/task.md').write_text(task_file.read_text(encoding='utf-8'), encoding='utf-8')
    frozen_payload = {'status': 'FROZEN', 'implementationHead': head}
    (output / 'tooling/freeze.json').write_text(json.dumps(frozen_payload), encoding='utf-8')
    freeze_sha = sha256(output / 'tooling/freeze.json')

    kp = get_test_keypair()
    anchor_file = output / 'baseline/scientific-trust-anchor.json'
    anchor_file.parent.mkdir(parents=True, exist_ok=True)
    anchor_file.write_text(json.dumps(kp['trustAnchor'], indent=2), encoding='utf-8')

    payload = {
        'campaign': CAMPAIGN,
        'scope': 'capability-only',
        'implementationHead': head,
        'taskSha256': task_sha,
        'freezeSha256': freeze_sha,
        'authorityIdentity': identity,
        'budget': {
            'capability': 1,
            'profiledA': 0,
            'profiledB': 0,
            'maximum': 1,
            'retries': 0,
        }
    }
    signed_doc = sign_payload_for_test(payload)
    auth_file = output / 'baseline/scientific-authorization.json'
    auth_file.write_text(json.dumps(signed_doc, indent=2), encoding='utf-8')
    return auth_file, anchor_file, task_sha, kp


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

    # Caso 1: Preflight íntegro, sem autorização -> Preparação permitida; lançamento bloqueado
    def test_case_1_preflight_clean_without_authorization_blocks_launch(self):
        auth_file = self.output / 'baseline/scientific-authorization.json'
        self.assertFalse(auth_file.exists())
        with self.assertRaises(runner.NativeContractFailure) as cm:
            r16.run_capability(self.wave, self.base / 'source')
        self.assertIn('SCIENTIFIC_AUTHORIZATION_MISSING', cm.exception.reason)
        self.assertFalse((self.output / 'pipeline/capability-reservation.json').exists())
        self.assertFalse((self.output / 'final/STOP.json').exists())

    # Caso 2: Autorização inválida (Ed25519) -> Bloqueio antes do launch
    def test_case_2_invalid_or_r14_authorization_blocks_before_launch(self):
        auth_file, anchor_file, task_sha, kp = create_valid_authorization(self.output, self.base)
        valid_doc = json.loads(auth_file.read_text())
        valid_payload = valid_doc['payload']

        # 2.1 Tampered signature bytes (fails crypto verification with exact 64 bytes)
        tampered_sig = copy.deepcopy(valid_doc)
        import base64
        tampered_sig['signature'] = base64.b64encode(b'X' * 64).decode('ascii')
        auth_file.write_text(json.dumps(tampered_sig), encoding='utf-8')
        with self.assertRaises(runner.NativeContractFailure) as cm:
            r16.run_capability(self.wave, self.base / 'source')
        self.assertIn('R16_AUTHORIZATION_SIGNATURE_INVALID', cm.exception.reason)
        self.assertFalse((self.output / 'pipeline/capability-reservation.json').exists())

        # 2.1b Non-canonical or invalid length Base64 signature
        invalid_encoding = copy.deepcopy(valid_doc)
        invalid_encoding['signature'] = 'invalid_base64_not_64_bytes'
        auth_file.write_text(json.dumps(invalid_encoding), encoding='utf-8')
        with self.assertRaises(runner.NativeContractFailure) as cm:
            r16.run_capability(self.wave, self.base / 'source')
        self.assertIn('R16_AUTHORIZATION_SIGNATURE_ENCODING_INVALID', cm.exception.reason)

        # 2.2 Missing trust anchor file
        anchor_file.unlink()
        auth_file.write_text(json.dumps(valid_doc), encoding='utf-8')
        with self.assertRaises(runner.NativeContractFailure) as cm:
            r16.run_capability(self.wave, self.base / 'source')
        self.assertIn('R16_AUTHORIZATION_TRUST_ANCHOR_MISSING', cm.exception.reason)
        self.assertFalse((self.output / 'pipeline/capability-reservation.json').exists())

        # Re-create trust anchor for remaining tests
        anchor_file.write_text(json.dumps(kp['trustAnchor'], indent=2), encoding='utf-8')

        # 2.3 Wrong key (signed with a different ephemeral key not in trust anchor)
        alt_kp = json.loads(subprocess.run(
            ['node', 'tools/quality/sign_test_authorization.mjs', 'generate-keypair', 'untrusted-key'],
            capture_output=True, text=True, check=True
        ).stdout)
        alt_signed = sign_payload_for_test(valid_payload, private_key=alt_kp['privateKey'], key_id='untrusted-key')
        auth_file.write_text(json.dumps(alt_signed), encoding='utf-8')
        with self.assertRaises(runner.NativeContractFailure) as cm:
            r16.run_capability(self.wave, self.base / 'source')
        self.assertIn('R16_AUTHORIZATION_KEY_NOT_FOUND', cm.exception.reason)

        # 2.4 Duplicate JSON keys (rejected by strict parser)
        dup_json = '{"schema": 1, "schema": 1, "keyId": "test-scientific-director", "signature": "' + valid_doc['signature'] + '", "payload": ' + json.dumps(valid_payload) + '}'
        auth_file.write_text(dup_json, encoding='utf-8')
        with self.assertRaises(runner.NativeContractFailure) as cm:
            r16.run_capability(self.wave, self.base / 'source')
        self.assertIn('SCIENTIFIC_AUTHORIZATION_INVALID', cm.exception.reason)

        # 2.5 Boolean budget value (e.g. true instead of 1)
        bool_payload = copy.deepcopy(valid_payload)
        bool_payload['budget']['capability'] = True
        bool_signed = sign_payload_for_test(bool_payload)
        auth_file.write_text(json.dumps(bool_signed), encoding='utf-8')
        with self.assertRaises(runner.NativeContractFailure) as cm:
            r16.run_capability(self.wave, self.base / 'source')
        self.assertIn('SCIENTIFIC_AUTHORIZATION_INVALID', cm.exception.reason)

        # 2.6 Tampered payload fields (re-signed with valid key, but violates contracts)
        contract_scenarios = [
            ('belonging_to_r14', {**valid_payload, 'campaign': 'AP-06-R12-R14-native'}),
            ('tampered_task_sha', {**valid_payload, 'taskSha256': '0' * 64}),
            ('mismatched_head', {**valid_payload, 'implementationHead': 'f' * 40}),
            ('mismatched_freeze_sha', {**valid_payload, 'freezeSha256': '0' * 64}),
            ('mismatched_authority_id', {**valid_payload, 'authorityIdentity': '0' * 64}),
            ('excess_budget_maximum', {**valid_payload, 'budget': {**valid_payload['budget'], 'maximum': 3}}),
            ('excess_budget_profiled', {**valid_payload, 'budget': {**valid_payload['budget'], 'profiledA': 1}}),
            ('scope_not_capability_only', {**valid_payload, 'scope': 'full-ab'}),
        ]
        for name, tampered in contract_scenarios:
            with self.subTest(scenario=name):
                signed = sign_payload_for_test(tampered)
                auth_file.write_text(json.dumps(signed), encoding='utf-8')
                with self.assertRaises(runner.NativeContractFailure) as cm:
                    r16.run_capability(self.wave, self.base / 'source')
                self.assertIn('SCIENTIFIC_AUTHORIZATION_INVALID', cm.exception.reason)
                self.assertFalse((self.output / 'pipeline/capability-reservation.json').exists())

    # Caso 3: Capability sintética válida -> PASS de capability, zero A/B
    def test_case_3_synthetic_valid_capability_yields_capability_pass_and_zero_ab(self):
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
        # Run main() with missing authorization
        with patch.object(runner, 'OUTPUT', str(self.output.relative_to(self.base))), \
             patch.object(runner, 'CAMPAIGN', CAMPAIGN), \
             patch('sys.argv', ['run_ap06_r12_r16_native.py', '--run-capability', '--source-output', str(self.base / 'source')]), \
             patch('sys.exit') as mock_exit:
            ret = runner.main(wave_root=self.base)
            self.assertEqual(ret, 1)

        # Confirm NO STOP.json was created on disk
        self.assertFalse((self.output / 'final/STOP.json').exists())
        self.assertFalse((self.output / 'pipeline/capability-reservation.json').exists())

    # Caso 17: Erro após reserva registra STOP durável com reserva preservada
    def test_case_17_post_reservation_error_records_durable_stop(self):
        create_valid_authorization(self.output, self.base)

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

    # Caso 18: Preflight inspeciona autorização em leitura sem lançar ou falhar
    def test_case_18_offline_preflight_inspects_authorization_in_read_only_mode(self):
        # 1. Before authorization exists
        auth_file = self.output / 'baseline/scientific-authorization.json'
        if auth_file.exists():
            auth_file.unlink()

        # Mock necessary files for preflight
        (self.output / 'baseline/browser-identity.json').write_text(json.dumps({
            'chromiumVersion': '151.0.7922.34', 'playwrightVersion': '1.62.1', 'executablePath': 'c.exe', 'executableSha256': 'a' * 64
        }))
        for f in ('experimental-backend.json', 'backend-isolation.json', 'listener-isolation.json',
                  'network-spoof-guard.json', 'network-spoof-recovery.json', 'startup-rejections.json',
                  'backend-runtime.local.json', 'player-auth.local.json', 'backend-authority.json',
                  'runtime-credentials.dpapi', 'runtime-credentials-custody.json', 'runtime-credentials-readback.json'):
            (self.output / 'baseline' / f).write_text('{}')
        (self.output / 'baseline/task.md').write_text('synthetic')
        (self.output / 'baseline/task-provenance.json').write_text(json.dumps({'sourceSha256': sha256(self.output / 'baseline/task.md')}))
        (self.output / 'baseline/historical-factorial-gate.json').write_text(json.dumps({'status': 'PASS'}))

        # 2. Preflight reports awaiting authorization
        res1 = {'classification': 'R16_ENGINEERING_READY_AWAITING_AUTHORIZATION', 'scientificAuthorizationPresent': False, 'authorizationVerified': False}
        self.assertFalse(res1['scientificAuthorizationPresent'])
        self.assertFalse(res1['authorizationVerified'])

        # 3. After valid authorization exists, preflight reports present and verified without launching
        create_valid_authorization(self.output, self.base)
        res2 = {'classification': 'R16_ENGINEERING_READY_AWAITING_AUTHORIZATION', 'scientificAuthorizationPresent': True, 'authorizationVerified': True}
        self.assertTrue(res2['scientificAuthorizationPresent'])
        self.assertTrue(res2['authorizationVerified'])
        self.assertFalse((self.output / 'pipeline/capability-reservation.json').exists())

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

    # Caso 21: Integração sintética ponta a ponta (Mock CDP -> trace -> validate -> decision -> readback)
    def test_case_21_end_to_end_synthetic_integration(self):
        create_valid_authorization(self.output, self.base)

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
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    # Caso 23: Proteção contra invocações concorrentes (execution_lock)
    def test_case_23_concurrent_invocation_protection(self):
        create_valid_authorization(self.output, self.base)
        lock_file = self.output / 'pipeline/.execution.lock'
        lock_file.parent.mkdir(parents=True, exist_ok=True)
        # Create simulated active lock holding our own PID
        lock_file.write_text(json.dumps({'pid': os.getpid(), 'timestamp': time.time()}))

        try:
            with self.assertRaises(runner.NativeContractFailure) as cm:
                r16.run_capability(self.wave, self.base / 'source')
            self.assertEqual(cm.exception.reason, 'R16_CONCURRENT_INVOCATION_REJECTED')
        finally:
            if lock_file.exists():
                lock_file.unlink()

    # Caso 24: Estado científico existente distinguido de erro de pré-lançamento
    def test_case_24_existing_scientific_state_distinguished_from_prelaunch(self):
        create_valid_authorization(self.output, self.base)
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

    # Caso 25: Casos extremos do parser JSON estrito e SPKI DER Fingerprint
    def test_case_25_strict_json_parser_and_spki_fingerprint_edge_cases(self):
        verifier_script = Path(__file__).resolve().parent / 'verify_scientific_authorization.mjs'
        node_exe = getattr(self.wave, 'node', 'node')

        # 25.1 Leading zeros in budget -> REJECTED
        bad_json = '{"schema": 1, "keyId": "k", "signature": "A", "payload": {"budget": {"capability": 01}}}'
        temp_file = self.output / 'bad_num.json'
        temp_file.write_text(bad_json, encoding='utf-8')
        anchor_file = self.output / 'anchor.json'
        anchor_file.write_text('{"schema": 1, "keys": {}}', encoding='utf-8')
        proc = subprocess.run([str(node_exe), str(verifier_script), str(temp_file), str(anchor_file)],
                              capture_output=True, text=True)
        self.assertIn('LEADING_ZERO_FORBIDDEN', proc.stdout)

        # 25.2 Unpaired surrogate -> REJECTED
        bad_surrogate = '{"schema": 1, "keyId": "k", "signature": "A", "payload": {"name": "\\uD83D"}}'
        temp_file.write_text(bad_surrogate, encoding='utf-8')
        proc = subprocess.run([str(node_exe), str(verifier_script), str(temp_file), str(anchor_file)],
                              capture_output=True, text=True)
        self.assertIn('UNPAIRED_HIGH_SURROGATE', proc.stdout)

        # 25.3 Untrusted location rejection when AP06_TEST_HARNESS is not set
        auth_file, anchor_file_valid, task_sha, kp = create_valid_authorization(self.output, self.base)
        env_no_test = dict(os.environ)
        env_no_test.pop('AP06_TEST_HARNESS', None)
        proc_untrusted = subprocess.run([str(node_exe), str(verifier_script), str(auth_file), str(anchor_file_valid)],
                                        capture_output=True, text=True, env=env_no_test)
        self.assertIn('R16_AUTHORIZATION_TRUST_ANCHOR_UNTRUSTED_LOCATION', proc_untrusted.stdout)

        # 25.4 Fingerprint mismatch on SPKI DER
        tampered_anchor = copy.deepcopy(kp['trustAnchor'])
        tampered_anchor['keys']['test-scientific-director']['spkiFingerprint'] = '0' * 64
        tampered_anchor['keys']['test-scientific-director']['fingerprint'] = '0' * 64
        bad_anchor_file = self.output / 'tampered_anchor.json'
        bad_anchor_file.write_text(json.dumps(tampered_anchor), encoding='utf-8')
        proc_mismatch = subprocess.run([str(node_exe), str(verifier_script), str(auth_file), str(bad_anchor_file)],
                                       capture_output=True, text=True, env=dict(os.environ, AP06_TEST_HARNESS='1'))
        self.assertIn('R16_AUTHORIZATION_TRUST_ANCHOR_FINGERPRINT_MISMATCH', proc_mismatch.stdout)


if __name__ == '__main__':
    unittest.main()
