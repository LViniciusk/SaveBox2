export const CONDITIONS=Object.freeze(Object.fromEntries([
  ['r12r2.0','xhr','xhr'],['r12r2.1','fetch','xhr'],['r12r2.2','xhr','fetch'],['r12r2.3','fetch','fetch'],
].map(([key,metadata,payload])=>[key,Object.freeze({metadata,payload})])));
export const CONTRASTS=Object.freeze([
  ['r12r2.0','r12r2.2'],['r12r2.1','r12r2.3'],['r12r2.0','r12r2.1'],['r12r2.2','r12r2.3'],
].map(Object.freeze));
export function selectCondition(value,...historical){
  if(value===undefined)return null;
  if(typeof value!=='string'||!Object.hasOwn(CONDITIONS,value))throw new Error('R12R2_INVALID_CONDITION');
  if(historical.some(v=>v!==undefined))throw new Error('R12R2_CONFLICTING_SELECTORS');
  return value;
}
function validate(values){
  if(!values||Object.keys(values).sort().join()!==Object.keys(CONDITIONS).sort().join()||
    Object.values(values).some(v=>typeof v!=='number'||!Number.isFinite(v)))throw new Error('R12R2_INVALID_DELTAS');
}
export function effects(values){
  validate(values);const [A,B,C,D]=Object.keys(CONDITIONS).map(c=>values[c]);
  return {payloadWithXhrMetadata:C-A,payloadWithFetchMetadata:D-B,metadataWithXhrPayload:B-A,metadataWithFetchPayload:D-C,interaction:D-C-B+A};
}
export function classify(values){
  validate(values);if(values['r12r2.3']<300)return {status:'R12R2_CONTROL_NOT_REPRODUCED'};
  for(const [index,pair] of CONTRASTS.entries()){
    const [a,b]=pair;
    if(Math.abs(values[b]-values[a])>=150)return {status:'R12R2_CANDIDATE',contrast:index+1,pair,
      highCondition:values[a]>values[b]?a:b,lowCondition:values[a]>values[b]?b:a};
  }
  return {status:'R12R2_FACTORIAL_INCONCLUSIVE'};
}
export function confirm(candidate,control,rows){
  if(typeof control!=='number'||!Number.isFinite(control))throw new Error('R12R2_INVALID_CONTROL');
  if(control<300)return {status:'R12R2_CONTROL_NOT_REPRODUCED'};
  const pair=CONTRASTS[candidate?.contrast-1];
  if(candidate?.status!=='R12R2_CANDIDATE'||!pair||pair.join()!==candidate.pair?.join()||
    !pair.includes(candidate.highCondition)||!pair.includes(candidate.lowCondition)||candidate.highCondition===candidate.lowCondition)throw new Error('R12R2_INVALID_CANDIDATE');
  const [a,b]=pair,order=[a,b,b,a,a,b];
  if(!Array.isArray(rows)||rows.length!==6||rows.some((r,i)=>r.condition!==order[i]||typeof r.rendererPrivateDeltaMiB!=='number'||!Number.isFinite(r.rendererPrivateDeltaMiB)))return {status:'R12R2_FORMAL_DISAGREEMENT'};
  const deltas=c=>rows.filter(r=>r.condition===c).map(r=>r.rendererPrivateDeltaMiB);
  const separationMiB=Math.min(...deltas(candidate.highCondition))-Math.max(...deltas(candidate.lowCondition));
  return separationMiB>=150?{...candidate,status:'R12R2_FACTORIAL_CONFIRMED',separationMiB}:{status:'R12R2_FORMAL_DISAGREEMENT'};
}
export function routeRange(condition,range,expected){
  selectCondition(condition);
  if(!expected||!['id','start','end'].every(k=>Number.isSafeInteger(range[k])&&range[k]===expected[k]))throw new Error('R12R2_RANGE_SEQUENCE_CHANGED');
  if(range.start===0&&range.end===131071)return 'metadata';
  if(range.start<=0||range.end-range.start+1!==4194320)throw new Error('R12R2_RANGE_SHAPE_CHANGED');
  return 'payload';
}
export function transportCounts(condition,sessions){
  const selected=CONDITIONS[selectCondition(condition)];
  if(!Number.isSafeInteger(sessions)||sessions<0||sessions>18)throw new Error('R12R2_SESSION_COUNT_INVALID');
  return Object.fromEntries(['metadata','payload'].flatMap(kind=>['xhr','fetch'].flatMap(transport=>[
    [kind+transport+'Count',selected[kind]===transport?sessions*(kind==='metadata'?1:2):0],
    [kind+transport+'Bytes',selected[kind]===transport?sessions*(kind==='metadata'?131072:8388640):0],
  ])));
}
