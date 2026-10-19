"""Shared freeze validation; it never launches a browser or publishes scientific evidence."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile

from ap06_authorities import (checked_path, private_permissions, relative_path, sha256,
    validate_owned_destination, verify_publication)
from run_readiness_wave1 import WaveFailure

ERRORS = {
    'inputs': 'R12R11_FREEZE_INPUTS_INVALID',
    'native-authority': 'R12R11_FREEZE_NATIVE_AUTHORITY_INVALID',
    'preflight': 'R12R11_FREEZE_PREFLIGHT_INVALID',
    'custody': 'R12R11_FREEZE_CUSTODY_INVALID',
    'publication': 'R12R11_FREEZE_PUBLICATION_FAILED',
    'readback': 'R12R11_FREEZE_READBACK_FAILED',
    'integrity': 'R12R11_FREEZE_INTEGRITY_FAILED',
}
NATIVE_FILES = {
    'server': 'nanika_ap06_local_server.exe', 'productionServer': 'savebox_server.exe',
    'fixture': 'nanika_e2e_fixture.exe', 'productionTests': 'savebox_tests.exe',
    'experimentalTests': 'nanika_ap06_tests.exe', 'compileCommands': 'compile_commands.json',
    'cmakeCache': 'CMakeCache.txt',
}
DYNAMIC_INPUTS = frozenset((
    'tooling/angular-unit-1.json', 'baseline/preflight-ready.json',
    'pipeline/preflight-started.json', 'pipeline/development-reservation.json',
    'baseline/offline-ready.json', 'baseline/freeze-readiness.json',
    'baseline/native-capability.json', 'pipeline/native-receipt.json',
    'baseline/offline-integration.json', 'tooling/offline-simulation/result.json',
    'tooling/offline-simulation/measurement-consumers.json',
))
RUNTIME_INPUTS=('authority-config.local.json','backend-runtime.local.json','player-auth.local.json')


def strict_freeze_namespace(output):
    return Path(output).name in ('readiness-wave12-r11-factorial','readiness-wave12-r11-native',
        'readiness-wave12-r12-factorial','readiness-wave12-r12-native','readiness-wave12-r13-native',
        'readiness-wave12-r14-native')


def load_native_budget(path, expected, task_sha):
    path = Path(path)
    if not path.is_file():
        raise ValueError('NATIVE_BUDGET_FILE_MISSING')
    raw = path.read_bytes()

    try:
        budget = json.loads(raw.decode('utf-8-sig'))
    except (UnicodeError, ValueError):
        raise ValueError('NATIVE_BUDGET_JSON_INVALID') from None

    if (
        not isinstance(budget, dict)
        or budget.get('approved') is not True
        or budget.get('approvedByTaskSha256') != task_sha
        or set(budget.keys()) != {'approved', 'approvedByTaskSha256', *expected.keys()}
        or any(
            type(budget.get(key)) is not int
            or budget[key] != value
            for key, value in expected.items()
        )
    ):
        raise ValueError('NATIVE_BUDGET_AUTHORITY_INVALID')

    return budget


class FreezeFailure(WaveFailure):
    def __init__(self, stage, error_type):
        self.stage = stage
        self.failure_class = ERRORS[stage]
        self.error_type = error_type
        super().__init__(self.failure_class)


@contextmanager
def freeze_stage(stage):
    try:
        yield
    except FreezeFailure:
        raise
    except (RuntimeError, OSError, ValueError, KeyError, TypeError, IndexError,
            AttributeError, subprocess.SubprocessError) as error:
        raise FreezeFailure(stage, type(error).__name__) from None


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def regular_file(path, root):
    path = checked_path(Path(path).absolute())
    if not path.is_relative_to(Path(root).absolute()) or not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError('AP06_FREEZE_SOURCE_INVALID')
    return path


def verify_private_sources(paths):
    if os.name!='nt':return
    script="""$ErrorActionPreference='Stop';
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    foreach($p in ($env:AP06_FREEZE_PRIVATE_PATHS | ConvertFrom-Json)) {
      $acl=Get-Acl -LiteralPath $p;
      if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'AP06_FREEZE_FILE_OWNER'};
      foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value){throw 'AP06_FREEZE_FILE_SHARED'};
      }
    }"""
    subprocess.run(['powershell','-NoProfile','-NonInteractive','-Command',script],
        env=dict(os.environ,AP06_FREEZE_PRIVATE_PATHS=json.dumps([str(p) for p in paths])),
        check=True,capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW)


def runtime_input_manifest(wave):
    rows=[]
    for name in RUNTIME_INPUTS:
        path=regular_file(wave.output/'baseline'/name,wave.output)
        rows.append({'path':path.relative_to(wave.root).as_posix(),'size':path.stat().st_size,'sha256':sha256(path)})
    verify_private_sources([wave.root/row['path'] for row in rows])
    return rows


def native_source_files(wave):
    names = wave.git('ls-files', 'backend/CMakeLists.txt', 'backend/include', 'backend/src', 'backend/tests').splitlines()
    if not names:
        raise ValueError('AP06_NATIVE_SOURCE_AUTHORITY_MISSING')
    return {name: sha256(regular_file(wave.root/name, wave.root)) for name in names}


def validate_compile_scope(commands):
    for target,experimental in (('nanika_ap06_local_server',True),('nanika_ap06_tests',True),
            ('savebox_server',False),('savebox_tests',False),('nanika_e2e_fixture',False)):
        rows=[row for row in commands if f'CMakeFiles/{target}.dir/' in row['command'].replace('\\','/')]
        # #ifdef enables the bypass even for an unvalued definition or =0.
        if not rows or any(('NANIKA_AP06_LOCAL_TEST_SERVER' in row['command'])!=experimental for row in rows):
            raise ValueError('AP06_NATIVE_COMPILATION_SCOPE_INVALID')


def validate_test_receipt(output, tests):
    required=('python','node','typescript','angularBuild','native')
    if Path(output).name not in ('readiness-wave12-r13-native','readiness-wave12-r14-native'):required+=('global',)
    if tests.get('status')!='PASS' or any(tests.get(name,{}).get('status') not in
            (('PASS','DOCUMENTED_EXCEPTION') if name=='global' else ('PASS',)) for name in required):
        raise ValueError('AP06_FREEZE_TEST_AUTHORITY_INVALID')


def validate_native_build_authority(wave):
    """A missing header requires a separately published build, never a provenance string."""
    with freeze_stage('native-authority'):
        backend = read(wave.output/'baseline/experimental-backend.json')
        receipt = read(wave.output/'baseline/native-binary-reuse.json')
        build = wave.output/'tooling/backend-build'
        artifacts = {key: sha256(regular_file(build/name, wave.output)) for key, name in NATIVE_FILES.items()}
        if (backend.get('status') != 'PASS' or receipt.get('status') != 'PASS' or
                receipt.get('artifacts') != artifacts or backend.get('binarySha256') != artifacts['server'] or
                backend.get('compileCommandsSha256') != artifacts['compileCommands'] or
                backend.get('cmakeCacheSha256') != artifacts['cmakeCache'] or
                receipt.get('crowHeaderSha256') != backend.get('crowHeaderSha256')):
            raise ValueError('AP06_NATIVE_BUILD_HASH_MISMATCH')
        sources = native_source_files(wave)
        if receipt.get('sourceFiles') != sources:
            raise ValueError('AP06_NATIVE_BUILD_SOURCE_MISMATCH')
        validate_compile_scope(read(build/'compile_commands.json'))
        header = wave.root/'backend/include/crow_all.h'
        if header.exists() or header.is_symlink():
            if sha256(regular_file(header, wave.root)) != backend['crowHeaderSha256']:
                raise ValueError('AP06_CROW_HEADER_HASH_MISMATCH')
        else:
            anchor = receipt['authority']
            root = checked_path(Path(anchor['root']))
            validate_owned_destination(root, anchor['identity'])
            verify_publication(root, anchor['identity'], anchor['publication'])
            if sha256(root/'manifests'/f"{anchor['publication']}.json") != anchor['manifestSha256']:
                raise ValueError('AP06_NATIVE_AUTHORITY_MANIFEST_CHANGED')
            origin = read(root/'native-build/receipt.json')
            if (origin.get('artifacts') != artifacts or origin.get('sourceFiles') != sources or
                    origin.get('crowHeaderSha256') != backend.get('crowHeaderSha256') or
                    sha256(root/'native-build/crow_all.h') != origin.get('crowHeaderSha256')):
                raise ValueError('AP06_NATIVE_AUTHORITY_READBACK_MISMATCH')
            for key, name in NATIVE_FILES.items():
                if sha256(root/'native-build'/name) != artifacts[key]:
                    raise ValueError('AP06_NATIVE_AUTHORITY_BINARY_MISMATCH')
        return backend


def validate_freeze_plan(wave, files, publications, *, preflight_complete, include_manifest=False):
    """Validate the same collector output before reservation and before publication."""
    with freeze_stage('inputs'):
        private_permissions(wave.output)
        private_permissions(wave.output/'baseline')
        versions=read(wave.output/'baseline/versions.json')
        identity=read(wave.output/'baseline/browser-identity.json')
        binaries=((Path(versions['nodeExecutable']),versions['nodeSha256']),
            (Path(versions['chromium']['executablePath']),versions['chromium']['sha256']),
            (Path(versions['postgres']['bin'])/'postgres.exe',versions['postgres']['serverSha256']))
        if (versions['chromium']['executablePath']!=identity['executablePath'] or
                versions['chromium']['sha256']!=identity['executableSha256'] or
                any(not checked_path(path).is_file() or sha256(path)!=digest for path,digest in binaries)):
            raise ValueError('AP06_FREEZE_RUNTIME_IDENTITY_CHANGED')
        tests=read(wave.output/'baseline/tests.json')
        validate_test_receipt(wave.output,tests)
        rows = []
        deferred = []
        for name, source in sorted(files.items()):
            relative_path('source/'+name)
            local = source.relative_to(wave.output).as_posix() if source.is_relative_to(wave.output) else None
            if local in DYNAMIC_INPUTS and not preflight_complete:
                deferred.append(local)
                continue
            source = regular_file(source, wave.root)
            rows.append({'path': name, 'size': source.stat().st_size, 'sha256': sha256(source)})
        if not rows:
            raise ValueError('AP06_FREEZE_EMPTY_INPUTS')
        static = [row for row in rows if not any(row['path'] == wave.output.relative_to(wave.root).as_posix()+'/'+p for p in DYNAMIC_INPUTS)]
        verify_private_sources([files[row['path']] for row in rows if files[row['path']].is_relative_to(wave.output)])
        runtime=runtime_input_manifest(wave)
        digest = hashlib.sha256(json.dumps(static+runtime, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    with freeze_stage('publication'):
        config = read(wave.output/'baseline/authority-config.local.json')
        root = validate_owned_destination(Path(config['AP06_AUTHORITY_ROOT']), config['identity'])
        prefix = wave.output.name.replace('readiness-wave', 'r')
        if (root/prefix/'tooling/source').exists():
            raise ValueError('AP06_FREEZE_PARTIAL_PUBLICATION_EXISTS')
        for name in ('implementation', 'freeze', 'freeze-complete'):
            relative_path('manifests/'+prefix+'-'+name+'.json')
            if (root/'manifests'/f'{prefix}-{name}.json').exists():
                raise ValueError('AP06_FREEZE_PUBLICATION_ALREADY_EXISTS')
        for name in files:
            if (root/prefix/'tooling/source'/name).exists():
                raise ValueError('AP06_FREEZE_PARTIAL_PUBLICATION_EXISTS')
        # A transient non-scientific file proves the owned destination is writable.
        with tempfile.TemporaryFile(dir=root) as probe:
            probe.write(b'AP06 freeze readiness write probe'); probe.flush(); os.fsync(probe.fileno())
    with freeze_stage('readback'):
        for name in ('corpus-publication', *publications):
            verify_publication(root, config['identity'], name)
    return {'status': 'PASS', 'inputCount': len(rows), 'sourceManifestSha256': digest,
        'deferredInputs': sorted(deferred), 'preflightComplete': preflight_complete,
        'implementationHead': wave.git('rev-parse', 'HEAD').strip(), 'scientificChromium': 0,
        'reservationCreated': False,**({'inputs':rows,'runtimeInputs':runtime} if include_manifest else {})}


def verify_freeze_completion(wave, frozen):
    with freeze_stage('integrity'):
        complete = read(wave.output/'baseline/freeze-complete.json')
        if (complete.get('status') != 'FROZEN' or complete.get('freezeSha256') != sha256(wave.output/'tooling/freeze.json') or
                complete.get('implementationHead') != frozen.get('implementationHead') or
                complete.get('independentReadback') is not True):
            raise ValueError('AP06_FREEZE_COMPLETION_INVALID')
        config = read(wave.output/'baseline/authority-config.local.json')
        root = Path(config['AP06_AUTHORITY_ROOT'])
        prefix=wave.output.name.replace('readiness-wave','r')
        if sha256(root/prefix/'freeze/freeze.json')!=complete['freezeSha256']:
            raise ValueError('AP06_FREEZE_PUBLISHED_SNAPSHOT_CHANGED')
        name = prefix+'-freeze-complete'
        manifest = verify_publication(root, config['identity'], name)
        if (len(manifest['files']) != 1 or manifest['files'][0]['path']!=prefix+'/evidence/freeze-complete.json' or
                manifest['files'][0]['sha256'] != sha256(wave.output/'baseline/freeze-complete.json')):
            raise ValueError('AP06_FREEZE_COMPLETION_CHANGED')
