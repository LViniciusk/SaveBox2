"""Exercise the actual Windows Python/Node boundary without Chromium."""
import copy
import json
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import run_ap06_r11 as r11

ROOT=Path(__file__).resolve().parents[2]


class ClassifierBridgeTests(unittest.TestCase):
    def setUp(self):
        self.wave=SimpleNamespace(root=ROOT,node=shutil.which('node'))
        self.values={'r11.0':30,'r11.1':450,'r11.2':400,'r11.3':420}

    def formal(self,candidate,size=0):
        a,b=candidate['pair']
        return [{'condition':c,'rendererPrivateDeltaMiB':50 if c==a else 400,
            'summary':{'privateNeverSent':'x'*size},'rawPath':'private-not-for-node'} for c in (a,b,b,a,a,b)]

    def test_real_public_bridge_triage_and_formal_all_hypotheses(self):
        for x,y,hypothesis in ((400,420,'H1'),(50,400,'H2'),(50,60,'H3')):
            values=dict(self.values,**{'r11.2':x,'r11.3':y})
            candidate=r11.classify(self.wave,values)
            self.assertEqual(candidate['hypothesis'],hypothesis)
            self.assertEqual(r11.classify(self.wave,values,self.formal(candidate),candidate)['status'],'R11_ATTRIBUTION_CONFIRMED')
        self.assertEqual(r11.classify(self.wave,dict(self.values,**{'r11.1':299}))['status'],'R11_CONTROL_NOT_REPRODUCED')

    def test_real_public_bridge_large_summaries_never_reach_node(self):
        candidate={'status':'R11_CANDIDATE','hypothesis':'H1','pair':['r11.0','r11.2']}
        execute=subprocess.run
        for size in (150_000,1_000_000):
            results=self.formal(candidate,size);before=copy.deepcopy(results)
            with patch.object(r11.subprocess,'run',wraps=execute) as process:
                result=r11.classify(self.wave,self.values,results,candidate)
            self.assertEqual(result['status'],'R11_ATTRIBUTION_CONFIRMED')
            self.assertEqual(results,before)
            args,kwargs=process.call_args
            self.assertEqual(args[0],[self.wave.node,'tools/ap06-r11-classifier.mjs'])
            self.assertLessEqual(len(kwargs['input'].encode('utf-8')),4096)
            self.assertNotIn('privateNeverSent',kwargs['input'])
            self.assertTrue(all(set(r)=={'condition','rendererPrivateDeltaMiB'} for r in json.loads(kwargs['input'])['formal']))

    def test_output_matches_direct_original_classifier(self):
        candidate=r11.classify(self.wave,self.values);results=self.formal(candidate)
        payload={'candidate':candidate,'control':450,'formal':r11.formal_scalars(results)}
        script="import{confirmFormal}from'./tools/ap06-r11-contract.mjs';const p=JSON.parse(process.argv[1]);console.log(JSON.stringify(confirmFormal(p.candidate,p.control,p.formal)))"
        direct=json.loads(subprocess.check_output([self.wave.node,'--input-type=module','-e',script,json.dumps(payload)],cwd=ROOT/'frontend',text=True))
        self.assertEqual(r11.classify(self.wave,self.values,results,candidate),direct)

    def test_formal_count_scalars_and_order(self):
        candidate=r11.classify(self.wave,self.values);results=self.formal(candidate)
        for count in (0,5,7):
            rows=(results+results)[:count]
            with self.assertRaisesRegex(ValueError,'R11_INVALID_FORMAL_COUNT'):r11.formal_scalars(rows)
        for field,value in [('condition','unknown'),('condition',[]),('rendererPrivateDeltaMiB',True),
                ('rendererPrivateDeltaMiB',float('nan')),('rendererPrivateDeltaMiB',float('inf')),('rendererPrivateDeltaMiB','400')]:
            rows=copy.deepcopy(results);rows[0][field]=value
            with self.assertRaisesRegex(ValueError,'R11_INVALID_FORMAL_SCALAR'):r11.formal_scalars(rows)
        results[0]['condition']='r11.2'
        self.assertEqual(r11.classify(self.wave,self.values,results,candidate),{'status':'R11_INCONCLUSIVE','reason':'FORMAL_DISAGREEMENT'})

    def test_process_failures_are_sanitized_and_not_retried(self):
        errors=[OSError('private path'),subprocess.CalledProcessError(1,['private'],stderr='secret'),
            subprocess.TimeoutExpired(['private'],30,stderr='secret')]
        for error in errors:
            with patch.object(r11.subprocess,'run',side_effect=error) as process:
                with self.assertRaisesRegex(RuntimeError,'^R11_CLASSIFIER_BRIDGE_FAILED$') as raised:r11.classify(self.wave,self.values)
            self.assertIsNone(raised.exception.__cause__)
            self.assertEqual(process.call_count,1)

    def test_invalid_empty_large_and_unexpected_process_output(self):
        outputs=['','private secret','null','[]','{}','{"status":"FORGED"}',
            '{"status":"R11_CANDIDATE","hypothesis":"H1","pair":["r11.2","r11.3"]}',
            '{"status":"R11_INCONCLUSIVE","secret":"private"}','x'*4097]
        for stdout in outputs:
            with patch.object(r11.subprocess,'run',return_value=SimpleNamespace(stdout=stdout)):
                with self.assertRaisesRegex((ValueError,RuntimeError),'R11_CLASSIFIER_'):r11.classify(self.wave,self.values)

    def test_limit_rejects_before_starting_process(self):
        with patch.object(r11.subprocess,'run') as process:
            with self.assertRaisesRegex(ValueError,'R11_CLASSIFIER_INPUT_TOO_LARGE'):
                r11.invoke_classifier(self.wave.node,ROOT/'frontend',{'mode':'triage','values':self.values,'extra':'x'*4097})
        process.assert_not_called()


if __name__=='__main__':unittest.main()
