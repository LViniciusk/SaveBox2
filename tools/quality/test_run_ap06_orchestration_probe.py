import hashlib
import json
import math
from pathlib import Path
import socket
import tempfile
from types import SimpleNamespace
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from run_ap06_orchestration_probe import (check_budget, select_baseline, next_condition, checked_classification,
    validate_condition, individual_deltas, measure, REPRODUCES, DOES_NOT, INCONCLUSIVE)
from run_ap06_transport_probe import media_server, byte_range
from run_readiness_wave1 import WaveFailure
from test_run_ap06_transmux_probe import raw, summary, SOURCE, FIXTURE, VERSION

APPROVAL = {'approved':True,'maximumChromiumMeasurementLaunches':7,'retries':0}
FIXTURES = [{'chunkCount':3} for _ in range(3)]


def condition_raw(condition='r6.1', stage='triage'):
    data = raw(stage, 'crypto-transmux-mse', 3 if stage == 'formal' else 1)
    data['orchestratorHash'] = 'runner'
    data['condition'] = condition
    for kind, value in [('browser',1),('renderer',20)]:
        data['summary']['phases'][0]['processTypes'][kind]['privateBytes']['signedDelta'].update(min=value,max=value)
    for run in data['runs']:
        for sample in run['samples']:
            cycle = sample['cycle']; sessions = cycle * 3
            sample.update(harnessHash='harness',orchestratorHash='runner')
            sample['processMemory']['processes'] = [{'pid':1},{'pid':2}]
            sample['processMemory']['byCategory'] = {'browser':{'privateBytes':100 + int(cycle>0)}, 'renderer':{'privateBytes':200 + (20 if cycle else 0)}}
            sample['ownership'].update({key:0 for key in ['cryptoWorkersLive','cryptoWorkerUrlsLive','pendingDecrypts','messagesPendingCrypto','messagesPendingTransmux']})
            c=sample['counters']
            c.update(cryptoWorkersCreated=sessions,cryptoWorkersTerminated=sessions)
            if condition == 'control':
                c.update(transmuxChunksSent=cycle*6,transmuxResponsesReceived=cycle*6);continue
            for key in ['activeDownloads','activeRangeRequests','currentFetches','pendingSchedulerJobs','liveEncryptedFetchBytes']:
                c[key]=0;sample['ownership'][key]=0
            c.update(fetchPromisesCreated=sessions*3,fetchPromisesSettled=sessions*3,processLockJobsQueued=sessions*3,processLockJobsSettled=sessions*3,
                rangeRequestsStarted=sessions*3,rangeRequestsCompleted=sessions*3,rangeRequestsAborted=0,rangeRequestsFailed=0,
                maxActiveDownloads=3 if cycle else 0,maxActiveRangeRequests=2 if cycle else 0,
                sessionsWithConcurrentRanges=sessions,playbackSessionsCompleted=sessions)
    return data


class BaselineAndBudgetTests(unittest.TestCase):
    def test_exact_recovery_uses_the_historical_baseline(self):
        self.assertEqual(select_baseline({'status':'R5_R2_AUTHORITIES_VERIFIED'},{}),'RECOVERED_R5_R2')

    def test_rebaseline_requires_explicit_selection_and_available_hashes(self):
        path='tools/quality/run_ap06_transmux_probe.py';audit={'status':'BLOCKED_MISSING_R5_R2_AUTHORITY','unavailableAuthorities':[path]}
        self.assertEqual(select_baseline(audit,{path:'a'*64},True),'NEW_BASELINE_REQUIRES_CONTROL')
        for available,allowed in [({},True),({path:True},True),({path:'a'*64},False)]:
            with self.assertRaises(WaveFailure):select_baseline(audit,available,allowed)

    def test_invalid_history_or_missing_bundle_cannot_be_rebaselined(self):
        for audit in [{'status':'BLOCKED_INVALID_R5_R2_AUTHORITY'}, {'status':'BLOCKED_MISSING_R5_R2_AUTHORITY','unavailableAuthorities':['worker.js']}]:
            with self.assertRaises(WaveFailure):select_baseline(audit,{'worker.js':'a'*64},True)

    def test_budget_includes_control_and_exact_three_formals(self):
        check_budget(APPROVAL,4,3)
        for previous,requested in [(5,3),(7,1),(-1,1),(0,2),(True,1)]:
            with self.assertRaises(WaveFailure):check_budget(APPROVAL,previous,requested)
        for change in [{'approved':False},{'retries':1},{'maximumChromiumMeasurementLaunches':8},{'maximumChromiumMeasurementLaunches':True}]:
            with self.assertRaises(WaveFailure):check_budget({**APPROVAL,**change},0,1)

    def test_conditional_tree_stops_control_divergence_ambiguity_and_after_formal_selection(self):
        self.assertEqual(next_condition('control',DOES_NOT),('triage','r6.1'))
        self.assertEqual(next_condition('r6.1',DOES_NOT),('triage','r6.2'))
        self.assertEqual(next_condition('r6.2',DOES_NOT),('triage','r6.3'))
        self.assertIsNone(next_condition('r6.3',DOES_NOT))
        self.assertIsNone(next_condition('control',REPRODUCES))
        for condition in ['r6.1','r6.2','r6.3']:
            self.assertEqual(next_condition(condition,REPRODUCES),('formal',condition))
            self.assertIsNone(next_condition(condition,INCONCLUSIVE))

    def test_classifier_uses_only_cycle_six_natural_and_rejects_zero_ties_and_nonfinite(self):
        self.assertEqual(checked_classification(summary(20,1)),REPRODUCES)
        self.assertEqual(checked_classification(summary(1,20)),DOES_NOT)
        for a,b in [(0,0),(1,1),(-1,-2),(math.nan,1),(math.inf,1),(True,2)]:
            self.assertEqual(checked_classification(summary(a,b)),INCONCLUSIVE)
        forced=summary(20,1);forced['phases'][0]['gc']='forced-diagnostic'
        self.assertEqual(checked_classification(forced),INCONCLUSIVE)

    def test_control_and_orchestration_share_the_strict_protocol(self):
        for condition in ['control','r6.1','r6.2','r6.3']:
            data=condition_raw(condition)
            self.assertEqual(validate_condition(data,condition,'triage',SOURCE,FIXTURE,'harness','runner',FIXTURES),DOES_NOT)
        formal=condition_raw('r6.1','formal')
        self.assertEqual(validate_condition(formal,'r6.1','formal',SOURCE,FIXTURE,'harness','runner',FIXTURES),DOES_NOT)
        formal['runs'].pop()
        with self.assertRaises(WaveFailure):validate_condition(formal,'r6.1','formal',SOURCE,FIXTURE,'harness','runner',FIXTURES)

    def test_insufficient_concurrency_is_not_negative_causal_evidence(self):
        data=condition_raw();data['runs'][0]['samples'][6]['counters']['maxActiveRangeRequests']=1
        with self.assertRaisesRegex(WaveFailure,'INSUFFICIENT_SCHEDULER_EXERCISE'):
            validate_condition(data,'r6.1','triage',SOURCE,FIXTURE,'harness','runner',FIXTURES)

    def test_sampling_loss_cleanup_and_wrong_fixture_identity_stop_classification(self):
        for mutate in [lambda d:d['runs'][0]['samples'][1]['processMemory'].update(processes=[]),
            lambda d:d['runs'][0]['samples'][1]['counters'].update(activeDownloads=1),
            lambda d:d.update(fixtureManifestSha256='different'),
            lambda d:d.update(condition='other-condition'),
            lambda d:d['runs'][0]['samples'][1]['counters'].update(cryptoWorkersTerminated=0)]:
            data=condition_raw();mutate(data)
            with self.assertRaises(WaveFailure):validate_condition(data,'r6.1','triage',SOURCE,FIXTURE,'harness','runner',FIXTURES)

    def test_summary_cannot_supply_a_classification_different_from_its_raw_deltas(self):
        data=condition_raw();data['summary']['phases'][0]['processTypes']['browser']['privateBytes']['signedDelta']['median']=99
        with self.assertRaisesRegex(WaveFailure,'SUMMARY_DOES_NOT_MATCH_RAW'):
            validate_condition(data,'r6.1','triage',SOURCE,FIXTURE,'harness','runner',FIXTURES)

    def test_formal_preserves_individual_signed_deltas_and_disagreement(self):
        data=condition_raw(stage='formal');data['runs'][0]['samples'][6]['processMemory']['byCategory']['browser']['privateBytes']=130
        rows=individual_deltas(data)
        self.assertEqual([row['classification'] for row in rows],[REPRODUCES,DOES_NOT,DOES_NOT])
        self.assertEqual(rows[0]['browserDeltaMiB'],30/1048576)

    def test_existing_stage_is_never_overwritten_or_retried(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);stage=root/'triage/control';stage.mkdir(parents=True)
            raw_path=stage/'raw.json';raw_path.write_text('immutable')
            wave=SimpleNamespace(output=root)
            with self.assertRaises(FileExistsError):measure(wave,'control','triage',[],root,root/'manifest.json',{},[],APPROVAL)
            self.assertEqual(raw_path.read_text(),'immutable')


class RangeServerTests(unittest.TestCase):
    def test_strict_range_bounds_do_not_change_legacy_open_range_behavior(self):
        self.assertEqual(byte_range('bytes=1-',5),(1,4))
        self.assertEqual(byte_range('bytes=1-99',5),(1,4))
        self.assertEqual(byte_range('bytes=1-4',5,True),(1,4))
        for value in ['bytes=1-','bytes=1-5','bytes=-2','bytes=0-1,3-4','bytes=5-6','bytes=2-1']:
            with self.assertRaises(ValueError):byte_range(value,5,True)

    def test_loopback_whitelist_inclusive_partial_range_and_416(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'fixture.bin';path.write_bytes(b'abcdef')
            with media_server({'/video-0.mp4':path},strict_ranges=True,content_type='application/octet-stream') as (origin,stats):
                with urlopen(Request(origin+'/video-0.mp4',headers={'Range':'bytes=2-5'}),timeout=3) as response:
                    self.assertEqual(response.status,206);self.assertEqual(response.headers['Content-Range'],'bytes 2-5/6')
                    self.assertEqual(response.headers['Content-Length'],'4');self.assertEqual(response.read(),b'cdef')
                    self.assertEqual(response.headers['Cache-Control'],'no-store')
                    self.assertEqual(response.headers['Content-Type'],'application/octet-stream')
                for url,headers,expected in [('/video-0.mp4',{},416),('/video-0.mp4',{'Range':'bytes=0-6'},416),
                    ('/video-0.mp4',{'Range':'bytes=0-1,3-4'},416),('/../private-key',{'Range':'bytes=0-1'},404),
                    ('/video-99.mp4',{'Range':'bytes=0-1'},404)]:
                    with self.assertRaises(HTTPError) as caught:urlopen(Request(origin+url,headers=headers),timeout=3)
                    self.assertEqual(caught.exception.code,expected);caught.exception.close()
            with self.assertRaises(OSError):urlopen(origin,timeout=0.2)
            self.assertEqual(stats['ranges'],1)

    def test_server_rejects_unwhitelisted_or_missing_fixture_maps(self):
        for files in [{},{'/../private-key':Path('none')},{'/video-0.mp4':Path('none')}]:
            with self.assertRaises(ValueError):
                with media_server(files):pass


if __name__ == '__main__':
    unittest.main()
