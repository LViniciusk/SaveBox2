import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { classifyStages, confirmFormal } from './ap06-r11-contract.mjs';

const run = input => spawnSync(process.execPath, ['tools/ap06-r11-classifier.mjs'], { input, cwd: new URL('../',import.meta.url), encoding: 'utf8', timeout: 5000 });
test('stdin bridge returns the exact original decisions for triage and formal', () => {
  for (const [x,y] of [[400,420],[50,400],[50,60],[180,400]]) {
    const values={'r11.0':30,'r11.1':450,'r11.2':x,'r11.3':y};
    const candidate=classifyStages(values), triage=run(JSON.stringify({mode:'triage',values}));
    assert.equal(triage.status,0);assert.deepEqual(JSON.parse(triage.stdout),candidate);
    if(candidate.status!=='R11_CANDIDATE')continue;
    const [a,b]=candidate.pair,formal=[a,b,b,a,a,b].map(condition=>({condition,rendererPrivateDeltaMiB:condition===a?50:400}));
    const result=run(JSON.stringify({mode:'formal',candidate,control:450,formal}));
    assert.equal(result.status,0);assert.deepEqual(JSON.parse(result.stdout),confirmFormal(candidate,450,formal));
    formal[0].condition=b;
    assert.deepEqual(JSON.parse(run(JSON.stringify({mode:'formal',candidate,control:450,formal})).stdout),confirmFormal(candidate,450,formal));
  }
});
test('input overflow, malformed JSON, empty input and unknown modes expose no input', () => {
  for(const input of ['', 'private-secret', '{"mode":"private-secret"}', 'private-secret'.repeat(1000)]) {
    const result=run(input);assert.equal(result.status,1);assert.equal(result.stdout,'');
    assert.equal(result.stderr,'R11_CLASSIFIER_BRIDGE_FAILED\n');
  }
});
