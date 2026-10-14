"""Quiesced PostgreSQL + Local recovery. Fresh restore only; never deletes operator data."""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/quality'))
from run_backend_shards import write_json_atomic
from run_playwright_campaign import sha256_file


class RecoveryError(RuntimeError): pass


def current_authority():
    """Reuse C.01's actual identity AND catalog query, without copying its schema model."""
    source = (ROOT / 'backend/src/database/DatabaseMigration.cpp').read_text(encoding='utf-8')
    try:
        record = {'version': int(re.search(r'kCurrentSchemaVersion = (\d+);', source)[1]),
                  'name': re.search(r'kV1Name = "([^"]+)";', source)[1],
                  'checksum': re.search(r'kV1Checksum = "([a-f0-9]{64})";', source)[1]}
        query = source.split('R"catalog(', 1)[1].split(')catalog"', 1)[0]
    except (AttributeError, TypeError, IndexError):
        raise RecoveryError('RECOVERY_SCHEMA_AUTHORITY_NOT_SUPPORTED') from None
    if record['version'] != 1: raise RecoveryError('RECOVERY_SCHEMA_AUTHORITY_NOT_SUPPORTED')
    return record, query


def checked_run(argv, **kwargs):
    """No stderr, command text, passwords or DB payloads in public failures."""
    try:
        result = subprocess.run(argv, stderr=subprocess.DEVNULL, check=False, **kwargs)
    except (OSError, subprocess.SubprocessError):
        raise RecoveryError('RECOVERY_PROCESS_UNAVAILABLE') from None
    if result.returncode: raise RecoveryError(f'RECOVERY_PROCESS_FAILED_EXIT_{result.returncode}')
    return result


class ComposeRuntime:
    def __init__(self, compose_file, project=None):
        self.prefix = ['docker', 'compose', '-f', str(compose_file.resolve())]
        if project: self.prefix += ['--project-name', project]

    def compose(self, *args, **kwargs):
        return checked_run([*self.prefix, *args], **kwargs)

    def backend_running(self):
        result = self.compose('ps', '--status', 'running', '-q', 'backend', stdout=subprocess.PIPE)
        return bool(result.stdout.strip())

    def stop_backend(self): self.compose('stop', 'backend', stdout=subprocess.DEVNULL)
    def start_backend(self): self.compose('start', 'backend', stdout=subprocess.DEVNULL)

    def storage_root(self):
        # Compose config may contain secrets; use it only in memory, never log or serialize it.
        result = self.compose('config', '--format', 'json', stdout=subprocess.PIPE)
        try:
            volumes = json.loads(result.stdout)['services']['backend']['volumes']
            mounts = [v for v in volumes if v.get('target') == '/app/nanika_storage' and v.get('type') == 'bind']
            if len(mounts) != 1: raise ValueError()
            return Path(mounts[0]['source'])
        except (KeyError, TypeError, ValueError): raise RecoveryError('RECOVERY_STORAGE_BIND_INVALID') from None

    def database(self, executable, *args, **kwargs):
        # POSTGRES_* already belongs to the selected container; no password on argv/stdout.
        script = f'exec {executable} --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" "$@"'
        return self.compose('exec', '-T', 'postgres-db', 'sh', '-c', script, 'nanika-recovery', *args, **kwargs)

    def query(self, sql):
        result = self.database('psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode(), stdout=subprocess.PIPE)
        return result.stdout.decode('utf-8').strip()

    def dump(self, path):
        with path.open('xb') as output:
            self.database('pg_dump', '--format=custom', '--no-owner', '--no-privileges', stdout=output)
            output.flush(); os.fsync(output.fileno())

    def restore_dump(self, path):
        with path.open('rb') as source:
            self.database('pg_restore', '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges',
                          stdin=source, stdout=subprocess.DEVNULL)


def schema_authority(runtime):
    expected, query = current_authority()
    try:
        history = json.loads(runtime.query("SELECT COALESCE(json_agg(json_build_object('version',version,'name',name,"
                            "'checksum',checksum,'hasAppliedAt',applied_at IS NOT NULL) ORDER BY version),'[]'::json) "
                            "FROM schema_migrations;"))
        if history != [{**expected, 'hasAppliedAt': True}]: raise ValueError()
        catalog = json.loads(runtime.query(query))
        serialized = json.dumps(catalog, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
        fingerprint = hashlib.sha256(serialized).hexdigest()
        source = (ROOT / 'backend/src/database/DatabaseMigration.cpp').read_text(encoding='utf-8')
        alias = re.search(r'kV1DumpRestoreCatalogFingerprint = "([a-f0-9]{64})";', source)
        if fingerprint != expected['checksum'] and (alias is None or fingerprint != alias[1]): raise ValueError()
    except (TypeError, ValueError, RecoveryError): raise RecoveryError('BACKUP_SCHEMA_AUTHORITY_INVALID') from None
    return expected


FRESH_QUERY = """SELECT (NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public') AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public') AND NOT EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
 WHERE n.nspname='public'))::text;"""


def require_fresh_database(result):
    if result.strip() != 'true': raise RecoveryError('RESTORE_DATABASE_NOT_FRESH')


def relative_path(value):
    if not isinstance(value, str) or not value or '\\' in value or ':' in value or '\x00' in value:
        raise RecoveryError('BACKUP_PATH_INVALID')
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ('.', '..') for part in path.parts) or path.as_posix() != value or value == '.':
        raise RecoveryError('BACKUP_PATH_INVALID')
    return path


def safe_tree(root):
    """All regular files; no following links, junctions, devices or ambiguous hardlinks."""
    root = Path(root)
    def check(path):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0):
            raise RecoveryError('BACKUP_SYMLINK_REJECTED')
        if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise RecoveryError('BACKUP_SPECIAL_FILE_REJECTED')
        if stat.S_ISREG(info.st_mode) and info.st_nlink != 1: raise RecoveryError('BACKUP_HARDLINK_REJECTED')
        return info
    if not stat.S_ISDIR(check(root).st_mode): raise RecoveryError('BACKUP_STORAGE_ROOT_INVALID')
    files = []
    def visit(directory):
        for path in sorted(directory.iterdir()):
            info = check(path)
            if stat.S_ISDIR(info.st_mode): visit(path)
            else:
                relative = path.relative_to(root).as_posix(); relative_path(relative)
                files.append((relative, path, info))
    visit(root)
    return sorted(files)


def private_mode(path, mode):
    if os.name == 'posix': path.chmod(mode)


def copy_regular(source, target, recorded):
    """Check opened identity before reading. O_NOFOLLOW where the platform exposes it."""
    target.parent.mkdir(parents=True, exist_ok=True)
    private_mode(target.parent, 0o700)
    descriptor = os.open(source, os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(descriptor, 'rb') as input_file:
        actual = os.fstat(input_file.fileno())
        if not stat.S_ISREG(actual.st_mode) or actual.st_nlink != 1 or (actual.st_dev, actual.st_ino) != (recorded.st_dev, recorded.st_ino):
            raise RecoveryError('BACKUP_SOURCE_CHANGED')
        with target.open('xb') as output:
            shutil.copyfileobj(input_file, output); output.flush(); os.fsync(output.fileno())
    private_mode(target, 0o600)


def remove_staging(path, parent, prefix):
    if path.is_symlink() or path.resolve().parent != parent.resolve() or not path.name.startswith(prefix):
        raise RecoveryError('RECOVERY_STAGING_CLEANUP_BOUNDARY_INVALID')
    shutil.rmtree(path)


def unique_json(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise RecoveryError('BACKUP_DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def verify(backup, *, staging=False):
    backup = Path(backup)
    if not staging and '.partial-' in backup.name: raise RecoveryError('BACKUP_NOT_COMPLETED')
    actual_files = {name: (path, info) for name, path, info in safe_tree(backup)}
    if not (backup / 'storage').is_dir(): raise RecoveryError('BACKUP_STORAGE_ROOT_MISSING')
    if 'manifest.json' not in actual_files or 'postgres.dump' not in actual_files:
        raise RecoveryError('BACKUP_REQUIRED_FILE_MISSING')
    try: manifest = json.loads((backup / 'manifest.json').read_text(encoding='utf-8'), object_pairs_hook=unique_json)
    except (OSError, ValueError): raise RecoveryError('BACKUP_MANIFEST_INVALID') from None
    if not isinstance(manifest, dict) or manifest.get('formatVersion') != 1: raise RecoveryError('BACKUP_FORMAT_VERSION_UNSUPPORTED')
    expected, _ = current_authority()
    database = manifest.get('database', {})
    if not isinstance(database, dict) or not isinstance(manifest.get('storage'), dict) or not isinstance(manifest['storage'].get('files'), list):
        raise RecoveryError('BACKUP_MANIFEST_INVALID')
    if manifest.get('consistencyMode') != 'backend-quiesced' or {key: database.get(key) for key in expected} != expected:
        raise RecoveryError('BACKUP_SCHEMA_AUTHORITY_INVALID')
    if database.get('format') != 'pg_dump-custom' or database.get('sha256') != sha256_file(backup / 'postgres.dump'):
        raise RecoveryError('BACKUP_DUMP_HASH_MISMATCH')
    names = set(); folded = set(); total = 0
    try:
        rows = manifest['storage']['files']
        for row in rows:
            if not isinstance(row, dict): raise RecoveryError('BACKUP_MANIFEST_INVALID')
            name = relative_path(row['path']).as_posix()
            if name in names or name.casefold() in folded: raise RecoveryError('BACKUP_DUPLICATE_PATH')
            names.add(name); folded.add(name.casefold())
            path, info = actual_files.get('storage/' + name, (None, None))
            if type(row['bytes']) is not int or row['bytes'] < 0 or info is None or info.st_size != row['bytes']:
                raise RecoveryError('BACKUP_STORAGE_SIZE_MISMATCH')
            if row['sha256'] != sha256_file(path): raise RecoveryError('BACKUP_STORAGE_HASH_MISMATCH')
            total += row['bytes']
        if manifest['storage']['fileCount'] != len(names) or manifest['storage']['totalBytes'] != total:
            raise RecoveryError('BACKUP_STORAGE_TOTAL_MISMATCH')
    except (KeyError, TypeError): raise RecoveryError('BACKUP_MANIFEST_INVALID') from None
    if set(actual_files) != {'manifest.json', 'postgres.dump', *('storage/' + name for name in names)}:
        raise RecoveryError('BACKUP_UNEXPECTED_FILE')
    return manifest


def backup(runtime, destination):
    destination = Path(destination).absolute()
    if destination.exists() or destination.is_symlink(): raise RecoveryError('BACKUP_DESTINATION_ALREADY_EXISTS')
    source = runtime.storage_root().absolute()
    if destination.resolve().is_relative_to(source.resolve()): raise RecoveryError('BACKUP_DESTINATION_INSIDE_STORAGE')
    running = runtime.backend_running(); staging = None
    try:
        if running: runtime.stop_backend()
        if runtime.backend_running(): raise RecoveryError('BACKUP_BACKEND_NOT_QUIESCED')
        authority = schema_authority(runtime)
        # Validate BEFORE copying; backend is stopped throughout both data authorities.
        files = safe_tree(source)
        destination.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=destination.name + '.partial-', dir=destination.parent))
        private_mode(staging, 0o700)
        runtime.dump(staging / 'postgres.dump'); private_mode(staging / 'postgres.dump', 0o600)
        (staging / 'storage').mkdir(mode=0o700)
        rows = []
        for name, path, info in files:
            target = staging / 'storage' / name; copy_regular(path, target, info)
            rows.append({'path': name, 'bytes': target.stat().st_size, 'sha256': sha256_file(target)})
        head = checked_run(['git', '-c', 'safe.directory=' + ROOT.as_posix(), 'rev-parse', 'HEAD'],
                           cwd=ROOT, stdout=subprocess.PIPE).stdout.decode().strip()
        manifest = {'formatVersion': 1, 'consistencyMode': 'backend-quiesced',
            'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'gitHead': head,
            'database': {'format': 'pg_dump-custom', 'sha256': sha256_file(staging / 'postgres.dump'), **authority},
            'storage': {'files': rows, 'fileCount': len(rows), 'totalBytes': sum(row['bytes'] for row in rows)},
            'externalStorage': {'googleDriveBytesIncluded': False}, 'environmentSecretsIncluded': False,
            'databaseContainsSensitiveState': True,
            'permissionEnforcement': 'POSIX_0700_0600' if os.name == 'posix' else 'NOT_AVAILABLE'}
        write_json_atomic(staging / 'manifest.json', manifest); private_mode(staging / 'manifest.json', 0o600)
        with (staging / 'manifest.json').open('r+b') as manifest_file: os.fsync(manifest_file.fileno())
        verify(staging, staging=True)
        if destination.exists() or destination.is_symlink(): raise RecoveryError('BACKUP_DESTINATION_ALREADY_EXISTS')
        staging.rename(destination); staging = None
        return manifest
    finally:
        try:
            if staging is not None: remove_staging(staging, destination.parent, destination.name + '.partial-')
        finally:
            if running:
                runtime.start_backend()
                if not runtime.backend_running(): raise RecoveryError('BACKUP_BACKEND_RESTART_FAILED')


def restore(runtime, backup_root, storage_target):
    manifest = verify(backup_root)  # All backup bytes validated BEFORE target DB/storage mutation.
    target = Path(storage_target).absolute()
    if target.exists() or target.is_symlink(): raise RecoveryError('RESTORE_STORAGE_TARGET_NOT_FRESH')
    if target.resolve().is_relative_to(Path(backup_root).resolve()): raise RecoveryError('RESTORE_STORAGE_TARGET_OVERLAPS_BACKUP')
    if runtime.backend_running(): raise RecoveryError('RESTORE_BACKEND_MUST_BE_STOPPED')
    require_fresh_database(runtime.query(FRESH_QUERY))
    if not target.parent.is_dir(): raise RecoveryError('RESTORE_STORAGE_PARENT_MISSING')
    staging = Path(tempfile.mkdtemp(prefix='.nanika-storage-restore-', dir=target.parent))
    try:
        private_mode(staging, 0o700)
        source_files = {name: (path, info) for name, path, info in safe_tree(Path(backup_root) / 'storage')}
        for row in manifest['storage']['files']:
            path, info = source_files[row['path']]; copied = staging / row['path']
            copy_regular(path, copied, info)
            if copied.stat().st_size != row['bytes'] or sha256_file(copied) != row['sha256']:
                raise RecoveryError('RESTORE_STORAGE_COPY_MISMATCH')
        if runtime.backend_running(): raise RecoveryError('RESTORE_BACKEND_MUST_BE_STOPPED')
        require_fresh_database(runtime.query(FRESH_QUERY))
        runtime.restore_dump(Path(backup_root) / 'postgres.dump')
        if schema_authority(runtime) != {key: manifest['database'][key] for key in ('version', 'name', 'checksum')}:
            raise RecoveryError('RESTORE_SCHEMA_AUTHORITY_MISMATCH')
        if target.exists() or target.is_symlink(): raise RecoveryError('RESTORE_STORAGE_TARGET_NOT_FRESH')
        staging.rename(target); staging = None
        return manifest  # Operator explicitly starts current backend for C.01 no-op/startup validation.
    finally:
        if staging is not None: remove_staging(staging, target.parent, '.nanika-storage-restore-')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--compose-file', type=Path, default=ROOT / 'docker-compose.yml')
    parser.add_argument('--project')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('backup').add_argument('--destination', type=Path, required=True)
    commands.add_parser('verify').add_argument('--backup', type=Path, required=True)
    restore_parser = commands.add_parser('restore')
    restore_parser.add_argument('--backup', type=Path, required=True)
    restore_parser.add_argument('--storage-target', type=Path, required=True)
    args = parser.parse_args()
    try:
        runtime = ComposeRuntime(args.compose_file, args.project)
        if args.command == 'backup': manifest = backup(runtime, args.destination)
        elif args.command == 'verify': manifest = verify(args.backup)
        else: manifest = restore(runtime, args.backup, args.storage_target)
        print(json.dumps({'status': 'PASS', 'operation': args.command, 'storageFiles': manifest['storage']['fileCount']}))
        return 0
    except (RecoveryError, OSError) as error:
        print(json.dumps({'status': 'FAIL', 'code': str(error) if isinstance(error, RecoveryError) else 'RECOVERY_FILESYSTEM_FAILED'}))
        return 1


if __name__ == '__main__': raise SystemExit(main())
