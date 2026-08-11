import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  classifyRecoveryContinuation,
  createRecoveryEvidenceJournal,
  evidenceFromRecoveryEvents,
  parseRecoveryJournal,
  sanitizeRecoveryEvent,
  RECOVERY_JOURNAL_SCHEMA,
} from './e2e-recovery-diagnostics.mjs';

const event = (kind, values = {}) => ({ kind, phase: 'recovery', ...values });
const complete = () => [
  event('phase-start', { phase: 'initial' }),
  event('phase-start', { phase: 'recovery' }),
  event('recovery-upload-start'),
  event('chunk-response', { statusClass: '2xx' }),
  event('chunk-finished'),
  event('chunk-observable-subscribed'),
  event('chunk-observable-next'),
  event('store-progress-100'),
  event('upload-engine-resolved'),
  event('run-upload-loop-enter', { generationCurrent: true }),
  event('run-upload-loop-resolved', { generationCurrent: true }),
  event('terminal-success-applied', { present: true, state: 'success', progressClass: '100' }),
  event('store-state-snapshot', { present: true, state: 'success', progressClass: '100' }),
  event('dom-success-observed'),
];

const classify = events => classifyRecoveryContinuation(evidenceFromRecoveryEvents(events));

test('M26-H01 accepts success followed by reconciliation removal and DOM hidden', () => {
  const events = complete().filter(item => item.kind !== 'dom-success-observed');
  events.push(event('store-state-snapshot', { present: false, state: 'unknown', progressClass: 'unknown' }));
  events.push(event('dom-terminal-hidden'));
  assert.equal(classify(events), 'PASS_RECOVERY_POST_UPLOAD_CONTINUATION');
});

test('classifies the complete continuation as pass', () => {
  assert.equal(classify(complete()), 'PASS_RECOVERY_POST_UPLOAD_CONTINUATION');
  assert.equal(evidenceFromRecoveryEvents(complete().filter(item => item.kind !== 'store-state-snapshot')).storeSuccessObserved, true);
});

for (const state of ['paused', 'processing', 'error', 'cancelled']) {
  test(`success followed by ${state} is a terminal regression`, () => {
    assert.equal(classify([...complete(), event('store-state-snapshot', {
      present: true, state, progressClass: '50-99',
    })]), 'M23_STORE_REGRESSED_AFTER_SUCCESS');
  });
}

test('removal followed by recovery reappearance fails even if it reappears as success', () => {
  for (const state of ['paused', 'success']) {
    assert.equal(classify([...complete(),
      event('store-state-snapshot', { present: false, state: 'unknown', progressClass: 'unknown' }),
      event('dom-terminal-hidden'),
      event('store-state-snapshot', { present: true, state, progressClass: state === 'success' ? '100' : '50-99' }),
    ]), 'M23_STORE_REGRESSED_AFTER_SUCCESS');
  }
});

test('terminal boundary observes the actual store rather than a requested update', () => {
  for (const snapshot of [
    { present: true, state: 'paused', progressClass: '50-99' },
    { present: false, state: 'unknown', progressClass: 'unknown' },
  ]) {
    const events = complete().filter(item => !['store-state-snapshot', 'dom-success-observed'].includes(item.kind))
      .map(item => item.kind === 'terminal-success-applied' ? { ...item, ...snapshot } : item);
    const evidence = evidenceFromRecoveryEvents(events);
    assert.equal(evidence.storeSuccessObserved, false);
    assert.equal(classifyRecoveryContinuation(evidence), 'M23_TERMINAL_PUBLICATION_WITHOUT_STORE_SUCCESS');
    assert.equal(classifyRecoveryContinuation({ ...evidence, storeSuccessObserved: true }), 'M23_EVIDENCE_INVALID');
    assert.equal(classify([...events, event('store-state-snapshot', {
      present: true, state: 'success', progressClass: '100',
    })]), 'M23_EVIDENCE_INVALID');
  }
});

test('absence before any applied success cannot pass', () => {
  const events = complete().filter(item => !['terminal-success-applied', 'store-state-snapshot', 'dom-success-observed'].includes(item.kind));
  events.push(event('store-state-snapshot', { present: false, state: 'unknown', progressClass: 'unknown' }));
  assert.equal(classify(events), 'M23_ENGINE_RESOLVED_WITHOUT_TERMINAL_PUBLICATION');
});

test('hidden DOM requires both an applied success and subsequent store removal', () => {
  const withoutDom = complete().filter(item => item.kind !== 'dom-success-observed');
  assert.equal(classify([...withoutDom, event('dom-terminal-hidden')]), 'M23_STORE_SUCCESS_WITHOUT_DOM_CONVERGENCE');
  assert.equal(classify([...withoutDom.filter(item => !['terminal-success-applied', 'store-state-snapshot'].includes(item.kind)),
    event('dom-terminal-hidden')]), 'M23_EVIDENCE_INVALID');
  assert.equal(classify([event('dom-terminal-hidden'), ...complete()]), 'M23_EVIDENCE_INVALID');
});

test('classifies partial evidence at each causal boundary', () => {
  const all = complete();
  const without = (...kinds) => all.filter(item => !kinds.includes(item.kind));
  assert.equal(classify([]), 'M23_NETWORK_RESPONSE_NOT_OBSERVED');
  assert.equal(classify(without('chunk-observable-subscribed', 'chunk-observable-next', 'store-progress-100', 'upload-engine-resolved', 'run-upload-loop-enter', 'run-upload-loop-resolved', 'terminal-success-applied', 'store-state-snapshot', 'dom-success-observed')), 'M23_HTTP_2XX_WITHOUT_OBSERVABLE_SUBSCRIPTION');
  assert.equal(classify(without('chunk-observable-next', 'store-progress-100', 'upload-engine-resolved', 'run-upload-loop-enter', 'run-upload-loop-resolved', 'terminal-success-applied', 'store-state-snapshot', 'dom-success-observed')), 'M23_HTTP_2XX_WITHOUT_OBSERVABLE_NEXT');
  assert.equal(classify(without('store-progress-100', 'upload-engine-resolved', 'run-upload-loop-enter', 'run-upload-loop-resolved', 'terminal-success-applied', 'store-state-snapshot', 'dom-success-observed')), 'M23_OBSERVABLE_NEXT_WITHOUT_PROGRESS_100');
  assert.equal(classify(without('upload-engine-resolved', 'run-upload-loop-enter', 'run-upload-loop-resolved', 'terminal-success-applied', 'store-state-snapshot', 'dom-success-observed')), 'M23_PROGRESS_100_WITH_ENGINE_UNRESOLVED');
  assert.equal(classify(all.map(item => item.kind === 'run-upload-loop-enter' ? { ...item, generationCurrent: false } : item)), 'M23_ENGINE_RESOLVED_WITH_STALE_RUNTIME_GENERATION');
  assert.equal(classify(without('terminal-success-applied', 'store-state-snapshot', 'dom-success-observed')), 'M23_ENGINE_RESOLVED_WITHOUT_TERMINAL_PUBLICATION');
  assert.equal(classify(without('store-state-snapshot', 'dom-success-observed').map(item =>
    item.kind === 'terminal-success-applied' ? { ...item, state: 'paused', progressClass: '50-99' } : item)),
    'M23_TERMINAL_PUBLICATION_WITHOUT_STORE_SUCCESS');
  assert.equal(classify(without('dom-success-observed')), 'M23_STORE_SUCCESS_WITHOUT_DOM_CONVERGENCE');
  assert.equal(classify(without('chunk-finished')), 'M23_TARGETED_TIMEOUT_UNCLASSIFIED');
});

test('contradictory milestones remain structurally invalid', () => {
  assert.equal(classify([event('chunk-observable-next')]), 'M23_EVIDENCE_INVALID');
  assert.equal(classify([event('store-progress-100')]), 'M23_EVIDENCE_INVALID');
  assert.equal(classify([
    event('chunk-response', { statusClass: '2xx' }), event('chunk-finished'),
    event('store-state-snapshot', { present: false, state: 'unknown', progressClass: 'unknown' }),
    event('dom-success-observed'),
  ]), 'M23_EVIDENCE_INVALID');
  assert.equal(classify([event('chunk-observable-complete')]), 'M23_EVIDENCE_INVALID');
  assert.equal(classify([...complete(), event('chunk-observable-error')]), 'M23_EVIDENCE_INVALID');
  const empty = evidenceFromRecoveryEvents([]);
  for (const changes of [
    { domSuccessObserved: true }, { domHiddenAfterSuccess: true }, { storeRemovedAfterSuccess: true },
    { observableNext: true }, { observableComplete: true }, { storeProgress100: true },
    { networkResponse2xx: 'true' }, { generationCurrentAtLoopEntry: 1 },
  ]) assert.equal(classifyRecoveryContinuation({ ...empty, ...changes }), 'M23_EVIDENCE_INVALID');
  assert.equal(classifyRecoveryContinuation({}), 'M23_EVIDENCE_INVALID');
  assert.equal(classifyRecoveryContinuation(null), 'M23_EVIDENCE_INVALID');
  assert.equal(classify([...complete(), event('terminal-success-applied', {
    present: true, state: 'success', progressClass: '100',
  })]), 'M23_EVIDENCE_INVALID');
});

test('sanitizer allowlists fields and never retains sensitive sentinels', () => {
  const safe = sanitizeRecoveryEvent({
    ...event('chunk-response', { statusClass: '2xx' }),
    filename: 'PASSWORD=SUPER_SECRET_SENTINEL',
    username: 'alice@example.invalid',
    token: 'Bearer SUPER_SECRET',
    path: 'C:\\Users\\Secret',
    url: 'http://secret.example',
  });
  assert.deepEqual(safe, { kind: 'chunk-response', phase: 'recovery', statusClass: '2xx' });
  assert.doesNotMatch(JSON.stringify(safe), /SUPER_SECRET|alice|Users|secret\.example/i);
  assert.equal(sanitizeRecoveryEvent(event('not-allowlisted')), null);
  assert.equal(sanitizeRecoveryEvent(event('chunk-response', { statusClass: 'http://127.0.0.1:12345' })), null);
  assert.equal(sanitizeRecoveryEvent(event('store-state-snapshot', { state: 'filename.mp4' })), null);
  const terminal = event('terminal-success-applied', { present: true, state: 'success', progressClass: '100' });
  assert.deepEqual(sanitizeRecoveryEvent({ ...terminal, filename: 'SECRET.bin', token: 'Bearer SECRET' }), terminal);
  assert.equal(sanitizeRecoveryEvent(event('terminal-success-applied', { present: true, state: 'success' })), null);
  assert.equal(sanitizeRecoveryEvent(event('terminal-success-applied', { present: false, state: 'paused', progressClass: '50-99' })), null);
  assert.equal(sanitizeRecoveryEvent(event('constructor')), null);
  assert.equal(sanitizeRecoveryEvent(event('__proto__')), null);
});

function withJournal(callback) {
  const root = mkdtempSync(join(tmpdir(), 'nanika-m26-'));
  try { return callback(join(root, 'recovery-continuation.journal.jsonl'), root); }
  finally { assert.ok(root.startsWith(join(tmpdir(), 'nanika-m26-'))); rmSync(root, { recursive: true, force: true }); }
}

const journalText = (events = complete()) => [ { schema: RECOVERY_JOURNAL_SCHEMA, kind: 'journal-start' }, ...events ]
  .map(item => JSON.stringify(item) + '\n').join('');

test('schema, UTF-8, bytes, fields, required enums and duplicate keys fail closed', () => withJournal((path, root) => {
  const unknownField = complete().map(item => item.kind === 'terminal-success-applied' ? { ...item, filename: 'UNSAFE_SENTINEL' } : item);
  const cases = [
    journalText().replace('"schema":5', '"schema":4'),
    journalText().replace('"schema":5', '"schema":5.0'),
    journalText().replace('"schema":5', '"schema":5e0'),
    journalText().replace('"schema":5', '"schema":5,"schema":5'),
    journalText().replace('"phase":"recovery"', '"phase":"recovery","phase":"recovery"'),
    journalText(unknownField),
    journalText().replace('"state":"success"', '"state":"UNSAFE_SENTINEL"'),
    journalText().replace('"state":"success",', ''),
    journalText().replace('"state":"success"', '"state":[]'),
    journalText().replace('"present":true', '"present":1'),
    journalText().replace('"kind":"terminal-success-applied"', '"kind":"terminal-success-published"'),
    journalText().replace('"kind":"chunk-finished"', '"kind":"__proto__"'),
    journalText() + JSON.stringify(event('chunk-finished')) + '\n'.repeat(2),
    Buffer.from([0xff, 0x0a]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(journalText())]),
    ' '.repeat(64 * 1024 + 1),
  ];
  for (const content of cases) {
    writeFileSync(path, content);
    const parsed = parseRecoveryJournal(path, root);
    assert.equal(parsed.classifier, 'M26_RECOVERY_EVIDENCE_INVALID');
    assert.doesNotMatch(JSON.stringify(parsed), /UNSAFE_SENTINEL/);
  }
}));

test('phase reversal, premature hidden, duplicate terminal and malformed truncation fail closed', () => withJournal((path, root) => {
  const prefix = complete().slice(0, 2);
  const cases = [
    [...complete(), event('phase-start', { phase: 'initial' })],
    [prefix[1], prefix[0]],
    [...prefix, event('dom-terminal-hidden'), ...complete().slice(2)],
    [...complete(), complete().find(item => item.kind === 'terminal-success-applied')],
    [...complete(), { kind: 'journal-truncated' }],
    [...prefix, ...Array.from({length: 63}, () => event('chunk-finished'))],
    [...prefix, ...Array.from({length: 62}, () => event('chunk-finished')), { kind: 'journal-truncated', extra: true }],
    [...prefix, ...Array.from({length: 62}, () => event('chunk-finished')), { kind: 'journal-truncated' }, event('chunk-finished')],
  ];
  for (const events of cases) {
    writeFileSync(path, journalText(events));
    assert.equal(parseRecoveryJournal(path, root).classifier, 'M26_RECOVERY_EVIDENCE_INVALID');
  }
}));

test('journal path and symlink violations fail closed without touching the linked target', () => withJournal((path, root) => {
  assert.throws(() => createRecoveryEvidenceJournal('relative.jsonl', root));
  assert.throws(() => createRecoveryEvidenceJournal(join(root, 'wrong.jsonl'), root));
  assert.equal(parseRecoveryJournal(path, tmpdir()).classifier, 'M26_RECOVERY_EVIDENCE_INVALID');
  writeFileSync(path, journalText());
  const original = fs.lstatSync;
  mock.method(fs, 'lstatSync', (candidate, ...args) => candidate === path
    ? { isFile: () => true, isSymbolicLink: () => true, size: 0 } : original(candidate, ...args));
  syncBuiltinESMExports();
  try {
    assert.equal(parseRecoveryJournal(path, root).classifier, 'M26_RECOVERY_EVIDENCE_INVALID');
    assert.throws(() => createRecoveryEvidenceJournal(path, root));
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(readFileSync(path, 'utf8'), journalText());
}));

test('durable journal preserves events without page finalization or reporter attachment', () => {
  const root = mkdtempSync(join(tmpdir(), 'nanika-m26-'));
  try {
    const path = join(root, 'recovery-continuation.journal.jsonl');
    const journal = createRecoveryEvidenceJournal(path, root);
    for (const item of complete()) journal.append(item);
    journal.close();
    const parsed = parseRecoveryJournal(path, root);
    assert.equal(parsed.journalValid, true);
    assert.equal(parsed.eventCount, complete().length);
    assert.equal(parsed.classifier, 'PASS_RECOVERY_POST_UPLOAD_CONTINUATION');
    assert.equal(parsed.recoveryOperationStarted, true);
    assert.equal(classifyRecoveryContinuation(parsed.evidence), 'PASS_RECOVERY_POST_UPLOAD_CONTINUATION');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('journal does not claim recovery before its input operation starts', () => {
  const root = mkdtempSync(join(tmpdir(), 'nanika-m26-'));
  try {
    const path = join(root, 'recovery-continuation.journal.jsonl');
    const journal = createRecoveryEvidenceJournal(path, root);
    journal.append(event('phase-start', { phase: 'initial' }));
    journal.append(event('phase-start', { phase: 'recovery' }));
    journal.append(event('instrumentation-installed'));
    journal.close();
    const parsed = parseRecoveryJournal(path, root);
    assert.equal(parsed.journalValid, true);
    assert.equal(parsed.recoveryOperationStarted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('journal parser rejects blank or unterminated records', () => {
  const root = mkdtempSync(join(tmpdir(), 'nanika-m26-'));
  try {
    const path = join(root, 'recovery-continuation.journal.jsonl');
    writeFileSync(path, '{"schema":5,"kind":"journal-start"}\n\n');
    assert.equal(parseRecoveryJournal(path, root).classifier, 'M26_RECOVERY_EVIDENCE_INVALID');
    writeFileSync(path, '{"schema":5,"kind":"journal-start"}');
    assert.equal(parseRecoveryJournal(path, root).classifier, 'M26_RECOVERY_EVIDENCE_INVALID');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('journal create-new is fail-closed and truncates after the bounded event limit', () => {
  const root = mkdtempSync(join(tmpdir(), 'nanika-m26-'));
  try {
    const path = join(root, 'recovery-continuation.journal.jsonl');
    const journal = createRecoveryEvidenceJournal(path, root);
    assert.throws(() => createRecoveryEvidenceJournal(path, root));
    journal.append(event('phase-start', { phase: 'initial' }));
    journal.append(event('phase-start', { phase: 'recovery' }));
    for (let index = 0; index < 100; index += 1) journal.append(event('chunk-finished'));
    journal.close();
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    assert.equal(lines.filter(line => JSON.parse(line).kind === 'chunk-finished').length, 62);
    assert.equal(parseRecoveryJournal(path, root).eventCount, 64);
    assert.equal(lines.filter(line => JSON.parse(line).kind === 'journal-truncated').length, 1);
    assert.equal(parseRecoveryJournal(path, root).truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('valid truncation framing cannot prove the final temporal state', () => withJournal((path, root) => {
  const events = complete();
  while (events.length < 64) events.push(event('chunk-finished'));
  writeFileSync(path, journalText([...events, { kind: 'journal-truncated' }]));
  const parsed = parseRecoveryJournal(path, root);
  assert.equal(parsed.journalValid, true);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.classifier, 'M23_EVIDENCE_INVALID');
}));
