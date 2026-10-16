import copy
import unittest
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from ap06_browser_identity import validate_process, metadata, verify_identity, ExecutableLease, regular_path, process_information, powershell


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.identity = dict(executablePath='C:/owned/chrome-headless-shell.exe', executableSha256='a'*64,
            executableBytes=123, chromiumVersion='151.0.7922.34', architecture='x64', mode='headless-shell')
        self.process = dict(pid=71, parentPid=42, creationTime=133000000000000000,
            executablePath=self.identity['executablePath'], executableSha256='a'*64, executableBytes=123,
            chromiumVersion=self.identity['chromiumVersion'], architecture='x64',
            args=[self.identity['executablePath'], '--headless', '--autoplay-policy=no-user-gesture-required'])

    def check(self, process=None, previous=None):
        return validate_process(self.identity, process or self.process, 71, 42,
            self.process['args'], ['--autoplay-policy=no-user-gesture-required'], previous)

    def test_real_association_contract(self):
        self.assertEqual(self.check()['status'], 'PASS')
        self.assertEqual(self.check(previous=self.check())['status'], 'PASS')

    def test_precise_r2_failure_and_independent_corruptions(self):
        for field, value in [('executablePath', 'C:/owned/chrome.exe'),
                ('executableSha256', 'b'*64), ('chromiumVersion', '151.0.7922.35'),
                ('pid', 72), ('parentPid', 43), ('architecture', 'arm64'),
                ('args', [self.identity['executablePath'], '--headless'])]:
            with self.subTest(field=field):
                process = copy.deepcopy(self.process); process[field] = value
                with self.assertRaises(ValueError): self.check(process)
        frozen_chrome = dict(self.identity, executablePath='C:/owned/chrome.exe')
        with self.assertRaises(ValueError):
            validate_process(frozen_chrome, self.process, 71, 42, self.process['args'], [])

    def test_pid_reuse_and_missing_os_evidence(self):
        previous = self.check(); process = dict(self.process, creationTime=self.process['creationTime']+1)
        with self.assertRaises(ValueError): self.check(process, previous)
        for field in self.process:
            process = dict(self.process); del process[field]
            with self.subTest(field=field), self.assertRaises((ValueError, KeyError)):
                self.check(process)

    @unittest.skipUnless(os.name=='nt','Windows APIs')
    def test_real_file_lease_hash_missing_installation_and_reparse(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); image=root/'shell.exe'; shutil.copyfile(sys.executable,image)
            package=root/'package.json'; package.write_text('{"version":"fixture"}')
            from ap06_browser_identity import digest
            identity=dict(metadata(image),mode='headless-shell',installationDirectory=str(root),installationFiles={str(package):digest(package)})
            self.assertEqual(verify_identity(identity)['status'],'PASS')
            lease=ExecutableLease(identity)
            try:
                for path in (image,package):
                    with self.assertRaises(PermissionError):
                        with path.open('wb') as stream:stream.write(b'changed')
            finally:lease.close()
            package.write_text('changed')
            with self.assertRaises(ValueError):verify_identity(identity)
            package.write_text('{"version":"fixture"}')
            image.unlink()
            with self.assertRaises(ValueError):verify_identity(identity)
            shutil.copyfile(sys.executable,image)
            with image.open('ab') as stream:stream.write(b'changed bytes, same file name and version')
            with self.assertRaises(ValueError):verify_identity(identity)
            junction=root/'junction'
            powershell("New-Item -ItemType Junction -Path '"+str(junction)+"' -Target '"+str(root)+"' | Out-Null; 'true'")
            try:
                with self.assertRaises(ValueError):regular_path(junction/'shell.exe')
            finally:os.rmdir(junction)

    @unittest.skipUnless(os.name=='nt','Windows APIs')
    def test_actual_os_query_and_fail_closed(self):
        row=process_information(os.getpid())
        self.assertEqual(row['pid'],os.getpid());self.assertEqual(row['parentPid'],os.getppid())
        self.assertGreater(row['creationTime'],0);self.assertTrue(Path(row['executablePath']).samefile(sys.executable))
        with self.assertRaises(ValueError):process_information(4294967294)


if __name__ == '__main__': unittest.main()
