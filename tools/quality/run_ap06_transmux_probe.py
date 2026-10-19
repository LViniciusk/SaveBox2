"""AP-06-R5: stop at the first reproducible transmux ownership boundary."""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

from run_readiness_wave1 import Wave, WaveFailure, campaign, owner
from run_ap06_transport_probe import media_server

HISTORICAL_OUTPUT = '.quality/readiness-wave5'
R1_OUTPUT = '.quality/readiness-wave5-r1'
R2_OUTPUT = '.quality/readiness-wave5-r2'
PLAIN = 'transmux-mse'
CRYPTO = 'crypto-transmux-mse'
REPRODUCES = 'TRANSMUX_MSE_REPRODUCES_BROWSER_PROCESS_OWNERSHIP'
DOES_NOT = 'TRANSMUX_MSE_DOES_NOT_REPRODUCE'
INCONCLUSIVE = 'INCONCLUSIVE_TRANSMUX_MSE_OWNERSHIP'
BROWSER_CEILING = 6
PHASES = [('baseline', 0, 'natural')] + [(f'cycle-{n}-close', n, 'natural') for n in range(1, 7)] + [('forced-GC-final', 6, 'forced-diagnostic')]
R5_TOOLING_PATHS = ('frontend/tools/ap06-transmux-probe.mjs', 'tools/quality/run_ap06_transmux_probe.py',
    'frontend/tools/ap06-mse-probe.mjs', 'frontend/tools/browser-memory-probe.mjs',
    'frontend/tools/mp4-resource-calibration-lib.mjs', 'tools/quality/run_ap06_mse_probe.py',
    'tools/quality/run_ap06_transport_probe.py', 'tools/quality/run_readiness_wave1.py')
TOOLING_PATHS = (*R5_TOOLING_PATHS, 'frontend/tools/ap06-transmux-probe.test.mjs',
    'frontend/tools/ap06-mse-probe.test.mjs',
    'frontend/e2e-video/video-fixtures.ts', 'frontend/package.json', 'frontend/package-lock.json',
    'tools/quality/test_run_ap06_transmux_probe.py')


def next_stage(mode, classification):
    if mode == PLAIN and classification == REPRODUCES:
        return ('formal', mode)
    if mode == PLAIN and classification == DOES_NOT:
        return ('triage', CRYPTO)
    if mode == CRYPTO and classification == 'CRYPTO_TRANSMUX_MSE_REPRODUCES_BROWSER_PROCESS_OWNERSHIP':
        return ('formal', mode)
    return None


def ensure_browser_budget(previous, launches):
    if previous + launches > BROWSER_CEILING:
        raise WaveFailure('AP06_R5_BROWSER_BUDGET_EXCEEDED')


def continuation_output(root):
    historical = root / HISTORICAL_OUTPUT
    continuation = root / R2_OUTPUT
    if continuation.exists():
        raise WaveFailure('BLOCKED_EXISTING_READINESS_WAVE5_R2_ARTIFACT_ROOT')
    if not historical.is_dir() or not (root / R1_OUTPUT).is_dir():
        raise WaveFailure('AP06_R5_HISTORICAL_AUTHORITY_MISSING')
    return continuation


def validate_chromium_preflight(result, expected_version):
    if not isinstance(expected_version, str) or not re.fullmatch(r'\d+\.\d+\.\d+\.\d+', expected_version):
        raise WaveFailure('AP06_R5_CHROMIUM_VERSION_AUTHORITY_INVALID')
    if not isinstance(result, dict):
        raise WaveFailure('CHROMIUM_IDENTITY_PREFLIGHT_OUTPUT_INVALID')
    if result.get('status') != 'PASS':
        raise WaveFailure(result.get('failureClass', 'CHROMIUM_IDENTITY_PREFLIGHT_FAILED'))
    if result.get('expectedVersion') != expected_version:
        raise WaveFailure('AP06_R5_CHROMIUM_VERSION_AUTHORITY_INVALID')
    if result.get('observedVersion') != expected_version:
        raise WaveFailure('CHROMIUM_BINARY_VERSION_MISMATCH')
    if (result.get('authority') != 'playwright-chromium-executable' or not result.get('executablePath') or
            result.get('processInvoked') is not True):
        raise WaveFailure('CHROMIUM_EXECUTABLE_UNAVAILABLE')
    if result.get('method') not in ('windows-file-version', 'binary--version'):
        raise WaveFailure('CHROMIUM_IDENTITY_PREFLIGHT_OUTPUT_INVALID')
    return result


def after_chromium_preflight(expected_version, preflight, prepare, measure):
    result = validate_chromium_preflight(preflight(), expected_version)
    return measure(prepare())


def classify(summary):
    phase = next((row for row in summary.get('phases', [])
                  if row.get('phase') == 'cycle-6-close' and row.get('gc') == 'natural'), None)
    types = phase.get('processTypes', {}) if phase else {}
    values = []
    for process_type in ('browser', 'renderer'):
        metric = types.get(process_type, {}).get('privateBytes', {}).get('signedDelta', {}).get('median')
        if not isinstance(metric, (int, float)):
            return INCONCLUSIVE
        values.append(metric)
    browser, renderer = values
    if browser > renderer and browser > 0:
        return REPRODUCES
    if renderer > browser and renderer > 0:
        return DOES_NOT
    return INCONCLUSIVE


def cycle6_process_deltas(record):
    phases = (record or {}).get('summary', {}).get('phases', [])
    phase = next((row for row in phases if row.get('phase') == 'cycle-6-close' and row.get('gc') == 'natural'), None)
    if phase is None:
        return {'status': 'NOT_AVAILABLE'}
    result = {}
    for kind in ('browser', 'renderer'):
        metric = phase.get('processTypes', {}).get(kind, {}).get('privateBytes', {}).get('signedDelta')
        result[kind] = metric if isinstance(metric, dict) else {'status': 'NOT_AVAILABLE'}
    for name, metric in (
            ('totalPrivateBytes', phase.get('processMemory', {}).get('privateBytes')),
            ('workingSetBytes', phase.get('processMemory', {}).get('workingSetBytes')),
            ('JSHeapUsedSize', phase.get('metrics', {}).get('JSHeapUsedSize'))):
        if isinstance(metric, dict) and isinstance(metric.get('signedDelta'), dict):
            result[name] = metric['signedDelta']
    return result


def validate_raw(raw, stage, mode, source_hash, fixture_hash, harness_hash=None, runner_hash=None,
                 expected_chromium_version=None, transmux_chunks_per_cycle=3, control_lifecycle=True, identity_expectations=None,
                 expected_runs=None):
    expected = expected_runs if expected_runs is not None else 1 if stage == 'triage' else 3
    if (raw.get('mode') != mode or raw.get('stage') != stage or raw.get('browserLaunches') != expected or
            raw.get('launchAttempts') != expected or raw.get('retries') != 0 or len(raw.get('runs', [])) != expected):
        raise WaveFailure('AP06_R5_LAUNCH_PROTOCOL_INVALID')
    if raw.get('processSampleCalls') != expected * len(PHASES):
        raise WaveFailure('INCONCLUSIVE_PROCESS_MEMORY_NOT_AVAILABLE')
    identities = identity_expectations if identity_expectations is not None else dict.fromkeys(
        ('playwrightRoutingInstalled', 'fetchInterceptionInstalled', 'videoStreamServiceUsed', 'angularOrBackendUsed'), False)
    if any(raw.get(key) is not expected_identity for key, expected_identity in identities.items()):
        raise WaveFailure('AP06_R5_CONTROL_IDENTITY_INVALID')
    if raw.get('fixtureManifestSha256') != fixture_hash:
        raise WaveFailure('INCOMPARABLE_MEASUREMENT_BASELINES')
    if (not expected_chromium_version or raw.get('expectedChromiumVersion') != expected_chromium_version or
            any(run.get('browserVersion') != expected_chromium_version for run in raw['runs'])):
        raise WaveFailure('CHROMIUM_RUNTIME_VERSION_IDENTITY_INVALID')
    if runner_hash is not None and raw.get('orchestratorHash') != runner_hash:
        raise WaveFailure('AP06_R5_RUNNER_HASH_MISMATCH')
    if len({run.get('runId') for run in raw['runs']}) != expected:
        raise WaveFailure('AP06_R5_RUN_ID_DUPLICATED')
    for run in raw['runs']:
        if (run.get('functionalStatus') != 'PASS' or run.get('cleanupStatus') != 'PASS' or
                run.get('playbackSessions') != 18 or run.get('extendedForPlateau') is not False):
            raise WaveFailure('AP06_R5_FUNCTIONAL_OR_CLEANUP_FAIL')
        if not run.get('supportedCodecs') or any(row.get('supported') is not True for row in run['supportedCodecs']):
            raise WaveFailure('AP06_R5_CODEC_UNSUPPORTED')
        samples = run.get('samples', [])
        if len(samples) != len(PHASES) or [(row.get('phase'), row.get('cycle'), row.get('gc')) for row in samples] != PHASES:
            raise WaveFailure('AP06_R5_SAMPLE_PROTOCOL_INVALID')
        for sample in samples:
            if sample.get('browserVersion') != expected_chromium_version:
                raise WaveFailure('INCOMPARABLE_MEASUREMENT_BASELINES')
            if sample.get('sourceHash') != source_hash or sample.get('fixtureHash') != fixture_hash:
                raise WaveFailure('INCOMPARABLE_MEASUREMENT_BASELINES')
            if ((harness_hash is not None and sample.get('harnessHash') != harness_hash) or
                    (runner_hash is not None and sample.get('orchestratorHash') != runner_hash)):
                raise WaveFailure('AP06_R5_TOOLING_HASH_MISMATCH')
            if sample.get('functionalStatus') != 'PASS' or sample.get('cleanupStatus') != 'PASS':
                raise WaveFailure('AP06_R5_FAILED_FUNCTIONAL_SAMPLE')
            if sample.get('gc') == 'natural':
                process_memory = sample.get('processMemory', {})
                by_type = process_memory.get('byType', {})
                if process_memory.get('status') != 'AVAILABLE' or any(
                        not isinstance(by_type.get(kind, {}).get('privateBytes'), (int, float))
                        for kind in ('browser', 'renderer')):
                    raise WaveFailure('INCONCLUSIVE_PROCESS_MEMORY_NOT_AVAILABLE')
            required = ['liveKnownArrayBufferBytes', 'knownTransmuxInputBytes', 'knownTransmuxOutputBytes',
                        'pendingTransmuxMessages', 'transmuxWorkersLive', 'workerUrlsLive', 'sourceBuffersLive',
                        'mediaSourcesLive', 'objectUrlsLive', 'pendingAppends', 'pendingFetches']
            if mode == CRYPTO:
                required += ['cryptoWorkersLive', 'cryptoWorkerUrlsLive', 'pendingDecrypts',
                             'messagesPendingCrypto', 'messagesPendingTransmux']
            ownership = sample.get('ownership', {})
            if sample.get('mediaNodes') != 0 or any(name not in ownership or ownership[name] != 0 for name in required) or any(ownership.values()):
                raise WaveFailure('AP06_R5_FUNCTIONAL_OWNERSHIP_FAIL')
            counters = sample.get('counters', {})
            sessions = sample['cycle'] * 3
            for name in ('mediaSourceCreated', 'mediaSourceClosed', 'objectUrlsCreated', 'objectUrlsRevoked',
                         'sourceBuffersCreated', 'sourceBuffersReleased', 'fetchesStarted', 'fetchesCompleted',
                         'transmuxWorkersCreated', 'transmuxWorkersTerminated', 'bootstrapMessagesSent',
                         'bootstrapResponsesReceived', 'transmuxChunksSent', 'transmuxResponsesReceived'):
                expected_counter = sample['cycle'] * transmux_chunks_per_cycle if name in (
                    'transmuxChunksSent', 'transmuxResponsesReceived') else sessions
                if control_lifecycle and counters.get(name) != expected_counter:
                    raise WaveFailure('AP06_R5_LIFECYCLE_COUNTER_INVALID')
        if stage == 'formal' and any(sample.get('functionalStatus') != 'PASS' for sample in samples):
            raise WaveFailure('AP06_R5_FORMAL_FUNCTIONAL_FAIL')
    if not isinstance(raw.get('summary'), dict):
        raise WaveFailure('AP06_R5_SUMMARY_MISSING')


def verify_frozen_authorities(wave, baseline, current=None, historical_r5_verified=False):
    current = current if current is not None else wave.capture_hashes()
    if 'frontend/angular.json' in baseline['files']:
        current['files']['frontend/angular.json'] = campaign.sha256_file(wave.root / 'frontend/angular.json')
    if current['trees'] != baseline['trees'] or any(current['files'].get(path) != digest
                                                     for path, digest in baseline['files'].items()):
        raise WaveFailure('AP06_R5_PRODUCTION_SOURCE_MUTATED')
    if baseline.get('historicalArtifacts') and current.get('historicalArtifacts') != baseline['historicalArtifacts']:
        raise WaveFailure('BLOCKED_AP06_HISTORICAL_EVIDENCE_MUTATED')
    historical = baseline['historicalReadinessRoots']
    for name, digest in historical.items():
        try:
            actual = owner._tree_sha256(wave.root, f'.quality/{name}')
        except owner.EnvironmentFailure:
            raise WaveFailure('BLOCKED_AP06_HISTORICAL_EVIDENCE_MUTATED') from None
        if actual != digest:
            raise WaveFailure('BLOCKED_AP06_HISTORICAL_EVIDENCE_MUTATED')
    expected_ap06 = baseline['wave3Ap06Expected']
    try:
        actual_ap06 = owner._tree_sha256(wave.root, '.quality/readiness-wave3/ap06')
    except owner.EnvironmentFailure:
        raise WaveFailure('BLOCKED_AP06_HISTORICAL_EVIDENCE_MUTATED') from None
    if actual_ap06 != expected_ap06:
        raise WaveFailure('BLOCKED_AP06_HISTORICAL_EVIDENCE_MUTATED')
    expected_build = baseline['frontendBuildTree']
    try:
        actual_build = owner._tree_sha256(wave.root, 'frontend/dist/frontend')
    except owner.EnvironmentFailure:
        raise WaveFailure('AP06_R5_COMPILED_WORKER_BUILD_HASH_MISMATCH') from None
    if actual_build != expected_build:
        raise WaveFailure('AP06_R5_COMPILED_WORKER_BUILD_HASH_MISMATCH')
    expected_r5 = baseline.get('historicalR5TreeSha256')
    if expected_r5 and not historical_r5_verified:
        try:
            actual_r5 = owner._tree_sha256(wave.root, HISTORICAL_OUTPUT)
        except owner.EnvironmentFailure:
            raise WaveFailure('BLOCKED_AP06_R5_HISTORICAL_ATTEMPT_MUTATED') from None
        if actual_r5 != expected_r5:
            raise WaveFailure('BLOCKED_AP06_R5_HISTORICAL_ATTEMPT_MUTATED')
    expected_r1 = baseline.get('historicalR5R1TreeSha256')
    if expected_r1:
        try:
            actual_r1 = owner._tree_sha256(wave.root, R1_OUTPUT)
        except owner.EnvironmentFailure:
            raise WaveFailure('BLOCKED_AP06_HISTORICAL_EVIDENCE_MUTATED') from None
        if actual_r1 != expected_r1:
            raise WaveFailure('BLOCKED_AP06_HISTORICAL_EVIDENCE_MUTATED')
    return current


def current_tooling_hashes(wave):
    recorded = json.loads((wave.output / 'baseline/tooling-hashes.json').read_text())
    current = {path: campaign.sha256_file(wave.root / path) for path in TOOLING_PATHS}
    if current != recorded:
        raise WaveFailure('AP06_R5_TOOLING_SOURCE_MUTATED')
    return recorded


def verify_stage_raws(root):
    for raw_path in root.glob('*/*.raw.json'):
        mode = raw_path.name.removesuffix('.raw.json')
        decision_path = raw_path.parent / f'{mode}.decision.json'
        if (not decision_path.is_file() or
                json.loads(decision_path.read_text()).get('rawSha256') != campaign.sha256_file(raw_path)):
            raise WaveFailure('AP06_R5_R1_RAW_EVIDENCE_INTEGRITY_FAILED')


def claim_stage(root, stage, mode):
    directory = root / stage
    directory.mkdir(parents=True, exist_ok=True)
    claim = directory / f'{mode}.claimed'
    try:
        claim.touch(exist_ok=False)
    except FileExistsError:
        raise WaveFailure('AP06_R5_STAGE_ALREADY_RECORDED') from None
    if (directory / f'{mode}.raw.json').exists():
        raise WaveFailure('AP06_R5_RAW_STAGE_ALREADY_EXISTS')
    return directory


def fixture_worker_authority(wave, baseline, versions):
    candidates = []
    for path in (wave.root / 'frontend/dist/frontend/browser').glob('worker-*.js'):
        content = path.read_text(encoding='utf-8')
        if 'BOOTSTRAP_COMPLETE' in content and 'TRANSMUX_CHUNK' in content:
            candidates.append(path)
    if len(candidates) != 1:
        raise WaveFailure('AP06_R5_REAL_TRANSMUX_WORKER_NOT_UNIQUE')
    worker = candidates[0]
    worker_hash = campaign.sha256_file(worker)
    r4_authority = json.loads((wave.root / '.quality/readiness-wave4/baseline/fixtures/crypto/worker-authority.json').read_text())
    crypto_path = wave.root / r4_authority['path']
    if (campaign.sha256_file(crypto_path) != r4_authority['sha256'] or
            r4_authority['sourceHash'] != baseline['groups']['frontend-player-production']):
        raise WaveFailure('AP06_R5_CRYPTO_WORKER_AUTHORITY_MISMATCH')
    return {
        'transmuxWorker': {'path': worker.relative_to(wave.root).as_posix(), 'sha256': worker_hash,
                           'frontendBuildSha256': baseline['frontendBuildTree'], 'builds': 0, 'authority': 'reused current Angular worker bundle'},
        'cryptoWorker': {'path': r4_authority['path'], 'sha256': r4_authority['sha256'],
                         'builds': 0, 'authority': 'exact R4 compiled production worker'},
        'chromiumVersion': versions['chromium']['version'],
    }


def prepare_plain(wave, temp, manifest_path, ffmpeg):
    generated_manifest = temp / 'fixture-manifest.json' if manifest_path.exists() else manifest_path
    environment = wave.env.copy()
    environment.update(AP06_R5_FIXTURE_DIR=str(temp / 'plain'), AP06_R5_FIXTURE_MANIFEST=str(generated_manifest),
                       AP06_R5_FFMPEG_VERSION=wave.versions.get('ffmpeg', 'NOT_AVAILABLE'),
                       NANIKA_FFMPEG_PATH=ffmpeg)
    wave.counts['fixturePreparationProcesses'] += 1
    wave.command('r5-fixture-generation', [wave.node, 'tools/ap06-transmux-probe.mjs', '--prepare'], wave.root / 'frontend', environment)
    fixtures = json.loads(generated_manifest.read_text())
    if generated_manifest != manifest_path:
        if json.loads(manifest_path.read_text()) != fixtures:
            raise WaveFailure('AP06_R5_FIXTURE_REGENERATION_MISMATCH')
    if len(fixtures) != 3 or any(item.get('chunkCount') != 2 or item.get('bytes', 0) <= 4 * 1024 * 1024
                                for item in fixtures):
        raise WaveFailure('AP06_R5_FIXTURE_CHUNK_AUTHORITY_INVALID')
    for item in fixtures:
        path = temp / 'plain' / item['path']
        if campaign.sha256_file(path) != item['sha256'] or path.stat().st_size != item['bytes']:
            raise WaveFailure('AP06_R5_FIXTURE_HASH_MISMATCH')
    return fixtures


def prepare_crypto(wave, temp, fixtures):
    r4 = wave.root / '.quality/readiness-wave4/baseline/fixtures/crypto/worker-authority.json'
    authority = json.loads(r4.read_text())
    folder = temp / 'ciphertext'; folder.mkdir()
    metadata_path = temp / 'crypto-chunks.json'
    tooling = current_tooling_hashes(wave)
    env = wave.env.copy()
    env.update(AP06_PREPARE_CRYPTO='1', AP06_KASUMI_BUNDLE=str(temp / 'kasumi-fixture.cjs'),
               AP06_CRYPTO_PREP_METADATA=str(metadata_path), AP06_FIXTURES=json.dumps([
                   {**fixture, 'absolutePath': str(temp / 'plain' / fixture['path']),
                   'ciphertextAbsolutePath': str(folder / f"video-{fixture['id']}.bin")}
                   for fixture in fixtures]))
    wave.counts['cryptoFixturePreparationProcesses'] += 1
    wave.counts['auxiliaryProbeBuilds'] += 1
    wave.command('r5-crypto-fixture-generation', [wave.node, 'tools/ap06-mse-probe.mjs'], wave.root / 'frontend', env)
    chunks = json.loads(metadata_path.read_text())
    result = []
    for fixture, chunk in zip(fixtures, chunks, strict=True):
        ciphertext = folder / f"video-{fixture['id']}.bin"
        if chunk['id'] != fixture['id'] or chunk['chunkBytes'] != fixture['chunkBytes'] or chunk['chunkCount'] != fixture['chunkCount']:
            raise WaveFailure('AP06_R5_CRYPTO_CHUNKING_MISMATCH')
        row = {**fixture, 'ciphertextBytes': ciphertext.stat().st_size,
               'ciphertextSha256': campaign.sha256_file(ciphertext)}
        if row['ciphertextBytes'] != row['bytes'] + row['chunkCount'] * 16:
            raise WaveFailure('AP06_R5_CIPHERTEXT_SIZE_INVALID')
        result.append(row)
    wave.save('baseline/crypto-fixture-manifest.json', result)
    wave.counts['cryptoFixtureFilesGenerated'] += len(result)
    if campaign.sha256_file(wave.root / authority['path']) != authority['sha256']:
        raise WaveFailure('AP06_R5_CRYPTO_WORKER_AUTHORITY_MISMATCH')
    return result, folder


def historical_r5_evidence(root):
    directory = root / HISTORICAL_OUTPUT
    decision = json.loads((directory / 'final/decision.json').read_text())
    relative_raw = decision.get('rawEvidence')
    raw_path = directory / relative_raw if relative_raw == 'triage/transmux-mse.raw.json' else None
    if (decision.get('status') != 'FAIL_AP06_R5_INVALID_MEASUREMENT' or
            decision.get('functionalFailure') != 'CHROMIUM_VERSION_MISMATCH' or
            decision.get('browserLaunches') != 1 or decision.get('validSamples') != 0 or
            decision.get('productionVideoPatch') != 'NONE' or raw_path is None or not raw_path.is_file()):
        raise WaveFailure('AP06_R5_HISTORICAL_INVALID_EVIDENCE_MISMATCH')
    raw_hash = campaign.sha256_file(raw_path)
    raw = json.loads(raw_path.read_text())
    if (raw_hash != decision.get('rawSha256') or raw.get('browserLaunches') != 1 or
            raw.get('processSampleCalls') != 0 or len(raw.get('runs', [])) != 1 or
            raw['runs'][0].get('failureClass') != 'CHROMIUM_VERSION_MISMATCH' or
            raw['runs'][0].get('samples') != []):
        raise WaveFailure('AP06_R5_HISTORICAL_INVALID_EVIDENCE_MISMATCH')
    return {'status': decision['status'], 'functionalFailure': decision['functionalFailure'],
            'treeSha256': owner._tree_sha256(root, HISTORICAL_OUTPUT), 'rawSha256': raw_hash,
            'browserLaunches': 1, 'validSamples': 0, 'processSampleCalls': 0,
            'productionVideoPatch': 'NONE'}


def current_matches_historical(current, historical):
    return (current['trees'] == historical['trees'] and
            all(current['files'].get(path) == digest for path, digest in historical['files'].items()) and
            current.get('historicalArtifacts') == historical.get('historicalArtifacts'))


def historical_r5_r1_evidence(root):
    directory = root / R1_OUTPUT
    try:
        decision = json.loads((directory / 'final/decision.json').read_text())
        counts = json.loads((directory / 'pipeline/operation-counts.json').read_text())
    except (OSError, ValueError):
        raise WaveFailure('AP06_R5_R1_HISTORICAL_INVALID_EVIDENCE_MISMATCH') from None
    expected = {'status': 'FAIL_AP06_R5_R1_PREFLIGHT',
        'reason': 'CHROMIUM_VERSION_PREFLIGHT_EXECUTION_FAILED', 'ap06': 'OPEN',
        'currentBrowserLaunches': 0, 'currentValidMeasurementLaunches': 0,
        'currentInvalidMeasurementLaunches': 0, 'productionSourceUnchanged': True,
        'productionVideoPatch': 'NONE', 'cleanup': 'PASS'}
    if (any(decision.get(key) != value for key, value in expected.items()) or
            ('historicalR5Unchanged' in decision and decision['historicalR5Unchanged'] is not True) or
            counts.get('fixtureFilesGenerated') != 0 or counts.get('fixturePreparationProcesses') != 0):
        raise WaveFailure('AP06_R5_R1_HISTORICAL_INVALID_EVIDENCE_MISMATCH')
    return {'status': expected['status'], 'reason': expected['reason'],
        'treeSha256': owner._tree_sha256(root, R1_OUTPUT), 'measurementBrowsers': 0,
        'validSamples': 0, 'fixtures': 0, 'productionVideoPatch': 'NONE'}


def parse_command_json(output):
    try:
        return json.loads(next(line for line in reversed(output.splitlines()) if line.strip()))
    except (StopIteration, ValueError):
        raise WaveFailure('CHROMIUM_IDENTITY_PREFLIGHT_OUTPUT_INVALID') from None


def run_stage(wave, root, stage, mode, fixtures, file_folder, manifest_path, source_hash, worker_authority):
    tooling = current_tooling_hashes(wave)
    harness_hash = tooling['frontend/tools/ap06-transmux-probe.mjs']
    runner_hash = tooling['tools/quality/run_ap06_transmux_probe.py']
    directory = claim_stage(root, stage, mode)
    expected_launches = 1 if stage == 'triage' else 3
    previous_launches = sum(json.loads(path.read_text()).get('browserLaunches', 0)
                            for path in root.glob('*/*.raw.json'))
    ensure_browser_budget(previous_launches, expected_launches)
    if stage == 'formal':
        prior = json.loads((root / 'triage' / f'{mode}.decision.json').read_text())
        if prior.get('classification') != (REPRODUCES if mode == PLAIN else 'CRYPTO_TRANSMUX_MSE_REPRODUCES_BROWSER_PROCESS_OWNERSHIP'):
            raise WaveFailure('AP06_R5_FORMAL_CONDITION_NOT_SELECTED')
    if mode == PLAIN and any(campaign.sha256_file(file_folder / fixture['path']) != fixture['sha256'] for fixture in fixtures):
        raise WaveFailure('AP06_R5_FIXTURE_HASH_MISMATCH')
    if mode == CRYPTO and any(campaign.sha256_file(file_folder / f"video-{item['id']}.bin") != item['ciphertextSha256']
                              for item in fixtures):
        raise WaveFailure('AP06_R5_CIPHERTEXT_HASH_MISMATCH')
    env = wave.env.copy()
    env.update(AP06_R5_MODE=mode, AP06_R5_STAGE=stage, AP06_R5_ARTIFACT_DIR=str(directory),
               AP06_R5_MEDIA_ORIGIN=wave.env['AP06_R5_MEDIA_ORIGIN'], AP06_R5_FIXTURE_MANIFEST=str(manifest_path),
               AP06_R5_TRANSMUX_WORKER=str(wave.root / worker_authority['transmuxWorker']['path']),
               AP06_R5_TRANSMUX_WORKER_SHA256=worker_authority['transmuxWorker']['sha256'],
               AP06_R5_CHROMIUM_VERSION=worker_authority['chromiumVersion'],
               AP06_R5_SOURCE_HASH=source_hash,
               AP06_R5_HARNESS_HASH=harness_hash, AP06_R5_RUNNER_SHA256=runner_hash,
               WAVE1_PYTHON=sys.executable, WAVE1_RUNNER=str(wave.root / 'tools/quality/run_readiness_wave1.py'))
    if mode == CRYPTO:
        env.update(AP06_R5_CRYPTO_WORKER=str(wave.root / worker_authority['cryptoWorker']['path']),
                   AP06_R5_CRYPTO_WORKER_SHA256=worker_authority['cryptoWorker']['sha256'])
    error = None
    try:
        with wave.phase(f'AP06 R5 {stage} {mode}'):
            wave.command(f'r5-{stage}-{mode}', [wave.node, 'tools/ap06-transmux-probe.mjs'], wave.root / 'frontend', env)
    except WaveFailure as caught:
        error = caught
    raw_path = directory / f'{mode}.raw.json'
    if not raw_path.is_file():
        raise error or WaveFailure('AP06_R5_RAW_EVIDENCE_MISSING')
    raw = json.loads(raw_path.read_text())
    launches = raw.get('browserLaunches', 0)
    wave.counts['currentBrowserLaunches'] += launches
    wave.counts['processSampleCalls'] += raw.get('processSampleCalls', 0)
    wave.counts['formalLaunches' if stage == 'formal' else 'triageLaunches'] += launches
    fixture_hash = campaign.sha256_file(manifest_path)
    if error:
        wave.counts['currentInvalidMeasurementLaunches'] += launches
        wave.save(f'{stage}/{mode}.decision.json', {'status': 'FUNCTIONAL_FAIL', 'reason': str(error),
                   'rawSha256': campaign.sha256_file(raw_path), 'browserLaunches': raw.get('browserLaunches', 0)})
        raise error
    try:
        validate_raw(raw, stage, mode, source_hash, fixture_hash, harness_hash, runner_hash,
                     worker_authority['chromiumVersion'])
    except WaveFailure as error:
        wave.counts['currentInvalidMeasurementLaunches'] += launches
        wave.save(f'{stage}/{mode}.decision.json', {'status': 'INVALID_MEASUREMENT', 'reason': str(error),
                   'rawSha256': campaign.sha256_file(raw_path), 'browserLaunches': launches})
        raise
    wave.counts['currentValidMeasurementLaunches'] += launches
    classification = classify(raw['summary'])
    if mode == CRYPTO and classification != INCONCLUSIVE:
        classification = 'CRYPTO_' + classification
    result = {'status': 'CHARACTERIZED', 'mode': mode, 'stage': stage, 'classification': classification,
              'browserLaunches': raw['browserLaunches'], 'processSampleCalls': raw['processSampleCalls'],
              'rawSha256': campaign.sha256_file(raw_path), 'fixtureManifestSha256': fixture_hash,
              'summary': raw['summary']}
    wave.save(f'{stage}/{mode}.decision.json', result)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--continuation-r2', action='store_true')
    args = parser.parse_args(argv)
    if not args.continuation_r2:
        print(json.dumps({'status': 'USE_AP06_R5_R2_CONTINUATION_FLAG'}), flush=True)
        return 2

    root = Path(__file__).resolve().parents[2]
    try:
        output = continuation_output(root)
    except WaveFailure as error:
        print(json.dumps({'status': str(error)}), flush=True)
        return 2

    wave = Wave(root)
    wave.output = output
    output.mkdir(parents=True, exist_ok=False)
    wave.counts.update({
        'baselineInventories': 0, 'integrityInventories': 0,
        'historicalR5InvalidBrowserLaunches': 1, 'historicalR5R1MeasurementBrowserLaunches': 0,
        'currentBrowserLaunches': 0,
        'currentValidMeasurementLaunches': 0, 'currentInvalidMeasurementLaunches': 0,
        'chromiumIdentityPreflightProcesses': 0, 'fixturePreparationProcesses': 0,
        'fixtureFilesGenerated': 0, 'cryptoFixturePreparationProcesses': 0,
        'cryptoFixtureFilesGenerated': 0, 'workerBundleBuilds': 0, 'workerBundleReuses': 0,
        'cryptoWorkerBundleReuses': 0, 'httpServerGenerations': 0, 'httpServerStarts': 0,
        'nodeUnitCommands': 0, 'pythonUnitCommands': 0,
        'discardedFixturePreparations': 0,
        'focusedAngularCommands': 0,
        'focusedAngularBrowserLaunches': 0, 'triageLaunches': 0, 'formalLaunches': 0,
        'processSampleCalls': 0, 'automaticRetries': 0, 'ffmpegFixtureProcesses': 0,
        'ffmpegVersionCommands': 0,
    })
    sys.addaudithook(lambda event, _: wave.counts.__setitem__('processInvocations', wave.counts['processInvocations'] + 1)
                     if event == 'subprocess.Popen' else None)

    result = {'status': 'BLOCKED_AP06_R5_R2_BASELINE', 'ap06': 'OPEN', 'productionVideoPatch': 'NONE'}
    baseline = worker_authority = None
    temporary_path = None
    phase = 'baseline'
    preflight_attempted = preflight_passed = False
    angular = {'status': 'NOT_RUN', 'reason': 'PRODUCTION_SOURCE_UNCHANGED_AND_WORKER_BUNDLE_REUSED_BY_HASH'}
    historical = {}
    historical_r1 = {}
    preflight_result = {}

    try:
        with tempfile.TemporaryDirectory(prefix='nanika-ap06-r5-r2-') as temporary:
            temporary_path = Path(temporary)
            wave.temp = temporary_path
            with wave.phase('R5-R2 baseline and immutable authorities'):
                historical_source = json.loads((root / HISTORICAL_OUTPUT / 'baseline/source-hashes.json').read_text())
                historical = historical_r5_evidence(root)
                historical_r1 = historical_r5_r1_evidence(root)
                wave.counts['baselineInventories'] += 1
                current = wave.capture_hashes()
                current['files']['frontend/angular.json'] = campaign.sha256_file(root / 'frontend/angular.json')
                if not current_matches_historical(current, historical_source):
                    raise WaveFailure('BLOCKED_AP06_R5_R2_PRODUCTION_INTEGRITY')
                head = wave.git('rev-parse', 'HEAD')
                branch = wave.git('branch', '--show-current')
                dirty_files = wave.git('status', '--porcelain').splitlines()
                baseline = {
                    **current, 'gitHead': head, 'branch': branch, 'dirtyFiles': dirty_files,
                    'npmLockSha256': campaign.sha256_file(root / 'frontend/package-lock.json'),
                    'historicalReadinessRoots': historical_source['historicalReadinessRoots'],
                    'wave3Ap06Expected': historical_source.get('wave3Ap06Expected',
                        historical_source.get('wave3Ap06AuthorityExpected')),
                    'frontendBuildTree': historical_source['frontendBuildTree'],
                    'historicalR5TreeSha256': historical['treeSha256'],
                    'historicalR5R1TreeSha256': historical_r1['treeSha256'],
                }
                wave.baseline_hashes = baseline
                verify_frozen_authorities(wave, baseline, current, historical_r5_verified=True)
                wave.versions = json.loads((root / HISTORICAL_OUTPUT / 'baseline/tool-versions.json').read_text())
                expected_version = wave.versions.get('chromium', {}).get('version')
                if not isinstance(expected_version, str) or not re.fullmatch(r'\d+\.\d+\.\d+\.\d+', expected_version):
                    raise WaveFailure('AP06_R5_CHROMIUM_VERSION_AUTHORITY_INVALID')
                baseline['expectedChromiumVersion'] = expected_version
                worker_authority = fixture_worker_authority(wave, baseline, wave.versions)
                wave.counts['workerBundleReuses'] = 1
                wave.save('baseline/source-hashes.json', baseline)
                old_environment = json.loads((root / HISTORICAL_OUTPUT / 'baseline/environment.json').read_text())
                wave.save('baseline/environment.json', {
                    **old_environment, 'gitHead': head, 'branch': branch, 'dirty': bool(dirty_files),
                    'dirtyFiles': dirty_files, 'productionUnchangedFromHistoricalR5': True,
                    'secretsRecorded': False})
                wave.save('baseline/tool-versions.json', wave.versions)
                wave.save('baseline/historical-r5-invalid.json', historical)
                wave.save('baseline/historical-r5-r1-invalid.json', historical_r1)
                wave.save('baseline/worker-authority.json', worker_authority)

            wave.save('baseline/tooling-hashes.json', {
                path: campaign.sha256_file(root / path) for path in TOOLING_PATHS})

            phase = 'tooling-tests'
            with wave.phase('R5-R2 dependency reuse validation'):
                wave.dependencies()
            with wave.phase('R5-R2 tooling unit tests'):
                wave.counts['nodeUnitCommands'] += 1
                node_output = wave.command('ap06-transmux-node-tests', [wave.node, '--test', '--test-reporter=tap',
                    'tools/ap06-transmux-probe.test.mjs', 'tools/ap06-mse-probe.test.mjs'], root / 'frontend')
                wave.counts['pythonUnitCommands'] += 1
                python_output = wave.command('ap06-transmux-python-tests', [sys.executable, '-m',
                    'unittest', '-v', 'test_run_ap06_transmux_probe'], root / 'tools/quality')
                node_counts = {key: int(value) for key, value in
                    re.findall(r'^# (tests|pass|fail) (\d+)$', node_output, re.M)}
                python_match = re.search(r'Ran (\d+) tests?', python_output)
                wave.save('tooling/unit-results.json', {
                    'node': {'status': 'PASS', **node_counts},
                    'python': {'status': 'PASS', 'tests': int(python_match.group(1)) if python_match else None}})
            current_tooling_hashes(wave)

            def preflight():
                nonlocal preflight_attempted
                preflight_attempted = True
                environment = wave.env.copy()
                environment['AP06_R5_CHROMIUM_VERSION'] = expected_version
                with wave.phase('zero-browser Chromium identity preflight'):
                    output_text = wave.command('chromium-identity-preflight',
                        [wave.node, 'tools/ap06-transmux-probe.mjs', '--preflight'], root / 'frontend', environment)
                preflight_result.update(parse_command_json(output_text))
                wave.counts['chromiumIdentityPreflightProcesses'] += int(
                    preflight_result.get('processInvoked') is True)
                wave.versions['node'] = preflight_result.get('nodeVersion', 'NOT_AVAILABLE')
                safe = {key: preflight_result.get(key) for key in (
                    'status', 'expectedVersion', 'observedVersion', 'authority',
                    'method', 'failureClass', 'processInvoked', 'nodeVersion')}
                wave.save('baseline/chromium-preflight.json', safe)
                return preflight_result

            def prepare():
                nonlocal phase, preflight_passed
                preflight_passed = True
                current_tooling_hashes(wave)
                wave.save('tooling/freeze.json', {'status': 'FROZEN',
                    'basis': 'Node and Python unit tests and portable Chromium preflight PASS',
                    'toolingHashesSha256': campaign.sha256_file(output / 'baseline/tooling-hashes.json')})
                if wave.versions['node'] != json.loads(
                        (root / HISTORICAL_OUTPUT / 'baseline/tool-versions.json').read_text()).get('node'):
                    raise WaveFailure('AP06_R5_NODE_VERSION_MISMATCH')
                wave.save('baseline/tool-versions.json', wave.versions)
                ffmpeg = shutil.which('ffmpeg', path=wave.env['PATH'])
                if not ffmpeg:
                    phase = 'fixture-preparation'
                    raise WaveFailure('M05_REQUIRED_FIXTURE_GENERATOR_UNAVAILABLE')
                phase = 'fixture-preparation'
                with wave.phase('R5-R2 FFmpeg identity and fixture preparation'):
                    wave.counts['ffmpegVersionCommands'] += 1
                    ffmpeg_output = wave.command('ffmpeg-version', [ffmpeg, '-version'], root)
                    lines = ffmpeg_output.splitlines()
                    actual_ffmpeg = lines[0] if lines else 'NOT_AVAILABLE'
                    expected_ffmpeg = json.loads(
                        (root / HISTORICAL_OUTPUT / 'baseline/tool-versions.json').read_text()).get('ffmpeg')
                    if actual_ffmpeg != expected_ffmpeg:
                        raise WaveFailure('AP06_R5_FFMPEG_VERSION_MISMATCH')
                    wave.versions['ffmpeg'] = actual_ffmpeg
                    wave.save('baseline/tool-versions.json', wave.versions)
                    fixture_path = output / 'baseline/fixture-manifest.json'
                    fixtures = prepare_plain(wave, temporary_path, fixture_path, ffmpeg)
                    wave.counts['fixtureFilesGenerated'] = len(fixtures)
                    wave.counts['ffmpegFixtureProcesses'] = len(fixtures)
                    wave.save('baseline/fixture-manifest.json', fixtures)
                return fixtures

            def measure(fixtures):
                nonlocal phase
                phase = 'measurement'
                fixture_path = output / 'baseline/fixture-manifest.json'
                source_hash = baseline['groups']['frontend-player-production']
                plain = run_condition(wave, temporary_path, fixtures, fixture_path, PLAIN,
                                      'triage', source_hash, worker_authority)
                selected = next_stage(PLAIN, plain['classification'])
                crypto_status = 'NOT_REQUIRED_BY_CAUSAL_DECISION_TREE'
                final_condition = plain
                crypto_triage = None

                def formal(mode, chosen_fixtures, folder, manifest):
                    mapping = {
                        f"/video-{item['id']}.mp4": folder / (
                            item['path'] if mode == PLAIN else f"video-{item['id']}.bin")
                        for item in chosen_fixtures}
                    wave.counts['httpServerGenerations'] += 1
                    wave.counts['httpServerStarts'] += 1
                    with media_server(mapping) as (origin, stats):
                        wave.env['AP06_R5_MEDIA_ORIGIN'] = origin
                        chosen = run_stage(wave, output, 'formal', mode, chosen_fixtures, folder,
                                           manifest, source_hash, worker_authority)
                        wave.save(f'formal/{mode}-media-transport.json', stats)
                        return chosen

                if selected == ('formal', PLAIN):
                    final_condition = formal(PLAIN, fixtures, temporary_path / 'plain', fixture_path)
                    confirmed = final_condition['classification'] == REPRODUCES
                    status = ('PASS_AP06_R5_R2_TRANSMUX_BOUNDARY_REPRODUCED' if confirmed
                              else 'PASS_AP06_R5_R2_INCONCLUSIVE')
                    next_boundary = ('MP4BOX_SEGMENTATION_WORKER_ATTRIBUTION' if confirmed
                                     else 'TRANSMUX_FORMAL_DID_NOT_CONFIRM_TRIAGE')
                elif selected == ('triage', CRYPTO):
                    with wave.phase('R5-R2 crypto fixture preparation'):
                        crypto_fixtures, crypto_folder = prepare_crypto(wave, temporary_path, fixtures)
                    wave.counts['cryptoWorkerBundleReuses'] = 1
                    crypto_manifest = output / 'baseline/crypto-fixture-manifest.json'
                    crypto = run_condition(wave, temporary_path, crypto_fixtures, crypto_manifest,
                                           CRYPTO, 'triage', source_hash, worker_authority)
                    crypto_triage = crypto
                    crypto_status = crypto['classification']
                    final_condition = crypto
                    selected_crypto = next_stage(CRYPTO, crypto_status)
                    if selected_crypto == ('formal', CRYPTO):
                        final_condition = formal(CRYPTO, crypto_fixtures, crypto_folder, crypto_manifest)
                        confirmed = final_condition['classification'] == (
                            'CRYPTO_TRANSMUX_MSE_REPRODUCES_BROWSER_PROCESS_OWNERSHIP')
                        status = ('PASS_AP06_R5_R2_CRYPTO_TRANSMUX_BOUNDARY_REPRODUCED' if confirmed
                                  else 'PASS_AP06_R5_R2_INCONCLUSIVE')
                        next_boundary = ('CRYPTO_TRANSMUX_COMPOSITION_ATTRIBUTION' if confirmed
                                         else 'CRYPTO_TRANSMUX_FORMAL_DID_NOT_CONFIRM_TRIAGE')
                    elif crypto_status == 'CRYPTO_TRANSMUX_MSE_DOES_NOT_REPRODUCE':
                        status, next_boundary = 'PASS_AP06_R5_R2_EVIDENCE_COMPLETE', 'VIDEO_STREAM_SERVICE_ORCHESTRATION'
                    else:
                        status, next_boundary = 'PASS_AP06_R5_R2_INCONCLUSIVE', 'CRYPTO_TRANSMUX_PROCESS_ATTRIBUTION'
                else:
                    status, next_boundary = 'PASS_AP06_R5_R2_INCONCLUSIVE', 'TRANSMUX_PROCESS_ATTRIBUTION'

                return {
                    'status': status, 'ap06': 'OPEN', 'transmuxMse': plain['classification'],
                    'plainTriage': plain,
                    'formal': final_condition if final_condition.get('stage') == 'formal' else 'NOT_RUN',
                    'cryptoTriage': crypto_triage if crypto_triage else 'NOT_RUN',
                    'cryptoTransmuxMse': crypto_status, 'nextBoundary': next_boundary,
                    'productionVideoPatch': 'NONE',
                }

            phase = 'preflight'
            measured = after_chromium_preflight(expected_version, preflight, prepare, measure)
            result = measured
    except WaveFailure as error:
        reason = str(error)
        if phase == 'baseline':
            status = 'BLOCKED_AP06_R5_R2_INTEGRITY' if reason.startswith('BLOCKED_') or 'INTEGRITY' in reason else 'FAIL_AP06_R5_R2_BASELINE'
        elif phase == 'preflight' and preflight_attempted and not preflight_passed:
            status = 'FAIL_AP06_R5_R2_PREFLIGHT'
        elif phase == 'tooling-tests':
            status = 'FAIL_AP06_R5_R2_TOOLING'
        elif phase == 'fixture-preparation':
            status = 'FAIL_AP06_R5_R2_FIXTURE_PREPARATION'
        elif phase == 'measurement' and wave.counts['currentInvalidMeasurementLaunches']:
            status = 'FAIL_AP06_R5_R2_INVALID_MEASUREMENT'
        elif reason.startswith('BLOCKED_') or 'INTEGRITY' in reason or 'MUTATED' in reason:
            status = 'BLOCKED_AP06_R5_R2_INTEGRITY'
        else:
            status = 'FAIL_AP06_R5_R2_PREFLIGHT' if not preflight_passed else 'FAIL_AP06_R5_R2_EXECUTION'
        result = {'status': status, 'reason': reason, 'ap06': 'OPEN', 'productionVideoPatch': 'NONE'}
    except Exception as error:
        result = {'status': 'FAIL_AP06_R5_R2_EXECUTION', 'reason': type(error).__name__,
                  'ap06': 'OPEN', 'productionVideoPatch': 'NONE'}
        if str(error) == 'MEDIA_SERVER_CLEANUP_FAILED':
            result.update(status='BLOCKED_AP06_R5_R2_CLEANUP_FAILURE', cleanupFailure=True)
    finally:
        final_hashes = None
        if baseline is not None:
            try:
                wave.counts['integrityInventories'] += 1
                final_hashes = verify_frozen_authorities(wave, baseline)
                result['productionSourceUnchanged'] = True
                result['historicalR5Unchanged'] = True
                result['historicalR5R1Unchanged'] = True
            except WaveFailure as error:
                result['productionSourceUnchanged'] = False
                result['integrityFailure'] = str(error)
                result['status'] = 'BLOCKED_AP06_R5_R2_INTEGRITY'
            if final_hashes is not None:
                try:
                    current_tooling_hashes(wave)
                    verify_stage_raws(output)
                except WaveFailure as error:
                    result['artifactIntegrityFailure'] = str(error)
                    result['status'] = 'BLOCKED_AP06_R5_R2_INTEGRITY'
        cleanup = 'PASS' if (temporary_path is None or not temporary_path.exists()) and not result.get('cleanupFailure') else 'FAIL'
        result['cleanup'] = cleanup
        if cleanup != 'PASS':
            result['status'] = 'BLOCKED_AP06_R5_R2_CLEANUP_FAILURE'
        result.update({
            'historicalR5InvalidBrowserLaunches': 1,
            'historicalR5R1MeasurementBrowserLaunches': 0,
            'currentBrowserLaunches': wave.counts['currentBrowserLaunches'],
            'currentValidMeasurementLaunches': wave.counts['currentValidMeasurementLaunches'],
            'currentInvalidMeasurementLaunches': wave.counts['currentInvalidMeasurementLaunches'],
            'chromiumIdentityPreflightProcesses': wave.counts['chromiumIdentityPreflightProcesses'],
            'processSampleCalls': wave.counts['processSampleCalls'],
            'focusedAngular': angular.get('status', 'NOT_RUN'),
            'productionVideoPatch': 'NONE',
            'productionSourceChanged': not result.get('productionSourceUnchanged', False),
        })
        result['expectedChromiumVersion'] = (baseline or {}).get('expectedChromiumVersion',
            getattr(wave, 'versions', {}).get('chromium', {}).get('version'))
        result['preflight'] = {key: preflight_result.get(key) for key in
            ('status', 'expectedVersion', 'observedVersion', 'authority', 'method', 'failureClass', 'processInvoked')}
        result['historicalLineage'] = {'r5': historical, 'r5r1': historical_r1}
        result['frontendPlayerSourceHash'] = (baseline or {}).get('groups', {}).get('frontend-player-production')
        if worker_authority:
            result['workerBundleSha256'] = worker_authority['transmuxWorker']['sha256']
        formal_record = result.get('formal') if isinstance(result.get('formal'), dict) else {}
        plain_record = formal_record if formal_record.get('mode') == PLAIN else result.get('plainTriage')
        crypto_record = formal_record if formal_record.get('mode') == CRYPTO else result.get('cryptoTriage')
        result['cycle6ProcessOwnership'] = {
            'transmuxMse': cycle6_process_deltas(plain_record),
            'cryptoTransmuxMse': cycle6_process_deltas(crypto_record) if isinstance(crypto_record, dict)
                else 'NOT_REQUIRED_BY_CAUSAL_DECISION_TREE' if crypto_record == 'NOT_RUN' else 'NOT_AVAILABLE',
        }
        fixture_manifest_path = output / 'baseline/fixture-manifest.json'
        if fixture_manifest_path.is_file():
            fixture_manifest = json.loads(fixture_manifest_path.read_text())
            result['fixtureManifestSha256'] = campaign.sha256_file(fixture_manifest_path)
            result['fixtureHashes'] = [{'id': row['id'], 'sha256': row['sha256']} for row in fixture_manifest]
        unit_results_path = output / 'tooling/unit-results.json'
        if unit_results_path.is_file():
            result['toolingTests'] = json.loads(unit_results_path.read_text())
        result['measurementRuns'] = []
        for raw_path in sorted(output.glob('*/*.raw.json')):
            raw = json.loads(raw_path.read_text())
            for run in raw.get('runs', []):
                result['measurementRuns'].append({key: run.get(key) for key in (
                    'runId', 'mode', 'browserVersion', 'functionalStatus', 'cleanupStatus', 'playbackSessions', 'failureClass')} |
                    {'stage': raw.get('stage'), 'samples': len(run.get('samples', [])),
                     'finalOwnership': run.get('samples', [{}])[-1].get('ownership') if run.get('samples') else None})
        if 'plainTriage' not in result:
            raw_path = output / 'triage/transmux-mse.raw.json'
            if raw_path.is_file():
                raw = json.loads(raw_path.read_text())
                triage_decision = json.loads((output / 'triage/transmux-mse.decision.json').read_text())
                result['triageRawSha256'] = campaign.sha256_file(raw_path)
                result['transmuxMse'] = triage_decision.get('classification', 'INVALID_MEASUREMENT')
                result['failureClass'] = (raw.get('runs') or [{}])[0].get(
                    'failureClass') or result.get('reason')
                if result['transmuxMse'] == 'INVALID_MEASUREMENT':
                    result['cryptoTransmuxMse'] = 'NOT_RUN_INVALID_FIRST_BOUNDARY'
        result.setdefault('transmuxMse', 'NOT_RUN')
        result.setdefault('cryptoTransmuxMse', 'NOT_RUN')
        result['findings'] = {
            'R5-M01': result.get('transmuxMse', 'OPEN'),
            'R5-M02': result.get('cryptoTransmuxMse',
                'NOT_REQUIRED_BY_CAUSAL_DECISION_TREE' if result.get('transmuxMse') == REPRODUCES else 'NOT_RUN'),
            'R5-P01': 'CLOSED_BY_BOUNDED_DECISION_TREE'
                if result.get('status', '').startswith('PASS_') and wave.counts['currentBrowserLaunches'] <= BROWSER_CEILING
                else 'OPEN',
        }
        operation_counts = {**wave.counts, 'browserCeiling': BROWSER_CEILING,
            'frontendBuilds': 0, 'backendBuilds': 0,
            'fullFrontendRuns': 0, 'fullBackendRuns': 0, 'coverageRuns': 0,
            'mutationRuns': 0, 'automaticRetries': 0, 'workerBundleBuilds': 0,
            'timings': wave.timings}
        wave.save('pipeline/operation-counts.json', operation_counts)
        if final_hashes is not None:
            wave.save('final/source-hashes.json', final_hashes)
        wave.save('final/decision.json', result)
        wave.save('final/findings.json', result['findings'])
        report = [
            f"# AP-06-R5-R2: {result['status']}", '',
            f"Baseline HEAD: {baseline.get('gitHead', 'NOT_AVAILABLE') if baseline else 'NOT_AVAILABLE'}.",
            f"Production unchanged: {result.get('productionSourceUnchanged', False)}; video patch: NONE.",
            f"Historical R5 remains invalid: 1 launch, 0 valid samples; tree {historical.get('treeSha256', 'NOT_AVAILABLE')}; raw {historical.get('rawSha256', 'NOT_AVAILABLE')}.",
            f"Historical R5-R1: {historical_r1.get('status', 'NOT_AVAILABLE')}; tree {historical_r1.get('treeSha256', 'NOT_AVAILABLE')}; 0 measurement browsers, 0 fixtures; failure {historical_r1.get('reason', 'NOT_AVAILABLE')}.",
            f"Chromium expected/observed: {result.get('expectedChromiumVersion')} / {preflight_result.get('observedVersion', 'NOT_AVAILABLE')}; method {preflight_result.get('method', 'NOT_AVAILABLE')}; preflight {preflight_result.get('status', 'NOT_RUN')} ({preflight_result.get('failureClass') or 'NONE'}).",
            f"Frontend player source: {result.get('frontendPlayerSourceHash')}; worker bundle: {result.get('workerBundleSha256', 'NOT_AVAILABLE')}.",
            f"Fixture manifest: {result.get('fixtureManifestSha256', 'NOT_GENERATED')}; fixture count: {wave.counts['fixtureFilesGenerated']}.",
            f"Preflight processes: {wave.counts['chromiumIdentityPreflightProcesses']}; current measurement launches: "
            f"{wave.counts['currentBrowserLaunches']} ({wave.counts['currentValidMeasurementLaunches']} valid, "
            f"{wave.counts['currentInvalidMeasurementLaunches']} invalid).",
            f"Transmux+MSE: {result.get('transmuxMse', 'NOT_RUN')}; crypto+transmux: "
            f"{result.get('cryptoTransmuxMse', 'NOT_RUN')}.",
            f"Cycle-6 browser/renderer signed private-byte deltas: {result.get('cycle6ProcessOwnership', 'NOT_AVAILABLE')}.",
            f"Measurement runs (runtime version, sessions, samples, functional/cleanup status): "
            f"{[{key: value for key, value in row.items() if key != 'finalOwnership'} for row in result['measurementRuns']]}.",
            f"Formal: {result.get('formal', 'NOT_RUN').get('classification') if isinstance(result.get('formal'), dict) else 'NOT_RUN'}; tooling hashes: baseline/tooling-hashes.json.",
            f"Fixture hashes: {result.get('fixtureHashes', 'NOT_GENERATED')}.",
            f"Focused Angular: {angular['status']}; reason: {angular['reason']}.",
            f"Fixtures generated: {wave.counts['fixtureFilesGenerated']}; preparation commands: "
            f"{wave.counts['fixturePreparationProcesses']}; HTTP starts: {wave.counts['httpServerStarts']}.",
            f"Tooling unit results: {result.get('toolingTests', 'NOT_RUN')}; "
            f"commands total Node {wave.counts['nodeUnitCommands']}, Python {wave.counts['pythonUnitCommands']}; "
            f"npm ci: {wave.counts['npmCiRuns']}; builds and broad suites: 0.",
            f"Cleanup: {cleanup}; process samples: {wave.counts['processSampleCalls']}; "
            f"next boundary: {result.get('nextBoundary', 'UNRESOLVED')}.",
            'Not run: Wave 1–4 campaigns, R4, C02/C03, M02/M04, full backend/frontend, production build, coverage, mutation, Knip; production source remained unchanged.',
            '', 'AP-06 remains OPEN. No causal conclusion is drawn from historical infrastructure failures.',
        ]
        wave.report('final/final-report.md', '\n'.join(report))
    print(json.dumps(result), flush=True)
    return 0 if result.get('status', '').startswith('PASS_AP06_R5_R2_') else 1

def run_condition(wave, temp, fixtures, manifest_path, mode, stage, source_hash, worker_authority):
    mapping = ({f"/video-{item['id']}.mp4": temp / 'plain' / item['path'] for item in fixtures}
               if mode == PLAIN else {f"/video-{item['id']}.mp4": temp / 'ciphertext' / f"video-{item['id']}.bin" for item in fixtures})
    wave.counts['httpServerGenerations'] += 1
    wave.counts['httpServerStarts'] += 1
    with media_server(mapping) as (origin, stats):
        wave.env['AP06_R5_MEDIA_ORIGIN'] = origin
        folder = temp / ('plain' if mode == PLAIN else 'ciphertext')
        result = run_stage(wave, wave.output, stage, mode, fixtures, folder, manifest_path, source_hash, worker_authority)
        wave.save(f'{stage}/{mode}-media-transport.json', stats)
        return result


if __name__ == '__main__':
    raise SystemExit(main())
