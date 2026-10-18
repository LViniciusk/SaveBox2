"""Bounded JSON event reader and pure MemoryInfra heaps_v2 aggregates. No raw stacks are public."""
import hashlib,json,math,re

class JsonStream:
    def __init__(self,stream,chunk_size,max_value):
        self.stream,self.chunk_size,self.max_value=stream,chunk_size,max_value;self.buffer='';self.eof=False
        def unique(pairs):
            result={}
            for key,value in pairs:
                if key in result:raise ValueError('NATIVE_JSON_DUPLICATE_KEY')
                result[key]=value
            return result
        self.decoder=json.JSONDecoder(parse_constant=lambda _:(_ for _ in ()).throw(ValueError('NONFINITE_JSON')),object_pairs_hook=unique)
    def fill(self):
        part=self.stream.read(self.chunk_size);self.eof=not part;self.buffer+=part
        if len(self.buffer)>self.max_value:raise ValueError('NATIVE_JSON_VALUE_TOO_LARGE')
    def peek(self):
        self.buffer=self.buffer.lstrip()
        while not self.buffer and not self.eof:self.fill();self.buffer=self.buffer.lstrip()
        return self.buffer[:1]
    def token(self,expected):
        if self.peek()!=expected:raise ValueError('NATIVE_JSON_TRUNCATED_OR_INVALID')
        self.buffer=self.buffer[1:]
    def value(self):
        self.peek()
        while True:
            try:
                value,end=self.decoder.raw_decode(self.buffer)
                # A scalar number can be split at a read boundary.
                if end==len(self.buffer) and not self.eof:self.fill();continue
                self.buffer=self.buffer[end:];return value
            except json.JSONDecodeError:
                if self.eof:raise ValueError('NATIVE_JSON_TRUNCATED_OR_INVALID') from None
                self.fill()

def trace_events(stream,chunk_size=65536,max_value=32*1024*1024):
    reader=JsonStream(stream,chunk_size,max_value);reader.token('{');keys=set();seen=False
    if reader.peek()!='}':
        while True:
            key=reader.value()
            if not isinstance(key,str) or key in keys:raise ValueError('NATIVE_JSON_DUPLICATE_KEY')
            keys.add(key);reader.token(':')
            if key=='traceEvents':
                seen=True;reader.token('[')
                if reader.peek()!=']':
                    while True:
                        value=reader.value()
                        if not isinstance(value,dict):raise ValueError('NATIVE_EVENT_INVALID')
                        yield value
                        if reader.peek()!=',':break
                        reader.token(',')
                reader.token(']')
            else:reader.value()
            if reader.peek()!=',':break
            reader.token(',')
    reader.token('}')
    if reader.peek() or not seen:raise ValueError('NATIVE_JSON_TRAILING_OR_MISSING_EVENTS')

def number(value):
    if type(value) not in (int,float) or not math.isfinite(value) or value<0:raise ValueError('NATIVE_NUMBER_INVALID')
    return value

def guid(value):
    if not isinstance(value,str) or not re.fullmatch(r'(?:0x)?[a-fA-F0-9]+',value):raise ValueError('NATIVE_GUID_INVALID')
    return int(value,16)

def label(value):
    return value if value in ('malloc','partition_alloc','partition_alloc/allocated_objects','blink_gc','v8') else 'allocator-'+hashlib.sha256(value.encode()).hexdigest()[:12]

def inspect_trace(events,renderer_pid,checkpoints):
    """Return bounded, sanitized trace structure counts. This is diagnostic, never acceptance."""
    phases={};names={};categories={};roles={};pids=set();pid_counts={};expected={};checkpoint_guids=[]
    if type(renderer_pid) is not int or renderer_pid<=0:renderer_pid=None
    for checkpoint in checkpoints if isinstance(checkpoints,list) else ():
        try:
            value=guid(checkpoint.get('dumpGuid'))
            checkpoint_guids.append(value)
            expected[value]=checkpoint.get('phase')
        except (AttributeError,TypeError,ValueError):pass
    total=missing_pid=renderer_events=other_events=0;metadata=renderer_metadata=0
    role_names={'Renderer':'renderer','Renderer process':'renderer','Browser':'browser','GPU Process':'gpu','Utility':'utility'}
    dump_renderer=dump_other=0;guid_forms={'id':0,'id2.global':0,'both':0,'missing':0}
    guid_types={'string':0,'number':0,'other':0};matched=set();duplicate_matches=0;unmatched=0
    renderer_matched=set();other_matched=set();matched_events=0
    dump_without_schema=0;dump_bad_guid=0;dump_timestamps=0;last_dump_ts=None;dump_order_valid=True
    heaps_present=heaps_renderer=heaps_matched=heaps_matched_missing=0
    heaps_versions={};heaps_valid=0;heap_allocators=0;heap_arrays_valid=0;allocator_stats=0;discarded=0
    def bucket(table,key):table[key]=table.get(key,0)+1
    def guid_value(value):
        if isinstance(value,str):kind='string'
        elif type(value) is int:kind='number'
        else:kind='other'
        bucket(guid_types,kind)
        try:return guid(value)
        except (TypeError,ValueError,OverflowError):return None
    for event in events:
        total+=1
        if not isinstance(event,dict):continue
        pid=event.get('pid')
        if type(pid) is int and pid>0:
            pids.add(pid);pid_counts[pid]=pid_counts.get(pid,0)+1
        else:missing_pid+=1
        is_renderer=renderer_pid is not None and pid==renderer_pid
        if is_renderer:renderer_events+=1
        else:other_events+=1
        phase=event.get('ph');phase=phase if isinstance(phase,str) and len(phase)==1 and phase.isalnum() else 'other'
        bucket(phases,phase)
        name=event.get('name');name=name if isinstance(name,str) and name in ('process_name','process_labels','explicitly_triggered','periodic_interval','global_dump','memory_dump','heap_profiler') else 'other'
        bucket(names,name)
        cat=event.get('cat')
        cats=cat if isinstance(cat,list) else [cat]
        for item in cats:
            if item=='disabled-by-default-memory-infra':category='disabled-by-default-memory-infra'
            elif item=='memory-infra':category='memory-infra'
            elif item is None:category='missing'
            else:category='other'
            bucket(categories,category)
        args=event.get('args');args=args if isinstance(args,dict) else {}
        if phase=='M' and event.get('name')=='process_name':
            metadata+=1
            if is_renderer:
                renderer_metadata+=1
            role=args.get('name')
            role=role_names.get(role,'other')
            bucket(roles,role)
        dumps=args.get('dumps')
        if phase!='v' or not isinstance(dumps,dict):
            if is_renderer and (phase=='v' or isinstance(args.get('dumps'),dict)):discarded+=1
            continue
        if is_renderer:dump_renderer+=1
        else:dump_other+=1
        has_id='id' in event;id2=event.get('id2');has_global=isinstance(id2,dict) and 'global' in id2
        form='both' if has_id and has_global else 'id' if has_id else 'id2.global' if has_global else 'missing'
        bucket(guid_forms,form)
        values=[]
        if has_id:values.append(guid_value(event.get('id')))
        if has_global:values.append(guid_value(id2.get('global')))
        valid_values=[value for value in values if value is not None]
        if values and not valid_values:dump_bad_guid+=1
        if has_id and has_global and len(valid_values)==2 and valid_values[0]!=valid_values[1]:dump_bad_guid+=1
        current=set(valid_values).intersection(expected)
        if len(current)>1:dump_bad_guid+=1
        for value in current:
            if value in matched:duplicate_matches+=1
            matched.add(value)
            (renderer_matched if is_renderer else other_matched).add(value)
        if current:matched_events+=1
        if not current:unmatched+=1
        ts=event.get('ts')
        if type(ts) in (int,float) and math.isfinite(ts) and ts>=0:
            dump_timestamps+=1
            if last_dump_ts is not None and ts<last_dump_ts:dump_order_valid=False
            last_dump_ts=ts
        else:dump_order_valid=False
        heaps=dumps.get('heaps_v2')
        if isinstance(heaps,dict):
            heaps_present+=1
            if is_renderer:heaps_renderer+=1
            if current:heaps_matched+=1
            version=heaps.get('version');version=str(version) if type(version) in (int,str) else 'other'
            if version not in ('1','2'):version='other'
            bucket(heaps_versions,version)
            allocators=heaps.get('allocators')
            if version=='1' and isinstance(allocators,dict):
                heaps_valid+=1;heap_allocators+=len(allocators)
                for allocator in allocators.values():
                    if not isinstance(allocator,dict):continue
                    sizes,counts=allocator.get('sizes'),allocator.get('counts')
                    nodes,types=allocator.get('nodes'),allocator.get('types')
                    if isinstance(sizes,list) and isinstance(counts,list) and len(sizes)==len(counts) and \
                        (nodes is None or isinstance(nodes,list) and len(nodes)==len(sizes)) and \
                        (types is None or isinstance(types,list) and len(types)==len(sizes)):
                        heap_arrays_valid+=1
        else:
            dump_without_schema+=1
            if current:heaps_matched_missing+=1
        allocators=dumps.get('allocators')
        if isinstance(allocators,dict):allocator_stats+=len(allocators)
    expected_count=len(set(checkpoint_guids))
    return {'scope':'sanitized_counts_only','events':total,'distinctPidCount':len(pids),
        'eventsByProcess':{'renderer':renderer_events,'other':other_events,'missingPid':missing_pid,
            'otherPidEventCounts':sorted((count for pid,count in pid_counts.items() if pid!=renderer_pid),reverse=True)},
        'eventsByPhase':dict(sorted(phases.items())),'eventsByName':dict(sorted(names.items())),
        'eventsByCategory':dict(sorted(categories.items())),'processNameMetadata':{'all':metadata,'renderer':renderer_metadata,'roles':dict(sorted(roles.items()))},
        'dumpEvents':{'renderer':dump_renderer,'otherProcess':dump_other,'guidForms':guid_forms,'guidValueTypes':guid_types,
            'checkpointGuidsExpected':expected_count,'checkpointGuidsMatched':len(matched),
            'rendererCheckpointGuidsMatched':len(renderer_matched),'otherProcessCheckpointGuidsMatched':len(other_matched),
            'checkpointMatchEvents':matched_events,'repeatedGuidEventReferences':duplicate_matches,
            'checkpointReceiptGuidsUnique':len(set(checkpoint_guids))==len(checkpoint_guids),
            'unmatched':unmatched,'invalidGuid':dump_bad_guid,'discardedByStrictShape':discarded,
            'timestampsValid':dump_timestamps,'timestampsMonotonicInStream':dump_order_valid},
        'heapsV2':{'eventsPresent':heaps_present,'rendererEvents':heaps_renderer,'checkpointMatches':heaps_matched,
            'checkpointMatchesMissing':heaps_matched_missing,'schemaVersions':dict(sorted(heaps_versions.items())),
            'schemaVersion1WithAllocatorMap':heaps_valid,'allocatorBins':heap_allocators,'validAllocatorArraySets':heap_arrays_valid,
            'dumpAllocatorStats':allocator_stats,
            'dumpEventsWithoutHeapsV2':dump_without_schema}}

def symbol(value):
    if isinstance(value,str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_:<>(), ~*&.\[\]-]{2,160}',value) and '0x' not in value and value.lower() not in ('unknown','unknown type'):
        return value
    return None

class NativeTraceError(ValueError):
    def __init__(self,reason):self.reason=reason;super().__init__(reason)

PHASES=('baseline','cycle-6-close','idle-120s','forced-GC-final')
NATIVE_FLAGS={'--memlog=all','--memlog-stack-mode=native','--memlog-sampling-rate=16384','--memlog-keep-small-allocations'}
INCONCLUSIVE={'NATIVE_RENDERER_METADATA_MISSING','NATIVE_CHECKPOINT_DUMPS_INCOMPLETE',
    'NATIVE_HEAPS_V2_NOT_EMITTED','NATIVE_HEAPS_V2_INCOMPLETE','NATIVE_HEAPS_V2_EMPTY'}

def _event_guid(event):
    id_present='id' in event
    id2=event.get('id2')
    if 'id2' in event and not isinstance(id2,dict):
        raise NativeTraceError('NATIVE_DUMP_GUID_SCHEMA_UNSUPPORTED')
    global_present=isinstance(id2,dict) and 'global' in id2
    if not id_present and not global_present:return None
    try:
        first=guid(event['id']) if id_present else None
        second=guid(id2['global']) if global_present else None
    except (TypeError,ValueError,OverflowError):raise NativeTraceError('NATIVE_DUMP_GUID_SCHEMA_UNSUPPORTED') from None
    if first is not None and second is not None and first!=second:
        raise NativeTraceError('NATIVE_DUMP_GUID_CONFLICT')
    return first if first is not None else second

def validate_canonical_filetime(value):
    if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]*', value):
        return None
    val = int(value)
    if val <= 0 or val > (1 << 64) - 1:
        return None
    return val

MAX_SAFE_FILETIME_INTEGER = (1 << 53) - 1

def _legacy_creation_time(value):
    """Return a comparable legacy FILETIME, None when absent, or INVALID."""
    if value is None:
        return None
    if type(value) is int and value > 0:
        return value
    if isinstance(value, str):
        return validate_canonical_filetime(value)
    return 'INVALID'

def _proof_matches(receipt,pid,*,allow_legacy=False):
    proof=receipt.get('rendererIdentityProof')
    if not isinstance(proof,dict):return False
    if not (proof.get('status')=='PASS' and proof.get('preRegistered') is True and \
        proof.get('campaign') in ('AP-06-R12-R14-native','AP-06-R12-R13-native') and \
        proof.get('rendererPid')==pid and \
        isinstance(proof.get('roles'),list) and proof['roles']==['renderer'] and \
        proof.get('attestationMethod')=='retained-win32-process-handles' and \
        proof.get('linkedToProfiledProcess') is True and proof.get('processIdentityCount')==1 and \
        proof.get('checkpointPhases')==list(PHASES)):
        return False

    audit=receipt.get('processExitAudit')
    if not isinstance(audit,dict) or audit.get('status')!='PASS' or audit.get('method')!='retained-win32-process-handles':
        return False
    if audit.get('reusedPidCount',0)!=0 or audit.get('timedOutProcessCount',0)!=0 or audit.get('waitFailedProcessCount',0)!=0:
        return False
    processes=audit.get('processes')
    if not isinstance(processes,list):
        return False
    renderer_processes=[p for p in processes if isinstance(p,dict) and 'renderer' in p.get('roles',())]
    if len(renderer_processes)!=1:
        return False
    audited=renderer_processes[0]
    if audited.get('pid')!=pid:
        return False

    proof_exact = proof.get('creationTimeExact')
    audited_exact = audited.get('creationTimeExact')
    if proof_exact is None and audited_exact is None:
        if not allow_legacy:
            return False
        proof_legacy = _legacy_creation_time(proof.get('creationTime'))
        audited_legacy = _legacy_creation_time(audited.get('creationTime'))
        if type(proof_legacy) is not int or type(audited_legacy) is not int or \
            proof_legacy <= 0 or proof_legacy != audited_legacy:
            return False
        proof_time = audited_time = proof_legacy
    else:
        proof_time = validate_canonical_filetime(proof_exact)
        audited_time = validate_canonical_filetime(audited_exact)
        if proof_time is None or audited_time is None or proof_time != audited_time:
            return False
        # Legacy integers are advisory for new proofs. A safe integer must not
        # contradict the canonical value; an unsafe one cannot be compared
        # without reproducing the JavaScript Number precision loss.
        for legacy in (_legacy_creation_time(proof.get('creationTime')),
                _legacy_creation_time(audited.get('creationTime'))):
            if legacy == 'INVALID':
                return False
            if type(legacy) is int and legacy <= MAX_SAFE_FILETIME_INTEGER and legacy != proof_time:
                return False

    samples=receipt.get('processSamples')
    if not isinstance(samples,list) or len(samples)<4:
        return False
    sample_map={s.get('phase'):s for s in samples if isinstance(s,dict)}
    for phase in PHASES:
        s=sample_map.get(phase)
        if not s or not isinstance(s.get('processes'),list):
            return False
        sample_renderers=[p for p in s['processes'] if isinstance(p,dict) and p.get('type')=='renderer']
        if len(sample_renderers)!=1 or sample_renderers[0].get('pid')!=pid:
            return False

    handle_release=receipt.get('handleRelease')
    if not isinstance(handle_release,dict) or handle_release.get('status')!='PASS':
        return False
    proc_handles=handle_release.get('processHandles',{})
    if proc_handles.get('closeFailures',0)!=0 or proc_handles.get('releasedProcessHandles',0)<=0:
        return False

    browser_id=receipt.get('browserIdentity')
    if not isinstance(browser_id,dict):
        return False
    before=browser_id.get('before')
    if not isinstance(before,dict) or before.get('nativeFlagsValidated') is not True:
        return False

    return True

def _legacy_proof_matches(receipt,pid):
    """Historical replay only. New proofs must use _proof_matches without fallback."""
    return _proof_matches(receipt,pid,allow_legacy=True)

def _aggregate_trace(events,receipt):
    """Strict allocation aggregates; snapshots do not identify individual lifetimes or prove leaks."""
    if not isinstance(receipt,dict):raise NativeTraceError('NATIVE_RECEIPT_INVALID')
    if receipt.get('tracingStarted') is not True or receipt.get('memoryInfraCategoryAvailable') is not True or \
        receipt.get('complete') is not True or receipt.get('dataLossOccurred') is not False or \
        receipt.get('activatedBeforeWorkload') is not True or receipt.get('streamEof') is not True:
        raise NativeTraceError('NATIVE_TRACE_INCOMPLETE_OR_DATA_LOSS')
    if not isinstance(receipt.get('flags'),list) or not NATIVE_FLAGS.issubset(set(receipt['flags'])):
        raise NativeTraceError('NATIVE_TRACE_FLAGS_INVALID')
    pid=receipt.get('rendererPid')
    if type(pid) is not int or pid<=0:raise NativeTraceError('NATIVE_RENDERER_PID_MISSING')
    checkpoints=receipt.get('checkpoints')
    if not isinstance(checkpoints,list) or [c.get('phase') for c in checkpoints if isinstance(c,dict)]!=list(PHASES) or \
        len(checkpoints)!=4 or any(c.get('success') is not True for c in checkpoints):
        raise NativeTraceError('NATIVE_CHECKPOINT_RECEIPT_INVALID')
    targets={}
    for index,checkpoint in enumerate(checkpoints):
        key=checkpoint.get('dumpGuid')
        try:parsed=guid(key)
        except (TypeError,ValueError,OverflowError):raise NativeTraceError('NATIVE_CHECKPOINT_GUID_INVALID') from None
        if parsed in targets:raise NativeTraceError('NATIVE_CHECKPOINT_GUID_DUPLICATE')
        timestamp=checkpoint.get('timestamp')
        try:number(timestamp)
        except ValueError:raise NativeTraceError('NATIVE_CHECKPOINT_TIMESTAMP_INVALID') from None
        if index and number(checkpoints[index-1]['timestamp'])>=timestamp:
            raise NativeTraceError('NATIVE_CHECKPOINT_ORDER_INVALID')
        targets[parsed]=checkpoint
    metadata_renderer_pids=set();dump_events={};strings={};nodes={};symbols=set();stack_bins=missing_bins=0
    heaps_seen=set()
    for event in events:
        if not isinstance(event,dict):raise NativeTraceError('NATIVE_EVENT_INVALID')
        event_pid=event.get('pid')
        if event.get('ph')=='M' and event.get('name')=='process_name':
            args=event.get('args')
            if isinstance(args,dict) and args.get('name') in ('Renderer','Renderer process') and type(event_pid) is int:
                metadata_renderer_pids.add(event_pid)
        args=event.get('args')
        if not isinstance(args,dict):continue
        data=args.get('dumps')
        if event.get('ph')!='v' or not isinstance(data,dict):continue
        event_guid=_event_guid(event)
        if event_guid is None:continue
        if event_guid not in targets:continue
        if type(event_pid) is not int or event_pid<=0:raise NativeTraceError('NATIVE_DUMP_PID_INVALID')
        if event_pid!=pid:
            # Global dump records from other process IDs are expected; only reject a renderer explicitly bound elsewhere.
            if event_pid in metadata_renderer_pids:raise NativeTraceError('NATIVE_RENDERER_PID_MISMATCH')
            continue
        category=event.get('cat')
        if 'disabled-by-default-memory-infra' not in (category if isinstance(category,list) else [category]):
            raise NativeTraceError('NATIVE_TRACE_CATEGORY_MISSING')
        timestamp=event.get('ts')
        try:number(timestamp)
        except ValueError:raise NativeTraceError('NATIVE_DUMP_TIMESTAMP_INVALID') from None
        if event_guid in dump_events:
            record=dump_events[event_guid]
            if record['pid']!=event_pid:raise NativeTraceError('NATIVE_DUMP_PID_CONFLICT')
            if record['traceTimestampUs']!=timestamp:raise NativeTraceError('NATIVE_DUMP_TIMESTAMP_CONFLICT')
        else:
            record=dump_events.setdefault(event_guid,{'pid':event_pid,'phase':targets[event_guid]['phase'],
                'traceTimestampUs':timestamp,'allocators':{},'allocatorStats':{},'rawAllocators':{}})
        stats=data.get('allocators',{})
        if not isinstance(stats,dict):raise NativeTraceError('NATIVE_ALLOCATOR_STATS_INVALID')
        for name,allocator in stats.items():
            if not isinstance(name,str) or not name or not isinstance(allocator,dict):raise NativeTraceError('NATIVE_ALLOCATOR_STATS_INVALID')
            attrs={}
            allocator_attrs=allocator.get('attrs',{})
            if not isinstance(allocator_attrs,dict):raise NativeTraceError('NATIVE_ALLOCATOR_STATS_INVALID')
            for attr in ('size','allocated_objects_size','virtual_size'):
                value=allocator_attrs.get(attr)
                if value is None:continue
                if not isinstance(value,dict) or value.get('type')!='scalar' or value.get('units')!='bytes' or \
                    not isinstance(value.get('value'),str) or not re.fullmatch(r'(?:0x)?[0-9a-fA-F]+',value['value']):
                    raise NativeTraceError('NATIVE_ALLOCATOR_STATS_INVALID')
                attrs[attr]=number(int(value['value'],16))
            if attrs:
                key=label(name)
                if key in record['allocatorStats']:
                    if record['allocatorStats'][key]!=attrs:
                        raise NativeTraceError('NATIVE_ALLOCATOR_STATS_DUPLICATE')
                else:
                    record['allocatorStats'][key]=attrs
        if 'heaps_v2' not in data:continue
        heaps=data['heaps_v2']
        if not isinstance(heaps,dict) or type(heaps.get('version')) is not int or heaps.get('version')!=1:
            raise NativeTraceError('NATIVE_HEAPS_V2_SCHEMA_UNSUPPORTED')
        maps=heaps.get('maps',{})
        if not isinstance(maps,dict) or not isinstance(maps.get('strings',[]),list) or not isinstance(maps.get('nodes',[]),list):
            raise NativeTraceError('NATIVE_HEAPS_V2_MAPS_INVALID')
        string_rows,nodes_rows=maps.get('strings',[]),maps.get('nodes',[])
        if len(strings)+len(string_rows)>100000 or len(nodes)+len(nodes_rows)>100000:
            raise NativeTraceError('NATIVE_HEAPS_V2_MAP_LIMIT')
        for entry in string_rows:
            if not isinstance(entry,dict) or type(entry.get('id')) is not int or entry['id']<0 or not isinstance(entry.get('string'),str):
                raise NativeTraceError('NATIVE_HEAPS_V2_MAPS_INVALID')
            if entry['id'] in strings and strings[entry['id']]!=entry['string']:
                raise NativeTraceError('NATIVE_HEAPS_V2_MAP_CONFLICT')
            strings[entry['id']]=entry['string']
        for node in nodes_rows:
            if not isinstance(node,dict) or type(node.get('id')) is not int or node['id']<0 or type(node.get('name_sid')) is not int:
                raise NativeTraceError('NATIVE_HEAPS_V2_MAPS_INVALID')
            if 'parent' in node and type(node['parent']) is not int:raise NativeTraceError('NATIVE_HEAPS_V2_MAPS_INVALID')
            if node['id'] in nodes and nodes[node['id']]!=node:raise NativeTraceError('NATIVE_HEAPS_V2_MAP_CONFLICT')
            nodes[node['id']]=node
        if len(strings)>100000 or len(nodes)>100000:raise NativeTraceError('NATIVE_HEAPS_V2_MAP_LIMIT')
        allocators=heaps.get('allocators')
        if not isinstance(allocators,dict):raise NativeTraceError('NATIVE_HEAPS_V2_ALLOCATORS_INVALID')
        for name,allocator in allocators.items():
            if not isinstance(name,str) or not name or not isinstance(allocator,dict):raise NativeTraceError('NATIVE_HEAPS_V2_ALLOCATORS_INVALID')
            sizes,counts=allocator.get('sizes'),allocator.get('counts')
            if not isinstance(sizes,list) or not sizes or len(sizes)>100000 or not isinstance(counts,list):
                raise NativeTraceError('NATIVE_HEAP_ARRAYS_INVALID')
            paths=allocator.get('nodes',[-1]*len(sizes));types=allocator.get('types',[-1]*len(sizes))
            if not isinstance(paths,list) or not isinstance(types,list) or len({len(sizes),len(counts),len(paths),len(types)})!=1:
                raise NativeTraceError('NATIVE_HEAP_ARRAYS_INVALID')
            safe_name=label(name)
            signature=(tuple(sizes),tuple(counts),tuple(paths),tuple(types))
            if safe_name in record['allocators']:
                if record.get('rawAllocators',{}).get(safe_name)!=signature:
                    raise NativeTraceError('NATIVE_HEAP_ALLOCATOR_DUPLICATE')
                continue
            record.setdefault('rawAllocators',{})[safe_name]=signature
            for index,path in enumerate(paths):
                if type(path) is not int or path < -1 or type(types[index]) is not int or types[index] < -1:
                    raise NativeTraceError('NATIVE_HEAP_ARRAYS_INVALID')
                number(sizes[index]);number(counts[index])
                chain=set();cursor=path
                while cursor in nodes:
                    if cursor in chain:raise NativeTraceError('NATIVE_STACK_CYCLE')
                    chain.add(cursor);node=nodes[cursor]
                    safe=symbol(strings.get(node['name_sid']))
                    if safe:symbols.add(safe)
                    cursor=node.get('parent',-1)
                if chain:stack_bins+=1
                else:missing_bins+=1
            record['allocators'][safe_name]={'trackedLiveRequestedBytes':number(sum(number(v) for v in sizes)),
                'estimatedLiveAllocationCount':number(sum(number(v) for v in counts)),'cohortBins':len(sizes)}
        heaps_seen.add(event_guid)
    if metadata_renderer_pids and pid not in metadata_renderer_pids:
        raise NativeTraceError('NATIVE_RENDERER_PID_MISMATCH')
    if pid not in metadata_renderer_pids and not _proof_matches(receipt,pid):
        raise NativeTraceError('NATIVE_RENDERER_METADATA_MISSING')
    if set(dump_events)!=set(targets):raise NativeTraceError('NATIVE_CHECKPOINT_DUMPS_INCOMPLETE')
    rows=[{k:v for k,v in dump_events[guid(checkpoint['dumpGuid'])].items() if k in ('phase','traceTimestampUs','allocators','allocatorStats')} for checkpoint in checkpoints]
    if any(rows[i]['traceTimestampUs']>=rows[i+1]['traceTimestampUs'] for i in range(3)):
        raise NativeTraceError('NATIVE_DUMP_TIMESTAMP_ORDER_INVALID')
    if heaps_seen!=set(targets):
        reason='NATIVE_HEAPS_V2_INCOMPLETE' if heaps_seen else 'NATIVE_HEAPS_V2_NOT_EMITTED'
        raise NativeTraceError(reason)
    usable=all(any(item['trackedLiveRequestedBytes']>0 for item in row['allocators'].values()) for row in rows)
    if not usable:raise NativeTraceError('NATIVE_HEAPS_V2_EMPTY')
    return {'status':'R12R2_NATIVE_CAPABILITY_PASS','checkpoints':rows,
        'stackAttribution':'sanitized-symbols' if symbols else 'STACK_ATTRIBUTION_UNAVAILABLE',
        'sanitizedSymbols':sorted(symbols)[:50],'stackBins':stack_bins,'missingStackBins':missing_bins,'sampling':True,
        'coverage':'Only exposed heaps_v2 allocators; total native heap coverage unproven.',
        'lifetimes':'Live aggregate cohorts at four timestamps; individual allocation identity unavailable.',
        'requestedVsCommitted':'Tracked sizes are requested bytes; allocator stats are separate, possibly hierarchical and never summed.'}

def aggregate_trace(events,receipt,*,detailed=False):
    try:
        result=_aggregate_trace(events,receipt)
        if detailed:result['status']='NATIVE_CAPABILITY_PASS'
        return result
    except NativeTraceError as error:
        if detailed:return {'status':'NATIVE_INCONCLUSIVE' if error.reason in INCONCLUSIVE else 'NATIVE_STOP','reason':error.reason}
        status='R12R2_NATIVE_PROFILER_UNAVAILABLE' if error.reason in ('NATIVE_HEAPS_V2_NOT_EMITTED','NATIVE_HEAPS_V2_INCOMPLETE','NATIVE_HEAPS_V2_EMPTY') else 'R12R2_NATIVE_INCONCLUSIVE'
        return {'status':status,'reason':'NATIVE_TRACE_CONTRACT_INVALID'}
    except (ValueError,KeyError,TypeError,OverflowError,RecursionError):
        if detailed:return {'status':'NATIVE_STOP','reason':'NATIVE_TRACE_SCHEMA_INVALID'}
        return {'status':'R12R2_NATIVE_INCONCLUSIVE','reason':'NATIVE_TRACE_CONTRACT_INVALID'}

def interpret(at_close,at_idle,private_delta,coverage_established):
    for value in (at_close,at_idle,private_delta):number(value)
    if not coverage_established:return 'INCONCLUSIVE'
    if at_idle>=at_close:return 'OBSERVED_TRACKED_RETENTION'
    return 'RESERVATION_COMPATIBLE' if private_delta>0 else 'OBSERVED_TRACKED_RELEASE'
