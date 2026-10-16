import copy
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import run_ap06_r12 as r12
from run_ap06_r9 import publish,verify_freeze
from ap06_authorities import initialize,sha256,verify_publication,private_permissions
from test_ap06_r11 import r11_complete_raw


def complete_raw(condition='r12.3'):
    raw,freeze,fixtures=r11_complete_raw('r11.2');run=raw['runs'][0]
    for f in fixtures:f.update(bytes=9*1024**2,ciphertextBytes=10*1024**2)
    ranges=[[f['id'],s] for f in fixtures for s in ('bytes=0-131071','bytes=114-4194433','bytes=4194434-8388753')]
    freeze['workload'].update(rangesPerCycle=ranges,bytesPerCycle=25559136,workerTransferBytesSentPerCycle=0)
    raw.update(condition=condition,transport='fetch' if condition in r12.FETCH else 'xhr',payload='blob' if condition in ('r12.0','r12.1') else 'direct-arraybuffer' if condition=='r12.4' else 'blob-arraybuffer',
        attributionDriverUsed=True,metadataCommon=True,workersUsed=False,mseUsed=False,cryptoWorkloadEquivalent=False,transmuxWorkloadEquivalent=False)
    raw['fixtureIdentities']=[{k:f[k] for k in ('id','name','bytes','sha256')} for f in fixtures]
    run['runId']=f'triage-{r12.CONDITIONS.index(condition)+1:02}-{condition}'
    run['transportProof']=r12.expected_proof('r10.1' if condition in r12.FETCH else 'r10.0')
    for row in run['rangeNetwork']['bootstrapRequests']:row['type']='XHR'
    template=run['rangeNetwork']['requests'][0];rows=[]
    for i,(fixture,value) in enumerate(ranges*6):
        start,end=map(int,value[6:].split('-'))
        rows.append(dict(template,requestId=str(i),fixture=fixture,fileId=100+fixture,range=value,type='Fetch' if condition in r12.FETCH else 'XHR',
            headers={'content-length':str(end-start+1),'content-range':f'bytes {start}-{end}/{10*1024**2}'}))
    run['rangeNetwork']['requests']=rows
    run['backendTraffic']['rows']=[{'fileId':r['fileId'],'status':206} for r in rows]
    run['samples'].insert(9,copy.deepcopy(run['samples'][8]));raw['processSampleCalls']=11
    for index,s in enumerate(run['samples']):
        s['phase']=r12.PHASES[index];s['timestamp']=f'2026-10-16T00:{index*2:02}:00Z';cycle=s['cycle'];sessions=3*cycle
        c=s['counters']['observed'];c.update(metadataRequests=sessions,rangeBytesReceived=25559136*cycle)
        s['counters'].pop('r11');payload=sessions*8388640;blob=condition!='r12.4';buffer=condition not in ('r12.0','r12.1')
        s['counters']['r12']=dict.fromkeys(r12.COUNTERS,0)
        s['counters']['r12'].update(payloadBlobCount=sessions*2 if blob else 0,payloadBlobBytes=payload if blob else 0,
            payloadArrayBufferCount=sessions*2 if buffer else 0,payloadArrayBufferBytes=payload if buffer else 0,
            metadataBytes=sessions*131072,metadataCompleted=sessions,completedOperations=sessions*3,sessionsStarted=sessions,sessionsCompleted=sessions)
    return raw,freeze,fixtures


class R12ValidationTests(unittest.TestCase):
    def test_all_five_real_complete_validator_paths_and_formal(self):
        for condition in r12.CONDITIONS:
            raw,freeze,fixtures=complete_raw(condition)
            self.assertEqual(r12.validate_condition(raw,condition,'triage',freeze,fixtures),'R12_MATERIALIZATION_VALID')
            raw['stage']='formal';raw['runs'][0]['runId']='formal-06-'+condition
            self.assertEqual(r12.validate_condition(raw,condition,'formal',freeze,fixtures),'R12_MATERIALIZATION_VALID')

    def test_full_raw_negative_copies_fail_closed(self):
        raw,freeze,fixtures=complete_raw()
        changes=[lambda r:r.update(processSampleCalls=10),lambda r:r.update(pageScriptSha256='changed'),lambda r:r.update(workersUsed=True),
            lambda r:r['runs'][0]['samples'][4]['processMemory']['processes'][1].update(pid=99),
            lambda r:r['runs'][0]['samples'][3]['processMemory'].update(privateBytes=1),
            lambda r:r['runs'][0]['samples'][9].update(phase='idle-30s'),
            lambda r:r['runs'][0]['samples'][9].update(timestamp=r['runs'][0]['samples'][8]['timestamp']),
            lambda r:r['runs'][0]['samples'][8].update(gc='forced-diagnostic'),
            lambda r:r['runs'][0]['samples'][9]['counters']['r12'].update(obtainMs=1),
            lambda r:r['runs'][0]['samples'][6]['counters']['r12'].update(activeReferences=1),
            lambda r:r['runs'][0]['samples'][6]['counters']['r12'].update(payloadArrayBufferBytes=0),
            lambda r:r['runs'][0]['samples'][6]['counters']['observed'].update(workersCreated=1),
            lambda r:r['runs'][0]['rangeNetwork']['requests'][3].update(status=200),
            lambda r:r['runs'][0]['rangeNetwork']['requests'][3].update(type='XHR'),
            lambda r:r['runs'][0]['rangeNetwork']['requests'][3]['headers'].update({'content-length':'0'}),
            lambda r:r['runs'][0]['rangeNetwork']['bootstrapRequests'][0].update(type='Fetch'),
            lambda r:r['runs'][0]['processExitAudit'].update(aliveOwnedPids=[1]),
            lambda r:r['runs'][0].update(runId='triage-01-r12.3')]
        for change in changes:
            bad=copy.deepcopy(raw);change(bad)
            with self.subTest(change=change),self.assertRaises((RuntimeError,ValueError)):r12.validate_condition(bad,'r12.3','triage',freeze,fixtures)
        # AudioService appearing after baseline is forbidden, even if numeric totals remain coherent.
        bad=copy.deepcopy(raw)
        for s in bad['runs'][0]['samples'][1:]:
            s['processMemory']['processes'].append({'pid':5,'type':'audio.mojom.AudioService','privateBytes':0})
            s['processMemory']['byType']['audio.mojom.AudioService']={'privateBytes':0}
        with self.assertRaisesRegex(RuntimeError,'R12_RAW_CONTRACT_INVALID'):r12.validate_condition(bad,'r12.3','triage',freeze,fixtures)

    def test_budget_and_real_publication_freeze_and_stop(self):
        budget={'approved':True,'developmentMaximum':1,'measurementMaximum':11,'measurementRetries':0}
        for used in range(11):r12.check_budget(budget,used,1)
        for used in (-1,11,True):
            with self.assertRaises(RuntimeError):r12.check_budget(budget,used,1)
        with tempfile.TemporaryDirectory() as tmp:
            directory=Path(tmp);root=directory/'authority';identity='d'*64;initialize(root,identity,campaign='AP-06-R10')
            workspace=directory/'repo';out=workspace/r12.OUTPUT;(out/'baseline').mkdir(parents=True);(out/'pipeline').mkdir()
            (out/'baseline/authority-config.local.json').write_text(json.dumps({'AP06_AUTHORITY_ROOT':str(root),'identity':identity}))
            wave=SimpleNamespace(root=workspace,output=out,git=lambda *a:'head')
            source=workspace/'source.py';source.write_text('source')
            receipt=publish(wave,'implementation',{'tooling/source/source.py':source})
            self.assertEqual(verify_publication(root,identity,'r12-implementation')['files'][0]['path'],'r12/tooling/source/source.py')
            frozen={'implementationHead':'head','implementationPublication':'r12-implementation','freezePublication':'r12-freeze',
                'publicationHashes':{'r12-implementation':receipt['manifestSha256']},'files':{'source.py':sha256(source)}}
            path=out/'freeze.json';path.write_text(json.dumps(frozen));publish(wave,'freeze',{'freeze/freeze.json':path})
            # Shared verification includes the corpus publication; publish a synthetic one through the same authority.
            from ap06_authorities import publish_snapshot
            publish_snapshot(root,identity,'corpus-publication',{'corpus/test':source},out/'pipeline')
            verify_freeze(wave,frozen)
            source.write_text('tampered')
            with self.assertRaises(RuntimeError):verify_freeze(wave,frozen)
            stop=out/'STOP.json';stop.write_text(json.dumps({'status':'R12_BLOCKED','reason':'R12_SYNTHETIC_HASH_CHANGED'}))
            publish(wave,'stop-campaign',{'evidence/STOP-campaign.json':stop})
            self.assertEqual(verify_publication(root,identity,'r12-stop-campaign')['files'][0]['path'],'r12/evidence/STOP-campaign.json')

    def test_preflight_refuses_incomplete_checks_before_reservation_or_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            out=Path(tmp);(out/'baseline').mkdir();(out/'baseline/prechecks.json').write_text('{"status":"PASS"}')
            wave=SimpleNamespace(output=out,git=lambda *a:'')
            with self.assertRaisesRegex(RuntimeError,'R12_PRECHECKS_REQUIRED'):r12.unit_browser(wave)
            self.assertFalse((out/'pipeline/development-reservation.json').exists())


class R12BridgeTests(unittest.TestCase):
    def setUp(self):
        self.wave=SimpleNamespace(root=Path(__file__).resolve().parents[2],node=shutil.which('node'))
        self.values=dict(zip(r12.CONDITIONS,(20,400,30,420,40)))

    def test_public_python_node_full_summaries_are_projected_with_bounded_stdin(self):
        candidate=r12.classify(self.wave,self.values);a,b=candidate['pair'];execute=subprocess.run
        for size in (150000,1000000):
            rows=[{'condition':c,'rendererPrivateDeltaMiB':400 if c==b else 20,'summary':{'private':'X'*size}} for c in (a,b,b,a,a,b)]
            before=copy.deepcopy(rows)
            with patch.object(r12.subprocess,'run',wraps=execute) as call:
                result=r12.classify(self.wave,self.values,rows,candidate)
                self.assertEqual(result['status'],'R12_CONTRAST_CONFIRMED')
                payload=call.call_args.kwargs['input'];self.assertLessEqual(len(payload.encode()),4096)
                self.assertNotIn('summary',payload);self.assertTrue(all(set(r)=={'condition','rendererPrivateDeltaMiB'} for r in json.loads(payload)['formal']))
                self.assertEqual(call.call_args.args[0],[self.wave.node,'tools/ap06-r12-classifier.mjs'])
            self.assertEqual(rows,before)

    def test_process_and_json_schema_failures_are_safe_and_not_retried(self):
        for failure in (OSError(206,'private'),subprocess.TimeoutExpired('private',30),subprocess.CalledProcessError(1,'private')):
            with patch.object(r12.subprocess,'run',side_effect=failure) as call,self.assertRaisesRegex(RuntimeError,'^R12_CLASSIFIER_BRIDGE_FAILED$'):r12.classify(self.wave,self.values)
            self.assertEqual(call.call_count,1)
        for output in ('','not-json','{}','{"status":"PASS"}','x'*4097):
            with patch.object(r12.subprocess,'run',return_value=SimpleNamespace(stdout=output)),self.assertRaises(RuntimeError):r12.classify(self.wave,self.values)
        for bad in (float('nan'),float('inf'),True,'400'):
            values=dict(self.values);values['r12.3']=bad
            with patch.object(r12.subprocess,'run') as call,self.assertRaises(RuntimeError):r12.classify(self.wave,values)
            call.assert_not_called()


if __name__=='__main__':unittest.main()
