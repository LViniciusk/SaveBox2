import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

export const AUTOPLAY_ARGS=['--autoplay-policy=no-user-gesture-required'];
const require=createRequire(import.meta.url), leases=new WeakMap();
const python=()=>process.env.AP06_IDENTITY_PYTHON||process.env.WAVE1_PYTHON;
const helper=fileURLToPath(new URL('../../tools/quality/ap06_browser_identity.py',import.meta.url));
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const check=value=>{if(!value)throw new Error('AP06_BROWSER_IDENTITY_UNPROVEN');};
function auditClosed(pids){
  check(process.env.AP06_R8_PID_AUDITOR&&pids.length);
  const result=JSON.parse(execFileSync(python(),[process.env.AP06_R8_PID_AUDITOR,'--closed-pids',pids.join(',')],{encoding:'utf8',windowsHide:true,timeout:30000}));
  check(result.status==='PASS');return result;
}

export function resolveBrowserIdentity(){
  check(python());
  const packagePath=realpathSync(require.resolve('playwright-core/package.json'));
  const root=dirname(packagePath), pkg=JSON.parse(readFileSync(packagePath,'utf8'));
  const testPackage=realpathSync(require.resolve('@playwright/test/package.json'));
  check(pkg.version===JSON.parse(readFileSync(testPackage,'utf8')).version&&process.arch==='x64');
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
    playwrightPackageSha256:hash(packagePath),installationFiles:Object.fromEntries(files.map(path=>[path,hash(path)]))};
}

export function validateResolution(expected,actual){
  check(expected&&actual);
  check(JSON.stringify(expected)===JSON.stringify(actual));
}

export function frozenLaunchOptions(identity,extraArgs=[]){
  if(identity?.mode!=='headless-shell'||!identity.executablePath||!/^[a-f0-9]{64}$/.test(identity.executableSha256??''))throw new Error('AP06_BROWSER_IDENTITY_MISSING');
  return {executablePath:identity.executablePath,headless:true,args:[...AUTOPLAY_ARGS,...extraArgs]};
}

async function openLease(manifest){
  const child=spawn(python(),['-u',helper,'--session',manifest],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  child.stderr.resume();child.on('error',()=>{});
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const receive=async()=>{
    let timer;
    try{
      const row=await Promise.race([lines.next(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('AP06_BROWSER_IDENTITY_TIMEOUT')),30000);})]);
      check(!row.done&&row.value.length<=65536);const result=JSON.parse(row.value);check(['READY','PASS'].includes(result.status));return result;
    }finally{clearTimeout(timer);}
  };
  const request=async value=>{child.stdin.write(JSON.stringify(value)+'\n');return receive();};
  try{await receive();return {child,request};}catch(error){child.stdin.end();child.kill();throw error;}
}

export async function launchAttestedBrowser(chromium,options,record){
  const manifest=process.env.AP06_BROWSER_IDENTITY;
  if(!manifest){check(!/readiness-wave12-r3-/.test(process.env.AP06_EXPERIMENT_ROOT??''));return chromium.launch(options);}
  check(python()&&options&&Object.keys(options).every(key=>key==='args'));
  const expected=JSON.parse(readFileSync(manifest,'utf8'));validateResolution(expected,resolveBrowserIdentity());
  const extra=(options.args??[]).filter(arg=>!AUTOPLAY_ARGS.includes(arg));
  const launch=frozenLaunchOptions(expected,extra), lease=await openLease(manifest);
  record.browserIdentity={status:'PENDING',readLease:true,expectedSha256:expected.executableSha256};
  const started=Date.now();let browser,pids=[];
  try{
    browser=await chromium.launch(launch);record.browserIdentity.launchSucceeded=true;
    const cdp=await browser.newBrowserCDPSession();
    const processes=(await cdp.send('SystemInfo.getProcessInfo')).processInfo;pids=processes.map(row=>row.id);
    const info=processes.filter(row=>row.type==='browser');
    check(info.length===1&&Number.isSafeInteger(info[0].id));
    const {arguments:cdpArgs}=await cdp.send('Browser.getBrowserCommandLine');
    const version=await cdp.send('Browser.getVersion');
    const query={action:'attest',pid:info[0].id,parentPid:process.pid,cdpArgs,requiredArgs:launch.args,launchStartedMs:started,browserVersion:version.product.split('/').at(-1)};
    record.browserIdentity.before=await lease.request(query);
    check(browser.version()===expected.chromiumVersion);record.browserIdentity.status='PASS';
    leases.set(browser,{...lease,query,record,cdp,pids});return browser;
  }catch(error){
    record.browserIdentity.status='STOP';
    try{if(browser){await browser.close();record.browserIdentity.failureCleanupAudit=auditClosed(pids);}}
    finally{lease.child.stdin.end();lease.child.kill();}
    throw error;
  }
}

export async function finishBrowserIdentity(browser){
  const lease=leases.get(browser);if(!lease)return;
  const {record,request,query}=lease;
  try{
    record.browserIdentity.after=await request(query);
    lease.pids=[...new Set([...lease.pids,...(await lease.cdp.send('SystemInfo.getProcessInfo')).processInfo.map(row=>row.id)])];
    validateResolution(JSON.parse(readFileSync(process.env.AP06_BROWSER_IDENTITY,'utf8')),resolveBrowserIdentity());
  }catch(error){record.browserIdentity.status='STOP';throw error;}
}

export async function closeBrowserIdentity(browser){
  const lease=leases.get(browser);if(!lease)return;
  try{lease.record.browserIdentity.closed=await lease.request({action:'closed'});lease.record.browserIdentity.processExitAudit=auditClosed(lease.pids);}
  catch(error){lease.record.browserIdentity.status='STOP';throw error;}
  finally{lease.child.stdin.end();leases.delete(browser);}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  check(process.argv[2]==='--resolve');console.log(JSON.stringify(resolveBrowserIdentity()));
}
