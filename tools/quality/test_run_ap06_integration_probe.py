import copy
import math
from pathlib import Path
import tempfile
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from run_ap06_integration_probe import (AUTOPLAY, CONDITIONS, check_budget, next_condition, claim_stage,
    validate_condition, verify_freeze, expected_source_buffers, audit_closed_pids)
from run_ap06_transport_probe import media_server
from run_ap06_orchestration_probe import checked_classification
from run_ap06_transmux_probe import DOES_NOT, REPRODUCES, INCONCLUSIVE
from run_readiness_wave1 import WaveFailure
from ap06_local_backend import verify_storage, isolated_database
from test_run_ap06_orchestration_probe import condition_raw
from test_run_ap06_transmux_probe import SOURCE, FIXTURE, summary

BUDGET = {'approved': True, 'measurementMaximum': 6, 'measurementRetries': 0}
FIXTURES = [{'id': n, 'name': f'unit-{n}', 'bytes': 100, 'sha256': str(n),
    'tracks': [{'type': kind} for kind in (['video'] if n == 1 else ['video', 'audio'])]} for n in range(3)]
FREEZE = {'sourceHash': SOURCE, 'fixtureHash': FIXTURE, 'harnessHash': 'harness', 'runnerHash': 'runner',
    'workers': {'crypto': {'name': 'worker-C.js', 'sha256': 'crypto'}, 'transmux': {'name': 'worker-T.js', 'sha256': 'transmux'}},
    'appProducts': {'main.js': 'app'}, 'pageScriptSha256': 'page',
    'backendAuthoritySha256': 'backend', 'backendFileMapping': [{'fixture':0,'fileId':100}]}
FREEZE['multiplexedContract'] = {'fixtureHash': FIXTURE,
    'workerHashes': {'crypto': 'crypto', 'transmux': 'transmux'}, 'initDataPerFixture': [1, 1, 1], 'initDataId': 0}


def integration_raw(condition='r8.1', stage='triage'):
    data = condition_raw('r6.1', stage)
    data.update(condition=condition, angularOrBackendUsed=True, videoStreamServiceUsed=True,
        videoPlayerComponentUsed=True, backendUsed=condition == 'r8.2', driveStoreUsed=condition != 'r8.0', fullKasumiContainer=True,
        backendAuthoritySha256='backend' if condition == 'r8.2' else None,
        backendFileMapping=FREEZE['backendFileMapping'] if condition == 'r8.2' else None,
        autoplayArgs=AUTOPLAY, playwrightRoutingInstalled=True, localRequestsIntercepted=False,
        experimentalAppProducts=FREEZE['appProducts'], pageScriptSha256='page',
        fixtureIdentities=[{key: fixture[key] for key in ('id', 'name', 'bytes', 'sha256')} for fixture in FIXTURES],
        cryptoWorkerBundleSha256='crypto', workerBundleSha256='transmux', pageErrors=0, recoveryWarnings=0,
        network={'rejectedRequests': 0, 'externalRequests': 0, 'unexpectedRequests': 0,
            'workerRequests': {'worker-C.js': 18, 'worker-T.js': 18}})
    for run in data['runs']:
        run['processExitAudit'] = {'status': 'PASS', 'ownedPids': [1, 2], 'aliveOwnedPids': []}
        for sample in run['samples']:
            cycle = sample['cycle']; sessions = cycle * 3
            sample.update(workerBundleHash='transmux', cryptoWorkerBundleHash='crypto')
            observed = dict.fromkeys(('initializeFailures', 'playbackFailures', 'rangeRequestsFailed', 'rangeRequestsAborted',
                'workerErrors', 'transferFailures', 'unhandledRejections', 'pendingOperations', 'pendingAppends', 'activeRanges',
                'timersLive', 'experimentalListeners', 'workerMessagesCancelled'), 0)
            observed.update(dict.fromkeys(('initializeAttempts', 'initializeSettled', 'playbackStarted', 'playbackCompleted',
                'destroyCalls', 'metadataRequests', 'mediaSourcesCreated', 'mediaSourcesClosed', 'sourceBuffersCreated', 'sourceBuffersReleased'), sessions))
            components = sessions * 2
            observed.update(componentsMounted=components, componentsDestroyed=components, workersCreated=sessions * 2,
                workersTerminated=sessions * 2, rangeRequestsStarted=sessions * 4, rangeRequestsCompleted=sessions * 4,
                workerMessagesSent=sessions * 6, workerMessagesReceived=sessions * 6, bytesAppended=sessions * 100, detachedTransfers=sessions * 6)
            sample['counters']['observed'] = observed
            store_used, backend_used = int(condition != 'r8.0'), int(condition == 'r8.2')
            observed.update(storeLoadStarted=store_used, storeLoadCompleted=store_used, storeEffectsSettled=store_used,
                storeFileResolved=sessions * store_used, authAttempts=backend_used, authSuccesses=backend_used,
                backendFileIdMatches=sessions * backend_used, outstandingSubscriptions=0, unexpectedPeripheralOperations=0,
                http206Validated=observed['rangeRequestsCompleted'] * backend_used,
                jwtRangesValidated=observed['rangeRequestsStarted'] * backend_used)
            selected = {'r8.0': 'component', 'r8.1': 'store', 'r8.2': 'backend'}[condition]
            sample['counters']['sessions'] = [{'fixture': index % 3, 'mode': selected, 'mountedMs': index * 3000,
                'canplayMs': index * 3000 + 10, 'playbackMs': index * 3000 + 510,
                'closeMs': index * 3000 + 2500, 'maxCurrentTime': 1.75, 'seeks': 0, 'muted': False,
                'volume': 1, 'playbackRate': 1} for index in range(sessions)]
    return data


class R8Contracts(unittest.TestCase):
    def test_each_chromium_requires_an_independent_pid_exit_audit(self):
        for audit in [None, {'status':'FAIL','ownedPids':[1,2],'aliveOwnedPids':[1]},
                {'status':'PASS','ownedPids':[],'aliveOwnedPids':[]}]:
            data = integration_raw(); data['runs'][0]['processExitAudit'] = audit
            with self.assertRaisesRegex(WaveFailure, 'CHROMIUM_NOT_VERIFIED_CLOSED'):
                validate_condition(data, 'r8.1', 'triage', FREEZE, FIXTURES)
    def test_closed_pid_auditor_rejects_missing_or_untrusted_ids(self):
        for ids in [[], [True], [-1], ['123'], list(range(1, 66))]:
            with self.assertRaises(WaveFailure): audit_closed_pids(ids)
    def test_store_and_http_boundary_counters_are_independently_required(self):
        for condition in CONDITIONS:
            for key in ('storeLoadStarted', 'storeLoadCompleted', 'storeEffectsSettled', 'storeFileResolved',
                    'authAttempts', 'authSuccesses', 'backendFileIdMatches', 'outstandingSubscriptions',
                    'unexpectedPeripheralOperations', 'http206Validated', 'jwtRangesValidated'):
                data = integration_raw(condition)
                data['runs'][0]['samples'][6]['counters']['observed'][key] += 1
                with self.assertRaisesRegex(WaveFailure, 'STORE_AUTH_OR_HTTP'):
                    validate_condition(data, condition, 'triage', FREEZE, FIXTURES)

    def test_backend_authority_and_file_mapping_cannot_be_substituted(self):
        for key, value in [('backendAuthoritySha256', 'wrong'), ('backendFileMapping', []),
                ('driveStoreUsed', False), ('backendUsed', False), ('videoPlayerComponentUsed', False)]:
            data = integration_raw('r8.2'); data[key] = value
            with self.assertRaises(WaveFailure): validate_condition(data, 'r8.2', 'triage', FREEZE, FIXTURES)

    def test_native_storage_and_database_ownership_guards(self):
        self.assertTrue(isolated_database('nanika_e2e_r8_unit'))
        for name in ('nanika', 'postgres', 'nanika_e2e_', 'nanika_e2e_../personal', 'nanika_e2e_é'):
            self.assertFalse(isolated_database(name))
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary); identity = 'a' * 64
            with self.assertRaises(RuntimeError): verify_storage(path, identity)
            (path / '.nanika-e2e-storage-id').write_text('wrong')
            with self.assertRaises(RuntimeError): verify_storage(path, identity)
            (path / '.nanika-e2e-storage-id').write_text(identity)
            verify_storage(path, identity)
            with self.assertRaises(RuntimeError): verify_storage(Path('relative'), identity)

    def test_budget_includes_control_and_exact_formal_three(self):
        for previous, requested in [(0, 1), (1, 1), (2, 1), (2, 3), (3, 3)]:
            check_budget(BUDGET, previous, requested)
        for previous, requested in [(4, 3), (6, 1), (-1, 1), (True, 1), (0, 2), (0, True)]:
            with self.assertRaises(WaveFailure): check_budget(BUDGET, previous, requested)
        for patch in [{'approved': False}, {'measurementMaximum': 7}, {'measurementRetries': 1}]:
            with self.assertRaises(WaveFailure): check_budget({**BUDGET, **patch}, 0, 1)

    def test_order_and_reproduction_stop_boundaries(self):
        self.assertEqual(next_condition('r8.0', DOES_NOT), ('triage', 'r8.1'))
        self.assertEqual(next_condition('r8.1', DOES_NOT), ('triage', 'r8.2'))
        self.assertIsNone(next_condition('r8.2', DOES_NOT))
        self.assertIsNone(next_condition('r8.0', REPRODUCES))
        for condition in ('r8.1', 'r8.2'):
            self.assertEqual(next_condition(condition, REPRODUCES), ('formal', condition))
        for condition in CONDITIONS:
            self.assertIsNone(next_condition(condition, INCONCLUSIVE))

    def test_natural_cycle_six_predicate_is_unchanged(self):
        self.assertEqual(checked_classification(summary(20, 1)), REPRODUCES)
        self.assertEqual(checked_classification(summary(1, 20)), DOES_NOT)
        for browser, renderer in [(0, 0), (1, 1), (-1, -2), (math.nan, 1), (math.inf, 1)]:
            self.assertEqual(checked_classification(summary(browser, renderer)), INCONCLUSIVE)
        forced = summary(20, 1); forced['phases'][0]['gc'] = 'forced-diagnostic'
        self.assertEqual(checked_classification(forced), INCONCLUSIVE)

    def test_stage_is_exclusive_and_control_cannot_be_formal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            claim_stage(root, 'r8.1', 'triage')
            with self.assertRaisesRegex(WaveFailure, 'BLOCKED_EXISTING'): claim_stage(root, 'r8.1', 'triage')
            with self.assertRaises(WaveFailure): claim_stage(root, 'r8.0', 'formal')

    def test_all_conditions_share_the_exact_protocol_and_allow_only_real_expected_integrations(self):
        for condition in CONDITIONS:
            self.assertEqual(validate_condition(integration_raw(condition), condition, 'triage', FREEZE, FIXTURES), DOES_NOT)
        self.assertEqual(validate_condition(integration_raw('r8.1', 'formal'), 'r8.1', 'formal', FREEZE, FIXTURES), DOES_NOT)

    def test_formal_requires_three_independent_browsers_and_eight_samples_each(self):
        data = integration_raw('r8.1', 'formal'); data['runs'].pop()
        with self.assertRaises(WaveFailure): validate_condition(data, 'r8.1', 'formal', FREEZE, FIXTURES)
        data = integration_raw(); data['runs'][0]['samples'].pop()
        with self.assertRaises(WaveFailure): validate_condition(data, 'r8.1', 'triage', FREEZE, FIXTURES)

    def test_multiplexed_cohort_has_three_buffers_per_cycle_and_eighteen_at_six(self):
        self.assertEqual([len(row['tracks']) for row in FIXTURES], [2, 1, 2])
        self.assertEqual(expected_source_buffers(FIXTURES, 1), 3)
        self.assertEqual(expected_source_buffers(FIXTURES, 6), 18)
        for fixtures in [FIXTURES[:2], FIXTURES[::-1], [FIXTURES[0]] * 3,
                [{**FIXTURES[0], 'tracks': [{'type': 'video'}]}, *FIXTURES[1:]]]:
            with self.assertRaisesRegex(WaveFailure, 'INVALID_FIXTURE_COHORT'):
                expected_source_buffers(fixtures, 1)

    def test_balanced_wrong_counts_unbalanced_and_pending_source_buffers_fail(self):
        for condition in CONDITIONS:
            for created, released in [(17, 17), (19, 19), (30, 30), (18, 17), (17, 18)]:
                data = integration_raw(condition)
                data['runs'][0]['samples'][6]['counters']['observed'].update(
                    sourceBuffersCreated=created, sourceBuffersReleased=released)
                with self.assertRaisesRegex(WaveFailure, 'LIFECYCLE_INCOMPLETE'):
                    validate_condition(data, condition, 'triage', FREEZE, FIXTURES)
            data = integration_raw(condition)
            data['runs'][0]['samples'][6]['counters']['observed']['pendingAppends'] = 1
            with self.assertRaises(WaveFailure): validate_condition(data, condition, 'triage', FREEZE, FIXTURES)

    def test_multiplexed_contract_is_pinned_to_corpus_and_workers(self):
        for patch in [{'fixtureHash': 'wrong'}, {'workerHashes': {}}, {'initDataPerFixture': [2, 1, 2]}, {'initDataId': 1}]:
            freeze = copy.deepcopy(FREEZE); freeze['multiplexedContract'].update(patch)
            with self.assertRaisesRegex(WaveFailure, 'CONTRACT_NOT_VERIFIED'):
                validate_condition(integration_raw(), 'r8.1', 'triage', freeze, FIXTURES)
        for key in ('workerBundleHash', 'cryptoWorkerBundleHash'):
            data = integration_raw(); data['runs'][0]['samples'][6][key] = 'wrong'
            with self.assertRaises(WaveFailure): validate_condition(data, 'r8.1', 'triage', FREEZE, FIXTURES)

    def test_source_fixture_bundle_and_app_identities_are_enforced(self):
        for key, value in [('fixtureManifestSha256', 'wrong'), ('fixtureIdentities', []),
                ('experimentalAppProducts', {}), ('pageScriptSha256', 'wrong'), ('workerBundleSha256', 'wrong'),
                ('videoStreamServiceUsed', False), ('autoplayArgs', []), ('condition', 'r8.2')]:
            data = integration_raw(); data[key] = value
            with self.assertRaises(WaveFailure): validate_condition(data, 'r8.1', 'triage', FREEZE, FIXTURES)

    def test_control_cannot_claim_store_and_requires_real_player(self):
        data = integration_raw('r8.0'); data['driveStoreUsed'] = True
        with self.assertRaises(WaveFailure): validate_condition(data, 'r8.0', 'triage', FREEZE, FIXTURES)

    def test_external_traffic_unexpected_urls_and_recovery_invalidate(self):
        for key in ('externalRequests', 'unexpectedRequests', 'rejectedRequests'):
            data = integration_raw(); data['network'][key] = 1
            with self.assertRaises(WaveFailure): validate_condition(data, 'r8.1', 'triage', FREEZE, FIXTURES)
        for key in ('pageErrors', 'recoveryWarnings'):
            data = integration_raw(); data[key] = 1
            with self.assertRaises(WaveFailure): validate_condition(data, 'r8.1', 'triage', FREEZE, FIXTURES)

    def test_actual_integrated_worker_urls_must_match_executed_bundles(self):
        for urls in [{}, {'worker-C.js': 18}, {'worker-C.js': 18, 'worker-T.js': 18, 'worker-OTHER.js': 1}]:
            data = integration_raw(); data['network']['workerRequests'] = urls
            with self.assertRaises(WaveFailure): validate_condition(data, 'r8.1', 'triage', FREEZE, FIXTURES)

    def test_owned_process_identity_and_finite_private_commit_are_required(self):
        for mutate in [lambda row: row['processMemory'].update(processes=[]),
                lambda row: row['processMemory'].update(status='UNAVAILABLE'),
                lambda row: row['processMemory']['processes'][0].update(pid=True),
                lambda row: row['processMemory']['byCategory']['browser'].update(privateBytes=math.nan),
                lambda row: row['processMemory']['byCategory']['renderer'].update(privateBytes=-1)]:
            data = integration_raw(); mutate(data['runs'][0]['samples'][6])
            with self.assertRaises(WaveFailure): validate_condition(data, 'r8.1', 'triage', FREEZE, FIXTURES)

    def test_pending_operations_errors_and_unclosed_lifecycle_are_invalid(self):
        for key in ('pendingOperations', 'timersLive', 'experimentalListeners', 'unhandledRejections', 'initializeFailures',
                'playbackFailures', 'workerErrors', 'rangeRequestsAborted', 'componentsDestroyed', 'metadataRequests'):
            data = integration_raw(); data['runs'][0]['samples'][6]['counters']['observed'][key] += 1
            with self.assertRaises(WaveFailure): validate_condition(data, 'r8.1', 'triage', FREEZE, FIXTURES)

    def test_playback_incomplete_seek_over_ten_seconds_and_bad_identity_invalidate(self):
        for patch in [{'maxCurrentTime': 1.5}, {'maxCurrentTime': 10}, {'seeks': 1}, {'fixture': 9},
                {'mode': 'control'}, {'canplayMs': None}, {'playbackMs': math.inf}, {'closeMs': -1},
                {'muted': True}, {'volume': 0.5}, {'playbackRate': 2}]:
            data = integration_raw(); data['runs'][0]['samples'][6]['counters']['sessions'][0].update(patch)
            with self.assertRaises(WaveFailure): validate_condition(data, 'r8.1', 'triage', FREEZE, FIXTURES)

    def test_summary_must_match_individual_signed_raw_deltas(self):
        data = integration_raw(); data['summary']['phases'][0]['processTypes']['browser']['privateBytes']['signedDelta']['median'] = 99
        with self.assertRaisesRegex(WaveFailure, 'SUMMARY_DISAGREES'): validate_condition(data, 'r8.1', 'triage', FREEZE, FIXTURES)

    def test_frozen_file_mutation_is_detected_before_launch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); (root / 'unit').write_text('changed')
            with self.assertRaisesRegex(WaveFailure, 'FROZEN_SOURCE'): verify_freeze(root, {'files': {'unit': 'wrong'}})

    def test_asset_server_reuses_loopback_range_contract_without_a_directory_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); mp4 = root / 'fixture'; mp4.write_bytes(b'abcdef')
            html = root / 'index'; html.write_text('<html>unit</html>')
            js = root / 'main'; js.write_text('window.unit=true;')
            with media_server({'/video-0.mp4': mp4}, True, 'application/octet-stream',
                    {'/': (html, 'text/html; charset=utf-8'), '/main-A.js': (js, 'text/javascript')}) as (origin, stats):
                with urlopen(origin + '/') as result: self.assertEqual(result.status, 200)
                with urlopen(origin + '/main-A.js') as result: self.assertEqual(result.headers['Content-Type'], 'text/javascript')
                with urlopen(Request(origin + '/video-0.mp4', headers={'Range': 'bytes=1-3'})) as result:
                    self.assertEqual(result.status, 206); self.assertEqual(result.read(), b'bcd')
                for path, headers in [('/other', {}), ('/../index', {}), ('/main-A.js', {'Range': 'bytes=0-2'}),
                        ('/video-0.mp4', {'Range': 'bytes=0-1,3-4'}), ('/video-0.mp4', {})]:
                    with self.assertRaises(HTTPError): urlopen(Request(origin + path, headers=headers))
                self.assertEqual(stats['ranges'], 1)


if __name__ == '__main__':
    unittest.main()
