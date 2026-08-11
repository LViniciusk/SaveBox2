import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyScenario,
  makeMetrics,
  makeScenarioState,
} from './e2e-backend-routing.browser-characterization.mjs';

function validEvidence() {
  return {
    routeMatched: true,
    routeFailure: null,
    sourceBypassReceived: false,
    targetRequestReceived: true,
    preflightObserved: false,
    targetLoginReceived: true,
    browserResponseReceived: true,
    browserFetchFailed: false,
    originPreserved: true,
    methodPreserved: true,
    bodyHashMatch: true,
    responseBodyPreserved: true,
    cookiePreserved: true,
    authorizationPreserved: true,
    rangeRequestPreserved: true,
    rangePreserved: true,
    fallbackChainPreserved: true,
  };
}

test('creates fresh metrics and scenario state per execution', () => {
  const first = makeMetrics();
  const second = makeMetrics();
  assert.notEqual(first, second);
  assert.deepEqual(first, {
    preflight: false,
    requests: 0,
    loginReceived: false,
    loginOriginPreserved: false,
    bodyHashMatch: false,
    methodPreserved: false,
    cookieHeaderPresent: false,
    probeCookieReturned: false,
    authorizationReceived: false,
    rangeHeaderMatch: false,
    fallbackReceived: false,
  });
  assert.notEqual(makeScenarioState(), makeScenarioState());
});

test('classifies complete evidence as pass', () => {
  assert.equal(classifyScenario(validEvidence()), null);
});

test('gives explicit route failures precedence', () => {
  assert.equal(classifyScenario({ ...validEvidence(), routeFailure: 'ROUTE_FETCH_FAILED' }), 'ROUTE_FETCH_FAILED');
});

test('classifies an unmatched route', () => {
  assert.equal(classifyScenario({ ...validEvidence(), routeMatched: false }), 'ROUTE_NOT_MATCHED');
});

test('classifies a source bypass', () => {
  assert.equal(classifyScenario({ ...validEvidence(), sourceBypassReceived: true }), 'SOURCE_BYPASS_REACHED');
});

test('uses browser fetch failure only when a browser operation failed', () => {
  assert.equal(classifyScenario({
    ...validEvidence(),
    browserResponseReceived: false,
    browserFetchFailed: true,
    targetRequestReceived: false,
    targetLoginReceived: false,
    methodPreserved: false,
    bodyHashMatch: false,
    responseBodyPreserved: false,
    cookiePreserved: false,
    authorizationPreserved: false,
    rangeRequestPreserved: false,
    rangePreserved: false,
    fallbackChainPreserved: false,
  }), 'BROWSER_FETCH_FAILED');
});

test('rejects the contradictory M14 evidence state', () => {
  assert.equal(classifyScenario({
    ...validEvidence(),
    targetRequestReceived: false,
    targetLoginReceived: false,
  }), 'CHARACTERIZATION_EVIDENCE_INVALID');
});

test('classifies a missing login independently of preflight telemetry', () => {
  assert.equal(classifyScenario({ ...validEvidence(), targetLoginReceived: false }), 'TARGET_LOGIN_NOT_RECEIVED');
});

test('allows complete evidence when preflight was not observed', () => {
  assert.equal(classifyScenario({ ...validEvidence(), preflightObserved: false }), null);
});

test('treats preflight observation as informational', () => {
  const withoutPreflight = classifyScenario({ ...validEvidence(), preflightObserved: false });
  const withPreflight = classifyScenario({ ...validEvidence(), preflightObserved: true });
  assert.equal(withoutPreflight, withPreflight);
});

test('requires Origin fidelity on the target login request', () => {
  assert.equal(classifyScenario({ ...validEvidence(), originPreserved: false }), 'ORIGIN_NOT_PRESERVED');
});

test('rejects Origin evidence without a target request', () => {
  assert.equal(classifyScenario({
    ...validEvidence(),
    targetRequestReceived: false,
    targetLoginReceived: false,
    originPreserved: true,
  }), 'CHARACTERIZATION_EVIDENCE_INVALID');
});

test('classifies request and response fidelity failures', () => {
  assert.equal(classifyScenario({ ...validEvidence(), methodPreserved: false }), 'REQUEST_FIDELITY_FAILED');
  assert.equal(classifyScenario({ ...validEvidence(), bodyHashMatch: false }), 'REQUEST_FIDELITY_FAILED');
  assert.equal(classifyScenario({ ...validEvidence(), responseBodyPreserved: false }), 'RESPONSE_FIDELITY_FAILED');
});

test('classifies cookie, authorization, range and fallback failures', () => {
  assert.equal(classifyScenario({ ...validEvidence(), cookiePreserved: false }), 'COOKIE_NOT_PRESERVED');
  assert.equal(classifyScenario({ ...validEvidence(), authorizationPreserved: false }), 'AUTHORIZATION_NOT_PRESERVED');
  assert.equal(classifyScenario({ ...validEvidence(), rangeRequestPreserved: false }), 'RANGE_NOT_PRESERVED');
  assert.equal(classifyScenario({ ...validEvidence(), rangePreserved: false }), 'RANGE_NOT_PRESERVED');
  assert.equal(classifyScenario({ ...validEvidence(), fallbackChainPreserved: false }), 'FALLBACK_CHAIN_NOT_PRESERVED');
});

test('never labels a complete browser response as browser fetch failure', () => {
  const evidence = validEvidence();
  assert.notEqual(classifyScenario(evidence), 'BROWSER_FETCH_FAILED');
});
