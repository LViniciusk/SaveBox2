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

def symbol(value):
    if isinstance(value,str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_:<>(), ~*&.\[\]-]{2,160}',value) and '0x' not in value and value.lower() not in ('unknown','unknown type'):
        return value
    return None

def aggregate_trace(events,receipt):
    """Snapshots are sampled live allocation cohorts, never individual allocation lifetimes or leak proof."""
    try:
        if receipt.get('complete') is not True or receipt.get('dataLossOccurred') is not False or receipt.get('activatedBeforeWorkload') is not True:raise ValueError('TRACE_INCOMPLETE')
        pid=receipt['rendererPid'];number(pid)
        if type(pid) is not int or not pid:raise ValueError('RENDERER_PID_MISSING')
        checkpoints=receipt['checkpoints']
        if [c['phase'] for c in checkpoints]!=['baseline','cycle-6-close','idle-120s','forced-GC-final'] or not all(c['success'] is True for c in checkpoints):raise ValueError('DUMPS_MISSING')
        targets={guid(c['dumpGuid']):c for c in checkpoints}
        if len(targets)!=4 or any(number(checkpoints[i]['timestamp'])>=number(checkpoints[i+1]['timestamp']) for i in range(3)):raise ValueError('DUMP_ORDER_INVALID')
        renderer=False;dumps={};strings={};nodes={};sanitized=set();stack_bins=0;missing_bins=0
        for event in events:
            if event.get('pid')!=pid:continue
            if event.get('ph')=='M' and event.get('name')=='process_name':renderer=event.get('args',{}).get('name') in ('Renderer','Renderer process')
            data=event.get('args',{}).get('dumps')
            if not isinstance(data,dict) or event.get('ph')!='v':continue
            key=guid(event.get('id',event.get('id2',{}).get('global')));timestamp=number(event.get('ts'))
            if key not in targets:continue
            record=dumps.setdefault(key,{'phase':targets[key]['phase'],'pid':pid,'traceTimestampUs':timestamp,'allocators':{},'allocatorStats':{}})
            for name,allocator in data.get('allocators',{}).items():
                attrs={}
                for attr in ('size','allocated_objects_size','virtual_size'):
                    value=allocator.get('attrs',{}).get(attr)
                    if value and value.get('type')=='scalar' and value.get('units')=='bytes':attrs[attr]=number(int(value['value'],16))
                if attrs:record['allocatorStats'][label(name)]=attrs
            heaps=data.get('heaps_v2')
            if heaps is None:continue
            if heaps.get('version')!=1:raise ValueError('HEAP_SCHEMA_UNSUPPORTED')
            maps=heaps.get('maps',{})
            for entry in maps.get('strings',[]):strings[entry['id']]=entry['string']
            for node in maps.get('nodes',[]):nodes[node['id']]=node
            if len(strings)>100000 or len(nodes)>100000:raise ValueError('NATIVE_MAP_LIMIT')
            for name,allocator in heaps.get('allocators',{}).items():
                sizes,counts=allocator['sizes'],allocator['counts'];paths=allocator.get('nodes',[-1]*len(sizes));types=allocator.get('types',[-1]*len(sizes))
                if not sizes or len({len(sizes),len(counts),len(paths),len(types)})!=1 or label(name) in record['allocators']:raise ValueError('HEAP_ARRAYS_INVALID')
                for path in paths:
                    chain=set()
                    while path in nodes:
                        if path in chain:raise ValueError('STACK_CYCLE')
                        chain.add(path);node=nodes[path];safe=symbol(strings.get(node['name_sid']))
                        if safe:sanitized.add(safe)
                        path=node.get('parent')
                    if chain:stack_bins+=1
                    else:missing_bins+=1
                record['allocators'][label(name)]={'trackedLiveRequestedBytes':sum(number(v) for v in sizes),
                    'estimatedLiveAllocationCount':sum(number(v) for v in counts),'cohortBins':len(sizes)}
        if not renderer or set(dumps)!=set(targets):raise ValueError('RENDERER_OR_DUMP_MISSING')
        rows=[dumps[guid(c['dumpGuid'])] for c in checkpoints]
        if any(rows[i]['traceTimestampUs']>=rows[i+1]['traceTimestampUs'] for i in range(3)):raise ValueError('DUMP_TIMESTAMP_INVALID')
        usable=all(any(a['trackedLiveRequestedBytes']>0 for a in row['allocators'].values()) for row in rows)
        return {'status':'R12R2_NATIVE_CAPABILITY_PASS' if usable else 'R12R2_NATIVE_PROFILER_UNAVAILABLE','rendererPid':pid,'checkpoints':rows,
            'stackAttribution':'sanitized-symbols' if sanitized else 'raw-stack-ids-only' if stack_bins else 'unavailable',
            'sanitizedSymbols':sorted(sanitized)[:50],'stackBins':stack_bins,'missingStackBins':missing_bins,'sampling':True,
            'coverage':'Only exposed heaps_v2 allocators; total native heap coverage unproven.',
            'lifetimes':'Live aggregate cohorts at four timestamps; individual allocation identity unavailable.',
            'requestedVsCommitted':'Tracked sizes are requested bytes; allocator stats are separate, possibly hierarchical and never summed.'}
    except (ValueError,KeyError,TypeError,OverflowError,RecursionError):return {'status':'R12R2_NATIVE_INCONCLUSIVE','reason':'NATIVE_TRACE_CONTRACT_INVALID'}

def interpret(at_close,at_idle,private_delta,coverage_established):
    for value in (at_close,at_idle,private_delta):number(value)
    if not coverage_established:return 'INCONCLUSIVE'
    if at_idle>=at_close:return 'OBSERVED_TRACKED_RETENTION'
    return 'RESERVATION_COMPATIBLE' if private_delta>0 else 'OBSERVED_TRACKED_RELEASE'
