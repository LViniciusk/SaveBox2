import json
import hashlib
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'operations'))
import nanika_recovery as recovery


class FakeRuntime:
    def __init__(self, storage, running=False, fail=False):
        self.storage = storage; self.running = running; self.fail = fail; self.calls = []
        self.password = 'unit-password-never-persist'; self.token = 'unit-provider-token-never-persist'
    def storage_root(self): return self.storage
    def backend_running(self): self.calls.append('state'); return self.running
    def stop_backend(self): self.calls.append('stop'); self.running = False
    def start_backend(self): self.calls.append('start'); self.running = True
    def dump(self, path):
        self.calls.append('dump')
        if self.running: raise AssertionError('dump must be quiesced')
        if self.fail: raise recovery.RecoveryError('TEST_DUMP_FAILED')
        path.write_bytes(b'custom-dump-test')
    def query(self, _): self.calls.append('query'); return 'true'
    def restore_dump(self, _): self.calls.append('restore')


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name); self.storage = self.root / 'source'; self.storage.mkdir()
        (self.storage / '123.dat').write_bytes(b'ciphertext')
        (self.storage / '123.proxy.dat').write_bytes(b'proxy')
        (self.storage / 'storage-moves').mkdir(); (self.storage / 'storage-moves/item-1.part').write_bytes(b'partial')
        self.authority = {'version': 1, 'name': 'unit-v1', 'checksum': 'a' * 64}
        authority = patch.object(recovery, 'current_authority', return_value=(self.authority, 'unit-catalog-query'))
        authority.start(); self.addCleanup(authority.stop)
        self.schema = patch.object(recovery, 'schema_authority', return_value=self.authority); self.schema.start(); self.addCleanup(self.schema.stop)
        self.git = patch.object(recovery, 'checked_run', return_value=SimpleNamespace(stdout=b'unit-head\n')); self.git.start(); self.addCleanup(self.git.stop)

    def make_backup(self, name='complete', running=False):
        runtime = FakeRuntime(self.storage, running)
        destination = self.root / name
        return runtime, destination, recovery.backup(runtime, destination)

    def write_manifest(self, path, manifest):
        (path / 'manifest.json').write_text(json.dumps(manifest))

    def test_backup_order_atomic_format_entire_tree_and_no_secrets(self):
        runtime, destination, manifest = self.make_backup(running=True)
        self.assertLess(runtime.calls.index('stop'), runtime.calls.index('dump'))
        self.assertEqual(runtime.calls[-2:], ['start', 'state']); self.assertTrue(runtime.running)
        self.assertEqual(manifest['storage']['fileCount'], 3)
        self.assertEqual(recovery.verify(destination), manifest)
        self.assertFalse(list(self.root.glob('*.partial-*')))
        for secret in (runtime.password, runtime.token): self.assertNotIn(secret, json.dumps(manifest))
        self.assertFalse(manifest['environmentSecretsIncluded'])

    def test_large_file_hash_is_streamed_and_byte_identical(self):
        payload = bytes(range(256)) * 9000
        path = self.root / 'large.dat'; path.write_bytes(payload)
        with patch.object(Path, 'read_bytes', side_effect=AssertionError('unbounded file read')):
            self.assertEqual(recovery.sha256_file(path), hashlib.sha256(payload).hexdigest())

    def test_empty_storage_directory_is_required_even_with_zero_files(self):
        empty = self.root / 'empty'; empty.mkdir(); destination = self.root / 'empty-backup'
        recovery.backup(FakeRuntime(empty), destination)
        (destination / 'storage').rmdir()
        with self.assertRaisesRegex(recovery.RecoveryError, 'STORAGE_ROOT_MISSING'): recovery.verify(destination)

    def test_destination_must_not_exist(self):
        runtime, destination, _ = self.make_backup()
        with self.assertRaisesRegex(recovery.RecoveryError, 'ALREADY_EXISTS'): recovery.backup(runtime, destination)

    def test_stopped_service_stays_stopped_and_manifest_deterministic(self):
        runtime, _, first = self.make_backup('first')
        _, _, second = self.make_backup('second')
        first.pop('createdAt'); second.pop('createdAt'); self.assertEqual(first, second)
        self.assertNotIn('start', runtime.calls); self.assertNotIn('stop', runtime.calls)

    def test_failure_removes_only_owned_partial_and_restores_service(self):
        runtime = FakeRuntime(self.storage, running=True, fail=True)
        with self.assertRaisesRegex(recovery.RecoveryError, 'TEST_DUMP_FAILED'): recovery.backup(runtime, self.root / 'bad')
        self.assertTrue(runtime.running); self.assertEqual(runtime.calls[-2:], ['start', 'state'])
        self.assertFalse((self.root / 'bad').exists()); self.assertFalse(list(self.root.glob('bad.partial-*')))
        self.assertTrue((self.storage / '123.dat').exists())

    def test_refuses_backup_if_stop_did_not_stop_backend(self):
        runtime = FakeRuntime(self.storage, running=True)
        runtime.stop_backend = lambda: runtime.calls.append('stop')
        with self.assertRaisesRegex(recovery.RecoveryError, 'NOT_QUIESCED'): recovery.backup(runtime, self.root / 'bad')
        self.assertNotIn('dump', runtime.calls)

    def test_restart_command_success_does_not_prove_running_state(self):
        runtime = FakeRuntime(self.storage, running=True)
        runtime.start_backend = lambda: runtime.calls.append('start')
        with self.assertRaisesRegex(recovery.RecoveryError, 'BACKEND_RESTART_FAILED'):
            recovery.backup(runtime, self.root / 'completed-before-restart')
        self.assertFalse(runtime.running)

    def test_partial_and_missing_dump_not_accepted(self):
        _, destination, _ = self.make_backup()
        partial = self.root / 'backup.partial-owned'; destination.rename(partial)
        with self.assertRaisesRegex(recovery.RecoveryError, 'NOT_COMPLETED'): recovery.verify(partial)
        partial.rename(destination); (destination / 'postgres.dump').unlink()
        with self.assertRaisesRegex(recovery.RecoveryError, 'REQUIRED_FILE_MISSING'): recovery.verify(destination)

    def test_manifest_paths_versions_duplicates_and_totals(self):
        _, destination, manifest = self.make_backup()
        for bad in ('/absolute', '../escape', 'a/../escape', 'C:/drive', 'a\\b', 'a//b', './123.dat'):
            with self.subTest(path=bad), self.assertRaises(recovery.RecoveryError): recovery.relative_path(bad)
        for mutation, code in [
            (lambda m: m.update(formatVersion=2), 'VERSION_UNSUPPORTED'),
            (lambda m: m['storage']['files'].append(m['storage']['files'][0]), 'DUPLICATE_PATH'),
            (lambda m: m['storage'].update(totalBytes=0), 'TOTAL_MISMATCH'),
            (lambda m: m['storage']['files'][0].update(bytes=999), 'SIZE_MISMATCH'),
            (lambda m: m['storage']['files'][0].update(sha256='0' * 64), 'HASH_MISMATCH'),
        ]:
            value = json.loads(json.dumps(manifest)); mutation(value); self.write_manifest(destination, value)
            with self.subTest(code=code), self.assertRaisesRegex(recovery.RecoveryError, code): recovery.verify(destination)

    def test_symlink_special_file_and_hardlink_rejected(self):
        original = Path.lstat; fixture = self.storage / '123.dat'
        for mode, links, code in [(stat.S_IFLNK, 1, 'SYMLINK'), (stat.S_IFIFO, 1, 'SPECIAL'), (stat.S_IFREG, 2, 'HARDLINK')]:
            def lstat(path, *args, **kwargs):
                if path == fixture: return SimpleNamespace(st_mode=mode, st_nlink=links, st_file_attributes=0)
                return original(path, *args, **kwargs)
            with self.subTest(mode=mode), patch.object(Path, 'lstat', lstat), self.assertRaisesRegex(recovery.RecoveryError, code):
                recovery.safe_tree(self.storage)

    def test_tamper_restore_rejected_before_any_target_action(self):
        _, destination, _ = self.make_backup(); (destination / 'storage/123.dat').write_bytes(b'corrupted!')
        target_runtime = FakeRuntime(self.root / 'unused')
        with self.assertRaises(recovery.RecoveryError): recovery.restore(target_runtime, destination, self.root / 'restored')
        self.assertEqual(target_runtime.calls, []); self.assertFalse((self.root / 'restored').exists())

    def test_overlapping_paths_and_cleanup_boundary_rejected(self):
        runtime, destination, _ = self.make_backup()
        with self.assertRaisesRegex(recovery.RecoveryError, 'INSIDE_STORAGE'):
            recovery.backup(runtime, self.storage / 'nested-backup')
        with self.assertRaisesRegex(recovery.RecoveryError, 'OVERLAPS_BACKUP'):
            recovery.restore(runtime, destination, destination / 'restored')
        with self.assertRaisesRegex(recovery.RecoveryError, 'CLEANUP_BOUNDARY_INVALID'):
            recovery.remove_staging(self.storage, self.root, 'not-owned-')
        self.assertTrue(self.storage.exists())

    def test_fresh_target_and_database_parser_enforced(self):
        for value in ('false', 't', '1', '', 'true\nfalse'):
            with self.subTest(value=value), self.assertRaisesRegex(recovery.RecoveryError, 'DATABASE_NOT_FRESH'):
                recovery.require_fresh_database(value)
        recovery.require_fresh_database('true\n')
        runtime, destination, _ = self.make_backup()
        with self.assertRaisesRegex(recovery.RecoveryError, 'STORAGE_TARGET_NOT_FRESH'):
            recovery.restore(runtime, destination, self.storage)
        runtime.running = True
        with self.assertRaisesRegex(recovery.RecoveryError, 'BACKEND_MUST_BE_STOPPED'):
            recovery.restore(runtime, destination, self.root / 'restored')

    def test_restore_publishes_verified_storage_without_start(self):
        runtime, destination, _ = self.make_backup()
        target = self.root / 'restored'; recovery.restore(runtime, destination, target)
        self.assertEqual((target / '123.dat').read_bytes(), b'ciphertext')
        self.assertEqual((target / 'storage-moves/item-1.part').read_bytes(), b'partial')
        self.assertNotIn('start', runtime.calls); self.assertFalse(list(self.root.glob('.nanika-storage-restore-*')))

    def test_subprocess_failure_is_sanitized_and_binary_stdout_not_decoded(self):
        self.git.stop()
        with patch.object(recovery.subprocess, 'run', return_value=subprocess.CompletedProcess([], 7, stderr=b'secret payload')):
            with self.assertRaisesRegex(recovery.RecoveryError, '^RECOVERY_PROCESS_FAILED_EXIT_7$'):
                recovery.checked_run(['unused'], stdout=subprocess.PIPE)

    def test_schema_history_and_fingerprint_are_checked_not_repaired(self):
        self.schema.stop()
        runtime = FakeRuntime(self.storage)
        runtime.query = lambda _: '[]'
        with self.assertRaisesRegex(recovery.RecoveryError, 'SCHEMA_AUTHORITY_INVALID'): recovery.schema_authority(runtime)
        self.assertNotIn('restore', runtime.calls)

    def test_catalog_drift_rejected_even_with_valid_ledger(self):
        self.schema.stop()
        runtime = FakeRuntime(self.storage)
        runtime.query = lambda query: json.dumps([{**self.authority, 'hasAppliedAt': True}]) if 'FROM schema_migrations' in query else '{}'
        with self.assertRaisesRegex(recovery.RecoveryError, 'SCHEMA_AUTHORITY_INVALID'): recovery.schema_authority(runtime)

    def test_compose_database_args_use_container_environment_and_binary_stream(self):
        self.git.stop()
        runtime = recovery.ComposeRuntime(self.root / 'compose.yml', 'owned-test')
        with patch.object(recovery.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, stdout=b'')) as run:
            runtime.dump(self.root / 'dump')
            argv = run.call_args.args[0]
            self.assertIn('--format=custom', argv); self.assertIn('postgres-db', argv)
            self.assertIn('$POSTGRES_USER', argv[argv.index('-c') + 1])
            self.assertNotIn('text', run.call_args.kwargs); self.assertNotIn('encoding', run.call_args.kwargs)
            self.assertEqual(run.call_args.kwargs['stderr'], subprocess.DEVNULL)


if __name__ == '__main__': unittest.main()
