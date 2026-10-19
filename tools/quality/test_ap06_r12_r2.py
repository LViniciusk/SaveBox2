import copy,json,shutil,subprocess,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from ap06_authorities import initialize,sha256,publish_snapshot,verify_publication
from run_ap06_r9 import publish,verify_freeze
import run_ap06_r12_r2 as r2
from test_ap06_r12 import complete_raw as r12_raw

def complete_raw(condition='r12r2.3'):
    raw,freeze,fixtures=r12_raw('r12.0');run=raw['runs'][0]
    raw.update(condition=condition,transport='factorial',metadataTransport=r2.CONDITIONS[condition]['metadata'],payloadTransport=r2.CONDITIONS[condition]['payload'])
    run['runId']=f'triage-{list(r2.CONDITIONS).index(condition)+1:02}-{condition}'
    run['transportProof']=r2.expected_proof('r10.1')
    for row in run['rangeNetwork']['requests']:
        row.update(method='GET',url=f"http://127.0.0.1:42187/files/{row['fileId']}/download")
        kind='metadata' if row['range']=='bytes=0-131071' else 'payload';row['type']=r2.CONDITIONS[condition][kind].capitalize() if r2.CONDITIONS[condition][kind]=='fetch' else 'XHR'
    for s in run['samples']:
        s['counters']['r12r2']=s['counters'].pop('r12');s['counters']['routing']=r2.transport_counts(condition,s['cycle']*3)
    return raw,freeze,fixtures

class FactorialTests(unittest.TestCase):
    def setUp(self):
        self.campaign_state=(r2.OUTPUT,r2.PUBLISHER,r2.CAMPAIGN)
        r2.OUTPUT='.quality/readiness-wave12-r2-factorial'
        r2.PUBLISHER=Path(r2.__file__).resolve()
        r2.CAMPAIGN='AP-06-R12-R2-factorial'

    def tearDown(self):
        r2.OUTPUT,r2.PUBLISHER,r2.CAMPAIGN=self.campaign_state

    def test_factorial_namespace_publication_readback_freeze_and_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);authority=root/'authority';identity='b'*64;initialize(authority,identity,campaign='AP-06-R10')
            workspace=root/'repo';out=workspace/r2.OUTPUT;(out/'baseline').mkdir(parents=True);(out/'pipeline').mkdir()
            (out/'baseline/authority-config.local.json').write_text(json.dumps({'AP06_AUTHORITY_ROOT':str(authority),'identity':identity}))
            wave=SimpleNamespace(output=out,root=workspace,git=lambda *args:'head')
            source=workspace/'source.py';source.write_text('fixed implementation')
            receipt=publish(wave,'implementation',{'tooling/source/source.py':source})
            frozen={'implementationHead':'head','implementationPublication':'r12-r2-factorial-implementation','freezePublication':'r12-r2-factorial-freeze',
                'publicationHashes':{'r12-r2-factorial-implementation':receipt['manifestSha256']},'files':{'source.py':sha256(source)}}
            path=out/'freeze.json';path.write_text(json.dumps(frozen));publish(wave,'freeze',{'freeze/freeze.json':path})
            publish_snapshot(authority,identity,'corpus-publication',{'corpus/test':source},out/'pipeline');verify_freeze(wave,frozen)
            stop=out/'STOP.json';stop.write_text('{"reason":"SYNTHETIC_FAILURE"}');publish(wave,'stop-campaign',{'evidence/STOP.json':stop})
            self.assertEqual(verify_publication(authority,identity,'r12-r2-factorial-stop-campaign')['files'][0]['path'],'r12-r2-factorial/evidence/STOP.json')
            source.write_text('changed')
            with self.assertRaises(RuntimeError):verify_freeze(wave,frozen)

    def test_four_full_raw_validator_paths(self):
        for condition in r2.CONDITIONS:
            raw,freeze,fixtures=complete_raw(condition)
            self.assertEqual(r2.validate_condition(raw,condition,'triage',freeze,fixtures),'R12R2_FACTORIAL_VALID')
            raw['stage']='formal';raw['runs'][0]['runId']='formal-05-'+condition
            self.assertEqual(r2.validate_condition(raw,condition,'formal',freeze,fixtures),'R12R2_FACTORIAL_VALID')

    def test_full_raw_guards_reject_independent_corruptions(self):
        raw,freeze,fixtures=complete_raw('r12r2.2')
        mutate=[lambda r:r.update(workersUsed=True),lambda r:r.update(payloadTransport='xhr'),lambda r:r.update(pageScriptSha256='bad'),
            lambda r:r['runs'][0].update(runId='triage-01-r12r2.2'),lambda r:r['runs'][0]['rangeNetwork']['requests'][0].update(type='Fetch'),
            lambda r:r['runs'][0]['rangeNetwork']['requests'][1].update(type='XHR'),lambda r:r['runs'][0]['rangeNetwork']['requests'][0].update(range='bytes=0-1023'),
            lambda r:r['runs'][0]['rangeNetwork']['requests'][1].update(status=200),lambda r:r['runs'][0]['rangeNetwork']['requests'][1].update(fileId=999),
            lambda r:r['runs'][0]['rangeNetwork']['requests'][1].update(url='https://outside.test'),
            lambda r:r['runs'][0]['rangeNetwork']['requests'][1]['headers'].update({'content-length':'0'}),
            lambda r:r['runs'][0]['rangeNetwork']['bootstrapRequests'][0].update(type='Fetch'),
            lambda r:r['runs'][0]['rangeNetwork']['requests'].reverse(),lambda r:r['runs'][0]['rangeNetwork']['requests'].pop(),
            lambda r:r['runs'][0]['samples'][6]['counters']['routing'].update(payloadfetchBytes=0),
            lambda r:r['runs'][0]['samples'][6]['counters']['r12r2'].update(payloadArrayBufferCount=1),
            lambda r:r['runs'][0]['samples'][6]['counters']['r12r2'].update(activeReferences=1),
            lambda r:r['runs'][0]['samples'][6]['counters']['observed'].update(jwtRangesValidated=0),
            lambda r:r['runs'][0]['samples'][6]['counters']['observed'].update(playbackStarted=1),
            lambda r:r['runs'][0]['samples'][9]['counters']['r12r2'].update(obtainMs=9),
            lambda r:r['runs'][0]['samples'][9].update(timestamp=r['runs'][0]['samples'][8]['timestamp']),
            lambda r:r['runs'][0]['samples'][8].update(gc='forced-diagnostic'),
            lambda r:r['runs'][0]['samples'][4]['processMemory']['processes'][1].update(pid=999),
            lambda r:r['runs'][0]['samples'][4]['processMemory'].update(privateBytes=1),
            lambda r:r['runs'][0]['processExitAudit'].update(aliveOwnedPids=[1])]
        for change in mutate:
            bad=copy.deepcopy(raw);change(bad)
            with self.subTest(change=change),self.assertRaises((RuntimeError,ValueError)):r2.validate_condition(bad,'r12r2.2','triage',freeze,fixtures)

    def test_real_windows_bridge_projects_large_summaries(self):
        wave=SimpleNamespace(root=Path(__file__).resolve().parents[2],node=shutil.which('node'))
        values=dict(zip(r2.CONDITIONS,(0,0,400,400)));candidate=r2.classify(wave,values)
        a,b=candidate['pair'];execute=subprocess.run
        for size in (150000,1000000):
            rows=[dict(condition=c,rendererPrivateDeltaMiB=400 if c==b else 0,summary={'data':'X'*size}) for c in (a,b,b,a,a,b)]
            with patch.object(r2.subprocess,'run',wraps=execute) as call:
                self.assertEqual(r2.classify(wave,values,rows,candidate)['status'],'R12R2_FACTORIAL_CONFIRMED')
                payload=call.call_args.kwargs['input'];self.assertLessEqual(len(payload.encode()),4096);self.assertNotIn('summary',payload)
        for failure in (OSError(206,'private'),subprocess.TimeoutExpired('private',30),subprocess.CalledProcessError(1,'private')):
            with patch.object(r2.subprocess,'run',side_effect=failure) as call,self.assertRaisesRegex(RuntimeError,'^R12R2_CLASSIFIER_BRIDGE_FAILED$'):r2.classify(wave,values)
            self.assertEqual(call.call_count,1)
        for output in ('not-json','{}','{"status":"PASS"}','x'*4097):
            with patch.object(r2.subprocess,'run',return_value=SimpleNamespace(stdout=output)),self.assertRaises(RuntimeError):r2.classify(wave,values)

    def test_factorial_budget_zero_retries_and_terminal_reservation(self):
        budget={'approved':True,'developmentMaximum':1,'measurementMaximum':10,'measurementRetries':0}
        for used in range(10):r2.check_budget(budget,used,1)
        for used in (-1,10,True):
            with self.assertRaises(RuntimeError):r2.check_budget(budget,used,1)
        with tempfile.TemporaryDirectory() as tmp:
            out=Path(tmp);(out/'pipeline').mkdir();(out/'pipeline/campaign-started.json').write_text('{}')
            with self.assertRaisesRegex(RuntimeError,'NO_RETRY'),patch.object(r2,'verify_r11_freeze') as verify:r2.campaign_run(SimpleNamespace(output=out))
            verify.assert_not_called()

if __name__=='__main__':unittest.main()
