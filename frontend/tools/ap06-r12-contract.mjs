export const R12_CONDITIONS = Object.freeze(Object.fromEntries([
  ['r12.0','xhr','blob'],['r12.1','fetch','blob'],['r12.2','xhr','blob-arraybuffer'],
  ['r12.3','fetch','blob-arraybuffer'],['r12.4','fetch','direct-arraybuffer'],
].map(([key,transport,payload])=>[key,Object.freeze({transport,payload})])));
export const R12_CONTRASTS = Object.freeze([
  ['r12.0','r12.1'],['r12.1','r12.3'],['r12.2','r12.3'],['r12.3','r12.4'],
].map(Object.freeze));

export function selectR12(value,r11,r10,r9) {
  if(value===undefined)return null;
  if(typeof value!=='string'||!Object.hasOwn(R12_CONDITIONS,value))throw new Error('R12_INVALID_CONDITION');
  if([r11,r10,r9].some(v=>v!==undefined))throw new Error('R12_CONFLICTING_SELECTORS');
  return value;
}
export function classifyR12(values) {
  if(!values||Object.keys(values).sort().join()!==Object.keys(R12_CONDITIONS).sort().join()||Object.values(values).some(v=>!Number.isFinite(v)))throw new Error('R12_INVALID_DELTAS');
  if(values['r12.3']<300)return {status:'R12_CONTROL_NOT_REPRODUCED'};
  for(const [index,pair] of R12_CONTRASTS.entries()){
    const [a,b]=pair;
    if(Math.abs(values[b]-values[a])>=150)return {status:'R12_CANDIDATE',contrast:index+1,pair,
      highCondition:values[a]>values[b]?a:b,lowCondition:values[a]>values[b]?b:a};
  }
  return {status:'R12_INCONCLUSIVE'};
}
export function confirmR12(candidate,control,results) {
  if(!Number.isFinite(control))throw new Error('R12_INVALID_CONTROL');
  if(control<300)return {status:'R12_CONTROL_NOT_REPRODUCED'};
  const pair=R12_CONTRASTS[candidate?.contrast-1];
  if(candidate?.status!=='R12_CANDIDATE'||!pair||pair.join()!==candidate.pair?.join()||
    !pair.includes(candidate.highCondition)||!pair.includes(candidate.lowCondition)||candidate.highCondition===candidate.lowCondition)throw new Error('R12_INVALID_CANDIDATE');
  const [a,b]=pair,order=[a,b,b,a,a,b];
  if(!Array.isArray(results)||results.length!==6||results.some((r,i)=>r.condition!==order[i]||!Number.isFinite(r.rendererPrivateDeltaMiB)))return {status:'R12_FORMAL_DISAGREEMENT'};
  const deltas=c=>results.filter(r=>r.condition===c).map(r=>r.rendererPrivateDeltaMiB);
  const separationMiB=Math.min(...deltas(candidate.highCondition))-Math.max(...deltas(candidate.lowCondition));
  return separationMiB>=150?{...candidate,status:'R12_CONTRAST_CONFIRMED',separationMiB}:{status:'R12_FORMAL_DISAGREEMENT'};
}
export function newR12Counters() {
  return Object.fromEntries(['payloadBlobCount','payloadBlobBytes','payloadArrayBufferCount','payloadArrayBufferBytes',
    'metadataBytes','metadataCompleted','pendingOperations','completedOperations','failedOperations','cancelledOperations',
    'activeReferences','sessionsStarted','sessionsCompleted','sessionsFailed','obtainMs','materializeMs'].map(k=>[k,0]));
}
export function rangeBodyBytes(condition,isPayload,body) {
  selectR12(condition);
  if(isPayload&&condition==='r12.4'){
    if(!(body instanceof ArrayBuffer))throw new Error('R12_RANGE_BODY_TYPE_INVALID');
    return body.byteLength;
  }
  if(!(body instanceof Blob))throw new Error('R12_RANGE_BODY_TYPE_INVALID');
  return body.size;
}
export function validateR12Counters(condition,c,sessions,payloadBytes) {
  const mode=R12_CONDITIONS[selectR12(condition)].payload,blob=mode!=='direct-arraybuffer',buffer=mode!=='blob';
  if(Object.keys(c).sort().join()!==Object.keys(newR12Counters()).sort().join()||Object.values(c).some(v=>!Number.isFinite(v)||v<0)||
    c.pendingOperations||c.activeReferences||c.failedOperations||c.cancelledOperations||c.sessionsFailed||
    c.sessionsStarted!==sessions||c.sessionsCompleted!==sessions||c.metadataCompleted!==sessions||
    c.metadataBytes!==sessions*131072||c.completedOperations!==sessions*3||
    c.payloadBlobCount!==(blob?sessions*2:0)||c.payloadBlobBytes!==(blob?payloadBytes:0)||
    c.payloadArrayBufferCount!==(buffer?sessions*2:0)||c.payloadArrayBufferBytes!==(buffer?payloadBytes:0))throw new Error('R12_SCALAR_CONTRACT_FAILED');
}
