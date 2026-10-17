import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

export const AUTOPLAY_ARGS=Object.freeze(['--autoplay-policy=no-user-gesture-required']);
export const NATIVE_ARGS=Object.freeze(['--memlog=all','--memlog-stack-mode=native','--memlog-sampling-rate=16384','--memlog-keep-small-allocations']);
const require=createRequire(import.meta.url), leases=new WeakMap(), proofs=new WeakMap();
const python=()=>process.env.AP06_IDENTITY_PYTHON||process.env.WAVE1_PYTHON;
const helper=fileURLToPath(new URL('../../tools/quality/ap06_browser_identity.py',import.meta.url));
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const check=(value,reason='AP06_BROWSER_IDENTITY_UNPROVEN')=>{if(!value)throw new Error(reason);};
const allowedFailures=new Set(['AP06_BROWSER_WINDOWS_REQUIRED','AP06_BROWSER_EXECUTABLE_MISSING','AP06_BROWSER_REPARSE_REJECTED',
  'AP06_BROWSER_PATH_CHANGED','AP06_BROWSER_PE_INVALID','AP06_BROWSER_ARCHITECTURE_MISMATCH','AP06_BROWSER_CREATION_UNAVAILABLE',
  'AP06_BROWSER_PID_NOT_OWNED','AP06_BROWSER_PID_REUSED','AP06_BROWSER_PID_AMBIGUOUS','AP06_BROWSER_OS_QUERY_FAILED',
  'AP06_BROWSER_FLAGS_MISMATCH','AP06_BROWSER_VERSION_MISMATCH','AP06_BROWSER_EXECUTABLE_CHANGED','AP06_BROWSER_PLAYWRIGHT_CHANGED',
  'AP06_BROWSER_HANDLE_CREATION_CHANGED','AP06_BROWSER_CREATION_CIM_MISMATCH','AP06_BROWSER_IMAGE_ARGUMENT_MISMATCH',
  'AP06_BROWSER_READ_LEASE_FAILED','AP06_BROWSER_PROFILE_PATH_INVALID','AP06_BROWSER_ANCESTRY_INVALID',
  'AP06_BROWSER_IDENTITY_MISMATCH','AP06_BROWSER_IDENTITY_UNPROVEN','AP06_BROWSER_EXECUTABLE_MISSING',
  'AP06_BROWSER_LAUNCH_FAILED','AP06_BROWSER_ATTESTATION_FAILED','AP06_BROWSER_PROCESS_EXIT_AUDIT_FAILED',
  'AP06_BROWSER_HANDLE_RELEASE_FAILED','AP06_BROWSER_CDP_PROCESS_QUERY_FAILED','AP06_BROWSER_PROCESS_REGISTRATION_FAILED',
  'AP06_BROWSER_ATTESTATION_ORDER_INVALID','AP06_BROWSER_POST_ATTESTATION_FAILED','AP06_BROWSER_AUDIT_HELPER_FAILED']);
export const usesRetainedProcessAudit=()=>process.env.AP06_R5_PROCESS_HANDLE_AUDIT==='1';
function auditClosed(pids){
  check(process.env.AP06_R8_PID_AUDITOR&&pids.length,'AP06_BROWSER_PROCESS_EXIT_AUDIT_FAILED');
  const result=JSON.parse(execFileSync(python(),[process.env.AP06_R8_PID_AUDITOR,'--closed-pids',pids.join(',')],{encoding:'utf8',windowsHide:true,timeout:30000}));
  check(result.status==='PASS','AP06_BROWSER_PROCESS_EXIT_AUDIT_FAILED');return result;
}
async function stopLease(lease){
  const {child}=lease;child.stdin.end();
  if(child.exitCode!==null||child.signalCode!==null)return true;
  let timer;const exited=new Promise(resolve=>child.once('exit',()=>resolve(true)));
  const result=await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),3000);})]);clearTimeout(timer);
  if(result)return true;
  child.kill();await exited;return false;
}
async function launchProtocol(profileRoot,chromium){
  const implementation=chromium._connection.toImpl(chromium),placeholder=join(profileRoot,'playwright_chromiumdev_profile-AP06_PROTOCOL');
  const defaults=await implementation.defaultArgs({headless:false,args:[]},false,placeholder),profileArg=`--user-data-dir=${placeholder}`;
  const profileIndex=defaults.indexOf(profileArg);check(profileIndex>0&&defaults.indexOf(profileArg,profileIndex+1)===-1);
  return {fixedArgs:defaults.slice(0,profileIndex),suffixArgs:defaults.slice(profileIndex+1),
    profileRoot,profileArgPrefix:'--user-data-dir=',profileNamePrefix:'playwright_chromiumdev_profile-',
    allowedExperimentalArgs:[[...AUTOPLAY_ARGS],[...AUTOPLAY_ARGS,...NATIVE_ARGS]]};
}
export async function resolveBrowserIdentity(){
  check(python());check(!process.env.PLAYWRIGHT_LEGACY_SCREENSHOT);
  const profileRoot=realpathSync(process.env.AP06_BROWSER_TEMP_ROOT??'');
  check(profileRoot===realpathSync(tmpdir()));
  const packagePath=realpathSync(require.resolve('playwright-core/package.json'));
  const root=dirname(packagePath), pkg=JSON.parse(readFileSync(packagePath,'utf8'));
  const testPackage=realpathSync(require.resolve('@playwright/test/package.json'));
  check(pkg.version==='1.62.1'&&pkg.version===JSON.parse(readFileSync(testPackage,'utf8')).version&&process.arch==='x64');
  const registryModule=realpathSync(require.resolve('playwright-core/lib/coreBundle'));
  const {registry}=require(registryModule).registry;
  const executable=registry.findExecutable('chromium-headless-shell');
  check(executable?.name==='chromium-headless-shell'&&executable.browserName==='chromium');
  const executablePath=executable.executablePathOrDie('javascript');
  const observed=JSON.parse(execFileSync(python(),[helper,'--inspect',executablePath],{encoding:'utf8',windowsHide:true,timeout:30000}));
  check(observed.productVersion===null||observed.productVersion===executable.browserVersion);
  const files=[packagePath,registryModule,join(root,'browsers.json'),join(root,'lib/serverRegistry.js'),testPackage];
  return {browser:'chromium',mode:'headless-shell',playwrightVersion:pkg.version,...observed,chromiumVersion:executable.browserVersion,
    versionEvidence:observed.productVersion===null?'Installed registry before launch; OS-correlated CDP Browser.getVersion before workload (PE VERSIONINFO absent)':'PE ProductVersion and OS-correlated CDP Browser.getVersion',
    registryDirectory:require(registryModule).registry.registryDirectory,
    installationDirectory:realpathSync(executable.directory),revision:executable.revision,
    resolutionMethod:'Installed playwright-core coreBundle.registry.registry.findExecutable(chromium-headless-shell).executablePathOrDie',
    playwrightPackageSha256:hash(packagePath),installationFiles:Object.fromEntries(files.map(path=>[path,hash(path)])),
    launchProtocol:await launchProtocol(profileRoot,require('@playwright/test').chromium)};
}

export function validateResolution(expected,actual){
  check(expected&&actual);check(JSON.stringify(expected)===JSON.stringify(actual),'AP06_BROWSER_EXECUTABLE_CHANGED');
}

export function frozenLaunchOptions(identity,extraArgs=[]){
  if(identity?.mode!=='headless-shell'||!identity.executablePath||!/^[a-f0-9]{64}$/.test(identity.executableSha256??''))throw new Error('AP06_BROWSER_IDENTITY_MISSING');
  check(identity.launchProtocol?.allowedExperimentalArgs.some(args=>JSON.stringify(args)===JSON.stringify(extraArgs)),'AP06_BROWSER_FLAGS_MISMATCH');
  return {executablePath:identity.executablePath,headless:false,args:[...extraArgs]};
}

async function openLease(manifest){
  const child=spawn(python(),['-u',helper,'--session',manifest],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  child.stderr.resume();child.on('error',()=>{});child.stdin.on('error',()=>{});
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const receive=async()=>{
    let timer;
    try{
      const row=await Promise.race([lines.next(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('AP06_BROWSER_IDENTITY_TIMEOUT')),30000);})]);
      check(!row.done,'AP06_BROWSER_AUDIT_HELPER_FAILED');check(row.value.length<=65536,'AP06_BROWSER_OS_QUERY_FAILED');const result=JSON.parse(row.value);
      if(result.status==='STOP'){const error=new Error(allowedFailures.has(result.reason)?result.reason:'AP06_BROWSER_IDENTITY_UNPROVEN');error.response=result;throw error;}
      check(['READY','PASS'].includes(result.status),'AP06_BROWSER_IDENTITY_UNPROVEN');return result;
    }finally{clearTimeout(timer);}
  };
  const request=async value=>{child.stdin.write(JSON.stringify(value)+'\n');return receive();};
  try{await receive();return {child,request};}catch(error){await stopLease({child});throw error;}
}

function safeFailure(error,stage){
  const candidate=String(error?.message??'');
  if(allowedFailures.has(candidate))return candidate;
  return ({'playwright-launch':'AP06_BROWSER_LAUNCH_FAILED','cdp-process-query':'AP06_BROWSER_CDP_PROCESS_QUERY_FAILED',
    'cdp-version-query':'AP06_BROWSER_CDP_VERSION_QUERY_FAILED','os-attestation':'AP06_BROWSER_ATTESTATION_FAILED',
    'identity-resolution':'AP06_BROWSER_EXECUTABLE_CHANGED','read-lease':'AP06_BROWSER_ATTESTATION_FAILED'})[stage]??'AP06_BROWSER_ATTESTATION_FAILED';
}
export function getAttestedBrowserProof(browser){
  const proof=proofs.get(browser);check(proof?.status==='PASS','AP06_BROWSER_NOT_ATTESTED');return proof;
}

export async function attestBrowserProcess(browser,identity,lease,requiredArgs,launchStartedMs,record,setStage=()=>{}){
  setStage('cdp-process-query');const cdp=await browser.newBrowserCDPSession();
  const processes=(await cdp.send('SystemInfo.getProcessInfo')).processInfo;
  const pids=[...new Set(processes.map(row=>row.id).filter(Number.isSafeInteger))];record.browserIdentity.ownedPids=pids;
  const roots=processes.filter(row=>row.type==='browser');check(roots.length===1&&Number.isSafeInteger(roots[0].id),'AP06_BROWSER_PID_AMBIGUOUS');
  setStage('cdp-version-query');const version=await cdp.send('Browser.getVersion');
  setStage('os-attestation');
  const query={action:'attest',pid:roots[0].id,parentPid:process.pid,nodeExecutable:realpathSync(process.execPath),
    requiredArgs,launchStartedMs,browserVersion:version.product.split('/').at(-1)};
  const before=await lease.request(query);check(browser.version()===identity.chromiumVersion,'AP06_BROWSER_VERSION_MISMATCH');
  if(usesRetainedProcessAudit())await lease.request({action:'register-processes',processes});
  const nativeFlagsValidated=JSON.stringify(requiredArgs)===JSON.stringify([...AUTOPLAY_ARGS,...NATIVE_ARGS]);
  const proof=Object.freeze({status:'PASS',browserPid:roots[0].id,processCreationTime:before.processCreationTime,nativeFlagsValidated});proofs.set(browser,proof);
  return {cdp,pids,query,before,proof};
}

export async function launchWithIdentityLease(chromium,launch,record,expected,lease,onBrowserLaunched=()=>{},resolveIdentity=resolveBrowserIdentity){
  let stage='playwright-launch',browser,cdp,pids=[];
  try{
    const launchStartedMs=Date.now();browser=await chromium.launch(launch);
    record.browserIdentity.browserLaunchSucceeded=true;record.browserIdentity.launchSucceeded=true;onBrowserLaunched(browser);
    const attested=await attestBrowserProcess(browser,expected,lease,launch.args,launchStartedMs,record,next=>{stage=next;});
    cdp=attested.cdp;pids=attested.pids;record.browserIdentity.before=attested.before;record.browserIdentity.status='PASS';
    leases.set(browser,{...lease,query:attested.query,record,cdp,pids,proof:attested.proof,resolveIdentity});return browser;
  }catch(error){
    const failure=safeFailure(error,stage);record.browserIdentity.status='STOP';record.browserIdentity.failureStage=stage;record.browserIdentity.failureClass=failure;
    record.failureStage??=stage;record.failureClass??=failure;
    pids=record.browserIdentity.ownedPids??[];
    if(browser){
      try{await browser.close();record.browserIdentity.browserClosed=true;}
      catch{record.browserIdentity.browserClosed=false;record.browserIdentity.cleanupStatus='FAIL';record.browserIdentity.cleanupFailureClass='AP06_BROWSER_CLOSE_FAILED';}
      if(usesRetainedProcessAudit()){
        try{await auditAndReleaseLease(lease,record);}catch(cleanupError){record.browserIdentity.cleanupStatus='FAIL';record.browserIdentity.cleanupFailureClass??=safeFailure(cleanupError,'os-attestation');}
      }else if(pids.length){try{record.browserIdentity.failureCleanupAudit=auditClosed(pids);if(record.browserIdentity.browserClosed)record.browserIdentity.cleanupStatus='PASS';}
        catch{record.browserIdentity.cleanupStatus='FAIL';record.browserIdentity.cleanupFailureClass??='AP06_BROWSER_PROCESS_EXIT_AUDIT_FAILED';}}
      else if(record.browserIdentity.browserClosed)record.browserIdentity.cleanupStatus='PROCESS_IDS_UNAVAILABLE';
    }
    if(usesRetainedProcessAudit()&&!browser){
      try{
        const release=await lease.request({action:'release'});record.handleRelease=release;record.browserIdentity.handleRelease=release;
        record.browserIdentity.cleanupStatus=release.status==='PASS'?'PASS':'FAIL';
        if(release.status!=='PASS')record.browserIdentity.cleanupFailureClass='AP06_BROWSER_HANDLE_RELEASE_FAILED';
      }catch(cleanupError){record.browserIdentity.cleanupStatus='FAIL';record.browserIdentity.cleanupFailureClass??=safeFailure(cleanupError,'os-attestation');}
      if(!await stopLease(lease)){record.browserIdentity.cleanupStatus='FAIL';record.browserIdentity.cleanupFailureClass??='AP06_BROWSER_HANDLE_RELEASE_FAILED';}
    }else if(!usesRetainedProcessAudit()&&!await stopLease(lease)){
      record.browserIdentity.cleanupStatus='FAIL';record.browserIdentity.cleanupFailureClass??='AP06_BROWSER_HANDLE_RELEASE_FAILED';
    }
    throw new Error(failure);
  }
}

export async function launchAttestedBrowser(chromium,options,record,onBrowserLaunched=()=>{},resolveIdentity=resolveBrowserIdentity){
  const manifest=process.env.AP06_BROWSER_IDENTITY;
  if(!manifest){check(!/readiness-wave12-r(3|4|5|6|7)-/.test(process.env.AP06_EXPERIMENT_ROOT??''));const browser=await chromium.launch(options);onBrowserLaunched(browser);return browser;}
  let stage='identity-resolution',expected,launch,lease;
  record.browserIdentity={status:'PENDING',attemptReserved:true,readLease:false,browserLaunchSucceeded:false};
  try{
    check(python()&&options&&Object.keys(options).every(key=>key==='args'));
    expected=JSON.parse(readFileSync(manifest,'utf8'));validateResolution(expected,await resolveIdentity());
    const profileRoot=expected.launchProtocol.profileRoot;
    check(realpathSync(tmpdir())===profileRoot&&readdirSync(profileRoot).length===0,'AP06_BROWSER_PROFILE_PATH_INVALID');
    launch=frozenLaunchOptions(expected,options.args??[]);
    stage='read-lease';lease=await openLease(manifest);record.browserIdentity.readLease=true;
  }catch(error){
    const failure=safeFailure(error,stage);record.browserIdentity.status='STOP';record.browserIdentity.failureStage=stage;record.browserIdentity.failureClass=failure;
    record.failureStage??=stage;record.failureClass??=failure;
    if(lease){lease.child.stdin.end();lease.child.kill();}throw new Error(failure);
  }
  return launchWithIdentityLease(chromium,launch,record,expected,lease,onBrowserLaunched,resolveIdentity);
}

export async function finishBrowserIdentity(browser){
  const lease=leases.get(browser);if(!lease)return;
  const {record,request,query,cdp}=lease;
  try{
    const after=await request(query);
    check(after.browserPid===lease.proof.browserPid&&after.processCreationTime===lease.proof.processCreationTime&&
      after.identityBeforeWorkload===false,'AP06_BROWSER_POST_ATTESTATION_FAILED');
    record.browserIdentity.after=after;
    const processes=(await cdp.send('SystemInfo.getProcessInfo')).processInfo;
    if(usesRetainedProcessAudit())await request({action:'register-processes',processes});
    lease.pids=[...new Set([...lease.pids,...processes.map(row=>row.id)])];
    record.browserIdentity.ownedPids=lease.pids;
    validateResolution(JSON.parse(readFileSync(process.env.AP06_BROWSER_IDENTITY,'utf8')),await lease.resolveIdentity());
  }catch(error){
    const failure=safeFailure(error,'os-attestation');
    record.browserIdentity.status='STOP';record.browserIdentity.failureStage='post-workload-os-attestation';
    record.browserIdentity.postWorkloadFailureClass=failure;
    record.failureStage??='post-workload-os-attestation';record.failureClass??='AP06_BROWSER_POST_ATTESTATION_FAILED';
    throw new Error('AP06_BROWSER_POST_ATTESTATION_FAILED');
  }
}

async function auditAndReleaseLease(lease,record){
  const browser=record.browserIdentity;let failure;
  if(usesRetainedProcessAudit()){
    try{
      const {receipt}=await lease.request({action:'audit-closed'});
      record.processExitAudit=receipt;browser.processExitAudit=receipt;
      browser.closed={closedHashVerified:receipt?.closedHashVerified===true};
      if(receipt?.status!=='PASS')throw new Error(receipt?.closedHashVerified===false?'AP06_BROWSER_EXECUTABLE_CHANGED':'AP06_BROWSER_PROCESS_EXIT_AUDIT_FAILED');
    }catch(error){
      const receipt=error?.response?.receipt;
      if(receipt){record.processExitAudit=receipt;browser.processExitAudit=receipt;browser.closed={closedHashVerified:receipt.closedHashVerified===true};}
      failure=safeFailure(error,'os-attestation');
    }
    try{
      const result=await lease.request({action:'release'});
      record.handleRelease=result;browser.handleRelease=result;
      if(result.status!=='PASS')failure??='AP06_BROWSER_HANDLE_RELEASE_FAILED';
    }catch(error){
      if(error.response){record.handleRelease=error.response;browser.handleRelease=error.response;}
      failure??=safeFailure(error,'os-attestation');
    }
  }else{
    try{
      browser.closed=await lease.request({action:'closed'});
      record.processExitAudit=auditClosed(lease.pids);browser.processExitAudit=record.processExitAudit;
    }catch(error){failure=safeFailure(error,'os-attestation');}
  }
  if(!await stopLease(lease))failure??='AP06_BROWSER_HANDLE_RELEASE_FAILED';
  browser.auditHelperExitCode=lease.child.exitCode;
  if(browser.auditHelperExitCode!==0&&!failure&&!record.failureClass&&!browser.failureClass)
    failure='AP06_BROWSER_AUDIT_HELPER_FAILED';
  browser.cleanupStatus=failure?'FAIL':'PASS';
  if(failure)browser.cleanupFailureClass??=failure;
  return {status:browser.cleanupStatus,failureClass:browser.cleanupFailureClass,processExitAudit:record.processExitAudit};
}

export async function registerBrowserProcesses(browser,processes){
  const lease=leases.get(browser);if(!lease||!usesRetainedProcessAudit())return;
  check(Array.isArray(processes),'AP06_BROWSER_CDP_PROCESS_QUERY_FAILED');
  try{await lease.request({action:'register-processes',processes});}
  catch(error){throw new Error(allowedFailures.has(error?.message)?error.message:'AP06_BROWSER_PROCESS_REGISTRATION_FAILED');}
  lease.pids=[...new Set([...lease.pids,...processes.map(row=>row.id).filter(Number.isSafeInteger)])];
  lease.record.browserIdentity.ownedPids=lease.pids;
}

export async function closeBrowserIdentity(browser){
  const lease=leases.get(browser);if(!lease)return {status:'PASS'};
  try{
    const result=await auditAndReleaseLease(lease,lease.record);
    if(result.status!=='PASS')throw new Error(result.failureClass??'AP06_BROWSER_PROCESS_EXIT_AUDIT_FAILED');
    return result;
  }finally{leases.delete(browser);proofs.delete(browser);}
}

export async function closeBrowserWithIdentity(browser,record){
  let cleanupFailure;
  try{await finishBrowserIdentity(browser);}catch(error){
    record.failureClass??=safeFailure(error,'os-attestation');
    record.failureStage??='post-workload-os-attestation';
  }
  try{await browser.close();record.browserClosed=true;}catch{record.browserClosed=false;cleanupFailure='AP06_BROWSER_CLOSE_FAILED';}
  try{await closeBrowserIdentity(browser);}catch(error){cleanupFailure??=safeFailure(error,'os-attestation');}
  if(!record.browserIdentity)record.browserIdentity={};
  record.cleanupStatus=cleanupFailure?'FAIL':'PASS';
  if(cleanupFailure)record.cleanupFailureClass??=cleanupFailure;
  record.browserIdentity.cleanupStatus=record.cleanupStatus;
  if(record.cleanupFailureClass)record.browserIdentity.cleanupFailureClass??=record.cleanupFailureClass;
  return {status:record.cleanupStatus,failureClass:record.cleanupFailureClass,processExitAudit:record.processExitAudit,
    handleRelease:record.handleRelease};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  check(process.argv[2]==='--resolve');console.log(JSON.stringify(await resolveBrowserIdentity()));
}
