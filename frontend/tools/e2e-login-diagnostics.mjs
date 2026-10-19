export const MAX_LOGIN_EVENTS = 16;

const M20_RESULTS = new Set([
  'PASS_ACTUAL_ANGULAR_CREDENTIAL_LOGIN',
  'PROBE_EVIDENCE_INVALID',
  'LOGIN_PAGE_NOT_READY',
  'LOGIN_ACTION_NOT_TRIGGERED',
  'FRONTEND_LOGIN_REQUEST_NOT_EMITTED',
  'LOGIN_REQUEST_COUNT_INVALID',
  'LOGIN_REQUEST_METHOD_INVALID',
  'LOGIN_REQUEST_BODY_INVALID',
  'LOGIN_REQUEST_FIXTURE_MISMATCH',
  'LOGIN_REQUEST_ORIGIN_MISMATCH',
  'LOGIN_REQUEST_AUTHORIZATION_UNEXPECTED',
  'ANGULAR_LOGIN_TRANSPORT_FAILED',
  'LOGIN_RESPONSE_NOT_OBSERVED',
  'LOGIN_RESPONSE_AUTHORITY_MISMATCH',
  'LOGIN_HTTP_SEMANTIC_FAILURE',
  'LOGIN_NAVIGATION_NOT_COMMITTED',
]);

const M20_PATHS = new Set(['/login', '/drive/setup', '/drive/home', 'unknown']);
const M20_UI_ERRORS = new Set(['none', 'verification-required', 'credentials-invalid', 'other-present']);

const SAFE_PATHS = new Set(['/login', '/drive', '/drive/home', '/drive/setup']);
const SAFE_KINDS = new Set([
  'login-page-ready',
  'login-clicked',
  'login-request',
  'login-response',
  'login-finished',
  'login-failed',
  'login-navigation',
  'login-navigation-complete',
  'login-ui-error',
]);

export function safeLoginPath(rawUrl) {
  try {
    const path = new URL(rawUrl).pathname;
    return SAFE_PATHS.has(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

export function safeRequestFailure(value) {
  return value && /^net::ERR_[A-Z0-9_]+$/.test(value)
    ? value.slice(0, 96)
    : 'REQUEST_FAILED';
}

export function classifyLoginUiError(present, text = '') {
  if (!present) return 'none';
  const normalized = text.toLowerCase();
  if (normalized.includes('verific')) return 'verification-required';
  if (normalized.includes('credenc') || normalized.includes('senha')) return 'credentials-invalid';
  return 'other-present';
}

export function appendLoginEvent(events, event) {
  if (events.length >= MAX_LOGIN_EVENTS) return false;
  if (!SAFE_KINDS.has(event.kind)) return false;
  events.push({
    kind: event.kind,
    ...(Number.isFinite(event.atMs) ? { atMs: Math.max(0, Math.round(event.atMs)) } : {}),
    ...(Number.isInteger(event.status) ? { status: event.status } : {}),
    ...(Number.isFinite(event.elapsedMs) ? { elapsedMs: Math.max(0, Math.round(event.elapsedMs)) } : {}),
    ...(safeLoginPath(`http://login.invalid${event.path ?? ''}`) ? { path: event.path } : {}),
  });
  return true;
}

export function summarizeLoginDiagnostic({
  events,
  loginRequestCount,
  responseStatus,
  requestFailure,
  path,
  uiError,
  truncated,
}) {
  const last = events.at(-1)?.kind ?? 'none';
  const safeStatus = Number.isInteger(responseStatus) ? responseStatus : 'none';
  const safePath = safeLoginPath(`http://login.invalid${path ?? ''}`) ?? 'unknown';
  const safeFailure = requestFailure ? safeRequestFailure(requestFailure) : 'none';
  const safeUiError = ['none', 'verification-required', 'credentials-invalid', 'other-present'].includes(uiError)
    ? uiError
    : 'none';
  return `E2E login navigation failed (last=${last},status=${safeStatus},path=${safePath},uiError=${safeUiError},requestCount=${loginRequestCount},requestFailure=${safeFailure},truncated=${Boolean(truncated)})`;
}

export function classifyCredentialLoginBoundary(evidence) {
  if (!isM20Evidence(evidence)) return 'PROBE_EVIDENCE_INVALID';

  const hasResponse = evidence.responseCount > 0;
  const isDrivePath = evidence.finalPath === '/drive/setup' || evidence.finalPath === '/drive/home';
  const hasRequest = evidence.requestCount > 0;
  const hasHttpSuccess = evidence.responseStatus >= 200 && evidence.responseStatus < 300;

  if (
    evidence.responseCount > evidence.requestCount ||
    evidence.responseObserved !== hasResponse ||
    (hasResponse && evidence.responseStatus === undefined) ||
    (!hasResponse && evidence.responseStatus !== undefined) ||
    (hasResponse && evidence.requestFailure !== 'none') ||
    (isDrivePath && !hasResponse) ||
    (evidence.httpSemanticPassed && (!hasResponse || !hasHttpSuccess)) ||
    (evidence.backendAuthorityMatches && !hasResponse) ||
    (hasRequest && !evidence.loginActionTriggered) ||
    (evidence.loginActionTriggered && !evidence.pageReady)
  ) {
    return 'PROBE_EVIDENCE_INVALID';
  }

  if (!evidence.pageReady) return 'LOGIN_PAGE_NOT_READY';
  if (!evidence.loginActionTriggered) return 'LOGIN_ACTION_NOT_TRIGGERED';
  if (!hasRequest) return 'FRONTEND_LOGIN_REQUEST_NOT_EMITTED';
  if (evidence.requestCount !== 1) return 'LOGIN_REQUEST_COUNT_INVALID';
  if (!evidence.methodPost) return 'LOGIN_REQUEST_METHOD_INVALID';
  if (!evidence.bodyShapeValid) return 'LOGIN_REQUEST_BODY_INVALID';
  if (!evidence.fixtureUsernameMatches || !evidence.fixturePasswordMatches) {
    return 'LOGIN_REQUEST_FIXTURE_MISMATCH';
  }
  if (!evidence.originMatches) return 'LOGIN_REQUEST_ORIGIN_MISMATCH';
  if (evidence.authorizationHeaderPresent) return 'LOGIN_REQUEST_AUTHORIZATION_UNEXPECTED';
  if (evidence.requestFailure !== 'none') return 'ANGULAR_LOGIN_TRANSPORT_FAILED';
  if (!hasResponse) return 'LOGIN_RESPONSE_NOT_OBSERVED';
  if (!evidence.backendAuthorityMatches) return 'LOGIN_RESPONSE_AUTHORITY_MISMATCH';
  if (!evidence.httpSemanticPassed) return 'LOGIN_HTTP_SEMANTIC_FAILURE';
  if (!isDrivePath) return 'LOGIN_NAVIGATION_NOT_COMMITTED';
  return 'PASS_ACTUAL_ANGULAR_CREDENTIAL_LOGIN';
}

function isM20Evidence(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const bools = [
    'pageReady', 'loginActionTriggered', 'methodPost', 'bodyShapeValid',
    'fixtureUsernameMatches', 'fixturePasswordMatches', 'originMatches',
    'authorizationHeaderPresent', 'responseObserved', 'backendAuthorityMatches',
    'httpSemanticPassed',
  ];
  if (!bools.every(key => typeof value[key] === 'boolean')) return false;
  if (!Number.isInteger(value.requestCount) || value.requestCount < 0) return false;
  if (!Number.isInteger(value.responseCount) || value.responseCount < 0) return false;
  if (value.responseStatus !== undefined && (!Number.isInteger(value.responseStatus) || value.responseStatus < 0 || value.responseStatus > 599)) return false;
  if (!M20_PATHS.has(value.finalPath) || !M20_UI_ERRORS.has(value.uiError)) return false;
  if (typeof value.requestFailure !== 'string') return false;
  return value.requestFailure === 'none' || value.requestFailure === 'REQUEST_FAILED' || /^net::ERR_[A-Z0-9_]{1,80}$/.test(value.requestFailure);
}
