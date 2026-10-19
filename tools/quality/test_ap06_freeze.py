import copy
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import ap06_authorities as authority
from ap06_freeze import (FreezeFailure, NATIVE_FILES, native_source_files,
    validate_native_build_authority, verify_freeze_completion, validate_compile_scope)
import run_ap06_r9 as freezer


class FreezePipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.output = self.root/'.quality/readiness-wave12-r11-factorial'
        self.output.mkdir(parents=True)
        authority.private_permissions(self.output, create=True)
        for name in ('baseline', 'pipeline', 'tooling/backend-build', 'fixtures', 'tooling/app'):
            (self.output/name).mkdir(parents=True, exist_ok=True)
        authority.private_permissions(self.output/'baseline', create=True)
        self.tracked = ['backend/CMakeLists.txt', 'backend/src/server.cpp', 'frontend/src/app.ts',
            'tools/harness.mjs', 'tools/runner.py', 'tools/quality/ap06_authorities.py']
        for name in self.tracked:
            self.write(self.root/name, '// synthetic source\n')
        shutil.copyfile(Path(authority.__file__), self.root/'tools/quality/ap06_authorities.py')
        self.write(self.root/'backend/include/crow_all.h', '// synthetic owned header\n')
        self.write(self.output/'fixtures/manifest.json', '[]')
        self.write(self.output/'fixtures/cipher.bin', 'synthetic corpus bytes')
        for name in ('budget', 'workload', 'backend-authority', 'historical-r9', 'versions', 'tests'):
            self.save('baseline/'+name+'.json', {'fileMapping': []} if name == 'backend-authority' else {})
        self.write(self.output/'baseline/task.md', 'synthetic offline contract test')
        self.write(self.output/'tooling/kasumi.cjs', '// synthetic')
        self.write(self.root/'postgres.exe','synthetic runtime binary')
        runtime=str(self.root/'postgres.exe');digest=authority.sha256(runtime)
        self.save('baseline/versions.json',{'nodeExecutable':runtime,'nodeSha256':digest,
            'chromium':{'executablePath':runtime,'sha256':digest},
            'postgres':{'bin':str(self.root),'serverSha256':digest}})
        self.save('baseline/browser-identity.json',{'executablePath':runtime,'executableSha256':digest})
        self.save('baseline/tests.json',dict(status='PASS',syntheticContractFixture=True,
            **{name:{'status':'PASS'} for name in ('python','node','typescript','angularBuild','native','global')}))
        for name in ('native-production.xml','native-experimental.xml'):
            self.write(self.output/'baseline'/name,'<synthetic-contract-fixture/>')
        for name in ('index.html', 'main.js', 'crypto.js', 'transmux.js'):
            self.write(self.output/'tooling/app'/name, name)
        self.identity = 'a'*64
        self.authority = self.root/'authority'
        authority.initialize(self.authority, self.identity, campaign='AP-06-R10')
        self.save('baseline/authority-config.local.json', {
            'AP06_AUTHORITY_ROOT': str(self.authority), 'identity': self.identity})
        self.save('baseline/backend-runtime.local.json',{'syntheticContractFixture':True})
        self.save('baseline/player-auth.local.json',{'syntheticContractFixture':True})
        for name in ('corpus-publication', 'custody'):
            authority.publish_snapshot(self.authority, self.identity, name,
                {'test/'+name+'.json': self.output/'fixtures/manifest.json'}, self.output/'pipeline')
        outer = self
        class Wave:
            root, output = outer.root, outer.output
            def git(self, *args):
                if args == ('ls-files',): return '\n'.join(outer.tracked)
                if args and args[0] == 'ls-files': return '\n'.join(n for n in outer.tracked if n.startswith('backend/'))
                if args == ('status', '--porcelain'): return ''
                return '1'*40
            def save(self, relative, value): outer.save(relative, value)
        self.wave = Wave()
        self.create_build()
        self.products_patch = patch.object(freezer, 'build_products', side_effect=self.products)
        self.products_patch.start()
        products, workers = self.products()[1:]
        self.unit = {'status': 'PASS', 'unitBrowserLaunches': 1, 'appProducts': products,
            'pageScriptSha256': 'b'*64, 'multiplexedContract': {
                'workerHashes': {kind: row['sha256'] for kind, row in workers.items()},
                'fixtureHash': authority.sha256(self.output/'fixtures/manifest.json')}}

    def tearDown(self):
        self.products_patch.stop()
        self.temp.cleanup()

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding='utf-8')

    def save(self, name, value):
        self.write(self.output/name, json.dumps(value))

    def products(self, *_args):
        files = list((self.output/'tooling/app').iterdir())
        products = {p.relative_to(self.root).as_posix(): authority.sha256(p) for p in files}
        workers = {kind: {'sha256': authority.sha256(self.output/'tooling/app'/name)}
            for kind, name in (('crypto', 'crypto.js'), ('transmux', 'transmux.js'))}
        return {}, products, workers

    def create_build(self):
        build = self.output/'tooling/backend-build'
        for name in NATIVE_FILES.values(): self.write(build/name, 'synthetic '+name)
        commands = [{'command': f'cc CMakeFiles/{target}.dir/file.cpp '+('-DNANIKA_AP06_LOCAL_TEST_SERVER=1' if experimental else '')}
            for target, experimental in (('nanika_ap06_local_server', True), ('nanika_ap06_tests', True),
                ('savebox_server', False), ('savebox_tests', False), ('nanika_e2e_fixture', False))]
        self.write(build/'compile_commands.json', json.dumps(commands))
        artifacts = {key: authority.sha256(build/name) for key, name in NATIVE_FILES.items()}
        self.backend = {'status': 'PASS', 'binarySha256': artifacts['server'],
            'compileCommandsSha256': artifacts['compileCommands'], 'cmakeCacheSha256': artifacts['cmakeCache'],
            'crowHeaderSha256': authority.sha256(self.root/'backend/include/crow_all.h')}
        self.reuse = {'status': 'PASS', 'artifacts': artifacts, 'sourceFiles': native_source_files(self.wave),
            'crowHeaderSha256':self.backend['crowHeaderSha256']}
        self.save('baseline/experimental-backend.json', self.backend)
        self.save('baseline/native-binary-reuse.json', self.reuse)

    def readiness(self, complete=False):
        return freezer.validate_freeze_readiness(self.wave,
            output=self.output.relative_to(self.root).as_posix(), extra_publications=('custody',),
            preflight_complete=complete)

    def freeze(self):
        freezer.freeze_implementation(self.wave, output=self.output.relative_to(self.root).as_posix(),
            harness='tools/harness.mjs', runner_path=self.root/'tools/runner.py', extra_publications=('custody',))

    def materialize_preflight(self):
        self.save('baseline/freeze-readiness.json', self.readiness())
        self.save('tooling/angular-unit-1.json', self.unit)

    def test_shared_collector_and_real_publication_independent_readback(self):
        ready = self.readiness()
        self.assertFalse(ready['reservationCreated'])
        self.assertIn('tooling/angular-unit-1.json', ready['deferredInputs'])
        self.materialize_preflight()
        self.assertEqual(self.readiness(True)['sourceManifestSha256'], ready['sourceManifestSha256'])
        self.freeze()
        frozen = json.loads((self.output/'tooling/freeze.json').read_text())
        freezer.verify_freeze(self.wave, frozen)
        verify_freeze_completion(self.wave, frozen)
        self.assertEqual(json.loads((self.output/'baseline/freeze-complete.json').read_text())['status'], 'FROZEN')
        local=self.output/'tooling/freeze.json';original=local.read_bytes();local.write_text('{}')
        with self.assertRaises(FreezeFailure): verify_freeze_completion(self.wave, frozen)
        local.write_bytes(original)
        published=self.authority/'r12-r11-factorial/freeze/freeze.json';published.write_text('{}')
        manifest=self.authority/'manifests/r12-r11-factorial-freeze.json'
        changed=json.loads(manifest.read_text());changed['files'][0].update(size=2,sha256=authority.sha256(published))
        manifest.write_text(json.dumps(changed),encoding='utf-8')
        with self.assertRaises(FreezeFailure):verify_freeze_completion(self.wave,frozen)

    def test_missing_static_input_and_directory_rejected_before_reservation(self):
        path = self.output/'baseline/historical-r9.json'
        path.unlink()
        with self.assertRaisesRegex(FreezeFailure, 'FREEZE_INPUTS_INVALID'): self.readiness()
        path.mkdir()
        with self.assertRaisesRegex(FreezeFailure, 'FREEZE_INPUTS_INVALID'): self.readiness()
        self.assertFalse((self.output/'pipeline/development-reservation.json').exists())

    def test_header_present_and_tampered_or_absent_without_authority(self):
        validate_native_build_authority(self.wave)
        path = self.root/'backend/include/crow_all.h'
        path.write_text('changed')
        with self.assertRaisesRegex(FreezeFailure, 'NATIVE_AUTHORITY_INVALID'): self.readiness()
        path.unlink()
        self.backend['crowHeaderSource'] = 'reused R7 build receipt'
        self.save('baseline/experimental-backend.json', self.backend)
        with self.assertRaises(FreezeFailure): self.readiness()

    def test_missing_header_requires_independent_build_manifest_and_matching_binaries(self):
        origin = dict(self.reuse, crowHeaderSha256=self.backend['crowHeaderSha256'])
        self.save('baseline/origin-build.json', origin)
        files = {'native-build/receipt.json': self.output/'baseline/origin-build.json',
            'native-build/crow_all.h': self.root/'backend/include/crow_all.h'}
        files.update({'native-build/'+name: self.output/'tooling/backend-build'/name for name in NATIVE_FILES.values()})
        result = authority.publish_snapshot(self.authority, self.identity, 'native-build', files, self.output/'pipeline')
        self.reuse['authority'] = {'root': str(self.authority), 'identity': self.identity,
            'publication': 'native-build', 'manifestSha256': result['manifestSha256']}
        self.save('baseline/native-binary-reuse.json', self.reuse)
        (self.root/'backend/include/crow_all.h').unlink()
        validate_native_build_authority(self.wave)
        (self.authority/'native-build/receipt.json').write_text('{}')
        with self.assertRaises(FreezeFailure): validate_native_build_authority(self.wave)

    def test_binary_source_and_compilation_scope_tampering(self):
        for name in ('savebox_server.exe', 'nanika_e2e_fixture.exe', 'nanika_ap06_local_server.exe'):
            path = self.output/'tooling/backend-build'/name
            original = path.read_bytes();path.write_bytes(b'tampered')
            with self.assertRaises(FreezeFailure): validate_native_build_authority(self.wave)
            path.write_bytes(original)
        self.reuse['sourceFiles']['backend/src/server.cpp'] = '0'*64
        self.save('baseline/native-binary-reuse.json', self.reuse)
        with self.assertRaises(FreezeFailure): validate_native_build_authority(self.wave)

    def test_zero_and_unvalued_macro_definitions_are_rejected_for_production(self):
        commands=json.loads((self.output/'tooling/backend-build/compile_commands.json').read_text())
        validate_compile_scope(commands)
        for flag in (' -DNANIKA_AP06_LOCAL_TEST_SERVER=0',' -DNANIKA_AP06_LOCAL_TEST_SERVER'):
            invalid=copy.deepcopy(commands)
            next(row for row in invalid if 'CMakeFiles/savebox_server.dir/' in row['command'])['command']+=flag
            with self.assertRaisesRegex(ValueError,'COMPILATION_SCOPE_INVALID'):validate_compile_scope(invalid)

    def test_app_worker_corpus_changes_or_incomplete_preflight_block_freeze(self):
        self.materialize_preflight()
        for name in ('tooling/app/main.js', 'tooling/app/crypto.js', 'fixtures/manifest.json'):
            path = self.output/name;original = path.read_bytes();path.write_bytes(b'changed')
            with self.assertRaises((FreezeFailure, RuntimeError)): self.freeze()
            path.write_bytes(original)
        bad = copy.deepcopy(self.unit);bad['status'] = 'FAIL'
        self.save('tooling/angular-unit-1.json', bad)
        with self.assertRaisesRegex(FreezeFailure, 'PREFLIGHT_INVALID'): self.freeze()

    def test_publication_collision_and_readback_mismatch_fail_offline(self):
        self.write(self.authority/'r12-r11-factorial/tooling/source/partial.txt', 'partial')
        with self.assertRaisesRegex(FreezeFailure, 'PUBLICATION_FAILED'): self.readiness()
        (self.authority/'r12-r11-factorial/tooling/source/partial.txt').unlink()
        for name in ('r12-r11-factorial/tooling/source', 'r12-r11-factorial/tooling', 'r12-r11-factorial'):
            (self.authority/name).rmdir()
        authority.publish_snapshot(self.authority,self.identity,'r12-r11-factorial-freeze-complete',
            {'r12-r11-factorial/evidence/freeze-complete.json':self.output/'baseline/budget.json'},self.output/'pipeline')
        with self.assertRaisesRegex(FreezeFailure,'PUBLICATION_FAILED'):self.readiness()
        (self.authority/'manifests/r12-r11-factorial-freeze-complete.json').unlink()
        (self.authority/'r12-r11-factorial/evidence/freeze-complete.json').unlink()
        # Unknown stray authority content also invalidates existing publication readback.
        self.write(self.authority/'stray.txt', 'stray')
        with self.assertRaisesRegex(FreezeFailure, 'READBACK_FAILED'): self.readiness()

    def test_publication_refusal_never_marks_frozen_or_retries(self):
        self.materialize_preflight()
        with patch.object(freezer, 'publish', side_effect=OSError('private source path')):
            with self.assertRaisesRegex(FreezeFailure, 'PUBLICATION_FAILED') as caught: self.freeze()
        self.assertNotIn('private', str(caught.exception))
        self.assertFalse((self.output/'baseline/freeze-complete.json').exists())
        self.assertFalse((self.output/'tooling/freeze.json').exists())
        self.assertTrue((self.output/'pipeline/freeze-attempt.json').exists())

    def test_source_escape_and_reparse_point_rejected(self):
        with self.assertRaises(ValueError):
            from ap06_freeze import regular_file
            regular_file(self.root.parent/'outside', self.root)
        link = self.output/'fixtures/linked'
        try: link.symlink_to(self.output/'fixtures/cipher.bin')
        except OSError: self.skipTest('Windows symlink privilege unavailable')
        with self.assertRaises(FreezeFailure): self.readiness()

    def test_versions_and_test_authorities_are_validated_before_reservation(self):
        self.save('baseline/versions.json',{})
        with self.assertRaisesRegex(FreezeFailure,'FREEZE_INPUTS_INVALID'):self.readiness()

    def test_r16_strict_freeze_namespace_and_test_receipt(self):
        from ap06_freeze import strict_freeze_namespace, validate_test_receipt
        self.assertTrue(strict_freeze_namespace('.quality/readiness-wave12-r16-native'))
        self.assertTrue(strict_freeze_namespace(self.root / '.quality/readiness-wave12-r16-native'))
        # R16 does not require 'global' test key in validate_test_receipt, matching R13/R14 native protocol
        tests_without_global = {
            'status': 'PASS',
            'python': {'status': 'PASS'},
            'node': {'status': 'PASS'},
            'typescript': {'status': 'PASS'},
            'angularBuild': {'status': 'PASS'},
            'native': {'status': 'PASS'},
        }
        # Does not raise ValueError
        validate_test_receipt('.quality/readiness-wave12-r16-native', tests_without_global)
        # But failing sub-test does raise
        with self.assertRaisesRegex(ValueError, 'AP06_FREEZE_TEST_AUTHORITY_INVALID'):
            validate_test_receipt('.quality/readiness-wave12-r16-native', {**tests_without_global, 'python': {'status': 'FAIL'}})


if __name__ == '__main__': unittest.main()
