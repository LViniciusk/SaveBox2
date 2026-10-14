"""AP-06-R7: authenticated control, real service, then the real Angular player."""
import argparse
import json
import math
from pathlib import Path
import statistics
import sys
import tempfile

from run_readiness_wave1 import Wave, WaveFailure, campaign, owner
from run_ap06_transport_probe import media_server
from run_ap06_transmux_probe import CRYPTO, DOES_NOT, REPRODUCES, INCONCLUSIVE, PHASES, validate_raw
from run_ap06_orchestration_probe import checked_classification, individual_deltas

OUTPUT = '.quality/readiness-wave7-r2'
VERSION = '151.0.7922.34'
CONDITIONS = ('r7.0', 'r7.1', 'r7.2')
AUTOPLAY = ['--autoplay-policy=no-user-gesture-required']
ALLOWED_EXISTING = {'.gitattributes', 'frontend/angular.json', 'frontend/tools/ap06-orchestration-probe.mjs',
    'frontend/tools/ap06-transmux-probe.mjs', 'tools/quality/run_ap06_transmux_probe.py',
    'tools/quality/run_ap06_transport_probe.py'}


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def check_budget(budget, previous, requested):
    if (budget.get('approved') is not True or budget.get('measurementMaximum') != 6 or
            budget.get('measurementRetries') != 0 or type(previous) is not int or previous < 0 or
            type(requested) is not int or requested not in (1, 3) or previous + requested > 6):
        raise WaveFailure('R7_BROWSER_BUDGET_EXCEEDED')


def next_condition(condition, classification):
    if condition not in CONDITIONS:
        raise WaveFailure('INVALID_R7_CONDITION')
    if classification == REPRODUCES:
        return None if condition == 'r7.0' else ('formal', condition)
    if classification != DOES_NOT:
        return None
    index = CONDITIONS.index(condition)
    return ('triage', CONDITIONS[index + 1]) if index + 1 < len(CONDITIONS) else None


def claim_stage(output, condition, stage):
    if condition not in CONDITIONS or stage not in ('triage', 'formal') or condition == 'r7.0' and stage == 'formal':
        raise WaveFailure('INVALID_R7_STAGE')
    path = output / stage / condition
    try:
        path.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        raise WaveFailure('BLOCKED_EXISTING_R7_STAGE') from None
    return path


def build_products(root):
    app = root / OUTPUT / 'tooling/app'
    assets = {'/': (app / 'browser/index.html', 'text/html; charset=utf-8')}
    for path in (app / 'browser').iterdir():
        if path.suffix in ('.js', '.css'):
            assets['/' + path.name] = (path, 'text/javascript' if path.suffix == '.js' else 'text/css')
    products = {path.relative_to(root).as_posix(): campaign.sha256_file(path) for path, _ in assets.values()}
    workers = {}
    for name, data in read(app / 'stats.json')['outputs'].items():
        for kind in ('crypto', 'transmux'):
            if data.get('entryPoint', '').endswith(f'/stream-{kind}.worker.ts'):
                path = app / 'browser' / name
                workers[kind] = {'path': path.relative_to(root).as_posix(), 'name': name, 'sha256': campaign.sha256_file(path)}
    if set(workers) != {'crypto', 'transmux'} or not assets['/'][0].is_file():
        raise WaveFailure('R7_EXECUTABLE_BUNDLES_MISSING')
    return assets, products, workers


def verify_authorities(root):
    baseline = read(root / OUTPUT / 'baseline/authority-snapshot.local.json')
    for path, expected in baseline['protectedFiles'].items():
        if path not in ALLOWED_EXISTING and campaign.sha256_file(root / path) != expected:
            raise WaveFailure('R7_PRODUCTION_OR_HISTORY_CHANGED')
    original, r6 = root.with_name('SaveBox2'), root.with_name('SaveBox2-ap06-r6')
    for values, directory in [(baseline['originalHistories'], original), (baseline['r6Artifacts'], r6)]:
        for path, expected in values.items():
            if campaign.sha256_file(directory / path) != expected:
                raise WaveFailure('R7_HISTORICAL_AUTHORITY_CHANGED')
    for path, expected in baseline['priorR7Artifacts'].items():
        if campaign.sha256_file(root / path) != expected:
            raise WaveFailure('R7_ORIGINAL_CAMPAIGN_CHANGED')
    old_config = json.loads(Wave(root).git('show', baseline['baseHead'] + ':frontend/angular.json'))
    if read(root / 'frontend/angular.json')['projects']['frontend'] != old_config['projects']['frontend']:
        raise WaveFailure('R7_NORMAL_APP_CONFIGURATION_CHANGED')
    return baseline


def verify_freeze(root, freeze):
    for path, expected in freeze['files'].items():
        if campaign.sha256_file(root / path) != expected:
            raise WaveFailure('R7_FROZEN_SOURCE_OR_FIXTURE_CHANGED')
    verify_authorities(root)


def expected_source_buffers(fixtures, cycle):
    if ([row.get('id') for row in fixtures] != [0, 1, 2] or
            [[track.get('type') for track in row.get('tracks', [])] for row in fixtures] !=
            [['video', 'audio'], ['video'], ['video', 'audio']]):
        raise WaveFailure('R7_INVALID_FIXTURE_COHORT')
    # Frozen handleTransmuxReady emits one multiplexed initData item (id=0) per fixture.
    return cycle * len(fixtures)


def validate_condition(raw, condition, stage, freeze, fixtures):
    expected_source_buffers(fixtures, 0)
    if freeze.get('multiplexedContract') != {'fixtureHash': freeze['fixtureHash'],
            'workerHashes': {kind: row['sha256'] for kind, row in freeze['workers'].items()},
            'initDataPerFixture': [1, 1, 1], 'initDataId': 0}:
        raise WaveFailure('R7_MULTIPLEXED_CONTRACT_NOT_VERIFIED')
    identities = {'playwrightRoutingInstalled': True, 'fetchInterceptionInstalled': False,
        'videoStreamServiceUsed': condition != 'r7.0', 'angularOrBackendUsed': True,
        'videoPlayerComponentUsed': condition == 'r7.2', 'backendUsed': False,
        'localRequestsIntercepted': False, 'fullKasumiContainer': True}
    validate_raw(raw, stage, CRYPTO, freeze['sourceHash'], freeze['fixtureHash'], freeze['harnessHash'],
        freeze['runnerHash'], VERSION, control_lifecycle=False, identity_expectations=identities)
    if raw.get('condition') != condition or raw.get('autoplayArgs') != AUTOPLAY:
        raise WaveFailure('R7_CONDITION_OR_PROTOCOL_CHANGED')
    if raw.get('experimentalAppProducts') != freeze['appProducts'] or raw.get('pageScriptSha256') != freeze['pageScriptSha256']:
        raise WaveFailure('R7_EXECUTED_APP_OR_PAGE_SCRIPT_CHANGED')
    identities = [{key: fixture[key] for key in ('id', 'name', 'bytes', 'sha256')} for fixture in fixtures]
    if raw.get('fixtureIdentities') != identities:
        raise WaveFailure('R7_FIXTURE_IDENTITIES_CHANGED')
    if (raw.get('workerBundleSha256') != freeze['workers']['transmux']['sha256'] or
            raw.get('cryptoWorkerBundleSha256') != freeze['workers']['crypto']['sha256']):
        raise WaveFailure('R7_EXECUTED_WORKER_IDENTITY_CHANGED')
    network = raw.get('network', {})
    if any(network.get(key) != 0 for key in ('rejectedRequests', 'externalRequests', 'unexpectedRequests')) or raw.get('pageErrors') != 0 or raw.get('recoveryWarnings') != 0:
        raise WaveFailure('R7_NETWORK_OR_RECOVERY_PROTOCOL_INVALID')
    requested_workers = network.get('workerRequests', {})
    allowed_workers = {row['name'] for row in freeze['workers'].values()}
    if set(requested_workers) - allowed_workers or condition != 'r7.0' and any(requested_workers.get(name, 0) == 0 for name in allowed_workers):
        raise WaveFailure('R7_ACTUAL_WORKER_URLS_NOT_VERIFIED')
    for run in raw['runs']:
        for sample in run['samples']:
            cycle = sample['cycle']; sessions = cycle * 3
            process = sample['processMemory']
            if process.get('status') != 'AVAILABLE' or not process.get('processes') or any(type(row.get('pid')) is not int or row['pid'] <= 0 for row in process['processes']):
                raise WaveFailure('R7_PROCESS_IDENTITY_MISSING')
            for kind in ('browser', 'renderer'):
                value = process.get('byCategory', {}).get(kind, {}).get('privateBytes')
                if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                    raise WaveFailure('R7_PROCESS_METRIC_INVALID')
            if sample.get('workerBundleHash') != freeze['workers']['transmux']['sha256'] or sample.get('cryptoWorkerBundleHash') != freeze['workers']['crypto']['sha256']:
                raise WaveFailure('R7_SAMPLE_WORKER_IDENTITY_CHANGED')
            c = sample['counters'].get('observed', {})
            components = sessions * (0 if condition == 'r7.0' else 2 if condition == 'r7.2' else 1)
            buffers = expected_source_buffers(fixtures, cycle)
            expected = {'initializeAttempts': sessions, 'initializeSettled': sessions, 'playbackStarted': sessions,
                'playbackCompleted': sessions, 'destroyCalls': sessions, 'componentsMounted': components,
                'componentsDestroyed': components, 'metadataRequests': sessions, 'workersCreated': sessions * 2,
                'workersTerminated': sessions * 2, 'mediaSourcesCreated': sessions, 'mediaSourcesClosed': sessions,
                'sourceBuffersCreated': buffers, 'sourceBuffersReleased': buffers}
            if any(c.get(key) != value for key, value in expected.items()):
                raise WaveFailure('R7_OBSERVED_LIFECYCLE_INCOMPLETE')
            if any(c.get(key) != 0 for key in ('initializeFailures', 'playbackFailures', 'rangeRequestsFailed',
                    'rangeRequestsAborted', 'workerErrors', 'transferFailures', 'unhandledRejections',
                    'pendingOperations', 'pendingAppends', 'activeRanges', 'timersLive', 'experimentalListeners')):
                raise WaveFailure('R7_FUNCTIONAL_OR_SETTLEMENT_FAILED')
            if c.get('rangeRequestsStarted') != c.get('rangeRequestsCompleted') or c.get('workerMessagesSent') != c.get('workerMessagesReceived') or c.get('workerMessagesCancelled') != 0:
                raise WaveFailure('R7_NATIVE_OPERATIONS_NOT_DRAINED')
            if sessions and (c.get('bytesAppended', 0) <= 0 or c.get('detachedTransfers', 0) <= 0):
                raise WaveFailure('R7_REAL_MEDIA_OR_TRANSFERS_NOT_OBSERVED')
            rows = sample['counters'].get('sessions', [])
            if len(rows) != sessions or [row.get('fixture') for row in rows] != list(range(3)) * cycle:
                raise WaveFailure('R7_SESSION_IDENTITIES_INCOMPLETE')
            selected = {'r7.0': 'control', 'r7.1': 'service', 'r7.2': 'component'}[condition]
            for row in rows:
                times = [row.get(key) for key in ('mountedMs', 'canplayMs', 'playbackMs', 'closeMs', 'maxCurrentTime')]
                if (row.get('mode') != selected or any(type(value) not in (int, float) or not math.isfinite(value) for value in times) or
                        not times[0] <= times[1] <= times[3] or not times[0] <= times[2] <= times[3] or
                        not 1.5 < times[4] < 10 or row.get('seeks') != 0 or row.get('muted') is not (condition != 'r7.2') or
                        row.get('volume') != 1 or row.get('playbackRate') != 1):
                    raise WaveFailure('R7_PLAYBACK_TIMING_OR_TRIGGER_INVALID')
    individual = individual_deltas(raw)
    natural = next(row for row in raw['summary']['phases'] if row.get('phase') == 'cycle-6-close' and row.get('gc') == 'natural')
    for kind in ('browser', 'renderer'):
        values = [row[kind + 'DeltaMiB'] * 1048576 for row in individual]
        recorded = natural['processTypes'][kind]['privateBytes']['signedDelta']
        if any(recorded.get(key) != value for key, value in [('min', min(values)), ('median', statistics.median(values)), ('max', max(values))]):
            raise WaveFailure('R7_SUMMARY_DISAGREES_WITH_RAW')
    return checked_classification(raw['summary'])


def environment(wave, directory, condition='r7.0', stage='triage', freeze=None):
    assets, products, workers = build_products(wave.root)
    manifest = wave.output / 'fixtures/manifest.json'
    env = dict(wave.env, AP06_R5_MODE=CRYPTO, AP06_R5_STAGE=stage, AP06_R5_ARTIFACT_DIR=str(directory),
        AP06_R5_FIXTURE_MANIFEST=str(manifest), AP06_R5_CHROMIUM_VERSION=VERSION, AP06_R6_CONDITION=condition,
        AP06_R7_ALLOWED_PATHS=json.dumps(list(assets) + [f'/video-{n}.mp4' for n in range(3)]),
        AP06_R7_APP_PRODUCTS=json.dumps(products),
        WAVE1_PYTHON=sys.executable, WAVE1_RUNNER=str(wave.root / 'tools/quality/run_readiness_wave1.py'))
    for kind, value in workers.items():
        env['AP06_R5_' + kind.upper() + '_WORKER'] = str(wave.root / value['path'])
        env['AP06_R5_' + kind.upper() + '_WORKER_SHA256'] = value['sha256']
    if freeze:
        env.update(AP06_R5_SOURCE_HASH=freeze['sourceHash'], AP06_R5_HARNESS_HASH=freeze['harnessHash'], AP06_R5_RUNNER_SHA256=freeze['runnerHash'])
    return env, assets


def unit_browser(wave):
    if (wave.output / 'tooling/freeze.json').exists():
        raise WaveFailure('R7_UNIT_BROWSER_AFTER_FREEZE_FORBIDDEN')
    attempt = len(list((wave.output / 'tooling').glob('angular-unit-*.json'))) + 1
    target = wave.output / f'tooling/angular-unit-{attempt}.json'
    env, assets = environment(wave, wave.output / 'tooling')
    env['AP06_R7_UNIT_OUTPUT'] = str(target)
    files = {f'/video-{n}.mp4': wave.output / f'fixtures/cipher/video-{n}.bin' for n in range(3)}
    with media_server(files, True, 'application/octet-stream', assets) as (origin, stats):
        env['AP06_R5_MEDIA_ORIGIN'] = origin
        wave.command(f'angular-unit-{attempt}', [wave.node, 'tools/ap06-angular-integration-check.mjs'], wave.root / 'frontend', env)
        wave.save(f'pipeline/angular-unit-{attempt}-transport.json', stats)
    result = read(target)
    if result['status'] != 'PASS':
        raise WaveFailure('R7_ANGULAR_UNIT_FAILED')
    print(json.dumps({'status': result['status'], 'cases': len(result['cases']), 'unitBrowsers': result['unitBrowserLaunches']}), flush=True)


def measure(wave, condition, stage, freeze, ledger):
    budget = read(wave.output / 'baseline/budget.json')
    requested = 3 if stage == 'formal' else 1
    check_budget(budget, sum(row['reservedAttempts'] for row in ledger), requested)
    directory = claim_stage(wave.output, condition, stage)
    verify_freeze(wave.root, freeze)
    entry = {'condition': condition, 'stage': stage, 'reservedAttempts': requested, 'launchAttempts': 0, 'browserLaunches': 0}
    ledger.append(entry); wave.save('pipeline/launch-ledger.json', ledger)
    env, assets = environment(wave, directory, condition, stage, freeze)
    files = {f'/video-{n}.mp4': wave.output / f'fixtures/cipher/video-{n}.bin' for n in range(3)}
    command_error = None
    with media_server(files, True, 'application/octet-stream', assets) as (origin, stats):
        env['AP06_R5_MEDIA_ORIGIN'] = origin
        try:
            wave.command(stage + '-' + condition, [wave.node, 'tools/ap06-integration-probe.mjs'], wave.root / 'frontend', env)
        except WaveFailure as error:
            command_error = error
        raw_path = directory / (CRYPTO + '.raw.json')
        if not raw_path.exists():
            raise command_error or WaveFailure('R7_RAW_MISSING')
        raw = read(raw_path)
        entry.update(launchAttempts=raw['launchAttempts'], browserLaunches=raw['browserLaunches'],
            processSampleCalls=raw['processSampleCalls'], rawSha256=campaign.sha256_file(raw_path))
        wave.save('pipeline/launch-ledger.json', ledger); wave.save(f'{stage}/{condition}/transport.json', stats)
    if command_error:
        raise command_error
    verify_freeze(wave.root, freeze)
    classification = validate_condition(raw, condition, stage, freeze, read(wave.output / 'fixtures/manifest.json'))
    result = {'condition': condition, 'stage': stage, 'status': 'VALID', 'classification': classification,
        'rawPath': raw_path.relative_to(wave.output).as_posix(), 'rawSha256': entry['rawSha256'],
        'individualRuns': individual_deltas(raw), 'summary': raw['summary']}
    wave.save(f'{stage}/{condition}/decision.json', result)
    return result


def campaign_run(wave):
    freeze = read(wave.output / 'tooling/freeze.json')
    if freeze.get('readiness') != {'units': 'PASS', 'angularIntegration': 'PASS', 'build': 'PASS', 'preflight': 'PASS', 'integrity': 'PASS', 'secretScan': 'PASS'}:
        raise WaveFailure('BLOCKED_R7_READINESS_NOT_VALIDATED')
    if freeze.get('status') != 'FROZEN' or (wave.output / 'pipeline/campaign-started.json').exists() or (wave.output / 'pipeline/launch-ledger.json').exists():
        raise WaveFailure('BLOCKED_R7_CAMPAIGN_NOT_FRESH')
    verify_freeze(wave.root, freeze)
    check_budget(read(wave.output / 'baseline/budget.json'), 0, 1)
    with (wave.output / 'pipeline/campaign-started.json').open('x', encoding='utf-8') as file:
        json.dump({'measurementRetries': 0, 'implementationHead': freeze['implementationHead']}, file)
    ledger, results = [], []
    decision = {'status': 'BLOCKED_AP06_R7_INVALID_MEASUREMENT', 'ap06': 'OPEN', 'results': results}
    condition, stage = 'r7.0', 'triage'
    try:
        while True:
            print(json.dumps({'stage': stage, 'condition': condition, 'state': 'STARTED'}), flush=True)
            result = measure(wave, condition, stage, freeze, ledger); results.append(result)
            print(json.dumps({'stage': stage, 'condition': condition, 'classification': result['classification']}), flush=True)
            if condition == 'r7.0' and result['classification'] != DOES_NOT:
                decision['status'] = 'BLOCKED_AP06_R7_INVALID_CONTROL'; break
            if stage == 'formal':
                confirmed = all(row['classification'] == REPRODUCES for row in result['individualRuns'])
                decision['status'] = ('PASS_AP06_R7_SERVICE_BOUNDARY_REPRODUCED' if condition == 'r7.1' else 'PASS_AP06_R7_COMPONENT_BOUNDARY_REPRODUCED') if confirmed else 'BLOCKED_AP06_R7_FORMAL_DISAGREEMENT'
                break
            following = next_condition(condition, result['classification'])
            if following is None:
                decision['status'] = 'PASS_AP06_R7_EVIDENCE_COMPLETE' if result['classification'] == DOES_NOT else 'BLOCKED_AP06_R7_INVALID_MEASUREMENT'
                break
            stage, condition = following
    except Exception as error:
        decision.update(status='BLOCKED_AP06_R7_INVALID_CONTROL' if condition == 'r7.0' else 'BLOCKED_AP06_R7_INVALID_MEASUREMENT',
            condition=condition, stage=stage, failureClass=str(error) if isinstance(error, WaveFailure) else type(error).__name__)
    decision.update(browserLaunches=sum(row['browserLaunches'] for row in ledger), launchAttempts=sum(row['launchAttempts'] for row in ledger),
        processSamples=sum(row.get('processSampleCalls', 0) for row in ledger), retries=0,
        nextBoundary='INTEGRATED_APP_DRIVE_STORE_AND_LOCAL_BACKEND' if decision['status'] == 'PASS_AP06_R7_EVIDENCE_COMPLETE' else None)
    wave.save('final/decision.json', decision)
    print(json.dumps({key: value for key, value in decision.items() if key != 'results'}), flush=True)
    return 0 if decision['status'].startswith('PASS_') else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--unit-browser', action='store_true')
    parser.add_argument('--validated-campaign', action='store_true')
    args = parser.parse_args()
    if args.unit_browser == args.validated_campaign:
        parser.error('choose exactly one action')
    wave = Wave(Path(__file__).resolve().parents[2]); wave.output = wave.root / OUTPUT
    with tempfile.TemporaryDirectory(prefix='nanika-r7-logs-') as temporary:
        wave.temp = Path(temporary)
        if args.unit_browser:
            unit_browser(wave); return 0
        return campaign_run(wave)


if __name__ == '__main__':
    raise SystemExit(main())
