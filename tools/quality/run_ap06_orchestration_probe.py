"""R6: an explicit baseline choice, one control, then the conditional orchestration tree."""
import argparse
import json
import math
import re
import statistics
from pathlib import Path
import sys
import tempfile

from run_readiness_wave1 import Wave, WaveFailure, campaign, owner
from run_ap06_transport_probe import media_server
from run_ap06_transmux_probe import CRYPTO, DOES_NOT, REPRODUCES, INCONCLUSIVE, PHASES, classify, validate_raw, validate_chromium_preflight
from validate_ap06_r6_authorities import BUNDLES

OUTPUT = '.quality/readiness-wave6-rebaseline'
CONDITIONS = ('control', 'r6.1', 'r6.2', 'r6.3')
TOOLING = (
    'frontend/tools/ap06-orchestration-probe.mjs', 'frontend/tools/ap06-orchestration-probe.test.mjs',
    'frontend/tools/ap06-transmux-probe.mjs', 'frontend/tools/ap06-transmux-probe.test.mjs',
    'frontend/tools/ap06-mse-probe.mjs', 'frontend/tools/ap06-mse-probe.test.mjs',
    'frontend/tools/browser-memory-probe.mjs', 'frontend/tools/mp4-resource-calibration-lib.mjs',
    'frontend/e2e-video/video-fixtures.ts', 'frontend/package.json', 'frontend/package-lock.json',
    'tools/quality/run_ap06_orchestration_probe.py', 'tools/quality/test_run_ap06_orchestration_probe.py',
    'tools/quality/run_ap06_transmux_probe.py', 'tools/quality/test_run_ap06_transmux_probe.py',
    'tools/quality/run_ap06_transport_probe.py', 'tools/quality/run_readiness_wave1.py',
)


def select_baseline(audit, available, allow_rebaseline=False):
    if audit['status'] == 'R5_R2_AUTHORITIES_VERIFIED':
        return 'RECOVERED_R5_R2'
    permitted = {'frontend/e2e-video/video-fixtures.ts', 'tools/quality/run_ap06_transmux_probe.py'}
    missing = set(audit.get('unavailableAuthorities', []))
    if (allow_rebaseline and audit['status'] == 'BLOCKED_MISSING_R5_R2_AUTHORITY' and missing and
            missing <= permitted and all(isinstance(available.get(path), str) and re.fullmatch(r'[a-f0-9]{64}', available[path]) for path in missing)):
        return 'NEW_BASELINE_REQUIRES_CONTROL'
    raise WaveFailure('BLOCKED_BASELINE_SELECTION')


def check_budget(approval, previous, requested):
    if (approval.get('approved') is not True or type(approval.get('maximumChromiumMeasurementLaunches')) is not int or
            not 1 <= approval['maximumChromiumMeasurementLaunches'] <= 7 or
            approval.get('retries') != 0 or type(previous) is not int or type(requested) is not int or
            previous < 0 or requested not in (1, 3) or previous + requested > approval['maximumChromiumMeasurementLaunches']):
        raise WaveFailure('BLOCKED_CHROMIUM_BUDGET')


def next_condition(condition, result):
    if result == REPRODUCES:
        return ('formal', condition) if condition != 'control' else None
    if result != DOES_NOT:
        return None
    index = CONDITIONS.index(condition)
    return ('triage', CONDITIONS[index + 1]) if index + 1 < len(CONDITIONS) else None


def checked_classification(summary):
    natural = [row for row in summary.get('phases', []) if row.get('phase') == 'cycle-6-close' and row.get('gc') == 'natural']
    if len(natural) != 1:
        return INCONCLUSIVE
    for kind in ('browser', 'renderer'):
        value = natural[0].get('processTypes', {}).get(kind, {}).get('privateBytes', {}).get('signedDelta', {}).get('median')
        if type(value) not in (int, float) or not math.isfinite(value):
            return INCONCLUSIVE
    return classify(summary)


def validate_condition(raw, condition, stage, source_hash, fixture_hash, harness_hash, runner_hash, fixtures):
    if raw.get('condition') != condition:
        raise WaveFailure('R6_CONDITION_IDENTITY_MISMATCH')
    validate_raw(raw, stage, CRYPTO, source_hash, fixture_hash, harness_hash, runner_hash, '151.0.7922.34',
                 transmux_chunks_per_cycle=sum(row['chunkCount'] - 1 for row in fixtures), control_lifecycle=condition == 'control')
    for run in raw['runs']:
        for sample in run['samples']:
            processes = sample.get('processMemory', {}).get('processes', [])
            if sample.get('processMemory', {}).get('status') != 'AVAILABLE' or not processes or any(type(row.get('pid')) is not int or row['pid'] <= 0 for row in processes):
                raise WaveFailure('INCONCLUSIVE_OWNED_PROCESS_IDENTITY')
            if condition == 'control':
                continue
            c = sample['counters']
            for created, released in [('mediaSourceCreated','mediaSourceClosed'), ('sourceBuffersCreated','sourceBuffersReleased'),
                ('objectUrlsCreated','objectUrlsRevoked'), ('cryptoWorkersCreated','cryptoWorkersTerminated'),
                ('transmuxWorkersCreated','transmuxWorkersTerminated')]:
                if c.get(created) != sample['cycle'] * 3 or c.get(released) != sample['cycle'] * 3:
                    raise WaveFailure('R6_LIFECYCLE_COUNTER_FAIL')
            for key in ('activeDownloads', 'activeRangeRequests', 'currentFetches', 'pendingSchedulerJobs', 'liveEncryptedFetchBytes'):
                if c.get(key) != 0 or sample['ownership'].get(key) != 0:
                    raise WaveFailure('R6_SCHEDULER_OWNERSHIP_FAIL')
            for created, settled in [('fetchPromisesCreated', 'fetchPromisesSettled'), ('processLockJobsQueued', 'processLockJobsSettled')]:
                if c.get(created) != c.get(settled):
                    raise WaveFailure('R6_PROMISES_NOT_DRAINED')
            if (c.get('rangeRequestsFailed') != 0 or c.get('maxActiveDownloads', 4) > 3 or
                    c.get('maxActiveRangeRequests', 4) > 3 or c.get('playbackSessionsCompleted') != sample['cycle'] * 3):
                raise WaveFailure('R6_FUNCTIONAL_OR_BUDGET_FAIL')
            if c.get('rangeRequestsStarted') != sum(c.get(key, -1) for key in ('rangeRequestsCompleted', 'rangeRequestsAborted', 'rangeRequestsFailed')):
                raise WaveFailure('R6_RANGE_REQUESTS_UNBALANCED')
        final = run['samples'][6]['counters']
        if condition != 'control' and (final.get('maxActiveRangeRequests', 0) < 2 or final.get('sessionsWithConcurrentRanges', 0) != 18):
            raise WaveFailure('INSUFFICIENT_SCHEDULER_EXERCISE')
    deltas = individual_deltas(raw)
    natural = next((row for row in raw['summary'].get('phases', []) if row.get('phase') == 'cycle-6-close' and row.get('gc') == 'natural'), None)
    if natural is None:
        raise WaveFailure('R6_NATURAL_SUMMARY_MISSING')
    for kind in ('browser', 'renderer'):
        values = [row[kind + 'DeltaMiB'] * 1048576 for row in deltas]
        recorded = natural.get('processTypes', {}).get(kind, {}).get('privateBytes', {}).get('signedDelta', {})
        if any(recorded.get(key) != value for key, value in [('min',min(values)),('median',statistics.median(values)),('max',max(values))]):
            raise WaveFailure('R6_SUMMARY_DOES_NOT_MATCH_RAW')
    return checked_classification(raw['summary'])


def individual_deltas(raw):
    rows = []
    for run in raw['runs']:
        first, last = run['samples'][0], run['samples'][6]
        browser = last['processMemory']['byCategory']['browser']['privateBytes'] - first['processMemory']['byCategory']['browser']['privateBytes']
        renderer = last['processMemory']['byCategory']['renderer']['privateBytes'] - first['processMemory']['byCategory']['renderer']['privateBytes']
        rows.append({'runId':run['runId'], 'browserDeltaMiB':browser / 1048576, 'rendererDeltaMiB':renderer / 1048576,
            'classification': REPRODUCES if browser > renderer and browser > 0 else DOES_NOT if renderer > browser and renderer > 0 else INCONCLUSIVE})
    return rows


def frozen_hashes(root):
    return {path: campaign.sha256_file(root / path) for path in TOOLING}


def verify_freeze(root, freeze):
    if campaign.sha256_file(root / OUTPUT / 'baseline/budget-approval.json') != freeze['budgetApprovalSha256']:
        raise WaveFailure('FROZEN_R6_BUDGET_CHANGED')
    if frozen_hashes(root) != freeze['tooling'] or owner._tree_sha256(root, 'frontend/src') != freeze['sourceHash']:
        raise WaveFailure('FROZEN_R6_SOURCE_CHANGED')
    for path, sha in freeze['productionFiles'].items():
        if campaign.sha256_file(root / path) != sha:
            raise WaveFailure('R6_PRODUCTION_MUTATED')
    for key, (path, sha) in BUNDLES.items():
        if campaign.sha256_file(root / path) != sha:
            raise WaveFailure('R6_WORKER_BUNDLE_CHANGED')


def prepare_cohort(wave, temporary, name, tail=False):
    directory = temporary / name; directory.mkdir()
    plaintext = directory / 'plain'
    manifest_path = wave.output / 'fixtures' / f'{name}.json'
    if manifest_path.exists():
        raise WaveFailure('BLOCKED_EXISTING_R6_COHORT')
    env = dict(wave.env, AP06_R5_FIXTURE_DIR=str(plaintext), AP06_R5_FIXTURE_MANIFEST=str(manifest_path),
               AP06_R5_FFMPEG_VERSION=wave.versions['ffmpeg'], AP06_R6_TAIL_MOOV='1' if tail else '0')
    wave.command(name + '-plaintext', [wave.node, 'tools/ap06-orchestration-probe.mjs', '--prepare'], wave.root / 'frontend', env)
    fixtures = json.loads(manifest_path.read_text())
    if (len(fixtures) != 3 or [row['id'] for row in fixtures] != [0,1,2] or any(
            row['path'] != f"video-{row['id']}.mp4" or row['chunkBytes'] != 4194304 or
            type(row['chunkCount']) is not int or row['chunkCount'] < 3 for row in fixtures)):
        raise WaveFailure('R6_FIXTURE_COHORT_INVALID')
    ciphertext = directory / 'ciphertext'; ciphertext.mkdir()
    metadata = directory / 'crypto-chunks.json'; auxiliary = temporary / 'kasumi-generator.cjs'
    env.update(AP06_PREPARE_CRYPTO='1', AP06_KASUMI_BUNDLE=str(auxiliary),
               AP06_KASUMI_BUNDLE_SHA256=campaign.sha256_file(auxiliary) if auxiliary.exists() else '',
               AP06_CRYPTO_PREP_METADATA=str(metadata), AP06_FIXTURES=json.dumps([
                   {**fixture, 'absolutePath': str(plaintext / fixture['path']),
                    'ciphertextAbsolutePath': str(ciphertext / f"video-{fixture['id']}.bin")} for fixture in fixtures]))
    wave.counts['auxiliaryProbeBuilds'] += int(not auxiliary.exists())
    wave.command(name + '-ciphertext', [wave.node, 'tools/ap06-mse-probe.mjs'], wave.root / 'frontend', env)
    crypto_chunks = json.loads(metadata.read_text())
    for fixture, chunk in zip(fixtures, crypto_chunks, strict=True):
        path = ciphertext / f"video-{fixture['id']}.bin"
        if (campaign.sha256_file(plaintext / fixture['path']) != fixture['sha256'] or
                chunk['id'] != fixture['id'] or chunk['chunkCount'] != fixture['chunkCount'] or
                path.stat().st_size != fixture['bytes'] + fixture['chunkCount'] * 16):
            raise WaveFailure('R6_FIXTURE_INTEGRITY_FAIL')
        fixture.update(ciphertextBytes=path.stat().st_size, ciphertextSha256=campaign.sha256_file(path), dataOffset=0)
    manifest_path.write_text(json.dumps(fixtures, indent=2) + '\n', encoding='utf-8')
    wave.counts['ffmpegFixtureProcesses'] += 3
    return fixtures, ciphertext, manifest_path


def measure(wave, condition, stage, fixtures, ciphertext, manifest_path, freeze, ledger, approval):
    requested = 3 if stage == 'formal' else 1
    check_budget(approval, sum(item['reservedAttempts'] for item in ledger), requested)
    directory = wave.output / stage / condition
    directory.mkdir(parents=True, exist_ok=False)
    verify_freeze(wave.root, freeze)
    if campaign.sha256_file(manifest_path) != freeze['fixtureManifestHashes'][manifest_path.name]:
        raise WaveFailure('R6_FROZEN_FIXTURE_MANIFEST_CHANGED')
    for fixture in fixtures:
        path = ciphertext / f"video-{fixture['id']}.bin"
        if campaign.sha256_file(path) != fixture['ciphertextSha256']:
            raise WaveFailure('R6_FIXTURE_INTEGRITY_FAIL')
    entry = {'condition': condition, 'stage': stage, 'reservedAttempts': requested, 'actualLaunchAttempts': 0, 'browserLaunches': 0}
    ledger.append(entry); wave.save('pipeline/launch-ledger.json', ledger)
    env = dict(wave.env, AP06_R5_MODE=CRYPTO, AP06_R5_STAGE=stage, AP06_R5_ARTIFACT_DIR=str(directory),
        AP06_R5_FIXTURE_MANIFEST=str(manifest_path), AP06_R5_CHROMIUM_VERSION='151.0.7922.34', AP06_R6_CONDITION=condition,
        AP06_R5_SOURCE_HASH=freeze['sourceHash'], AP06_R5_HARNESS_HASH=freeze['tooling']['frontend/tools/ap06-transmux-probe.mjs' if condition == 'control' else 'frontend/tools/ap06-orchestration-probe.mjs'],
        AP06_R5_RUNNER_SHA256=freeze['tooling']['tools/quality/run_ap06_orchestration_probe.py'],
        WAVE1_PYTHON=sys.executable, WAVE1_RUNNER=str(wave.root / 'tools/quality/run_readiness_wave1.py'))
    for key, (path, sha) in BUNDLES.items():
        prefix = 'TRANSMUX' if key == 'transmuxWorker' else 'CRYPTO'
        env['AP06_R5_' + prefix + '_WORKER'] = str(wave.root / path); env['AP06_R5_' + prefix + '_WORKER_SHA256'] = sha
    command_error = None
    with media_server({f"/video-{row['id']}.mp4": ciphertext / f"video-{row['id']}.bin" for row in fixtures}, strict_ranges=condition != 'control', content_type='application/octet-stream') as (url, stats):
        env['AP06_R5_MEDIA_ORIGIN'] = url
        try:
            wave.command(stage + '-' + condition, [wave.node, 'tools/ap06-transmux-probe.mjs' if condition == 'control' else 'tools/ap06-orchestration-probe.mjs'], wave.root / 'frontend', env)
        except WaveFailure as error:
            command_error = error
        raw_path = directory / (CRYPTO + '.raw.json')
        if not raw_path.is_file():
            raise command_error or WaveFailure('R6_RAW_EVIDENCE_MISSING')
        raw = json.loads(raw_path.read_text())
        entry.update(actualLaunchAttempts=raw['launchAttempts'], browserLaunches=raw['browserLaunches'],
            processSampleCalls=raw['processSampleCalls'], rawSha256=campaign.sha256_file(raw_path))
        wave.save('pipeline/launch-ledger.json', ledger); wave.save(f'{stage}/{condition}/transport.json', stats)
        if command_error:
            raise command_error
        classification = validate_condition(raw, condition, stage, freeze['sourceHash'], campaign.sha256_file(manifest_path),
            env['AP06_R5_HARNESS_HASH'], env['AP06_R5_RUNNER_SHA256'], fixtures)
    result = {'condition': condition, 'stage': stage, 'status': 'VALID', 'classification': classification,
        'rawSha256': campaign.sha256_file(raw_path), 'rawPath': raw_path.relative_to(wave.output).as_posix(),
        'fixtureManifestSha256': campaign.sha256_file(manifest_path), 'browserLaunches': raw['browserLaunches'],
        'processSampleCalls': raw['processSampleCalls'], 'summary': raw['summary'], 'individualRuns': individual_deltas(raw)}
    wave.save(f'{stage}/{condition}/decision.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--frozen-campaign', action='store_true', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]; wave = Wave(root); wave.output = root / OUTPUT
    freeze = json.loads((wave.output / 'tooling/freeze.json').read_text())
    approval = json.loads((wave.output / 'baseline/budget-approval.json').read_text())
    if freeze.get('status') != 'FROZEN' or (wave.output / 'pipeline/launch-ledger.json').exists():
        raise WaveFailure('BLOCKED_CAMPAIGN_NOT_FRESH_OR_NOT_FROZEN')
    verify_freeze(root, freeze)
    check_budget(approval,0,1)
    with (wave.output/'pipeline/campaign-started.json').open('x',encoding='utf-8') as file:
        json.dump({'status':'STARTED','baselineCase':freeze['baselineCase'],'automaticRetries':0},file)
    wave.versions = json.loads((wave.output / 'baseline/tool-versions.json').read_text())
    wave.counts.update(ffmpegFixtureProcesses=0, controlLaunches=0, r6Launches=0, automaticRetries=0)
    ledger = []; results = []
    decision = {'status': 'FAIL_R6_MEASUREMENT', 'ap06': 'OPEN', 'baselineCase': freeze['baselineCase'], 'results': results, 'browserBudget': approval}
    with tempfile.TemporaryDirectory(prefix='nanika-r6-fixtures-') as temporary:
        wave.temp = Path(temporary)
        if not wave.temp.resolve().is_relative_to(Path(tempfile.gettempdir()).resolve()) or not wave.temp.name.startswith('nanika-r6-fixtures-'):
            raise WaveFailure('TEMPORARY_OWNERSHIP_INVALID')
        try:
            fixtures, ciphertext, manifest = prepare_cohort(wave, wave.temp, 'faststart')
            freeze['fixtureManifestHashes'] = {manifest.name: campaign.sha256_file(manifest)}
            wave.save('fixtures/faststart-freeze.json', {'manifestSha256': freeze['fixtureManifestHashes'][manifest.name]})
            condition, stage = ('r6.1' if freeze['baselineCase'] == 'RECOVERED_R5_R2' else 'control'), 'triage'
            while True:
                if condition == 'r6.3' and fixtures[0]['layout'] != 'tail-moov':
                    fixtures, ciphertext, manifest = prepare_cohort(wave, wave.temp, 'tail-moov', tail=True)
                    freeze['fixtureManifestHashes'][manifest.name] = campaign.sha256_file(manifest)
                    wave.save('fixtures/tail-moov-freeze.json', {'manifestSha256': freeze['fixtureManifestHashes'][manifest.name]})
                result = measure(wave, condition, stage, fixtures, ciphertext, manifest, freeze, ledger, approval)
                results.append(result)
                if condition == 'control' and result['classification'] != DOES_NOT:
                    decision['status'] = 'CONTROL_DIVERGED_FROM_HISTORICAL_RENDERER_HEAVY'; break
                if stage == 'formal':
                    confirmed = result['classification'] == REPRODUCES and all(row['classification'] == REPRODUCES for row in result['individualRuns'])
                    decision['status'] = ('PASS_AP06_R6_' + {'r6.1':'SCHEDULER', 'r6.2':'BOOTSTRAP', 'r6.3':'TAIL_MOOV'}[condition] + '_BOUNDARY_REPRODUCED') if confirmed else 'INCONCLUSIVE_FORMAL_REPRODUCTION'
                    break
                selected = next_condition(condition, result['classification'])
                if selected is None:
                    decision['status'] = 'PASS_AP06_R6_EVIDENCE_COMPLETE' if condition == 'r6.3' and result['classification'] == DOES_NOT else 'INCONCLUSIVE_R6_PROCESS_OWNERSHIP'
                    break
                stage, condition = selected
        except Exception as error:
            decision['failureClass'] = str(error) if isinstance(error, WaveFailure) else type(error).__name__
        finally:
            wave.counts.update(browserMeasurementProcesses=sum(row['browserLaunches'] for row in ledger),
                controlLaunches=sum(row['browserLaunches'] for row in ledger if row['condition']=='control'),
                r6Launches=sum(row['browserLaunches'] for row in ledger if row['condition']!='control'),
                processSampleCalls=sum(row.get('processSampleCalls',0) for row in ledger),
                nodeUnitCommands=freeze['developmentCounts']['nodeUnitCommands'],pythonUnitCommands=freeze['developmentCounts']['pythonUnitCommands'])
            decision.update(browserLaunches=sum(row['browserLaunches'] for row in ledger), launchAttempts=sum(row['actualLaunchAttempts'] for row in ledger),
                retries=0, productionChanges=0, fixturesTemporary=True)
            wave.save('final/decision.json', decision); wave.save('pipeline/operation-counts.json', wave.counts)
    wave.save('pipeline/temporary-cleanup.json', {'status':'FAIL' if wave.temp.exists() else 'PASS','temporaryFixtureRootExists':wave.temp.exists()})
    print(json.dumps({'status':decision['status'],'browserLaunches':decision['browserLaunches'],'launchAttempts':decision['launchAttempts'],'failureClass':decision.get('failureClass')}),flush=True)
    return 0 if decision['status'].startswith('PASS_') else 1


if __name__ == '__main__':
    raise SystemExit(main())
