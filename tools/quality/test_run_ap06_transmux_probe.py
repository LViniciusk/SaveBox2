import json
import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from run_ap06_transmux_probe import (BROWSER_CEILING, CRYPTO, DOES_NOT, INCONCLUSIVE, PLAIN,
    REPRODUCES, after_chromium_preflight, classify, continuation_output, ensure_browser_budget,
    historical_r5_evidence, historical_r5_r1_evidence, next_stage, claim_stage, cycle6_process_deltas,
    validate_chromium_preflight, validate_raw,
    verify_frozen_authorities, verify_stage_raws)
import run_ap06_transmux_probe as runner
from run_playwright_campaign_env import EnvironmentFailure
from run_readiness_wave1 import WaveFailure


SOURCE = 'source-hash'
FIXTURE = 'fixture-hash'
VERSION = '151.0.7922.34'
OWNERSHIP = {key: 0 for key in ('liveKnownArrayBufferBytes', 'knownTransmuxInputBytes', 'knownTransmuxOutputBytes',
    'pendingTransmuxMessages', 'transmuxWorkersLive', 'workerUrlsLive', 'sourceBuffersLive', 'mediaSourcesLive',
    'objectUrlsLive', 'pendingAppends', 'pendingFetches')}


def summary(browser=1, renderer=20):
    return {'phases': [{'phase': 'cycle-6-close', 'gc': 'natural', 'processTypes': {
        'browser': {'privateBytes': {'signedDelta': {'median': browser}}},
        'renderer': {'privateBytes': {'signedDelta': {'median': renderer}}}}}]}


def raw(stage='triage', mode=PLAIN, count=1):
    runs = []
    for index in range(count):
        run_id = f'{stage}-{mode}-r{index + 1}'
        samples = []
        for phase, cycle, gc in [('baseline', 0, 'natural')] + [(f'cycle-{n}-close', n, 'natural') for n in range(1, 7)] + [('forced-GC-final', 6, 'forced-diagnostic')]:
            sessions = cycle * 3
            counters = {name: sessions for name in ('mediaSourceCreated', 'mediaSourceClosed', 'objectUrlsCreated',
                'objectUrlsRevoked', 'sourceBuffersCreated', 'sourceBuffersReleased', 'fetchesStarted', 'fetchesCompleted',
                'transmuxWorkersCreated', 'transmuxWorkersTerminated', 'bootstrapMessagesSent', 'bootstrapResponsesReceived',
                'transmuxChunksSent', 'transmuxResponsesReceived')}
            samples.append({'runId': run_id, 'phase': phase, 'cycle': cycle, 'gc': gc, 'sourceHash': SOURCE,
                'browserVersion': VERSION,
                'fixtureHash': FIXTURE, 'functionalStatus': 'PASS', 'cleanupStatus': 'PASS', 'mediaNodes': 0,
                'processMemory': {'status': 'AVAILABLE', 'byType': {
                    'browser': {'privateBytes': 100}, 'renderer': {'privateBytes': 200}}},
                'ownership': dict(OWNERSHIP), 'counters': counters})
        runs.append({'runId': run_id, 'mode': mode, 'functionalStatus': 'PASS', 'cleanupStatus': 'PASS',
            'browserVersion': VERSION,
            'playbackSessions': 18, 'extendedForPlateau': False,
            'supportedCodecs': [{'codec': 'video/mp4; codecs="avc1"', 'supported': True}], 'samples': samples})
    return {'mode': mode, 'stage': stage, 'expectedChromiumVersion': VERSION,
        'browserLaunches': count, 'launchAttempts': count, 'processSampleCalls': count * 8, 'retries': 0,
        'playwrightRoutingInstalled': False, 'fetchInterceptionInstalled': False, 'videoStreamServiceUsed': False,
        'angularOrBackendUsed': False, 'fixtureManifestSha256': FIXTURE, 'runs': runs,
        'summary': summary()}


class RunnerProtocolTests(unittest.TestCase):
    def test_r2_main_orders_authorities_units_preflight_fixture_then_measurement(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for relative in runner.TOOLING_PATHS:
                path = root / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('test')
            (root / 'frontend/angular.json').write_text('{}')
            historical = root / runner.HISTORICAL_OUTPUT / 'baseline'; historical.mkdir(parents=True)
            (root / runner.R1_OUTPUT).mkdir(parents=True)
            source = {'trees': {'frontend/src': 'prod'}, 'files': {}, 'historicalArtifacts': {},
                'groups': {'frontend-player-production': SOURCE}, 'historicalReadinessRoots': {},
                'wave3Ap06Expected': 'ap06', 'frontendBuildTree': 'build'}
            for name, value in [('source-hashes', source), ('tool-versions', {
                    'chromium': {'version': VERSION}, 'node': 'test-node', 'ffmpeg': 'test-ffmpeg'}),
                    ('environment', {})]:
                (historical / f'{name}.json').write_text(json.dumps(value))
            calls = []
            wave = runner.Wave(root)
            def command(name, *_args):
                if name == 'ap06-transmux-node-tests': calls.append('node-tests'); return '# tests 1\n# pass 1\n# fail 0'
                if name == 'ap06-transmux-python-tests': calls.append('python-tests'); return 'Ran 1 test\nOK'
                if name == 'chromium-identity-preflight':
                    calls.append('preflight')
                    return json.dumps({'status': 'PASS', 'expectedVersion': VERSION, 'observedVersion': VERSION,
                        'authority': 'playwright-chromium-executable', 'method': 'windows-file-version',
                        'processInvoked': True, 'executablePath': 'private-path.exe', 'nodeVersion': 'test-node'})
                if name == 'ffmpeg-version': calls.append('ffmpeg'); return 'test-ffmpeg'
                self.fail(f'Unexpected subprocess: {name}')
            def capture():
                calls.append('production'); return json.loads(json.dumps(source))
            with contextlib.ExitStack() as stack:
                for target, value in [
                        ('__file__', str(root / 'tools/quality/runner.py')),
                        ('Wave', lambda _: wave),
                        ('historical_r5_evidence', lambda _: calls.append('r5') or {'treeSha256': 'r5'}),
                        ('historical_r5_r1_evidence', lambda _: calls.append('r1') or {'treeSha256': 'r1'}),
                        ('verify_frozen_authorities', lambda *_a, **_k: source),
                        ('fixture_worker_authority', lambda *_a: calls.append('worker') or {
                            'transmuxWorker': {'sha256': 'worker'}, 'chromiumVersion': VERSION}),
                        ('prepare_plain', lambda *_a: calls.append('fixtures') or [{'id': 0, 'sha256': 'fixture'}]),
                        ('run_condition', lambda *_a: calls.append('measure') or {'classification': INCONCLUSIVE}),
                ]:
                    stack.enter_context(patch.object(runner, target, value))
                stack.enter_context(patch.object(wave, 'capture_hashes', capture))
                stack.enter_context(patch.object(wave, 'git', return_value=''))
                stack.enter_context(patch.object(wave, 'dependencies', return_value=None))
                stack.enter_context(patch.object(wave, 'command', command))
                stack.enter_context(patch.object(runner.shutil, 'which', return_value='owned-ffmpeg'))
                stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                self.assertEqual(runner.main(['--continuation-r2']), 0)
            self.assertEqual(calls, ['r5', 'r1', 'production', 'worker', 'node-tests', 'python-tests',
                'preflight', 'ffmpeg', 'fixtures', 'measure'])
            preflight = json.loads((root / runner.R2_OUTPUT / 'baseline/chromium-preflight.json').read_text())
            self.assertNotIn('executablePath', preflight)

    def test_first_boundary_controls_escalation_and_formal_selection(self):
        self.assertEqual(next_stage(PLAIN, REPRODUCES), ('formal', PLAIN))
        self.assertNotEqual(next_stage(PLAIN, REPRODUCES), ('triage', CRYPTO))
        self.assertEqual(next_stage(PLAIN, DOES_NOT), ('triage', CRYPTO))
        self.assertEqual(next_stage(CRYPTO, 'CRYPTO_TRANSMUX_MSE_REPRODUCES_BROWSER_PROCESS_OWNERSHIP'), ('formal', CRYPTO))
        self.assertIsNone(next_stage(CRYPTO, 'CRYPTO_TRANSMUX_MSE_DOES_NOT_REPRODUCE'))
        self.assertIsNone(next_stage(PLAIN, INCONCLUSIVE))

    def test_browser_budget_is_hard_and_no_retry_is_part_of_raw_protocol(self):
        ensure_browser_budget(3, 3)
        ensure_browser_budget(0, 1)  # the historical invalid launch has its own budget
        self.assertEqual(BROWSER_CEILING, 6)
        with self.assertRaisesRegex(WaveFailure, 'BROWSER_BUDGET_EXCEEDED'):
            ensure_browser_budget(4, 3)
        value = raw(); value['retries'] = 1
        with self.assertRaisesRegex(WaveFailure, 'LAUNCH_PROTOCOL_INVALID'):
            validate_raw(value, 'triage', PLAIN, SOURCE, FIXTURE, expected_chromium_version=VERSION)

    def test_triage_launches_one_and_formal_launches_exactly_three(self):
        validate_raw(raw(), 'triage', PLAIN, SOURCE, FIXTURE, expected_chromium_version=VERSION)
        validate_raw(raw('formal', PLAIN, 3), 'formal', PLAIN, SOURCE, FIXTURE,
                     expected_chromium_version=VERSION)
        with self.assertRaisesRegex(WaveFailure, 'LAUNCH_PROTOCOL_INVALID'):
            validate_raw(raw('formal', PLAIN, 2), 'formal', PLAIN, SOURCE, FIXTURE,
                         expected_chromium_version=VERSION)

    def test_hash_mismatch_incompatible_source_or_fixture_rejects_aggregation(self):
        with self.assertRaisesRegex(WaveFailure, 'INCOMPARABLE_MEASUREMENT_BASELINES'):
            validate_raw(raw(), 'triage', PLAIN, 'changed-source', FIXTURE,
                         expected_chromium_version=VERSION)
        with self.assertRaisesRegex(WaveFailure, 'INCOMPARABLE_MEASUREMENT_BASELINES'):
            validate_raw(raw(), 'triage', PLAIN, SOURCE, 'changed-fixture',
                         expected_chromium_version=VERSION)

    def test_failed_functional_or_cleanup_sample_never_becomes_valid_measurement(self):
        value = raw(); value['runs'][0]['functionalStatus'] = 'FAIL'
        with self.assertRaisesRegex(WaveFailure, 'FUNCTIONAL_OR_CLEANUP_FAIL'):
            validate_raw(value, 'triage', PLAIN, SOURCE, FIXTURE, expected_chromium_version=VERSION)
        value = raw(); value['runs'][0]['samples'][3]['cleanupStatus'] = 'FAIL'
        with self.assertRaisesRegex(WaveFailure, 'FAILED_FUNCTIONAL_SAMPLE'):
            validate_raw(value, 'triage', PLAIN, SOURCE, FIXTURE, expected_chromium_version=VERSION)
        value = raw(); del value['runs'][0]['samples'][3]['ownership']['knownTransmuxOutputBytes']
        with self.assertRaisesRegex(WaveFailure, 'FUNCTIONAL_OWNERSHIP_FAIL'):
            validate_raw(value, 'triage', PLAIN, SOURCE, FIXTURE, expected_chromium_version=VERSION)

    def test_empty_samples_and_missing_process_authority_are_invalid_not_inconclusive(self):
        value = raw(); value['runs'][0]['samples'] = []
        with self.assertRaisesRegex(WaveFailure, 'SAMPLE_PROTOCOL_INVALID'):
            validate_raw(value, 'triage', PLAIN, SOURCE, FIXTURE, expected_chromium_version=VERSION)
        value = raw(); value['runs'][0]['samples'][2]['processMemory']['status'] = 'NOT_AVAILABLE'
        with self.assertRaisesRegex(WaveFailure, 'PROCESS_MEMORY_NOT_AVAILABLE'):
            validate_raw(value, 'triage', PLAIN, SOURCE, FIXTURE, expected_chromium_version=VERSION)
        value = raw(); value['runs'][0]['samples'][3]['browserVersion'] = '151.0.7922.35'
        with self.assertRaisesRegex(WaveFailure, 'INCOMPARABLE_MEASUREMENT_BASELINES'):
            validate_raw(value, 'triage', PLAIN, SOURCE, FIXTURE, expected_chromium_version=VERSION)

    def test_chromium_preflight_must_match_before_fixture_or_measurement(self):
        calls = []
        ok = {'status': 'PASS', 'expectedVersion': VERSION, 'observedVersion': VERSION,
              'authority': 'playwright-chromium-executable', 'processInvoked': True,
              'method': 'windows-file-version',
              'executablePath': 'owned-chrome.exe'}
        result = after_chromium_preflight(VERSION, lambda: (calls.append('preflight') or ok),
            lambda: (calls.append('prepare') or ['fixtures']),
            lambda fixtures: (calls.append(('measure', fixtures)) or 'measured'))
        self.assertEqual(result, 'measured')
        self.assertEqual(calls, ['preflight', 'prepare', ('measure', ['fixtures'])])
        calls.clear()
        mismatch = {**ok, 'observedVersion': '151.0.7922.35'}
        with self.assertRaisesRegex(WaveFailure, 'CHROMIUM_BINARY_VERSION_MISMATCH'):
            after_chromium_preflight(VERSION, lambda: mismatch,
                lambda: calls.append('prepare'), lambda _: calls.append('measure'))
        missing = {'status': 'FAIL', 'failureClass': 'AP06_R5_CHROMIUM_VERSION_AUTHORITY_INVALID',
                   'processInvoked': False}
        with self.assertRaisesRegex(WaveFailure, 'CHROMIUM_VERSION_AUTHORITY_INVALID'):
            after_chromium_preflight(VERSION, lambda: missing,
                lambda: calls.append('prepare'), lambda _: calls.append('measure'))
        self.assertEqual(calls, [])
        for method in ('windows-file-version', 'binary--version'):
            validate_chromium_preflight({**ok, 'method': method}, VERSION)
        for method in (None, 'smoke-browser'):
            with self.assertRaisesRegex(WaveFailure, 'PREFLIGHT_OUTPUT_INVALID'):
                validate_chromium_preflight({**ok, 'method': method}, VERSION)
        with self.assertRaisesRegex(WaveFailure, 'CHROMIUM_VERSION_AUTHORITY_INVALID'):
            validate_chromium_preflight({'status': 'PASS'}, None)

    def test_portable_preflight_failure_stops_before_any_fixture_or_browser_without_retry(self):
        for suffix in ('PROCESS_UNAVAILABLE', 'TIMEOUT', 'NONZERO_EXIT', 'INVALID'):
            calls = []
            def failed():
                calls.append('preflight')
                return {'status': 'FAIL', 'failureClass': f'CHROMIUM_VERSION_PREFLIGHT_{suffix}',
                    'expectedVersion': VERSION, 'processInvoked': True}
            with self.assertRaisesRegex(WaveFailure, suffix):
                after_chromium_preflight(VERSION, failed,
                    lambda: calls.append('fixtures'), lambda _: calls.append('browser'))
            self.assertEqual(calls, ['preflight'])

    def test_ambiguous_process_ownership_stays_inconclusive(self):
        self.assertEqual(classify(summary(12, 12)), INCONCLUSIVE)
        self.assertEqual(classify({'phases': []}), INCONCLUSIVE)
        self.assertEqual(classify(summary(5, 10)), DOES_NOT)
        self.assertEqual(classify(summary(10, 5)), REPRODUCES)

    def test_cycle_six_reports_signed_process_deltas_without_clamping(self):
        phases = summary(-3, 20)['phases']
        for kind, value in (('browser', -3), ('renderer', 20)):
            phases[0]['processTypes'][kind]['privateBytes']['signedDelta'] = {
                'min': value, 'median': value, 'max': value}
        record = {'summary': {'phases': phases}}
        self.assertEqual(cycle6_process_deltas(record), {
            'browser': {'min': -3, 'median': -3, 'max': -3},
            'renderer': {'min': 20, 'median': 20, 'max': 20},
        })

    def test_existing_stage_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            claim_stage(root, 'triage', PLAIN)
            with self.assertRaisesRegex(WaveFailure, 'STAGE_ALREADY_RECORDED'):
                claim_stage(root, 'triage', PLAIN)

    def test_production_or_historical_hash_change_blocks_closure(self):
        baseline = {'trees': {'frontend/src': 'prod'}, 'files': {'frontend/nginx.conf': 'nginx'},
            'historicalReadinessRoots': {'readiness-wave4': 'wave4'}, 'wave3Ap06Expected': 'ap06',
            'frontendBuildTree': 'build', 'historicalR5TreeSha256': 'r5', 'historicalR5R1TreeSha256': 'r1'}

        class FakeWave:
            root = Path('.')
            def capture_hashes(self):
                return {'trees': {'frontend/src': 'prod'}, 'files': {'frontend/nginx.conf': 'nginx'}}

        hashes = {'.quality/readiness-wave4': 'wave4', '.quality/readiness-wave3/ap06': 'ap06',
                  'frontend/dist/frontend': 'build', '.quality/readiness-wave5': 'r5',
                  '.quality/readiness-wave5-r1': 'r1'}
        with patch('run_ap06_transmux_probe.owner._tree_sha256', side_effect=lambda _root, path: hashes[path]):
            verify_frozen_authorities(FakeWave(), baseline)
            hashes['.quality/readiness-wave4'] = 'mutated'
            with self.assertRaisesRegex(WaveFailure, 'HISTORICAL_EVIDENCE_MUTATED'):
                verify_frozen_authorities(FakeWave(), baseline)
            hashes['.quality/readiness-wave4'] = 'wave4'
            hashes['.quality/readiness-wave5'] = 'mutated'
            with self.assertRaisesRegex(WaveFailure, 'BLOCKED_AP06_R5_HISTORICAL_ATTEMPT_MUTATED'):
                verify_frozen_authorities(FakeWave(), baseline)
            hashes['.quality/readiness-wave5'] = 'r5'
            hashes['.quality/readiness-wave5-r1'] = 'mutated'
            with self.assertRaisesRegex(WaveFailure, 'HISTORICAL_EVIDENCE_MUTATED'):
                verify_frozen_authorities(FakeWave(), baseline)
            hashes['.quality/readiness-wave5-r1'] = 'r1'
            FakeWave.capture_hashes = lambda self: {'trees': {'frontend/src': 'mutated'}, 'files': {'frontend/nginx.conf': 'nginx'}}
            with self.assertRaisesRegex(WaveFailure, 'PRODUCTION_SOURCE_MUTATED'):
                verify_frozen_authorities(FakeWave(), baseline)

    def test_missing_historical_root_fails_as_integrity_block(self):
        baseline = {'trees': {'frontend/src': 'prod'}, 'files': {'frontend/nginx.conf': 'nginx'},
            'historicalReadinessRoots': {'readiness-wave4': 'wave4'}, 'wave3Ap06Expected': 'ap06',
            'frontendBuildTree': 'build'}

        class FakeWave:
            root = Path('.')
            def capture_hashes(self):
                return {'trees': {'frontend/src': 'prod'}, 'files': {'frontend/nginx.conf': 'nginx'}}

        def missing_root(_root, _path):
            raise EnvironmentFailure('CAMPAIGN_SOURCE_HASH_FAILED')

        with patch.object(runner.owner, '_tree_sha256', side_effect=missing_root):
            with self.assertRaisesRegex(WaveFailure, 'BLOCKED_AP06_HISTORICAL_EVIDENCE_MUTATED'):
                verify_frozen_authorities(FakeWave(), baseline)

    def test_new_continuation_root_requires_historical_root_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / '.quality/readiness-wave5').mkdir(parents=True)
            with self.assertRaisesRegex(WaveFailure, 'HISTORICAL_AUTHORITY_MISSING'):
                continuation_output(root)
            (root / '.quality/readiness-wave5-r1').mkdir()
            self.assertEqual(continuation_output(root), root / '.quality/readiness-wave5-r2')
            (root / '.quality/readiness-wave5-r2').mkdir()
            with self.assertRaisesRegex(WaveFailure, 'BLOCKED_EXISTING_READINESS_WAVE5_R2'):
                continuation_output(root)

    def test_historical_r1_semantics_are_validated_without_rewriting_legacy_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); folder = root / '.quality/readiness-wave5-r1'
            (folder / 'final').mkdir(parents=True); (folder / 'pipeline').mkdir()
            decision = {'status': 'FAIL_AP06_R5_R1_PREFLIGHT',
                'reason': 'CHROMIUM_VERSION_PREFLIGHT_EXECUTION_FAILED', 'ap06': 'OPEN',
                'currentBrowserLaunches': 0, 'currentValidMeasurementLaunches': 0,
                'currentInvalidMeasurementLaunches': 0, 'productionSourceUnchanged': True,
                'productionVideoPatch': 'NONE', 'cleanup': 'PASS'}
            decision_path = folder / 'final/decision.json'
            decision_path.write_text(json.dumps(decision))
            counts_path = folder / 'pipeline/operation-counts.json'
            counts_path.write_text(json.dumps({'fixtureFilesGenerated': 0, 'fixturePreparationProcesses': 0}))
            with patch.object(runner.owner, '_tree_sha256', return_value='r1-hash'):
                self.assertEqual(historical_r5_r1_evidence(root)['treeSha256'], 'r1-hash')
                self.assertEqual(json.loads(decision_path.read_text()), decision)
                for changes in ({'status': 'PASS'}, {'currentBrowserLaunches': 1},
                        {'productionVideoPatch': 'PATCH'}, {'historicalR5Unchanged': False}):
                    decision_path.write_text(json.dumps({**decision, **changes}))
                    with self.assertRaisesRegex(WaveFailure, 'HISTORICAL_INVALID_EVIDENCE_MISMATCH'):
                        historical_r5_r1_evidence(root)
                decision_path.write_text(json.dumps(decision))
                counts_path.write_text(json.dumps({'fixtureFilesGenerated': 1, 'fixturePreparationProcesses': 0}))
                with self.assertRaisesRegex(WaveFailure, 'HISTORICAL_INVALID_EVIDENCE_MISMATCH'):
                    historical_r5_r1_evidence(root)

    def test_historical_r5_identity_rejects_mutated_or_reclassified_attempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); folder = root / '.quality/readiness-wave5'
            (folder / 'final').mkdir(parents=True); (folder / 'triage').mkdir()
            raw_path = folder / 'triage/transmux-mse.raw.json'
            raw_path.write_text(json.dumps({'browserLaunches': 1, 'processSampleCalls': 0,
                'runs': [{'failureClass': 'CHROMIUM_VERSION_MISMATCH', 'samples': []}]}))
            import hashlib
            digest = hashlib.sha256(raw_path.read_bytes()).hexdigest()
            (folder / 'final/decision.json').write_text(json.dumps({
                'status': 'FAIL_AP06_R5_INVALID_MEASUREMENT', 'functionalFailure': 'CHROMIUM_VERSION_MISMATCH',
                'browserLaunches': 1, 'validSamples': 0, 'productionVideoPatch': 'NONE',
                'rawEvidence': 'triage/transmux-mse.raw.json', 'rawSha256': digest}))
            with patch('run_ap06_transmux_probe.owner._tree_sha256', return_value='root-hash'):
                identity = historical_r5_evidence(root)
            self.assertEqual(identity['treeSha256'], 'root-hash')
            (folder / 'final/decision.json').write_text('{}')
            with self.assertRaisesRegex(WaveFailure, 'HISTORICAL_INVALID_EVIDENCE_MISMATCH'):
                historical_r5_evidence(root)

    def test_raw_stage_must_match_its_recorded_sha256(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); stage = root / 'triage'; stage.mkdir()
            raw_path = stage / 'transmux-mse.raw.json'; raw_path.write_text('{"samples":8}')
            from run_ap06_transmux_probe import campaign
            decision_path = stage / 'transmux-mse.decision.json'
            decision_path.write_text(json.dumps({'rawSha256': campaign.sha256_file(raw_path)}))
            verify_stage_raws(root)
            raw_path.write_text('{"samples":0}')
            with self.assertRaisesRegex(WaveFailure, 'RAW_EVIDENCE_INTEGRITY_FAILED'):
                verify_stage_raws(root)


if __name__ == '__main__':
    unittest.main()
