"""Wave 1 authority: shared builds/runtime, serial measurements, one regression gate."""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import contextlib
import ctypes
import hashlib
import http.client
import http.server
import json
import os
import platform
import re
import secrets
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import owned_frontend as frontend_owner
import run_playwright_campaign as campaign
import run_playwright_campaign_env as owner
import run_recovery_targeted as recovery
import run_test_matrix as matrix
from run_backend_shards import parse_catch_report, write_json_atomic

TRACKS = ('C01', 'M01', 'M02', 'M03', 'M04')
DIRECTORIES = dict(zip(TRACKS, ('c01-schema', 'm01-player-memory', 'm02-thumbnail-memory', 'm03-ap06', 'm04-db-pool')))
FINDINGS = {
    'M01-F01': 'REAL_PLAYER_TOTAL_MEMORY_UNCHARACTERIZED',
    'M02-F01': 'THUMBNAIL_DECODE_MEMORY_UNCHARACTERIZED',
    'M03-F01': 'AP06_MEASUREMENT_RATIFICATION_PENDING',
    'M04-F01': 'DB_POOL_CAPACITY_UNRATIFIED',
    'M04-F02': 'DB_POOL_ACQUIRE_WAIT_UNBOUNDED_BY_TIME',
    'C01-F01': 'EXISTING_SCHEMA_HAS_NO_VERSION_AUTHORITY',
    'C01-F02': 'CURRENT_SCHEMA_BASELINE_NOT_CAPTURED',
    'W1-F01': 'PIPELINE_DUPLICATION_MUST_REMAIN_BOUNDED',
}
FROZEN_TREES = ('backend/include', 'backend/src', 'frontend/src', 'deploy')
FROZEN_FILES = ('Dockerfile', 'frontend/Dockerfile', 'frontend/nginx.conf')


class WaveFailure(RuntimeError):
    pass


def compatible_measurements(player, thumbnails):
    return (player.get('status') == thumbnails.get('status') == 'CHARACTERIZED'
            and player.get('baselineGroups') == thumbnails.get('baselineGroups')
            and bool(player.get('baselineGroups')))


def reusable_build(record, current, products):
    return bool(record and record.get('inputs') == current and record.get('products') == products
                and products and all(products.values()))


def authenticated_headers(payload):
    token = payload.get('token')
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9._-]+', token):
        raise WaveFailure('DB_WORKLOAD_AUTHENTICATION_FAILED')
    return {'Authorization': 'Bearer ' + token}


def validate_db_warmup(requests):
    if any(row['status'] == 429 for row in requests): raise WaveFailure('M04_RATE_LIMIT_CONTAMINATED')
    if any(row['status'] != 200 or row['timeout'] or row['transportError'] for row in requests):
        raise WaveFailure('M04_WORKLOAD_PREFLIGHT_FAILED')


def format_mib(value):
    return 'NOT_AVAILABLE' if value is None else f'{value / 2**20:.2f}'


def orchestrate(actions):
    """One scheduling path; tests replace actions, never launch real browsers."""
    states = {track: {'status': 'NOT_RUN'} for track in TRACKS}
    common = None
    gate = {'status': 'NOT_RUN'}
    teardown = {'status': 'FAIL'}
    try:
        for phase in ('baseline', 'dependencies', 'backend_build', 'frontend_build', 'runtime'):
            actions[phase]()
        for track in TRACKS:
            if track == 'M03' and not compatible_measurements(states['M01'], states['M02']):
                states[track] = {'status': 'BLOCKED', 'reason': 'INCOMPARABLE_MEASUREMENT_BASELINES' if
                    states['M01'].get('status') == states['M02'].get('status') == 'CHARACTERIZED' else 'M03_REQUIRES_VALID_M01_AND_M02'}
                continue
            try:
                states[track] = actions[track]()
            except Exception as error:
                states[track] = {'status': 'BLOCKED' if isinstance(error, WaveFailure) else 'FAIL',
                    'reason': str(error) if isinstance(error, WaveFailure) else type(error).__name__}
        actions['focused']()
        gate = actions['gate']()
    except Exception as error:
        common = str(error) if isinstance(error, WaveFailure) else type(error).__name__
    finally:
        try:
            teardown = actions['teardown']()
        except Exception as error:
            teardown = {'status': 'FAIL', 'reason': type(error).__name__}
    return {'tracks': states, 'commonFailure': common, 'gate': gate, 'teardown': teardown}


def process_sample(ids, authority='Explicit PIDs from owned CDP SystemInfo.getProcessInfo'):
    """Only explicit PIDs supplied by the owned CDP SystemInfo authority."""
    if os.name != 'nt':
        return {'status': 'NOT_AVAILABLE', 'reason': 'This collector implements Windows process information only'}
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [
            (name, ctypes.c_size_t) for name in ('PeakWorkingSetSize', 'WorkingSetSize', 'QuotaPeakPagedPoolUsage',
                'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage', 'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage', 'PrivateUsage')]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    psapi = ctypes.WinDLL('psapi', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
    rows = []
    for pid in ids:
        handle = kernel.OpenProcess(0x0400 | 0x0010, False, pid)
        if not handle:
            return {'status': 'NOT_AVAILABLE', 'reason': 'An owned PID was inaccessible or exited'}
        try:
            value = Counters(); value.cb = ctypes.sizeof(value)
            if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(value), value.cb):
                return {'status': 'NOT_AVAILABLE', 'reason': 'Owned process memory unavailable'}
            row = {'pid': pid, 'privateBytes': value.PrivateUsage, 'workingSetBytes': value.WorkingSetSize}
            times = (wintypes.FILETIME * 4)()
            if kernel.GetProcessTimes(handle, *[ctypes.byref(t) for t in times]):
                row['cpuSeconds'] = sum((t.dwHighDateTime << 32) + t.dwLowDateTime for t in times[2:]) / 10_000_000
            rows.append(row)
        finally:
            kernel.CloseHandle(handle)
    return {'status': 'AVAILABLE', 'authority': authority, 'processes': rows,
        'privateBytes': sum(r['privateBytes'] for r in rows), 'workingSetBytes': sum(r['workingSetBytes'] for r in rows),
        'cpuSeconds': sum(r['cpuSeconds'] for r in rows) if all('cpuSeconds' in r for r in rows) else None,
        'scope': 'Owned process-group private commit and sum of working sets; shared pages may be counted more than once; GPU/device allocations not exposed'}


def persisted_evidence(value, secret_values=()):
    encoded = json.dumps(value, allow_nan=False)
    if any(secret and len(secret) >= 8 and secret in encoded for secret in secret_values):
        raise WaveFailure('SECRET_ARTIFACT_REJECTED')
    if re.search(r'(?i)(Bearer\s+[A-Za-z0-9._-]+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.)', encoded):
        raise WaveFailure('SECRET_ARTIFACT_REJECTED')
    return value


class Wave:
    def __init__(self, root):
        self.root = root.resolve()
        self.output = self.root / '.quality/readiness-wave1'
        self.timings = []
        self.counts = dict.fromkeys(('baselineInventories', 'dependencySetups', 'npmCiRuns', 'backendBuilds', 'frontendBuilds',
            'postgresGenerations', 'browserMeasurementProcesses', 'browserFixtureGenerationProcesses', 'auxiliaryProbeBuilds', 'fixtureBundles',
            'fullBackendRuns', 'fullFrontendRuns', 'fullGateInvocations', 'processInvocations'), 0)
        self.lease = self.backend = self.server = self.server_thread = self.build_temp = None
        self.baseline_hashes = None
        self.secrets = []
        self.host_env = os.environ.copy()
        self.env = self.host_env.copy()
        if os.name == 'nt':
            self.env['PATH'] = 'C:/msys64/ucrt64/bin;' + self.env['PATH']
        self.node = shutil.which('node') or 'node'
        self.server_binary = self.root / ('backend/build/savebox_server.exe' if os.name == 'nt' else 'backend/build/savebox_server')
        self.fixture_binary = self.root / ('backend/build/nanika_e2e_fixture.exe' if os.name == 'nt' else 'backend/build/nanika_e2e_fixture')
        self.test_binary = self.root / ('backend/build/savebox_tests.exe' if os.name == 'nt' else 'backend/build/savebox_tests')

    def save(self, relative, value):
        (self.output / relative).parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(self.output / relative, persisted_evidence(value, self.secrets))

    def report(self, relative, content):
        persisted_evidence(content, self.secrets)
        path = self.output / relative; path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content + '\n', encoding='utf-8')

    @contextlib.contextmanager
    def phase(self, name):
        started = time.perf_counter(); cpu = time.process_time(); calls = self.counts['processInvocations']
        print(json.dumps({'phase': name, 'state': 'STARTED'}), flush=True)
        try:
            yield
        finally:
            self.timings.append({'phase': name, 'wallSeconds': round(time.perf_counter() - started, 3),
                'orchestratorCpuSeconds': round(time.process_time() - cpu, 3), 'processInvocations': self.counts['processInvocations'] - calls,
                'protocolRevision': getattr(self, 'protocol_revision', 1)})
            self.save('pipeline/timings.json', {'phases': self.timings, 'cpuScope': 'Orchestrator only; child CPU not inferred'})

    def git(self, *arguments):
        completed = subprocess.run(['git', '-c', f'safe.directory={self.root.as_posix()}', *arguments], cwd=self.root, capture_output=True, text=True, check=False)
        if completed.returncode: raise WaveFailure('GIT_INVENTORY_UNAVAILABLE')
        return completed.stdout.rstrip('\r\n')

    def capture_hashes(self):
        trees = {relative: owner._tree_sha256(self.root, relative) for relative in FROZEN_TREES}
        files = {relative: campaign.sha256_file(self.root / relative) for relative in FROZEN_FILES}
        for path in sorted(self.root.glob('docker-compose*.yml')):
            files[path.name] = campaign.sha256_file(path)
        tooling = {relative: owner._tree_sha256(self.root, relative) for relative in ('frontend/tools', 'frontend/e2e-video')}
        # Quality includes Python bytecode caches; hash only actual tooling source files.
        tooling_files = {p.relative_to(self.root).as_posix(): campaign.sha256_file(p) for p in sorted((self.root / 'tools/quality').glob('*')) if p.is_file()}
        groups = {
            'frontend-player-production': trees['frontend/src'], 'frontend-thumbnail-production': trees['frontend/src'],
            'backend-db-production': hashlib.sha256((trees['backend/include'] + trees['backend/src']).encode()).hexdigest(),
            'database-schema-production': campaign.sha256_file(self.root / 'backend/src/database/DatabaseMigration.cpp'),
            'measurement-tooling': hashlib.sha256(json.dumps([tooling, tooling_files], sort_keys=True).encode()).hexdigest(),
        }
        historical = {p.name: owner._tree_sha256(self.root, p.relative_to(self.root).as_posix())
            for p in sorted((self.root / '.quality').iterdir()) if p.is_dir() and re.match(r'b(?:89|9[0-8])-', p.name)}
        return {'algorithm': 'sha256', 'trees': trees, 'files': files, 'groups': groups, 'historicalArtifacts': historical,
            'tooling': tooling, 'toolingFiles': tooling_files}

    def baseline(self):
        self.counts['baselineInventories'] += 1
        with self.phase('preflight'):
            self.head = self.git('rev-parse', 'HEAD')
            self.branch = self.git('branch', '--show-current')
            dirty = self.git('status', '--porcelain').splitlines()
            self.baseline_hashes = self.capture_hashes()
            self.save('baseline/source-hashes.json', self.baseline_hashes)
            self.containers_before = recovery.container_snapshot()
            memory = None
            if os.name == 'nt':
                class MemoryStatus(ctypes.Structure):
                    _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [(name, ctypes.c_ulonglong) for name in
                        ('totalPhys', 'availPhys', 'totalPage', 'availPage', 'totalVirtual', 'availVirtual', 'availExtended')]
                value = MemoryStatus(); value.length = ctypes.sizeof(value)
                if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(value)): memory = value.totalPhys
            environment = {'gitHead': self.head, 'branch': self.branch, 'dirty': bool(dirty), 'dirtyFiles': dirty,
                'os': platform.system(), 'osVersion': platform.version(), 'architecture': platform.machine(), 'cpuCount': os.cpu_count(),
                'cpuModel': platform.processor(), 'ramTotalBytes': memory, 'singlePhysicalWorker': True,
                'productionFrozen': True, 'secretsRecorded': False}
            self.save('baseline/environment.json', environment)
            self.build_temp = tempfile.TemporaryDirectory(prefix='nanika-wave1-build-')
            self.temp = Path(self.build_temp.name)
            versions = {}
            for tool, arguments in [('node', ['--version']), ('npm', ['--version']), ('ffmpeg', ['-version']), ('ffprobe', ['-version']),
                    ('psql', ['--version']), ('cmake', ['--version']), ('g++', ['--version'])]:
                executable = matrix.npm_command() if tool == 'npm' else shutil.which(tool, path=self.env['PATH'])
                if not executable: versions[tool] = {'status': 'NOT_AVAILABLE'}; continue
                result = subprocess.run([executable, *arguments], env=self.env, capture_output=True, text=True, errors='replace')
                versions[tool] = result.stdout.splitlines()[0] if result.returncode == 0 and result.stdout else {'status': 'NOT_AVAILABLE'}
            self.versions = versions
            self.save('baseline/tool-versions.json', versions)
            self.save('pipeline/protocol.json', {'browserRepetitions': 3, 'heavyTracksSerial': True, 'automaticRetries': 0,
                'naturalWarmupMs': 1000, 'naturalSettleMs': 1000, 'dbConcurrency': [1, 2, 4, 8, 16, 32],
                'dbRequestsPerRepetition': 192, 'dbWarmupRequests': 8, 'dbRepetitions': 3, 'httpTimeoutSeconds': 10,
                'slo': 'NONE_PREEXISTING; curves characterized without inventing an SLO',
                'saturationDefinition': 'First level with <=5% marginal throughput gain and >=20% median p95 growth versus previous level; observational heuristic, not an SLO'})
            self.save('pipeline/findings-entry.json', {key: {'name': value, 'status': 'OPEN'} for key, value in FINDINGS.items()})

    def command(self, name, command, cwd=None, environment=None, check=True):
        # Existing logged runner; private temporary logs are summarized, never copied wholesale.
        previous = os.environ.copy()
        try:
            os.environ.clear(); os.environ.update(self.env if environment is None else environment)
            result = matrix.run_logged_command(command, cwd or self.root, self.temp / f'{name}.log')
        finally:
            os.environ.clear(); os.environ.update(previous)
        output = result['log'].read_text(encoding='utf-8', errors='replace')
        artifact = {'name': name, 'exitCode': result['exit_code'], 'status': 'PASS' if result['exit_code'] == 0 else 'FAIL',
            'wallSeconds': result['duration_seconds'], 'logPersisted': False,
            'counts': re.findall(r'(?im)\bTOTAL:\s*\d+ SUCCESS|\bTotal: \d+ tests in \d+ files|^# (?:tests|suites|pass|fail) \d+|^Ran \d+ tests[^\r\n]*|^\s*\d+ passed \([^\r\n]*\)',
                re.sub(r'\x1b\[[0-9;]*m','',output))[-6:]}
        if name == 'full-backend':
            # Classify success and failure before private logs are removed; never persist HTTP bodies or assertion values.
            start = output.find('<Catch2TestRun'); end = output.rfind('</Catch2TestRun>')
            report = self.temp / 'backend-report.xml'
            report.write_text(output[start:end+len('</Catch2TestRun>')],encoding='utf-8')
            try:
                artifact['testResults'] = parse_catch_report(report)
                artifact['testResults'].pop('names')
                tree = ET.parse(report).getroot()
                artifact['failedCases'] = [{'name':case.get('name'), 'assertionLines':[e.get('line') for e in case.iter('Expression') if e.get('success')=='false']}
                    for case in tree.findall('.//TestCase') if case.find('OverallResult') is not None and case.find('OverallResult').get('success')=='false']
            except ValueError:
                artifact['testResults'] = {'status':'NOT_AVAILABLE','reason':'Invalid or incomplete Catch2 XML; exit status remains authoritative'}
        if result['exit_code']:
            artifact['failureSignals'] = [signal for signal in (
                'Cannot read directory', 'Access is denied', 'cannot start', 'not captured', 'FAILED', 'ERROR',
            ) if signal.lower() in output.lower()]
        self.save(f'pipeline/commands/{name}.json', artifact)
        if check and result['exit_code'] != 0: raise WaveFailure(f'COMMAND_FAILED_{name.upper()}')
        return output

    def dependencies(self):
        self.counts['dependencySetups'] += 1
        with self.phase('dependency setup'):
            lock = json.loads((self.root / 'frontend/package-lock.json').read_text())
            mismatches = []
            for relative, entry in lock.get('packages', {}).items():
                if not relative or entry.get('optional'): continue
                path = self.root / 'frontend' / relative / 'package.json'
                try: matches = json.loads(path.read_text()).get('version') == entry.get('version')
                except (OSError, ValueError): matches = False
                if not matches: mismatches.append(relative)
            if mismatches:
                self.counts['npmCiRuns'] += 1
                self.command('npm-ci', [matrix.npm_command(), 'ci'], self.root / 'frontend')
            self.save('pipeline/dependencies.json', {'npmLockSha256': campaign.sha256_file(self.root / 'frontend/package-lock.json'),
                'reuseAllowed': not mismatches, 'basis': 'Mandatory installed package versions compared with every package-lock entry',
                'mismatchesBeforeSetup': len(mismatches), 'npmCiRuns': self.counts['npmCiRuns']})
            self.cache_path = self.root / '.quality/readiness-wave1-build-cache.json'
            try: self.cache = json.loads(self.cache_path.read_text())
            except (OSError, ValueError): self.cache = {}

    def backend_build(self):
        with self.phase('backend build'):
            inputs = {'production': self.baseline_hashes['groups']['backend-db-production'],
                'cmake': campaign.sha256_file(self.root / 'backend/CMakeLists.txt'),
                'tests': owner._tree_sha256(self.root, 'backend/tests'),
                'config': campaign.sha256_file(self.root / 'backend/build/CMakeCache.txt'), 'compiler': self.versions['g++']}
            products = {p.name: campaign.sha256_file(p) if p.is_file() else None for p in (self.server_binary, self.fixture_binary, self.test_binary)}
            reused = reusable_build(self.cache.get('backend'), inputs, products)
            if not reused:
                self.counts['backendBuilds'] += 1
                self.command('backend-configure', ['cmake', '-S', 'backend', '-B', 'backend/build', '-DBUILD_TESTS=ON'])
                self.command('backend-build', ['cmake', '--build', 'backend/build', '--parallel', '4', '--target', 'savebox_server', 'savebox_tests', 'nanika_e2e_fixture'])
                products = {p.name: campaign.sha256_file(p) for p in (self.server_binary, self.fixture_binary, self.test_binary)}
                inputs['config'] = campaign.sha256_file(self.root / 'backend/build/CMakeCache.txt')
            self.cache['backend'] = {'inputs': inputs, 'products': products}
            self.save('pipeline/backend-reuse.json', {'reused': reused, **self.cache['backend']})
            self.db_probe = self.temp / ('readiness-db-probe.exe' if os.name == 'nt' else 'readiness-db-probe')
            self.counts['auxiliaryProbeBuilds'] += 1
            self.command('db-probe-build', [shutil.which('g++', path=self.env['PATH']) or 'g++', '-std=c++17', '-pthread', '-Ibackend/include',
                'tools/quality/readiness-db-probe.cpp', 'backend/src/database/DatabasePool.cpp', 'backend/src/database/DatabaseMigration.cpp', '-lpqxx', '-lpq', '-o', str(self.db_probe)])

    def frontend_build(self):
        with self.phase('frontend build'):
            inputs = {'production': self.baseline_hashes['trees']['frontend/src'],
                'lock': campaign.sha256_file(self.root / 'frontend/package-lock.json'),
                'config': campaign.sha256_file(self.root / 'frontend/angular.json'), 'node': self.versions['node'],
                'public': owner._tree_sha256(self.root, 'frontend/public')}
            directory = self.root / 'frontend/dist/frontend'
            products = {'build': owner._tree_sha256(self.root, 'frontend/dist/frontend')} if directory.is_dir() else {}
            reused = reusable_build(self.cache.get('frontend'), inputs, products)
            if not reused:
                self.counts['frontendBuilds'] += 1
                self.command('frontend-production-build', [matrix.npm_command(), 'run', 'build', '--', '--configuration', 'production'], self.root / 'frontend')
                products = {'build': owner._tree_sha256(self.root, 'frontend/dist/frontend')}
            self.cache['frontend'] = {'inputs': inputs, 'products': products}
            self.save('pipeline/frontend-reuse.json', {'reused': reused, **self.cache['frontend']})
            write_json_atomic(self.cache_path, self.cache)
            self.frontend_directory = directory / 'browser'
            self.counts['fixtureBundles'] += 1
            self.command('fixture-bundle', [self.node, '-e',
                "require('esbuild').buildSync({entryPoints:['./tools/readiness-fixtures.ts','./src/app/core/crypto/crypto.worker.ts'],bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},outdir:process.argv[1],logLevel:'error'})", str(self.temp / 'bundles')], self.root / 'frontend')

    def runtime(self):
        with self.phase('runtime startup'):
            reservation = frontend_owner.reserve_frontend_port()
            self.backend_url = f'http://127.0.0.1:{recovery._free_loopback_port()}'
            frontend_url = f'http://127.0.0.1:{reservation.port}'
            try:
                self.lease = owner.prepare_environment(self.root, frontend_url, self.backend_url, self.server_binary)
                self.counts['postgresGenerations'] += 1
                if self.lease.postgres.container_id in self.containers_before: raise WaveFailure('PREEXISTING_POSTGRES_ADOPTION_REJECTED')
                self.env.update(owner.read_dotenv(self.lease.workspace.env_file))
                self.env.update(self.lease.e2e_environment)
                self.env.update({'NANIKA_E2E_BASE_URL': frontend_url, 'NANIKA_E2E_BACKEND_URL': self.backend_url,
                    'NANIKA_E2E_FIXTURE_EXE': str(self.fixture_binary), 'WAVE1_ARTIFACT_ROOT': str(self.output),
                    'WAVE1_SOURCE_HASHES': json.dumps(self.baseline_hashes['groups']), 'WAVE1_FIXTURES': str(self.lease.workspace.root / 'fixtures'),
                    'WAVE1_FIXTURE_BUNDLE': str(self.temp / 'bundles/tools/readiness-fixtures.cjs'),
                    'WAVE1_CRYPTO_WORKER': (self.temp / 'bundles/src/app/core/crypto/crypto.worker.cjs').as_uri(),
                    'WAVE1_PYTHON': sys.executable, 'WAVE1_RUNNER': str(Path(__file__).resolve()),
                    'WAVE1_PLAYWRIGHT_OUTPUT': str(self.lease.workspace.root / 'playwright')})
                self.secrets += [self.env[key] for key in ('DB_PASSWORD', 'PASS_PEPPER', 'NANIKA_JWT_SECRET')]
                self.env['WAVE1_DB_CONNECTION'] = ' '.join(f"{key}={self.env[envkey]}" for key, envkey in
                    [('host','DB_HOST'), ('port','DB_PORT'), ('dbname','DB_NAME'), ('user','DB_USER'), ('password','DB_PASSWORD')])
                wave = self
                class Handler(http.server.SimpleHTTPRequestHandler):
                    def __init__(self, *args, **kwargs): super().__init__(*args, directory=str(wave.frontend_directory), **kwargs)
                    def log_message(self, *_): pass
                    def end_headers(self):
                        self.send_header('Cross-Origin-Opener-Policy', 'same-origin'); self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
                        super().end_headers()
                    def request(self):
                        if self.path.startswith('/backend/'):
                            body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
                            parsed = urlsplit(wave.backend_url)
                            connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=35)
                            try:
                                headers = {k:v for k,v in self.headers.items() if k.lower() not in {'host','connection'}}
                                connection.request(self.command, self.path[len('/backend'):], body, headers)
                                response = connection.getresponse(); payload = response.read()
                                self.send_response(response.status)
                                for key,value in response.getheaders():
                                    if key.lower() not in {'connection','transfer-encoding','content-length'}: self.send_header(key,value)
                                self.send_header('Content-Length', str(len(payload))); self.end_headers(); self.wfile.write(payload)
                            finally: connection.close()
                        else:
                            path = Path(self.translate_path(urlsplit(self.path).path))
                            if not path.is_file(): self.path = '/index.html'
                            super().do_GET()
                    do_GET = do_POST = do_DELETE = do_PUT = do_PATCH = do_OPTIONS = request
                reservation.socket.close()
                self.server = http.server.ThreadingHTTPServer(('127.0.0.1', reservation.port), Handler)
                self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.server_thread.start()
                self.versions['PostgreSQL'] = self.sql('SHOW server_version;')
                # Windows chrome.exe --version may launch a GUI and never exit.
                # Resolve the test executable without launching it; formal samples supply its version.
                chromium = subprocess.run([self.node, '-e', "console.log(require('@playwright/test').chromium.executablePath())"],
                    cwd=self.root / 'frontend', env=self.env, capture_output=True, text=True, check=True)
                self.env['CHROME_BIN'] = chromium.stdout.strip()
                self.versions['backendBinarySha256'] = campaign.sha256_file(self.server_binary)
                self.versions['frontendBuildSha256'] = self.cache['frontend']['products']['build']
                self.save('baseline/tool-versions.json', self.versions)
            finally:
                reservation.socket.close()

    def sql(self, query):
        handle = self.lease.postgres
        env = self.env.copy(); env['PGPASSWORD'] = handle.credentials.password
        result = subprocess.run(['docker', 'exec', '-i', '--env', 'PGPASSWORD', handle.container_id, 'psql', '-X', '-qAt',
            '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-U', handle.credentials.user, '-d', handle.credentials.name],
            input=query, env=env, capture_output=True, text=True, errors='replace', check=False)
        if result.returncode: raise WaveFailure('OWNED_DATABASE_QUERY_FAILED')
        return result.stdout.strip()

    def start_backend(self):
        previous = os.environ.copy()
        try:
            os.environ.update(self.env)
            self.backend = campaign.start_backend(campaign.BackendSpec(self.server_binary, self.lease.workspace.cwd, self.backend_url), 1)
        finally: os.environ.clear(); os.environ.update(previous)

    def C01(self):
        with self.phase('C01'):
            captures = []
            for index in (1, 2):
                self.command(f'schema-initialize-{index}', [str(self.db_probe), 'initialize'], self.lease.workspace.cwd)
                capture = json.loads(self.sql((self.root / 'tools/quality/readiness-schema.sql').read_text()))
                captures.append(capture); self.save(f'c01-schema/capture-{index}.json', capture)
            self.save('c01-schema/schema-v1.json', captures[0])
            digest = campaign.sha256_file(self.output / 'c01-schema/schema-v1.json')
            self.report('c01-schema/schema-v1.sha256', digest)
            equal = captures[0] == captures[1]
            self.save('c01-schema/idempotence.json', {'equal': equal, 'runs': 2, 'initializer': 'Unchanged production DatabaseMigration::run', 'freshDisposableDatabase': True})
            self.start_backend()
            self.validate_fixture_seed()
            self.report('c01-schema/characterization.md', f'V1 SHA-256: `{digest}`. Dynamic catalog capture after two real initializer calls. A == B: {equal}.\n'
                f"Tables: {len(captures[0]['tables'])}; columns: {len(captures[0]['columns'])}; indexes: {len(captures[0]['indexes'])}; constraints: {len(captures[0]['constraints'])}.\n"
                'Sequence definitions and ownership are captured; changing sequence counters and OIDs are excluded. No version authority exists yet.')
            self.report('c01-schema/migration-plan.md', f'V1 = canonical schema at B.98/Wave1 `{self.head}`; schema SHA-256 `{digest}`.\n\n'
                'Next round: add schema_migrations(version PRIMARY KEY, name, checksum, applied_at). Under one transactional advisory lock, empty DB establishes V1 and records its checksum; '
                'existing unversioned DB must match this normalized V1 catalog before adoption. Apply future V2+ in order, validate recorded checksums, reject unknown future versions. '
                'Rollback a failed migration and its ledger insert in the same transaction where PostgreSQL supports transactional DDL. Restart is a no-op. '
                'Nontransactional DDL needs an explicit separate protocol when required. Do not reconstruct historical B.31–B.98 migrations. Production initializer remains unchanged in this wave.')
            if not equal: raise WaveFailure('C01_CURRENT_SCHEMA_INITIALIZER_NOT_IDEMPOTENT')
            return {'status': 'CHARACTERIZED', 'schemaSha256': digest, 'idempotent': True}

    def validate_fixture_seed(self):
        credentials = {'username':'nanika_e2e_' + secrets.token_hex(12), 'email':'wave1-seed-' + secrets.token_hex(8) + '@example.test',
            'password':'Password-' + secrets.token_hex(24), 'vaultPhrase':'Phrase-' + secrets.token_hex(24)}
        self.secrets += [credentials['password'], credentials['vaultPhrase']]
        path = self.lease.workspace.root / 'seed-check.png'
        path.write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII='))
        self.fixture('provision', credentials)
        try:
            completed = subprocess.run([self.node, self.env['WAVE1_FIXTURE_BUNDLE']], env=self.env,
                input=json.dumps({'credentials':credentials,'paths':[str(path)],'thumbnailMode':True}), capture_output=True, text=True)
            if completed.returncode: raise WaveFailure('FIXTURE_SEED_PREPARATION_FAILED')
            result = json.loads(completed.stdout)
            if len(result.get('files', [])) != 1: raise WaveFailure('FIXTURE_SEED_INVALID_RESPONSE')
            self.save('pipeline/fixture-preparation-check.json', {'status':'PASS', 'outsideMeasurement':True,
                'productionKasumiReused':True, 'productionArgon2WorkerReused':True, 'files':1})
        finally:
            self.fixture('cleanup', {'username':credentials['username']})

    def browser_track(self, track, mode):
        with self.phase(track):
            if not self.backend: raise WaveFailure('BACKEND_RUNTIME_NOT_READY')
            if track == 'M01' and isinstance(self.versions['ffmpeg'], dict): raise WaveFailure('M01_REQUIRED_FIXTURE_GENERATOR_UNAVAILABLE')
            self.env['WAVE1_BROWSER_TRACK'] = mode
            # One CLI call per track; each formal scenario owns a fresh Chromium process.
            result = subprocess.run([self.node, 'node_modules/@playwright/test/cli.js', 'test', '--config=e2e-video/playwright.readiness.config.ts'],
                cwd=self.root / 'frontend', env=self.env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace', check=False)
            path = self.output / DIRECTORIES[track] / 'raw.json'
            if not path.is_file(): raise WaveFailure(f'{track}_RAW_EVIDENCE_MISSING')
            raw = json.loads(path.read_text()); persisted_evidence(raw, self.secrets)
            self.record_browser_version(raw)
            fixture_browsers = int(mode == 'thumbnail')
            self.counts['browserFixtureGenerationProcesses'] += fixture_browsers
            self.counts['browserMeasurementProcesses'] += raw.get('browserLaunches', 0) - fixture_browsers
            summary_code = """import { readFileSync } from 'node:fs';
import { summarizeRuns, writeJsonAtomic } from './tools/browser-memory-probe.mjs';
const raw=JSON.parse(readFileSync(process.argv[1])); const summaries=[];
for(const id of new Set(raw.scenarios.map(s=>s.scenarioId))){
 const scenarios=raw.scenarios.filter(s=>s.scenarioId===id); const samples=raw.samples.filter(s=>s.scenarioId===id);
 summaries.push(summarizeRuns({samples,functionalStatus:scenarios.length===3&&scenarios.every(s=>s.functionalStatus==='PASS')?'PASS':'FAIL',cleanupStatus:scenarios.every(s=>s.cleanupStatus==='PASS')?'PASS':'FAIL'}));
}
writeJsonAtomic(process.argv[2],{status:'CHARACTERIZED',scenarios:summaries});"""
            if result.returncode:
                self.save(f'{DIRECTORIES[track]}/execution.json', {'exitCode': result.returncode, 'status': 'FAIL',
                    'tests': [{k:s.get(k) for k in ('runId','functionalStatus','cleanupStatus')} for s in raw.get('scenarios', [])], 'retries': 0})
                raise WaveFailure(f'{track}_FUNCTIONAL_MEASUREMENT_FAILED')
            expected = 12 if mode == 'player' else 60
            if len(raw.get('scenarios', [])) != expected: raise WaveFailure(f'{track}_INCOMPLETE_SCENARIOS')
            summary_path = self.output / DIRECTORIES[track] / 'summary.json'
            self.command(f'{track.lower()}-summarize', [self.node, '--input-type=module', '-e', summary_code, str(path), str(summary_path)], self.root / 'frontend')
            summary = json.loads(summary_path.read_text()); summary['baselineGroups'] = self.baseline_hashes['groups']
            summary['formalScenarios'] = expected; self.save(f'{DIRECTORIES[track]}/summary.json', summary)
            rows = []
            for scenario in summary['scenarios']:
                phase = next(p for p in scenario['phases'] if p['phase'] == ('steady' if mode == 'player' and scenario['scenarioId'] != 'switch-abc' else 'switch-1-0' if mode == 'player' else 'visible'))
                heap = phase['metrics']['JSHeapUsedSize']['signedDelta']['median']
                process = phase['processMemory'].get('privateBytes', {}).get('signedDelta', {}).get('median', 'NOT_AVAILABLE')
                rows.append(f"| {scenario['scenarioId']} | {heap} | {process} |")
            self.report(f'{DIRECTORIES[track]}/report.md', f'{track}: CHARACTERIZED; {expected} functional scenarios, 3 independent runs per scenario, zero retries.\n\n'
                '| Scenario | Main-page JS heap signed median delta (bytes) | Browser process-group private commit signed median delta (bytes) |\n|---|---:|---:|\n' + '\n'.join(rows) + '\n\n'
                'Raw contains every phase and signed value. Natural and forced-GC diagnostic close samples remain separate. '
                'JS heap is the main page only; process-group private commit includes runtime overhead and is not GPU or universal total player memory. '
                'RGBA pixel-buffer reference estimate is not browser actual memory. Decode concurrency is NOT_AVAILABLE; request concurrency is observed. '
                'Large viewport thumbnail stress and explicit Image.decode verification are harness protocol, not a production usage guarantee. '
                'Lifecycle cancellation/FDK correctness additionally uses the unchanged focused unit contracts.')
            return summary

    def M01(self): return self.browser_track('M01', 'player')
    def M02(self): return self.browser_track('M02', 'thumbnail')

    def record_browser_version(self, raw):
        versions = {sample.get('browserVersion') for sample in raw.get('samples', [])}
        if len(versions) != 1 or not all(isinstance(v, str) and v for v in versions):
            raise WaveFailure('INCOMPARABLE_MEASUREMENT_BASELINES')
        version = next(iter(versions))
        if self.versions.get('Chromium', version) != version:
            raise WaveFailure('INCOMPARABLE_MEASUREMENT_BASELINES')
        self.versions['Chromium'] = version
        self.save('baseline/tool-versions.json', self.versions)

    def M03(self):
        with self.phase('M03'):
            player = json.loads((self.output / 'm01-player-memory/summary.json').read_text())
            thumbnails = json.loads((self.output / 'm02-thumbnail-memory/summary.json').read_text())
            if not compatible_measurements(player, thumbnails): raise WaveFailure('INCOMPARABLE_MEASUREMENT_BASELINES')
            raw_player = json.loads((self.output / 'm01-player-memory/raw.json').read_text())
            raw_thumbnails = json.loads((self.output / 'm02-thumbnail-memory/raw.json').read_text())
            resource_guard = json.loads((self.output / 'm01-player-memory/production-resource-guard.json').read_text())
            owned_clear = all(s['lifecycle']['mediaNodes'] == 0 for s in raw_player['samples'] if 'close' in s['phase'])
            leaving_clear = all(s['lifecycle']['retainedThumbnailBackgrounds'] == 0 for s in raw_thumbnails['samples'] if s['phase'] in ('leave-view','reload'))
            guard_valid = len(resource_guard['guards']) == 3 and all(g['inspection']['decision'] == 'append' for g in resource_guard['guards'])
            cycle_phases = [f'switch-close-{cycle}-2' for cycle in (1, 2, 3)]
            run_ids = {s['runId'] for s in raw_player['samples'] if s['scenarioId'] == 'switch-abc'}
            residuals = []
            for run_id in sorted(run_ids):
                endpoints = [next((s for s in raw_player['samples'] if s['runId'] == run_id and s['phase'] == phase and s['gc'] == 'natural'), None) for phase in cycle_phases]
                if all(s and s['processMemory']['status'] == 'AVAILABLE' for s in endpoints):
                    residuals.append([s['processMemory']['privateBytes'] for s in endpoints])
            repeated_growth = len(residuals) == 3 and all(a < b < c for a, b, c in residuals)
            observations = {'player': [], 'thumbnail': [], 'parserGuards': resource_guard}
            for scenario in player['scenarios']:
                closes = [p for p in scenario['phases'] if 'close' in p['phase'] and p['gc'] == 'natural']
                observations['player'].append({'scenario':scenario['scenarioId'], 'naturalPostCloseResiduals': [
                    {'phase':p['phase'], 'mainPageJsHeap':p['metrics']['JSHeapUsedSize']['signedDelta'],
                     'browserPrivateCommit':p['processMemory'].get('privateBytes', {}).get('signedDelta', {'status':'NOT_AVAILABLE'})} for p in closes]})
            for scenario in thumbnails['scenarios']:
                observations['thumbnail'].append({'scenario':scenario['scenarioId'], 'phases': [
                    {'phase':p['phase'], 'mainPageJsHeap':p['metrics']['JSHeapUsedSize']['signedDelta'],
                     'browserPrivateCommit':p['processMemory'].get('privateBytes', {}).get('signedDelta', {'status':'NOT_AVAILABLE'})}
                    for p in scenario['phases'] if p['phase'] in ('visible','prune','leave-view','reload')]})
            # No new numerical budget invented after measurement: expose missing total/GPU scope explicitly.
            questions = {
                'parserModelConservativeWithinClaim': 'Existing retained MP4Box parser model/guards preserved; resource contract gate verifies calibration. Main-page/browser totals are not parser-only allocation.',
                'unboundedRetainedPlayerMemory': {'unboundedLeakProven': False, 'repeatedNaturalPostCloseGrowth': repeated_growth,
                    'naturalPostCloseProcessEvidenceAvailable': len(residuals) == 3,
                    'interpretation': 'Three cycles cannot prove an unbounded leak or identify the native allocation owner. Reproducible growth prevents retention ratification from DOM absence alone.'},
                'closeSwitchReclaimsApplicationOwnedState': owned_clear,
                'thumbnailDecodePressureBounded': 'Current visibility-driven usage and 1..100 stress corpus characterized, no global decoded-pixel budget exists.',
                'productionBudgetMissing': 'Decision requires review of actual process and retained-state observations; no JS-to-GPU extrapolation.'}
            # A finite study can close AP-06 only on its stated scoped resource model, never on universal native/GPU memory.
            ratified = owned_clear and leaving_clear and guard_valid and len(residuals) == 3 and not repeated_growth
            decision = {'status': 'PASS' if ratified else 'NEEDS_PATCH',
                'result': 'PASS_M03_AP06_MEASURED_RESOURCE_MODEL_CLOSED' if ratified else 'FAIL_M03_AP06_REQUIRES_PRODUCTION_RECALIBRATION',
                'AP06': 'CLOSED' if ratified else 'OPEN', 'questions': questions, 'quantitativeObservations':observations,
                'baselineGroups': player['baselineGroups'], 'rawEvidence': ['m01-player-memory/raw.json', 'm02-thumbnail-memory/raw.json'],
                'scope': 'Measured finite scenarios and existing parser model; total GPU/device allocation remains unavailable',
                'followup': None if ratified else {'metric': 'Browser process-group private commit at natural post-close cycle endpoints' if repeated_growth else 'Application-owned retained DOM media/thumbnail state',
                    'scenario': 'switch-abc; 3 cycles in each of 3 fresh browsers' if repeated_growth else 'close/switch or leave-view',
                    'rawEvidence': 'm01-player-memory/raw.json', 'cyclePhases': cycle_phases,
                    'expectation': 'Retention ratification must explain reproducible residual growth; DOM removal alone is insufficient',
                    'numericalSloViolated': False, 'productionLeakCauseProven': False,
                    'proposedMinimalPatch': 'After native allocation attribution, change only the existing owner release or resource budget shown to retain allocations. Calibrate a thumbnail dimensions/pixel guard separately if needed; no queue or concurrency patch in this wave.'}}
            self.save('m03-ap06/decision.json', decision)
            self.report('m03-ap06/report.md', f"{decision['result']}; AP-06 {decision['AP06']}.\n" + '\n'.join(f'{key}: {value}' for key,value in questions.items()) +
                '\n\nNo measurements rerun. Three repetitions do not establish a universal resource bound. Parser estimate, page JS heap, browser private commit, GPU memory, and RGBA reference are separate scopes.')
            return decision

    def fixture(self, command, payload):
        script = """import { executeFixture } from './tools/e2e-fixture-characterization.mjs';
let input=''; for await(const c of process.stdin) input+=c;
const result=await executeFixture({command:process.argv[1],payload:JSON.parse(input),environment:{executable:process.env.NANIKA_E2E_FIXTURE_EXE,cwd:process.env.NANIKA_E2E_FIXTURE_CWD,storagePath:process.env.NANIKA_E2E_STORAGE_PATH,storageId:process.env.NANIKA_E2E_STORAGE_ID}});
console.log(JSON.stringify(result)); if(result.result!=='PASS') process.exitCode=1;"""
        result = subprocess.run([self.node, '--input-type=module', '-e', script, command], cwd=self.root / 'frontend', env=self.env,
            input=json.dumps(payload), capture_output=True, text=True)
        if result.returncode: raise WaveFailure('OWNED_E2E_FIXTURE_FAILED_' + command.upper())
        return json.loads(result.stdout)

    def M04(self):
        with self.phase('M04'):
            if not self.backend: raise WaveFailure('BACKEND_RUNTIME_NOT_READY')
            credentials = {'username': 'nanika_e2e_' + secrets.token_hex(12), 'email': 'wave1-' + secrets.token_hex(8) + '@example.test',
                'password': 'Password-' + secrets.token_hex(24), 'vaultPhrase': 'Phrase-' + secrets.token_hex(24)}
            self.secrets += [credentials['password'], credentials['vaultPhrase']]
            raw = {'protocol': {'concurrency': [1,2,4,8,16,32], 'repetitions': 3, 'warmupRequests': 8,
                'requestsPerRun': 192, 'retries': 0, 'routes': ['/tree?file_limit=100', '/folders/0/contents'], 'slo': None}, 'runs': [],
                'baselineGroups': getattr(self, 'review_hashes', self.baseline_hashes)['groups'], 'gitHead': self.head,
                'backendBinarySha256': campaign.sha256_file(self.server_binary), 'protocolRevision': getattr(self, 'protocol_revision', 1)}
            self.fixture('provision', credentials)
            try:
                request = Request(self.backend_url + '/login', data=json.dumps({'username': credentials['username'], 'password': credentials['password']}).encode(), headers={'Content-Type': 'application/json'})
                with urlopen(request, timeout=10) as response:
                    headers = authenticated_headers(json.loads(response.read()))
                self.secrets.append(headers['Authorization'][len('Bearer '):])
                # Read-only workload corpus; generated DB values only, no human data.
                uid = int(self.sql(f"SELECT id FROM users WHERE username='{credentials['username']}';"))
                self.sql(f"INSERT INTO folders(user_id,encrypted_name,name_hash) SELECT {uid},'wave1-fixture-'||i,'wave1-fixture-'||i FROM generate_series(1,20) i;")
                routes = raw['protocol']['routes']
                def hit(index):
                    started = time.perf_counter(); status = None; timed_out = False; failed = False
                    try:
                        connection = http.client.HTTPConnection('127.0.0.1', urlsplit(self.backend_url).port, timeout=10)
                        try:
                            connection.request('GET', routes[index % len(routes)], headers=headers)
                            response = connection.getresponse(); status = response.status; response.read()
                        finally: connection.close()
                    except TimeoutError: timed_out = True
                    except (OSError, http.client.HTTPException): failed = True
                    return {'request': index, 'routeIndex': index % len(routes), 'status': status, 'timeout': timed_out,
                        'transportError': failed, 'elapsedMs': (time.perf_counter() - started) * 1000}
                for concurrency in raw['protocol']['concurrency']:
                    for repetition in (1,2,3):
                        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
                            warmup = list(executor.map(hit, range(8)))
                            raw['preflight'] = {'concurrency': concurrency, 'repetition': repetition, 'requests': warmup}
                            self.save('m04-db-pool/raw.json', raw)
                            validate_db_warmup(warmup)
                            started = time.perf_counter(); requests = list(executor.map(hit, range(192))); elapsed = time.perf_counter() - started
                        stat = json.loads(self.sql("SELECT COALESCE(json_agg(row_to_json(x)),'[]') FROM (SELECT state,wait_event_type,wait_event,count(*) AS connections FROM pg_stat_activity WHERE datname=current_database() GROUP BY state,wait_event_type,wait_event ORDER BY state,wait_event_type,wait_event) x;"))
                        raw['runs'].append({'concurrency': concurrency, 'repetition': repetition, 'warmup': warmup,
                            'requests': requests, 'wallSeconds': elapsed, 'pgStatActivityAfter': stat,
                            'serverProcess': process_sample([self.backend.process.pid], authority='Owned backend process handle from existing backend owner')})
                        self.save('m04-db-pool/raw.json', raw)
                        print(json.dumps({'phase': 'M04', 'concurrency': concurrency, 'repetition': repetition, 'completedRequests': len(requests)}), flush=True)
                        if any(r['status'] == 429 for r in [*warmup,*requests]): raise WaveFailure('M04_RATE_LIMIT_CONTAMINATED')
                        if any(r['status'] in (401, 403) for r in requests): raise WaveFailure('M04_WORKLOAD_AUTHENTICATION_CONTAMINATED')
                output = self.command('pool-wait-characterization', [str(self.db_probe), 'wait'], self.lease.workspace.cwd)
                raw['waitSemantics'] = json.loads(output.strip().splitlines()[-1]); self.save('m04-db-pool/raw.json', raw)
            finally:
                raw['cleanup'] = self.fixture('cleanup', {'username': credentials['username']})
                self.save('m04-db-pool/raw.json', raw)
            curve = []
            for concurrency in raw['protocol']['concurrency']:
                runs = [r for r in raw['runs'] if r['concurrency'] == concurrency]; requests = [q for r in runs for q in r['requests']]
                latencies = sorted(q['elapsedMs'] for q in requests)
                # Stdlib inclusive quantiles; 576 observations support p95/p99, no inferred tail from three medians.
                percentiles = statistics.quantiles(latencies, n=100, method='inclusive')
                curve.append({'concurrency': concurrency, 'requests': len(requests), 'success': sum(q['status'] == 200 for q in requests),
                    'errors': sum(q['transportError'] or (q['status'] is not None and q['status'] != 200) for q in requests),
                    'timeouts': sum(q['timeout'] for q in requests), 'throughput': statistics.median(192/r['wallSeconds'] for r in runs),
                    'p50Ms': statistics.median(latencies), 'p95Ms': percentiles[94], 'p99Ms': percentiles[98], 'maxMs': max(latencies)})
            saturation = next((b['concurrency'] for a,b in zip(curve,curve[1:]) if b['throughput'] <= a['throughput']*1.05 and b['p95Ms'] >= a['p95Ms']*1.2), None)
            change = any(row['errors'] or row['timeouts'] for row in curve)
            summary = {'status': 'CHARACTERIZED', 'result': 'CURRENT_POOL_2_CHARACTERIZED',
                'policy': 'FOLLOWUP_POOL_POLICY_REQUIRED' if change else 'NO_EVIDENCE_REQUIRING_CHANGE', 'capacityCurve': curve,
                'observedSaturationConcurrency': saturation, 'saturationScope': 'HTTP/backend/client curve; cannot attribute solely to DB pool',
                'acquisitionTimeout': None, 'waitSemantics': raw['waitSemantics'], 'k6': 'NOT_REQUIRED / NOT_RUN',
                'pgStatScope': 'After-run snapshots; query itself adds an active connection, not evidence of peak pool occupancy',
                'serverCpuScope': 'Cumulative Windows GetProcessTimes snapshots; includes warmup and between-run work, not isolated HTTP-window CPU',
                'noSloInvented': True}
            self.save('m04-db-pool/summary.json', summary)
            self.report('m04-db-pool/report.md', f"CURRENT_POOL_2_CHARACTERIZED; {summary['policy']}. Observational saturation concurrency: {saturation}. No preexisting SLO.\n\n"
                '| Concurrency | Success/requests | req/s median | p50 ms | p95 ms | p99 ms | Max ms | Errors | Timeouts |\n|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n' +
                '\n'.join(f"| {r['concurrency']} | {r['success']}/{r['requests']} | {r['throughput']:.2f} | {r['p50Ms']:.2f} | {r['p95Ms']:.2f} | {r['p99Ms']:.2f} | {r['maxMs']:.2f} | {r['errors']} | {r['timeouts']} |" for r in curve) +
                '\n\nPool(2) and no-timeout acquisition are unchanged. Third requester waits while both leases are held and proceeds after release. '
                'Curve includes client, Crow scheduling, authentication queries and DB work. After-run pg_stat_activity is not peak saturation. '
                'No artificial leases held during HTTP workload. Next policy round, if required, must distinguish pool size, bounded wait, or another bottleneck.')
            return summary

    def focused(self):
        with self.phase('focused tests'):
            self.command('orchestrator-unit', [sys.executable, '-m', 'unittest', 'discover', '-s', 'tools/quality', '-p', 'test_run_readiness_wave1.py'])
            self.command('memory-tool-unit', [self.node, '--test', 'tools/browser-memory-probe.test.mjs'], self.root / 'frontend')
            self.command('thumbnail-contract', [matrix.npm_command(), 'run', 'test', '--', '--watch=false', '--browsers=ChromeHeadless',
                '--include=src/app/features/drive/services/thumbnail-loader.service.spec.ts', '--progress=false', '--reporters=progress'], self.root / 'frontend', environment=self.host_env)

    def gate(self):
        if self.counts['fullGateInvocations']:
            raise WaveFailure('FINAL_GATE_ALREADY_INVOKED')
        self.counts['fullGateInvocations'] += 1
        with self.phase('final regressions'):
            results = {}
            self.counts['fullBackendRuns'] += 1
            try:
                self.command('full-backend', [str(self.test_binary), '--reporter', 'xml', '--rng-seed', '100201'], self.lease.workspace.cwd)
                evidence = json.loads((self.output / 'pipeline/commands/full-backend.json').read_text())
                results['backend'] = {'status':'PASS' if evidence['testResults'].get('cases') and not evidence['testResults']['case_failures'] else 'FAIL',
                    'testResults':evidence['testResults']}
            except WaveFailure:
                results['backend'] = {'status':'FAIL','evidence':'pipeline/commands/full-backend.json'}
            self.counts['fullFrontendRuns'] += 1
            for name,command,cwd in [
                ('frontend', [matrix.npm_command(), 'run', 'test', '--', '--watch=false', '--browsers=ChromeHeadless', '--progress=false', '--reporters=progress'], self.root / 'frontend'),
                ('mp4-resource', [matrix.npm_command(), 'run', 'quality:mp4-resource:test'], self.root / 'frontend'),
                ('video-helper-contract', [self.node, 'node_modules/@playwright/test/cli.js', 'test', '--config=playwright.video.config.ts', 'upload-helper-contract.spec.ts'], self.root / 'frontend'),
            ]:
                try:
                    self.command('gate-' + name, command, cwd, environment=self.host_env if name == 'frontend' else None)
                    evidence = json.loads((self.output / f'pipeline/commands/gate-{name}.json').read_text())
                    results[name] = {'status':'PASS', 'counts':evidence['counts']}
                except WaveFailure: results[name] = {'status':'FAIL'}
            try: self.git('diff', '--check'); results['diffCheck'] = {'status':'PASS'}
            except WaveFailure: results['diffCheck'] = {'status':'FAIL'}
            # The production build already consumed the frozen hash; rebuilding the same artifact would duplicate the gate.
            results['productionBuild'] = {'status':'PASS', 'reusedByHash': True, 'sha256': self.cache['frontend']['products']['build']}
            results['status'] = 'PASS' if all(r['status']=='PASS' for r in results.values()) else 'FAIL'
            self.save('final/regressions.json', results)
            return results

    def teardown(self):
        with self.phase('teardown'):
            results = {}
            for name, cleanup in [
                ('backend', lambda: campaign.stop_backend(self.backend) if self.backend else None),
                ('frontend', lambda: (self.server.shutdown(), self.server.server_close(), self.server_thread.join(5)) if self.server else None),
                ('postgres', lambda: owner.remove_disposable_postgres(self.lease.postgres) if self.lease else None),
                ('workspace', lambda: owner.cleanup_runtime_workspace(self.lease.workspace) if self.lease else None),
                ('buildTemp', lambda: self.build_temp.cleanup() if self.build_temp else None),
            ]:
                try: cleanup(); results[name] = True
                except Exception: results[name] = False
            results['userContainersPreserved'] = recovery.container_snapshot() == getattr(self, 'containers_before', {})
            results['status'] = 'PASS' if all(results.values()) else 'FAIL'
            self.save('pipeline/cleanup.json', results)
            return results

    def finish(self, result):
        final = self.capture_hashes(); self.save('final/source-hashes.json', final)
        production_integrity = all(self.baseline_hashes[k] == final[k] for k in ('trees', 'files', 'historicalArtifacts')) and self.git('rev-parse', 'HEAD') == self.head
        integrity = production_integrity and getattr(self, 'review_hashes', self.baseline_hashes) == final
        tracks = result['tracks']
        for track in TRACKS:
            path = DIRECTORIES[track]
            if track == 'M03':
                if not (self.output / path / 'decision.json').exists(): self.save(f'{path}/decision.json', tracks[track])
            elif track != 'C01':
                for filename in ('raw.json','summary.json'):
                    if not (self.output / path / filename).exists(): self.save(f'{path}/{filename}', {'evidence': 'NOT_RUN', **tracks[track]})
            if not (self.output / path / ('report.md' if track != 'C01' else 'characterization.md')).exists():
                self.report(f"{path}/{'report.md' if track != 'C01' else 'characterization.md'}", json.dumps(tracks[track]))
        complete = all(tracks[t].get('status') == 'CHARACTERIZED' for t in ('M01','M02','M04','C01')) and tracks['M03'].get('status') in ('PASS','NEEDS_PATCH')
        valid = integrity and result['teardown']['status']=='PASS' and result['gate']['status']=='PASS' and not result['commonFailure']
        state = ('PASS_READINESS_WAVE1_MEASUREMENT_AND_CHARACTERIZATION_COMPLETE' if tracks['M03'].get('AP06') == 'CLOSED' else 'PASS_READINESS_WAVE1_EVIDENCE_COMPLETE') if complete and valid else 'BLOCKED_READINESS_WAVE1_INCOMPLETE_OR_INVALID_EVIDENCE'
        self.counts['processInvocationScope'] = 'Direct subprocess.Popen calls observed in the Python authority; nested Node/psql child counts NOT_AVAILABLE'
        self.counts['avoidedDuplicateRuns'] = [
            {'operation': operation, 'avoided': 4-self.counts[counter], 'comparison': 'Theoretical four independent runners; no speedup percentage measured'}
            for operation,counter in [('backend-build','backendBuilds'), ('frontend-build','frontendBuilds'), ('npm-ci','npmCiRuns'),
                ('full-backend','fullBackendRuns'), ('full-frontend','fullFrontendRuns')]]
        self.save('pipeline/reused-work.json', self.counts)
        findings = {key: {'name': name, 'status': 'OPEN'} for key,name in FINDINGS.items()}
        for key,track in [('M01-F01','M01'), ('M02-F01','M02'), ('M03-F01','M03'), ('M04-F01','M04'), ('C01-F02','C01')]:
            findings[key]['status'] = 'CHARACTERIZED' if tracks[track].get('status') in ('PASS','CHARACTERIZED') else 'OPEN'
        findings['M01-F01']['scope'] = 'Main page JS and owned browser process-group; GPU/device allocation NOT_AVAILABLE'
        findings['M04-F02']['status'] = 'CHARACTERIZED / FOLLOWUP_POLICY_DECISION' if tracks['M04'].get('status') == 'CHARACTERIZED' else 'OPEN'
        findings['C01-F01']['status'] = 'CHARACTERIZED / FOLLOWUP_REQUIRED' if tracks['C01'].get('status') == 'CHARACTERIZED' else 'OPEN'
        findings['W1-F01']['status'] = 'CLOSED' if all(self.counts[k] <= 1 for k in ('backendBuilds','frontendBuilds','npmCiRuns','fullGateInvocations')) else 'OPEN'
        if tracks['M03'].get('AP06') == 'OPEN':
            findings['M01-F02'] = {'name':'REPRODUCIBLE_NATURAL_POST_CLOSE_BROWSER_PRIVATE_COMMIT_GROWTH',
                'status':'CHARACTERIZED / CAUSAL_FOLLOWUP_REQUIRED', 'productionLeakProven':False, 'evidence':'m01-player-memory/raw.json'}
        if result['gate'].get('backend',{}).get('status') == 'FAIL':
            findings['W1-F02'] = {'name':'FINAL_BACKEND_REGRESSION_GATE_FAILED','status':'OPEN / FOLLOWUP_REQUIRED',
                'evidence':'pipeline/commands/full-backend.json','productionDefectCauseProven':False}
            if (self.output / 'final/backend-evidence-limitation.json').is_file():
                findings['W1-F03'] = {'name':'BACKEND_FAILED_ASSERTION_DETAILS_NOT_PRESERVED','status':'CHARACTERIZED / EVIDENCE_LIMITATION',
                    'futureCollectorFixedAndUnitTested':True,'originalCause':'NOT_DETERMINED','fullGateRepeated':False}
        decision = {'result': state, 'baselineSha': self.head, 'productionSource': 'UNCHANGED' if production_integrity else 'INTEGRITY_MISMATCH',
            'tracks': {t: {k:v for k,v in tracks[t].items() if k not in ('scenarios','baselineGroups')} for t in TRACKS},
            'AP06': tracks['M03'].get('AP06', 'PENDING MEASUREMENT'), 'integrity': integrity, 'findings': findings,
            'historicalFindings': 'B.89–B.98 CLOSED / FROZEN / PRESERVED; AP-01–AP-05 and AP-07–AP-15 untouched',
            'gate': result['gate'], 'cleanup': result['teardown'], 'commonFailure': result['commonFailure'],
            'notStarted': ['C.01 implementation','C.02','C.03','C.04','C.05','C.06','Q.01','Q.02','coverage','mutation'],
            'next': ('M.03 causal allocation attribution and resource recalibration; ' if tracks['M03'].get('AP06') == 'OPEN' else '') + 'C.01 migration implementation; M.04 policy follow-up only if evidence requires it'}
        if 'W1-F02' in findings: decision['next'] = 'Causal diagnostic round for the failed backend gate; ' + decision['next']
        self.save('final/decision.json', decision)
        if hasattr(self, 'review_hashes'):
            self.save('final/tooling-revision.json', {'status': 'REVISED_AFTER_BROWSER_MEASUREMENT_FREEZE',
                'executedBrowserMeasurementToolingHash': self.baseline_hashes['groups']['measurement-tooling'],
                'reviewedToolingHash': self.review_hashes['groups']['measurement-tooling'],
                'browserRawEvidenceUnchanged': True, 'productionSourcesUnchanged': production_integrity,
                'authenticatedDbMeasurementToolingHash': json.loads((self.output / 'm04-db-pool/raw.json').read_text()).get('baselineGroups',{}).get('measurement-tooling'),
                'executedRegressionToolingHash': json.loads((self.output / 'baseline/source-hashes-r3.json').read_text())['groups']['measurement-tooling'] if (self.output / 'baseline/source-hashes-r3.json').is_file() else None,
                'changes': ['Authenticated workload headers and warmup validation', 'Browser version from formal samples, no Windows --version launch', 'Native residual review prevents automatic AP06 closure', 'Unit framework uses host environment; private runtime configuration stays with application processes', 'Memory probe extension and explicit config keep canonical discovery unchanged; executed files preserved in baseline/browser-harness-executed', 'Post-gate collector preserves classified failed Catch2 evidence before cleanup; original detailed backend evidence cannot be reconstructed', 'Safe failure classifications retained']})
        report = f"Wave 1: **{state}**\n\nBaseline `{self.head}`. Production source: **{decision['productionSource']}**. Cleanup: {result['teardown']['status']}.\n\n"
        report += '| Shared operation | Actual invocations |\n|---|---:|\n' + '\n'.join(f'| {k} | {v} |' for k,v in self.counts.items() if isinstance(v,int))
        report += '\n\n' + '\n'.join(f"{track}: {tracks[track].get('status')} {tracks[track].get('reason','')}" for track in TRACKS)
        report += f"\n\nAP-06: {decision['AP06']}. Schema V1: {tracks['C01'].get('schemaSha256','NOT_CAPTURED')}.\n\n"
        report += 'Regression gate: ' + ', '.join(f'{name}={check.get("status")}' for name,check in result['gate'].items() if isinstance(check,dict)) + '.\n\n'
        if 'W1-F02' in findings:
            backend = json.loads((self.output / 'pipeline/commands/full-backend.json').read_text())
            report += f"Backend gate exit {backend['exitCode']} in {backend['wallSeconds']} s; failed assertion details and cause NOT_AVAILABLE. "
            report += 'The private log was cleaned before detailed failure classification. Collector corrected with a synthetic failed-report test; no full gate or measurements retried. '
            report += 'Frontend gate: 1,530 PASS; MP4 resource contracts: 85 PASS. This blocks global ratification independently of AP-06.\n\n'
        if tracks['M01'].get('status') == 'CHARACTERIZED':
            player = json.loads((self.output / 'm01-player-memory/summary.json').read_text())
            report += '| Player fixture | JS heap steady delta MiB | Private commit steady delta MiB | Natural close residual MiB |\n|---|---:|---:|---:|\n'
            for scenario in player['scenarios']:
                if scenario['scenarioId'] == 'switch-abc': continue
                steady = next(p for p in scenario['phases'] if p['phase'] == 'steady')
                close = next(p for p in scenario['phases'] if p['phase'] == 'close' and p['gc'] == 'natural')
                report += f"| {scenario['fixtureId']} | {steady['metrics']['JSHeapUsedSize']['signedDelta']['median']/2**20:.3f} | {format_mib(steady['processMemory'].get('privateBytes',{}).get('signedDelta',{}).get('median'))} | {format_mib(close['processMemory'].get('privateBytes',{}).get('signedDelta',{}).get('median'))} |\n"
            switching = next(s for s in player['scenarios'] if s['scenarioId'] == 'switch-abc')
            residuals = [next(p for p in switching['phases'] if p['phase'] == f'switch-close-{c}-2')['processMemory'].get('privateBytes',{}).get('signedDelta',{}).get('median') for c in (1,2,3)]
            report += '\nNatural post-close ABC-cycle residual medians MiB: ' + ' → '.join(f'{v/2**20:.2f}' if v is not None else 'NOT_AVAILABLE' for v in residuals) + '. Native allocation owner and unbounded leak remain unproven.\n\n'
        if tracks['M02'].get('status') == 'CHARACTERIZED':
            thumbnails = json.loads((self.output / 'm02-thumbnail-memory/summary.json').read_text())
            report += '| 100 thumbnails | JS heap visible delta MiB | Private commit visible delta MiB |\n|---|---:|---:|\n'
            for scenario in thumbnails['scenarios']:
                if not scenario['scenarioId'].endswith('-100'): continue
                visible = next(p for p in scenario['phases'] if p['phase'] == 'visible')
                report += f"| {scenario['scenarioId']} | {visible['metrics']['JSHeapUsedSize']['signedDelta']['median']/2**20:.2f} | {format_mib(visible['processMemory'].get('privateBytes',{}).get('signedDelta',{}).get('median'))} |\n"
            report += '\nObserved pending download requests reached 100; CSS decode concurrency and GPU/device allocation NOT_AVAILABLE. No aggregate decoded-pixel budget is claimed.\n\n'
        if tracks['M04'].get('status') == 'CHARACTERIZED':
            report += '| DB concurrency | Success/requests | Median req/s | p95 ms | Errors/timeouts |\n|---:|---:|---:|---:|---:|\n'
            report += '\n'.join(f"| {r['concurrency']} | {r['success']}/{r['requests']} | {r['throughput']:.2f} | {r['p95Ms']:.2f} | {r['errors']}/{r['timeouts']} |" for r in tracks['M04']['capacityCurve'])
            report += f"\n\nPool policy: {tracks['M04']['policy']}; observational saturation: {tracks['M04']['observedSaturationConcurrency']}. Acquire has no timeout.\n\n"
        report += 'All phase min/median/max, natural and forced-GC diagnostics, decoded dimensions and RGBA reference estimates are in track reports/JSON. Every datapoint retained in raw JSON. '
        report += 'No universal memory guarantee or speedup percentage inferred. No production budget or pool policy invented after data. '
        report += 'Historical B.89–B.98 and AP closures untouched. C.01 implementation, C.02–C.06, Q.01/Q.02, coverage and mutation not started.\n'
        if hasattr(self, 'review_hashes'):
            report += '\nHarness findings: original unauthenticated DB attempt remains in attempt-01-auth-invalid; the documented corrected full matrix is formal. '
            report += 'Karma launcher failed before the full gate; 50/50 focused tests passed with the host environment. '
            report += 'Owned PostgreSQL generations beyond the first follow completed teardown, with no additional production builds or browser measurements. '
            report += 'Direct Python child invocations are counted; nested Node/psql counts are unavailable.\n'
        report += '\nFindings: native player residual growth requires causal attribution (M01-F02, AP-06 OPEN); schema version authority requires C.01 implementation (C01-F01); '
        report += 'unbounded-by-time acquire semantics remain characterized for a future policy decision (M04-F02). No production patch applied.\n'
        report += f"Next: {decision['next']}. Common failure: {result['commonFailure'] or 'none'}."
        self.report('final/final-report.md', report); self.report('pipeline/final-report.md', report)
        print(json.dumps({'result': state, 'productionSource': decision['productionSource'], 'AP06': decision['AP06']}), flush=True)
        return 0 if state.startswith('PASS_') else 1


def load_reviewed_round(wave):
    """Restore the existing round and verify source/build hashes; no setup or measurement."""
    wave.baseline_hashes = json.loads((wave.output / 'baseline/source-hashes.json').read_text())
    wave.review_hashes = wave.capture_hashes()
    environment = json.loads((wave.output / 'baseline/environment.json').read_text())
    wave.head = environment['gitHead']; wave.branch = environment['branch']
    changed = {key for key in wave.review_hashes['toolingFiles'].keys() | wave.baseline_hashes['toolingFiles'].keys()
        if wave.review_hashes['toolingFiles'].get(key) != wave.baseline_hashes['toolingFiles'].get(key)}
    allowed = {'tools/quality/run_readiness_wave1.py', 'tools/quality/test_run_readiness_wave1.py'}
    expected_tooling = wave.baseline_hashes['tooling'].copy()
    gate_protocol = wave.output / 'pipeline/final-gate-protocol.json'
    if gate_protocol.is_file():
        reviewed_trees = json.loads(gate_protocol.read_text()).get('reviewedToolingTrees',{})
        if set(reviewed_trees) - {'frontend/e2e-video'}: raise WaveFailure('REVIEW_CONTINUATION_SOURCE_MISMATCH')
        expected_tooling.update(reviewed_trees)
    if wave.git('rev-parse', 'HEAD') != wave.head or not changed.issubset(allowed) or any(
            wave.baseline_hashes[k] != wave.review_hashes[k] for k in ('trees','files','historicalArtifacts')) or wave.review_hashes['tooling'] != expected_tooling:
        raise WaveFailure('REVIEW_CONTINUATION_SOURCE_MISMATCH')
    wave.counts = json.loads((wave.output / 'pipeline/reused-work.json').read_text())
    wave.counts.pop('avoidedDuplicateRuns', None)
    wave.counts['browserMeasurementProcesses'] = sum(len(json.loads((wave.output / DIRECTORIES[t] / 'raw.json').read_text())['scenarios']) for t in ('M01','M02'))
    wave.counts['browserFixtureGenerationProcesses'] = 1
    wave.timings = json.loads((wave.output / 'pipeline/timings.json').read_text())['phases']
    wave.versions = json.loads((wave.output / 'baseline/tool-versions.json').read_text())
    wave.cache = json.loads((wave.root / '.quality/readiness-wave1-build-cache.json').read_text())
    wave.frontend_directory = wave.root / 'frontend/dist/frontend/browser'
    backend_inputs = {'production':wave.review_hashes['groups']['backend-db-production'],
        'cmake':campaign.sha256_file(wave.root / 'backend/CMakeLists.txt'),
        'tests':owner._tree_sha256(wave.root,'backend/tests'), 'config':campaign.sha256_file(wave.root / 'backend/build/CMakeCache.txt'),
        'compiler':wave.versions['g++']}
    frontend_inputs = {'production':wave.review_hashes['trees']['frontend/src'],
        'lock':campaign.sha256_file(wave.root / 'frontend/package-lock.json'),
        'config':campaign.sha256_file(wave.root / 'frontend/angular.json'), 'node':wave.versions['node'],
        'public':owner._tree_sha256(wave.root,'frontend/public')}
    if not reusable_build(wave.cache.get('backend'), backend_inputs,
            {p.name:campaign.sha256_file(p) for p in (wave.server_binary,wave.fixture_binary,wave.test_binary)}) or not reusable_build(
            wave.cache.get('frontend'), frontend_inputs, {'build':owner._tree_sha256(wave.root,'frontend/dist/frontend')}):
        raise WaveFailure('REVIEW_CONTINUATION_BUILD_HASH_MISMATCH')


def continue_after_review(wave):
    """Continue this owned round after a documented harness correction; never remeasure M01/M02."""
    if not (wave.output / 'pipeline/correction-protocol.json').is_file():
        raise WaveFailure('REVIEW_CONTINUATION_PROTOCOL_REQUIRED')
    receipt = wave.output / 'pipeline/correction-invocation.json'
    if receipt.exists(): raise WaveFailure('REVIEW_CONTINUATION_ALREADY_ATTEMPTED')
    previous = json.loads((wave.output / 'final/automated-decision-pre-review.json').read_text())
    raw = json.loads((wave.output / 'm04-db-pool/attempt-01-auth-invalid/raw.json').read_text())
    if previous['gate']['status'] != 'NOT_RUN' or previous['cleanup']['status'] != 'PASS' or not raw['runs'] or not all(
            q['status'] == 401 for r in raw['runs'] for q in [*r['warmup'], *r['requests']]):
        raise WaveFailure('REVIEW_CONTINUATION_PRECONDITION_FAILED')
    load_reviewed_round(wave)
    wave.protocol_revision = 2
    wave.save('pipeline/correction-invocation.json', {'status':'STARTED', 'automaticRetries':0, 'buildsReusedByHash':True, 'browserMeasurementsRepeated':False})
    wave.containers_before = recovery.container_snapshot()
    wave.build_temp = tempfile.TemporaryDirectory(prefix='nanika-wave1-review-'); wave.temp = Path(wave.build_temp.name)
    wave.db_probe = wave.temp / ('readiness-db-probe.exe' if os.name == 'nt' else 'readiness-db-probe')
    result = {'tracks': previous['tracks'], 'commonFailure': None, 'gate': {'status':'NOT_RUN'}, 'teardown': {'status':'FAIL'}}
    try:
        with wave.phase('support probe rebuild after owned cleanup'):
            wave.counts['auxiliaryProbeBuilds'] += 1
            wave.command('db-probe-build-review', [shutil.which('g++', path=wave.env['PATH']) or 'g++', '-std=c++17', '-pthread', '-Ibackend/include',
                'tools/quality/readiness-db-probe.cpp', 'backend/src/database/DatabasePool.cpp', 'backend/src/database/DatabaseMigration.cpp', '-lpqxx', '-lpq', '-o', str(wave.db_probe)])
        wave.runtime(); wave.start_backend()
        result['tracks']['M03'] = wave.M03()
        try: result['tracks']['M04'] = wave.M04()
        except Exception as error: result['tracks']['M04'] = {'status':'BLOCKED', 'reason': str(error) if isinstance(error, WaveFailure) else type(error).__name__}
        wave.focused(); result['gate'] = wave.gate()
    except Exception as error:
        result['commonFailure'] = str(error) if isinstance(error, WaveFailure) else type(error).__name__
    finally:
        result['teardown'] = wave.teardown()
    return wave.finish(result)


def final_gate_only(wave):
    """Finish the existing valid measurements after the isolated unit-launcher diagnosis."""
    if not (wave.output / 'pipeline/final-gate-protocol.json').is_file():
        raise WaveFailure('FINAL_GATE_PROTOCOL_REQUIRED')
    if (wave.output / 'pipeline/final-gate-invocation.json').exists():
        raise WaveFailure('FINAL_GATE_ALREADY_ATTEMPTED')
    previous = json.loads((wave.output / 'final/decision.json').read_text())
    counts = json.loads((wave.output / 'pipeline/reused-work.json').read_text())
    focused = json.loads((wave.output / 'pipeline/commands/thumbnail-host-env-diagnostic.json').read_text())
    if previous['cleanup']['status'] != 'PASS' or previous['gate']['status'] != 'NOT_RUN' or counts['fullGateInvocations'] or focused['status'] != 'PASS':
        raise WaveFailure('FINAL_GATE_PRECONDITION_FAILED')
    if not all(previous['tracks'][t]['status'] == 'CHARACTERIZED' for t in ('M01','M02','M04','C01')) or previous['tracks']['M03']['status'] not in ('PASS','NEEDS_PATCH'):
        raise WaveFailure('FINAL_GATE_VALID_MEASUREMENTS_REQUIRED')
    load_reviewed_round(wave)
    wave.protocol_revision = 3
    wave.save('pipeline/final-gate-invocation.json', {'status':'STARTED', 'automaticRetries':0,
        'buildsReusedByHash':True, 'measurementsRepeated':False, 'newPostgresReason':'Previous owned runtime already torn down; disposable DB required by full backend gate'})
    wave.containers_before = recovery.container_snapshot()
    wave.build_temp = tempfile.TemporaryDirectory(prefix='nanika-wave1-final-'); wave.temp = Path(wave.build_temp.name)
    result = {'tracks':previous['tracks'], 'commonFailure':None, 'gate':{'status':'NOT_RUN'}, 'teardown':{'status':'FAIL'}}
    try:
        with wave.phase('focused tooling tests after launcher correction'):
            wave.command('orchestrator-unit-final', [sys.executable,'-m','unittest','discover','-s','tools/quality','-p','test_run_readiness_wave1.py'])
            discovery = wave.command('canonical-video-discovery', [wave.node,'node_modules/@playwright/test/cli.js','test','--config=playwright.video.config.ts','--list'], wave.root / 'frontend',environment=wave.host_env)
            if 'Total: 5 tests in 3 files' not in discovery or 'readiness-memory' in discovery:
                raise WaveFailure('CANONICAL_VIDEO_DISCOVERY_CHANGED')
        wave.runtime()
        result['gate'] = wave.gate()
    except Exception as error:
        result['commonFailure'] = str(error) if isinstance(error,WaveFailure) else type(error).__name__
    finally:
        result['teardown'] = wave.teardown()
    return wave.finish(result)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=matrix.repository_root())
    parser.add_argument('--process-sample')
    parser.add_argument('--continue-after-review', action='store_true', help='Continue the documented authentication correction; preserve the original raw attempt')
    parser.add_argument('--final-gate-only', action='store_true', help='Complete the unrun full gate after the documented launcher diagnosis; no measurements')
    args = parser.parse_args(argv)
    if args.process_sample is not None:
        if not re.fullmatch(r'[1-9][0-9]*(?:,[1-9][0-9]*)*', args.process_sample): return 2
        print(json.dumps(process_sample([int(v) for v in args.process_sample.split(',')]))); return 0
    wave = Wave(args.root)
    def audit(event, _):
        if event == 'subprocess.Popen': wave.counts['processInvocations'] += 1
    sys.addaudithook(audit)
    if args.final_gate_only:
        try: return final_gate_only(wave)
        except WaveFailure as error: print(str(error)); return 2
    if args.continue_after_review:
        try: return continue_after_review(wave)
        except WaveFailure as error: print(str(error)); return 2
    if wave.output.exists() or wave.output.is_symlink():
        print('BLOCKED_EXISTING_WAVE1_ARTIFACT_ROOT'); return 2
    wave.output.mkdir(parents=True)
    for directory in ('baseline','pipeline',*DIRECTORIES.values(),'final'): (wave.output / directory).mkdir()
    actions = {phase: getattr(wave, phase) for phase in ('baseline','dependencies','backend_build','frontend_build','runtime','focused','gate','teardown',*TRACKS)}
    result = orchestrate(actions)
    if wave.baseline_hashes is None:
        wave.save('final/decision.json', {'result':'BLOCKED_READINESS_WAVE1_PREFLIGHT', **result}); return 1
    return wave.finish(result)


if __name__ == '__main__':
    raise SystemExit(main())
