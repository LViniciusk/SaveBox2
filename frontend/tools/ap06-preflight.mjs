import { parseRangeHeader } from '../experiments/ap06-r7/range-adapter.ts';

export function credentialAuthDelay(attempts,now,readyAt) {
  // Native auth permits five/minute; an initial full window also covers API preparation.
  return Math.max(0,readyAt-now,attempts.length>=5?attempts.at(-5)+60250-now:0);
}

export function networkGuardSnapshot(raw) {
  return {pageErrors:raw.pageErrors,rejectedRequests:raw.network?.rejectedRequests,
    externalRequests:raw.network?.externalRequests,unexpectedRequests:raw.network?.unexpectedRequests,recoveryWarnings:raw.recoveryWarnings};
}

export function validateCleanNetwork(raw,condition) {
  const counters=networkGuardSnapshot(raw);
  for (const [name,actual] of Object.entries(counters)) if(actual!==0) {
    const error=new Error(`R10_NETWORK_GUARD_${name}`);
    error.guard={condition,name,actual:actual??null,expected:0};error.counters=counters;throw error;
  }
  return counters;
}

export function strictHttpFailure(policy,observed,status=403) {
  return async route=>{
    const request=route.request();
    if(request.url()!==policy.url) throw new Error('R10_UNEXPECTED_NEGATIVE_URL');
    if(request.method()==='OPTIONS'){observed.options++;return route.continue();}
    const headers=request.headers();
    if(request.method()!=='GET' || !headers.authorization) throw new Error('R10_UNEXPECTED_NEGATIVE_REQUEST');
    if(policy.ciphertextBytes) {
      try {parseRangeHeader(headers.range??'',policy.ciphertextBytes);}
      catch {throw new Error('R10_INVALID_NEGATIVE_RANGE');}
    } else if(headers.range) throw new Error('R10_UNEXPECTED_NEGATIVE_RANGE');
    if(++observed.get!==1) throw new Error('R10_ADDITIONAL_NEGATIVE_GET');
    return route.fulfill({status,contentType:'application/json',headers:{
      'Access-Control-Allow-Origin':policy.origin,'Access-Control-Allow-Credentials':'true'},body:'{}'});
  };
}

export function validateHttpFailure(network,observed,proof,expectedType) {
  const rows=network.requests,options=network.optionsRequests??[];
  const ids=[...rows,...options,...(network.bootstrapRequests??[])].map(row=>row.requestId);
  if(proof.status===0 || [...rows,...options].some(row=>row.failed))throw new Error('R10_NEGATIVE_CORS_OR_NETWORK_FAILURE');
  if(observed.get===0 || rows.length===0)throw new Error('R10_NEGATIVE_GET_NOT_OBSERVED');
  if(rows.some(row=>row.status!==403))throw new Error('R10_NEGATIVE_STATUS_NOT_403');
  if(!network.enabledBeforeNavigation || !network.listenersDetached || !network.sessionDetached || network.duplicateRequestIds ||
    observed.get!==1 || observed.failureCode || rows.length!==1 || ids.length!==new Set(ids).size ||
    rows.some(row=>row.method!=='GET' || row.status!==403 || row.type!==expectedType || !row.finished || row.failed) ||
    options.some(row=>row.status===403 || row.status<200 || row.status>=300 || !row.finished || row.failed)) {
    throw new Error('R10_NEGATIVE_HTTP_EVIDENCE_INVALID');
  }
  if(!proof.rejected || !proof.angularHttpError || proof.status!==403 || proof.lockedBefore!==false ||
    proof.lockedAfter!==true || !proof.authenticated) throw new Error('R10_NEGATIVE_ANGULAR_403_NOT_PROVEN');
}

export async function cleanupContext({routes,observer,cdp,context},record) {
  const errors=[];
  const attempt=async action=>{try{await action();return true;}catch(error){errors.push(error);return false;}};
  const unrouted=[];
  for(const [url,handler] of routes)unrouted.push(await attempt(()=>context.unroute(url,handler)));
  record.routesRemoved=unrouted.every(Boolean);
  if(observer)await attempt(observer);
  if(cdp)record.listenerSessionDetached=await attempt(()=>cdp.detach());
  if(context)record.closed=await attempt(()=>context.close());
  return errors;
}

function failure(error,condition,gate,diagnostic) {
  const auth=diagnostic.network?.find(row=>row.method==='POST'&&row.url==='http://127.0.0.1:42187/login'&&row.status!==200);
  const frames=[];
  for(const line of String(error.stack??'').split('\n').slice(1)) {
    const match=/\bat (?:([\w$.<>]+) \()?[^\r\n]*[\\/]([\w.-]+\.(?:mjs|js|ts)):(\d+):(\d+)\)?$/.exec(line.trim());
    if(match && /^(?:ap06-|browser-memory-|mp4-resource-)/.test(match[2]) && frames.length<12) frames.push({function:match[1]??null,file:match[2],line:Number(match[3]),column:Number(match[4])});
  }
  const code=/^(?:R\d+_|INVALID_|ERR_)[A-Za-z0-9_]+$/.test(error.message)?error.message:
    /^[A-Z_]+$/.test(error.code??'')?error.code:'R10_PREFLIGHT_ACTION_FAILED';
  return {condition,gate:diagnostic.gate??gate,class:['Error','AssertionError','TypeError','TimeoutError'].includes(error.name)?error.name:'Error',
    code:auth?`R10_AUTH_BOOTSTRAP_HTTP_${Number.isInteger(auth.status)?auth.status:'NO_RESPONSE'}`:code,
    guard:auth?{condition,name:'authStatus',actual:auth.status,expected:200}:error.guard??null,guards:error.counters??networkGuardSnapshot(diagnostic.raw??{}),
    actual:auth?auth.status:typeof error.actual==='number'||typeof error.actual==='boolean'?error.actual:null,
    expected:auth?200:typeof error.expected==='number'||typeof error.expected==='boolean'?error.expected:null,
    lifecycle:diagnostic.lifecycle??null,resources:diagnostic.resources??null,network:diagnostic.network??[],frames};
}

export async function checkCase(result,save,condition,name,action,diagnose=async()=>({})) {
  const row={condition,name,status:'PENDING'};result.cases.push(row);save();
  try {await action();row.status='PASS';save();}
  catch(error) {
    let diagnostic;
    try {diagnostic=await diagnose();} catch {diagnostic={gate:name,lifecycle:{status:'UNAVAILABLE_DIAGNOSTIC_FAILED'}};}
    row.status='FAIL';result.preflight.failures.push(failure(error,condition,name,diagnostic));save();throw error;
  }
}

export function validatePreflightConsistency(result,conditions) {
  if(!result.browserClosed || result.preflight.failures.length || !result.cases.length || result.cases.some(row=>row.status!=='PASS') ||
    result.preflight.contexts.some(row=>!row.closed || !row.routesRemoved || !row.listenersDetached || !row.sessionDetached || row.cleanupStatus!=='PASS') ||
    conditions.some(condition=>!result.preflight.contexts.some(row=>row.condition===condition && row.scenario==='positive' &&
      row.guards && Object.values(row.guards).every(value=>value===0)))) throw new Error('R10_PREFLIGHT_RECEIPT_INCONSISTENT');
  if(result.preflight.contexts.some(row=>row.rangeNetwork?.duplicateRequestIds || row.routeFailureCode))throw new Error('R10_PREFLIGHT_NETWORK_INCONSISTENT');
  if(conditions.some(condition=>condition.startsWith('r10.')) && (conditions.some(condition=>
    !['positive','GET 403','cancellation'].every(scenario=>result.preflight.contexts.some(row=>row.condition===condition&&row.scenario===scenario)) ||
    !result.negativeHttp?.[condition]?.proof) || !result.preflight.contexts.some(row=>row.scenario==='Store HTTP 500')))throw new Error('R10_PREFLIGHT_NEGATIVE_CONDITIONS_MISSING');
}
