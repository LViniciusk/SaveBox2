import copy,io,json,tempfile,unittest
from pathlib import Path
from ap06_native import trace_events,aggregate_trace,interpret
import run_ap06_r12_r2_native as native
from ap06_authorities import initialize,verify_publication,sha256
from types import SimpleNamespace

def events(sizes=(100,500,200,180),stacks=True):
    rows=[{'ph':'M','pid':42,'name':'process_name','args':{'name':'Renderer'}}]
    for i,size in enumerate(sizes):
        maps={'strings':[{'id':0,'string':'SafeNativeFunction'}],'nodes':[{'id':1,'name_sid':0}],'types':[]}
        rows.append({'ph':'v','pid':42,'ts':i*100+1,'id':hex(i+1),'name':'explicitly_triggered','args':{'dumps':{
            'level_of_detail':'detailed','allocators':{'malloc':{'attrs':{'size':{'type':'scalar','units':'bytes','value':hex(size+20)[2:]}}}},
            'heaps_v2':{'version':1,'maps':maps if stacks else {},'allocators':{'malloc':{'sizes':[size],'counts':[2],'types':[0],'nodes':[1] if stacks else [-1]}}}}}})
    return rows

def receipt():
    return {'complete':True,'dataLossOccurred':False,'rendererPid':42,'activatedBeforeWorkload':True,
        'checkpoints':[{'phase':p,'dumpGuid':hex(i+1),'success':True,'timestamp':i+1} for i,p in enumerate(('baseline','cycle-6-close','idle-120s','forced-GC-final'))]}

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
        self.assertEqual(no_stacks['status'],'R12R2_NATIVE_CAPABILITY_PASS');self.assertEqual(no_stacks['stackAttribution'],'unavailable')

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

if __name__=='__main__':unittest.main()
