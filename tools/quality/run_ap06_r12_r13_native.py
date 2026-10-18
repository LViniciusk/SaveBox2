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
from ap06_native import aggregate_trace, trace_events
from prepare_ap06_r12_r13 import NATIVE_BUDGET, OUTPUT, CAMPAIGN, prepare, verify_historical_factorial
from run_readiness_wave1 import Wave, WaveFailure
from run_ap06_r9 import (freeze_implementation, publish, validate_freeze_readiness,
    verify_freeze)
from ap06_freeze import (NATIVE_FILES, load_native_budget, native_source_files,
    validate_native_build_authority, verify_freeze_completion)

TASK_PATH = 'quality/ap06-r12-r13.md'
RUNNER_PATH = Path(__file__).resolve()


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
    trace = receipt.get('trace', receipt)
    if receipt is not trace:
        for k in ('rendererIdentityProof', 'processExitAudit', 'handleRelease', 'processSamples', 'browserIdentity'):
            if k in receipt and k not in trace:
                trace[k] = receipt[k]
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
    if capability.get('status') != 'NATIVE_CAPABILITY_PASS':
        decision = {'status': f'R12{tag}_NATIVE_CAPABILITY_INCONCLUSIVE', 'reason': capability.get('reason', 'NATIVE_TRACE_CONTRACT_INVALID'),
            'capabilityChromium': 1, 'measurementChromium': 0, 'retries': 0,
            'abAuthorized': False, 'interpretation': 'No A/B measurement without four correlated renderer heaps_v2 dumps.'}
        wave.save('final/decision.json', decision)
        publish(wave, 'decision', {'evidence/decision.json': output / 'final/decision.json'})
        return decision
    return run_profiled_pair(wave, source, frozen, native)


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
        wave.save(f'formal/{directory}/native-aggregate.json', aggregate)
        publish(wave, 'aggregate-' + directory[:2], {
            f'evidence/formal/{directory}/aggregate.json': wave.output / 'formal' / directory / 'native-aggregate.json',
            f'evidence/formal/{directory}/receipt.json': receipt})
        results.append({'condition': condition, 'rawSha256': result['rawSha256'], 'native': aggregate})
    decision = {'status': f'R12{tag}_NATIVE_TRACKED_AGGREGATES_OBSERVED'
        if all(row['native'].get('status') == 'NATIVE_CAPABILITY_PASS' for row in results)
        else f'R12{tag}_NATIVE_ALLOCATION_COVERAGE_INSUFFICIENT', 'capabilityChromium': 1,
        'measurementChromium': 2, 'retries': 0, 'results': results,
        'causalAttribution': 'Exploratory and conditional on R12R12; sampled aggregates do not establish total coverage, individual lifetimes, or a leak.'}
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


def execution_state(output):
    reservation = output / 'pipeline/capability-reservation.json'
    cap_receipt = output / 'pipeline/native-receipt.json'

    state = {
        'reservationCreated': reservation.is_file(),
        'launchAttempts': 0,
        'browserLaunches': 0,
        'retries': 0,
        'capabilityChromium': 0,
        'measurementChromium': 0,
        'unverifiedConsumption': False,
    }

    if reservation.is_file():
        if cap_receipt.is_file():
            try:
                cap_data = json.loads(cap_receipt.read_text(encoding='utf-8-sig'))
                attempts = cap_data.get('launchAttempts', 0)
                launches = cap_data.get('browserLaunches', 0)
                retries = cap_data.get('retries', 0)
                state['launchAttempts'] += attempts
                state['browserLaunches'] += launches
                state['retries'] += retries
                state['capabilityChromium'] = launches
            except Exception:
                state['unverifiedConsumption'] = True
                state['launchAttempts'] += 1
        else:
            state['unverifiedConsumption'] = True
            state['launchAttempts'] += 1

    for directory in ('05-r12r2.0', '06-r12r2.2'):
        m_receipt = output / 'formal' / directory / 'native-receipt.json'
        if m_receipt.is_file():
            try:
                m_data = json.loads(m_receipt.read_text(encoding='utf-8-sig'))
                launches = m_data.get('browserLaunches', 1 if m_data.get('status') == 'CAPTURED' or 'checkpoints' in m_data else 0)
                state['launchAttempts'] += m_data.get('launchAttempts', 1)
                state['browserLaunches'] += launches
                state['retries'] += m_data.get('retries', 0)
                state['measurementChromium'] += launches
            except Exception:
                state['unverifiedConsumption'] = True
                state['launchAttempts'] += 1

    return state


def stop_and_verify_backend_cleanup(wave, supervisor_proc=None):
    output = wave.output
    stop_marker = output / 'pipeline/stop-backend.request'
    stop_marker.touch(exist_ok=True)

    if supervisor_proc is not None:
        try:
            supervisor_proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            supervisor_proc.kill()
            supervisor_proc.wait(timeout=10)

    for _ in range(15):
        try:
            import socket, time
            conn = socket.create_connection(('127.0.0.1', 42187), timeout=1)
            conn.close()
            time.sleep(0.5)
        except (OSError, ConnectionRefusedError):
            break
    else:
        raise RuntimeError('AP06_BACKEND_LISTENER_STILL_ACTIVE')

    cleanup_path = output / 'pipeline/backend-runtime-cleanup.json'
    if not cleanup_path.is_file():
        return {'status': 'UNVERIFIED', 'reason': 'BACKEND_CLEANUP_RECEIPT_MISSING'}

    try:
        cleanup_receipt = json.loads(cleanup_path.read_text(encoding='utf-8-sig'))
    except Exception:
        return {'status': 'UNVERIFIED', 'reason': 'BACKEND_CLEANUP_RECEIPT_CORRUPT'}

    if cleanup_receipt.get('status') != 'PASS':
        return {'status': 'FAIL', 'reason': cleanup_receipt.get('failureClass', 'BACKEND_CLEANUP_FAILED')}

    runtime_config = output / 'baseline/backend-runtime.local.json'
    if runtime_config.is_file():
        try:
            conf = json.loads(runtime_config.read_text(encoding='utf-8-sig'))
            cwd_str = conf.get('cwd')
            storage_str = conf.get('storagePath')
            if (cwd_str and Path(cwd_str).exists()) or (storage_str and Path(storage_str).exists()):
                return {'status': 'FAIL', 'reason': 'BACKEND_RUNTIME_STILL_EXISTS'}
        except Exception:
            pass

    try:
        from run_ap06_r9 import publication_namespace
        ns = publication_namespace(wave)
        pub_name = f"{ns}-backend-cleanup" if ns else 'backend-cleanup'
        publish(wave, 'backend-cleanup', {'evidence/backend-runtime-cleanup.json': cleanup_path})
        config = json.loads((output / 'baseline/authority-config.local.json').read_text(encoding='utf-8-sig'))
        authority = checked_path(Path(config['AP06_AUTHORITY_ROOT']))
        verify_publication(authority, config['identity'], pub_name)
    except Exception as exc:
        return {'status': 'STOP', 'reason': f'BACKEND_CLEANUP_PUBLICATION_FAILED_{type(exc).__name__}'}

    return {'status': 'PASS', 'receipt': cleanup_receipt}


def record_durable_stop(wave, reason, error=None, stage=None):
    output = wave.output
    state = execution_state(output)

    failure_class = reason
    failure_stage = stage or 'execution'
    cleanup_status = 'NOT_PERFORMED'
    cleanup_failure_class = None

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
        'publicationStatus': 'PENDING',
    }

    try:
        from run_ap06_r9 import publication_namespace
        ns = publication_namespace(wave)
        pub_name = f"{ns}-stop" if ns else 'stop'
        wave.save('final/STOP.json', stop_payload)
        publish(wave, 'stop', {'evidence/STOP.json': output / 'final/STOP.json'})
        config = json.loads((output / 'baseline/authority-config.local.json').read_text(encoding='utf-8-sig'))
        authority = checked_path(Path(config['AP06_AUTHORITY_ROOT']))
        verify_publication(authority, config['identity'], pub_name)
        stop_payload['publicationStatus'] = 'PASS'
        wave.save('final/STOP.json', stop_payload)
    except Exception as pub_error:
        stop_payload['publicationStatus'] = 'FAIL'
        stop_payload['publicationFailure'] = type(pub_error).__name__
        try:
            wave.save('final/STOP.json', stop_payload)
        except Exception:
            pass

    return stop_payload


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
                config = json.loads((wave.output / 'baseline/authority-config.local.json').read_text(encoding='utf-8-sig'))
                authority = checked_path(Path(config['AP06_AUTHORITY_ROOT']))
                from run_ap06_r9 import publication_namespace
                ns = publication_namespace(wave)
                pub_name = f"{ns}-decision" if ns else 'decision'
                verify_publication(authority, config['identity'], pub_name)
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
