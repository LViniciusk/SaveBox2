import { writeFile } from 'node:fs/promises';
import { test, expect } from '../e2e/support/fixtures';
import type { Request, Response } from '@playwright/test';
import { loginToDrive, type E2ECredentials } from '../e2e/support/session';
import {
  classifyCredentialLoginBoundary,
  classifyLoginUiError,
  safeLoginPath,
  safeRequestFailure,
  type CredentialLoginBoundaryEvidence,
} from '../tools/e2e-login-diagnostics.mjs';
import { resolveE2EBackendOrigin } from '../tools/e2e-backend-routing.mjs';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesCredentialBody(body: unknown, credentials: E2ECredentials): {
  shape: boolean;
  username: boolean;
  password: boolean;
} {
  if (!isRecord(body)) return { shape: false, username: false, password: false };
  const keys = Object.keys(body).sort();
  const shape = keys.length === 2 && keys[0] === 'password' && keys[1] === 'username' &&
    typeof body['username'] === 'string' && typeof body['password'] === 'string';
  return {
    shape,
    username: shape && body['username'] === credentials.username,
    password: shape && body['password'] === credentials.password,
  };
}

test('observes the current Angular credential login boundary', async ({ page, credentials }) => {
  test.setTimeout(30_000);
  const expectedFrontendOrigin = new URL(process.env['NANIKA_E2E_BASE_URL']!).origin;
  const expectedBackendOrigin = resolveE2EBackendOrigin(process.env);
  const resultPath = process.env['NANIKA_M20_RESULT_PATH']!;
  const matchingRequests = new WeakSet<object>();
  let pageReady = false;
  let loginActionTriggered = false;
  let requestCount = 0;
  let methodPost = false;
  let bodyShapeValid = false;
  let fixtureUsernameMatches = false;
  let fixturePasswordMatches = false;
  let originMatches = false;
  let authorizationHeaderPresent = false;
  let requestFailure = 'none';
  let responseCount = 0;
  let responseStatus: number | undefined;
  let backendAuthorityMatches = false;
  let finalPath: CredentialLoginBoundaryEvidence['finalPath'] = 'unknown';
  let uiError: CredentialLoginBoundaryEvidence['uiError'] = 'none';

  const isLoginApiRequest = (request: Request): boolean => {
    try {
      const url = new URL(request.url());
      return request.method() !== 'OPTIONS' && url.pathname === '/login' && url.origin !== expectedFrontendOrigin;
    } catch {
      return false;
    }
  };
  const onRequest = (request: Request) => {
    if (!isLoginApiRequest(request)) return;
    requestCount += 1;
    matchingRequests.add(request);
    if (requestCount !== 1) return;

    methodPost = request.method() === 'POST';
    const headers = request.headers();
    originMatches = headers['origin'] === expectedFrontendOrigin;
    authorizationHeaderPresent = Object.prototype.hasOwnProperty.call(headers, 'authorization');
    let body: unknown;
    try {
      body = request.postDataJSON();
    } catch {
      body = undefined;
    }
    const comparison = matchesCredentialBody(body, credentials);
    bodyShapeValid = comparison.shape;
    fixtureUsernameMatches = comparison.username;
    fixturePasswordMatches = comparison.password;
  };
  const onResponse = (response: Response) => {
    if (!matchingRequests.has(response.request())) return;
    responseCount += 1;
    if (responseCount !== 1) return;
    responseStatus = response.status();
    try {
      const requestOrigin = new URL(response.request().url()).origin;
      const responseOrigin = new URL(response.url()).origin;
      backendAuthorityMatches = requestOrigin === expectedBackendOrigin && responseOrigin === expectedBackendOrigin;
    } catch {
      backendAuthorityMatches = false;
    }
  };
  const onRequestFailed = (request: Request) => {
    if (matchingRequests.has(request)) requestFailure = safeRequestFailure(request.failure()?.errorText);
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  try {
    await loginToDrive(page, credentials, {
      timeoutMs: 20_000,
      onPageReady: () => { pageReady = true; },
      onLoginActionTriggered: () => { loginActionTriggered = true; },
    });
  } catch {
    // The structured evidence below is the only persisted failure detail.
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
    const path = safeLoginPath(page.url());
    finalPath = path === '/login' || path === '/drive/setup' || path === '/drive/home' ? path : 'unknown';
    const banner = page.locator('.error-banner').first();
    const visible = await banner.isVisible().catch(() => false);
    const text = visible ? await banner.innerText().catch(() => '') : '';
    uiError = classifyLoginUiError(visible, text);
    credentials.password = '';
    credentials.vaultPhrase = '';
  }

  const evidence: CredentialLoginBoundaryEvidence = {
    pageReady,
    loginActionTriggered,
    requestCount,
    methodPost,
    bodyShapeValid,
    fixtureUsernameMatches,
    fixturePasswordMatches,
    originMatches,
    authorizationHeaderPresent,
    requestFailure,
    responseCount,
    responseObserved: responseCount > 0,
    ...(responseStatus === undefined ? {} : { responseStatus }),
    backendAuthorityMatches,
    httpSemanticPassed: responseStatus !== undefined && responseStatus >= 200 && responseStatus < 300,
    finalPath,
    uiError,
  };
  const result = classifyCredentialLoginBoundary(evidence);
  const artifact = {
    round: 'B.90-R1.M20',
    result,
    secretsRecorded: false,
    login: evidence,
  };
  await writeFile(resultPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

  expect(result).toBe('PASS_ACTUAL_ANGULAR_CREDENTIAL_LOGIN');
});
