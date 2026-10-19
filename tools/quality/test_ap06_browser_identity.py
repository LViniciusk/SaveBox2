import copy
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import ap06_browser_identity as browser_identity
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

    def run_protocol(self, actions, mutate_second=None, fail_verify_at=None, audit_status='PASS'):
        identity=dict(self.identity,productVersion=None)
        manifest=self.root/'identity.json';manifest.write_text(json.dumps(identity))
        calls={'process':0,'verify':0};process=copy.deepcopy(self.process)
        class Lease:
            def __init__(self):self.closes=0
            def close(self):
                released=self.closes==0;self.closes+=1
                return {'releasedExecutableHandles':int(released),'closeFailures':0}
        class Audit:
            def __init__(self):self.entries=[];self.current={};self.closes=0
            def register(self,rows):
                for row in rows:
                    self.entries.append(row.copy())
                    self.current[row['id']]={'creationTime':process['creationTime'],'handle':row['id']}
            def audit(self):
                status=audit_status if self.entries else 'FAIL'
                return {'status':status,'registeredProcessCount':len(self.entries),
                    'closedProcessCount':len(self.entries) if status=='PASS' else 0,
                    'timedOutProcessCount':0 if status=='PASS' else 1,'waitFailedProcessCount':0,
                    'reusedPidCount':0,'deadlineMs':10000,'elapsedMs':1,'closedHashVerified':False,'processes':[]}
            def close(self):
                released=self.closes==0;self.closes+=1
                return {'releasedProcessHandles':len(self.entries) if released else 0,'closeFailures':0}
        lease,audit=Lease(),Audit()
        def process_information(pid,include_identity=True,check_argv0=True):
            if pid==42:return copy.deepcopy(self.parent)
            calls['process']+=1
            row=copy.deepcopy(process);row['pid']=pid
            if mutate_second and calls['process']==2:mutate_second(row)
            return row
        def verify(_identity):
            calls['verify']+=1
            if calls['verify']==fail_verify_at:raise ValueError('AP06_BROWSER_EXECUTABLE_CHANGED')
            return {'status':'PASS'}
        lines=''.join(json.dumps(action)+'\n' for action in actions)
        output=io.StringIO()
        with patch.dict(os.environ,{'AP06_R5_PROCESS_HANDLE_AUDIT':'1'}), \
                patch.object(browser_identity,'ExecutableLease',return_value=lease), \
                patch.object(browser_identity,'OwnedProcessAudit',return_value=audit), \
                patch.object(browser_identity,'process_information',side_effect=process_information), \
                patch.object(browser_identity,'verify_identity',side_effect=verify), \
                patch.object(sys,'argv',['ap06_browser_identity.py','--session',str(manifest)]), \
                patch.object(sys,'stdin',io.StringIO(lines)),contextlib.redirect_stdout(output):
            try:browser_identity.main()
            except SystemExit as error:self.assertEqual(error.code,1)
        return [json.loads(line) for line in output.getvalue().splitlines()],lease,audit

    def attest(self, **updates):
        return {'action':'attest','pid':71,'parentPid':42,'requiredArgs':self.autoplay,'nodeExecutable':sys.executable,
            'launchStartedMs':self.started,'browserVersion':self.identity['chromiumVersion'],**updates}

    def test_session_protocol_accepts_both_attestations_and_releases_all_handles(self):
        rows,lease,audit=self.run_protocol([
            self.attest(),{'action':'register-processes','processes':[{'id':71,'type':'renderer'}]},self.attest(),
            {'action':'register-processes','processes':[{'id':72,'type':'gpu'}]},{'action':'audit-closed'},{'action':'release'}])
        self.assertEqual([row['status'] for row in rows],['READY','PASS','PASS','PASS','PASS','PASS','PASS'])
        self.assertTrue(rows[1]['identityBeforeWorkload']);self.assertFalse(rows[3]['identityBeforeWorkload'])
        self.assertEqual(rows[5]['receipt']['closedHashVerified'],True)
        self.assertEqual(rows[6]['processHandles']['closeFailures'],0);self.assertEqual(rows[6]['executableHandles']['closeFailures'],0)
        self.assertEqual(lease.closes,2);self.assertEqual(audit.closes,2)

    def test_protocol_failures_are_sanitized_and_cleanup_remains_available(self):
        cases=(
            ('second-pid',[self.attest(),self.attest(pid=72)],None,None,'AP06_BROWSER_PID_REUSED'),
            ('second-creation',[self.attest(),self.attest()],lambda row:row.update(creationTime=row['creationTime']+1),None,'AP06_BROWSER_PID_REUSED'),
            ('second-image',[self.attest(),self.attest()],lambda row:row.update(executablePath=str(self.root/'other.exe')),None,'AP06_BROWSER_IDENTITY_MISMATCH'),
            ('second-flags',[self.attest(),self.attest(requiredArgs=['--disable-web-security'])],None,None,'AP06_BROWSER_FLAGS_MISMATCH'),
            ('second-hash',[self.attest(),self.attest()],None,2,'AP06_BROWSER_EXECUTABLE_CHANGED'),
            ('third-attest',[self.attest(),self.attest(),self.attest()],None,None,'AP06_BROWSER_ATTESTATION_ORDER_INVALID'),
            ('register-before',[{'action':'register-processes','processes':[{'id':71,'type':'renderer'}]}],None,None,'AP06_BROWSER_ATTESTATION_ORDER_INVALID'),
            ('audit-before',[{'action':'audit-closed'}],None,None,'AP06_BROWSER_ATTESTATION_ORDER_INVALID'),
            ('winapi-failure',[self.attest(),self.attest()],lambda row:(_ for _ in ()).throw(ValueError('AP06_BROWSER_OS_QUERY_FAILED')),None,'AP06_BROWSER_OS_QUERY_FAILED'),
        )
        for name,attestations,mutation,verify_failure,reason in cases:
            with self.subTest(case=name):
                actions=[*attestations,{'action':'audit-closed'},{'action':'release'}]
                rows,lease,audit=self.run_protocol(actions,mutation,verify_failure)
                self.assertEqual(rows[1+len(attestations)-1]['status'] if name not in ('register-before','audit-before') else rows[1]['status'],'STOP')
                self.assertIn({'status':'STOP','reason':reason},[{key:row.get(key) for key in ('status','reason')} for row in rows])
                self.assertEqual(rows[-1]['status'],'PASS');self.assertEqual(lease.closes,2);self.assertEqual(audit.closes,2)

    def test_process_timeout_is_audit_stop_but_release_still_succeeds(self):
        rows,lease,audit=self.run_protocol([self.attest(),self.attest(),{'action':'audit-closed'},{'action':'release'}],audit_status='FAIL')
        self.assertEqual(rows[3]['status'],'STOP');self.assertEqual(rows[3]['receipt']['timedOutProcessCount'],1)
        self.assertEqual(rows[4]['status'],'PASS');self.assertEqual(lease.closes,2);self.assertEqual(audit.closes,2)

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
