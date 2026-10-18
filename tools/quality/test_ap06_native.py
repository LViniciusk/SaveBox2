import copy,io,json,tempfile,unittest
from pathlib import Path
from ap06_native import (trace_events,aggregate_trace,inspect_trace,interpret,_proof_matches,
    _legacy_proof_matches)
import run_ap06_r12_r2_native as native
from ap06_authorities import initialize,verify_publication,sha256
from types import SimpleNamespace

def events(sizes=(100,500,200,180),stacks=True):
    rows=[{'ph':'M','pid':42,'name':'process_name','args':{'name':'Renderer'}}]
    for i,size in enumerate(sizes):
        maps={'strings':[{'id':0,'string':'SafeNativeFunction'}],'nodes':[{'id':1,'name_sid':0}],'types':[]}
        rows.append({'ph':'v','pid':42,'ts':i*100+1,'id':hex(i+1),'name':'explicitly_triggered',
            'cat':['disabled-by-default-memory-infra'],'args':{'dumps':{
            'level_of_detail':'detailed','allocators':{'malloc':{'attrs':{'size':{'type':'scalar','units':'bytes','value':hex(size+20)[2:]}}}},
            'heaps_v2':{'version':1,'maps':maps if stacks else {},'allocators':{'malloc':{'sizes':[size],'counts':[2],'types':[0],'nodes':[1] if stacks else [-1]}}}}}})
    return rows

def receipt():
    return {'tracingStarted':True,'memoryInfraCategoryAvailable':True,'complete':True,'streamEof':True,
        'flags':['--memlog=all','--memlog-stack-mode=native','--memlog-sampling-rate=16384','--memlog-keep-small-allocations'],
        'dataLossOccurred':False,'rendererPid':42,'activatedBeforeWorkload':True,
        'checkpoints':[{'phase':p,'dumpGuid':hex(i+1),'success':True,'timestamp':i+1} for i,p in enumerate(('baseline','cycle-6-close','idle-120s','forced-GC-final'))]}

def r12_schema_events():
    rows=[]
    for i in range(1,4):
        for pid in (42,77):
            rows.append({'ph':'v','pid':pid,'ts':i*100,'id':hex(i),'name':'periodic_interval',
                'cat':['disabled-by-default-memory-infra'],'args':{'dumps':{'allocators':{}}}})
    for i in range(90,101):
        rows.append({'ph':'v','pid':99,'ts':i*100,'id':hex(i),'name':'periodic_interval',
            'cat':['disabled-by-default-memory-infra'],'args':{'dumps':{'allocators':{}}}})
    return rows

class NativeTests(unittest.TestCase):
    def test_private_trace_seal_real_authority_and_budget(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);authority=root/'authority';identity='a'*64;initialize(authority,identity,campaign='AP-06-R10')
            out=root/'output';(out/'baseline').mkdir(parents=True);(out/'pipeline').mkdir()
            (out/'baseline/authority-config.local.json').write_text(json.dumps({'AP06_AUTHORITY_ROOT':str(authority),'identity':identity}))
            def save(name,data):(out/name).write_text(json.dumps(data))
            wave=SimpleNamespace(output=out,save=save)
            path=native.private_trace_path(wave,out/'pipeline');path.write_text(json.dumps({'traceEvents':events()}))
            receipt=out/'pipeline/native-receipt.json';receipt.write_text(json.dumps({'trace':{'sha256':sha256(path),'bytes':path.stat().st_size}}))
            self.assertEqual(native.seal_trace(wave,receipt)['status'],'PASS')
            self.assertEqual(len(verify_publication(authority,identity,'r12-r2-native-trace-capability')['files']),1)
            with self.assertRaises(RuntimeError):native.private_trace_path(wave,out/'pipeline')
            path.write_text('tampered')
            with self.assertRaises(RuntimeError):native.seal_trace(wave,receipt)
        budget={'approved':True,'developmentMaximum':1,'measurementMaximum':2,'measurementRetries':0}
        for used in (0,1):native.native_budget(budget,used,1)
        for used in (-1,2,True):
            with self.assertRaises(RuntimeError):native.native_budget(budget,used,1)

    def test_stream_parser_handles_json_escapes_order_and_chunk_boundaries(self):
        rows=events();text=json.dumps({'metadata':{'quote':'x"[{,]\\foo'},'traceEvents':rows,'tail':[1,2]})
        self.assertEqual(list(trace_events(io.StringIO(text),chunk_size=7)),rows)
        for bad in (text[:-1],text+' garbage','{"traceEvents":[{}', '{"traceEvents":[],"traceEvents":[]}', '{"missing":[]}'):
            with self.assertRaises(ValueError):list(trace_events(io.StringIO(bad),chunk_size=5))
        with self.assertRaises(ValueError):list(trace_events(io.StringIO(text),max_value=20))

    def test_native_live_allocations_and_allocator_bytes_are_separate(self):
        result=aggregate_trace(iter(events()),receipt())
        self.assertEqual(result['status'],'R12R2_NATIVE_CAPABILITY_PASS')
        self.assertEqual(result['checkpoints'][1]['allocators']['malloc']['trackedLiveRequestedBytes'],500)
        self.assertEqual(result['checkpoints'][1]['allocatorStats']['malloc']['size'],520)
        self.assertEqual(result['stackAttribution'],'sanitized-symbols')
        no_stacks=aggregate_trace(iter(events(stacks=False)),receipt())
        self.assertEqual(no_stacks['status'],'R12R2_NATIVE_CAPABILITY_PASS');self.assertEqual(no_stacks['stackAttribution'],'STACK_ATTRIBUTION_UNAVAILABLE')

    def test_r12r12_sanitized_schema_is_diagnosed_without_acceptance(self):
        inventory=inspect_trace(iter(r12_schema_events()),42,receipt()['checkpoints'])
        self.assertEqual(inventory['scope'],'sanitized_counts_only')
        self.assertEqual(inventory['processNameMetadata']['renderer'],0)
        self.assertEqual(inventory['dumpEvents']['checkpointGuidsMatched'],3)
        self.assertFalse(inventory['dumpEvents']['checkpointReceiptGuidsUnique'] is False)
        self.assertEqual(inventory['heapsV2']['eventsPresent'],0)
        self.assertEqual(inventory['heapsV2']['dumpEventsWithoutHeapsV2'],17)
        self.assertEqual(aggregate_trace(iter(r12_schema_events()),receipt(),detailed=True),
            {'status':'NATIVE_INCONCLUSIVE','reason':'NATIVE_RENDERER_METADATA_MISSING'})

    def test_detailed_parser_separates_inconclusive_coverage_from_stop(self):
        rows=events();rows[0:1]=[]
        self.assertEqual(aggregate_trace(iter(rows),receipt(),detailed=True)['reason'],'NATIVE_RENDERER_METADATA_MISSING')
        rows=events()
        for row in rows[1:]:row['args']['dumps'].pop('heaps_v2')
        self.assertEqual(aggregate_trace(iter(rows),receipt(),detailed=True),
            {'status':'NATIVE_INCONCLUSIVE','reason':'NATIVE_HEAPS_V2_NOT_EMITTED'})
        rows=events();rows.pop(2)
        self.assertEqual(aggregate_trace(iter(rows),receipt(),detailed=True)['reason'],'NATIVE_CHECKPOINT_DUMPS_INCOMPLETE')
        rows=events();rows[1]['id2']={'global':'2'}
        self.assertEqual(aggregate_trace(iter(rows),receipt(),detailed=True)['reason'],'NATIVE_DUMP_GUID_CONFLICT')
        rows=events();rows[1]['id']=42
        self.assertEqual(aggregate_trace(iter(rows),receipt(),detailed=True)['status'],'NATIVE_STOP')
        rows=events();rows[1]['id2']=42
        self.assertEqual(aggregate_trace(iter(rows),receipt(),detailed=True)['status'],'NATIVE_STOP')
        # Identical duplicate event for same GUID is now cleanly accepted without double-counting
        rows=events();rows.insert(2,copy.deepcopy(rows[1]))
        res_dup = aggregate_trace(iter(rows),receipt(),detailed=True)
        self.assertEqual(res_dup['status'],'NATIVE_CAPABILITY_PASS')
        # Conflicting duplicate event produces STOP
        rows=events();conflict=copy.deepcopy(rows[1])
        conflict['args']['dumps']['heaps_v2']['allocators']['malloc']['sizes']=[999]
        rows.insert(2,conflict)
        self.assertEqual(aggregate_trace(iter(rows),receipt(),detailed=True)['reason'],'NATIVE_HEAP_ALLOCATOR_DUPLICATE')
        side=receipt();side['checkpoints'][1]['dumpGuid']=side['checkpoints'][0]['dumpGuid']
        self.assertEqual(aggregate_trace(iter(events()),side,detailed=True)['reason'],'NATIVE_CHECKPOINT_GUID_DUPLICATE')
        rows=events();rows[0]['pid']=43
        for row in rows[1:]:row['pid']=43
        self.assertEqual(aggregate_trace(iter(rows),receipt(),detailed=True)['reason'],'NATIVE_RENDERER_PID_MISMATCH')
        rows=events();rows[-1]['ts']=1
        self.assertEqual(aggregate_trace(iter(rows),receipt(),detailed=True)['reason'],'NATIVE_DUMP_TIMESTAMP_ORDER_INVALID')
        rows=events();rows[1]['args']['dumps']['heaps_v2']['allocators']['malloc']['counts']=[]
        self.assertEqual(aggregate_trace(iter(rows),receipt(),detailed=True)['reason'],'NATIVE_HEAP_ARRAYS_INVALID')
        side=receipt();side['dataLossOccurred']=True
        self.assertEqual(aggregate_trace(iter(events()),side,detailed=True)['reason'],'NATIVE_TRACE_INCOMPLETE_OR_DATA_LOSS')
        side=receipt();side['streamEof']=False
        self.assertEqual(aggregate_trace(iter(events()),side,detailed=True)['reason'],'NATIVE_TRACE_INCOMPLETE_OR_DATA_LOSS')
        rows=events();rows[1]['ts']=float('nan')
        self.assertEqual(aggregate_trace(iter(rows),receipt(),detailed=True)['status'],'NATIVE_STOP')

    def test_aggregates_only_are_not_native_allocation_profiling(self):
        rows=events()
        for row in rows[1:]:row['args']['dumps'].pop('heaps_v2')
        self.assertEqual(aggregate_trace(iter(rows),receipt())['status'],'R12R2_NATIVE_PROFILER_UNAVAILABLE')
        rows=events();rows[0]['args']['name']='Browser'
        self.assertEqual(aggregate_trace(iter(rows),receipt())['status'],'R12R2_NATIVE_INCONCLUSIVE')

    def test_malformed_missing_pid_guid_loss_or_incomplete_trace_fail_closed(self):
        for mutate in (lambda r:r.update(complete=False),lambda r:r.update(dataLossOccurred=True),lambda r:r.update(rendererPid=None),
            lambda r:r.update(activatedBeforeWorkload=False),lambda r:r['checkpoints'][1].update(success=False),
            lambda r:r['checkpoints'][1].update(dumpGuid='999')):
            side=receipt();mutate(side);self.assertEqual(aggregate_trace(iter(events()),side)['status'],'R12R2_NATIVE_INCONCLUSIVE')
        for mutate in (lambda r:r[1]['args']['dumps']['heaps_v2']['allocators']['malloc'].update(counts=[]),
            lambda r:r[1]['args']['dumps']['heaps_v2']['allocators']['malloc'].update(sizes=[-1]),
            lambda r:r[1]['args']['dumps']['allocators']['malloc']['attrs']['size'].update(value='-1'),
            lambda r:r[1].update(ts=float('nan'))):
            rows=events();mutate(rows)
            self.assertEqual(aggregate_trace(iter(rows),receipt())['status'],'R12R2_NATIVE_INCONCLUSIVE')

    def test_classification_limits_do_not_confirm_leaks_or_uncovered_reservation(self):
        self.assertEqual(interpret(500,200,400,True),'RESERVATION_COMPATIBLE')
        self.assertEqual(interpret(500,500,400,True),'OBSERVED_TRACKED_RETENTION')
        self.assertEqual(interpret(500,200,400,False),'INCONCLUSIVE')
        self.assertEqual(interpret(500,200,0,True),'OBSERVED_TRACKED_RELEASE')

    def test_renderer_identity_proof_and_negative_matrix(self):
        def valid_proof_receipt(pid=42, creation_time=123456, campaign='AP-06-R12-R14-native'):
            side = receipt()
            exact = str(creation_time)
            side['rendererIdentityProof'] = {
                'status': 'PASS', 'campaign': campaign, 'preRegistered': True,
                'rendererPid': pid, 'creationTime': creation_time, 'creationTimeExact': exact,
                'roles': ['renderer'],
                'attestationMethod': 'retained-win32-process-handles',
                'linkedToProfiledProcess': True, 'processIdentityCount': 1,
                'checkpointPhases': ['baseline', 'cycle-6-close', 'idle-120s', 'forced-GC-final']
            }
            side['processExitAudit'] = {
                'status': 'PASS', 'method': 'retained-win32-process-handles',
                'reusedPidCount': 0, 'timedOutProcessCount': 0, 'waitFailedProcessCount': 0,
                'closedProcessCount': 1,
                'processes': [{'pid': pid, 'creationTime': creation_time,
                    'creationTimeExact': exact, 'roles': ['renderer']}]
            }
            side['processSamples'] = [
                {'phase': p, 'processes': [{'pid': pid, 'type': 'renderer'}]}
                for p in ('baseline', 'cycle-6-close', 'idle-120s', 'forced-GC-final')
            ]
            side['handleRelease'] = {
                'status': 'PASS',
                'processHandles': {'releasedProcessHandles': 1, 'closeFailures': 0}
            }
            side['browserIdentity'] = {
                'before': {'nativeFlagsValidated': True}
            }
            return side

        trace_without_name = events()[1:]

        res = aggregate_trace(iter(trace_without_name), valid_proof_receipt(), detailed=True)
        self.assertEqual(res['status'], 'NATIVE_CAPABILITY_PASS')

        negatives = [
            lambda r: r['rendererIdentityProof'].update(rendererPid=999),
            lambda r: r['rendererIdentityProof'].update(creationTime=999999),
            lambda r: r['processExitAudit'].update(reusedPidCount=1),
            lambda r: r['rendererIdentityProof'].update(roles=['utility']),
            lambda r: r['processExitAudit']['processes'][0].update(roles=['gpu']),
            lambda r: r['handleRelease']['processHandles'].update(releasedProcessHandles=0),
            lambda r: r['handleRelease']['processHandles'].update(closeFailures=1),
            lambda r: r['handleRelease'].update(status='FAIL'),
            lambda r: r['rendererIdentityProof'].update(attestationMethod='unsupported-method'),
            lambda r: r.pop('processExitAudit'),
            lambda r: r['processExitAudit'].update(status='FAIL'),
            lambda r: r['processExitAudit']['processes'].append({'pid': 43, 'creationTime': 123457, 'roles': ['renderer']}),
            lambda r: r['processSamples'][0]['processes'].append({'pid': 43, 'type': 'renderer'}),
            lambda r: r['processSamples'][1]['processes'][0].update(pid=99),
            lambda r: r['rendererIdentityProof'].update(linkedToProfiledProcess=False),
            lambda r: r['browserIdentity']['before'].update(nativeFlagsValidated=False),
            lambda r: r.pop('browserIdentity'),
            lambda r: r.pop('processSamples'),
            lambda r: r['rendererIdentityProof'].update(processIdentityCount=2),
            lambda r: r['rendererIdentityProof'].update(checkpointPhases=['baseline']),
        ]

        for mutator in negatives:
            side = valid_proof_receipt()
            mutator(side)
            result = aggregate_trace(iter(trace_without_name), side, detailed=True)
            self.assertEqual(result.get('status'), 'NATIVE_INCONCLUSIVE')
            self.assertEqual(result.get('reason'), 'NATIVE_RENDERER_METADATA_MISSING')

    def test_load_native_budget_bom_and_negative_matrix(self):
        from ap06_freeze import load_native_budget
        expected = {'capability': 1, 'profiledA': 1, 'profiledB': 1, 'maximum': 3, 'retries': 0}
        task_sha = 'a' * 64
        valid_dict = {'approved': True, **expected, 'approvedByTaskSha256': task_sha}

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp) / 'budget.json'

            tmp_path.write_bytes(json.dumps(valid_dict).encode('utf-8'))
            budget = load_native_budget(tmp_path, expected, task_sha)
            self.assertEqual(budget['approved'], True)

            tmp_path.write_bytes(b'\xef\xbb\xbf' + json.dumps(valid_dict).encode('utf-8'))
            budget_bom = load_native_budget(tmp_path, expected, task_sha)
            self.assertEqual(budget_bom['approved'], True)

            tmp_path.write_bytes(json.dumps(valid_dict).encode('utf-8')[:15])
            with self.assertRaisesRegex(ValueError, 'NATIVE_BUDGET_JSON_INVALID'):
                load_native_budget(tmp_path, expected, task_sha)

            tmp_path.write_bytes(b'\xff\xfe\x00\x00garbage')
            with self.assertRaisesRegex(ValueError, 'NATIVE_BUDGET_JSON_INVALID'):
                load_native_budget(tmp_path, expected, task_sha)

            tampered = dict(valid_dict, maximum=4)
            tmp_path.write_bytes(json.dumps(tampered).encode('utf-8'))
            with self.assertRaisesRegex(ValueError, 'NATIVE_BUDGET_AUTHORITY_INVALID'):
                load_native_budget(tmp_path, expected, task_sha)

            tmp_path.write_bytes(json.dumps(dict(valid_dict, approved=False)).encode('utf-8'))
            with self.assertRaisesRegex(ValueError, 'NATIVE_BUDGET_AUTHORITY_INVALID'):
                load_native_budget(tmp_path, expected, task_sha)

            tmp_path.write_bytes(json.dumps(dict(valid_dict, approvedByTaskSha256='b'*64)).encode('utf-8'))
            with self.assertRaisesRegex(ValueError, 'NATIVE_BUDGET_AUTHORITY_INVALID'):
                load_native_budget(tmp_path, expected, task_sha)

            tmp_path.write_bytes(json.dumps(dict(valid_dict, capability=True)).encode('utf-8'))
            with self.assertRaisesRegex(ValueError, 'NATIVE_BUDGET_AUTHORITY_INVALID'):
                load_native_budget(tmp_path, expected, task_sha)

            tmp_path.write_bytes(json.dumps(dict(valid_dict, extra=1)).encode('utf-8'))
            with self.assertRaisesRegex(ValueError, 'NATIVE_BUDGET_AUTHORITY_INVALID'):
                load_native_budget(tmp_path, expected, task_sha)

            no_max = dict(valid_dict)
            del no_max['maximum']
            tmp_path.write_bytes(json.dumps(no_max).encode('utf-8'))
            with self.assertRaisesRegex(ValueError, 'NATIVE_BUDGET_AUTHORITY_INVALID'):
                load_native_budget(tmp_path, expected, task_sha)

    def test_memory_infra_event_and_guid_contract_scenarios(self):
        # 1. Single valid event per GUID
        res1 = aggregate_trace(iter(events()), receipt(), detailed=True)
        self.assertEqual(res1['status'], 'NATIVE_CAPABILITY_PASS')

        # 2. Two identical events for same GUID
        rows_dup = events()
        rows_dup.insert(2, copy.deepcopy(rows_dup[1]))
        res2 = aggregate_trace(iter(rows_dup), receipt(), detailed=True)
        self.assertEqual(res2['status'], 'NATIVE_CAPABILITY_PASS')
        self.assertEqual(res2['checkpoints'][0]['allocators']['malloc']['trackedLiveRequestedBytes'], 100)

        # 3. Complementary fragments (event A has process_totals/allocators, event B has heaps_v2)
        rows_comp = events()
        frag_a = copy.deepcopy(rows_comp[1])
        frag_a['args']['dumps'].pop('heaps_v2')
        frag_b = copy.deepcopy(rows_comp[1])
        frag_b['args']['dumps'].pop('allocators')
        rows_comp[1:2] = [frag_a, frag_b]
        res3 = aggregate_trace(iter(rows_comp), receipt(), detailed=True)
        self.assertEqual(res3['status'], 'NATIVE_CAPABILITY_PASS')
        self.assertEqual(res3['checkpoints'][0]['allocators']['malloc']['trackedLiveRequestedBytes'], 100)
        self.assertIn('malloc', res3['checkpoints'][0]['allocatorStats'])

        # 4. Contradictory values produce STOP
        rows_conflict = events()
        frag_bad = copy.deepcopy(rows_conflict[1])
        frag_bad['args']['dumps']['allocators']['malloc']['attrs']['size']['value'] = '9999'
        rows_conflict.insert(2, frag_bad)
        res4 = aggregate_trace(iter(rows_conflict), receipt(), detailed=True)
        self.assertEqual(res4['status'], 'NATIVE_STOP')
        self.assertEqual(res4['reason'], 'NATIVE_ALLOCATOR_STATS_DUPLICATE')

        # 5. Same GUID across distinct processes (GPU / browser emit dump with same GUID)
        rows_multi_pid = events()
        gpu_event = {'ph': 'v', 'pid': 77, 'ts': 101, 'id': '0x1', 'cat': ['disabled-by-default-memory-infra'],
                     'name': 'periodic_interval', 'args': {'dumps': {'allocators': {}}}}
        rows_multi_pid.insert(2, gpu_event)
        res5 = aggregate_trace(iter(rows_multi_pid), receipt(), detailed=True)
        self.assertEqual(res5['status'], 'NATIVE_CAPABILITY_PASS')

        # 6. Periodic interval and explicitly triggered associated with same GUID
        rows_names = events()
        rows_names[1]['name'] = 'periodic_interval'
        res6 = aggregate_trace(iter(rows_names), receipt(), detailed=True)
        self.assertEqual(res6['status'], 'NATIVE_CAPABILITY_PASS')

        # 7. Event without heaps_v2 produces NATIVE_HEAPS_V2_NOT_EMITTED
        rows_no_heaps = events()
        for r in rows_no_heaps[1:]:
            r['args']['dumps'].pop('heaps_v2')
        res7 = aggregate_trace(iter(rows_no_heaps), receipt(), detailed=True)
        self.assertEqual(res7['status'], 'NATIVE_INCONCLUSIVE')
        self.assertEqual(res7['reason'], 'NATIVE_HEAPS_V2_NOT_EMITTED')

        # 8. Partial heaps_v2 produces NATIVE_HEAPS_V2_INCOMPLETE
        rows_partial = events()
        rows_partial[2]['args']['dumps'].pop('heaps_v2')
        res8 = aggregate_trace(iter(rows_partial), receipt(), detailed=True)
        self.assertEqual(res8['status'], 'NATIVE_INCONCLUSIVE')
        self.assertEqual(res8['reason'], 'NATIVE_HEAPS_V2_INCOMPLETE')

        # 9. Conflicting or malformed GUID produces STOP
        rows_guid_conflict = events()
        rows_guid_conflict[1]['id2'] = {'global': '0x99'}
        self.assertEqual(aggregate_trace(iter(rows_guid_conflict), receipt(), detailed=True)['reason'], 'NATIVE_DUMP_GUID_CONFLICT')

        # 10. Limit overflow produces STOP
        rows_overflow = events()
        rows_overflow[1]['args']['dumps']['heaps_v2']['maps']['strings'] = [{'id': i, 'string': f's{i}'} for i in range(100001)]
        self.assertEqual(aggregate_trace(iter(rows_overflow), receipt(), detailed=True)['reason'], 'NATIVE_HEAPS_V2_MAP_LIMIT')

    def test_exact_filetime_uint64_and_negative_matrix(self):
        side = receipt()
        side.pop('rendererPid')
        side['rendererPid'] = 42

        def make_receipt(time_exact='134368223588270130', time_num=134368223588270130, audited_exact=None, audited_time=None):
            r = receipt()
            r['rendererIdentityProof'] = {
                'status': 'PASS', 'campaign': 'AP-06-R12-R14-native', 'preRegistered': True,
                'rendererPid': 42, 'creationTime': time_num, 'creationTimeExact': time_exact,
                'roles': ['renderer'], 'attestationMethod': 'retained-win32-process-handles',
                'linkedToProfiledProcess': True, 'processIdentityCount': 1,
                'checkpointPhases': ['baseline', 'cycle-6-close', 'idle-120s', 'forced-GC-final']
            }
            if time_exact is None:
                r['rendererIdentityProof'].pop('creationTimeExact')
            r['processExitAudit'] = {
                'status': 'PASS', 'method': 'retained-win32-process-handles',
                'reusedPidCount': 0, 'timedOutProcessCount': 0, 'waitFailedProcessCount': 0,
                'closedProcessCount': 1,
                'processes': [{'pid': 42, 'creationTime': audited_time if audited_time is not None else time_num,
                               'creationTimeExact': audited_exact if audited_exact is not None else time_exact,
                               'roles': ['renderer']}]
            }
            if (audited_exact is None and time_exact is None):
                r['processExitAudit']['processes'][0].pop('creationTimeExact')
            r['processSamples'] = [{'phase': p, 'processes': [{'pid': 42, 'type': 'renderer'}]} for p in ('baseline', 'cycle-6-close', 'idle-120s', 'forced-GC-final')]
            r['handleRelease'] = {'status': 'PASS', 'processHandles': {'releasedProcessHandles': 1, 'closeFailures': 0}}
            r['browserIdentity'] = {'before': {'nativeFlagsValidated': True}}
            return r

        trace_no_metadata = events()[1:]

        # Exact uint64 above 2^53 - 1 PASS
        res = aggregate_trace(iter(trace_no_metadata), make_receipt('134368223588270130'), detailed=True)
        self.assertEqual(res['status'], 'NATIVE_CAPABILITY_PASS')

        # Maximum uint64 PASS
        res_max = aggregate_trace(iter(trace_no_metadata), make_receipt('18446744073709551615'), detailed=True)
        self.assertEqual(res_max['status'], 'NATIVE_CAPABILITY_PASS')

        # Negative tests: invalid canonical representations
        for bad_time in ('0', '-1', '134368223588270130.5', '1e17', '0123', '18446744073709551616', 'NaN', 'abc'):
            r = make_receipt(time_exact=bad_time)
            self.assertEqual(aggregate_trace(iter(trace_no_metadata), r, detailed=True)['reason'], 'NATIVE_RENDERER_METADATA_MISSING')

        # Mismatch between audited and proof
        r_mismatch = make_receipt(time_exact='134368223588270130', audited_exact='134368223588270131')
        self.assertEqual(aggregate_trace(iter(trace_no_metadata), r_mismatch, detailed=True)['reason'], 'NATIVE_RENDERER_METADATA_MISSING')

        # Unreleased handles
        r_handles = make_receipt()
        r_handles['handleRelease']['status'] = 'FAIL'
        self.assertEqual(aggregate_trace(iter(trace_no_metadata), r_handles, detailed=True)['reason'], 'NATIVE_RENDERER_METADATA_MISSING')

    def test_new_identity_proof_requires_exact_filetime_and_isolates_legacy(self):
        def make(proof_exact='134368223588270130', audit_exact='134368223588270130',
                proof_legacy=None, audit_legacy=None):
            side = receipt()
            proof = {
                'status': 'PASS', 'campaign': 'AP-06-R12-R14-native', 'preRegistered': True,
                'rendererPid': 42, 'roles': ['renderer'],
                'attestationMethod': 'retained-win32-process-handles',
                'linkedToProfiledProcess': True, 'processIdentityCount': 1,
                'checkpointPhases': ['baseline', 'cycle-6-close', 'idle-120s', 'forced-GC-final']
            }
            if proof_exact is not None: proof['creationTimeExact'] = proof_exact
            if proof_legacy is not None: proof['creationTime'] = proof_legacy
            side['rendererIdentityProof'] = proof
            audited = {'pid': 42, 'roles': ['renderer']}
            if audit_exact is not None: audited['creationTimeExact'] = audit_exact
            if audit_legacy is not None: audited['creationTime'] = audit_legacy
            side['processExitAudit'] = {
                'status': 'PASS', 'method': 'retained-win32-process-handles',
                'reusedPidCount': 0, 'timedOutProcessCount': 0, 'waitFailedProcessCount': 0,
                'closedProcessCount': 1, 'processes': [audited]
            }
            side['processSamples'] = [
                {'phase': p, 'processes': [{'pid': 42, 'type': 'renderer'}]}
                for p in ('baseline', 'cycle-6-close', 'idle-120s', 'forced-GC-final')
            ]
            side['handleRelease'] = {
                'status': 'PASS',
                'processHandles': {'releasedProcessHandles': 1, 'closeFailures': 0}
            }
            side['browserIdentity'] = {'before': {'nativeFlagsValidated': True}}
            return side

        trace = events()[1:]
        exact = '134368223588270130'

        # New proofs require the canonical exact representation on both sides.
        self.assertTrue(_proof_matches(make(), 42))
        self.assertFalse(_proof_matches(make(proof_exact=None, audit_exact=None,
            proof_legacy=123456, audit_legacy=123456), 42))
        self.assertEqual(aggregate_trace(iter(trace), make(proof_exact=None, audit_exact=None,
            proof_legacy=123456, audit_legacy=123456), detailed=True)['reason'],
            'NATIVE_RENDERER_METADATA_MISSING')
        self.assertFalse(_proof_matches(make(audit_exact=None, audit_legacy=123456), 42))
        self.assertFalse(_proof_matches(make(audit_exact='134368223588270131'), 42))
        self.assertFalse(_proof_matches(make(proof_exact=int(exact)), 42))
        for bad in ('0', '01', '+1', ' 1', '1.0', '1e17', '18446744073709551616'):
            self.assertFalse(_proof_matches(make(proof_exact=bad, audit_exact=bad), 42))

        # A conflicting safe legacy integer is a contradiction; an unsafe one is
        # ignored because JSON numbers above 2**53-1 are not exact.
        self.assertFalse(_proof_matches(make(proof_legacy=1), 42))
        self.assertFalse(_proof_matches(make(audit_legacy=1), 42))
        self.assertTrue(_proof_matches(make(proof_legacy=134368223588270128,
            audit_legacy=134368223588270128), 42))
        self.assertTrue(_proof_matches(make(proof_legacy=int(exact),
            audit_legacy=int(exact)), 42))

        # Bounds and JSON round-trip preserve the canonical string byte for byte.
        self.assertTrue(_proof_matches(make(proof_exact='1', audit_exact='1'), 42))
        self.assertTrue(_proof_matches(make(proof_exact='18446744073709551615',
            audit_exact='18446744073709551615'), 42))
        self.assertTrue(_proof_matches(json.loads(json.dumps(make())), 42))

        # Historical replay remains available only through the explicit legacy path.
        legacy = make(proof_exact=None, audit_exact=None,
            proof_legacy=123456, audit_legacy=123456)
        self.assertFalse(_proof_matches(legacy, 42))
        self.assertTrue(_legacy_proof_matches(legacy, 42))

if __name__=='__main__':unittest.main()

