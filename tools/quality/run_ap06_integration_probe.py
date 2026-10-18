"""AP-06-R8: authenticated control, real service, then the real Angular player."""
import argparse
from html.parser import HTMLParser
import json
import math
import os
from pathlib import Path
import statistics
import stat
import subprocess
import sys
import tempfile
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit

from run_readiness_wave1 import Wave, WaveFailure, campaign, owner
from run_ap06_transport_probe import media_server
from run_ap06_transmux_probe import CRYPTO, DOES_NOT, REPRODUCES, INCONCLUSIVE, PHASES, validate_raw
from run_ap06_orchestration_probe import checked_classification, individual_deltas
from ap06_authorities import checked_path

OUTPUT = '.quality/readiness-wave8'
VERSION = '151.0.7922.34'
CONDITIONS = ('r8.0', 'r8.1', 'r8.2')
AUTOPLAY = ['--autoplay-policy=no-user-gesture-required']
ALLOWED_EXISTING = {'.gitattributes', 'frontend/angular.json', 'frontend/tools/ap06-orchestration-probe.mjs',
    'frontend/tools/ap06-transmux-probe.mjs', 'tools/quality/run_ap06_transmux_probe.py',
    'tools/quality/run_ap06_transport_probe.py'}
ALLOWED_EXISTING.update({'frontend/experiments/ap06-r7/main.ts', 'frontend/experiments/ap06-r7/range-adapter.ts',
    'frontend/tools/ap06-integration-probe.mjs', 'frontend/tools/ap06-r7-instrumentation.mjs',
    'frontend/tools/ap06-angular-integration-check.mjs', 'frontend/tools/ap06-integration-probe.test.mjs',
    'tools/quality/run_ap06_integration_probe.py', 'tools/quality/test_run_ap06_integration_probe.py'})


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def audit_closed_pids(ids):
    if not ids or len(ids) > 64 or any(type(pid) is not int or pid <= 0 for pid in ids):
        raise WaveFailure('R8_INVALID_OWNED_PID_SET')
    command = '@(Get-Process -Id ' + ','.join(map(str, sorted(set(ids)))) + ' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) | ConvertTo-Json -Compress'
    output = subprocess.check_output(['powershell', '-NoProfile', '-Command', command], text=True).strip()
    alive = json.loads(output) if output else []
    if isinstance(alive, int): alive = [alive]
    return {'status': 'FAIL' if alive else 'PASS', 'ownedPids': sorted(set(ids)), 'aliveOwnedPids': alive}


def check_budget(budget, previous, requested):
    if (budget.get('approved') is not True or budget.get('measurementMaximum') != 6 or
            budget.get('measurementRetries') != 0 or type(previous) is not int or previous < 0 or
            type(requested) is not int or requested not in (1, 3) or previous + requested > 6):
        raise WaveFailure('R8_BROWSER_BUDGET_EXCEEDED')


def next_condition(condition, classification):
    if condition not in CONDITIONS:
        raise WaveFailure('INVALID_R8_CONDITION')
    if classification == REPRODUCES:
        return None if condition == 'r8.0' else ('formal', condition)
    if classification != DOES_NOT:
        return None
    index = CONDITIONS.index(condition)
    return ('triage', CONDITIONS[index + 1]) if index + 1 < len(CONDITIONS) else None


def claim_stage(output, condition, stage):
    if condition not in CONDITIONS or stage not in ('triage', 'formal') or condition == 'r8.0' and stage == 'formal':
        raise WaveFailure('INVALID_R8_STAGE')
    path = output / stage / condition
    try:
        path.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        raise WaveFailure('BLOCKED_EXISTING_R8_STAGE') from None
    return path


def build_products(root, output=OUTPUT):
    root = Path(root).resolve()
    r12r8 = Path(output).as_posix() in ('.quality/readiness-wave12-r8-factorial','.quality/readiness-wave12-r9-factorial','.quality/readiness-wave12-r9-native',
        '.quality/readiness-wave12-r10-factorial','.quality/readiness-wave12-r10-native',
        '.quality/readiness-wave12-r11-factorial','.quality/readiness-wave12-r11-native',
        '.quality/readiness-wave12-r12-factorial','.quality/readiness-wave12-r12-native')

    def fail(reason):
        raise WaveFailure('R12R9_APP_PRODUCTS_INVALID' if Path(output).name.startswith('readiness-wave12-r9-') else reason if r12r8 else 'R8_EXECUTABLE_BUNDLES_MISSING')

    app = root / output / 'tooling/app'
    if not r12r8:
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
            fail('R8_EXECUTABLE_BUNDLES_MISSING')
        return assets, products, workers

    browser = app / 'browser'
    try:
        checked_path(app.absolute())
        checked_path(browser.absolute())
        app_root = (root / output).resolve(strict=True)
        app_real = app.resolve(strict=True)
        browser_real = browser.resolve(strict=True)
        if not app_real.is_relative_to(app_root) or not browser_real.is_relative_to(app_real):
            fail('R12R8_APP_PRODUCTS_MISSING')
    except (OSError, ValueError):
        fail('R12R8_APP_PRODUCTS_MISSING')
    if not browser.is_dir():
        fail('R12R8_APP_PRODUCTS_MISSING')

    def regular_file(path):
        try:
            checked_path(path.absolute())
            info = path.lstat()
            return stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode) and not getattr(info, 'st_file_attributes', 0) & 0x400
        except (OSError, ValueError):
            return False

    for directory, directories, files in os.walk(browser, followlinks=False):
        for name in [*directories, *files]:
            try:
                checked_path((Path(directory) / name).absolute())
            except ValueError:
                fail('R12R8_APP_PRODUCTS_MISSING')

    index = browser / 'index.html'
    if not regular_file(index):
        fail('R12R8_APP_PRODUCTS_MISSING')
    stats_path = app / 'stats.json'
    if not regular_file(stats_path):
        fail('R12R8_APP_STATS_INVALID')
    try:
        stats = read(stats_path)
        outputs = stats.get('outputs')
        if not isinstance(outputs, dict) or not outputs or any(not isinstance(name, str) or not isinstance(data, dict) for name, data in outputs.items()):
            fail('R12R8_APP_STATS_INVALID')
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        fail('R12R8_APP_STATS_INVALID')

    def output_file(name):
        if not isinstance(name, str) or not name:
            fail('R12R8_APP_PRODUCTS_MISSING')
        relative = PurePosixPath(name)
        if not relative.parts or relative.is_absolute() or any(part in ('', '.', '..') for part in relative.parts) or '\\' in name or ':' in name:
            fail('R12R8_APP_PRODUCTS_MISSING')
        parts = relative.parts[1:] if relative.parts[0] == 'browser' else relative.parts
        if not parts:
            fail('R12R8_APP_PRODUCTS_MISSING')
        path = browser.joinpath(*parts)
        if not regular_file(path):
            fail('R12R8_APP_PRODUCTS_MISSING')
        try:
            if not path.resolve(strict=True).is_relative_to(browser.resolve(strict=True)):
                fail('R12R8_APP_PRODUCTS_MISSING')
        except OSError:
            fail('R12R8_APP_PRODUCTS_MISSING')
        return path

    class BundleReferences(HTMLParser):
        def __init__(self):
            super().__init__();self.paths=[]
        def handle_starttag(self,tag,attrs):
            attribute='src' if tag=='script' else 'href' if tag=='link' else None
            reference=dict(attrs).get(attribute) if attribute else None
            if isinstance(reference,str):
                url=urlsplit(reference)
                if not url.scheme and not url.netloc and PurePosixPath(url.path).suffix in ('.js','.css'):
                    self.paths.append(unquote(url.path).lstrip('/'))
        def handle_startendtag(self,tag,attrs):self.handle_starttag(tag,attrs)

    try:
        references=BundleReferences();references.feed(index.read_text(encoding='utf-8'))
    except (OSError,UnicodeError):
        fail('R12R8_APP_PRODUCTS_MISSING')
    for name in references.paths:output_file(name)

    for name in outputs:
        if name.endswith(('.js', '.css')):
            if name.endswith('.css') and outputs[name].get('ng-component') is True:
                continue  # Angular records component CSS that it embeds in the JavaScript bundle.
            output_file(name)

    assets = {'/': (index, 'text/html; charset=utf-8')}
    for path in browser.iterdir():
        if path.suffix in ('.js', '.css'):
            if not regular_file(path):
                fail('R12R8_APP_PRODUCTS_MISSING')
            assets['/' + path.name] = (path, 'text/javascript' if path.suffix == '.js' else 'text/css')
    products = {path.relative_to(root).as_posix(): campaign.sha256_file(path) for path, _ in assets.values()}
    workers = {}
    for name, data in outputs.items():
        entry = data.get('entryPoint', '')
        for kind in ('crypto', 'transmux'):
            if isinstance(entry, str) and entry.endswith(f'/stream-{kind}.worker.ts'):
                if kind in workers:
                    fail('R12R8_WORKER_PRODUCTS_INVALID')
                path = output_file(name)
                digest = campaign.sha256_file(path)
                if not isinstance(digest, str) or len(digest) != 64:
                    fail('R12R8_WORKER_PRODUCTS_INVALID')
                workers[kind] = {'path': path.relative_to(root).as_posix(), 'name': name, 'sha256': digest}
    if set(workers) != {'crypto', 'transmux'}:
        fail('R12R8_WORKER_PRODUCTS_INVALID')
    return assets, products, workers


def verify_authorities(root):
    baseline = read(root / OUTPUT / 'baseline/authority-snapshot.local.json')
    for path, expected in baseline['protectedFiles'].items():
        if path not in ALLOWED_EXISTING and campaign.sha256_file(root / path) != expected:
            raise WaveFailure('R8_PRODUCTION_OR_HISTORY_CHANGED')
    original, r6 = root.with_name('SaveBox2'), root.with_name('SaveBox2-ap06-r6')
    for values, directory in [(baseline['originalHistories'], original), (baseline['r6Artifacts'], r6)]:
        for path, expected in values.items():
            if campaign.sha256_file(directory / path) != expected:
                raise WaveFailure('R8_HISTORICAL_AUTHORITY_CHANGED')
    for path, expected in baseline['priorR7Artifacts'].items():
        if campaign.sha256_file(root.with_name('SaveBox2-ap06-r7') / path) != expected:
            raise WaveFailure('R8_ORIGINAL_CAMPAIGN_CHANGED')
    old_config = json.loads(Wave(root).git('show', baseline['baseHead'] + ':frontend/angular.json'))
    if read(root / 'frontend/angular.json')['projects']['frontend'] != old_config['projects']['frontend']:
        raise WaveFailure('R8_NORMAL_APP_CONFIGURATION_CHANGED')
    return baseline


def verify_freeze(root, freeze):
    for path, expected in freeze['files'].items():
        if campaign.sha256_file(root / path) != expected:
            raise WaveFailure('R8_FROZEN_SOURCE_OR_FIXTURE_CHANGED')
    verify_authorities(root)


def expected_source_buffers(fixtures, cycle):
    if ([row.get('id') for row in fixtures] != [0, 1, 2] or
            [[track.get('type') for track in row.get('tracks', [])] for row in fixtures] !=
            [['video', 'audio'], ['video'], ['video', 'audio']]):
        raise WaveFailure('R8_INVALID_FIXTURE_COHORT')
    # Frozen handleTransmuxReady emits one multiplexed initData item (id=0) per fixture.
    return cycle * len(fixtures)


def validate_condition(raw, condition, stage, freeze, fixtures):
    return validate_integration_condition(raw, condition, stage, freeze, fixtures,
        {'r8.0': 'component', 'r8.1': 'store', 'r8.2': 'backend'}[condition])


def validate_integration_condition(raw, condition, stage, freeze, fixtures, mode, direct_fetch=False, expected_runs=None):
    expected_source_buffers(fixtures, 0)
    if freeze.get('multiplexedContract') != {'fixtureHash': freeze['fixtureHash'],
            'workerHashes': {kind: row['sha256'] for kind, row in freeze['workers'].items()},
            'initDataPerFixture': [1, 1, 1], 'initDataId': 0}:
        raise WaveFailure('R8_MULTIPLEXED_CONTRACT_NOT_VERIFIED')
    identities = {'playwrightRoutingInstalled': True, 'fetchInterceptionInstalled': False,
        'videoStreamServiceUsed': True, 'angularOrBackendUsed': True,
        'videoPlayerComponentUsed': True, 'backendUsed': mode == 'backend',
        'localRequestsIntercepted': False, 'fullKasumiContainer': True}
    validate_raw(raw, stage, CRYPTO, freeze['sourceHash'], freeze['fixtureHash'], freeze['harnessHash'],
        freeze['runnerHash'], VERSION, control_lifecycle=False, identity_expectations=identities, expected_runs=expected_runs)
    if raw.get('condition') != condition or raw.get('autoplayArgs') != AUTOPLAY:
        raise WaveFailure('R8_CONDITION_OR_PROTOCOL_CHANGED')
    if raw.get('driveStoreUsed') is not (mode != 'component'):
        raise WaveFailure('R8_STORE_BOUNDARY_CHANGED')
    if mode == 'backend' and (raw.get('backendAuthoritySha256') != freeze['backendAuthoritySha256'] or
            raw.get('backendFileMapping') != freeze['backendFileMapping']):
        raise WaveFailure('R8_BACKEND_AUTHORITY_CHANGED')
    if raw.get('experimentalAppProducts') != freeze['appProducts'] or raw.get('pageScriptSha256') != freeze['pageScriptSha256']:
        raise WaveFailure('R8_EXECUTED_APP_OR_PAGE_SCRIPT_CHANGED')
    identities = [{key: fixture[key] for key in ('id', 'name', 'bytes', 'sha256')} for fixture in fixtures]
    if raw.get('fixtureIdentities') != identities:
        raise WaveFailure('R8_FIXTURE_IDENTITIES_CHANGED')
    if (raw.get('workerBundleSha256') != freeze['workers']['transmux']['sha256'] or
            raw.get('cryptoWorkerBundleSha256') != freeze['workers']['crypto']['sha256']):
        raise WaveFailure('R8_EXECUTED_WORKER_IDENTITY_CHANGED')
    network = raw.get('network', {})
    if any(network.get(key) != 0 for key in ('rejectedRequests', 'externalRequests', 'unexpectedRequests')) or raw.get('pageErrors') != 0 or raw.get('recoveryWarnings') != 0:
        raise WaveFailure('R8_NETWORK_OR_RECOVERY_PROTOCOL_INVALID')
    requested_workers = network.get('workerRequests', {})
    allowed_workers = {row['name'] for row in freeze['workers'].values()}
    if set(requested_workers) - allowed_workers or any(requested_workers.get(name, 0) == 0 for name in allowed_workers):
        raise WaveFailure('R8_ACTUAL_WORKER_URLS_NOT_VERIFIED')
    for run in raw['runs']:
        pids = sorted({row['pid'] for sample in run['samples'] for row in sample['processMemory']['processes']})
        if run.get('processExitAudit') != {'status': 'PASS', 'ownedPids': pids, 'aliveOwnedPids': []}:
            raise WaveFailure('R8_OWNED_CHROMIUM_NOT_VERIFIED_CLOSED')
        for sample in run['samples']:
            cycle = sample['cycle']; sessions = cycle * 3
            process = sample['processMemory']
            if process.get('status') != 'AVAILABLE' or not process.get('processes') or any(type(row.get('pid')) is not int or row['pid'] <= 0 for row in process['processes']):
                raise WaveFailure('R8_PROCESS_IDENTITY_MISSING')
            for kind in ('browser', 'renderer'):
                value = process.get('byCategory', {}).get(kind, {}).get('privateBytes')
                if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                    raise WaveFailure('R8_PROCESS_METRIC_INVALID')
            if sample.get('workerBundleHash') != freeze['workers']['transmux']['sha256'] or sample.get('cryptoWorkerBundleHash') != freeze['workers']['crypto']['sha256']:
                raise WaveFailure('R8_SAMPLE_WORKER_IDENTITY_CHANGED')
            c = sample['counters'].get('observed', {})
            components = sessions * 2
            buffers = expected_source_buffers(fixtures, cycle)
            expected = {'initializeAttempts': sessions, 'initializeSettled': sessions, 'playbackStarted': sessions,
                'playbackCompleted': sessions, 'destroyCalls': sessions, 'componentsMounted': components,
                'componentsDestroyed': components, 'metadataRequests': sessions, 'workersCreated': sessions * 2,
                'workersTerminated': sessions * 2, 'mediaSourcesCreated': sessions, 'mediaSourcesClosed': sessions,
                'sourceBuffersCreated': buffers, 'sourceBuffersReleased': buffers}
            if any(c.get(key) != value for key, value in expected.items()):
                raise WaveFailure('R8_OBSERVED_LIFECYCLE_INCOMPLETE')
            store_used, backend_used = int(mode != 'component'), int(mode == 'backend')
            expected_r8 = {'storeLoadStarted': store_used, 'storeLoadCompleted': store_used,
                'storeEffectsSettled': store_used, 'storeFileResolved': sessions * store_used,
                'authAttempts': backend_used, 'authSuccesses': backend_used,
                'backendFileIdMatches': sessions * backend_used, 'outstandingSubscriptions': 0,
                'unexpectedPeripheralOperations': 0,
                'http206Validated': c.get('rangeRequestsCompleted') if backend_used else 0,
                'jwtRangesValidated': c.get('rangeRequestsStarted') if backend_used and not direct_fetch else 0}
            if any(c.get(key) != value for key, value in expected_r8.items()):
                raise WaveFailure('R8_STORE_AUTH_OR_HTTP_CONTRACT_INVALID')
            if any(c.get(key) != 0 for key in ('initializeFailures', 'playbackFailures', 'rangeRequestsFailed',
                    'rangeRequestsAborted', 'workerErrors', 'transferFailures', 'unhandledRejections',
                    'pendingOperations', 'pendingAppends', 'activeRanges', 'timersLive', 'experimentalListeners')):
                raise WaveFailure('R8_FUNCTIONAL_OR_SETTLEMENT_FAILED')
            if c.get('rangeRequestsStarted') != c.get('rangeRequestsCompleted') or c.get('workerMessagesSent') != c.get('workerMessagesReceived') or c.get('workerMessagesCancelled') != 0:
                raise WaveFailure('R8_NATIVE_OPERATIONS_NOT_DRAINED')
            if sessions and (c.get('bytesAppended', 0) <= 0 or c.get('detachedTransfers', 0) <= 0):
                raise WaveFailure('R8_REAL_MEDIA_OR_TRANSFERS_NOT_OBSERVED')
            rows = sample['counters'].get('sessions', [])
            if len(rows) != sessions or [row.get('fixture') for row in rows] != list(range(3)) * cycle:
                raise WaveFailure('R8_SESSION_IDENTITIES_INCOMPLETE')
            selected = mode
            for row in rows:
                times = [row.get(key) for key in ('mountedMs', 'canplayMs', 'playbackMs', 'closeMs', 'maxCurrentTime')]
                if (row.get('mode') != selected or any(type(value) not in (int, float) or not math.isfinite(value) for value in times) or
                        not times[0] <= times[1] <= times[3] or not times[0] <= times[2] <= times[3] or
                        not 1.5 < times[4] < 10 or row.get('seeks') != 0 or row.get('muted') is not False or
                        row.get('volume') != 1 or row.get('playbackRate') != 1):
                    raise WaveFailure('R8_PLAYBACK_TIMING_OR_TRIGGER_INVALID')
    individual = individual_deltas(raw)
    natural = next(row for row in raw['summary']['phases'] if row.get('phase') == 'cycle-6-close' and row.get('gc') == 'natural')
    for kind in ('browser', 'renderer'):
        values = [row[kind + 'DeltaMiB'] * 1048576 for row in individual]
        recorded = natural['processTypes'][kind]['privateBytes']['signedDelta']
        if any(recorded.get(key) != value for key, value in [('min', min(values)), ('median', statistics.median(values)), ('max', max(values))]):
            raise WaveFailure('R8_SUMMARY_DISAGREES_WITH_RAW')
    return checked_classification(raw['summary'])


def environment(wave, directory, condition='r8.0', stage='triage', freeze=None, output=OUTPUT):
    assets, products, workers = build_products(wave.root, output)
    manifest = wave.output / 'fixtures/manifest.json'
    env = dict(wave.env, AP06_R5_MODE=CRYPTO, AP06_R5_STAGE=stage, AP06_R5_ARTIFACT_DIR=str(directory),
        AP06_R5_FIXTURE_MANIFEST=str(manifest), AP06_R5_CHROMIUM_VERSION=VERSION, AP06_R6_CONDITION=condition,
        AP06_R7_ALLOWED_PATHS=json.dumps(list(assets) + [f'/video-{n}.mp4' for n in range(3)]),
        AP06_R7_APP_PRODUCTS=json.dumps(products), AP06_R8_PRIVATE_CONFIG=str(wave.output / 'baseline/player-auth.local.json'),
        AP06_R8_PID_AUDITOR=str(wave.root / 'tools/quality/run_ap06_integration_probe.py'),
        WAVE1_PYTHON=sys.executable, WAVE1_RUNNER=str(wave.root / 'tools/quality/run_readiness_wave1.py'))
    for kind, value in workers.items():
        env['AP06_R5_' + kind.upper() + '_WORKER'] = str(wave.root / value['path'])
        env['AP06_R5_' + kind.upper() + '_WORKER_SHA256'] = value['sha256']
    if freeze:
        env.update(AP06_R5_SOURCE_HASH=freeze['sourceHash'], AP06_R5_HARNESS_HASH=freeze['harnessHash'], AP06_R5_RUNNER_SHA256=freeze['runnerHash'])
        env.update(AP06_R8_BACKEND_AUTHORITY_SHA256=freeze['backendAuthoritySha256'],
            AP06_R8_FILE_MAPPING=json.dumps(freeze['backendFileMapping']))
    if condition == 'r8.2' or freeze is None:
        authority = read(wave.output / 'baseline/backend-authority.json')
        api = authority['backendOrigin']
        allowed = json.loads(env['AP06_R7_ALLOWED_PATHS'])
        allowed += [api + path for path in ['/login', '/tree?file_limit=100&file_offset=0', '/pending-uploads']]
        allowed += [api + f"/files/{row['fileId']}/download" for row in authority['fileMapping']]
        env['AP06_R7_ALLOWED_PATHS'] = json.dumps(allowed)
    return env, assets


def unit_browser(wave):
    if (wave.output / 'tooling/freeze.json').exists():
        raise WaveFailure('R8_UNIT_BROWSER_AFTER_FREEZE_FORBIDDEN')
    attempt = len(list((wave.output / 'tooling').glob('angular-unit-*.json'))) + 1
    target = wave.output / f'tooling/angular-unit-{attempt}.json'
    env, assets = environment(wave, wave.output / 'tooling')
    env['AP06_R7_UNIT_OUTPUT'] = str(target)
    files = {f'/video-{n}.mp4': wave.output / f'fixtures/cipher/video-{n}.bin' for n in range(3)}
    with media_server(files, True, 'application/octet-stream', assets, port=42088) as (origin, stats):
        env['AP06_R5_MEDIA_ORIGIN'] = origin
        wave.command(f'angular-unit-{attempt}', [wave.node, 'tools/ap06-angular-integration-check.mjs'], wave.root / 'frontend', env)
        wave.save(f'pipeline/angular-unit-{attempt}-transport.json', stats)
    result = read(target)
    if result['status'] != 'PASS':
        raise WaveFailure('R8_ANGULAR_UNIT_FAILED')
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
    with media_server(files, True, 'application/octet-stream', assets, port=42088) as (origin, stats):
        env['AP06_R5_MEDIA_ORIGIN'] = origin
        try:
            wave.command(stage + '-' + condition, [wave.node, 'tools/ap06-integration-probe.mjs'], wave.root / 'frontend', env)
        except WaveFailure as error:
            command_error = error
        raw_path = directory / (CRYPTO + '.raw.json')
        if not raw_path.exists():
            raise command_error or WaveFailure('R8_RAW_MISSING')
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
        raise WaveFailure('BLOCKED_R8_READINESS_NOT_VALIDATED')
    if freeze.get('status') != 'FROZEN' or (wave.output / 'pipeline/campaign-started.json').exists() or (wave.output / 'pipeline/launch-ledger.json').exists():
        raise WaveFailure('BLOCKED_R8_CAMPAIGN_NOT_FRESH')
    verify_freeze(wave.root, freeze)
    check_budget(read(wave.output / 'baseline/budget.json'), 0, 1)
    with (wave.output / 'pipeline/campaign-started.json').open('x', encoding='utf-8') as file:
        json.dump({'measurementRetries': 0, 'implementationHead': freeze['implementationHead']}, file)
    ledger, results = [], []
    decision = {'status': 'BLOCKED_AP06_R8_INVALID_MEASUREMENT', 'ap06': 'OPEN', 'results': results}
    condition, stage = 'r8.0', 'triage'
    try:
        while True:
            print(json.dumps({'stage': stage, 'condition': condition, 'state': 'STARTED'}), flush=True)
            result = measure(wave, condition, stage, freeze, ledger); results.append(result)
            print(json.dumps({'stage': stage, 'condition': condition, 'classification': result['classification']}), flush=True)
            if condition == 'r8.0' and result['classification'] != DOES_NOT:
                decision['status'] = 'BLOCKED_AP06_R8_INVALID_CONTROL'; break
            if stage == 'formal':
                confirmed = all(row['classification'] == REPRODUCES for row in result['individualRuns'])
                decision['status'] = ('PASS_AP06_R8_STORE_BOUNDARY_REPRODUCED' if condition == 'r8.1' else 'PASS_AP06_R8_BACKEND_BOUNDARY_REPRODUCED') if confirmed else 'BLOCKED_AP06_R8_FORMAL_DISAGREEMENT'
                break
            following = next_condition(condition, result['classification'])
            if following is None:
                decision['status'] = 'PASS_AP06_R8_EVIDENCE_COMPLETE' if result['classification'] == DOES_NOT else 'BLOCKED_AP06_R8_INVALID_MEASUREMENT'
                break
            stage, condition = following
    except Exception as error:
        decision.update(status='BLOCKED_AP06_R8_INVALID_CONTROL' if condition == 'r8.0' else 'BLOCKED_AP06_R8_INVALID_MEASUREMENT',
            condition=condition, stage=stage, failureClass=str(error) if isinstance(error, WaveFailure) else type(error).__name__)
    decision.update(browserLaunches=sum(row['browserLaunches'] for row in ledger), launchAttempts=sum(row['launchAttempts'] for row in ledger),
        processSamples=sum(row.get('processSampleCalls', 0) for row in ledger), retries=0,
        nextBoundary='FULL_HISTORICAL_WAVE3_APPLICATION_REPRODUCTION' if decision['status'] == 'PASS_AP06_R8_EVIDENCE_COMPLETE' else None)
    wave.save('final/decision.json', decision)
    print(json.dumps({key: value for key, value in decision.items() if key != 'results'}), flush=True)
    return 0 if decision['status'].startswith('PASS_') else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--unit-browser', action='store_true')
    parser.add_argument('--validated-campaign', action='store_true')
    parser.add_argument('--closed-pids')
    args = parser.parse_args()
    if args.closed_pids:
        result = audit_closed_pids([int(value) for value in args.closed_pids.split(',')])
        print(json.dumps(result)); return 0 if result['status'] == 'PASS' else 1
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
