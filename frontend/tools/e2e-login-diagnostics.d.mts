export const MAX_LOGIN_EVENTS: 16;
export type SafeLoginPath = '/login' | '/drive' | '/drive/home' | '/drive/setup';
export type LoginDiagnosticKind =
  | 'login-page-ready'
  | 'login-clicked'
  | 'login-request'
  | 'login-response'
  | 'login-finished'
  | 'login-failed'
  | 'login-navigation'
  | 'login-navigation-complete'
  | 'login-ui-error';
export interface LoginDiagnosticEvent {
  kind: LoginDiagnosticKind;
  atMs: number;
  status?: number;
  elapsedMs?: number;
  path?: SafeLoginPath;
}
export function safeLoginPath(rawUrl: string): SafeLoginPath | undefined;
export function safeRequestFailure(value?: string | null): string;
export function classifyLoginUiError(present: boolean, text?: string): 'none' | 'verification-required' | 'credentials-invalid' | 'other-present';
export function appendLoginEvent(events: LoginDiagnosticEvent[], event: LoginDiagnosticEvent): boolean;
export function summarizeLoginDiagnostic(input: {
  events: LoginDiagnosticEvent[];
  loginRequestCount: number;
  responseStatus?: number;
  requestFailure?: string;
  path?: SafeLoginPath;
  uiError?: 'none' | 'verification-required' | 'credentials-invalid' | 'other-present';
  truncated: boolean;
}): string;
export type CredentialLoginBoundaryResult =
  | 'PASS_ACTUAL_ANGULAR_CREDENTIAL_LOGIN'
  | 'PROBE_EVIDENCE_INVALID'
  | 'LOGIN_PAGE_NOT_READY'
  | 'LOGIN_ACTION_NOT_TRIGGERED'
  | 'FRONTEND_LOGIN_REQUEST_NOT_EMITTED'
  | 'LOGIN_REQUEST_COUNT_INVALID'
  | 'LOGIN_REQUEST_METHOD_INVALID'
  | 'LOGIN_REQUEST_BODY_INVALID'
  | 'LOGIN_REQUEST_FIXTURE_MISMATCH'
  | 'LOGIN_REQUEST_ORIGIN_MISMATCH'
  | 'LOGIN_REQUEST_AUTHORIZATION_UNEXPECTED'
  | 'ANGULAR_LOGIN_TRANSPORT_FAILED'
  | 'LOGIN_RESPONSE_NOT_OBSERVED'
  | 'LOGIN_RESPONSE_AUTHORITY_MISMATCH'
  | 'LOGIN_HTTP_SEMANTIC_FAILURE'
  | 'LOGIN_NAVIGATION_NOT_COMMITTED';
export interface CredentialLoginBoundaryEvidence {
  pageReady: boolean;
  loginActionTriggered: boolean;
  requestCount: number;
  methodPost: boolean;
  bodyShapeValid: boolean;
  fixtureUsernameMatches: boolean;
  fixturePasswordMatches: boolean;
  originMatches: boolean;
  authorizationHeaderPresent: boolean;
  requestFailure: string;
  responseCount: number;
  responseObserved: boolean;
  responseStatus?: number;
  backendAuthorityMatches: boolean;
  httpSemanticPassed: boolean;
  finalPath: '/login' | '/drive/setup' | '/drive/home' | 'unknown';
  uiError: 'none' | 'verification-required' | 'credentials-invalid' | 'other-present';
}
export function classifyCredentialLoginBoundary(evidence: CredentialLoginBoundaryEvidence): CredentialLoginBoundaryResult;
