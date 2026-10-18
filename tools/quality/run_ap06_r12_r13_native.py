"""Bounded R12-R13 MemoryInfra parser entrypoint and independent capability runner."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from ap06_authorities import checked_path, private_permissions, sha256, verify_publication
from ap06_native import PHASES, aggregate_trace, trace_events
from prepare_ap06_r12_r13 import NATIVE_BUDGET, OUTPUT, CAMPAIGN, prepare, verify_historical_factorial
from run_readiness_wave1 import Wave, WaveFailure
from run_ap06_r9 import (freeze_implementation, publish, validate_freeze_readiness,
    verify_freeze, CRYPTO)
from ap06_freeze import (NATIVE_FILES, load_native_budget, native_source_files,
    validate_native_build_authority, verify_freeze_completion)

TASK_PATH = 'quality/ap06-r12-r13.md'
RUNNER_PATH = Path(__file__).resolve()


class NativeContractFailure(ValueError):
    """Explicit contract failure for native execution."""
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


def campaign_tag():
    parts = CAMPAIGN.split('-')
    return parts[3].upper() if len(parts) > 3 else 'R13'


def configure_campaign(campaign, output, task_path, runner_path=None):
    global CAMPAIGN, OUTPUT, TASK_PATH, RUNNER_PATH, COMPLETED_STATUSES
    CAMPAIGN = campaign
    OUTPUT = output
    TASK_PATH = task_path
    if runner_path:
        RUNNER_PATH = runner_path
    tag = campaign_tag()
    COMPLETED_STATUSES = frozenset({
        'PASS',
        'NATIVE_CAPABILITY_PASS',
        f'R12{tag}_NATIVE_TRACKED_AGGREGATES_OBSERVED',
        f'R12{tag}_NATIVE_ALLOCATION_COVERAGE_INSUFFICIENT',
        f'R12{tag}_NATIVE_CAPABILITY_INCONCLUSIVE',
    })


def require(value, reason):
    if not value:
        raise ValueError(reason)


def validate_trace(path, receipt_path, *, synthetic=False):
    path = checked_path(Path(os.path.abspath(path)))
    receipt_path = checked_path(Path(os.path.abspath(receipt_path)))
    if synthetic:
        temp_root = Path(os.path.abspath(tempfile.gettempdir()))
        require(path.is_relative_to(temp_root) and receipt_path.is_relative_to(temp_root) and
            path.stat().st_size <= 1024 * 1024, 'R12R13_SYNTHETIC_TRACE_PATH_INVALID')
    else:
        root = receipt_path.parent.parent
        tag = campaign_tag()
        require(receipt_path.is_relative_to(root), f'R12{tag}_RECEIPT_PATH_INVALID')
        config_path = root / 'baseline/authority-config.local.json'
        if config_path.is_file():
            config = json.loads(config_path.read_text(encoding='utf-8-sig'))
            authority = checked_path(Path(config['AP06_AUTHORITY_ROOT']))
            require(path.is_relative_to(authority), f'R12{tag}_TRACE_PATH_INVALID')
        else:
            require(path.is_relative_to(root / 'authority'), f'R12{tag}_TRACE_PATH_INVALID')
        private_permissions(path.parent)
    require(path.is_file() and path.stat().st_size <= 512 * 1024 * 1024, 'R12R13_TRACE_SIZE_INVALID')
    receipt = json.loads(receipt_path.read_text(encoding='utf-8-sig'))
    trace = dict(receipt.get('trace', receipt))
    if receipt is not trace:
        for k, v in receipt.items():
            if k not in trace and k != 'trace':
                trace[k] = v
    digest = sha256(path)
    require(trace.get('bytes') == path.stat().st_size and trace.get('sha256') == digest,
        'R12R13_TRACE_CHECKSUM_INVALID')
    try:
        with path.open(encoding='utf-8') as stream:
            result = aggregate_trace(trace_events(stream), trace, detailed=True)
    except (UnicodeError, ValueError, OSError):
        result = {'status': 'NATIVE_STOP', 'reason': 'NATIVE_TRACE_SCHEMA_INVALID'}
    if result.get('status') == 'NATIVE_CAPABILITY_PASS':
        result['heapProfilingEffective'] = True
    return {**result, 'traceSha256': digest, 'traceBytes': path.stat().st_size}


def validate_budget(budget, expected=NATIVE_BUDGET):
    require(isinstance(budget, dict) and budget.get('approved') is True and
        set(budget.keys()) == {'approved', 'approvedByTaskSha256', *expected.keys()} and
        all(type(budget.get(key)) is int and budget[key] == value for key, value in expected.items()),
        'R12R13_NATIVE_BUDGET_INVALID')


def configure_native(source):
    import run_ap06_r12_r2 as factorial
    import run_ap06_r12_r2_native as native
    factorial.configure_campaign('.quality/readiness-wave12-r12-factorial', RUNNER_PATH,
        'AP-06-R12-R12-factorial')
    native.OUTPUT, native.PUBLISHER, native.CAMPAIGN = OUTPUT, RUNNER_PATH, CAMPAIGN
    native.TRACE_PREFIX = CAMPAIGN.lower().replace('ap-06-', '')
    native.FACTORIAL, native.FACTORIAL_STATUS = str(source), 'R12R12_FACTORIAL_CONFIRMED'
    return native


def verify_frozen_campaign(wave, source):
    frozen_path = wave.output / 'tooling/freeze.json'
    tag = campaign_tag()
    require(frozen_path.is_file(), f'R12{tag}_FREEZE_MISSING')
    frozen = json.loads(frozen_path.read_text(encoding='utf-8'))
    head = wave.git('rev-parse', 'HEAD').strip()
    require(wave.git('status', '--porcelain').strip() == '' and frozen.get('implementationHead') == head,
        f'R12{tag}_FROZEN_HEAD_CHANGED')
    verify_freeze(wave, frozen)
    verify_freeze_completion(wave, frozen)
    historical = verify_historical_factorial(source, wave.root)
    gate = json.loads((wave.output / 'baseline/historical-factorial-gate.json').read_text(encoding='utf-8'))
    require(gate.get('status') == 'PASS' and historical['decisionSha256'] == gate['decisionSha256'] and
        historical['freezeSha256'] == gate['freezeSha256'] and historical['pair'] == ['r12r2.0', 'r12r2.2'],
        f'R12{tag}_HISTORICAL_GATE_CHANGED')
    tests = json.loads((wave.output / 'baseline/tests.json').read_text(encoding='utf-8'))
    from ap06_freeze import validate_test_receipt
    validate_test_receipt(wave.output, tests)
    ci = json.loads((wave.output / 'baseline/ci.json').read_text(encoding='utf-8'))
    require(ci.get('status') == 'PASS' and ci.get('headSha') == head and isinstance(ci.get('jobs'), list) and
        len(ci['jobs']) >= 4 and all(job.get('conclusion') == 'success' for job in ci['jobs']),
        f'R12{tag}_CI_NOT_GREEN_ON_FROZEN_HEAD')
    quality = json.loads((wave.output / 'baseline/quality-baseline-ci.json').read_text(encoding='utf-8'))
    require(quality.get('status') == 'PASS' and quality.get('headSha') == head,
        f'R12{tag}_QUALITY_CI_NOT_GREEN_ON_FROZEN_HEAD')
    return frozen

verify_frozen_r13 = verify_frozen_campaign


def run_capability(wave, source):
    output = wave.output
    tag = campaign_tag()
    require(not any((output / path).exists() for path in ('pipeline/capability-reservation.json',
        'final/STOP.json', 'final/decision.json')), f'R12{tag}_NATIVE_NO_RETRY_OR_RESUME')
    task_hash = sha256(output / 'baseline/task.md') if (output / 'baseline/task.md').is_file() else None
    load_native_budget(output / 'baseline/native-budget.json', NATIVE_BUDGET, task_hash)
    frozen = verify_frozen_campaign(wave, source)
    native = configure_native(source)
    reservation = output / 'pipeline/capability-reservation.json'
    with reservation.open('x', encoding='utf-8') as stream:
        json.dump({'campaign': CAMPAIGN, 'maximum': 1, 'retries': 0,
            'implementationHead': frozen['implementationHead']}, stream)
    publish(wave, 'capability-reserved', {'evidence/capability-reservation.json': reservation})
    receipt_path = output / 'pipeline/native-receipt.json'
    env, _ = native.environment(wave, output / 'pipeline', 'r12r2.0', stage='capability', freeze=frozen)
    env.update(AP06_NATIVE_RECEIPT=str(receipt_path), WAVE1_PYTHON=sys.executable,
        AP06_IDENTITY_PYTHON=sys.executable, AP06_R8_PID_AUDITOR=str(wave.root / 'tools/quality/run_ap06_integration_probe.py'),
        AP06_SCIENTIFIC_CAMPAIGN=CAMPAIGN)
    trace_label = CAMPAIGN.lower().replace('ap-06-', '')
    wave.command(f'{trace_label}-capability', [wave.node, 'tools/ap06-native-capability.mjs'],
        wave.root / 'frontend', env)
    native.seal_trace(wave, receipt_path)
    record = json.loads(receipt_path.read_text(encoding='utf-8'))
    require(record.get('launchAttempts') == record.get('browserLaunches') == 1 and record.get('retries') == 0 and
        record.get('browserClosed') is True and record.get('processExitAudit', {}).get('status') == 'PASS',
        f'R12{tag}_NATIVE_CAPABILITY_LIFECYCLE_FAILED')
    from run_ap06_r12_r2 import validate_browser_receipt
    validate_browser_receipt(record, json.loads((output / 'baseline/browser-identity.json').read_text(encoding='utf-8')),
        native=True, process_samples=record.get('processSamples', ()))
    registration = json.loads((output / 'pipeline/native-trace.json').read_text(encoding='utf-8'))
    trace_path = checked_path(Path(json.loads((output / 'baseline/authority-config.local.json').read_text())[
        'AP06_AUTHORITY_ROOT']) / registration['authorityRelativePath'])
    capability = validate_trace(trace_path, receipt_path)
    wave.save('baseline/native-capability.json', capability)
    publish(wave, 'capability-complete', {'evidence/capability-receipt.json': receipt_path,
        'evidence/capability.json': output / 'baseline/native-capability.json'})
    status = capability.get('status')
    if status == 'NATIVE_CAPABILITY_PASS':
        return run_profiled_pair(wave, source, frozen, native)
    if status == 'NATIVE_INCONCLUSIVE':
        return publish_inconclusive_decision(wave, capability)
    if status == 'NATIVE_STOP':
        raise NativeContractFailure(capability.get('reason', 'NATIVE_TRACE_CONTRACT_INVALID'))
    raise ValueError('NATIVE_CAPABILITY_STATUS_INVALID')


def classify_native_aggregate(aggregate):
    if not isinstance(aggregate, dict):
        raise NativeContractFailure('NATIVE_AGGREGATE_INVALID')
    status = aggregate.get('status')
    if status == 'NATIVE_CAPABILITY_PASS':
        return 'PASS'
    if status == 'NATIVE_INCONCLUSIVE':
        return 'INCONCLUSIVE'
    if status == 'NATIVE_STOP':
        reason = aggregate.get('reason')
        raise NativeContractFailure(reason if isinstance(reason, str) and
            re.fullmatch(r'[A-Z][A-Z0-9_:]+', reason) else 'NATIVE_TRACE_CONTRACT_INVALID')
    raise NativeContractFailure('NATIVE_AGGREGATE_STATUS_INVALID')


def expected_decision_launches(decision):
    if not isinstance(decision, dict):
        raise NativeContractFailure('NATIVE_DECISION_INVALID')
    tag = campaign_tag()
    status = decision.get('status')
    rows = decision.get('results', [])
    if status == f'R12{tag}_NATIVE_CAPABILITY_INCONCLUSIVE':
        if decision.get('abAuthorized') is not False or rows != []:
            raise NativeContractFailure('NATIVE_DECISION_RESULTS_INVALID')
        conditions = []
    elif status == f'R12{tag}_NATIVE_ALLOCATION_COVERAGE_INSUFFICIENT':
        if decision.get('abAuthorized') is not False or not isinstance(rows, list) or len(rows) not in (1, 2):
            raise NativeContractFailure('NATIVE_DECISION_RESULTS_INVALID')
        conditions = ['r12r2.0', 'r12r2.2'][:len(rows)]
        aggregate_statuses = ['NATIVE_INCONCLUSIVE'] if len(rows) == 1 else [
            'NATIVE_CAPABILITY_PASS', 'NATIVE_INCONCLUSIVE']
    elif status == f'R12{tag}_NATIVE_TRACKED_AGGREGATES_OBSERVED':
        if decision.get('abAuthorized') is not True or not isinstance(rows, list) or len(rows) != 2:
            raise NativeContractFailure('NATIVE_DECISION_RESULTS_INVALID')
        conditions = ['r12r2.0', 'r12r2.2']
        aggregate_statuses = ['NATIVE_CAPABILITY_PASS', 'NATIVE_CAPABILITY_PASS']
    else:
        raise NativeContractFailure('NATIVE_DECISION_STATUS_INVALID')

    if conditions:
        for row, condition, aggregate_status in zip(rows, conditions, aggregate_statuses):
            if (not isinstance(row, dict) or row.get('condition') != condition or
                    not isinstance(row.get('native'), dict) or
                    row['native'].get('status') != aggregate_status):
                raise NativeContractFailure('NATIVE_DECISION_RESULTS_INVALID')
    elif isinstance(rows, list) and rows:
        raise NativeContractFailure('NATIVE_DECISION_RESULTS_INVALID')
    return {'capabilityChromium': 1, 'measurementChromium': len(conditions),
        'retries': 0, 'total': 1 + len(conditions), 'measurementConditions': conditions}


def _decision_consumption(state):
    capability = state.get('capabilityChromium', 0) if state.get('capabilityVerified', True) else 'UNVERIFIED'
    measurement = state.get('measurementChromium', 0) if state.get('measurementVerified', True) else 'UNVERIFIED'
    retries = state.get('retries', 0) if not state.get('unverifiedConsumption') else 'UNVERIFIED'
    return capability, measurement, retries


def publish_inconclusive_decision(wave, capability):
    output = wave.output
    tag = campaign_tag()
    cleanup = stop_and_verify_backend_cleanup(wave)
    if cleanup.get('status') != 'PASS':
        raise NativeContractFailure(f"BACKEND_CLEANUP_{cleanup.get('status', 'FAILED')}")
    capability_chromium, measurement_chromium, retries = _decision_consumption(execution_state(output))
    decision = {
        'status': f'R12{tag}_NATIVE_CAPABILITY_INCONCLUSIVE',
        'reason': capability.get('reason', 'NATIVE_TRACE_CONTRACT_INVALID'),
        'capabilityChromium': capability_chromium,
        'measurementChromium': measurement_chromium,
        'retries': retries,
        'abAuthorized': False,
        'cleanupStatus': cleanup.get('status'),
        'interpretation': 'No A/B measurement without four correlated renderer heaps_v2 dumps.',
    }
    validate_decision_consumption(output, decision)
    wave.save('final/decision.json', decision)
    publish(wave, 'decision', {'evidence/decision.json': output / 'final/decision.json'})
    return decision


def publish_coverage_decision(wave, results, reason=None):
    output = wave.output
    tag = campaign_tag()
    cleanup = stop_and_verify_backend_cleanup(wave)
    if cleanup.get('status') != 'PASS':
        raise NativeContractFailure(f"BACKEND_CLEANUP_{cleanup.get('status', 'FAILED')}")
    capability_chromium, measurement_chromium, retries = _decision_consumption(execution_state(output))
    decision = {
        'status': f'R12{tag}_NATIVE_ALLOCATION_COVERAGE_INSUFFICIENT',
        'reason': reason or 'NATIVE_ALLOCATION_COVERAGE_INSUFFICIENT',
        'capabilityChromium': capability_chromium,
        'measurementChromium': measurement_chromium,
        'retries': retries,
        'abAuthorized': False,
        'results': results,
        'cleanupStatus': cleanup.get('status'),
        'causalAttribution': 'Exploratory and conditional on R12R12; sampled aggregates do not establish total coverage, individual lifetimes, or a leak.',
    }
    validate_decision_consumption(output, decision)
    wave.save('final/decision.json', decision)
    publish(wave, 'decision', {'evidence/decision.json': output / 'final/decision.json'})
    return decision


def run_profiled_pair(wave, source, frozen, native):
    import run_ap06_r12_r2_native as native_runner
    from run_ap06_r9 import measure
    tag = campaign_tag()

    def budget_check(_budget, previous, requested):
        task_hash = sha256(wave.output / 'baseline/task.md') if (wave.output / 'baseline/task.md').is_file() else None
        load_native_budget(wave.output / 'baseline/native-budget.json', NATIVE_BUDGET, task_hash)
        require(type(previous) is int and previous in (0, 1) and requested == 1,
            f'R12{tag}_NATIVE_BUDGET_EXCEEDED')

    def verify(_wave, _frozen):
        require(verify_frozen_campaign(wave, source) == frozen, f'R12{tag}_FREEZE_CHANGED_DURING_MEASUREMENT')

    ledger, results = [], []
    pairs = [('r12r2.0', '05-r12r2.0'), ('r12r2.2', '06-r12r2.2')]
    for condition, directory in pairs:
        result = measure(wave, condition, 'formal', frozen, ledger, requested=1, directory_name=directory,
            budget_fn=budget_check, verify_fn=verify, environment_fn=native.environment,
            validate_fn=native_runner.validate_condition, probe='tools/ap06-r12-r2-native-probe.mjs')
        receipt = wave.output / 'formal' / directory / 'native-receipt.json'
        registration = json.loads((receipt.parent / 'native-trace.json').read_text(encoding='utf-8'))
        config = json.loads((wave.output / 'baseline/authority-config.local.json').read_text(encoding='utf-8'))
        trace_path = checked_path(Path(config['AP06_AUTHORITY_ROOT']) / registration['authorityRelativePath'])
        aggregate = validate_trace(trace_path, receipt)
        classification = classify_native_aggregate(aggregate)
        results.append({'condition': condition, 'rawSha256': result['rawSha256'],
            'rawPath': result['rawPath'], 'native': aggregate})
        wave.save(f'formal/{directory}/native-aggregate.json', aggregate)
        publish(wave, 'aggregate-' + directory[:2], {
            f'evidence/formal/{directory}/aggregate.json': wave.output / 'formal' / directory / 'native-aggregate.json',
            f'evidence/formal/{directory}/receipt.json': receipt})
        if classification == 'INCONCLUSIVE':
            return publish_coverage_decision(wave, results, aggregate.get('reason'))
    cleanup = stop_and_verify_backend_cleanup(wave)
    if cleanup.get('status') != 'PASS':
        raise NativeContractFailure(f"BACKEND_CLEANUP_{cleanup.get('status', 'FAILED')}")
    capability_chromium, measurement_chromium, retries = _decision_consumption(execution_state(wave.output))
    decision = {'status': f'R12{tag}_NATIVE_TRACKED_AGGREGATES_OBSERVED',
        'capabilityChromium': capability_chromium, 'measurementChromium': measurement_chromium,
        'retries': retries, 'abAuthorized': True, 'results': results,
        'cleanupStatus': cleanup.get('status'),
        'causalAttribution': 'Exploratory and conditional on R12R12; sampled aggregates do not establish total coverage, individual lifetimes, or a leak.'}
    validate_decision_consumption(wave.output, decision)
    wave.save('final/decision.json', decision)
    publish(wave, 'decision', {'evidence/decision.json': wave.output / 'final/decision.json'})
    return decision


def offline_preflight(wave, source_output):
    from run_ap06_r12_r2 import validate_r8_native_tests
    from run_backend_shards import parse_catch_report
    from ap06_browser_identity import verify_identity
    from run_ap06_integration_probe import build_products
    from ap06_key_custody import readback

    require(not any((wave.output / path).exists() for path in ('pipeline/capability-reservation.json',
        'final/STOP.json', 'final/decision.json')), 'R12R13_OFFLINE_AFTER_SCIENCE_FORBIDDEN')
    identity = json.loads((wave.output / 'baseline/browser-identity.json').read_text(encoding='utf-8-sig'))
    verify_identity(identity)
    require(identity.get('chromiumVersion') == '151.0.7922.34' and identity.get('playwrightVersion') == '1.62.1',
        'R12R13_BROWSER_IDENTITY_INVALID')
    for relative in ('experimental-backend.json', 'backend-isolation.json', 'listener-isolation.json',
        'network-spoof-guard.json', 'network-spoof-recovery.json', 'startup-rejections.json',
        'backend-runtime.local.json',
        'player-auth.local.json', 'backend-authority.json', 'runtime-credentials.dpapi',
        'runtime-credentials-custody.json', 'runtime-credentials-readback.json'):
        path = wave.output / ('baseline/' + relative)
        require(path.is_file(), 'R12R13_OFFLINE_BACKEND_OR_CUSTODY_INCOMPLETE')
    for name in ('native-production.xml', 'native-experimental.xml'):
        path = wave.output / 'baseline' / name
        report = parse_catch_report(path)
        require(report['assertion_failures'] == report['case_failures'] == report['expected_failures'] == 0,
            'R12R13_NATIVE_TESTS_FAILED')
    artifacts = {key: sha256(wave.output / 'tooling/backend-build' / name) for key, name in NATIVE_FILES.items()}
    backend = json.loads((wave.output / 'baseline/experimental-backend.json').read_text())
    reuse = {'status': 'PASS', 'method': 'fresh isolated R13 CMake/Ninja build', 'artifacts': artifacts,
        'sourceFiles': native_source_files(wave), 'crowHeaderSha256': backend['crowHeaderSha256']}
    wave.save('baseline/native-binary-reuse.json', reuse)
    summaries = {}
    for kind, name in (('production', 'native-production.xml'), ('experimental', 'native-experimental.xml')):
        report = parse_catch_report(wave.output / 'baseline' / name)
        summaries[kind] = {'status': 'PASS', 'assertionsPassed': report['assertion_successes'],
            'assertionsFailed': report['assertion_failures'], 'expectedFailures': report['expected_failures'],
            'casesPassed': report['case_successes'], 'casesFailed': report['case_failures'],
            'xmlSha256': sha256(wave.output / 'baseline' / name)}
    wave.save('baseline/native-tests-summary.json', {'status': 'PASS', 'seed': 60102, 'suites': summaries})
    validate_native_build_authority(wave)
    validate_r8_native_tests(wave)
    assets, products, workers = build_products(wave.root, OUTPUT)
    worker_hashes = {kind: row['sha256'] for kind, row in workers.items()}
    fixture_hash = sha256(wave.output / 'fixtures/manifest.json')
    wave.save('tooling/app-products.json', {'status': 'PASS', 'project': 'ap06-r7',
        'products': products, 'workers': worker_hashes, 'assetCount': len(assets)})
    wave.save('tooling/angular-unit-1.json', {'status': 'PASS', 'preflightMode': 'build-only',
        'unitBrowserLaunches': 0, 'browserLaunches': 0, 'appProducts': products,
        'workerHashes': worker_hashes, 'fixtureHash': fixture_hash})
    task_hash = sha256(wave.output / 'baseline/task.md')
    wave.save('baseline/budget.json', {'approved': True, **NATIVE_BUDGET, 'approvedByTaskSha256': task_hash})
    wave.save('baseline/dependency-audit.json', {'status': 'RECORDED_NO_UPGRADES', 'upgradePerformed': False,
        'findings': {'moderate': 7, 'high': 20, 'critical': 3, 'total': 30},
        'sourceReport': 'docs/qualidade/ap06-r12-r12.json'})
    wave.save('baseline/historical-r9.json', json.loads((wave.root / 'docs/qualidade/ap06-r9-r2.json').read_text(encoding='utf-8')))
    source = json.loads((wave.output / 'baseline/historical-factorial-gate.json').read_text())
    tag = campaign_tag()
    source_task = wave.root / TASK_PATH
    require(sha256(source_task) == json.loads((wave.output / 'baseline/task-provenance.json').read_text())['sourceSha256'],
        f'R12{tag}_TASK_AUTHORITY_CHANGED')
    manifest = {'status': 'PASS', 'preflightMode': 'resolve-only', 'headSha': wave.git('rev-parse', 'HEAD').strip(),
        'manifestSha256': sha256(wave.output / 'baseline/browser-identity.json'),
        'playwrightVersion': identity['playwrightVersion'], 'chromiumVersion': identity['chromiumVersion'],
        'scientificChromium': 0, 'reservationCreated': False, 'launchAttempts': 0, 'retries': 0}
    wave.save('baseline/playwright-identity-preflight.json', manifest)
    source_output = checked_path(Path(os.path.abspath(source_output)))
    verify_historical_factorial(source_output, wave.root)
    kasumi_source = source_output / 'tooling/kasumi.cjs'
    require(kasumi_source.is_file(), f'R12{tag}_KAS2_SOURCE_UNAVAILABLE')
    shutil.copyfile(kasumi_source, wave.output / 'tooling/kasumi.cjs')
    runner_test = f'tools/quality/test_ap06_r12_{tag.lower()}.py'
    if not (wave.root / runner_test).is_file():
        runner_test = 'tools/quality/test_ap06_r12_r13.py'
    commands = (
        ('python-native-parser', [sys.executable, 'tools/quality/test_ap06_native.py'], wave.root),
        ('python-runner', [sys.executable, runner_test], wave.root),
        ('python-freeze-contract', [sys.executable, 'tools/quality/test_ap06_freeze.py'], wave.root),
        ('node-capture-and-integration', [wave.node, '--test', 'tools/ap06-native-trace.test.mjs',
            'tools/ap06-native-integration.test.mjs'], wave.root / 'frontend'),
        ('typescript', [wave.node, str(wave.root / 'frontend/node_modules/typescript/bin/tsc'),
            '--noEmit', '-p', str(wave.root / 'frontend/tsconfig.app.json')], wave.root),
    )
    for label, command, cwd in commands:
        wave.command(f'r12-{tag.lower()}-' + label, command, cwd)
    from run_test_matrix import npm_command
    wave.command(f'r12-{tag.lower()}-angular-build', [npm_command(), 'run', 'build', '--', 'ap06-r7',
        '--output-path=../' + OUTPUT + '/tooling/app'], wave.root / 'frontend')
    tests = {'status': 'PASS', 'python': {'status': 'PASS'}, 'node': {'status': 'PASS'},
        'typescript': {'status': 'PASS'}, 'angularBuild': {'status': 'PASS'}, 'native': {'status': 'PASS'}}
    wave.save('baseline/tests.json', tests)
    wave.save('baseline/custody-readback.json', readback(Path(json.loads((wave.output / 'baseline/authority-config.local.json').read_text())[
        'AP06_AUTHORITY_ROOT']), json.loads((wave.output / 'baseline/authority-config.local.json').read_text())['identity'], campaign=CAMPAIGN))
    identity_record = json.loads((wave.output / 'baseline/playwright-identity-preflight.json').read_text())
    identity_record.update(headSha=wave.git('rev-parse', 'HEAD').strip(),
        manifestSha256=sha256(wave.output / 'baseline/browser-identity.json'))
    wave.save('baseline/playwright-identity-preflight.json', identity_record)
    return {'status': 'PASS', 'scientificChromium': 0, 'reservationCreated': False,
        'implementationHead': wave.git('rev-parse', 'HEAD').strip(), 'sourceGate': source.get('status')}


def scan_staged_changes(wave, executable=None):
    executable = Path(executable or shutil.which('gitleaks') or (Path.home() / 'go/bin/gitleaks.exe'))
    require(executable.is_file(), 'R12R13_GITLEAKS_UNAVAILABLE')
    version = subprocess.run(['go', 'version', '-m', str(executable)], capture_output=True, text=True, check=True).stdout
    require(re.search(r'(?m)^\s*mod\s+github\.com/zricethezav/gitleaks/v8\s+v8\.30\.1\s', version),
        'R12R13_GITLEAKS_VERSION_INVALID')
    changed = wave.git('diff', '--cached', '--name-only', '--diff-filter=ACMRTUXB').splitlines()
    require(bool(changed), 'R12R13_GITLEAKS_EMPTY_DIFF')
    target = wave.output / 'pipeline/secret-scan-target'
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)
    private_permissions(target, create=True)
    try:
        for relative in changed:
            source = checked_path((wave.root / relative).absolute())
            require(source.is_relative_to(wave.root) and source.is_file(), 'R12R13_GITLEAKS_INPUT_INVALID')
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        report = wave.output / 'baseline/secret-scan.json'
        report.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run([str(executable), 'dir', str(target), '--no-banner', '--no-color', '--redact',
            '--report-format', 'json', '--report-path', str(report), '--exit-code', '1'],
            capture_output=True, text=True, timeout=300)
        findings = json.loads(report.read_text(encoding='utf-8')) if report.exists() else []
        require(result.returncode == 0 and findings == [], 'R12R13_GITLEAKS_FINDINGS')
        tracked = {name: sha256(wave.root / name) for name in wave.git('ls-files').splitlines()
            if (wave.root / name).is_file()}
        import hashlib
        tree_hash = hashlib.sha256(json.dumps(tracked, sort_keys=True).encode()).hexdigest()
        wave.save('baseline/secret-scan-receipt.json', {'status': 'PASS', 'scanner': 'gitleaks',
            'version': 'v8.30.1', 'actionableFindings': 0, 'trackedTreeSha256': tree_hash,
            'rawReportSha256': sha256(report), 'findings': 0, 'scannedStagedFiles': len(changed)})
        return {'status': 'PASS', 'version': 'v8.30.1', 'findings': 0, 'scannedStagedFiles': len(changed)}
    finally:
        if target.exists():
            target = checked_path(target.resolve(strict=True))
            require(target.is_relative_to(wave.output.resolve()), 'R12R13_GITLEAKS_CLEANUP_PATH_INVALID')
            shutil.rmtree(target)


R13_FREEZE_FILES = (
    'baseline/custody.json', 'baseline/custody-readback.json', 'baseline/task-provenance.json',
    'baseline/corpus-provenance.json', 'baseline/historical-factorial-gate.json',
    'baseline/historical-native-diagnosis.json', 'baseline/native-budget.json',
    'baseline/preregistered-protocol.json', 'baseline/browser-identity.json',
    'baseline/playwright-identity-preflight.json', 'baseline/experimental-backend.json',
    'baseline/backend-isolation.json', 'baseline/listener-isolation.json',
    'baseline/network-spoof-guard.json', 'baseline/network-spoof-recovery.json',
    'baseline/startup-rejections.json', 'baseline/postgres-toolchain.json',
    'baseline/backend-runtime.local.json', 'baseline/player-auth.local.json',
    'baseline/backend-authority.json', 'baseline/runtime-credentials.dpapi',
    'baseline/runtime-credentials-custody.json', 'baseline/runtime-credentials-readback.json',
    'baseline/native-binary-reuse.json', 'baseline/native-tests-summary.json',
    'baseline/dependency-audit.json', 'baseline/secret-scan.json',
    'baseline/secret-scan-receipt.json', 'baseline/ci.json',
    'baseline/quality-baseline-ci.json', 'baseline/tests.json', 'baseline/historical-r9.json',
    'tooling/app-products.json', 'tooling/app/stats.json', 'tooling/kasumi.cjs',
)


def freeze_campaign(wave):
    from ap06_key_custody import readback
    from run_ap06_integration_probe import VERSION
    tag = campaign_tag()
    require(json.loads((wave.output / 'baseline/ci.json').read_text()).get('headSha') == wave.git('rev-parse', 'HEAD').strip(),
        f'R12{tag}_CI_HEAD_CHANGED')
    ready = validate_freeze_readiness(wave, output=OUTPUT, extra_files=R13_FREEZE_FILES,
        extra_publications=('custody',), preflight_complete=True)
    wave.save('baseline/freeze-readiness.json', ready)
    identity = json.loads((wave.output / 'baseline/browser-identity.json').read_text(encoding='utf-8-sig'))
    protocol = json.loads((wave.output / 'baseline/preregistered-protocol.json').read_text())
    freeze_implementation(wave, output=OUTPUT, harness='frontend/tools/ap06-native-trace.mjs',
        runner_path=RUNNER_PATH, extra_files=R13_FREEZE_FILES, extra_publications=('custody',),
        protocol={'campaign': CAMPAIGN, 'browserIdentity': identity, 'protocol': protocol,
            'factorialAuthority': json.loads((wave.output / 'baseline/historical-factorial-gate.json').read_text()),
            'chromiumVersion': VERSION})
    frozen = json.loads((wave.output / 'tooling/freeze.json').read_text())
    verify_freeze(wave, frozen); verify_freeze_completion(wave, frozen)
    config = json.loads((wave.output / 'baseline/authority-config.local.json').read_text())
    custody = readback(Path(config['AP06_AUTHORITY_ROOT']), config['identity'], campaign=CAMPAIGN)
    require(custody.get('status') == 'PASS', f'R12{tag}_CUSTODY_READBACK_FAILED')
    return {'status': 'FROZEN', 'implementationHead': frozen['implementationHead'],
        'freezeSha256': sha256(wave.output / 'tooling/freeze.json'), 'independentReadback': True}

freeze_r13 = freeze_campaign


COMPLETED_STATUSES = frozenset({
    'PASS',
    'NATIVE_CAPABILITY_PASS',
    'R12R13_NATIVE_TRACKED_AGGREGATES_OBSERVED',
    'R12R13_NATIVE_ALLOCATION_COVERAGE_INSUFFICIENT',
    'R12R13_NATIVE_CAPABILITY_INCONCLUSIVE',
    'R12R14_NATIVE_TRACKED_AGGREGATES_OBSERVED',
    'R12R14_NATIVE_ALLOCATION_COVERAGE_INSUFFICIENT',
    'R12R14_NATIVE_CAPABILITY_INCONCLUSIVE',
})


CLEANUP_RECEIPT_KEYS = frozenset({
    'status', 'ownedServerStopped', 'ownedPostgresStopped',
    'ownedClusterStorageAndDotenvRemoved', 'runtimePreservedForResume',
    'personalServicesTouched', 'failureClass', 'errors',
})

BACKEND_START_EVIDENCE = (
    'pipeline/backend-live.json',
    'pipeline/backend-runtime-cleanup.json',
    'pipeline/capability-reservation.json',
    'pipeline/native-receipt.json',
    'baseline/backend-isolation.json',
    'baseline/listener-isolation.json',
    'baseline/backend-runtime.local.json',
)


def _decode_json_object(path):
    try:
        value = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _backend_start_evidence(output):
    return tuple(relative for relative in BACKEND_START_EVIDENCE if (output / relative).is_file())


def _validate_runtime_config(output):
    path = output / 'baseline/backend-runtime.local.json'
    if not path.is_file():
        return None, 'BACKEND_RUNTIME_CONFIG_MISSING'
    config = _decode_json_object(path)
    if config is None:
        return None, 'BACKEND_RUNTIME_CONFIG_CORRUPT'
    if not {'cwd', 'storagePath', 'storageId', 'backendOrigin'}.issubset(config):
        return None, 'BACKEND_RUNTIME_OWNERSHIP_INVALID'
    cwd, storage = config.get('cwd'), config.get('storagePath')
    storage_id, origin = config.get('storageId'), config.get('backendOrigin')
    if not (isinstance(cwd, str) and isinstance(storage, str) and
            isinstance(storage_id, str) and isinstance(origin, str)):
        return None, 'BACKEND_RUNTIME_OWNERSHIP_INVALID'
    try:
        from urllib.parse import urlsplit
        parsed = urlsplit(origin)
        port = parsed.port
    except ValueError:
        return None, 'BACKEND_RUNTIME_ORIGIN_INVALID'
    if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or port is None or
            not 1 <= port <= 65535 or parsed.path not in ('', '/') or parsed.query or
            parsed.fragment or parsed.username or parsed.password):
        return None, 'BACKEND_RUNTIME_ORIGIN_INVALID'
    try:
        cwd_path = checked_path(Path(cwd).absolute())
        storage_path = checked_path(Path(storage).absolute())
        pipeline = output.resolve() / 'pipeline'
        cwd_resolved = cwd_path.resolve()
        storage_resolved = storage_path.resolve()
    except (OSError, ValueError):
        return None, 'BACKEND_RUNTIME_OWNERSHIP_INVALID'
    if (cwd_resolved.parent != pipeline or
            not re.fullmatch(r'runtime-[0-9a-f]{16}', cwd_resolved.name) or
            storage_resolved != cwd_resolved / 'storage' or
            not re.fullmatch(r'[0-9a-f]{64}', storage_id)):
        return None, 'BACKEND_RUNTIME_OWNERSHIP_INVALID'
    return {'cwd': cwd_resolved, 'storagePath': storage_resolved,
        'storageId': storage_id, 'port': port, 'origin': origin}, None


def _validate_runtime_evidence(output, config):
    live_path = output / 'pipeline/backend-live.json'
    if live_path.is_file():
        live = _decode_json_object(live_path)
        if live is None:
            return 'BACKEND_RUNTIME_EVIDENCE_INVALID'
        if (live.get('status') != 'READY' or live.get('isolated') is not True or
                live.get('backendOrigin') != config['origin'] or
                ('backendPid' in live and (type(live['backendPid']) is not int or live['backendPid'] <= 0))):
            return 'BACKEND_RUNTIME_OWNERSHIP_INVALID'
    isolation_path = output / 'baseline/backend-isolation.json'
    if isolation_path.is_file():
        isolation = _decode_json_object(isolation_path)
        if isolation is None:
            return 'BACKEND_RUNTIME_EVIDENCE_INVALID'
        if (isolation.get('origin') != config['origin'] or isolation.get('port') != config['port'] or
                isolation.get('bind') != '127.0.0.1' or isolation.get('storageId') != config['storageId'] or
                isolation.get('existingServicesTouched') is not False or
                isolation.get('isolatedCluster') is not True):
            return 'BACKEND_RUNTIME_OWNERSHIP_INVALID'
    return None


def _probe_owned_listener(port):
    import socket, time
    for attempt in range(5):
        try:
            connection = socket.create_connection(('127.0.0.1', port), timeout=1)
        except ConnectionRefusedError:
            return True, None
        except (TimeoutError, socket.timeout, OSError):
            return False, 'BACKEND_LISTENER_PROBE_FAILED'
        connection.close()
        if attempt == 4:
            return False, 'BACKEND_LISTENER_STILL_ACTIVE'
        time.sleep(0.2)
    return False, 'BACKEND_LISTENER_STILL_ACTIVE'


def _validate_cleanup_receipt(receipt):
    if not isinstance(receipt, dict) or set(receipt) != CLEANUP_RECEIPT_KEYS:
        return 'BACKEND_CLEANUP_RECEIPT_INVALID'
    if receipt.get('status') != 'PASS':
        return 'BACKEND_CLEANUP_FAILED'
    for key in ('ownedServerStopped', 'ownedPostgresStopped',
            'ownedClusterStorageAndDotenvRemoved', 'runtimePreservedForResume',
            'personalServicesTouched'):
        if type(receipt.get(key)) is not bool:
            return 'BACKEND_CLEANUP_RECEIPT_INVALID'
    if receipt['personalServicesTouched'] is not False:
        return 'BACKEND_PERSONAL_SERVICES_TOUCHED'
    if receipt['runtimePreservedForResume'] is not False:
        return 'BACKEND_RUNTIME_PRESERVED_FOR_RESUME'
    if not (receipt['ownedServerStopped'] and receipt['ownedPostgresStopped'] and
            receipt['ownedClusterStorageAndDotenvRemoved']):
        return 'BACKEND_CLEANUP_INCOMPLETE'
    if receipt.get('failureClass') is not None:
        return 'BACKEND_CLEANUP_FAILED'
    errors = receipt.get('errors')
    if not isinstance(errors, list):
        return 'BACKEND_CLEANUP_RECEIPT_INVALID'
    if errors:
        return 'BACKEND_CLEANUP_ERRORS_REPORTED'
    return None


def _wait_supervisor(supervisor_proc):
    try:
        code = supervisor_proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        try:
            supervisor_proc.terminate()
        except OSError:
            pass
        try:
            supervisor_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try:
                supervisor_proc.kill()
            except OSError:
                pass
            try:
                supervisor_proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        return 'FAIL', 'BACKEND_SUPERVISOR_TIMEOUT'
    if code not in (0, None):
        return 'FAIL', 'BACKEND_SUPERVISOR_FAILED'
    return 'PASS', None


def _publish_cleanup_receipt(wave, cleanup_path):
    from run_ap06_r9 import publication_namespace
    namespace = publication_namespace(wave)
    publication = f'{namespace}-backend-cleanup' if namespace else 'backend-cleanup'
    try:
        publish(wave, 'backend-cleanup', {'evidence/backend-runtime-cleanup.json': cleanup_path})
    except Exception:
        return 'UNVERIFIED', 'BACKEND_CLEANUP_PUBLICATION_FAILED'
    config_path = wave.output / 'baseline/authority-config.local.json'
    config = _decode_json_object(config_path)
    if config is None or not config.get('AP06_AUTHORITY_ROOT') or not config.get('identity'):
        return 'UNVERIFIED', 'BACKEND_CLEANUP_AUTHORITY_MISSING'
    try:
        authority = checked_path(Path(config['AP06_AUTHORITY_ROOT']))
        manifest = verify_publication(authority, config['identity'], publication)
    except Exception:
        return 'UNVERIFIED', 'BACKEND_CLEANUP_READBACK_FAILED'
    relative = 'evidence/backend-runtime-cleanup.json'
    published = f'{namespace}/{relative}' if namespace else relative
    entry = next((row for row in manifest.get('files', ())
        if isinstance(row, dict) and row.get('path') == published), None)
    if (not entry or entry.get('sha256') != sha256(cleanup_path) or
            entry.get('size') != cleanup_path.stat().st_size):
        return 'FAIL', 'BACKEND_CLEANUP_READBACK_MISMATCH'
    return 'PASS', None


def _stop_and_verify_backend_cleanup(wave, supervisor_proc):
    output = wave.output
    evidence = _backend_start_evidence(output)
    started = bool(evidence) or supervisor_proc is not None
    if not started:
        return {'status': 'PASS', 'backendStarted': False,
            'reason': 'BACKEND_NOT_STARTED', 'startEvidence': []}

    stop_marker = output / 'pipeline/stop-backend.request'
    try:
        stop_marker.parent.mkdir(parents=True, exist_ok=True)
        stop_marker.touch(exist_ok=True)
    except OSError:
        return {'status': 'FAIL', 'backendStarted': True,
            'reason': 'BACKEND_STOP_MARKER_FAILED', 'startEvidence': list(evidence)}

    if supervisor_proc is not None:
        status, reason = _wait_supervisor(supervisor_proc)
        if status != 'PASS':
            return {'status': status, 'backendStarted': True,
                'reason': reason, 'startEvidence': list(evidence)}

    config, reason = _validate_runtime_config(output)
    if config is None:
        status = 'UNVERIFIED' if reason in ('BACKEND_RUNTIME_CONFIG_MISSING',
            'BACKEND_RUNTIME_CONFIG_CORRUPT') else 'FAIL'
        return {'status': status, 'backendStarted': True,
            'reason': reason, 'startEvidence': list(evidence)}

    reason = _validate_runtime_evidence(output, config)
    if reason:
        return {'status': 'FAIL', 'backendStarted': True,
            'reason': reason, 'startEvidence': list(evidence)}

    closed, reason = _probe_owned_listener(config['port'])
    if not closed:
        status = 'FAIL' if reason == 'BACKEND_LISTENER_STILL_ACTIVE' else 'UNVERIFIED'
        return {'status': status, 'backendStarted': True,
            'reason': reason, 'startEvidence': list(evidence)}

    cleanup_path = output / 'pipeline/backend-runtime-cleanup.json'
    if not cleanup_path.is_file():
        return {'status': 'UNVERIFIED', 'backendStarted': True,
            'reason': 'BACKEND_CLEANUP_RECEIPT_MISSING', 'startEvidence': list(evidence)}
    receipt = _decode_json_object(cleanup_path)
    if receipt is None:
        return {'status': 'UNVERIFIED', 'backendStarted': True,
            'reason': 'BACKEND_CLEANUP_RECEIPT_CORRUPT', 'startEvidence': list(evidence)}
    reason = _validate_cleanup_receipt(receipt)
    if reason:
        return {'status': 'FAIL', 'backendStarted': True,
            'reason': reason, 'startEvidence': list(evidence)}

    if os.path.lexists(config['cwd']) or os.path.lexists(config['storagePath']):
        return {'status': 'FAIL', 'backendStarted': True,
            'reason': 'BACKEND_RUNTIME_STILL_EXISTS', 'startEvidence': list(evidence)}

    status, reason = _publish_cleanup_receipt(wave, cleanup_path)
    if status != 'PASS':
        return {'status': status, 'backendStarted': True,
            'reason': reason, 'startEvidence': list(evidence)}
    return {'status': 'PASS', 'backendStarted': True, 'reason': 'BACKEND_CLEANUP_VERIFIED',
        'receipt': receipt, 'receiptSha256': sha256(cleanup_path),
        'publicationStatus': 'PASS', 'startEvidence': list(evidence)}


def stop_and_verify_backend_cleanup(wave, supervisor_proc=None):
    try:
        return _stop_and_verify_backend_cleanup(wave, supervisor_proc)
    except Exception as exc:
        return {'status': 'UNVERIFIED',
            'reason': f'BACKEND_CLEANUP_INTERNAL_{type(exc).__name__}'}


def execution_state(output):
    reservation = output / 'pipeline/capability-reservation.json'
    cap_receipt = output / 'pipeline/native-receipt.json'
    ledger_path = output / 'pipeline/launch-ledger.json'
    state = {
        'reservationCreated': reservation.is_file(),
        'launchAttempts': 0,
        'browserLaunches': 0,
        'retries': 0,
        'capabilityChromium': 0,
        'measurementChromium': 0,
        'unverifiedConsumption': False,
        'capabilityVerified': True,
        'measurementVerified': True,
        'ledgerPresent': ledger_path.is_file(),
        'measurementConditions': [],
        'measurementDirectories': [],
        'measurementRawSha256': {},
    }

    def unverified(*, capability=False, measurement=False):
        state['unverifiedConsumption'] = True
        if capability:
            state['capabilityVerified'] = False
        if measurement:
            state['measurementVerified'] = False

    def valid_trace_receipt(receipt):
        trace = receipt.get('trace', receipt) if isinstance(receipt, dict) else None
        checkpoints = trace.get('checkpoints') if isinstance(trace, dict) else None
        return (isinstance(trace, dict) and trace.get('tracingStarted') is True and
            trace.get('memoryInfraCategoryAvailable') is True and
            trace.get('activatedBeforeWorkload') is True and trace.get('complete') is True and
            trace.get('streamEof') is True and trace.get('dataLossOccurred') is False and
            trace.get('traceFormat') == 'json' and type(trace.get('rendererPid')) is int and
            trace['rendererPid'] > 0 and isinstance(trace.get('sha256'), str) and
            re.fullmatch(r'[0-9a-f]{64}', trace['sha256']) is not None and
            type(trace.get('bytes')) is int and trace['bytes'] > 0 and
            isinstance(checkpoints, list) and len(checkpoints) == len(PHASES) and
            [item.get('phase') if isinstance(item, dict) else None for item in checkpoints] == list(PHASES) and
            all(isinstance(item, dict) and item.get('success') is True and
                isinstance(item.get('dumpGuid'), str) for item in checkpoints) and
            len({item['dumpGuid'].lower() for item in checkpoints}) == len(PHASES))

    reservation_data = _decode_json_object(reservation) if reservation.is_file() else None
    receipt_data = _decode_json_object(cap_receipt) if cap_receipt.is_file() else None
    if reservation.is_file():
        if (reservation_data is None or set(reservation_data) !=
                {'campaign', 'maximum', 'retries', 'implementationHead'} or
                reservation_data.get('campaign') != CAMPAIGN or
                type(reservation_data.get('maximum')) is not int or reservation_data['maximum'] != 1 or
                type(reservation_data.get('retries')) is not int or reservation_data['retries'] != 0 or
                not isinstance(reservation_data.get('implementationHead'), str) or
                not re.fullmatch(r'[0-9a-f]{40}', reservation_data['implementationHead'])):
            unverified(capability=True)
    elif receipt_data is not None:
        unverified(capability=True)

    if reservation.is_file() and receipt_data is None:
        unverified(capability=True)
        state['launchAttempts'] += 1
    elif receipt_data is not None:
        attempts = receipt_data.get('launchAttempts')
        launches = receipt_data.get('browserLaunches')
        retries = receipt_data.get('retries')
        if any(type(value) is not int or value < 0 for value in (attempts, launches, retries)):
            unverified(capability=True)
            state['launchAttempts'] += 1
        else:
            state['launchAttempts'] += attempts
            state['browserLaunches'] += launches
            state['retries'] += retries
            state['capabilityChromium'] = launches
            if launches > attempts:
                unverified(capability=True)
        if (receipt_data.get('status') != 'CAPTURED' or receipt_data.get('browserClosed') is not True or
                not isinstance(receipt_data.get('processExitAudit'), dict) or
                receipt_data['processExitAudit'].get('status') != 'PASS' or
                not isinstance(receipt_data.get('handleRelease'), dict) or
                receipt_data['handleRelease'].get('status') != 'PASS' or
                not valid_trace_receipt(receipt_data)):
            unverified(capability=True)

    directories = {'05-r12r2.0': 'r12r2.0', '06-r12r2.2': 'r12r2.2'}
    reverse_directories = {condition: directory for directory, condition in directories.items()}
    formal_root = output / 'formal'
    actual_directories = []
    if formal_root.is_dir():
        try:
            for child in formal_root.iterdir():
                if not child.is_dir():
                    unverified(measurement=True)
                    continue
                condition = directories.get(child.name)
                if condition is None:
                    unverified(measurement=True)
                else:
                    actual_directories.append(condition)
        except OSError:
            unverified(measurement=True)
    state['measurementDirectories'] = sorted(actual_directories,
        key=lambda condition: ('r12r2.0', 'r12r2.2').index(condition))

    ledger = None
    if ledger_path.is_file():
        try:
            ledger = json.loads(ledger_path.read_text(encoding='utf-8-sig'))
        except (OSError, UnicodeError, json.JSONDecodeError):
            unverified(measurement=True)
    if ledger is not None and not isinstance(ledger, list):
        unverified(measurement=True)
        ledger = None
    if ledger is None and state['measurementDirectories']:
        unverified(measurement=True)

    ledger_conditions = []
    if ledger is not None:
        for entry in ledger:
            if not isinstance(entry, dict):
                unverified(measurement=True)
                continue
            condition = entry.get('condition')
            if condition not in ('r12r2.0', 'r12r2.2'):
                unverified(measurement=True)
                continue
            lane_index = ('r12r2.0', 'r12r2.2').index(condition)
            ledger_conditions.append(condition)
            if condition in ledger_conditions[:-1] or lane_index != len(ledger_conditions) - 1:
                unverified(measurement=True)
            directory = output / 'formal' / reverse_directories[condition]
            receipt_path = directory / 'native-receipt.json'
            raw_path = directory / f'{CRYPTO}.raw.json'
            reserved = entry.get('reservedAttempts')
            entry_attempts, entry_launches = entry.get('launchAttempts'), entry.get('browserLaunches')
            entry_digest = entry.get('rawSha256')
            if (entry.get('stage') != 'formal' or type(reserved) is not int or reserved != 1 or
                    type(entry_attempts) is not int or entry_attempts < 0 or
                    type(entry_launches) is not int or entry_launches < 0 or
                    not isinstance(entry_digest, str) or not re.fullmatch(r'[0-9a-f]{64}', entry_digest)):
                unverified(measurement=True)

            raw = _decode_json_object(raw_path) if raw_path.is_file() else None
            raw_counts = tuple(raw.get(key) for key in ('launchAttempts', 'browserLaunches', 'retries')) if raw else ()
            raw_valid = (raw is not None and raw.get('condition') == condition and raw.get('stage') == 'formal' and
                all(type(value) is int and value >= 0 for value in raw_counts) and
                raw_counts[0] == 1 and raw_counts[1] == 1 and raw_counts[1] <= raw_counts[0] and
                isinstance(raw.get('runs'), list) and len(raw['runs']) == 1)
            if raw_valid:
                state['launchAttempts'] += raw_counts[0]
                state['browserLaunches'] += raw_counts[1]
                state['retries'] += raw_counts[2]
                digest = sha256(raw_path)
                state['measurementRawSha256'][condition] = digest
                if (entry_attempts != raw_counts[0] or entry_launches != raw_counts[1] or
                        entry_digest != digest):
                    unverified(measurement=True)
            else:
                unverified(measurement=True)
                if type(entry_attempts) is int and entry_attempts >= 0:
                    state['launchAttempts'] += entry_attempts
                elif type(reserved) is int and reserved > 0:
                    state['launchAttempts'] += reserved
                if type(entry_launches) is int and entry_launches >= 0:
                    state['browserLaunches'] += entry_launches

            receipt = _decode_json_object(receipt_path) if receipt_path.is_file() else None
            if not valid_trace_receipt(receipt):
                unverified(measurement=True)

        if ledger_conditions != state['measurementDirectories']:
            unverified(measurement=True)
    elif ledger_path.is_file():
        unverified(measurement=True)
    elif formal_root.is_dir():
        try:
            if any(formal_root.iterdir()):
                unverified(measurement=True)
        except OSError:
            unverified(measurement=True)
    state['measurementConditions'] = ledger_conditions
    state['measurementChromium'] = state['browserLaunches'] - state['capabilityChromium']

    return state


def validate_decision_consumption(output, decision):
    expected = expected_decision_launches(decision)
    state = execution_state(output)
    if (state['unverifiedConsumption'] or not state['capabilityVerified'] or
            not state['measurementVerified'] or not state['reservationCreated'] or
            expected['measurementConditions'] and not state['ledgerPresent']):
        raise NativeContractFailure('NATIVE_CONSUMPTION_UNVERIFIED')
    if (state['measurementConditions'] != expected['measurementConditions'] or
            state['measurementDirectories'] != expected['measurementConditions']):
        raise NativeContractFailure('NATIVE_CONSUMPTION_MISMATCH')

    for row, condition in zip(decision.get('results', []), expected['measurementConditions']):
        directory = {'r12r2.0': '05-r12r2.0', 'r12r2.2': '06-r12r2.2'}[condition]
        if (row.get('rawPath') != f'formal/{directory}/{CRYPTO}.raw.json' or
                row.get('rawSha256') != state['measurementRawSha256'].get(condition)):
            raise NativeContractFailure('NATIVE_CONSUMPTION_MISMATCH')

    for field in ('capabilityChromium', 'measurementChromium', 'retries'):
        actual = state[field]
        declared = decision.get(field)
        if (type(actual) is not int or type(declared) is not int or
                actual != declared or actual != expected[field]):
            raise NativeContractFailure('NATIVE_CONSUMPTION_MISMATCH')
    if (state['launchAttempts'] != expected['total'] or
            state['browserLaunches'] != expected['total'] or state['retries'] != 0):
        raise NativeContractFailure('NATIVE_LAUNCH_ACCOUNTING_INVALID')
    return True


def record_durable_stop(wave, reason, error=None, stage=None):
    output = wave.output
    stop_path = output / 'final/STOP.json'
    readback_path = output / 'final/stop-publication-readback.json'

    # Check if a durable STOP is already recorded; if so, preserve it and reject overwrite/re-execution
    if stop_path.is_file():
        try:
            existing = json.loads(stop_path.read_text(encoding='utf-8-sig'))
            pub_status = 'PASS'
            if readback_path.is_file():
                try:
                    readback_info = json.loads(readback_path.read_text(encoding='utf-8-sig'))
                    pub_status = readback_info.get('status', 'PASS')
                except Exception:
                    pass
            return {**existing, 'publicationStatus': pub_status}
        except Exception:
            pass

    state = execution_state(output)

    failure_class = reason
    failure_stage = stage or 'execution'
    cleanup_status = 'NOT_PERFORMED'
    cleanup_failure_class = None

    # Mandatory cleanup on STOP paths (post-reservation, post-launch, publication failure, during A/B)
    if state['reservationCreated'] or state['browserLaunches'] > 0 or _backend_start_evidence(output):
        try:
            cleanup_res = stop_and_verify_backend_cleanup(wave)
            cleanup_status = cleanup_res.get('status', 'UNVERIFIED')
            if cleanup_status != 'PASS':
                cleanup_failure_class = cleanup_res.get('reason')
        except Exception as exc:
            cleanup_status = 'FAIL'
            cleanup_failure_class = type(exc).__name__
    else:
        cleanup_receipt_path = output / 'pipeline/backend-runtime-cleanup.json'
        if cleanup_receipt_path.is_file():
            try:
                cleanup_data = json.loads(cleanup_receipt_path.read_text(encoding='utf-8-sig'))
                cleanup_status = cleanup_data.get('status', 'UNVERIFIED')
                cleanup_failure_class = cleanup_data.get('failureClass')
            except Exception:
                cleanup_status = 'UNVERIFIED'

    stop_payload = {
        'status': 'STOP',
        'reason': reason,
        'failureStage': failure_stage,
        'failureClass': failure_class,
        'reservationCreated': state['reservationCreated'],
        'launchAttempts': state['launchAttempts'],
        'browserLaunches': state['browserLaunches'],
        'retries': state['retries'],
        'scientificChromium': state['browserLaunches'] if not state['unverifiedConsumption'] else 'UNVERIFIED',
        'cleanupStatus': cleanup_status,
        'cleanupFailureClass': cleanup_failure_class,
    }

    # 1. Save local final/STOP.json
    wave.save('final/STOP.json', stop_payload)
    digest = sha256(stop_path)

    # 2. Publish STOP to authority and verify independent readback
    pub_status = 'PASS'
    pub_failure = None
    try:
        from run_ap06_r9 import publication_namespace
        ns = publication_namespace(wave)
        pub_name = f"{ns}-stop" if ns else 'stop'
        publish(wave, 'stop', {'evidence/STOP.json': stop_path})
        config = json.loads((output / 'baseline/authority-config.local.json').read_text(encoding='utf-8-sig'))
        authority = checked_path(Path(config['AP06_AUTHORITY_ROOT']))
        manifest = verify_publication(authority, config['identity'], pub_name)
        stop_entry = next((f for f in manifest.get('files', []) if f.get('path') == 'evidence/STOP.json'), None)
        if not stop_entry or stop_entry.get('sha256') != digest:
            raise ValueError('STOP_PUBLICATION_HASH_MISMATCH')
    except Exception as pub_error:
        pub_status = 'FAIL'
        pub_failure = type(pub_error).__name__

    # 3. Save publication result in separate readback receipt without modifying final/STOP.json
    readback_payload = {
        'status': pub_status,
        'stopSha256': digest,
        'independentReadback': pub_status == 'PASS',
    }
    if pub_failure:
        readback_payload['publicationFailure'] = pub_failure
    wave.save('final/stop-publication-readback.json', readback_payload)

    return {**stop_payload, 'publicationStatus': pub_status}


def _record_decision_validation_incident(wave, reason):
    decision_path = wave.output / 'final/decision.json'
    incident_path = wave.output / 'final/decision-validation-incident.json'
    if incident_path.exists():
        return
    safe_reason = reason if isinstance(reason, str) and re.fullmatch(r'[A-Z][A-Z0-9_:]+', reason) else \
        'NATIVE_CONSUMPTION_UNVERIFIED'
    try:
        wave.save('final/decision-validation-incident.json', {
            'status': 'STOP', 'reason': safe_reason,
            'decisionSha256': sha256(decision_path) if decision_path.is_file() else None,
        })
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument('--prepare', action='store_true')
    actions.add_argument('--validate-trace', type=Path)
    actions.add_argument('--validate-synthetic-trace', type=Path)
    actions.add_argument('--offline-preflight', action='store_true')
    actions.add_argument('--freeze', action='store_true')
    actions.add_argument('--scan-staged', action='store_true')
    actions.add_argument('--run', action='store_true')
    parser.add_argument('--source-output', type=Path)
    parser.add_argument('--receipt', type=Path)
    args = parser.parse_args()
    wave = Wave(Path(__file__).resolve().parents[2]); wave.output = wave.root / OUTPUT
    temporary = tempfile.TemporaryDirectory(prefix='ap06-r13-logs-')
    wave.temp = Path(temporary.name)
    try:
        if args.prepare:
            require(args.source_output is not None, 'R12R13_HISTORICAL_SOURCE_REQUIRED')
            result = prepare(wave, args.source_output)
        elif args.offline_preflight:
            require(args.source_output is not None, 'R12R13_HISTORICAL_SOURCE_REQUIRED')
            result = offline_preflight(wave, args.source_output)
        elif args.scan_staged:
            result = scan_staged_changes(wave)
        elif args.freeze:
            result = freeze_r13(wave)
        elif args.validate_trace or args.validate_synthetic_trace:
            require(args.receipt is not None, 'R12R13_RECEIPT_REQUIRED')
            result = validate_trace(args.validate_synthetic_trace or args.validate_trace, args.receipt,
                synthetic=args.validate_synthetic_trace is not None)
            result = {key: result[key] for key in
                ('status', 'reason', 'heapProfilingEffective', 'traceSha256', 'traceBytes') if key in result}
        else:
            require(args.source_output is not None, 'R12R13_HISTORICAL_SOURCE_REQUIRED')
            result = run_capability(wave, args.source_output)
        print(json.dumps(result))
        status = result.get('status')
        if args.validate_trace or args.validate_synthetic_trace:
            return 0 if status in ('PASS', 'NATIVE_CAPABILITY_PASS') else 1
        if args.freeze:
            return 0 if status == 'FROZEN' else 1
        if args.prepare or args.offline_preflight or args.scan_staged:
            return 0 if status == 'PASS' else 1
        if status in COMPLETED_STATUSES:
            decision_path = wave.output / 'final/decision.json'
            if not decision_path.is_file():
                return 1
            try:
                decision_data = json.loads(decision_path.read_text(encoding='utf-8-sig'))
                if decision_data.get('status') != status:
                    return 1
                try:
                    validate_decision_consumption(wave.output, decision_data)
                except NativeContractFailure as error:
                    _record_decision_validation_incident(wave, error.reason)
                    return 1
                if 'cleanupStatus' in decision_data and decision_data['cleanupStatus'] != 'PASS':
                    return 1
                config = json.loads((wave.output / 'baseline/authority-config.local.json').read_text(encoding='utf-8-sig'))
                authority = checked_path(Path(config['AP06_AUTHORITY_ROOT']))
                from run_ap06_r9 import publication_namespace
                ns = publication_namespace(wave)
                pub_name = f"{ns}-decision" if ns else 'decision'
                manifest = verify_publication(authority, config['identity'], pub_name)
                relative = 'evidence/decision.json'
                published = f'{ns}/{relative}' if ns else relative
                entry = next((row for row in manifest.get('files', ())
                    if isinstance(row, dict) and row.get('path') == published), None)
                if not entry or entry.get('sha256') != sha256(decision_path):
                    return 1
            except Exception:
                return 1
            return 0
        return 1
    except (WaveFailure, OSError, ValueError, KeyError, TypeError) as error:
        reason = str(error) if re.fullmatch(r'[A-Z][A-Z0-9_:]+', str(error)) else 'R12R13_NATIVE_EXECUTION_FAILED'
        stop_record = record_durable_stop(wave, reason, error=error)
        print(json.dumps(stop_record))
        return 1
    finally:
        temporary.cleanup()


if __name__ == '__main__': raise SystemExit(main())
