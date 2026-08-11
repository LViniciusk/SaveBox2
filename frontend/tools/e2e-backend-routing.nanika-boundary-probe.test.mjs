import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRealBoundary } from './e2e-backend-routing.nanika-boundary-probe.mjs';

function validEvidence() {
  return {
    navigationPassed: true,
    healthRouteMatched: true,
    loginRouteMatched: true,
    loginOriginMatchesFrontend: true,
    healthBrowserFetchResolved: true,
    healthResponseObserved: true,
    healthStatus: 200,
    healthRequestFailureClass: null,
    healthCorsAllowOriginMatchesFrontend: true,
    loginBrowserFetchResolved: true,
    loginResponseObserved: true,
    loginStatus: 401,
    loginStatusClass: '4xx',
    loginRequestFailureClass: null,
    loginCorsAllowOriginMatchesFrontend: true,
  };
}

test('classifies the real browser boundary success', () => {
  assert.equal(classifyRealBoundary(validEvidence()), 'PASS_REAL_BROWSER_BOUNDARY');
});

test('classifies a missing health route', () => {
  assert.equal(classifyRealBoundary({ ...validEvidence(), healthRouteMatched: false }), 'HEALTH_ROUTE_NOT_MATCHED');
});

test('classifies a health browser transport failure', () => {
  assert.equal(classifyRealBoundary({
    ...validEvidence(),
    healthBrowserFetchResolved: false,
    healthResponseObserved: false,
    healthStatus: null,
    healthRequestFailureClass: 'net::ERR_FAILED',
  }), 'REAL_BACKEND_HEALTH_BROWSER_TRANSPORT_FAILED');
});

test('keeps an unexpected health HTTP status distinct from transport failure', () => {
  assert.equal(classifyRealBoundary({ ...validEvidence(), healthStatus: 503 }), 'REAL_BACKEND_HEALTH_HTTP_UNEXPECTED');
});

test('classifies a missing login route', () => {
  assert.equal(classifyRealBoundary({ ...validEvidence(), loginRouteMatched: false }), 'LOGIN_ROUTE_NOT_MATCHED');
});

test('classifies a login Origin mismatch', () => {
  assert.equal(classifyRealBoundary({ ...validEvidence(), loginOriginMatchesFrontend: false }), 'REAL_LOGIN_ORIGIN_MISMATCH');
});

test('classifies a login browser transport failure', () => {
  assert.equal(classifyRealBoundary({
    ...validEvidence(),
    loginBrowserFetchResolved: false,
    loginResponseObserved: false,
    loginStatus: null,
    loginStatusClass: null,
    loginRequestFailureClass: 'net::ERR_FAILED',
  }), 'REAL_BACKEND_LOGIN_BROWSER_TRANSPORT_FAILED');
});

test('accepts HTTP 401 as a real transport response', () => {
  assert.equal(classifyRealBoundary({ ...validEvidence(), loginStatus: 401 }), 'PASS_REAL_BROWSER_BOUNDARY');
});

test('keeps HTTP 403 transport success separate from login semantics', () => {
  assert.equal(classifyRealBoundary({ ...validEvidence(), loginStatus: 403, loginStatusClass: '4xx' }), 'PASS_REAL_BROWSER_BOUNDARY');
});

test('rejects structurally contradictory response evidence', () => {
  assert.equal(classifyRealBoundary({ ...validEvidence(), loginResponseObserved: true, loginStatus: null }), 'PROBE_EVIDENCE_INVALID');
});
