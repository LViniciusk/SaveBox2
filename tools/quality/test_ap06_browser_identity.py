import copy
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest
from ap06_browser_identity import (validate_process, metadata, verify_identity, ExecutableLease,
    regular_path, process_information, powershell, validate_creation_times)


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.shell=self.root/'chrome-headless-shell.exe';self.shell.write_bytes(b'owned image')
        self.profile_root=self.root/'temp';self.profile_root.mkdir()
        self.profile=self.profile_root/'playwright_chromiumdev_profile-test1234';self.profile.mkdir()
        now_filetime=int((time.time()+11644473600)*10000000)
        self.started=int(time.time()*1000)-2000
        self.fixed=['--disable-background-networking','--no-sandbox']
        self.autoplay=['--autoplay-policy=no-user-gesture-required']
        self.native=self.autoplay+['--memlog=all','--memlog-stack-mode=native','--memlog-sampling-rate=16384','--memlog-keep-small-allocations']
        self.protocol=dict(fixedArgs=self.fixed,suffixArgs=['--remote-debugging-pipe','--no-startup-window'],
            profileRoot=str(self.profile_root),profileArgPrefix='--user-data-dir=',profileNamePrefix='playwright_chromiumdev_profile-',
            allowedExperimentalArgs=[self.autoplay,self.native])
        self.identity=dict(executablePath=str(self.shell),executableSha256='a'*64,executableBytes=123,
            chromiumVersion='151.0.7922.34',architecture='x64',mode='headless-shell',launchProtocol=self.protocol)
        self.process=dict(pid=71,parentPid=42,creationTime=now_filetime,
            executablePath=self.identity['executablePath'],executableSha256='a'*64,executableBytes=123,
            chromiumVersion=self.identity['chromiumVersion'],architecture='x64',
            args=[self.identity['executablePath'],*self.fixed,*self.autoplay,
                '--user-data-dir='+str(self.profile),*self.protocol['suffixArgs']])
        self.parent=dict(pid=42,creationTime=self.process['creationTime']-10000000,
            executablePath=sys.executable,args=[sys.executable,'runner.js'])

    def tearDown(self): self.temp.cleanup()

    def check(self, process=None, previous=None, required_args=None, parent=None):
        return validate_process(self.identity,process or self.process,71,42,
            self.autoplay if required_args is None else required_args,previous,
            self.parent if parent is None else parent,sys.executable,self.started)

    def test_shell_binary_is_headless_without_headless_switch(self):
        result=self.check()
        self.assertEqual(result['status'],'PASS');self.assertEqual(result['browserMode'],'headless-shell')
        self.assertNotIn('--headless',self.process['args']);self.assertTrue(result['fixedDefaultsValidated'])
        self.assertTrue(result['experimentalArgumentsValidated']);self.assertFalse(result['nativeFlagsValidated'])
        self.assertEqual(self.check(previous=result)['status'],'PASS')

    def test_native_switches_are_exact_and_only_registered_set_passes(self):
        process=copy.deepcopy(self.process);process['args']=[self.identity['executablePath'],*self.fixed,*self.native,
            '--user-data-dir='+str(self.profile),*self.protocol['suffixArgs']]
        self.assertTrue(self.check(process,required_args=self.native)['nativeFlagsValidated'])
        with self.assertRaisesRegex(ValueError,'AP06_BROWSER_FLAGS_MISMATCH'):
            self.check(required_args=['--autoplay-policy=no-user-gesture-required','--memlog=all'])

    def test_pid_path_hash_version_arch_and_full_argv_mismatches_stop(self):
        mutations=[('pid',72),('parentPid',43),('executablePath',str(self.root/'chrome.exe')),
            ('executableSha256','b'*64),('executableBytes',124),('chromiumVersion','151.0.7922.35'),('architecture','arm64')]
        for field,value in mutations:
            with self.subTest(field=field):
                process=copy.deepcopy(self.process);process[field]=value
                with self.assertRaises(ValueError):self.check(process)
        for mutation in (
            lambda args:args.__setitem__(args.index(self.autoplay[0]),'--autoplay-policy=no-user-gesture'),
            lambda args:args.append('--disable-web-security'),
            lambda args:args.__setitem__(args.index('--disable-background-networking'),'--disable-background-networking=0'),
            lambda args:args.append('--headless'),
            lambda args:args.__setitem__(args.index('--remote-debugging-pipe'),'--remote-debugging-port=0')):
            process=copy.deepcopy(self.process);mutation(process['args'])
            with self.assertRaisesRegex(ValueError,'AP06_BROWSER_FLAGS_MISMATCH'):self.check(process)

    def test_parentage_creation_and_pid_reuse_fail_closed(self):
        previous=self.check()
        for process,parent in ((dict(self.process,creationTime=self.process['creationTime']+1),self.parent),
            (self.process,dict(self.parent,creationTime=self.process['creationTime']+1)),
            (self.process,dict(self.parent,pid=43))):
            with self.assertRaises(ValueError):self.check(process,previous,parent=parent)
        self.assertEqual(validate_creation_times(100000000000,100000000001,100000000000),100000000000)
        with self.assertRaisesRegex(ValueError,'AP06_BROWSER_CREATION_CIM_MISMATCH'):validate_creation_times(1,10002,1)
        with self.assertRaisesRegex(ValueError,'AP06_BROWSER_HANDLE_CREATION_CHANGED'):validate_creation_times(1,1,2)

    def test_profile_must_be_a_fresh_child_of_the_session_temp_root(self):
        process=copy.deepcopy(self.process)
        process['args'][len(self.fixed)+len(self.autoplay)+1]='--user-data-dir='+str(self.root/'elsewhere')
        with self.assertRaises(ValueError):self.check(process)
        process=copy.deepcopy(self.process);process['args'][len(self.fixed)+len(self.autoplay)+1]='--user-data-dir='+str(self.profile_root)
        with self.assertRaises(ValueError):self.check(process)

    @unittest.skipUnless(os.name=='nt','Windows APIs')
    def test_real_file_lease_hash_missing_installation_and_reparse(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);image=root/'shell.exe';shutil.copyfile(sys.executable,image)
            package=root/'package.json';package.write_text('{"version":"fixture"}')
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
    def test_actual_os_query_correlates_handle_cim_and_command_line(self):
        row=process_information(os.getpid())
        self.assertEqual(row['pid'],os.getpid());self.assertEqual(row['parentPid'],os.getppid())
        self.assertGreater(row['creationTime'],0);self.assertTrue(Path(row['executablePath']).samefile(sys.executable))
        self.assertTrue(Path(row['args'][0]).samefile(sys.executable))
        self.assertEqual(validate_creation_times(row['creationTime'],row['creationTime'],row['creationTime']),row['creationTime'])
        with self.assertRaises(ValueError):process_information(4294967294)


if __name__ == '__main__': unittest.main()
