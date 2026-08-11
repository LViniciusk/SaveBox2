import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { fixtureFailureCode, parseFixtureResponse } from './e2e-fixture-diagnostics.mjs';

const MAX_STDOUT_CHARS = 16 * 1024;
const MAX_STDERR_CHARS = 1024;
const FIXTURE_TIMEOUT_MS = 15_000;
const MAX_ITERATIONS = 10;
const HARNESS_CLASSES = new Set([
  'HARNESS_ENV_INVALID',
  'HARNESS_FIXTURE_START_FAILED',
  'HARNESS_FIXTURE_TIMEOUT',
  'HARNESS_FIXTURE_STDOUT_OVERSIZED',
  'HARNESS_FIXTURE_STDERR_OVERSIZED',
  'HARNESS_FIXTURE_EXIT_FAILED',
  'HARNESS_FIXTURE_EXIT_UNCLASSIFIED',
  'HARNESS_FIXTURE_PROTOCOL_INVALID',
  'HARNESS_CLEANUP_FAILED',
  'HARNESS_INTERNAL_ERROR',
]);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUTPUT = resolve(REPOSITORY_ROOT, '.quality/b90-r1m6-direct-fixture/direct-characterization/result.json');

export function parseArgs(argv) {
  const parsed = { iterations: 1, output: DEFAULT_OUTPUT, control: 'campaign' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--iterations') {
      const value = argv[++index];
      if (!/^\d+$/.test(value ?? '') || Number(value) < 1 || Number(value) > MAX_ITERATIONS) {
        throw new Error('Invalid iteration count.');
      }
      parsed.iterations = Number(value);
    } else if (argument === '--output') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('Invalid output path.');
      parsed.output = resolve(value);
    } else if (argument === '--control') {
      const value = argv[++index];
      if (value !== 'duplicate') throw new Error('Invalid control.');
      parsed.control = value;
    } else {
      throw new Error('Invalid arguments.');
    }
  }
  return parsed;
}

export async function validateEnvironment(environment) {
  if (!environment || !isAbsolute(environment.executable ?? '') ||
      !isAbsolute(environment.cwd ?? '') || !isAbsolute(environment.storagePath ?? '') ||
      !/^[0-9a-f]{64}$/.test(environment.storageId ?? '')) {
    return { ok: false, classification: 'HARNESS_ENV_INVALID' };
  }
  try {
    const executable = await lstat(environment.executable);
    const cwd = await lstat(environment.cwd);
    if (!executable.isFile() || !cwd.isDirectory() || cwd.isSymbolicLink()) {
      return { ok: false, classification: 'HARNESS_ENV_INVALID' };
    }
  } catch {
    return { ok: false, classification: 'HARNESS_ENV_INVALID' };
  }
  return { ok: true };
}

function failure(failedStage, classification, extras = {}) {
  return {
    result: 'FAIL',
    childStarted: false,
    exitCode: null,
    failedStage,
    classification,
    fixtureSafeCode: null,
    responseValid: false,
    ...extras,
  };
}

export async function executeFixture({
  command,
  payload,
  environment,
  spawnImpl = spawn,
  timeoutMs = FIXTURE_TIMEOUT_MS,
}) {
  if (command !== 'provision' && command !== 'cleanup') {
    return failure('environment_validation', 'HARNESS_INTERNAL_ERROR');
  }
  const validation = await validateEnvironment(environment);
  if (!validation.ok) return failure('environment_validation', validation.classification);

  const prefix = `fixture_${command}`;
  const startedAt = performance.now();
  return new Promise(resolvePromise => {
    let child;
    let childStarted = false;
    let settled = false;
    let timedOut = false;
    let inputFailed = false;
    let oversized = null;
    let stdout = '';
    let stderr = '';
    let timer;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ ...value, durationMs: Math.max(0, Math.round(performance.now() - startedAt)) });
    };
    try {
      child = spawnImpl(environment.executable, [command], {
        cwd: environment.cwd,
        env: {
          ...process.env,
          NANIKA_E2E_FIXTURE: '1',
          NANIKA_E2E_STORAGE_PATH: environment.storagePath,
          NANIKA_E2E_STORAGE_ID: environment.storageId,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      finish(failure(`${prefix}_spawn`, 'HARNESS_FIXTURE_START_FAILED'));
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* Best-effort child termination. */ }
      finish(failure(`${prefix}_${oversized ? 'protocol' : 'exit'}`, oversized ?? 'HARNESS_FIXTURE_TIMEOUT', { childStarted }));
    }, timeoutMs);
    child.on('spawn', () => { childStarted = true; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      const text = String(chunk);
      if (stdout.length + text.length > MAX_STDOUT_CHARS) {
        oversized = 'HARNESS_FIXTURE_STDOUT_OVERSIZED';
        try { child.kill(); } catch { /* Best-effort child termination. */ }
      } else if (!oversized) {
        stdout += text;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      const text = String(chunk);
      if (stderr.length + text.length > MAX_STDERR_CHARS) {
        oversized = 'HARNESS_FIXTURE_STDERR_OVERSIZED';
        try { child.kill(); } catch { /* Best-effort child termination. */ }
      } else if (!oversized) {
        stderr += text;
      }
    });
    child.stdout.on('error', () => {
      try { child.kill(); } catch { /* Best-effort child termination. */ }
      finish(failure(`${prefix}_protocol`, 'HARNESS_INTERNAL_ERROR', { childStarted }));
    });
    child.stderr.on('error', () => {
      try { child.kill(); } catch { /* Best-effort child termination. */ }
      finish(failure(`${prefix}_exit`, 'HARNESS_INTERNAL_ERROR', { childStarted }));
    });
    child.stdin.on('error', () => { inputFailed = true; });
    child.on('error', () => {
      if (!childStarted) finish(failure(`${prefix}_spawn`, 'HARNESS_FIXTURE_START_FAILED'));
    });
    child.on('close', (exitCode) => {
      if (timedOut) {
        finish(failure(`${prefix}_${oversized ? 'protocol' : 'exit'}`, oversized ?? 'HARNESS_FIXTURE_TIMEOUT', { childStarted, exitCode }));
        return;
      }
      if (inputFailed) {
        finish(failure(`${prefix}_spawn`, 'HARNESS_INTERNAL_ERROR', { childStarted, exitCode }));
        return;
      }
      if (oversized) {
        finish(failure(`${prefix}_protocol`, oversized, { childStarted, exitCode }));
        return;
      }
      if (exitCode !== 0) {
        const safeCode = fixtureFailureCode(stderr) ?? null;
        finish({
          result: 'FAIL', childStarted, exitCode, failedStage: `${prefix}_exit`,
          classification: safeCode ? 'FIXTURE_REPORTED_FAILURE' : 'HARNESS_FIXTURE_EXIT_UNCLASSIFIED',
          fixtureSafeCode: safeCode, responseValid: false,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        });
        return;
      }
      try {
        const removedFileIds = parseFixtureResponse(command, stdout);
        finish({
          result: 'PASS', childStarted, exitCode, classification: null,
          fixtureSafeCode: null, responseValid: true,
          ...(command === 'cleanup' ? { removedFileCount: removedFileIds.length } : {}),
        });
      } catch {
        finish(failure(`${prefix}_protocol`, 'HARNESS_FIXTURE_PROTOCOL_INVALID', {
          childStarted, exitCode,
        }));
      }
    });
    try {
      child.stdin.end(JSON.stringify(payload));
    } catch {
      try { child.kill(); } catch { /* Best-effort child termination. */ }
      finish(failure(`${prefix}_spawn`, 'HARNESS_INTERNAL_ERROR', { childStarted }));
    }
  });
}

function makeIdentity() {
  const id = randomBytes(12).toString('hex');
  return {
    username: `nanika_e2e_m6_${id}`,
    email: `nanika_e2e_m6_${id}@example.test`,
    password: `Password-${randomBytes(18).toString('base64url')}`,
  };
}

function safeClassification(outcome, fallback) {
  if (outcome?.classification === 'FIXTURE_REPORTED_FAILURE' &&
      typeof outcome.fixtureSafeCode === 'string' && /^FIXTURE_[A-Z0-9_]+$/.test(outcome.fixtureSafeCode)) {
    return { classification: 'FIXTURE_REPORTED_FAILURE', fixtureSafeCode: outcome.fixtureSafeCode };
  }
  if (HARNESS_CLASSES.has(outcome?.classification)) {
    return { classification: outcome.classification, fixtureSafeCode: null };
  }
  return { classification: fallback, fixtureSafeCode: null };
}

export async function runIteration(index, environment, execute = executeFixture) {
  const startedAt = performance.now();
  const events = [];
  let lastCompletedStage = null;
  let primary = null;
  let primaryOutcome = null;
  const cleanup = { attempted: false, childStarted: false, result: 'NOT_ATTEMPTED', completed: false };

  const record = (stage, result, details = {}) => {
    if (events.length >= 32) return;
    events.push({
      stage, result, atMs: Math.max(0, Math.round(performance.now() - startedAt)),
      ...details,
    });
  };

  const validation = await validateEnvironment(environment);
  if (!validation.ok) {
    record('environment_validation', 'FAIL', { classification: validation.classification });
    return {
      iteration: index, result: 'FAIL', durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      failedStage: 'environment_validation', classification: validation.classification,
      fixtureSafeCode: null, childStarted: false, exitCode: null, responseValid: false,
      lastCompletedStage: null, cleanup, bestEffortSafetyCleanup: false, events,
    };
  }
  record('environment_validation', 'PASS');
  const identity = makeIdentity();

  const invoke = async command => {
    const prefix = `fixture_${command}`;
    record(`${prefix}_spawn`, 'STARTED');
    let outcome;
    try {
      outcome = await execute({
        command,
        payload: command === 'provision'
          ? { username: identity.username, email: identity.email, password: identity.password }
          : { username: identity.username },
        environment,
      });
    } catch {
      record(`${prefix}_spawn`, 'FAIL', { classification: 'HARNESS_INTERNAL_ERROR' });
      return {
        result: 'FAIL', childStarted: null, exitCode: null,
        failedStage: `${prefix}_runner`, classification: 'HARNESS_INTERNAL_ERROR',
        fixtureSafeCode: null, responseValid: false,
      };
    }

    const started = outcome?.childStarted === true;
    record(`${prefix}_spawn`, started ? 'PASS' : 'FAIL', { childStarted: started });
    if (!started) return {
      ...outcome,
      failedStage: `${prefix}_spawn`,
      classification: safeClassification(outcome, 'HARNESS_FIXTURE_START_FAILED').classification,
      fixtureSafeCode: null,
    };

    const exitPassed = outcome?.exitCode === 0;
    const exitSafe = safeClassification(outcome, 'HARNESS_FIXTURE_EXIT_UNCLASSIFIED');
    record(`${prefix}_exit`, exitPassed ? 'PASS' : 'FAIL', {
      exitCode: Number.isInteger(outcome?.exitCode) ? outcome.exitCode : null,
      ...(exitSafe.fixtureSafeCode ? { fixtureSafeCode: exitSafe.fixtureSafeCode } : {}),
      ...(exitSafe.classification ? { classification: exitSafe.classification } : {}),
    });
    if (!exitPassed) {
      const safe = safeClassification(outcome, 'HARNESS_FIXTURE_EXIT_UNCLASSIFIED');
      return {
        ...outcome,
        failedStage: `${prefix}_exit`,
        classification: safe.classification,
        fixtureSafeCode: safe.fixtureSafeCode,
      };
    }

    const protocolPassed = outcome?.responseValid === true;
    const protocolSafe = safeClassification(outcome, 'HARNESS_FIXTURE_PROTOCOL_INVALID');
    record(`${prefix}_protocol`, protocolPassed ? 'PASS' : 'FAIL', {
      responseValid: protocolPassed,
      ...(protocolSafe.classification ? { classification: protocolSafe.classification } : {}),
    });
    if (!protocolPassed) {
      const safe = safeClassification(outcome, 'HARNESS_FIXTURE_PROTOCOL_INVALID');
      return {
        ...outcome,
        failedStage: `${prefix}_protocol`,
        classification: safe.classification,
        fixtureSafeCode: safe.fixtureSafeCode,
      };
    }

    record(`${prefix}_complete`, 'PASS', {
      exitCode: outcome.exitCode,
      responseValid: true,
      ...(Number.isSafeInteger(outcome.removedFileCount) ? { removedFileCount: outcome.removedFileCount } : {}),
    });
    lastCompletedStage = `${prefix}_complete`;
    return outcome;
  };

  try {
    primaryOutcome = await invoke('provision');
    if (primaryOutcome.result !== 'PASS') {
      const safe = safeClassification(primaryOutcome, 'HARNESS_INTERNAL_ERROR');
      primary = {
        failedStage: primaryOutcome.failedStage ?? 'fixture_provision_runner',
        classification: safe.classification,
        fixtureSafeCode: safe.fixtureSafeCode,
        childStarted: primaryOutcome.childStarted ?? null,
        exitCode: Number.isInteger(primaryOutcome.exitCode) ? primaryOutcome.exitCode : null,
        responseValid: primaryOutcome.responseValid === true,
      };
    } else {
      primary = {
        failedStage: null, classification: null, fixtureSafeCode: null,
        childStarted: true, exitCode: 0, responseValid: true,
      };
    }

    if (!(primaryOutcome.result !== 'PASS' && primaryOutcome.childStarted === false)) {
      cleanup.attempted = true;
      cleanup.result = 'RUNNING';
      cleanup.safetyCleanup = primaryOutcome.result !== 'PASS';
      const cleanupOutcome = await invoke('cleanup');
      cleanup.childStarted = cleanupOutcome.childStarted === true;
      cleanup.completed = cleanupOutcome.result === 'PASS';
      cleanup.result = cleanup.completed ? 'PASS' : 'FAIL';
      if (!cleanup.completed) {
        const safe = safeClassification(cleanupOutcome, 'HARNESS_CLEANUP_FAILED');
        cleanup.failedStage = cleanupOutcome.failedStage ?? 'fixture_cleanup_runner';
        cleanup.classification = safe.classification === 'HARNESS_INTERNAL_ERROR'
          ? 'HARNESS_CLEANUP_FAILED'
          : safe.classification;
        cleanup.fixtureSafeCode = safe.fixtureSafeCode;
        if (!primary || primary.classification === null) {
          primary = {
            failedStage: cleanup.failedStage,
            classification: cleanup.classification,
            fixtureSafeCode: cleanup.fixtureSafeCode,
            childStarted: cleanup.childStarted,
            exitCode: Number.isInteger(cleanupOutcome.exitCode) ? cleanupOutcome.exitCode : null,
            responseValid: cleanupOutcome.responseValid === true,
          };
        }
      }
    }
  } catch {
    if (!primary) {
      primary = {
        failedStage: 'fixture_provision_runner', classification: 'HARNESS_INTERNAL_ERROR',
        fixtureSafeCode: null, childStarted: null, exitCode: null, responseValid: false,
      };
    }
  } finally {
    identity.password = '';
  }

  return {
    iteration: index,
    result: primary?.classification === null && cleanup.result === 'PASS' ? 'PASS' : 'FAIL',
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    failedStage: primary?.failedStage ?? null,
    classification: primary?.classification ?? null,
    fixtureSafeCode: primary?.fixtureSafeCode ?? null,
    childStarted: primary?.childStarted ?? false,
    exitCode: primary?.exitCode ?? null,
    responseValid: primary?.responseValid ?? false,
    lastCompletedStage,
    cleanup,
    bestEffortSafetyCleanup: cleanup.safetyCleanup === true,
    events,
  };
}

export async function runCampaign({ iterations, environment, execute = executeFixture }) {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
    return {
      result: 'FAIL', classification: 'HARNESS_ENV_INVALID', fixtureSafeCode: null,
      plannedIterations: iterations, startedIterations: 0, completedIterations: 0,
      passedIterations: 0, failedIterations: 1, retries: 0, stoppedEarly: true, iterations: [],
    };
  }
  const validation = await validateEnvironment(environment);
  if (!validation.ok) {
    return {
      result: 'FAIL', classification: validation.classification, fixtureSafeCode: null,
      plannedIterations: iterations, startedIterations: 0, completedIterations: 0,
      passedIterations: 0, failedIterations: 1, retries: 0, stoppedEarly: true,
      databaseProbe: false, iterations: [],
    };
  }
  const results = [];
  for (let index = 1; index <= iterations; index++) {
    const result = await runIteration(index, environment, execute);
    results.push(result);
    if (result.result !== 'PASS') break;
  }
  const passedIterations = results.filter(item => item.result === 'PASS').length;
  return {
    result: passedIterations === iterations ? 'PASS' : 'FAIL',
    plannedIterations: iterations,
    startedIterations: results.length,
    completedIterations: results.length,
    passedIterations,
    failedIterations: results.length - passedIterations,
    retries: 0,
    stoppedEarly: results.length < iterations || passedIterations !== iterations,
    databaseProbe: false,
    iterations: results,
  };
}

export async function runDuplicateControl(environment, execute = executeFixture) {
  const startedAt = performance.now();
  const identity = makeIdentity();
  const commands = [];
  let firstProvisioned = false;
  let provisionMayHaveCommitted = false;
  let duplicateCode = null;
  let failureClassification = null;
  let cleanupResult = 'NOT_ATTEMPTED';
  const invoke = async command => {
    commands.push(command);
    return execute({
      command,
      payload: command === 'provision'
        ? { username: identity.username, email: identity.email, password: identity.password }
        : { username: identity.username },
      environment,
    });
  };
  try {
    provisionMayHaveCommitted = true;
    const first = await invoke('provision');
    provisionMayHaveCommitted = first?.childStarted !== false;
    firstProvisioned = first?.result === 'PASS' && first?.responseValid === true;
    if (!firstProvisioned) {
      failureClassification = safeClassification(first, 'HARNESS_INTERNAL_ERROR').classification;
    } else {
      const second = await invoke('provision');
      provisionMayHaveCommitted ||= second?.childStarted === true;
      duplicateCode = second?.fixtureSafeCode ?? null;
      if (second?.classification !== 'FIXTURE_REPORTED_FAILURE' || duplicateCode !== 'FIXTURE_USER_ALREADY_EXISTS') {
        failureClassification = safeClassification(second, 'HARNESS_FIXTURE_EXIT_UNCLASSIFIED').classification;
      }
    }
  } catch {
    failureClassification = 'HARNESS_INTERNAL_ERROR';
  } finally {
    if (firstProvisioned || provisionMayHaveCommitted) {
      try {
        const cleanup = await invoke('cleanup');
        cleanupResult = cleanup?.result === 'PASS' && cleanup?.responseValid === true ? 'PASS' : 'FAIL';
        if (cleanupResult !== 'PASS' && !failureClassification) {
          failureClassification = 'HARNESS_CLEANUP_FAILED';
        }
      } catch {
        cleanupResult = 'FAIL';
        if (!failureClassification) failureClassification = 'HARNESS_CLEANUP_FAILED';
      }
    }
    identity.password = '';
  }
  const passed = failureClassification === null &&
    duplicateCode === 'FIXTURE_USER_ALREADY_EXISTS' && cleanupResult === 'PASS';
  return {
    result: passed ? 'PASS' : 'FAIL',
    control: 'duplicate_user',
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    duplicateCode: duplicateCode === 'FIXTURE_USER_ALREADY_EXISTS' ? duplicateCode : null,
    cleanupResult,
    classification: passed ? null : failureClassification,
    fixtureSafeCode: duplicateCode === 'FIXTURE_USER_ALREADY_EXISTS' ? duplicateCode : null,
    commands,
    retries: 0,
  };
}

function environmentFromProcess(env) {
  return {
    executable: env.NANIKA_E2E_FIXTURE_EXE,
    cwd: env.NANIKA_E2E_FIXTURE_CWD,
    storagePath: env.NANIKA_E2E_STORAGE_PATH,
    storageId: env.NANIKA_E2E_STORAGE_ID,
  };
}

async function persist(output, result) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

async function main() {
  let output = DEFAULT_OUTPUT;
  let result;
  try {
    const args = parseArgs(process.argv.slice(2));
    output = args.output;
    const environment = environmentFromProcess(process.env);
    const validation = await validateEnvironment(environment);
    if (!validation.ok) {
      result = {
        result: 'FAIL', classification: validation.classification,
        fixtureSafeCode: null, failedStage: 'environment_validation',
      };
    } else {
      result = args.control === 'duplicate'
        ? await runDuplicateControl(environment)
        : await runCampaign({ iterations: args.iterations, environment });
    }
    await persist(output, result);
    process.stdout.write(`${JSON.stringify({ result: result.result, artifactWritten: true, retries: result.retries ?? 0 })}\n`);
    process.exitCode = result.result === 'PASS' ? 0 : 1;
  } catch {
    result = {
      result: 'FAIL', classification: 'HARNESS_INTERNAL_ERROR',
      fixtureSafeCode: null, failedStage: 'harness_internal',
    };
    try { await persist(output, result); } catch { /* Preserve sanitized process failure if artifact storage is unavailable. */ }
    process.stderr.write('Fixture characterization failed (HARNESS_INTERNAL_ERROR).\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
