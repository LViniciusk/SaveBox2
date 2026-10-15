import copy
import os
from pathlib import Path
import secrets
import tempfile
import unittest
from unittest.mock import patch

import ap06_authorities as authorities
from ap06_key_custody import protect, unprotect, custody_context
import run_ap06_r10 as r10
from run_ap06_r10 import decide, check_r10_budget, FORMAL_ORDER, REPRODUCES, DOES_NOT
from run_readiness_wave1 import WaveFailure
from test_run_ap06_r9 import fixture_run


def r10_raw(condition='r10.0',stage='triage'):
    data,freeze,fixtures=fixture_run()
    freeze['workload']['requestsPerCycle']=len(freeze['workload']['rangesPerCycle'])
    freeze['workload']['workerTransferBytesSentPerCycle']=12345
    data.update(condition=condition,stage=stage,transport=r10.CONDITIONS[condition]['transport'])
    run=data['runs'][0];number=next(i for i,row in enumerate(r10.SCHEDULE,1) if row==(stage,condition))
    run['runId']=f'{stage}-{number:02}-{condition}'
    run['transportProof']=r10.expected_proof(condition)
    for row in run['rangeNetwork']['requests']:row['type']=r10.CONDITIONS[condition]['rangeType']
    run['rangeNetwork']['bootstrapRequests']=[{'requestId':kind,'kind':kind,'method':'POST' if kind=='auth' else 'GET',
        'type':r10.CONDITIONS[condition]['otherType'],'status':200,'finished':True,'failed':False,
        'fromDiskCache':False,'fromServiceWorker':False,'servedFromCache':False,'encodedDataLength':200} for kind in ('auth','tree','pending')]
    run['processExitAudit']['ownedPids']=[1,2,3,4]
    for sample in run['samples']:
        sample['counters']['observed']['workerTransferBytesSent']=12345*sample['cycle']
        sample.setdefault('metrics',{'Documents':1,'Nodes':8})
        sample['rendererMemory']={'heap':{'status':'AVAILABLE','usedSize':20,'totalSize':40,
            'embedderHeapUsedSize':5,'backingStorageSize':10,'unavailable':{}},'dom':{'status':'AVAILABLE',
            'documents':sample['metrics']['Documents'],'nodes':sample['metrics']['Nodes'],'jsEventListeners':3,'unavailable':{}}}
        sample['metrics']['eventListeners']=3
        memory=sample['processMemory'];memory['byCategory'].update({'gpu-process':{'privateBytes':10},'utility':{'privateBytes':20}})
        memory['byType'].update({kind:copy.deepcopy(memory['byCategory'][kind]) for kind in ('browser','renderer')})
        memory['processes']=[{'pid':i,'privateBytes':memory['byCategory'][kind]['privateBytes']} for i,kind in enumerate(('browser','renderer','gpu-process','utility'),1)]
        memory['privateBytes']=sum(row['privateBytes'] for row in memory['processes'])
    return data,freeze,fixtures


class R10Decisions(unittest.TestCase):
    def test_real_protocol_validator_accepts_all_three_triages_and_single_formal_browsers(self):
        for condition,stage in [('r10.0','triage'),('r10.1','triage'),('r10.2','triage'),('r10.0','formal'),('r10.1','formal')]:
            data,freeze,fixtures=r10_raw(condition,stage)
            self.assertIn(r10.validate_condition(data,condition,stage,freeze,fixtures),(REPRODUCES,DOES_NOT))

    def test_plausible_incoherence_in_delegates_bootstrap_heap_dom_and_process_totals_fails(self):
        changes=[lambda run:run['transportProof'].update(xhrBackend=False),
            lambda run:run['rangeNetwork']['bootstrapRequests'][0].update(type='Fetch'),
            lambda run:run['rangeNetwork']['bootstrapRequests'][0].update(requestId='0'),
            lambda run:run['rangeNetwork']['requests'][0].update(encodedDataLength=float('nan')),
            lambda run:run['samples'][2]['rendererMemory']['dom'].update(nodes=999),
            lambda run:run['samples'][2]['rendererMemory']['heap'].update(usedSize=50),
            lambda run:run['samples'][2]['processMemory']['byCategory']['utility'].update(privateBytes=50),
            lambda run:run.update(runId='triage-02-r10.0'),
            lambda run:run['samples'][2]['counters']['observed'].update(workerTransferBytesSent=12345)]
        for change in changes:
            data,freeze,fixtures=r10_raw();change(data['runs'][0])
            with self.assertRaises(WaveFailure):r10.validate_condition(data,'r10.0','triage',freeze,fixtures)

    def test_auxiliary_unavailable_is_explicit_but_invalid_values_do_not_pass(self):
        data,freeze,fixtures=r10_raw();sample=data['runs'][0]['samples'][2]
        sample['rendererMemory']['heap'].update(backingStorageSize=None,status='PARTIAL',unavailable={'backingStorageSize':'FIELD_NOT_SUPPORTED'})
        r10.validate_condition(data,'r10.0','triage',freeze,fixtures)
        sample['rendererMemory']['heap']['unavailable']={}
        with self.assertRaisesRegex(WaveFailure,'MISSING_REASON'):r10.validate_condition(data,'r10.0','triage',freeze,fixtures)

    def test_budget_and_frozen_alternating_order(self):
        self.assertEqual(FORMAL_ORDER,('r10.0','r10.1','r10.1','r10.0','r10.0','r10.1'))
        check_r10_budget(8)
        for value in [9,-1,True,1.5]:
            with self.assertRaises(ValueError):check_r10_budget(value)

    def test_each_scientific_branch_and_complete_formals(self):
        triage={'r10.0':REPRODUCES,'r10.1':DOES_NOT,'r10.2':DOES_NOT}
        formal={'r10.0':[REPRODUCES]*3,'r10.1':[DOES_NOT]*3}
        self.assertEqual(decide(triage,formal)['status'],'PASS_AP06_R10_RANGE_FETCH_EFFECT_CONFIRMED')
        triage['r10.1']=REPRODUCES;formal['r10.1']=[REPRODUCES]*3
        self.assertEqual(decide(triage,formal)['status'],'PASS_AP06_R10_RANGE_FETCH_NO_OWNERSHIP_SHIFT')
        self.assertEqual(decide(triage,formal)['reference'],'GLOBAL_PROVIDER_EFFECT_SUSPECTED')
        for values in [[REPRODUCES]*2,[REPRODUCES,DOES_NOT,REPRODUCES],['INCONCLUSIVE']*3]:
            formal['r10.1']=values
            self.assertEqual(decide(triage,formal)['status'],'BLOCKED_AP06_R10_FORMAL_DISAGREEMENT')
        self.assertEqual(decide({'r10.0':DOES_NOT},{})['status'],'BLOCKED_AP06_R10_CONTROL_NOT_REPRODUCED')
        self.assertEqual(decide({}, {})['status'],'BLOCKED_AP06_R10_INVALID_MEASUREMENT')

    def test_r10_authority_identity_cannot_adopt_or_mutate_r9(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)/'authority';identity=secrets.token_hex(32)
            authorities.initialize(root,identity,campaign='AP-06-R10')
            authorities.validate_owned_destination(root,identity,campaign='AP-06-R10')
            with self.assertRaises(ValueError):authorities.validate_owned_destination(root,identity,campaign='AP-06-R9-R2')


@unittest.skipUnless(os.name=='nt','DPAPI CurrentUser is Windows-only; runtime preflight refuses fallback')
class R10Custody(unittest.TestCase):
    def test_real_current_user_seal_unseal_and_context_binding(self):
        context=custody_context('a'*64,'b'*64)
        payload=secrets.token_bytes(32)
        sealed=protect(payload,context)
        self.assertNotIn(payload,sealed)
        self.assertEqual(unprotect(sealed,context),payload)
        for broken in [sealed[:-1],sealed[:20]+b'corrupt'+sealed[27:]]:
            with self.assertRaises(ValueError):unprotect(broken,context)
        with self.assertRaises(ValueError):unprotect(sealed,custody_context('c'*64,'b'*64))
        invalid=copy.deepcopy(context);invalid['userSid']='S-1-0-0'
        with self.assertRaisesRegex(ValueError,'USER_MISMATCH'):unprotect(sealed,invalid)


if __name__=='__main__':unittest.main()
