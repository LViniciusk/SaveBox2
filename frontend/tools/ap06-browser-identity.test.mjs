import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {frozenLaunchOptions, validateResolution, AUTOPLAY_ARGS,launchAttestedBrowser} from './ap06-browser-identity.mjs';

const identity={mode:'headless-shell',executablePath:'C:/owned/chrome-headless-shell.exe',executableSha256:'a'.repeat(64)};
test('explicit headless shell and unchanged autoplay args; missing identity rejects',()=>{
  assert.deepEqual(frozenLaunchOptions(identity,['--memlog=all']),{executablePath:identity.executablePath,headless:true,args:[...AUTOPLAY_ARGS,'--memlog=all']});
  for(const bad of [null,{}, {...identity,mode:'chromium'}, {...identity,executableSha256:'bad'}])assert.throws(()=>frozenLaunchOptions(bad));
});
test('installation, version and executable substitution reject before launch',()=>{
  const expected={...identity,playwrightVersion:'1.62.1',registryDirectory:'C:/cache',installationDirectory:'C:/cache/shell',playwrightPackageSha256:'b'.repeat(64)};
  validateResolution(expected,expected);
  for(const key of Object.keys(expected))assert.throws(()=>validateResolution(expected,{...expected,[key]:'changed'}));
});
test('all R3 paths enter one shared gate; legacy callers retain explicit launch options',()=>{
  for(const name of ['ap06-transmux-probe.mjs','ap06-r12-preflight.mjs','ap06-native-capability.mjs']){
    const code=readFileSync(new URL(name,import.meta.url),'utf8');
    assert.match(code,/launchAttestedBrowser\(chromium/); assert.doesNotMatch(code,/chromium\.launch\(/);
    assert.match(code,/finishBrowserIdentity/);
  }
});
test('R3 cannot launch or start a Range without a validated manifest',async()=>{
  const old=process.env.AP06_EXPERIMENT_ROOT,manifest=process.env.AP06_BROWSER_IDENTITY;
  process.env.AP06_EXPERIMENT_ROOT='.quality/readiness-wave12-r3-factorial';delete process.env.AP06_BROWSER_IDENTITY;
  let launched=false;
  try{await assert.rejects(launchAttestedBrowser({launch:()=>{launched=true;}},{args:AUTOPLAY_ARGS},{}));assert.equal(launched,false);}
  finally{if(old===undefined)delete process.env.AP06_EXPERIMENT_ROOT;else process.env.AP06_EXPERIMENT_ROOT=old;if(manifest!==undefined)process.env.AP06_BROWSER_IDENTITY=manifest;}
  const probe=readFileSync(new URL('ap06-transmux-probe.mjs',import.meta.url),'utf8');
  assert.ok(probe.indexOf('await launchAttestedBrowser')<probe.indexOf('await page.goto(origin)'));
  const preflight=readFileSync(new URL('ap06-r12-preflight.mjs',import.meta.url),'utf8');
  assert.ok(preflight.indexOf('await launchAttestedBrowser')<preflight.indexOf('await page.goto(origin)'));
});
