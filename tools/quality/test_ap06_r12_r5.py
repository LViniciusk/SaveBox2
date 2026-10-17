import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import ap06_browser_identity as browser_identity
import ap06_local_backend as local_backend
import run_ap06_r9 as r9
import run_ap06_r12_r2 as factorial
from run_ap06_r12_r2 import validate_process_audit_receipt, validate_browser_receipt


class FakeClock:
    def __init__(self): self.milliseconds=0
    def __call__(self): return self.milliseconds/1000
    def advance(self,milliseconds): self.milliseconds+=milliseconds


class FakeProcessApi:
    def __init__(self,clock,generations=None,image='C:/owned/chrome-headless-shell.exe'):
        self.clock=clock;self.generations=generations or {};self.image=image;self.indices={};self.next_handle=1
        self.handles={};self.closed=[];self.fail_wait=False;self.fail_close=False;self.raise_close=False
    def open(self,pid):
        rows=self.generations.get(pid,[(1000,self.image,None)]);index=self.indices.get(pid,0)
        creation,image,delay=rows[min(index,len(rows)-1)];self.indices[pid]=index+1
        handle=self.next_handle;self.next_handle+=1
        self.handles[handle]={'pid':pid,'creationTime':creation,'image':image,'delayMs':delay,'status':'live'}
        return handle,creation,image
    def wait(self,handle,timeout_ms):
        if self.fail_wait:return browser_identity.WinProcessApi.WAIT_FAILED
        row=self.handles[handle]
        if row['status']=='exited':return browser_identity.WinProcessApi.WAIT_OBJECT_0
        delay=row['delayMs']
        if delay is not None:
            if timeout_ms>=delay:
                self.clock.advance(delay);row['status']='exited';return browser_identity.WinProcessApi.WAIT_OBJECT_0
        self.clock.advance(timeout_ms)
        return browser_identity.WinProcessApi.WAIT_TIMEOUT
    def close(self,handle):
        self.closed.append(handle)
        if self.raise_close:raise OSError('CloseHandle failed')
        if self.fail_close:return False
        self.handles.pop(handle,None);return True


class ProcessAuditTests(unittest.TestCase):
    def make_audit(self,api=None,clock=None):
        clock=clock or FakeClock();api=api or FakeProcessApi(clock)
        identity={'executablePath':'C:/owned/chrome-headless-shell.exe'}
        return browser_identity.OwnedProcessAudit(identity,api,clock),api,clock

    def test_retains_handles_and_merges_roles_from_cdpsnapshots(self):
        audit,api,_=self.make_audit();audit.register([{'id':71,'type':'browser'}])
        audit.register([{'id':71,'type':'browser'},{'id':72,'type':'audio.mojom.AudioService'}])
        self.assertEqual(len(api.handles),2)
        self.assertEqual(audit.current[71]['roles'],{'browser'})
        self.assertEqual(audit.entries[1]['roles'],{'audio.mojom.AudioService'})
        for row in audit.entries:api.handles[row['handle']]['status']='exited'
        receipt=audit.audit();self.assertEqual(receipt['status'],'PASS');self.assertEqual(receipt['registeredProcessCount'],2)
        self.assertEqual(receipt['closedProcessCount'],2);self.assertEqual(receipt['deadlineMs'],10000)
        released=audit.close();self.assertEqual(released,{'releasedProcessHandles':2,'closeFailures':0});self.assertFalse(api.handles)

    def test_instant_and_delayed_exit_finish_inside_shared_deadline(self):
        audit,api,clock=self.make_audit();audit.register([{'id':81,'type':'renderer'}])
        api.handles[1]['status']='exited'
        self.assertEqual(audit.audit()['status'],'PASS')
        audit.close()
        api=FakeProcessApi(clock,{82:[(2000,'C:/owned/chrome-headless-shell.exe',1500)]})
        audit,api,_=self.make_audit(api,clock);audit.register([{'id':82,'type':'gpu'}])
        receipt=audit.audit();self.assertEqual(receipt['status'],'PASS');self.assertEqual(receipt['elapsedMs'],1500)
        audit.close();self.assertFalse(api.handles)

    def test_timeout_and_wait_api_failure_fail_closed_without_terminating_processes(self):
        clock=FakeClock();api=FakeProcessApi(clock,{91:[(3000,'C:/owned/chrome-headless-shell.exe',11000)]})
        audit,api,_=self.make_audit(api,clock);audit.register([{'id':91,'type':'utility'}])
        receipt=audit.audit();self.assertEqual(receipt['status'],'FAIL');self.assertEqual(receipt['timedOutProcessCount'],1)
        self.assertEqual(receipt['elapsedMs'],10000);self.assertFalse(hasattr(api,'terminate'))
        audit.close();self.assertFalse(api.handles)
        audit,api,_=self.make_audit();audit.register([{'id':92,'type':'renderer'}]);api.fail_wait=True
        self.assertEqual(audit.audit()['waitFailedProcessCount'],1);audit.close();self.assertFalse(api.handles)

    def test_pid_reuse_retains_both_generations_and_counts_reuse(self):
        clock=FakeClock();api=FakeProcessApi(clock,{101:[(4000,'C:/owned/chrome-headless-shell.exe',None),
            (5000,'C:/owned/chrome-headless-shell.exe',None)]})
        audit,api,_=self.make_audit(api,clock);audit.register([{'id':101,'type':'renderer'}])
        api.handles[1]['status']='exited';audit.register([{'id':101,'type':'gpu'}])
        self.assertEqual(audit.reused_pid_count,1);self.assertEqual(len(audit.entries),2)
        for row in audit.entries:api.handles[row['handle']]['status']='exited'
        receipt=audit.audit();self.assertEqual(receipt['status'],'PASS');self.assertEqual(receipt['reusedPidCount'],1)
        self.assertEqual([row['creationTime'] for row in receipt['processes']],[4000,5000])
        audit.close();self.assertFalse(api.handles)

    def test_image_mismatch_closes_the_untrusted_handle(self):
        audit,api,_=self.make_audit(FakeProcessApi(FakeClock(),image='C:/foreign/chrome.exe'))
        with self.assertRaisesRegex(ValueError,'AP06_BROWSER_IDENTITY_MISMATCH'):
            audit.register([{'id':111,'type':'browser'}])
        self.assertFalse(api.closed);self.assertEqual(len(api.handles),1)
        self.assertEqual(audit.close(),{'releasedProcessHandles':1,'closeFailures':0})
        self.assertEqual(api.closed,[1]);self.assertFalse(api.handles)

    def test_close_handle_failure_is_reported_as_a_leak(self):
        audit,api,_=self.make_audit();api.raise_close=True
        audit.register([{'id':113,'type':'renderer'},{'id':114,'type':'utility'}])
        self.assertEqual(audit.close(),{'releasedProcessHandles':2,'closeFailures':2})
        self.assertEqual(api.closed,[1,2]);self.assertEqual(len(api.handles),2)

    def test_open_process_failure_does_not_create_a_retained_handle(self):
        class FailedOpen(FakeProcessApi):
            def open(self,_pid):raise ValueError('AP06_BROWSER_OS_QUERY_FAILED')
        audit,api,_=self.make_audit(FailedOpen(FakeClock()))
        with self.assertRaisesRegex(ValueError,'AP06_BROWSER_OS_QUERY_FAILED'):
            audit.register([{'id':112,'type':'renderer'}])
        self.assertFalse(api.handles);self.assertEqual(audit.close()['releasedProcessHandles'],0)


class ReceiptAndRecoveryTests(unittest.TestCase):
    def receipt(self):
        return {'status':'PASS','method':'retained-win32-process-handles','registeredProcessCount':1,'closedProcessCount':1,
            'timedOutProcessCount':0,'waitFailedProcessCount':0,'reusedPidCount':0,'deadlineMs':10000,'elapsedMs':7,
            'closedHashVerified':True,'processes':[{'pid':201,'creationTime':9001,'roles':['browser']}]}

    def test_receipt_is_exact_and_covers_raw_pid_and_role(self):
        raw=[{'processMemory':{'processes':[{'pid':201,'type':'browser'}]}}]
        self.assertTrue(validate_process_audit_receipt(self.receipt(),raw))
        for mutate in (lambda row:row.pop('method'),lambda row:row.update(elapsedMs=10001),
            lambda row:row.update(closedHashVerified=False),lambda row:row.update(closedProcessCount=0),
            lambda row:row['processes'][0].update(pid=202)):
            value=self.receipt();mutate(value)
            with self.assertRaises(Exception):validate_process_audit_receipt(value,raw)
        with self.assertRaises(Exception):validate_process_audit_receipt(self.receipt(),[{'processes':[{'pid':202,'type':'renderer'}]}])

    def test_browser_validator_requires_exact_handle_release_receipt(self):
        identity={'executablePath':'C:/owned/chrome-headless-shell.exe','executableSha256':'a'*64,
            'chromiumVersion':'151.0.7922.34','architecture':'x64','installationFiles':{},'mode':'headless-shell'}
        point={'status':'PASS','browserPid':201,'parentPid':10,'parentCreationTime':100,'processCreationTime':9001,
            'expectedSha256':'a'*64,'observedSha256':'a'*64,'expectedExecutable':identity['executablePath'],
            'observedExecutable':identity['executablePath'],'chromiumVersion':identity['chromiumVersion'],'architecture':'x64',
            'browserMode':'headless-shell','launchArgsValidated':True,'fixedDefaultsValidated':True,
            'experimentalArgumentsValidated':True,'profileDirectoryValidated':True,'nativeFlagsValidated':False,
            'imageHashBoundByLease':True,'ancestryValidated':True}
        before=dict(point,identityBeforeWorkload=True);after=dict(point,identityBeforeWorkload=False)
        audit=self.receipt();release={'status':'PASS','processHandles':{'releasedProcessHandles':1,'closeFailures':0},
            'executableHandles':{'releasedExecutableHandles':1,'closeFailures':0}}
        record={'processExitAudit':audit,'handleRelease':release,'processSamples':[{'processMemory':{'processes':[{'pid':201,'type':'browser'}]}}],
            'browserIdentity':{'status':'PASS','readLease':True,'attemptReserved':True,'browserLaunchSucceeded':True,
                'before':before,'after':after,'closed':{'closedHashVerified':True},'processExitAudit':audit,'handleRelease':release}}
        with patch.object(factorial,'CAMPAIGN','AP-06-R12-R5-factorial'):
            validate_browser_receipt(record,identity,process_samples=record['processSamples'])
            invalid=copy.deepcopy(record);invalid['handleRelease']['processHandles']['releasedProcessHandles']=0
            invalid['browserIdentity']['handleRelease']['processHandles']['releasedProcessHandles']=0
            with self.assertRaises(Exception):validate_browser_receipt(invalid,identity,process_samples=invalid['processSamples'])
            preflight=copy.deepcopy(record);preflight.pop('processSamples')
            preflight['cases']=[{'processSamples':record['processSamples']}]
            validate_browser_receipt(preflight,identity)
            preflight['cases'][0]['processSamples'][0]['processMemory']['processes'][0]['pid']=202
            with self.assertRaises(Exception):validate_browser_receipt(preflight,identity)
            with self.assertRaises(Exception):validate_browser_receipt(record|{'processSamples':[]},identity)

    def test_r5_freeze_includes_git_ignored_crow_header_for_both_namespaces(self):
        for namespace in ('readiness-wave12-r5-factorial','readiness-wave12-r5-native'):
            with self.subTest(namespace=namespace),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);output=root/'.quality'/namespace
                (output/'tooling').mkdir(parents=True);(output/'fixtures').mkdir()
                (output/'fixtures/manifest.json').write_text('{}')
                crow=root/'backend/include/crow_all.h';crow.parent.mkdir(parents=True);crow.write_text('// ignored')
                unit={'status':'PASS','unitBrowserLaunches':1,'appProducts':{},'pageScriptSha256':'1'*64,
                    'multiplexedContract':{'workerHashes':{},'fixtureHash':'a'*64}}
                values={'tooling/angular-unit-1.json':unit,'baseline/authority-config.local.json':
                    {'AP06_AUTHORITY_ROOT':str(root/'authority'),'identity':'2'*64},
                    'baseline/backend-authority.json':{'fileMapping':[]},'baseline/workload.json':{},'baseline/budget.json':{}}
                class Wave:
                    def __init__(self):self.root=root;self.output=output
                    def git(self,*args):return '' if args in (('status','--porcelain'),('ls-files',)) else 'head'
                    def save(self,name,value):
                        path=self.output/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value))
                published=[]
                with patch.object(r9,'read',side_effect=lambda path:values[Path(path).relative_to(output).as_posix()]),\
                        patch.object(r9,'build_products',return_value=({}, {}, {})),\
                        patch.object(r9,'sha256',return_value='a'*64),\
                        patch.object(r9.owner,'_tree_sha256',return_value='b'*64),\
                        patch.object(r9,'publish',side_effect=lambda _wave,_name,files: published.append(files) or {'manifestSha256':'c'*64}),\
                        patch.object(r9,'verify_freeze'),patch('builtins.print'):
                    r9.freeze_implementation(Wave(),output=f'.quality/{namespace}',harness='tools/harness.mjs',runner_path=root/'runner.py')
                self.assertIn('tooling/source/backend/include/crow_all.h',published[0])

    def test_resume_requires_proven_fresh_state_and_an_unbanned_independent_allowlisted_peer(self):
        self.assertEqual(local_backend.select_spoof_client('fresh',{},dict.fromkeys(local_backend.SPOOF_CLIENTS,False)),'127.0.0.2')
        previous={'status':'PASS','phase':'fresh','sourceAddress':'127.0.0.2','actualPeer':'127.0.0.2',
            'statuses':[401]*5+[429]*9+[403]*2}
        self.assertEqual(local_backend.select_spoof_client('resume',previous,{'127.0.0.2':True,'127.0.0.3':False}),'127.0.0.3')
        for phase,row,bans in (('fresh',{}, {'127.0.0.2':True,'127.0.0.3':False}),
            ('resume',{}, {'127.0.0.2':True,'127.0.0.3':False}),
            ('resume',previous,{'127.0.0.2':False,'127.0.0.3':False}),
            ('resume',previous,{'127.0.0.2':True,'127.0.0.3':True})):
            with self.assertRaises(RuntimeError):local_backend.select_spoof_client(phase,row,bans)

    def test_active_ban_query_is_read_only_and_rejects_addresses_outside_allowlist(self):
        with patch.object(local_backend.subprocess,'check_output',return_value='t\n') as query:
            self.assertTrue(local_backend.active_ban(Path('C:/pg/bin'),Path('C:/runtime'),{'DB_PORT':'5432','DB_USER':'user'},'db','127.0.0.2'))
            command=query.call_args.args[0];sql=command[-1]
            self.assertIn('BEGIN READ ONLY',sql);self.assertIn('SELECT EXISTS',sql);self.assertNotIn('DELETE',sql.upper())
        with patch.object(local_backend.subprocess,'check_output') as query,self.assertRaisesRegex(RuntimeError,'AP06_SPOOF_CLIENT_NOT_ALLOWED'):
            local_backend.active_ban(Path('C:/pg/bin'),Path('C:/runtime'),{},'db','127.0.0.1')
            query.assert_not_called()

    def test_failed_real_peer_guard_records_only_statuses_and_sanitized_failure(self):
        class Response:
            def __init__(self,status,body=b''):self.status=status;self.body=body
            def read(self,_limit=None):return self.body
        class Connection:
            def __init__(self,host,port,timeout,source_address):self.address=source_address[0];self.path='';self.sock=None
            def connect(self):self.sock=type('Socket',(),{'getsockname':lambda _self:(self.address,44000)})()
            def request(self,method,path,*_args,**_kwargs):self.path=path
            def getresponse(self):return Response(200,self.address.encode()) if self.path=='/__ap06/actual-peer' else Response(429,b'sensitive body')
            def close(self):pass
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp);(output/'baseline').mkdir();old=local_backend.OUTPUT;local_backend.OUTPUT=output
            try:
                with patch.object(local_backend.http.client,'HTTPConnection',Connection),self.assertRaisesRegex(RuntimeError,'AP06_REAL_PEER_SPOOF_GUARD_FAILED'):
                    local_backend.verify_spoof_guard('127.0.0.2','fresh',False,False)
                saved=(output/'baseline/network-spoof-guard.json').read_text()
                self.assertIn('"status": "FAIL"',saved);self.assertIn('"statuses": [\n        429',saved)
                self.assertIn('127.0.0.2',saved);self.assertNotIn('sensitive body',saved);self.assertNotIn('synthetic-invalid-password',saved)
            finally:local_backend.OUTPUT=old


if __name__=='__main__':unittest.main()
