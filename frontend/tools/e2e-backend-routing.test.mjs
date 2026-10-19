import assert from 'node:assert/strict';
import test from 'node:test';
import {
  installE2EBackendRouting,
  resolveE2EBackendOrigin,
  rewriteE2EBackendRequestUrl,
} from './e2e-backend-routing.mjs';

test('derives the default backend from the default frontend', () => {
  assert.equal(resolveE2EBackendOrigin({ NANIKA_E2E_BASE_URL: 'http://localhost:4200' }), 'http://localhost:8080');
});

test('uses the explicit disposable backend as the single authority', () => {
  assert.equal(resolveE2EBackendOrigin({ NANIKA_E2E_BACKEND_URL: 'http://127.0.0.1:18082' }), 'http://127.0.0.1:18082');
});

test('accepts only exact loopback hosts', () => {
  for (const origin of ['http://localhost:18082', 'http://127.0.0.1:18082', 'http://[::1]:18082']) {
    assert.equal(resolveE2EBackendOrigin({ NANIKA_E2E_BACKEND_URL: origin }), origin);
  }
  for (const origin of ['http://evil-localhost.example:18082', 'http://localhost.attacker.example:18082']) {
    assert.throws(() => resolveE2EBackendOrigin({ NANIKA_E2E_BACKEND_URL: origin }));
  }
});

test('rejects remote, credentialed, path, query, hash and invalid-port authorities', () => {
  for (const origin of [
    'https://example.com:18082',
    'http://example.com:18082',
    'http://user:password@localhost:18082',
    'http://localhost:18082/backend',
    'http://localhost:18082/?x=1',
    'http://localhost:18082/#fragment',
    'http://localhost',
    'http://localhost:0',
  ]) {
    assert.throws(() => resolveE2EBackendOrigin({ NANIKA_E2E_BACKEND_URL: origin }));
  }
});

test('rewrites only the origin and preserves path and query', () => {
  assert.equal(
    rewriteE2EBackendRequestUrl(
      'http://localhost:8080/files/42/chunks?index=3',
      'http://127.0.0.1:18082',
    ),
    'http://127.0.0.1:18082/files/42/chunks?index=3',
  );
});

test('does not register a route when the authority is the default backend', async () => {
  let registered = 0;
  await installE2EBackendRouting({ route: async () => { registered += 1; } }, {
    NANIKA_E2E_BASE_URL: 'http://localhost:4200',
  });
  assert.equal(registered, 0);
});

test('registers one route for an explicit disposable backend', async () => {
  let pattern;
  let handler;
  await installE2EBackendRouting({
    async route(nextPattern, nextHandler) {
      pattern = nextPattern;
      handler = nextHandler;
    },
  }, { NANIKA_E2E_BACKEND_URL: 'http://127.0.0.1:18082' });

  assert.equal(pattern, 'http://localhost:8080/**');
  const continued = [];
  await handler({
    request: () => ({ url: () => 'http://localhost:8080/login?next=%2Fdrive' }),
    continue: async options => continued.push(options),
  });
  assert.deepEqual(continued, [{ url: 'http://127.0.0.1:18082/login?next=%2Fdrive' }]);
});
