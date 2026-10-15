import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import run_ap06_r9 as r9
from run_readiness_wave1 import WaveFailure
from run_ap06_transmux_probe import INCONCLUSIVE
from test_run_ap06_integration_probe import integration_raw, FREEZE, FIXTURES


def fixture_run(condition='r9-r2.0', stage='triage'):
    data = integration_raw('r8.2', stage)
    freeze = copy.deepcopy(FREEZE)
    fixtures = copy.deepcopy(FIXTURES)
    for fixture in fixtures: fixture['ciphertextBytes'] = 1000
    mapping = [{'fixture':n,'fileId':100+n} for n in range(3)]
    freeze['backendFileMapping'] = mapping
    sequence = [[n,'bytes=0-3'] for n in range(3) for _ in range(4)]
    freeze['workload'] = {'rangesPerCycle':sequence,'bytesPerCycle':48}
    data.update(condition=condition,transport=r9.TRANSPORTS[condition],backendFileMapping=mapping)
    for run in data['runs']:
        run['transportProof'] = {'transport':r9.TRANSPORTS[condition], 'xhrBackend':condition!='r9-r2.1',
            'fetchBackend':condition=='r9-r2.1','originalRange':condition!='r9-r2.2',
            'directRange':condition=='r9-r2.2','realAuth':True}
        rows = [{'requestId':str(i),'fixture':n,'fileId':100+n,'range':value,'status':206,
            'type':'XHR' if condition=='r9-r2.0' else 'Fetch','finished':True,'failed':False,
            'fromDiskCache':False,'fromServiceWorker':False,'servedFromCache':False,'encodedDataLength':204,
            'headers':{'content-range':'bytes 0-3/1000','content-length':'4'}} for i,(n,value) in enumerate(sequence*6)]
        run['rangeNetwork'] = {'requests':rows,'enabledBeforeNavigation':True,'listenersDetached':True,
            'sessionDetached':True,'routingInstalled':True,'httpCache':'disabled by Playwright routing',
            'explicitCacheIntervention':False,'duplicateRequestIds':0}
        run['backendTraffic'] = {'pendingGets':0,'rows':[{'fileId':row['fileId'],'status':206} for row in rows]}
        for sample in run['samples']:
            c=sample['counters']['observed'];c['rangeBytesReceived']=sample['cycle']*48
            c['directAuthorizedRanges']=c['rangeRequestsStarted'] if condition=='r9-r2.2' else 0
            if condition=='r9-r2.2':c['jwtRangesValidated']=0
    return data,freeze,fixtures


class R9Tests(unittest.TestCase):
    def test_exact_decision_tree(self):
        self.assertEqual(r9.following('r9-r2.0',r9.REPRODUCES),('triage','r9-r2.1'))
        self.assertIsNone(r9.following('r9-r2.0',r9.DOES_NOT))
        self.assertEqual(r9.following('r9-r2.1',r9.REPRODUCES),('triage','r9-r2.2'))
        self.assertEqual(r9.following('r9-r2.1',r9.DOES_NOT),('formal','r9-r2.1'))
        for classification in (r9.REPRODUCES,r9.DOES_NOT):
            self.assertEqual(r9.following('r9-r2.2',classification),('formal','r9-r2.2'))
        for condition in r9.CONDITIONS:self.assertIsNone(r9.following(condition,INCONCLUSIVE))
        with self.assertRaises(ValueError):r9.following('r8.2',r9.REPRODUCES)

    def test_all_three_formals_must_agree_with_triage(self):
        with self.assertRaises(ValueError):r9.formal_status('r9-r2.0',r9.REPRODUCES,[])
        for condition,classification,suffix in [('r9-r2.1',r9.DOES_NOT,'ANGULAR_FETCH_EFFECT_CONFIRMED'),
            ('r9-r2.2',r9.DOES_NOT,'DIRECT_FETCH_EFFECT_CONFIRMED'),('r9-r2.2',r9.REPRODUCES,'NO_TRANSPORT_ISOLATION')]:
            formal=[{'classification':classification} for _ in range(3)]
            self.assertEqual(r9.formal_status(condition,classification,formal),'PASS_'+r9.PREFIX+suffix)
            self.assertTrue(r9.formal_status(condition,classification,formal[:2]).endswith('FORMAL_DISAGREEMENT'))
            formal[1]['classification']=INCONCLUSIVE
            self.assertTrue(r9.formal_status(condition,classification,formal).endswith('FORMAL_DISAGREEMENT'))

    def test_valid_r9_protocols_reuse_historical_lifecycle_checks(self):
        for condition in r9.CONDITIONS:
            for stage in ('triage','formal'):
                data,freeze,fixtures=fixture_run(condition,stage)
                self.assertIn(r9.validate_condition(data,condition,stage,freeze,fixtures),(r9.REPRODUCES,r9.DOES_NOT))

    def test_cdp_backend_and_client_are_independently_required(self):
        for field,value in [('status',200),('type','Other'),('fromDiskCache',True),('encodedDataLength',None),
                            ('finished',False),('fromServiceWorker',None),('failed',True),('fileId',999)]:
            data,freeze,fixtures=fixture_run();data['runs'][0]['rangeNetwork']['requests'][0][field]=value
            with self.assertRaises(WaveFailure):r9.validate_condition(data,'r9-r2.0','triage',freeze,fixtures)
        for field,value in [('duplicateRequestIds',1),('sessionDetached',False),('enabledBeforeNavigation',False)]:
            data,freeze,fixtures=fixture_run();data['runs'][0]['rangeNetwork'][field]=value
            with self.assertRaises(WaveFailure):r9.validate_condition(data,'r9-r2.0','triage',freeze,fixtures)
        data,freeze,fixtures=fixture_run();data['runs'][0]['backendTraffic']['rows'].pop()
        with self.assertRaisesRegex(WaveFailure,'COUNTS_DISAGREE'):r9.validate_condition(data,'r9-r2.0','triage',freeze,fixtures)
        data,freeze,fixtures=fixture_run();data['runs'][0]['samples'][3]['counters']['observed']['rangeBytesReceived']+=1
        with self.assertRaisesRegex(WaveFailure,'WORKLOAD_CLIENT'):r9.validate_condition(data,'r9-r2.0','triage',freeze,fixtures)

    def test_mode_flag_cannot_replace_di_proof(self):
        data,freeze,fixtures=fixture_run('r9-r2.1');data['runs'][0]['transportProof']['xhrBackend']=True
        with self.assertRaisesRegex(WaveFailure,'DI_PROOF'):r9.validate_condition(data,'r9-r2.1','triage',freeze,fixtures)

    def test_freeze_rejects_changed_source_without_historical_worktrees(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);out=root/r9.OUTPUT;(out/'baseline').mkdir(parents=True)
            (out/'baseline/authority-config.local.json').write_text(json.dumps({'AP06_AUTHORITY_ROOT':str(root/'authority'),'identity':'unit'}))
            source=root/'tool.py';source.write_text('before')
            freeze={'publicationHashes':{},'files':{'tool.py':r9.sha256(source)},'implementationHead':'unit-head'}
            wave=type('UnitWave',(),{'root':root,'output':out,'git':lambda *args:'unit-head'})()
            with patch.object(r9,'verify_publication'):
                r9.verify_freeze(wave,freeze)
                source.write_text('after')
                with self.assertRaisesRegex(WaveFailure,'FROZEN_FILE_CHANGED'):r9.verify_freeze(wave,freeze)


if __name__ == '__main__':unittest.main()
