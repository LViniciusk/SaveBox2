import { closeSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

export const MAX_RECOVERY_JOURNAL_EVENTS = 64;
export const RECOVERY_JOURNAL_SCHEMA = 5;
const MAX_JOURNAL_BYTES = 64 * 1024;
const JOURNAL_NAME = 'recovery-continuation.journal.jsonl';
const phases = new Set(['initial', 'recovery']);
const states = new Set(['processing', 'paused', 'success', 'error', 'cancelled', 'cancelling', 'unknown']);
const progressClasses = new Set(['0-49', '50-99', '100', 'unknown']);
const statusClasses = new Set(['2xx', '4xx', '5xx', 'other']);
const requiredByKind = {
  'chunk-response': ['statusClass'],
  'store-state-snapshot': ['present', 'state', 'progressClass'],
  'terminal-success-applied': ['present', 'state', 'progressClass'],
  'dom-state-snapshot': ['state', 'progressClass', 'matchingCards'],
  'run-upload-loop-enter': ['generationCurrent'],
  'run-upload-loop-resolved': ['generationCurrent'],
  'run-upload-loop-rejected': ['generationCurrent'],
};

const fieldsByKind = {
  'phase-start': ['phase'],
  'recovery-upload-start': ['phase'],
  'instrumentation-installed': ['phase'],
  'instrumentation-invalid': ['phase'],
  'chunk-response': ['phase', 'statusClass'],
  'chunk-finished': ['phase'],
  'chunk-failed': ['phase'],
  'chunk-observable-subscribed': ['phase'],
  'chunk-observable-next': ['phase'],
  'chunk-observable-complete': ['phase'],
  'chunk-observable-error': ['phase'],
  'store-progress-100': ['phase', 'transferPresent'],
  'upload-engine-enter': ['phase'],
  'upload-engine-resolved': ['phase'],
  'upload-engine-rejected': ['phase'],
  'run-upload-loop-enter': ['phase', 'generationCurrent'],
  'run-upload-loop-resolved': ['phase', 'generationCurrent'],
  'run-upload-loop-rejected': ['phase', 'generationCurrent'],
  'terminal-success-applied': ['phase', 'present', 'state', 'progressClass'],
  'store-state-snapshot': ['phase', 'present', 'state', 'progressClass'],
  'dom-state-snapshot': ['phase', 'state', 'progressClass', 'matchingCards'],
  'dom-success-observed': ['phase'],
  'dom-terminal-hidden': ['phase'],
};

export function sanitizeRecoveryEvent(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 16
    || typeof value.kind !== 'string') return null;
  const kind = value.kind;
  if (!Object.hasOwn(fieldsByKind, kind)) return null;
  const allowed = fieldsByKind[kind];
  const result = { kind };
  for (const key of allowed) {
    if (key === 'kind' || value[key] === undefined) continue;
    const field = value[key];
    if (key === 'phase' && phases.has(field)) result.phase = field;
    else if (key === 'statusClass' && statusClasses.has(field)) result.statusClass = field;
    else if (key === 'state' && states.has(field)) result.state = field;
    else if (key === 'progressClass' && progressClasses.has(field)) result.progressClass = field;
    else if (['present', 'transferPresent', 'generationCurrent'].includes(key) && typeof field === 'boolean') result[key] = field;
    else if (key === 'matchingCards' && Number.isSafeInteger(field) && field >= 0 && field <= 20) result[key] = field;
    else return null;
  }
  if (fieldsByKind[kind].includes('phase') && !phases.has(result.phase)) return null;
  if (['recovery-upload-start', 'terminal-success-applied', 'dom-terminal-hidden'].includes(kind)
    && result.phase !== 'recovery') return null;
  if ((requiredByKind[kind] ?? []).some(key => result[key] === undefined)) return null;
  if (['store-state-snapshot', 'terminal-success-applied'].includes(kind) && !result.present
    && (result.state !== 'unknown' || result.progressClass !== 'unknown')) return null;
  return result;
}

const storeIsSuccess = item => item?.present === true && item.state === 'success' && item.progressClass === '100';

export function evidenceFromRecoveryEvents(events) {
  if (!Array.isArray(events) || events.some(item => !sanitizeRecoveryEvent(item))) return null;
  const recovery = events.filter(item => item.phase === 'recovery');
  const has = kind => recovery.some(item => item.kind === kind);
  const terminalIndex = recovery.findIndex(item => item.kind === 'terminal-success-applied');
  const terminal = recovery[terminalIndex];
  if (recovery.filter(item => item.kind === 'terminal-success-applied').length > 1) return null;
  const terminalStore = terminal
    ? { present: terminal.present, state: terminal.state, progressClass: terminal.progressClass } : null;
  const storeSuccessObserved = storeIsSuccess(terminalStore);
  let storeRemovedAfterSuccess = false;
  let storeRegressedAfterSuccess = false;
  for (let index = 0; index < recovery.length; index += 1) {
    const item = recovery[index];
    if (['dom-success-observed', 'dom-terminal-hidden'].includes(item.kind)
      && (!storeSuccessObserved || index <= terminalIndex)) return null;
    if (item.kind !== 'store-state-snapshot') continue;
    if (index <= terminalIndex || terminalIndex < 0) {
      if (storeIsSuccess(item)) return null;
      continue;
    }
    if (!storeSuccessObserved) {
      if (storeIsSuccess(item)) return null;
      continue;
    }
    if (!item.present) storeRemovedAfterSuccess = true;
    else if (storeRemovedAfterSuccess || !storeIsSuccess(item)) storeRegressedAfterSuccess = true;
  }
  const response = recovery.find(item => item.kind === 'chunk-response');
  const loopEntry = recovery.find(item => item.kind === 'run-upload-loop-enter');
  const loopExit = recovery.find(item => ['run-upload-loop-resolved', 'run-upload-loop-rejected'].includes(item.kind));
  return {
    networkResponse2xx: response?.statusClass === '2xx',
    requestFinished: has('chunk-finished'),
    observableSubscribed: has('chunk-observable-subscribed'),
    observableNext: has('chunk-observable-next'),
    observableComplete: has('chunk-observable-complete'),
    observableError: has('chunk-observable-error'),
    storeProgress100: has('store-progress-100'),
    uploadEngineResolved: has('upload-engine-resolved'),
    generationCurrentAtLoopEntry: typeof loopEntry?.generationCurrent === 'boolean' ? loopEntry.generationCurrent : null,
    generationCurrentAtLoopExit: typeof loopExit?.generationCurrent === 'boolean' ? loopExit.generationCurrent : null,
    runUploadLoopResolved: has('run-upload-loop-resolved'),
    terminalSuccessApplied: terminalIndex >= 0,
    terminalStore,
    storeSuccessObserved,
    storeRemovedAfterSuccess,
    storeRegressedAfterSuccess,
    domSuccessObserved: has('dom-success-observed'),
    domHiddenAfterSuccess: has('dom-terminal-hidden'),
  };
}

const booleanEvidenceFields = [
  'networkResponse2xx', 'requestFinished', 'observableSubscribed', 'observableNext', 'observableComplete',
  'observableError', 'storeProgress100', 'uploadEngineResolved', 'runUploadLoopResolved',
  'terminalSuccessApplied', 'storeSuccessObserved', 'storeRemovedAfterSuccess', 'storeRegressedAfterSuccess',
  'domSuccessObserved', 'domHiddenAfterSuccess',
];

export function classifyRecoveryContinuation(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || booleanEvidenceFields.some(key => typeof evidence[key] !== 'boolean')
    || ['generationCurrentAtLoopEntry', 'generationCurrentAtLoopExit'].some(key =>
      evidence[key] !== null && typeof evidence[key] !== 'boolean')
    || (evidence.terminalStore !== null && (!sanitizeRecoveryEvent({
      kind: 'terminal-success-applied', phase: 'recovery', ...evidence.terminalStore,
    }) || Object.keys(evidence.terminalStore).length !== 3))
    || evidence.terminalSuccessApplied !== (evidence.terminalStore !== null)
    || evidence.storeSuccessObserved !== storeIsSuccess(evidence.terminalStore)) return 'M23_EVIDENCE_INVALID';
  if ((evidence.observableNext && !evidence.observableSubscribed)
    || (evidence.observableComplete && !evidence.observableSubscribed)
    || (evidence.observableError && !evidence.observableSubscribed)
    || (evidence.storeProgress100 && !evidence.observableNext)
    || (evidence.observableError && (evidence.observableNext || evidence.observableComplete
      || evidence.storeProgress100 || evidence.uploadEngineResolved || evidence.terminalSuccessApplied))
    || ([evidence.domSuccessObserved, evidence.domHiddenAfterSuccess, evidence.storeRemovedAfterSuccess,
      evidence.storeRegressedAfterSuccess].some(Boolean) && !evidence.storeSuccessObserved)) return 'M23_EVIDENCE_INVALID';
  if (!evidence.networkResponse2xx) return 'M23_NETWORK_RESPONSE_NOT_OBSERVED';
  if (!evidence.requestFinished) return 'M23_TARGETED_TIMEOUT_UNCLASSIFIED';
  if (!evidence.observableSubscribed) return 'M23_HTTP_2XX_WITHOUT_OBSERVABLE_SUBSCRIPTION';
  if (!evidence.observableNext) return 'M23_HTTP_2XX_WITHOUT_OBSERVABLE_NEXT';
  if (!evidence.storeProgress100) return 'M23_OBSERVABLE_NEXT_WITHOUT_PROGRESS_100';
  if (!evidence.uploadEngineResolved) return 'M23_PROGRESS_100_WITH_ENGINE_UNRESOLVED';
  if (evidence.generationCurrentAtLoopEntry === null || evidence.generationCurrentAtLoopExit === null) return 'M23_EVIDENCE_INVALID';
  if (evidence.generationCurrentAtLoopEntry === false || evidence.generationCurrentAtLoopExit === false) return 'M23_ENGINE_RESOLVED_WITH_STALE_RUNTIME_GENERATION';
  if (!evidence.runUploadLoopResolved || !evidence.terminalSuccessApplied) return 'M23_ENGINE_RESOLVED_WITHOUT_TERMINAL_PUBLICATION';
  if (!evidence.storeSuccessObserved) return 'M23_TERMINAL_PUBLICATION_WITHOUT_STORE_SUCCESS';
  if (evidence.storeRegressedAfterSuccess) return 'M23_STORE_REGRESSED_AFTER_SUCCESS';
  if (!evidence.domSuccessObserved && !(evidence.storeRemovedAfterSuccess && evidence.domHiddenAfterSuccess)) return 'M23_STORE_SUCCESS_WITHOUT_DOM_CONVERGENCE';
  return 'PASS_RECOVERY_POST_UPLOAD_CONTINUATION';
}

function validJournalLocation(path, outputDir) {
  if (typeof path !== 'string' || typeof outputDir !== 'string' || !isAbsolute(path) || !isAbsolute(outputDir)) return false;
  try {
    const root = realpathSync(outputDir);
    const rootStat = lstatSync(outputDir);
    return rootStat.isDirectory() && !rootStat.isSymbolicLink()
      && dirname(resolve(path)) === root && basename(path) === JOURNAL_NAME;
  } catch {
    return false;
  }
}

export function createRecoveryEvidenceJournal(path, outputDir) {
  if (!validJournalLocation(path, outputDir)) throw new Error('RECOVERY_EVIDENCE_PATH_INVALID');
  const descriptor = openSync(path, 'wx', 0o600);
  const header = JSON.stringify({ schema: RECOVERY_JOURNAL_SCHEMA, kind: 'journal-start' }) + '\n';
  try {
    writeSync(descriptor, header, undefined, 'utf8');
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  let count = 0;
  let truncated = false;
  let invalidInput = false;
  let invalidMarker = false;
  let activePhase = null;
  let closed = false;
  const appendLine = item => writeSync(descriptor, JSON.stringify(item) + '\n', undefined, 'utf8');
  return {
    append(candidate) {
      if (closed) return null;
      const safe = sanitizeRecoveryEvent(candidate);
      if (!safe) {
        invalidInput = true;
        if (count >= MAX_RECOVERY_JOURNAL_EVENTS && !truncated) {
          appendLine({ kind: 'journal-truncated' });
          truncated = true;
        } else if (!invalidMarker && count < MAX_RECOVERY_JOURNAL_EVENTS) {
          appendLine({ kind: 'instrumentation-invalid', phase: activePhase ?? 'initial' });
          count += 1;
          invalidMarker = true;
        }
        return null;
      }
      if (count >= MAX_RECOVERY_JOURNAL_EVENTS) {
        if (!truncated) {
          appendLine({ kind: 'journal-truncated' });
          truncated = true;
        }
        return null;
      }
      appendLine(safe);
      count += 1;
      if (safe.kind === 'phase-start') activePhase = safe.phase;
      return safe;
    },
    get count() { return count; },
    get truncated() { return truncated; },
    get invalidInput() { return invalidInput; },
    close() {
      if (closed) return;
      closed = true;
      closeSync(descriptor);
    },
  };
}

export function parseRecoveryJournal(path, outputDir) {
  if (!validJournalLocation(path, outputDir)) return { journalValid: false, journalMissing: false, classifier: 'M26_RECOVERY_EVIDENCE_INVALID' };
  let parsed;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JOURNAL_BYTES) throw new Error();
    const raw = readFileSync(path);
    if (raw.byteLength > MAX_JOURNAL_BYTES) throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    if (!text.endsWith('\n')) throw new Error();
    const lines = text.slice(0, -1).split('\n');
    if (lines.some(line => !line) || lines.length < 1 || lines.length > MAX_RECOVERY_JOURNAL_EVENTS + 2) throw new Error();
    parsed = lines.map(line => {
      const record = JSON.parse(line);
      // The allowlisted journal is flat: every key must survive JSON parsing exactly once.
      if (!record || Array.isArray(record) || typeof record !== 'object'
        || (line.match(/"(?:[^"\\]|\\.)*"\s*:/g) ?? []).length !== Object.keys(record).length) throw new Error();
      if ([...line.matchAll(/:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*[,}]/g)]
        .some(match => !/^-?\d+$/.test(match[1]))) throw new Error();
      return record;
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return { journalValid: false, journalMissing: true, classifier: 'M26_RECOVERY_EVIDENCE_MISSING' };
    return { journalValid: false, journalMissing: false, classifier: 'M26_RECOVERY_EVIDENCE_INVALID' };
  }
  if (parsed[0]?.schema !== RECOVERY_JOURNAL_SCHEMA || parsed[0]?.kind !== 'journal-start' || Object.keys(parsed[0]).length !== 2) return { journalValid: false, journalMissing: false, classifier: 'M26_RECOVERY_EVIDENCE_INVALID' };
  const events = [];
  let truncated = false;
  let activePhase = null;
  const startedPhases = new Set();
  for (const record of parsed.slice(1)) {
    if (record?.kind === 'journal-truncated' && Object.keys(record).length === 1 && !truncated) {
      if (events.length !== MAX_RECOVERY_JOURNAL_EVENTS) return { journalValid: false, journalMissing: false, classifier: 'M26_RECOVERY_EVIDENCE_INVALID' };
      truncated = true;
      continue;
    }
    const safe = sanitizeRecoveryEvent(record);
    if (!safe || Object.keys(safe).length !== Object.keys(record).length
      || Object.keys(safe).some(key => safe[key] !== record[key]) || truncated) return { journalValid: false, journalMissing: false, classifier: 'M26_RECOVERY_EVIDENCE_INVALID' };
    if (safe.kind === 'phase-start') {
      if (startedPhases.has(safe.phase) || (safe.phase === 'initial' && activePhase !== null)
        || (safe.phase === 'recovery' && activePhase !== 'initial')) return { journalValid: false, journalMissing: false, classifier: 'M26_RECOVERY_EVIDENCE_INVALID' };
      activePhase = safe.phase;
      startedPhases.add(safe.phase);
    } else if (safe.phase !== activePhase) {
      return { journalValid: false, journalMissing: false, classifier: 'M26_RECOVERY_EVIDENCE_INVALID' };
    }
    events.push(safe);
  }
  const evidence = evidenceFromRecoveryEvents(events);
  if (!evidence || events.length > MAX_RECOVERY_JOURNAL_EVENTS) return { journalValid: false, journalMissing: false, classifier: 'M26_RECOVERY_EVIDENCE_INVALID' };
  return {
    journalValid: true,
    journalMissing: false,
    schema: RECOVERY_JOURNAL_SCHEMA,
    classifier: truncated ? 'M23_EVIDENCE_INVALID' : classifyRecoveryContinuation(evidence),
    evidence,
    eventCount: events.length,
    truncated,
    recoveryOperationStarted: events.some(item => item.kind === 'recovery-upload-start'),
    instrumentationTransportFailed: events.some(item => item.kind === 'instrumentation-invalid'),
  };
}
