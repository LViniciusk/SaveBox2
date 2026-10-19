import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_LOGIN_EVENTS,
  appendLoginEvent,
  classifyCredentialLoginBoundary,
  classifyLoginUiError,
  safeLoginPath,
  safeRequestFailure,
  summarizeLoginDiagnostic,
} from './e2e-login-diagnostics.mjs';

function validBoundaryEvidence(overrides = {}) {
  return {
    pageReady: true,
    loginActionTriggered: true,
    requestCount: 1,
    methodPost: true,
    bodyShapeValid: true,
    fixtureUsernameMatches: true,
    fixturePasswordMatches: true,
    originMatches: true,
    authorizationHeaderPresent: false,
    requestFailure: 'none',
    responseCount: 1,
    responseObserved: true,
    responseStatus: 200,
    backendAuthorityMatches: true,
    httpSemanticPassed: true,
    finalPath: '/drive/home',
    uiError: 'none',
    ...overrides,
  };
}

test('allowlists login paths and removes query strings and fragments', () => {
  assert.equal(safeLoginPath('http://localhost:4200/login?token=SECRET#state'), '/login');
  assert.equal(safeLoginPath('http://localhost:4200/drive/home#SECRET'), '/drive/home');
  assert.equal(safeLoginPath('http://localhost:4200/private'), undefined);
});

test('preserves only classified network failures', () => {
  assert.equal(safeRequestFailure('net::ERR_CONNECTION_RESET'), 'net::ERR_CONNECTION_RESET');
  assert.equal(safeRequestFailure('PASSWORD=SUPER_SECRET'), 'REQUEST_FAILED');
});

test('classifies visible login errors without returning their text', () => {
  assert.equal(classifyLoginUiError(false, 'SUPER_SECRET'), 'none');
  assert.equal(classifyLoginUiError(true, 'Conta não verificada'), 'verification-required');
  assert.equal(classifyLoginUiError(true, 'Senha inválida'), 'credentials-invalid');
  assert.equal(classifyLoginUiError(true, 'SUPER_SECRET_JWT'), 'other-present');
});

test('bounds event storage and keeps secrets out of the summary', () => {
  const events = [];
  for (let index = 0; index < MAX_LOGIN_EVENTS; index += 1) {
    assert.equal(appendLoginEvent(events, { kind: 'login-request', atMs: index }), true);
  }
  assert.equal(appendLoginEvent(events, { kind: 'login-request', atMs: 99 }), false);
  const summary = summarizeLoginDiagnostic({
    events,
    loginRequestCount: 1,
    responseStatus: 200,
    path: '/login',
    requestFailure: 'PASSWORD=SUPER_SECRET',
    uiError: 'other-present',
    truncated: true,
  });
  assert.equal(events.length, MAX_LOGIN_EVENTS);
  assert.equal(summary.includes('SUPER_SECRET'), false);
  assert.equal(summary.includes('PASSWORD'), false);
  assert.equal(summary.includes('truncated=true'), true);
});

test('classifies a complete actual credential-login boundary as pass', () => {
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence()), 'PASS_ACTUAL_ANGULAR_CREDENTIAL_LOGIN');
});

test('classifies evidence contradictions before causal failures', () => {
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ responseCount: 0 })), 'PROBE_EVIDENCE_INVALID');
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ requestCount: 0 })), 'PROBE_EVIDENCE_INVALID');
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ finalPath: '/drive/home', responseObserved: false, responseCount: 0, responseStatus: undefined })), 'PROBE_EVIDENCE_INVALID');
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ requestFailure: 'net::ERR_FAILED' })), 'PROBE_EVIDENCE_INVALID');
  assert.equal(classifyCredentialLoginBoundary(null), 'PROBE_EVIDENCE_INVALID');
});

test('classifies readiness, click and missing request in causal order', () => {
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ pageReady: false, loginActionTriggered: false, requestCount: 0, responseCount: 0, responseObserved: false, responseStatus: undefined, backendAuthorityMatches: false, httpSemanticPassed: false, finalPath: '/login' })), 'LOGIN_PAGE_NOT_READY');
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ loginActionTriggered: false, requestCount: 0, responseCount: 0, responseObserved: false, responseStatus: undefined, backendAuthorityMatches: false, httpSemanticPassed: false, finalPath: '/login' })), 'LOGIN_ACTION_NOT_TRIGGERED');
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ requestCount: 0, responseCount: 0, responseObserved: false, responseStatus: undefined, backendAuthorityMatches: false, httpSemanticPassed: false, finalPath: '/login' })), 'FRONTEND_LOGIN_REQUEST_NOT_EMITTED');
});

test('classifies request count, method, body and fixture fidelity', () => {
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ requestCount: 2, responseCount: 0, responseObserved: false, responseStatus: undefined, backendAuthorityMatches: false, httpSemanticPassed: false, finalPath: '/login' })), 'LOGIN_REQUEST_COUNT_INVALID');
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ methodPost: false, responseCount: 0, responseObserved: false, responseStatus: undefined, backendAuthorityMatches: false, httpSemanticPassed: false, finalPath: '/login' })), 'LOGIN_REQUEST_METHOD_INVALID');
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ bodyShapeValid: false, responseCount: 0, responseObserved: false, responseStatus: undefined, backendAuthorityMatches: false, httpSemanticPassed: false, finalPath: '/login' })), 'LOGIN_REQUEST_BODY_INVALID');
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ fixturePasswordMatches: false, responseCount: 0, responseObserved: false, responseStatus: undefined, backendAuthorityMatches: false, httpSemanticPassed: false, finalPath: '/login' })), 'LOGIN_REQUEST_FIXTURE_MISMATCH');
});

test('classifies origin, unexpected authorization and transport independently', () => {
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ originMatches: false, responseCount: 0, responseObserved: false, responseStatus: undefined, backendAuthorityMatches: false, httpSemanticPassed: false, finalPath: '/login' })), 'LOGIN_REQUEST_ORIGIN_MISMATCH');
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ authorizationHeaderPresent: true, responseCount: 0, responseObserved: false, responseStatus: undefined, backendAuthorityMatches: false, httpSemanticPassed: false, finalPath: '/login' })), 'LOGIN_REQUEST_AUTHORIZATION_UNEXPECTED');
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ requestFailure: 'net::ERR_CONNECTION_RESET', responseCount: 0, responseObserved: false, responseStatus: undefined, backendAuthorityMatches: false, httpSemanticPassed: false, finalPath: '/login' })), 'ANGULAR_LOGIN_TRANSPORT_FAILED');
});

test('distinguishes absent response, wrong backend authority and HTTP semantics', () => {
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ responseCount: 0, responseObserved: false, responseStatus: undefined, backendAuthorityMatches: false, httpSemanticPassed: false, finalPath: '/login' })), 'LOGIN_RESPONSE_NOT_OBSERVED');
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ backendAuthorityMatches: false, httpSemanticPassed: false, finalPath: '/login' })), 'LOGIN_RESPONSE_AUTHORITY_MISMATCH');
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ responseStatus: 401, httpSemanticPassed: false, finalPath: '/login' })), 'LOGIN_HTTP_SEMANTIC_FAILURE');
});

test('requires completed drive navigation after successful HTTP', () => {
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ finalPath: '/login' })), 'LOGIN_NAVIGATION_NOT_COMMITTED');
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ finalPath: '/drive/setup' })), 'PASS_ACTUAL_ANGULAR_CREDENTIAL_LOGIN');
});

test('rejects malformed or unsafe evidence fields', () => {
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ requestCount: -1 })), 'PROBE_EVIDENCE_INVALID');
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ responseStatus: 700 })), 'PROBE_EVIDENCE_INVALID');
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ requestFailure: 'SECRET_TOKEN' })), 'PROBE_EVIDENCE_INVALID');
  assert.equal(classifyCredentialLoginBoundary(validBoundaryEvidence({ finalPath: 'http://localhost/private' })), 'PROBE_EVIDENCE_INVALID');
});
