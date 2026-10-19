"""Small private authorities exercise the entire offline path with real Node."""
import copy
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import adjudicate_ap06_r11_r4 as audit
import ap06_authorities as authority
from test_ap06_r11 import r11_complete_raw


class OfflineAdjudicationTests(unittest.TestCase):
    def fixture(self,change=None):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        root=Path(temporary.name)/'authority';authority.initialize(root,audit.IDENTITY,campaign='AP-06-R10')
        publications={}
        def write(path,data):
            p=root/path;p.parent.mkdir(parents=True,exist_ok=True)
            p.write_bytes(data if isinstance(data,bytes) else (json.dumps(data,indent=2)+'\n').encode())
            return p
        def publish(name,files):
            rows=[]
            for path,data in files.items():
                p=write(path,data);rows.append({'path':path,'size':p.stat().st_size,'sha256':authority.sha256(p)})
            p=write('manifests/'+name+'.json',{'campaign':'AP-06-R10','files':rows});publications[name]=authority.sha256(p)
        _,freeze,fixtures=r11_complete_raw()
        files={audit.SOURCE+'tools/quality/run_ap06_r11.py':(audit.ROOT/'tools/quality/run_ap06_r11.py').read_bytes(),
            audit.SOURCE+'frontend/tools/ap06-r11-contract.mjs':(audit.ROOT/'frontend/tools/ap06-r11-contract.mjs').read_bytes(),
            audit.SOURCE+audit.R3_OUTPUT+'fixtures/manifest.json':(json.dumps(fixtures,indent=2)+'\n').encode(),
            audit.SOURCE+audit.R3_OUTPUT+'baseline/versions.json':{'nodeExecutable':shutil.which('node'),'nodeSha256':authority.sha256(shutil.which('node'))},
            audit.SOURCE+audit.R3_OUTPUT+'tooling/angular-unit-1.json':{'status':'PASS','unitBrowserLaunches':1,'unitBrowserLaunchAttempts':1,'browserClosed':True,'processExitAudit':{'status':'PASS'}}}
        if change=='classifier':files[audit.SOURCE+'frontend/tools/ap06-r11-contract.mjs']+=b'\n// changed\n'
        publish('r11-r3-implementation',files)
        freeze.update(campaign='AP-06-R11-R3',implementationHead='wrong' if change=='head' else audit.IMPLEMENTATION,
            files={p.removeprefix(audit.SOURCE):authority.sha256(root/p) for p in files},
            publicationHashes={'r11-r3-implementation':publications['r11-r3-implementation']})
        fixture_hash=authority.sha256(root/audit.SOURCE/audit.R3_OUTPUT/'fixtures/manifest.json')
        freeze['fixtureHash']=fixture_hash;freeze['multiplexedContract']['fixtureHash']=fixture_hash
        publish('r11-r3-freeze',{'r11-r3/freeze/freeze.json':freeze})
        freeze_hash=authority.sha256(root/'r11-r3/freeze/freeze.json')
        publish('r11-r3-development-reserved',{'r11-r3/evidence/development-reservation.json':{'campaign':'AP-06-R11-R3','implementationHead':audit.IMPLEMENTATION,'developmentMaximum':1,'measurementMaximum':10,'retries':0}})
        rows=[];ledger=[]
        for index,(stage,condition) in enumerate(audit.SCHEDULE,1):
            raw,_,_=r11_complete_raw(condition);raw['stage']=stage;raw['fixtureManifestSha256']=fixture_hash
            raw['runs'][0]['runId']=f'{stage}-{index:02}-{condition}'
            if change=='raw-order' and index==6:raw['runs'][0]['runId']='formal-08-r11.2'
            for s in raw['runs'][0]['samples']:s['fixtureHash']=fixture_hash
            path=f'r11-r3/evidence/{stage}/{index:02}-{condition}/complete.raw.json'
            name=f'r11-r3-{stage}-{index:02}-{condition}'
            publish(name+'-complete',{path:raw});digest=authority.sha256(root/path)
            classified=audit.r11.validate_condition(raw,condition,stage,freeze,fixtures)
            publish(name+'-decision',{path.replace('complete.raw.json','decision.json'):{'condition':condition,'stage':stage,'classification':classified,'rawSha256':digest}})
            delta=audit.r11.renderer_delta(raw)
            rows.append({'condition':condition,'stage':stage,'classification':classified,'rawAuthorityPath':path,'rawSha256':digest,
                'samples':[{'privateDeltaMiB':{'renderer':delta}} for _ in range(10)]})
            ledger.append({'condition':condition,'stage':stage,'reservedAttempts':1,'launchAttempts':1,'browserLaunches':1,'rawSha256':digest})
        if change=='duplicate':ledger[1]=copy.deepcopy(ledger[0])
        if change=='same-hash':ledger[1]['rawSha256']=ledger[0]['rawSha256']
        if change=='order':ledger[5],ledger[6]=ledger[6],ledger[5];ledger[5]['condition']='r11.0'
        publish('r11-r3-ledger-finished-10',{'r11-r3/evidence/ledger-finished-10.json':ledger})
        candidate={'status':'R11_CANDIDATE','hypothesis':'H1','pair':['r11.0','r11.2']}
        publish('r11-r3-triage-decision',{'r11-r3/evidence/triage-decision.json':candidate})
        stop={'reason':'R11_VALIDATION_CONTRACT_FAILED','retries':0,'status':'BLOCKED_AP06_R11_R3'}
        publish('r11-r3-stop-campaign',{'r11-r3/evidence/STOP-campaign.json':stop})
        budget={'developmentUsed':1,'measurementUsed':10,'launchAttempts':11,'retries':0,'totalUsed':11}
        if change=='delta':rows[0]['samples'][6]['privateDeltaMiB']['renderer']+=1
        report={'status':'R11_INCONCLUSIVE','implementationHead':audit.IMPLEMENTATION,'privatePublications':copy.deepcopy(publications),'measurements':rows,'executionStop':stop}
        publish('r11-r3-reports',{'r11-r3/evidence/reports/ap06-r11-r3.json':report})
        seal={'status':'R11_INCONCLUSIVE','implementationHead':audit.IMPLEMENTATION,'evidenceHead':audit.REFERENCE,
            'reportsManifestSha256':publications['r11-r3-reports'],'jsonSha256':authority.sha256(root/'r11-r3/evidence/reports/ap06-r11-r3.json'),'budget':budget,'stop':stop}
        publish('r11-r3-delivery',{'r11-r3/evidence/delivery-seal.json':seal})
        self.enterContext(patch.object(audit,'FREEZE_SHA',freeze_hash))
        self.enterContext(patch.object(audit,'DELIVERY_SHA',publications['r11-r3-delivery']))
        self.enterContext(patch.object(audit,'FROZEN_FILES',len(freeze['files'])))
        return root

    def test_full_independent_adjudication_preserves_history_and_starts_only_node(self):
        root=self.fixture();before=audit.r3_snapshot(root);execute=subprocess.run
        def only_offline(args,*a,**kw):
            self.assertIn(Path(args[0]).stem.lower(),('node','powershell'));return execute(args,*a,**kw)
        with patch.object(audit.r11,'campaign_run',side_effect=AssertionError('NO_CAMPAIGN')),patch.object(audit.r11,'unit_browser',side_effect=AssertionError('NO_BROWSER')),patch.object(audit.r11,'measure',side_effect=AssertionError('NO_MEASUREMENT')),patch.object(subprocess,'run',side_effect=only_offline):
            result=audit.adjudicate(root,audit.IDENTITY)
        self.assertEqual(result['status'],'R11_R4_ADJUDICATION_CONFIRMED');self.assertEqual(result['hypothesis'],'H1')
        self.assertEqual(result['chromiumUsed'],0);self.assertEqual(result['newMeasurements'],0)
        self.assertEqual(audit.r3_snapshot(root),before)

    def test_forged_head_classifier_delta_duplicate_and_order_stop(self):
        for change,reason in [('head','FROZEN_HEAD_CHANGED'),('classifier','CLASSIFIER_CHANGED'),('delta','PUBLISHED_DELTA_CHANGED'),('duplicate','ATTEMPT_ORDER_CHANGED'),('same-hash','RAW_SET_CHANGED'),('order','ATTEMPT_ORDER_CHANGED'),('raw-order','RAW_ORDER_CHANGED')]:
            with self.subTest(change=change):
                root=self.fixture(change)
                with self.assertRaisesRegex(ValueError,reason):audit.adjudicate(root,audit.IDENTITY)

    def test_tamper_missing_manifest_and_raw_stop(self):
        for change in ('hash','manifest','raw'):
            root=self.fixture();p=root/'r11-r3/evidence/triage/01-r11.0/complete.raw.json'
            if change=='hash':p.write_text('changed')
            elif change=='manifest':(root/'manifests/r11-r3-triage-01-r11.0-complete.json').unlink()
            else:p.unlink()
            with self.subTest(change=change),self.assertRaises((ValueError,OSError)):audit.adjudicate(root,audit.IDENTITY)

    def test_ownership_acl_and_external_or_reparse_path_stop(self):
        root=self.fixture();marker=root/'.owned-ap06-r10';saved=marker.read_text();marker.write_text('wrong')
        with self.assertRaisesRegex(ValueError,'OWNERSHIP'):audit.adjudicate(root,audit.IDENTITY)
        marker.write_text(saved)
        with patch.object(authority,'private_permissions',side_effect=ValueError('AUTHORITY_ACL_CHANGED')):
            with self.assertRaisesRegex(ValueError,'ACL_CHANGED'):audit.adjudicate(root,audit.IDENTITY)
        with self.assertRaisesRegex(ValueError,'ABSOLUTE_PATH'):audit.adjudicate(root/'../authority',audit.IDENTITY)
        target=root/'link'
        if os.name=='nt':subprocess.run(['cmd','/c','mklink','/J',str(target),str(root.parent)],capture_output=True,check=True)
        else:target.symlink_to(root.parent,target_is_directory=True)
        try:
            with self.assertRaisesRegex(ValueError,'REPARSE'):audit.adjudicate(root,audit.IDENTITY)
        finally:target.rmdir() if os.name=='nt' else target.unlink()

    def test_altered_unreadable_node_result_stops_after_integrity(self):
        root=self.fixture();execute=subprocess.run
        def altered(args,*a,**kw):
            if Path(args[0]).stem.lower()=='node':return type('Result',(),{'stdout':'{"status":"ALTERED"}'})()
            return execute(args,*a,**kw)
        with patch.object(subprocess,'run',side_effect=altered):
            with self.assertRaisesRegex(RuntimeError,'R11_CLASSIFIER_BRIDGE_FAILED'):audit.adjudicate(root,audit.IDENTITY)

    def test_cli_publishes_only_r4_and_rejects_a_second_adjudication(self):
        root=self.fixture();workspace=root.parent/'workspace';before=audit.r3_snapshot(root)
        for name in ('tools/quality/adjudicate_ap06_r11_r4.py','tools/quality/run_ap06_r11.py',
                'frontend/tools/ap06-r11-classifier.mjs','frontend/tools/ap06-r11-contract.mjs'):
            target=workspace/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(audit.ROOT/name,target)
        execute=subprocess.check_output
        def metadata(args,*a,**kw):
            if args[0]=='git':return '' if args[1]=='status' else 'synthetic-implementation-head'
            return execute(args,*a,**kw)
        with patch.object(audit,'ROOT',workspace),patch('sys.argv',['adjudicator','--root',str(root),'--identity',audit.IDENTITY]),patch.object(subprocess,'check_output',side_effect=metadata):
            output=io.StringIO()
            with redirect_stdout(output):self.assertEqual(audit.main(),0)
            self.assertEqual(json.loads(output.getvalue())['status'],'R11_R4_ADJUDICATION_CONFIRMED')
            authority.verify_publication(root,audit.IDENTITY,'r11-r4-adjudication')
            self.assertEqual(audit.r3_snapshot(root),before)
            with redirect_stdout(io.StringIO()):self.assertEqual(audit.main(),1)
            stop=json.loads((workspace/'.quality/readiness-wave11-r4/final/STOP.json').read_text())
            self.assertEqual(stop['reason'],'R11_R4_ALREADY_ADJUDICATED')


if __name__=='__main__':unittest.main()
