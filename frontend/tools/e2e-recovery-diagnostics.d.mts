export type RecoveryPhase = 'initial' | 'recovery';
export type RecoveryProgressClass = '0-49' | '50-99' | '100' | 'unknown';
export type RecoveryState = 'processing' | 'paused' | 'success' | 'error' | 'cancelled' | 'cancelling' | 'unknown';
export type RecoveryDiagnosticKind =
  | 'phase-start' | 'recovery-upload-start' | 'instrumentation-installed' | 'instrumentation-invalid'
  | 'chunk-response' | 'chunk-finished' | 'chunk-failed'
  | 'chunk-observable-subscribed' | 'chunk-observable-next' | 'chunk-observable-complete' | 'chunk-observable-error'
  | 'store-progress-100' | 'upload-engine-enter' | 'upload-engine-resolved' | 'upload-engine-rejected'
  | 'run-upload-loop-enter' | 'run-upload-loop-resolved' | 'run-upload-loop-rejected'
  | 'terminal-success-applied' | 'store-state-snapshot' | 'dom-state-snapshot' | 'dom-success-observed'
  | 'dom-terminal-hidden';

export type SafeRecoveryEvent = {
  kind: RecoveryDiagnosticKind;
  phase?: RecoveryPhase;
  statusClass?: '2xx' | '4xx' | '5xx' | 'other';
  generationCurrent?: boolean;
  transferPresent?: boolean;
  present?: boolean;
  state?: RecoveryState;
  progressClass?: RecoveryProgressClass;
  matchingCards?: number;
};

export type M23Evidence = {
  networkResponse2xx: boolean;
  requestFinished: boolean;
  observableSubscribed: boolean;
  observableNext: boolean;
  observableComplete: boolean;
  observableError: boolean;
  storeProgress100: boolean;
  uploadEngineResolved: boolean;
  generationCurrentAtLoopEntry: boolean | null;
  generationCurrentAtLoopExit: boolean | null;
  runUploadLoopResolved: boolean;
  terminalSuccessApplied: boolean;
  terminalStore: { present: boolean; state: RecoveryState; progressClass: RecoveryProgressClass } | null;
  storeSuccessObserved: boolean;
  storeRemovedAfterSuccess: boolean;
  storeRegressedAfterSuccess: boolean;
  domSuccessObserved: boolean;
  domHiddenAfterSuccess: boolean;
};

export type M23Classification =
  | 'PASS_RECOVERY_POST_UPLOAD_CONTINUATION' | 'M23_EVIDENCE_INVALID' | 'M23_NETWORK_RESPONSE_NOT_OBSERVED'
  | 'M23_HTTP_2XX_WITHOUT_OBSERVABLE_SUBSCRIPTION' | 'M23_HTTP_2XX_WITHOUT_OBSERVABLE_NEXT'
  | 'M23_OBSERVABLE_NEXT_WITHOUT_PROGRESS_100' | 'M23_PROGRESS_100_WITH_ENGINE_UNRESOLVED'
  | 'M23_ENGINE_RESOLVED_WITH_STALE_RUNTIME_GENERATION' | 'M23_ENGINE_RESOLVED_WITHOUT_TERMINAL_PUBLICATION'
  | 'M23_TERMINAL_PUBLICATION_WITHOUT_STORE_SUCCESS' | 'M23_STORE_SUCCESS_WITHOUT_DOM_CONVERGENCE'
  | 'M23_STORE_REGRESSED_AFTER_SUCCESS'
  | 'M23_TARGETED_TIMEOUT_UNCLASSIFIED';

export const MAX_RECOVERY_JOURNAL_EVENTS: 64;
export const RECOVERY_JOURNAL_SCHEMA: 5;
export function sanitizeRecoveryEvent(value: unknown): SafeRecoveryEvent | null;
export function evidenceFromRecoveryEvents(events: SafeRecoveryEvent[]): M23Evidence | null;
export function classifyRecoveryContinuation(evidence: M23Evidence | null): M23Classification;
export function createRecoveryEvidenceJournal(path: string, outputDir: string): {
  append(candidate: unknown): SafeRecoveryEvent | null;
  readonly count: number;
  readonly truncated: boolean;
  readonly invalidInput: boolean;
  close(): void;
};
export function parseRecoveryJournal(path: string, outputDir: string): {
  journalValid: boolean;
  journalMissing: boolean;
  schema?: number;
  classifier: M23Classification | 'M26_RECOVERY_EVIDENCE_MISSING' | 'M26_RECOVERY_EVIDENCE_INVALID';
  evidence?: M23Evidence;
  eventCount?: number;
  truncated?: boolean;
  recoveryOperationStarted?: boolean;
  instrumentationTransportFailed?: boolean;
};
