import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import {
  executeFixture,
  parseArgs,
  runCampaign,
  runDuplicateControl,
  runIteration,
} from './e2e-fixture-characterization.mjs';

const environment = {
  executable: process.execPath,
  cwd: process.cwd(),
  storagePath: process.cwd(),
  storageId: 'a'.repeat(64),
};

function fakeSpawn({ stdout = '', stderr = '', exitCode = 0, spawnError, hang = false, killNoClose = false } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      if (!killNoClose) setImmediate(() => child.emit('close', null, 'SIGTERM'));
      return true;
    };
    queueMicrotask(() => {
      if (spawnError) {
        child.emit('error', new Error('SPAWN_SECRET_SENTINEL'));
        setImmediate(() => child.emit('close', null, null));
        return;
      }
      child.emit('spawn');
      if (hang) return;
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      setImmediate(() => child.emit('close', exitCode, null));
    });
    return child;
  };
}

function success(command) {
  return {
    result: 'PASS', childStarted: true, exitCode: 0, classification: null,
    fixtureSafeCode: null, responseValid: true,
    removedFileCount: command === 'cleanup' ? 0 : null,
  };
}

function fixtureFailure(code) {
  return {
    result: 'FAIL', childStarted: true, exitCode: 1,
    failedStage: 'fixture_exit', classification: 'FIXTURE_REPORTED_FAILURE',
    fixtureSafeCode: code, responseValid: false,
  };
}

test('argument default is one iteration and the requested campaign is bounded', () => {
  assert.equal(parseArgs([]).iterations, 1);
  assert.equal(parseArgs(['--iterations', '10']).iterations, 10);
  assert.throws(() => parseArgs(['--iterations', '0']));
});

test('spawn failure is a harness stage and never a fixture code', async () => {
  const result = await executeFixture({
    command: 'provision', payload: {}, environment, spawnImpl: fakeSpawn({ spawnError: true }),
  });
  assert.equal(result.failedStage, 'fixture_provision_spawn');
  assert.equal(result.classification, 'HARNESS_FIXTURE_START_FAILED');
  assert.equal(result.childStarted, false);
  assert.equal(result.fixtureSafeCode, null);
});

test('known native failure retains only its allowlisted fixture code', async () => {
  const result = await executeFixture({
    command: 'provision', payload: {}, environment,
    spawnImpl: fakeSpawn({ stderr: 'FIXTURE_DB_OPERATION_FAILED\n', exitCode: 1 }),
  });
  assert.equal(result.failedStage, 'fixture_provision_exit');
  assert.equal(result.classification, 'FIXTURE_REPORTED_FAILURE');
  assert.equal(result.fixtureSafeCode, 'FIXTURE_DB_OPERATION_FAILED');
});

test('unknown stderr is unclassified and never enters the result', async () => {
  const result = await executeFixture({
    command: 'provision', payload: {}, environment,
    spawnImpl: fakeSpawn({ stderr: 'pqxx PASSWORD=SUPER_SECRET_SENTINEL', exitCode: 1 }),
  });
  assert.equal(result.classification, 'HARNESS_FIXTURE_EXIT_UNCLASSIFIED');
  assert.equal(result.fixtureSafeCode, null);
  assert.equal(JSON.stringify(result).includes('SUPER_SECRET_SENTINEL'), false);
});

test('invalid success JSON and invalid user_id fail at the protocol stage', async () => {
  for (const stdout of ['garbage', '{"ok":true,"user_id":0}']) {
    const result = await executeFixture({
      command: 'provision', payload: {}, environment, spawnImpl: fakeSpawn({ stdout }),
    });
    assert.equal(result.failedStage, 'fixture_provision_protocol');
    assert.equal(result.classification, 'HARNESS_FIXTURE_PROTOCOL_INVALID');
    assert.equal(result.fixtureSafeCode, null);
  }
  const invalidCleanup = await executeFixture({
    command: 'cleanup', payload: {}, environment,
    spawnImpl: fakeSpawn({ stdout: '{"ok":true,"removed_file_ids":[0]}' }),
  });
  assert.equal(invalidCleanup.failedStage, 'fixture_cleanup_protocol');
  assert.equal(invalidCleanup.classification, 'HARNESS_FIXTURE_PROTOCOL_INVALID');
});

test('stdout and stderr overflow have distinct safe classifications', async () => {
  const stdout = await executeFixture({
    command: 'provision', payload: {}, environment,
    spawnImpl: fakeSpawn({ stdout: 'x'.repeat(16 * 1024 + 1) }),
  });
  const stderr = await executeFixture({
    command: 'provision', payload: {}, environment,
    spawnImpl: fakeSpawn({ stderr: 'x'.repeat(1025), exitCode: 1 }),
  });
  assert.equal(stdout.classification, 'HARNESS_FIXTURE_STDOUT_OVERSIZED');
  assert.equal(stderr.classification, 'HARNESS_FIXTURE_STDERR_OVERSIZED');
  assert.equal(stdout.fixtureSafeCode, null);
  assert.equal(stderr.fixtureSafeCode, null);
});

test('deadline classifies a timed-out child without a retry', async () => {
  const result = await executeFixture({
    command: 'provision', payload: {}, environment, timeoutMs: 5,
    spawnImpl: fakeSpawn({ hang: true, killNoClose: true }),
  });
  assert.equal(result.classification, 'HARNESS_FIXTURE_TIMEOUT');
  assert.equal(result.fixtureSafeCode, null);
});

test('successful provision and cleanup complete exactly once without a DB probe', async () => {
  const commands = [];
  let provisionPayload;
  const result = await runIteration(1, environment, async ({ command, payload }) => {
    commands.push(command);
    if (command === 'provision') provisionPayload = payload;
    return success(command);
  });
  assert.equal(result.result, 'PASS');
  assert.equal(result.lastCompletedStage, 'fixture_cleanup_complete');
  assert.deepEqual(commands, ['provision', 'cleanup']);
  assert.equal(result.events.some(event => event.stage.includes('database')), false);
  assert.ok(result.events.length <= 32);
  const serialized = JSON.stringify(result);
  for (const secret of Object.values(provisionPayload)) assert.equal(serialized.includes(secret), false);
});

test('cleanup failure preserves provision completion and attempts cleanup once', async () => {
  const commands = [];
  const result = await runIteration(1, environment, async ({ command }) => {
    commands.push(command);
    return command === 'provision' ? success(command) : fixtureFailure('FIXTURE_CLEANUP_FAILED');
  });
  assert.equal(result.failedStage, 'fixture_cleanup_exit');
  assert.equal(result.lastCompletedStage, 'fixture_provision_complete');
  assert.equal(result.fixtureSafeCode, 'FIXTURE_CLEANUP_FAILED');
  assert.deepEqual(commands, ['provision', 'cleanup']);
  assert.equal(result.cleanup.attempted, true);
});

test('cleanup protocol failure stays distinct from native cleanup failure', async () => {
  const result = await runIteration(1, environment, async ({ command }) =>
    command === 'provision' ? success(command) : {
      result: 'FAIL', childStarted: true, exitCode: 0,
      failedStage: 'fixture_cleanup_protocol',
      classification: 'HARNESS_FIXTURE_PROTOCOL_INVALID', fixtureSafeCode: null,
      responseValid: false,
    },
  );
  assert.equal(result.failedStage, 'fixture_cleanup_protocol');
  assert.equal(result.classification, 'HARNESS_FIXTURE_PROTOCOL_INVALID');
  assert.equal(result.fixtureSafeCode, null);
});

test('internal driver exception never fabricates FIXTURE_INTERNAL_ERROR and safety-cleans once', async () => {
  const commands = [];
  const result = await runIteration(1, environment, async ({ command }) => {
    commands.push(command);
    if (command === 'provision') throw new Error('FIXTURE_INTERNAL_ERROR SECRET_SENTINEL');
    return success(command);
  });
  assert.equal(result.classification, 'HARNESS_INTERNAL_ERROR');
  assert.equal(result.fixtureSafeCode, null);
  assert.equal(result.bestEffortSafetyCleanup, true);
  assert.deepEqual(commands, ['provision', 'cleanup']);
  assert.equal(JSON.stringify(result).includes('SECRET_SENTINEL'), false);
  assert.equal(result.events.some(event => event.classification === 'FIXTURE_INTERNAL_ERROR'), false);
});

test('ambiguous provision failure preserves primary outcome and records cleanup outcome', async () => {
  let cleanupCalls = 0;
  const result = await runIteration(1, environment, async ({ command }) => {
    if (command === 'provision') return fixtureFailure('FIXTURE_DB_OPERATION_FAILED');
    cleanupCalls++;
    return success(command);
  });
  assert.equal(result.failedStage, 'fixture_provision_exit');
  assert.equal(result.fixtureSafeCode, 'FIXTURE_DB_OPERATION_FAILED');
  assert.equal(result.cleanup.attempted, true);
  assert.equal(result.cleanup.result, 'PASS');
  assert.equal(result.bestEffortSafetyCleanup, true);
  assert.equal(cleanupCalls, 1);
});

test('campaign stops after first failure and never retries or starts iteration two', async () => {
  let calls = 0;
  const result = await runCampaign({
    iterations: 10, environment,
    execute: async ({ command }) => {
      calls++;
      return command === 'provision' ? fixtureFailure('FIXTURE_DB_OPERATION_FAILED') : success(command);
    },
  });
  assert.equal(result.startedIterations, 1);
  assert.equal(result.completedIterations, 1);
  assert.equal(result.failedIterations, 1);
  assert.equal(result.retries, 0);
  assert.equal(result.stoppedEarly, true);
  assert.equal(calls, 2); // one provision plus its one safety cleanup
});

test('duplicate-user control requires the native duplicate code and one cleanup', async () => {
  const commands = [];
  const result = await runDuplicateControl(environment, async ({ command }) => {
    commands.push(command);
    if (command === 'provision') {
      const count = commands.filter(value => value === 'provision').length;
      return count === 1 ? success(command) : fixtureFailure('FIXTURE_USER_ALREADY_EXISTS');
    }
    return success(command);
  });
  assert.equal(result.result, 'PASS');
  assert.equal(result.fixtureSafeCode, 'FIXTURE_USER_ALREADY_EXISTS');
  assert.deepEqual(commands, ['provision', 'provision', 'cleanup']);
});
