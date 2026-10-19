import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import sys
import unittest
from unittest.mock import patch

from ap06_authorities import initialize, private_permissions, publish_snapshot, sha256, verify_publication
from ap06_freeze import load_native_budget, validate_test_receipt
from prepare_ap06_r12_r13 import NATIVE_BUDGET, verify_all_publications_once
import run_ap06_r12_r13_native as runner
import run_ap06_r12_r14_native as r14
from run_ap06_r12_r13_native import validate_budget
from run_ap06_r9 import CRYPTO, publication_namespace, validate_freeze_preflight
import run_ap06_r12_r2_native as native

CAMPAIGN = 'AP-06-R12-R14-native'
OUTPUT = '.quality/readiness-wave12-r14-native'


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


def runtime_config(output, port=49999):
    runtime = output / 'pipeline' / ('runtime-' + 'b' * 16)
    return {
        'executable': str(output / 'tooling/backend-build/nanika_e2e_fixture.exe'),
        'cwd': str(runtime),
        'storagePath': str(runtime / 'storage'),
        'storageId': 'c' * 64,
        'backendOrigin': f'http://127.0.0.1:{port}',
    }


def cleanup_wave(base):
    authority = base / 'authority'
    identity = 'a' * 64
    initialize(authority, identity, campaign=CAMPAIGN)
    output = base / 'output'
    (output / 'pipeline').mkdir(parents=True)
    (output / 'baseline').mkdir(parents=True)
    (output / 'baseline/authority-config.local.json').write_text(json.dumps(
        {'AP06_AUTHORITY_ROOT': str(authority), 'identity': identity}), encoding='utf-8')
    wave = SimpleNamespace(output=output, save=lambda name, value: (
        output / name).parent.mkdir(parents=True, exist_ok=True) or (
        output / name).write_text(json.dumps(value), encoding='utf-8'))
    return wave, output, authority, identity


def capability_receipt_payload():
    return {
        'status': 'CAPTURED', 'launchAttempts': 1, 'browserLaunches': 1, 'retries': 0,
        'browserClosed': True, 'processExitAudit': {'status': 'PASS'},
        'handleRelease': {'status': 'PASS'},
        'trace': {
            'tracingStarted': True, 'memoryInfraCategoryAvailable': True, 'activatedBeforeWorkload': True,
            'complete': True, 'streamEof': True, 'dataLossOccurred': False, 'traceFormat': 'json',
            'rendererPid': 42, 'sha256': 'b' * 64, 'bytes': 256,
            'checkpoints': [{'phase': phase, 'success': True, 'dumpGuid': hex(index + 1)}
                for index, phase in enumerate(('baseline', 'cycle-6-close', 'idle-120s', 'forced-GC-final'))]
        }
    }


def write_capability_accounting(output):
    pipeline = output / 'pipeline'; pipeline.mkdir(parents=True, exist_ok=True)
    (pipeline / 'capability-reservation.json').write_text(json.dumps({
        'campaign': CAMPAIGN, 'maximum': 1, 'retries': 0, 'implementationHead': 'a' * 40}), encoding='utf-8')
    (pipeline / 'native-receipt.json').write_text(json.dumps(capability_receipt_payload()), encoding='utf-8')


def write_measurement_accounting(output, condition, native_status='NATIVE_CAPABILITY_PASS', ledger=None,
        *, retries=0, attempts=1, launches=1, receipt=True):
    directories = {'r12r2.0': '05-r12r2.0', 'r12r2.2': '06-r12r2.2'}
    directory = output / 'formal' / directories[condition]
    directory.mkdir(parents=True, exist_ok=True)
    raw_path = directory / f'{CRYPTO}.raw.json'
    raw = {'condition': condition, 'stage': 'formal', 'launchAttempts': attempts,
        'browserLaunches': launches, 'retries': retries, 'runs': [{}]}
    raw_path.write_text(json.dumps(raw), encoding='utf-8')
    digest = sha256(raw_path)
    if receipt:
        (directory / 'native-receipt.json').write_text(json.dumps({'trace': {
            'tracingStarted': True, 'memoryInfraCategoryAvailable': True, 'activatedBeforeWorkload': True,
            'complete': True, 'streamEof': True, 'dataLossOccurred': False, 'traceFormat': 'json',
            'rendererPid': 42, 'sha256': 'b' * 64, 'bytes': 256,
            'checkpoints': [{'phase': phase, 'success': True, 'dumpGuid': hex(index + 1)}
                for index, phase in enumerate(('baseline', 'cycle-6-close', 'idle-120s', 'forced-GC-final'))]
        }}), encoding='utf-8')
    if ledger is not None:
        ledger.append({'condition': condition, 'stage': 'formal', 'reservedAttempts': 1,
            'launchAttempts': attempts, 'browserLaunches': launches, 'rawSha256': digest})
    return {'condition': condition, 'rawSha256': digest,
        'rawPath': raw_path.relative_to(output).as_posix(),
        'native': {'status': native_status, 'traceSha256': 'b' * 64}}


class R12R14PreparationTests(unittest.TestCase):
    def test_native_aggregate_classifier_rejects_unknown_and_malformed_statuses(self):
        self.assertEqual(runner.classify_native_aggregate({'status': 'NATIVE_CAPABILITY_PASS'}), 'PASS')
        self.assertEqual(runner.classify_native_aggregate({'status': 'NATIVE_INCONCLUSIVE'}), 'INCONCLUSIVE')
        for aggregate, reason in (
            ({'status': 'NATIVE_STOP', 'reason': 'NATIVE_TRACE_INVALID'}, 'NATIVE_TRACE_INVALID'),
            ({'status': 'NATIVE_STOP', 'reason': 'invalid reason'}, 'NATIVE_TRACE_CONTRACT_INVALID'),
            ({'status': 'UNKNOWN'}, 'NATIVE_AGGREGATE_STATUS_INVALID'),
            ({'status': None}, 'NATIVE_AGGREGATE_STATUS_INVALID'),
            ({}, 'NATIVE_AGGREGATE_STATUS_INVALID'),
            (None, 'NATIVE_AGGREGATE_INVALID'),
        ):
            with self.subTest(aggregate=aggregate), self.assertRaises(runner.NativeContractFailure) as ctx:
                runner.classify_native_aggregate(aggregate)
            self.assertEqual(ctx.exception.reason, reason)

    def test_expected_terminal_launches_validate_status_results_and_order(self):
        expected = runner.expected_decision_launches
        tag = 'R12R14'
        self.assertEqual(expected({'status': f'{tag}_NATIVE_CAPABILITY_INCONCLUSIVE',
            'abAuthorized': False}), {'capabilityChromium': 1, 'measurementChromium': 0,
                'retries': 0, 'total': 1, 'measurementConditions': []})
        self.assertEqual(expected({'status': f'{tag}_NATIVE_ALLOCATION_COVERAGE_INSUFFICIENT',
            'abAuthorized': False, 'results': [{'condition': 'r12r2.0',
                'native': {'status': 'NATIVE_INCONCLUSIVE'}}]})['total'], 2)
        with self.assertRaises(runner.NativeContractFailure):
            expected({'status': f'{tag}_NATIVE_TRACKED_AGGREGATES_OBSERVED', 'abAuthorized': True,
                'results': [{'condition': 'r12r2.2', 'native': {'status': 'NATIVE_CAPABILITY_PASS'}},
                    {'condition': 'r12r2.0', 'native': {'status': 'NATIVE_CAPABILITY_PASS'}}]})
        for decision in (
            {'status': 'UNKNOWN'},
            {'status': f'{tag}_NATIVE_TRACKED_AGGREGATES_OBSERVED', 'abAuthorized': True, 'results': []},
            {'status': f'{tag}_NATIVE_ALLOCATION_COVERAGE_INSUFFICIENT', 'abAuthorized': False,
                'results': [{'condition': 'r12r2.0', 'native': {'status': 'NATIVE_CAPABILITY_PASS'}}]},
            {'status': f'{tag}_NATIVE_TRACKED_AGGREGATES_OBSERVED', 'abAuthorized': True, 'results': [
                {'condition': 'r12r2.0', 'native': {'status': 'NATIVE_CAPABILITY_PASS'}},
                {'condition': 'r12r2.0', 'native': {'status': 'NATIVE_CAPABILITY_PASS'}}]},
        ):
            with self.subTest(decision=decision), self.assertRaises(runner.NativeContractFailure):
                expected(decision)

    def _accounted_decision(self, output, status, conditions=(), aggregate_statuses=()):
        write_capability_accounting(output)
        ledger, results = [], []
        for condition, aggregate_status in zip(conditions, aggregate_statuses):
            results.append(write_measurement_accounting(output, condition, aggregate_status, ledger))
        if ledger:
            (output / 'pipeline/launch-ledger.json').write_text(json.dumps(ledger), encoding='utf-8')
        return {
            'status': status, 'capabilityChromium': 1, 'measurementChromium': len(results), 'retries': 0,
            'abAuthorized': status == 'R12R14_NATIVE_TRACKED_AGGREGATES_OBSERVED',
            'cleanupStatus': 'PASS', **({'results': results} if results else {}),
        }

    def test_decision_consumption_accepts_only_the_four_terminal_accounting_shapes(self):
        cases = (
            ('R12R14_NATIVE_CAPABILITY_INCONCLUSIVE', (), ()),
            ('R12R14_NATIVE_ALLOCATION_COVERAGE_INSUFFICIENT', ('r12r2.0',), ('NATIVE_INCONCLUSIVE',)),
            ('R12R14_NATIVE_ALLOCATION_COVERAGE_INSUFFICIENT', ('r12r2.0', 'r12r2.2'),
                ('NATIVE_CAPABILITY_PASS', 'NATIVE_INCONCLUSIVE')),
            ('R12R14_NATIVE_TRACKED_AGGREGATES_OBSERVED', ('r12r2.0', 'r12r2.2'),
                ('NATIVE_CAPABILITY_PASS', 'NATIVE_CAPABILITY_PASS')),
        )
        for status, conditions, aggregate_statuses in cases:
            with self.subTest(status=status, conditions=conditions), tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary) / 'output'; output.mkdir()
                decision = self._accounted_decision(output, status, conditions, aggregate_statuses)
                self.assertTrue(runner.validate_decision_consumption(output, decision))

    def test_decision_consumption_rejects_unverified_or_inconsistent_evidence(self):
        cases = ('capability-missing', 'capability-corrupt', 'a-missing', 'a-corrupt',
            'b-missing', 'b-corrupt', 'orphan-ledger', 'ledger-divergence', 'retry',
            'four-launches', 'ledger-order')
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary) / 'output'; output.mkdir()
                decision = self._accounted_decision(output, 'R12R14_NATIVE_TRACKED_AGGREGATES_OBSERVED',
                    ('r12r2.0', 'r12r2.2'), ('NATIVE_CAPABILITY_PASS', 'NATIVE_CAPABILITY_PASS'))
                cap = output / 'pipeline/native-receipt.json'
                ledger_path = output / 'pipeline/launch-ledger.json'
                ledger = json.loads(ledger_path.read_text(encoding='utf-8'))
                if case == 'capability-missing':
                    cap.unlink()
                elif case == 'capability-corrupt':
                    cap.write_text('{', encoding='utf-8')
                elif case in ('a-missing', 'a-corrupt', 'b-missing', 'b-corrupt'):
                    index = 0 if case.startswith('a-') else 1
                    receipt = output / 'formal' / ('05-r12r2.0' if index == 0 else '06-r12r2.2') / 'native-receipt.json'
                    if case.endswith('missing'):
                        receipt.unlink()
                    else:
                        receipt.write_text('{', encoding='utf-8')
                elif case == 'orphan-ledger':
                    (output / 'formal/05-r12r2.0/native-receipt.json').unlink()
                elif case == 'ledger-divergence':
                    ledger[0]['browserLaunches'] = 0
                    ledger_path.write_text(json.dumps(ledger), encoding='utf-8')
                elif case == 'retry':
                    raw_path = output / decision['results'][0]['rawPath']
                    raw = json.loads(raw_path.read_text(encoding='utf-8')); raw['retries'] = 1
                    raw_path.write_text(json.dumps(raw), encoding='utf-8')
                    ledger[0]['rawSha256'] = sha256(raw_path)
                    ledger_path.write_text(json.dumps(ledger), encoding='utf-8')
                    decision['results'][0]['rawSha256'] = sha256(raw_path)
                elif case == 'four-launches':
                    ledger[0].update(launchAttempts=3, browserLaunches=3)
                    ledger_path.write_text(json.dumps(ledger), encoding='utf-8')
                elif case == 'ledger-order':
                    ledger.reverse()
                    ledger_path.write_text(json.dumps(ledger), encoding='utf-8')
                with self.assertRaises(runner.NativeContractFailure):
                    runner.validate_decision_consumption(output, decision)

    def test_decision_consumption_rejects_declared_unverified_bool_and_extra_lane(self):
        for field, value in (('measurementChromium', 'UNVERIFIED'), ('capabilityChromium', True),
                ('retries', True)):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary) / 'output'; output.mkdir()
                decision = self._accounted_decision(output, 'R12R14_NATIVE_CAPABILITY_INCONCLUSIVE')
                decision[field] = value
                with self.assertRaises(runner.NativeContractFailure):
                    runner.validate_decision_consumption(output, decision)

        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'output'; output.mkdir()
            decision = self._accounted_decision(output, 'R12R14_NATIVE_ALLOCATION_COVERAGE_INSUFFICIENT',
                ('r12r2.0',), ('NATIVE_INCONCLUSIVE',))
            ledger = json.loads((output / 'pipeline/launch-ledger.json').read_text(encoding='utf-8'))
            write_measurement_accounting(output, 'r12r2.2', 'NATIVE_CAPABILITY_PASS', ledger)
            (output / 'pipeline/launch-ledger.json').write_text(json.dumps(ledger), encoding='utf-8')
            with self.assertRaises(runner.NativeContractFailure):
                runner.validate_decision_consumption(output, decision)

        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'output'; output.mkdir()
            decision = self._accounted_decision(output, 'R12R14_NATIVE_CAPABILITY_INCONCLUSIVE')
            (output / 'formal').mkdir()
            (output / 'formal/unexpected-receipt.json').write_text('{}', encoding='utf-8')
            with self.assertRaises(runner.NativeContractFailure):
                runner.validate_decision_consumption(output, decision)

    def test_aggregate_invalid_status_is_not_published_or_followed_by_next_lane(self):
        for aggregate in ({'status': 'UNKNOWN'}, None, {}):
            with self.subTest(aggregate=aggregate), tempfile.TemporaryDirectory() as temporary:
                wave, out, _authority, _identity = self._profiled_wave(temporary)
                calls = []
                with patch('run_ap06_r9.measure', side_effect=self._measure_fixture(calls)), \
                     patch.object(runner, 'validate_trace', return_value=aggregate), \
                     patch.object(runner, 'publish') as publish_mock, \
                     patch.object(runner, 'stop_and_verify_backend_cleanup', return_value={'status': 'PASS'}):
                    with self.assertRaises(runner.NativeContractFailure):
                        runner.run_profiled_pair(wave, Path(temporary) / 'historical',
                            {'implementationHead': 'a' * 40},
                            SimpleNamespace(environment=lambda *_a, **_k: ({}, [])))
                self.assertEqual(calls, ['r12r2.0'])
                self.assertFalse((out / 'formal/05-r12r2.0/native-aggregate.json').exists())
                self.assertFalse((out / 'final/decision.json').exists())
                publish_mock.assert_not_called()

    def test_profiled_pair_classifies_second_lane_inconclusive_and_invalid_statuses(self):
        with tempfile.TemporaryDirectory() as temporary:
            wave, out, _authority, _identity = self._profiled_wave(temporary)
            calls = []
            with patch('run_ap06_r9.measure', side_effect=self._measure_fixture(calls)), \
                 patch.object(runner, 'validate_trace', side_effect=[
                     {'status': 'NATIVE_CAPABILITY_PASS'},
                     {'status': 'NATIVE_INCONCLUSIVE', 'reason': 'NATIVE_HEAPS_V2_NOT_EMITTED'}]), \
                 patch.object(runner, 'publish'), \
                 patch.object(runner, 'stop_and_verify_backend_cleanup', return_value={'status': 'PASS'}):
                decision = runner.run_profiled_pair(wave, Path(temporary) / 'historical',
                    {'implementationHead': 'a' * 40},
                    SimpleNamespace(environment=lambda *_a, **_k: ({}, [])))
            self.assertEqual(calls, ['r12r2.0', 'r12r2.2'])
            self.assertEqual(decision['status'], 'R12R14_NATIVE_ALLOCATION_COVERAGE_INSUFFICIENT')
            self.assertEqual(decision['measurementChromium'], 2)
            self.assertEqual([row['condition'] for row in decision['results']], ['r12r2.0', 'r12r2.2'])
            self.assertEqual([row['native']['status'] for row in decision['results']],
                ['NATIVE_CAPABILITY_PASS', 'NATIVE_INCONCLUSIVE'])
            self.assertTrue((out / 'final/decision.json').is_file())

        for aggregate in ({'status': 'NATIVE_STOP', 'reason': 'NATIVE_SECOND_LANE_STOP'},
                {'status': 'UNKNOWN'}, None, {}):
            with self.subTest(aggregate=aggregate), tempfile.TemporaryDirectory() as temporary:
                wave, out, _authority, _identity = self._profiled_wave(temporary)
                calls = []
                with patch('run_ap06_r9.measure', side_effect=self._measure_fixture(calls)), \
                     patch.object(runner, 'validate_trace', side_effect=[{'status': 'NATIVE_CAPABILITY_PASS'}, aggregate]), \
                     patch.object(runner, 'publish'), \
                     patch.object(runner, 'stop_and_verify_backend_cleanup', return_value={'status': 'PASS'}):
                    with self.assertRaises(runner.NativeContractFailure):
                        runner.run_profiled_pair(wave, Path(temporary) / 'historical',
                            {'implementationHead': 'a' * 40},
                            SimpleNamespace(environment=lambda *_a, **_k: ({}, [])))
                self.assertEqual(calls, ['r12r2.0', 'r12r2.2'])
                self.assertTrue((out / 'formal/05-r12r2.0/native-aggregate.json').is_file())
                self.assertFalse((out / 'formal/06-r12r2.2/native-aggregate.json').exists())
                self.assertFalse((out / 'final/decision.json').exists())

    def test_main_terminal_gate_accepts_valid_publication_and_rejects_unverified_without_rewriting(self):
        for valid in (True, False):
            with self.subTest(valid=valid), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); output = root / OUTPUT
                for name in ('baseline', 'pipeline', 'final'):
                    (output / name).mkdir(parents=True, exist_ok=True)
                authority = root / 'authority'; identity = 'a' * 64
                initialize(authority, identity, campaign=CAMPAIGN)
                (output / 'baseline/authority-config.local.json').write_text(json.dumps({
                    'AP06_AUTHORITY_ROOT': str(authority), 'identity': identity}), encoding='utf-8')
                write_capability_accounting(output)
                wave = SimpleNamespace(root=root, output=output, node='node', save=lambda name, value: (
                    (output / name).parent.mkdir(parents=True, exist_ok=True) or
                    (output / name).write_text(json.dumps(value), encoding='utf-8')))
                namespace = publication_namespace(wave)
                publication_name = f'{namespace}-decision' if namespace else 'decision'
                published_path = f'{namespace}/evidence/decision.json' if namespace else 'evidence/decision.json'

                def published_decision_sha256():
                    manifest = verify_publication(authority, identity, publication_name)
                    row = next(item for item in manifest['files'] if item['path'] == published_path)
                    return row['sha256']

                capability = {'status': 'NATIVE_INCONCLUSIVE', 'reason': 'NATIVE_HEAPS_V2_NOT_EMITTED'}
                with patch.object(runner, 'stop_and_verify_backend_cleanup', return_value={'status': 'PASS'}):
                    if valid:
                        run = lambda active, _source: runner.publish_inconclusive_decision(active, capability)
                        expected_exit = 0
                    else:
                        decision = self._accounted_decision(output, 'R12R14_NATIVE_CAPABILITY_INCONCLUSIVE')
                        decision['capabilityChromium'] = 'UNVERIFIED'
                        (output / 'final/decision.json').write_text(json.dumps(decision), encoding='utf-8')
                        runner.publish(wave, 'decision', {'evidence/decision.json': output / 'final/decision.json'})
                        before = (output / 'final/decision.json').read_bytes()
                        published_before = published_decision_sha256()
                        self.assertEqual(published_before, sha256(output / 'final/decision.json'))
                        run = lambda _active, _source: decision
                        expected_exit = 1
                    with patch.object(runner, 'OUTPUT', OUTPUT), patch.object(runner, 'Wave', return_value=wave), \
                         patch.object(runner, 'run_capability', side_effect=run), \
                         patch.object(sys, 'argv', ['run_ap06_r12_r13_native.py', '--run', '--source-output', str(root)]):
                        self.assertEqual(runner.main(), expected_exit)
                if not valid:
                    self.assertEqual((output / 'final/decision.json').read_bytes(), before)
                    self.assertEqual(published_decision_sha256(), published_before)
                    self.assertTrue((output / 'final/decision-validation-incident.json').is_file())

    def test_main_terminal_gate_requires_explicit_cleanup_pass(self):
        cases = [('missing', None), *((repr(value), value) for value in
            (None, 'UNVERIFIED', 'FAIL', 'NOT_PERFORMED', False, 0, ''))]
        for label, cleanup_status in [('PASS', 'PASS'), *cases]:
            with self.subTest(cleanup_status=label), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); output = root / OUTPUT
                for name in ('baseline', 'pipeline', 'final'):
                    (output / name).mkdir(parents=True, exist_ok=True)
                authority = root / 'authority'; identity = 'a' * 64
                initialize(authority, identity, campaign=CAMPAIGN)
                (output / 'baseline/authority-config.local.json').write_text(json.dumps({
                    'AP06_AUTHORITY_ROOT': str(authority), 'identity': identity}), encoding='utf-8')
                decision = self._accounted_decision(output, 'R12R14_NATIVE_CAPABILITY_INCONCLUSIVE')
                if label == 'missing':
                    decision.pop('cleanupStatus', None)
                else:
                    decision['cleanupStatus'] = cleanup_status
                decision_path = output / 'final/decision.json'
                decision_path.write_text(json.dumps(decision), encoding='utf-8')
                wave = SimpleNamespace(root=root, output=output, node='node', save=lambda name, value: (
                    (output / name).parent.mkdir(parents=True, exist_ok=True) or
                    (output / name).write_text(json.dumps(value), encoding='utf-8')))
                namespace = publication_namespace(wave)
                decision_publication = f'{namespace}-decision' if namespace else 'decision'
                decision_relative = f'{namespace}/evidence/decision.json' if namespace else 'evidence/decision.json'
                runner.publish(wave, 'decision', {'evidence/decision.json': decision_path})

                historical_stop = root / 'historical-stop.json'
                historical_stop.write_text('{"status":"STOP","reason":"historical"}', encoding='utf-8')
                stop_publication = f'{namespace}-stop' if namespace else 'stop'
                stop_relative = f'{namespace}/evidence/STOP.json' if namespace else 'evidence/STOP.json'
                runner.publish(wave, 'stop', {'evidence/STOP.json': historical_stop})

                def published_sha(publication, relative):
                    manifest = verify_publication(authority, identity, publication)
                    return next(item['sha256'] for item in manifest['files'] if item['path'] == relative)

                decision_before = decision_path.read_bytes()
                decision_sha_before = published_sha(decision_publication, decision_relative)
                stop_sha_before = published_sha(stop_publication, stop_relative)
                self.assertEqual(decision_sha_before, sha256(decision_path))
                self.assertFalse((output / 'final/STOP.json').exists())

                with patch.object(runner, 'OUTPUT', OUTPUT), patch.object(runner, 'Wave', return_value=wave), \
                     patch.object(runner, 'run_capability', return_value=decision) as run_mock, \
                     patch.object(sys, 'argv', ['run_ap06_r12_r13_native.py', '--run', '--source-output', str(root)]):
                    self.assertEqual(runner.main(), 0 if label == 'PASS' else 1)

                run_mock.assert_called_once_with(wave, root)
                self.assertEqual(decision_path.read_bytes(), decision_before)
                self.assertEqual(published_sha(decision_publication, decision_relative), decision_sha_before)
                self.assertEqual(published_sha(stop_publication, stop_relative), stop_sha_before)
                self.assertFalse((output / 'final/STOP.json').exists())

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
            self.assertTrue(s2['unverifiedConsumption'])
            self.assertFalse(s2['capabilityVerified'])

    def test_cleanup_not_started_returns_pass_without_listener_probe(self):
        with tempfile.TemporaryDirectory() as temporary:
            wave, out, _authority, _identity = cleanup_wave(Path(temporary))
            with patch('socket.create_connection', side_effect=AssertionError('listener must not be probed')):
                result = runner.stop_and_verify_backend_cleanup(wave)
            self.assertEqual(result['status'], 'PASS')
            self.assertFalse(result['backendStarted'])
            self.assertEqual(result['reason'], 'BACKEND_NOT_STARTED')
            self.assertFalse((out / 'pipeline/backend-runtime-cleanup.json').exists())

    def test_cleanup_started_without_runtime_config_is_unverified(self):
        with tempfile.TemporaryDirectory() as temporary:
            wave, out, _authority, _identity = cleanup_wave(Path(temporary))
            (out / 'pipeline/backend-live.json').write_text(json.dumps({
                'status': 'READY', 'backendOrigin': 'http://127.0.0.1:49999', 'isolated': True}))
            with patch('socket.create_connection', side_effect=AssertionError('listener must not be probed')):
                result = runner.stop_and_verify_backend_cleanup(wave)
            self.assertEqual(result['status'], 'UNVERIFIED')
            self.assertEqual(result['reason'], 'BACKEND_RUNTIME_CONFIG_MISSING')

    def test_cleanup_corrupt_runtime_config_is_unverified(self):
        with tempfile.TemporaryDirectory() as temporary:
            wave, out, _authority, _identity = cleanup_wave(Path(temporary))
            (out / 'pipeline/backend-live.json').write_text(json.dumps({
                'status': 'READY', 'backendOrigin': 'http://127.0.0.1:49999', 'isolated': True}))
            (out / 'baseline/backend-runtime.local.json').write_text('{not-json', encoding='utf-8')
            with patch('socket.create_connection', side_effect=ConnectionRefusedError):
                result = runner.stop_and_verify_backend_cleanup(wave)
            self.assertEqual(result['status'], 'UNVERIFIED')
            self.assertEqual(result['reason'], 'BACKEND_RUNTIME_CONFIG_CORRUPT')

    def test_cleanup_rejects_foreign_origin_and_runtime_path(self):
        cases = (
            ({'backendOrigin': 'http://0.0.0.0:49999'}, 'BACKEND_RUNTIME_ORIGIN_INVALID'),
            ({'backendOrigin': 'http://127.0.0.1'}, 'BACKEND_RUNTIME_ORIGIN_INVALID'),
            ({'cwd': 'C:\\foreign-runtime'}, 'BACKEND_RUNTIME_OWNERSHIP_INVALID'),
            ({'storagePath': 'C:\\foreign-runtime\\storage'}, 'BACKEND_RUNTIME_OWNERSHIP_INVALID'),
            ({'storageId': 'not-a-storage-id'}, 'BACKEND_RUNTIME_OWNERSHIP_INVALID'),
        )
        for overrides, reason in cases:
            with self.subTest(reason=reason, overrides=overrides), tempfile.TemporaryDirectory() as temporary:
                wave, out, _authority, _identity = cleanup_wave(Path(temporary))
                (out / 'pipeline/backend-live.json').write_text(json.dumps({
                    'status': 'READY', 'backendOrigin': 'http://127.0.0.1:49999', 'isolated': True}))
                config = runtime_config(out)
                config.update(overrides)
                (out / 'baseline/backend-runtime.local.json').write_text(json.dumps(config))
                (out / 'pipeline/backend-runtime-cleanup.json').write_text(
                    json.dumps(valid_cleanup_receipt()))
                with patch('socket.create_connection', side_effect=ConnectionRefusedError):
                    result = runner.stop_and_verify_backend_cleanup(wave)
                self.assertEqual(result['status'], 'FAIL')
                self.assertEqual(result['reason'], reason)

    def test_cleanup_requires_complete_receipt_and_untouched_foreign_services(self):
        cases = (
            ({'status': 'PASS'}, 'BACKEND_CLEANUP_RECEIPT_INVALID'),
            (valid_cleanup_receipt(ownedServerStopped=False), 'BACKEND_CLEANUP_INCOMPLETE'),
            (valid_cleanup_receipt(ownedPostgresStopped=False), 'BACKEND_CLEANUP_INCOMPLETE'),
            (valid_cleanup_receipt(ownedClusterStorageAndDotenvRemoved=False), 'BACKEND_CLEANUP_INCOMPLETE'),
            (valid_cleanup_receipt(runtimePreservedForResume=True), 'BACKEND_RUNTIME_PRESERVED_FOR_RESUME'),
            (valid_cleanup_receipt(personalServicesTouched=True), 'BACKEND_PERSONAL_SERVICES_TOUCHED'),
            (valid_cleanup_receipt(failureClass='BOOM'), 'BACKEND_CLEANUP_FAILED'),
            (valid_cleanup_receipt(errors=[{'stage': 'server_stop', 'error': 'OSError'}]), 'BACKEND_CLEANUP_ERRORS_REPORTED'),
            (valid_cleanup_receipt(status='FAIL'), 'BACKEND_CLEANUP_FAILED'),
        )
        for receipt, reason in cases:
            with self.subTest(reason=reason, receipt=receipt), tempfile.TemporaryDirectory() as temporary:
                wave, out, _authority, _identity = cleanup_wave(Path(temporary))
                (out / 'pipeline/backend-live.json').write_text(json.dumps({
                    'status': 'READY', 'backendOrigin': 'http://127.0.0.1:49999', 'isolated': True}))
                (out / 'baseline/backend-runtime.local.json').write_text(json.dumps(runtime_config(out)))
                (out / 'pipeline/backend-runtime-cleanup.json').write_text(json.dumps(receipt))
                with patch('socket.create_connection', side_effect=ConnectionRefusedError):
                    result = runner.stop_and_verify_backend_cleanup(wave)
                self.assertEqual(result['status'], 'FAIL')
                self.assertEqual(result['reason'], reason)

    def test_cleanup_active_listener_is_fail_not_exception(self):
        with tempfile.TemporaryDirectory() as temporary:
            wave, out, _authority, _identity = cleanup_wave(Path(temporary))
            (out / 'pipeline/backend-live.json').write_text(json.dumps({
                'status': 'READY', 'backendOrigin': 'http://127.0.0.1:49999', 'isolated': True}))
            (out / 'baseline/backend-runtime.local.json').write_text(json.dumps(runtime_config(out)))
            (out / 'pipeline/backend-runtime-cleanup.json').write_text(json.dumps(valid_cleanup_receipt()))
            connection = type('Connection', (), {'close': lambda _self: None})()
            with patch('socket.create_connection', return_value=connection):
                result = runner.stop_and_verify_backend_cleanup(wave)
            self.assertEqual(result['status'], 'FAIL')
            self.assertEqual(result['reason'], 'BACKEND_LISTENER_STILL_ACTIVE')

    def test_cleanup_missing_or_corrupt_receipt_is_unverified(self):
        for receipt, reason in ((None, 'BACKEND_CLEANUP_RECEIPT_MISSING'),
                               ('{not-json', 'BACKEND_CLEANUP_RECEIPT_CORRUPT')):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as temporary:
                wave, out, _authority, _identity = cleanup_wave(Path(temporary))
                (out / 'pipeline/backend-live.json').write_text(json.dumps({
                    'status': 'READY', 'backendOrigin': 'http://127.0.0.1:49999', 'isolated': True}))
                (out / 'baseline/backend-runtime.local.json').write_text(json.dumps(runtime_config(out)))
                if receipt is not None:
                    (out / 'pipeline/backend-runtime-cleanup.json').write_text(receipt, encoding='utf-8')
                with patch('socket.create_connection', side_effect=ConnectionRefusedError):
                    result = runner.stop_and_verify_backend_cleanup(wave)
                self.assertEqual(result['status'], 'UNVERIFIED')
                self.assertEqual(result['reason'], reason)

    def test_cleanup_runtime_still_exists_and_readback_mismatch_block_pass(self):
        with tempfile.TemporaryDirectory() as temporary:
            wave, out, _authority, _identity = cleanup_wave(Path(temporary))
            (out / 'pipeline/backend-live.json').write_text(json.dumps({
                'status': 'READY', 'backendOrigin': 'http://127.0.0.1:49999', 'isolated': True}))
            config = runtime_config(out)
            (out / 'baseline/backend-runtime.local.json').write_text(json.dumps(config))
            (out / 'pipeline/backend-runtime-cleanup.json').write_text(json.dumps(valid_cleanup_receipt()))
            Path(config['cwd']).mkdir(parents=True)
            with patch('socket.create_connection', side_effect=ConnectionRefusedError):
                result = runner.stop_and_verify_backend_cleanup(wave)
            self.assertEqual(result['status'], 'FAIL')
            self.assertEqual(result['reason'], 'BACKEND_RUNTIME_STILL_EXISTS')

        with tempfile.TemporaryDirectory() as temporary:
            wave, out, _authority, _identity = cleanup_wave(Path(temporary))
            (out / 'pipeline/backend-live.json').write_text(json.dumps({
                'status': 'READY', 'backendOrigin': 'http://127.0.0.1:49999', 'isolated': True}))
            (out / 'baseline/backend-runtime.local.json').write_text(json.dumps(runtime_config(out)))
            (out / 'pipeline/backend-runtime-cleanup.json').write_text(json.dumps(valid_cleanup_receipt()))
            with patch('socket.create_connection', side_effect=ConnectionRefusedError), \
                 patch.object(runner, 'verify_publication', return_value={'files': [
                     {'path': 'evidence/backend-runtime-cleanup.json', 'sha256': '0' * 64}]}):
                result = runner.stop_and_verify_backend_cleanup(wave)
            self.assertEqual(result['status'], 'FAIL')
            self.assertEqual(result['reason'], 'BACKEND_CLEANUP_READBACK_MISMATCH')

    def test_cleanup_valid_receipt_publishes_and_verifies(self):
        with tempfile.TemporaryDirectory() as temporary:
            wave, out, authority, identity = cleanup_wave(Path(temporary))
            (out / 'pipeline/backend-live.json').write_text(json.dumps({
                'status': 'READY', 'backendOrigin': 'http://127.0.0.1:49999', 'isolated': True}))
            (out / 'baseline/backend-runtime.local.json').write_text(json.dumps(runtime_config(out)))
            cleanup_file = out / 'pipeline/backend-runtime-cleanup.json'
            cleanup_file.write_text(json.dumps(valid_cleanup_receipt()))
            with patch('socket.create_connection', side_effect=ConnectionRefusedError):
                result = runner.stop_and_verify_backend_cleanup(wave)
            self.assertEqual(result['status'], 'PASS')
            self.assertTrue(result['backendStarted'])
            self.assertEqual(result['receiptSha256'], sha256(cleanup_file))
            manifest = verify_publication(authority, identity, 'backend-cleanup')
            entry = next(row for row in manifest['files']
                if row['path'] == 'evidence/backend-runtime-cleanup.json')
            self.assertEqual(entry['sha256'], sha256(cleanup_file))

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

            # Verify byte-for-byte hash equality between local STOP.json and published authority evidence
            local_stop = out / 'final/STOP.json'
            local_hash = sha256(local_stop)
            manifest = verify_publication(authority, identity, 'stop')
            self.assertEqual(manifest['campaign'], CAMPAIGN)
            stop_entry = next(f for f in manifest['files'] if f['path'] == 'evidence/STOP.json')
            self.assertEqual(stop_entry['sha256'], local_hash)

            # Local STOP.json does NOT contain publicationStatus (immutable after publication)
            stop_data = json.loads(local_stop.read_text(encoding='utf-8-sig'))
            self.assertNotIn('publicationStatus', stop_data)

            # Publication readback is stored in separate receipt
            readback_file = out / 'final/stop-publication-readback.json'
            self.assertTrue(readback_file.is_file())
            readback_data = json.loads(readback_file.read_text(encoding='utf-8-sig'))
            self.assertEqual(readback_data['status'], 'PASS')
            self.assertEqual(readback_data['stopSha256'], local_hash)
            self.assertTrue(readback_data['independentReadback'])

            # Re-execution when STOP already exists preserves the file without mutation
            payload2 = r14.record_durable_stop(wave, 'SOME_OTHER_ERROR', stage='later')
            self.assertEqual(payload2['failureClass'], 'CAPABILITY_EXECUTION_FAILED')
            self.assertEqual(sha256(local_stop), local_hash)

    def test_record_durable_stop_publication_failure_preserves_local_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); authority = base / 'authority'; identity = 'a' * 64
            # Authority is NOT initialized -> publish will fail
            out = base / 'output'; (out / 'pipeline').mkdir(parents=True); (out / 'baseline').mkdir(parents=True)
            (out / 'final').mkdir(parents=True)
            (out / 'baseline/authority-config.local.json').write_text(json.dumps(
                {'AP06_AUTHORITY_ROOT': str(authority), 'identity': identity}), encoding='utf-8')
            wave = type('Wave', (), {'output': out, 'save': lambda _self, name, value:
                (out / name).write_text(json.dumps(value), encoding='utf-8')})()

            payload = r14.record_durable_stop(wave, 'PREFLIGHT_ABORTED', stage='preflight')
            self.assertEqual(payload['status'], 'STOP')
            self.assertEqual(payload['reason'], 'PREFLIGHT_ABORTED')
            self.assertEqual(payload['publicationStatus'], 'FAIL')

            local_stop = out / 'final/STOP.json'
            self.assertTrue(local_stop.is_file())
            stop_data = json.loads(local_stop.read_text(encoding='utf-8-sig'))
            self.assertEqual(stop_data['reason'], 'PREFLIGHT_ABORTED')
            self.assertNotIn('publicationStatus', stop_data)

            readback_file = out / 'final/stop-publication-readback.json'
            self.assertTrue(readback_file.is_file())
            readback_data = json.loads(readback_file.read_text(encoding='utf-8-sig'))
            self.assertEqual(readback_data['status'], 'FAIL')
            self.assertFalse(readback_data['independentReadback'])

    def test_record_durable_stop_cleanup_error_does_not_mask_original_reason(self):
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
            # Missing cleanup receipt -> cleanup status UNVERIFIED
            with patch('socket.create_connection', side_effect=ConnectionRefusedError):
                payload = r14.record_durable_stop(wave, 'ORIGINAL_FAILURE_REASON', stage='execution')

            self.assertEqual(payload['status'], 'STOP')
            self.assertEqual(payload['reason'], 'ORIGINAL_FAILURE_REASON')
            self.assertEqual(payload['failureClass'], 'ORIGINAL_FAILURE_REASON')
            self.assertEqual(payload['cleanupStatus'], 'UNVERIFIED')

    def _setup_capability_wave(self, temporary):
        base = Path(temporary); authority = base / 'authority'; identity = 'a' * 64
        initialize(authority, identity, campaign=CAMPAIGN)
        out = base / 'output'; (out / 'pipeline').mkdir(parents=True); (out / 'baseline').mkdir(parents=True)
        (out / 'final').mkdir(parents=True)
        (out / 'baseline/authority-config.local.json').write_text(json.dumps(
            {'AP06_AUTHORITY_ROOT': str(authority), 'identity': identity}), encoding='utf-8')
        (out / 'pipeline/native-receipt.json').write_text(json.dumps(capability_receipt_payload()))
        (out / 'pipeline/native-trace.json').write_text(json.dumps({'authorityRelativePath': 'traces/cap.json'}))
        (out / 'baseline/browser-identity.json').write_text('{}')
        wave = type('Wave', (), {'root': base, 'node': 'node', 'output': out, 'save': lambda _self, name, value:
            (out / name).write_text(json.dumps(value), encoding='utf-8'),
            'command': lambda *a, **k: None})()
        return wave, base, out

    def test_runner_classification_capability_pass_authorizes_ab(self):
        with tempfile.TemporaryDirectory() as temporary:
            wave, base, _out = self._setup_capability_wave(temporary)
            with patch('run_ap06_r12_r13_native.validate_trace', return_value={'status': 'NATIVE_CAPABILITY_PASS'}), \
                 patch('run_ap06_r12_r13_native.verify_frozen_campaign', return_value={'implementationHead': 'a'*40}), \
                 patch('run_ap06_r12_r13_native.configure_native', return_value=type('N', (), {'environment': lambda *a, **k: ({}, []), 'seal_trace': lambda *a, **k: None})()), \
                 patch('run_ap06_r12_r13_native.load_native_budget', return_value=None), \
                 patch('run_ap06_r12_r2.validate_browser_receipt', return_value=None), \
                 patch('run_ap06_r12_r13_native.run_profiled_pair', return_value={'status': 'R12R14_NATIVE_TRACKED_AGGREGATES_OBSERVED'}) as mock_ab:
                res = r14.run_capability(wave, base / 'hist')
                self.assertEqual(res['status'], 'R12R14_NATIVE_TRACKED_AGGREGATES_OBSERVED')
                mock_ab.assert_called_once()

    def test_runner_classification_capability_inconclusive_publishes_decision(self):
        with tempfile.TemporaryDirectory() as temporary:
            wave, base, _out = self._setup_capability_wave(temporary)
            with patch('run_ap06_r12_r13_native.validate_trace', return_value={'status': 'NATIVE_INCONCLUSIVE', 'reason': 'NATIVE_HEAPS_V2_NOT_EMITTED'}), \
                 patch('run_ap06_r12_r13_native.verify_frozen_campaign', return_value={'implementationHead': 'a'*40}), \
                 patch('run_ap06_r12_r13_native.configure_native', return_value=type('N', (), {'environment': lambda *a, **k: ({}, []), 'seal_trace': lambda *a, **k: None})()), \
                 patch('run_ap06_r12_r13_native.load_native_budget', return_value=None), \
                 patch('run_ap06_r12_r2.validate_browser_receipt', return_value=None), \
                 patch('run_ap06_r12_r13_native.stop_and_verify_backend_cleanup', return_value={'status': 'PASS'}):
                res = r14.run_capability(wave, base / 'hist')
                self.assertEqual(res['status'], 'R12R14_NATIVE_CAPABILITY_INCONCLUSIVE')
                self.assertEqual(res['reason'], 'NATIVE_HEAPS_V2_NOT_EMITTED')
                self.assertFalse(res['abAuthorized'])

    def test_runner_classification_capability_stop_raises_contract_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            wave, base, _out = self._setup_capability_wave(temporary)
            with patch('run_ap06_r12_r13_native.validate_trace', return_value={'status': 'NATIVE_STOP', 'reason': 'NATIVE_ALLOCATOR_STATS_DUPLICATE'}), \
                 patch('run_ap06_r12_r13_native.verify_frozen_campaign', return_value={'implementationHead': 'a'*40}), \
                 patch('run_ap06_r12_r13_native.configure_native', return_value=type('N', (), {'environment': lambda *a, **k: ({}, []), 'seal_trace': lambda *a, **k: None})()), \
                 patch('run_ap06_r12_r13_native.load_native_budget', return_value=None), \
                 patch('run_ap06_r12_r2.validate_browser_receipt', return_value=None):
                with self.assertRaises(r14.NativeContractFailure) as ctx:
                    r14.run_capability(wave, base / 'hist')
                self.assertEqual(ctx.exception.reason, 'NATIVE_ALLOCATOR_STATS_DUPLICATE')

    def test_runner_classification_unknown_status_raises_value_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            wave, base, _out = self._setup_capability_wave(temporary)
            with patch('run_ap06_r12_r13_native.validate_trace', return_value={'status': 'UNEXPECTED_STATUS'}), \
                 patch('run_ap06_r12_r13_native.verify_frozen_campaign', return_value={'implementationHead': 'a'*40}), \
                 patch('run_ap06_r12_r13_native.configure_native', return_value=type('N', (), {'environment': lambda *a, **k: ({}, []), 'seal_trace': lambda *a, **k: None})()), \
                 patch('run_ap06_r12_r13_native.load_native_budget', return_value=None), \
                 patch('run_ap06_r12_r2.validate_browser_receipt', return_value=None):
                with self.assertRaisesRegex(ValueError, 'NATIVE_CAPABILITY_STATUS_INVALID'):
                    r14.run_capability(wave, base / 'hist')

    def _profiled_wave(self, temporary):
        wave, out, authority, identity = cleanup_wave(Path(temporary))
        write_capability_accounting(out)
        (out / 'final').mkdir()
        wave.root = Path(temporary)
        return wave, out, authority, identity

    def _measure_fixture(self, calls):
        def fake_measure(wave, condition, stage, _frozen, ledger, requested, directory_name, **_kwargs):
            self.assertEqual(requested, 1)
            calls.append(condition)
            row = write_measurement_accounting(wave.output, condition, ledger=ledger)
            wave.save('pipeline/launch-ledger.json', ledger)
            directory = wave.output / 'formal' / directory_name
            (directory / 'native-trace.json').write_text(json.dumps({
                'authorityRelativePath': 'traces/x.json'}), encoding='utf-8')
            return {'rawSha256': row['rawSha256'], 'rawPath': row['rawPath']}
        return fake_measure

    def test_profiled_pair_native_stop_is_formal_stop_after_first_aggregate(self):
        with tempfile.TemporaryDirectory() as temporary:
            wave, out, _authority, _identity = self._profiled_wave(temporary)
            calls = []
            with patch('run_ap06_r9.measure', side_effect=self._measure_fixture(calls)), \
                 patch.object(runner, 'validate_trace', side_effect=[
                     {'status': 'NATIVE_STOP', 'reason': 'NATIVE_ALLOCATOR_STATS_DUPLICATE'}]), \
                 patch.object(runner, 'publish') as publish_mock, \
                 patch.object(runner, 'stop_and_verify_backend_cleanup', return_value={'status': 'PASS'}):
                with self.assertRaises(runner.NativeContractFailure) as context:
                    runner.run_profiled_pair(wave, Path(temporary) / 'historical',
                        {'implementationHead': 'h' * 40},
                        SimpleNamespace(environment=lambda *_a, **_k: ({}, [])))
            self.assertEqual(context.exception.reason, 'NATIVE_ALLOCATOR_STATS_DUPLICATE')
            self.assertEqual(calls, ['r12r2.0'])
            self.assertFalse((out / 'formal/05-r12r2.0/native-aggregate.json').exists())
            self.assertFalse((out / 'final/decision.json').exists())
            publish_mock.assert_not_called()

    def test_profiled_pair_inconclusive_halts_without_second_measurement(self):
        with tempfile.TemporaryDirectory() as temporary:
            wave, out, _authority, _identity = self._profiled_wave(temporary)
            calls = []
            with patch('run_ap06_r9.measure', side_effect=self._measure_fixture(calls)), \
                 patch.object(runner, 'validate_trace', side_effect=[
                     {'status': 'NATIVE_INCONCLUSIVE', 'reason': 'NATIVE_HEAPS_V2_NOT_EMITTED'}]), \
                 patch.object(runner, 'publish'), \
                 patch.object(runner, 'stop_and_verify_backend_cleanup', return_value={'status': 'PASS'}):
                decision = runner.run_profiled_pair(wave, Path(temporary) / 'historical',
                    {'implementationHead': 'h' * 40},
                    SimpleNamespace(environment=lambda *_a, **_k: ({}, [])))
            self.assertEqual(decision['status'], 'R12R14_NATIVE_ALLOCATION_COVERAGE_INSUFFICIENT')
            self.assertEqual(decision['reason'], 'NATIVE_HEAPS_V2_NOT_EMITTED')
            self.assertEqual(decision['measurementChromium'], 1)
            self.assertFalse(decision['abAuthorized'])
            self.assertEqual(calls, ['r12r2.0'])
            self.assertTrue((out / 'final/decision.json').is_file())

    def test_profiled_pair_consumption_comes_from_ledger_and_raw_receipts(self):
        with tempfile.TemporaryDirectory() as temporary:
            wave, _out, _authority, _identity = self._profiled_wave(temporary)
            calls = []
            with patch('run_ap06_r9.measure', side_effect=self._measure_fixture(calls)), \
                 patch.object(runner, 'validate_trace',
                     side_effect=[{'status': 'NATIVE_CAPABILITY_PASS'}, {'status': 'NATIVE_CAPABILITY_PASS'}]), \
                 patch.object(runner, 'publish'), \
                 patch.object(runner, 'stop_and_verify_backend_cleanup', return_value={'status': 'PASS'}):
                decision = runner.run_profiled_pair(wave, Path(temporary) / 'historical',
                    {'implementationHead': 'h' * 40},
                    SimpleNamespace(environment=lambda *_a, **_k: ({}, [])))
            self.assertEqual(decision['status'], 'R12R14_NATIVE_TRACKED_AGGREGATES_OBSERVED')
            self.assertEqual(decision['capabilityChromium'], 1)
            self.assertEqual(decision['measurementChromium'], 2)
            self.assertEqual(decision['retries'], 0)
            self.assertEqual(calls, ['r12r2.0', 'r12r2.2'])

    def test_profiled_pair_marks_unverified_measurement_consumption(self):
        with tempfile.TemporaryDirectory() as temporary:
            wave, out, _authority, _identity = self._profiled_wave(temporary)
            calls = []
            measure = self._measure_fixture(calls)
            def missing_a_receipt(*args, **kwargs):
                result = measure(*args, **kwargs)
                if args[1] == 'r12r2.0':
                    (args[0].output / 'formal/05-r12r2.0/native-receipt.json').unlink()
                return result
            with patch.object(runner, 'validate_trace',
                     side_effect=[{'status': 'NATIVE_CAPABILITY_PASS'}, {'status': 'NATIVE_CAPABILITY_PASS'}]), \
                 patch.object(runner, 'publish'), \
                 patch.object(runner, 'stop_and_verify_backend_cleanup', return_value={'status': 'PASS'}):
                with patch('run_ap06_r9.measure', side_effect=missing_a_receipt):
                    with self.assertRaisesRegex(runner.NativeContractFailure, 'NATIVE_CONSUMPTION_UNVERIFIED'):
                        runner.run_profiled_pair(wave, Path(temporary) / 'historical',
                            {'implementationHead': 'h' * 40},
                            SimpleNamespace(environment=lambda *_a, **_k: ({}, [])))
            self.assertFalse((out / 'final/decision.json').exists())

    def test_inconclusive_decision_consumption_comes_from_durable_receipts(self):
        with tempfile.TemporaryDirectory() as temporary:
            wave, out, _authority, _identity = self._profiled_wave(temporary)
            (out / 'pipeline/native-receipt.json').unlink()
            with patch.object(runner, 'publish') as publish_mock, \
                 patch.object(runner, 'stop_and_verify_backend_cleanup', return_value={'status': 'PASS'}):
                with self.assertRaisesRegex(runner.NativeContractFailure, 'NATIVE_CONSUMPTION_UNVERIFIED'):
                    runner.publish_inconclusive_decision(wave, {
                        'status': 'NATIVE_INCONCLUSIVE', 'reason': 'NATIVE_HEAPS_V2_NOT_EMITTED'})
            self.assertFalse((out / 'final/decision.json').exists())
            publish_mock.assert_not_called()

    def test_backend_cleanup_failure_blocks_green_inconclusive(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); authority = base / 'authority'; identity = 'a' * 64
            initialize(authority, identity, campaign=CAMPAIGN)
            out = base / 'output'; (out / 'pipeline').mkdir(parents=True); (out / 'baseline').mkdir(parents=True)
            (out / 'final').mkdir(parents=True)
            (out / 'baseline/authority-config.local.json').write_text(json.dumps(
                {'AP06_AUTHORITY_ROOT': str(authority), 'identity': identity}), encoding='utf-8')
            wave = type('Wave', (), {'output': out, 'save': lambda _self, name, value:
                (out / name).write_text(json.dumps(value), encoding='utf-8')})()

            # When backend cleanup returns UNVERIFIED during inconclusive decision publication, it must raise NativeContractFailure
            cap = {'status': 'NATIVE_INCONCLUSIVE', 'reason': 'NATIVE_HEAPS_V2_NOT_EMITTED'}
            with patch('run_ap06_r12_r13_native.stop_and_verify_backend_cleanup', return_value={'status': 'UNVERIFIED', 'reason': 'RECEIPT_MISSING'}):
                with self.assertRaises(r14.NativeContractFailure) as ctx:
                    r14.publish_inconclusive_decision(wave, cap)
                self.assertEqual(ctx.exception.reason, 'BACKEND_CLEANUP_UNVERIFIED')

            # When backend cleanup returns FAIL, it must raise NativeContractFailure
            with patch('run_ap06_r12_r13_native.stop_and_verify_backend_cleanup', return_value={'status': 'FAIL', 'reason': 'RUNTIME_STILL_EXISTS'}):
                with self.assertRaises(r14.NativeContractFailure) as ctx:
                    r14.publish_inconclusive_decision(wave, cap)
                self.assertEqual(ctx.exception.reason, 'BACKEND_CLEANUP_FAIL')

    def test_dynamic_backend_port_discovery(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); authority = base / 'authority'; identity = 'a' * 64
            initialize(authority, identity, campaign=CAMPAIGN)
            out = base / 'output'; (out / 'pipeline').mkdir(parents=True); (out / 'baseline').mkdir(parents=True)
            (out / 'baseline/authority-config.local.json').write_text(json.dumps(
                {'AP06_AUTHORITY_ROOT': str(authority), 'identity': identity}), encoding='utf-8')
            # Dynamic port configured
            (out / 'pipeline/backend-live.json').write_text(json.dumps({
                'status': 'READY', 'backendOrigin': 'http://127.0.0.1:49999', 'isolated': True
            }), encoding='utf-8')
            (out / 'baseline/backend-runtime.local.json').write_text(
                json.dumps(runtime_config(out, port=49999)), encoding='utf-8')
            (out / 'pipeline/backend-runtime-cleanup.json').write_text(
                json.dumps(valid_cleanup_receipt()), encoding='utf-8')

            wave = type('Wave', (), {'output': out, 'save': lambda _self, name, value:
                (out / name).parent.mkdir(parents=True, exist_ok=True) or
                (out / name).write_text(json.dumps(value), encoding='utf-8')})()

            probed_ports = []
            def fake_create_connection(addr, timeout=1):
                probed_ports.append(addr[1])
                raise ConnectionRefusedError('Connection refused')

            with patch('socket.create_connection', side_effect=fake_create_connection):
                res = r14.stop_and_verify_backend_cleanup(wave)
                self.assertEqual(res['status'], 'PASS')
                self.assertIn(49999, probed_ports)
                self.assertNotIn(42187, probed_ports)

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
                    dump_guid = hex(i + 1)
                    events.extend([
                        {'ph': 'b', 'pid': 99, 'ts': (i + 1) * 100 - 1, 'id2': {'local': dump_guid},
                            'name': 'GlobalMemoryDump', 'cat': ['disabled-by-default-memory-infra'],
                            'args': {'dump_guid': dump_guid, 'dump_type': 'explicitly_triggered',
                                'level_of_detail': 'detailed', 'success': True}},
                        {'ph': 'e', 'pid': 99, 'ts': (i + 1) * 100 + 1, 'id2': {'local': dump_guid},
                            'name': 'GlobalMemoryDump', 'cat': ['disabled-by-default-memory-infra']},
                    ])
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
                    'trace': {'tracingStarted': True, 'memoryInfraCategoryAvailable': True,
                        'activatedBeforeWorkload': True, 'complete': True, 'streamEof': True,
                        'dataLossOccurred': False, 'traceFormat': 'json', 'rendererPid': 42,
                        'checkpoints': [{'phase': p, 'dumpGuid': hex(i + 1), 'success': True,
                            'timestamp': i + 1} for i, p in enumerate(PHASES)],
                        'sha256': sha256(trace_path), 'bytes': trace_path.stat().st_size},
                    'processExitAudit': {'status': 'PASS', 'method': 'retained-win32-process-handles', 'processes': [{'pid': 42, 'creationTime': 100, 'roles': ['renderer']}]},
                    'processSamples': [{'phase': p, 'processes': [{'pid': 42, 'type': 'renderer'}]} for p in PHASES],
                    'handleRelease': {'status': 'PASS', 'processHandles': {'releasedProcessHandles': 1, 'closeFailures': 0}},
                    'browserIdentity': {'before': {'nativeFlagsValidated': True}, 'browserClosed': True, 'cleanupStatus': 'PASS'},
                }
                receipt_p.write_text(json.dumps(rec), encoding='utf-8')
                (output / 'pipeline/native-trace.json').write_text(json.dumps({
                    'authorityRelativePath': 'r12-r14-native/traces/r12-r14-native-trace-capability.json'
                }), encoding='utf-8')
                (output / 'pipeline/backend-live.json').write_text(json.dumps({
                    'status': 'READY', 'backendOrigin': 'http://127.0.0.1:49999', 'isolated': True
                }), encoding='utf-8')
                (output / 'baseline/backend-runtime.local.json').write_text(
                    json.dumps(runtime_config(output, port=49999)), encoding='utf-8')
                (output / 'pipeline/backend-runtime-cleanup.json').write_text(
                    json.dumps(valid_cleanup_receipt()), encoding='utf-8')

            wave.command = fake_capability_command

            frozen_mock = {'status': 'FROZEN', 'implementationHead': 'a' * 40}
            with patch('run_ap06_r12_r13_native.verify_frozen_campaign', return_value=frozen_mock):
                with patch('run_ap06_r12_r2.validate_browser_receipt', return_value=None):
                    with patch('run_ap06_r12_r2_native.environment', return_value=({}, [])):
                        with patch('socket.create_connection',
                                side_effect=ConnectionRefusedError('Connection refused')):
                            decision = r14.run_capability(wave, root / 'historical')

            # Verify conclusive handling: heaps_v2 not emitted -> INCONCLUSIVE decision, 0 A/B launches
            self.assertEqual(decision['status'], 'R12R14_NATIVE_CAPABILITY_INCONCLUSIVE')
            self.assertEqual(decision['capabilityChromium'], 1)
            self.assertEqual(decision['measurementChromium'], 0)
            self.assertFalse(decision['abAuthorized'])
            self.assertEqual(decision['cleanupStatus'], 'PASS')
            self.assertTrue((final / 'decision.json').is_file())
            manifest = verify_publication(authority, identity, 'r12-r14-native-decision')
            self.assertEqual(manifest['campaign'], CAMPAIGN)

            # Reexecution forbidden
            with self.assertRaisesRegex(ValueError, 'R12R14_NATIVE_NO_RETRY_OR_RESUME'):
                r14.run_capability(wave, root / 'historical')


if __name__ == '__main__':
    unittest.main()
