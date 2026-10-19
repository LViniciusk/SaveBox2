import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolveBrowserIdentity,validateResolution,frozenLaunchOptions,AUTOPLAY_ARGS,NATIVE_ARGS} from './ap06-browser-identity.mjs';

const failures=new Set(['AP06_BROWSER_IDENTITY_MISSING','AP06_BROWSER_IDENTITY_MISMATCH','AP06_BROWSER_IDENTITY_RESOLUTION_FAILED',
  'AP06_BROWSER_EXECUTABLE_CHANGED','AP06_BROWSER_PLAYWRIGHT_CHANGED','AP06_BROWSER_FLAGS_MISMATCH',
  'AP06_BROWSER_PROFILE_PATH_INVALID','AP06_BROWSER_WINDOWS_REQUIRED','AP06_BROWSER_EXECUTABLE_MISSING',
  'AP06_BROWSER_REPARSE_REJECTED','AP06_BROWSER_PATH_CHANGED','AP06_BROWSER_PE_INVALID',
  'AP06_BROWSER_ARCHITECTURE_MISMATCH']);

async function main(){
  let status='STOP',failureClass='AP06_BROWSER_IDENTITY_RESOLUTION_FAILED',changedFields=[];
  const manifest=process.env.AP06_BROWSER_IDENTITY;
  try{
    if(!manifest||!/^[0-9a-f]{40}$/i.test(process.env.AP06_R12R10_HEAD??''))throw new Error('AP06_BROWSER_IDENTITY_MISSING');
    const bytes=readFileSync(manifest),expected=JSON.parse(bytes.toString('utf8'));
    const actual=await resolveBrowserIdentity();
    validateResolution(expected,actual);
    frozenLaunchOptions(expected,AUTOPLAY_ARGS);
    frozenLaunchOptions(expected,[...AUTOPLAY_ARGS,...NATIVE_ARGS]);
    const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
    if(head!==process.env.AP06_R12R10_HEAD)throw new Error('AP06_BROWSER_IDENTITY_MISMATCH');
    status='PASS';failureClass=undefined;
    process.stdout.write(JSON.stringify({status,head,manifestSha256:createHash('sha256').update(bytes).digest('hex'),
      playwrightVersion:actual.playwrightVersion,chromiumVersion:actual.chromiumVersion,
      scientificChromium:0,reservationCreated:false,launchAttempts:0,retries:0})+'\n');
    return 0;
  }catch(error){
    failureClass=failures.has(error?.message)?error.message:'AP06_BROWSER_IDENTITY_RESOLUTION_FAILED';
    if(Array.isArray(error?.changedFields))changedFields=error.changedFields.filter(field=>
      /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)?$/.test(field));
    process.stdout.write(JSON.stringify({status,failureClass,...(changedFields.length?{changedFields}:{}),
      scientificChromium:0,reservationCreated:false,launchAttempts:0,retries:0})+'\n');
    return 1;
  }
}

process.exitCode=await main();
