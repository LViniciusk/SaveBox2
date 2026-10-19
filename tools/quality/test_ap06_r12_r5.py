import copy
import importlib
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
        for campaign in ('AP-06-R12-R5-factorial','AP-06-R12-R7-factorial'):
            with self.subTest(campaign=campaign),patch.object(factorial,'CAMPAIGN',campaign):
                validate_browser_receipt(record,identity,process_samples=record['processSamples'])
                invalid=copy.deepcopy(record);invalid['handleRelease']['processHandles']['releasedProcessHandles']=0
                invalid['browserIdentity']['handleRelease']['processHandles']['releasedProcessHandles']=0
                with self.assertRaises(Exception):validate_browser_receipt(invalid,identity,process_samples=invalid['processSamples'])
                for mutate in (lambda row:row.update(browserPid=202),lambda row:row.update(processCreationTime=9002),
                    lambda row:row.update(identityBeforeWorkload=True)):
                    invalid=copy.deepcopy(record);mutate(invalid['browserIdentity']['after'])
                    with self.assertRaises(Exception):validate_browser_receipt(invalid,identity,process_samples=invalid['processSamples'])
                preflight=copy.deepcopy(record);preflight.pop('processSamples')
                preflight['cases']=[{'processSamples':copy.deepcopy(record['processSamples'])}]
                validate_browser_receipt(preflight,identity)
                preflight['cases'][0]['processSamples'][0]['processMemory']['processes'][0]['pid']=202
                with self.assertRaises(Exception):validate_browser_receipt(preflight,identity)
                with self.assertRaises(Exception):validate_browser_receipt(record|{'processSamples':[]},identity)

    def test_freeze_includes_git_ignored_crow_header_for_r5_and_r7_namespaces(self):
        for namespace in ('readiness-wave12-r5-factorial','readiness-wave12-r5-native',
            'readiness-wave12-r7-factorial','readiness-wave12-r7-native'):
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

    def test_real_peer_guard_records_expected_middleware_status_sequence(self):
        expected=[401]*5+[429]*9+[403]*2
        connections=[]
        login_attempts={}
        class Response:
            def __init__(self,status,body=b''):self.status=status;self.body=body
            def read(self,_limit=None):return self.body
        class Connection:
            def __init__(self,host,port,timeout,source_address):
                self.address=source_address[0];self.path='';self.headers={};self.sock=None;connections.append(self)
            def connect(self):self.sock=type('Socket',(),{'getsockname':lambda _self:(self.address,44000)})()
            def request(self,method,path,body=None,headers=None):self.path=path;self.headers=headers or {}
            def getresponse(self):
                if self.path=='/__ap06/actual-peer':return Response(200,self.address.encode())
                index=login_attempts.get(self.address,0);login_attempts[self.address]=index+1
                return Response(expected[index],b'synthetic body')
            def close(self):pass
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp);(output/'baseline').mkdir();old=local_backend.OUTPUT;local_backend.OUTPUT=output
            try:
                with patch.object(local_backend.http.client,'HTTPConnection',Connection):
                    local_backend.verify_spoof_guard('127.0.0.2','fresh',False,False)
                    local_backend.verify_spoof_guard('127.0.0.3','resume',True,False)
                saved=json.loads((output/'baseline/network-spoof-guard.json').read_text())
                self.assertEqual(saved['status'],'PASS');self.assertEqual(len(saved['attempts']),2)
                self.assertEqual([row['actualPeer'] for row in saved['attempts']],['127.0.0.2','127.0.0.3'])
                self.assertTrue(all(row['statuses']==expected for row in saved['attempts']))
                self.assertEqual(len(connections),34)
                self.assertTrue(all(connection.address in ('127.0.0.2','127.0.0.3') for connection in connections))
                self.assertTrue(all(connection.headers.get('X-Real-IP')=='127.0.0.1' and connection.headers.get('X-Forwarded-For')=='127.0.0.1, ::1' for connection in connections if connection.path=='/login'))
                self.assertNotIn('synthetic body',(output/'baseline/network-spoof-guard.json').read_text())
            finally:local_backend.OUTPUT=old


class R6AuthorityTests(unittest.TestCase):
    def test_r7_preflight_requires_the_os_attestation_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);output=root/'.quality/readiness-wave12-r7-factorial'
            (output/'baseline').mkdir(parents=True);(output/'pipeline').mkdir();(output/'tooling').mkdir()
            head='a'*40;target=output/'tooling/angular-unit-1.json'
            unit={'status':'PASS','unitBrowserLaunchAttempts':1,'unitBrowserLaunches':1,'browserClosed':True,
                'processExitAudit':{'status':'PASS'},'cases':[{'status':'PASS','contextClosed':True} for _ in range(5)]}
            class Wave:
                node='node'
                def __init__(self):self.root=root;self.output=output
                def git(self,*args):return '' if args[0]=='status' else head
                def save(self,name,value):
                    path=self.output/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value))
                def command(self,*args):pass
            def read(path):
                path=Path(path)
                if path==output/'baseline/prechecks.json':return {'status':'PASS','secretScan':'PASS','angularBuild':'PASS','typescript':'PASS','syntax':'PASS','diff':'PASS'}
                if path==output/'baseline/ci.json':return {'headSha':head,'conclusion':'success','jobs':[{'conclusion':'success'}]*3}
                if path==output/'baseline/browser-identity.json':return {'status':'PASS'}
                if path==target:return unit
                raise AssertionError(f'unexpected read: {path.name}')
            with patch.object(factorial,'CAMPAIGN','AP-06-R12-R7-factorial'),\
                    patch.object(factorial,'validate_r7_authority'),patch.object(factorial,'validate_r6_corpus'),\
                    patch.object(factorial,'read',side_effect=read),patch.object(factorial,'publish'),\
                    patch.object(factorial,'environment',return_value=({'AP06_R7_UNIT_OUTPUT':str(target)},{})),\
                    patch.object(factorial,'media_files',return_value=[]),\
                    patch.object(factorial,'media_server') as media_server,\
                    patch.object(factorial,'validate_browser_receipt',side_effect=RuntimeError('RECEIPT_REQUIRED')) as validate:
                media_server.return_value.__enter__.return_value=('http://127.0.0.1:42088',{})
                with self.assertRaisesRegex(RuntimeError,'RECEIPT_REQUIRED'):factorial.unit_browser(Wave())
                validate.assert_called_once_with(unit,{'status':'PASS'},process_samples=[])

    def test_r7_local_backend_uses_its_owned_r10_r3_runtime(self):
        with patch.dict(local_backend.os.environ,{'AP06_EXPERIMENT_ROOT':'.quality/readiness-wave12-r7-factorial'}):
            importlib.reload(local_backend)
            self.assertEqual(local_backend.OUTPUT.name,'readiness-wave12-r7-factorial')
            self.assertEqual(local_backend.EXPERIMENT_ID,'r10_r3')
            self.assertTrue(local_backend.R3)
        importlib.reload(local_backend)

    def make_wave(self,root,content=None,r7=False):
        root=Path(root);round_name='r7' if r7 else 'r6';output=root/f'.quality/readiness-wave12-{round_name}-factorial';baseline=output/'baseline'
        task=root/f'quality/ap06-r12-{round_name}.md' if r7 else root/'quality/prompt.md';task.parent.mkdir(parents=True,exist_ok=True)
        source=Path(__file__).resolve().parents[2]/('quality/ap06-r12-r7.md' if r7 else 'quality/prompt.md')
        content=content if content is not None else source.read_bytes()
        task.write_bytes(content);(baseline).mkdir(parents=True,exist_ok=True)
        private_task=baseline/'task.md';private_task.write_bytes(content)
        digest=r9.sha256(task)
        conditions={key:value for key,value in factorial.CONDITIONS.items()}
        expected_ranges=[[0,'bytes=0-131071'],[0,'bytes=114-4194433'],[0,'bytes=4194434-8388753'],
            [1,'bytes=0-131071'],[1,'bytes=117-4194436'],[1,'bytes=4194437-8388756'],
            [2,'bytes=0-131071'],[2,'bytes=114-4194433'],[2,'bytes=4194434-8388753']]
        protocol={'campaign':f'AP-06-R12-{round_name.upper()}-factorial','implementationHead':'a'*40,
            'hypotheses':'Fetch on payload chunks changes cycle-6 renderer private memory; metadata transport is the factorial control.',
            'conditions':conditions,
            'triageOrder':list(factorial.CONDITIONS),'formalOrder':'A,B,B,A,A,B',
            'metrics':{'primary':'renderer-private-delta-cycle-6','secondary':'total-chromium-private-delta'},
            'thresholds':{'controlMiB':300,'triageMiB':150,'formalSeparationMiB':150},
            'order':[list(pair) for pair in factorial.PAIRS],
            'budget':{'preflight':1,'triage':4,'formal':6,'nativeCapability':1,'nativeMeasurements':2,'maximum':14,'retries':0},
            'corpus':{'fixtureCount':3,'bytesPerCycle':25559136,'metadataBytesPerCycle':393216,'payloadBytesPerCycle':25165920,'rangesPerCycle':expected_ranges},
            'httpContract':{'status':206,'jwt':True,'contentRange':True,'contentLength':True,'rangeCountPerCycle':9,'noWorkerMseMediaOrPlayback':True,'blobOnly':True},
            'security':{'loopbackBind':'127.0.0.1','testedRealPeers':['127.0.0.2','127.0.0.3'],'spoofHeadersIgnored':True,
                'productionBypassOrEndpoint':False,'endpointExperimentalOnly':True,'externalAccessDenied':True},
            'cleanup':{'accountAndFileCleanup':True,'readOnlyBanReadback':True},
            'stop':{'noRetry':True,'stopOnGateFailure':True},'publication':{'draftOnly':True,'merge':False},
            'nativeProfiling':{'onlyAfterFormalConfirmation':True,'capabilityBrowsers':1,'measurementBrowsers':2,'idleSeconds':120,
                'samplingBytes':16384,'traceBytesMax':536870912,'eventBytesMax':33554432,'cdpTimeoutMs':30000,'streamTimeoutMs':120000,
                'checkpoints':['baseline','cycle-6-close','idle-120s','forced-GC-final']},
            'authoritySha256':digest,'authorityBytes':len(content)}
        (baseline/'task-provenance.json').write_text(json.dumps({'sourceSha256':digest,'sourceBytes':len(content)}))
        (baseline/'preregistered-protocol.json').write_text(json.dumps(protocol))
        class Wave:
            def __init__(self):self.root=root;self.output=output
            def git(self,*args):return 'a'*40
        return Wave(),protocol,content

    def test_authority_checks_presence_hash_semantics_and_freeze(self):
        with tempfile.TemporaryDirectory() as tmp:
            wave,protocol,_=self.make_wave(tmp)
            self.assertEqual(factorial.validate_r6_authority(wave),protocol['authoritySha256'])
            changed=copy.deepcopy(protocol);changed['thresholds']['controlMiB']=299
            with self.assertRaises(Exception):factorial.validate_r6_authority(wave,changed)
            protocol['authoritySha256']='0'*64
            (wave.output/'baseline/preregistered-protocol.json').write_text(json.dumps(protocol))
            with self.assertRaises(Exception):factorial.validate_r6_authority(wave)
        with tempfile.TemporaryDirectory() as tmp:
            wave,protocol,content=self.make_wave(tmp,b'AP-06 R12-R6')
            with self.assertRaises(Exception):factorial.validate_r6_authority(wave)
            (wave.root/'quality/prompt.md').unlink()
            with self.assertRaises(Exception):factorial.validate_r6_authority(wave)

    def test_r7_authority_is_bound_to_its_own_task_file_and_protocol(self):
        with tempfile.TemporaryDirectory() as tmp:
            wave,protocol,_=self.make_wave(tmp,r7=True)
            self.assertEqual(factorial.validate_r7_authority(wave),protocol['authoritySha256'])
            self.assertFalse((wave.root/'quality/prompt.md').exists())
            changed=copy.deepcopy(protocol);changed['campaign']='AP-06-R12-R6-factorial'
            with self.assertRaises(Exception):factorial.validate_r7_authority(wave,changed)

    def test_corpus_authority_rejects_changed_manifest_ranges_and_missing_fixtures(self):
        expected_ranges=[[0,'bytes=0-131071'],[0,'bytes=114-4194433'],[0,'bytes=4194434-8388753'],
            [1,'bytes=0-131071'],[1,'bytes=117-4194436'],[1,'bytes=4194437-8388756'],
            [2,'bytes=0-131071'],[2,'bytes=114-4194433'],[2,'bytes=4194434-8388753']]
        workload={'bytesPerCycle':25559136,'cycles':6,'requestsPerCycle':9,'rangesPerCycle':expected_ranges}
        fixtures=[{'id':i,'path':f'video-{i}.mp4','bytes':i+1,'sha256':str(i)*64,'ciphertextBytes':i+11,
            'ciphertextSha256':str(i+1)*64,'chunkBytes':4194304,'chunkCount':3,'lastChunkBytes':1,'authenticatedMetadata':True} for i in range(3)]
        with tempfile.TemporaryDirectory() as tmp:
            wave,_,_=self.make_wave(tmp);fixture_root=wave.output/'fixtures';(fixture_root/'plain').mkdir(parents=True);(fixture_root/'cipher').mkdir()
            manifest=fixture_root/'manifest.json';manifest.write_text(json.dumps(fixtures));digest=r9.sha256(manifest)
            receipt={'manifestSha256':digest,'workload':workload,'referenceCampaigns':['AP-06-R12','AP-06-R12-R2','AP-06-R12-R4'],
                'historicalR6Identity':'NOT_PROVEN_NEW_R12R6_BASELINE','fixtures':[{'id':row['id'],'plainBytes':row['bytes'],
                    'plainSha256':row['sha256'],'cipherBytes':row['ciphertextBytes'],'cipherSha256':row['ciphertextSha256'],
                    'chunkBytes':row['chunkBytes'],'chunkCount':row['chunkCount'],'lastChunkBytes':row['lastChunkBytes']} for row in fixtures]}
            (wave.output/'baseline/workload.json').write_text(json.dumps(workload))
            receipt_path=wave.output/'baseline/corpus-provenance.json';receipt_path.write_text(json.dumps(receipt))
            with self.assertRaises(Exception):factorial.validate_r6_corpus(wave)
            manifest.write_text('[]')
            with self.assertRaises(Exception):factorial.validate_r6_corpus(wave)
            workload['rangesPerCycle'][0]=[0,'bytes=0-1023'];receipt['workload']=workload
            manifest.write_text(json.dumps(fixtures));receipt['manifestSha256']=r9.sha256(manifest)
            (wave.output/'baseline/workload.json').write_text(json.dumps(workload));receipt_path.write_text(json.dumps(receipt))
            with self.assertRaises(Exception):factorial.validate_r6_corpus(wave)

    def test_runtime_preservation_is_limited_to_r6_resume(self):
        with patch.object(local_backend.sys,'argv',['ap06_local_backend.py','--preserve-runtime-for-resume']),\
                patch.object(local_backend,'OUTPUT',Path('.quality/readiness-wave12-r6-factorial')):
            self.assertTrue(local_backend.preserve_runtime_for_resume())
        with patch.object(local_backend.sys,'argv',['ap06_local_backend.py','--preserve-runtime-for-resume']),\
                patch.object(local_backend,'OUTPUT',Path('.quality/readiness-wave12-r5-factorial')):
            with self.assertRaisesRegex(RuntimeError,'AP06_RUNTIME_PRESERVE_R6_ONLY'):
                local_backend.preserve_runtime_for_resume()
        with patch.object(local_backend.sys,'argv',['ap06_local_backend.py','--preserve-runtime-for-resume']),\
                patch.object(local_backend,'OUTPUT',Path('.quality/readiness-wave12-r7-factorial')):
            with self.assertRaisesRegex(RuntimeError,'AP06_RUNTIME_PRESERVE_R6_ONLY'):
                local_backend.preserve_runtime_for_resume()


if __name__=='__main__':unittest.main()
