import test from 'node:test';
import assert from 'node:assert/strict';
import {CONDITIONS,CONTRASTS,selectCondition,classify,confirm,effects,routeRange,transportCounts} from './ap06-r12-r2-contract.mjs';

test('four immutable selectors reject historical conflicts and invalid values',()=>{
  assert.ok(Object.isFrozen(CONDITIONS));assert.equal(selectCondition(undefined),null);
  for(const [key,value] of Object.entries(CONDITIONS)){
    assert.ok(Object.isFrozen(value));assert.equal(selectCondition(key),key);
    for(let i=0;i<4;i++){const conflicts=Array(4);conflicts[i]='historical';assert.throws(()=>selectCondition(key,...conflicts));}
  }
  for(const value of [null,'','r12.0','r12r2.4',true,{}])assert.throws(()=>selectCondition(value));
});
test('all four conditional effects and interaction are descriptive signed scalars',()=>{
  assert.deepEqual(effects({'r12r2.0':10,'r12r2.1':30,'r12r2.2':400,'r12r2.3':450}),{
    payloadWithXhrMetadata:390,payloadWithFetchMetadata:420,metadataWithXhrPayload:20,metadataWithFetchPayload:50,interaction:30});
});
test('control and 150 threshold, priority and observed direction are fixed',()=>{
  assert.equal(classify({'r12r2.0':0,'r12r2.1':0,'r12r2.2':400,'r12r2.3':299.99}).status,'R12R2_CONTROL_NOT_REPRODUCED');
  assert.equal(classify(Object.fromEntries(Object.keys(CONDITIONS).map(c=>[c,300]))).status,'R12R2_FACTORIAL_INCONCLUSIVE');
  const cases=[[0,0,150,300],[200,0,200,300],[150,300,150,300],[300,400,200,500]];
  for(const [index,values] of cases.entries()){
    const candidate=classify(Object.fromEntries(Object.keys(CONDITIONS).map((c,i)=>[c,values[i]])));
    assert.equal(candidate.contrast,index+1);assert.deepEqual(candidate.pair,CONTRASTS[index]);
  }
  const reversed=classify({'r12r2.0':450,'r12r2.1':450,'r12r2.2':0,'r12r2.3':300});
  assert.equal(reversed.highCondition,'r12r2.0');
  for(const value of [NaN,Infinity,true,'400'])assert.throws(()=>classify({'r12r2.0':0,'r12r2.1':0,'r12r2.2':value,'r12r2.3':400}));
});
test('ABBAAB confirms only the frozen contrast, sign and conservative separation',()=>{
  const c=classify({'r12r2.0':0,'r12r2.1':0,'r12r2.2':400,'r12r2.3':400}),[a,b]=c.pair;
  const rows=[a,b,b,a,a,b].map(condition=>({condition,rendererPrivateDeltaMiB:condition===b?300:150}));
  assert.equal(confirm(c,400,rows).separationMiB,150);
  assert.equal(confirm(c,400,rows.map(r=>({...r,rendererPrivateDeltaMiB:-r.rendererPrivateDeltaMiB}))).status,'R12R2_FORMAL_DISAGREEMENT');
  assert.equal(confirm(c,400,rows.slice(1)).status,'R12R2_FORMAL_DISAGREEMENT');
  assert.equal(confirm(c,400,rows.map((r,i)=>({...r,condition:i===0?b:r.condition}))).status,'R12R2_FORMAL_DISAGREEMENT');
  assert.throws(()=>confirm({...c,pair:[a,'r12r2.1']},400,rows));
});
test('route validates exact protocol identity, offset and order before transport choice',()=>{
  const metadata={id:101,start:0,end:131071},payload={id:101,start:114,end:4194433};
  for(const [condition,selected] of Object.entries(CONDITIONS)){
    assert.equal(routeRange(condition,metadata,metadata),'metadata');
    assert.equal(routeRange(condition,payload,payload),'payload');
    assert.equal(selected.metadata,condition==='r12r2.1'||condition==='r12r2.3'?'fetch':'xhr');
    assert.equal(selected.payload,condition==='r12r2.2'||condition==='r12r2.3'?'fetch':'xhr');
    for(const bad of [{...metadata,end:1023},{...metadata,id:102},{...payload,start:0},{...payload,end:4194432}])assert.throws(()=>routeRange(condition,bad,metadata));
    assert.throws(()=>routeRange(condition,metadata,payload));
    const counts=transportCounts(condition,3);
    assert.equal(Object.values(counts).reduce((a,b)=>a+b,0),25559136+9);
  }
});
