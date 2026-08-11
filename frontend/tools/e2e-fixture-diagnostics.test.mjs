import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fixtureFailureCode,
  formatFixtureFailure,
  parseFixtureResponse,
} from './e2e-fixture-diagnostics.mjs';

test('extracts one allowlisted code with CRLF and surrounding whitespace', () => {
  assert.equal(fixtureFailureCode(' warning\r\n  FIXTURE_INPUT_INVALID \r\n'), 'FIXTURE_INPUT_INVALID');
});

test('ignores unknown stderr and returns only the generic message', () => {
  const stderr = 'password=DO_NOT_LEAK\nunknown native failure';
  const message = formatFixtureFailure('provision', stderr);
  assert.equal(message, 'E2E fixture provision failed');
  assert.equal(message.includes('DO_NOT_LEAK'), false);
});

test('does not expose connection or path sentinels around a safe code', () => {
  const stderr = 'postgresql://user:SECRET_SENTINEL@host/db\nC:\\SECRET_PATH_SENTINEL\\storage\nFIXTURE_DB_OPERATION_FAILED';
  const message = formatFixtureFailure('provision', stderr);
  assert.equal(message, 'E2E fixture provision failed (FIXTURE_DB_OPERATION_FAILED)');
  assert.equal(message.includes('SECRET_SENTINEL'), false);
  assert.equal(message.includes('SECRET_PATH_SENTINEL'), false);
});

test('ambiguous safe codes fail closed', () => {
  assert.equal(fixtureFailureCode('FIXTURE_DB_OPERATION_FAILED\nFIXTURE_INTERNAL_ERROR'), undefined);
  assert.equal(formatFixtureFailure('cleanup', 'FIXTURE_DB_OPERATION_FAILED\nFIXTURE_INTERNAL_ERROR'), 'E2E fixture cleanup failed');
});

test('parses provision only with a positive safe user id', () => {
  assert.deepEqual(parseFixtureResponse('provision', '{"ok":true,"user_id":7}'), []);
  assert.throws(() => parseFixtureResponse('provision', '{"ok":true,"user_id":0}'), /invalid response/);
  assert.throws(() => parseFixtureResponse('provision', '{"ok":true,"user_id":9007199254740992}'), /invalid response/);
});

test('parses cleanup only with positive safe file ids', () => {
  assert.deepEqual(parseFixtureResponse('cleanup', '{"ok":true,"removed_file_ids":[2,4]}'), [2, 4]);
  assert.throws(() => parseFixtureResponse('cleanup', '{"ok":true,"removed_file_ids":[0]}'), /invalid response/);
  assert.throws(() => parseFixtureResponse('cleanup', '{"ok":true,"removed_file_ids":[9007199254740992]}'), /invalid response/);
});

test('rejects malformed JSON and non-record responses without echoing input', () => {
  const secretInput = 'SECRET_RESPONSE_SENTINEL not-json';
  assert.throws(() => parseFixtureResponse('provision', secretInput), error => {
    assert.equal(error.message, 'E2E fixture provision returned an invalid response');
    assert.equal(error.message.includes('SECRET_RESPONSE_SENTINEL'), false);
    return true;
  });
  assert.throws(() => parseFixtureResponse('cleanup', '[]'), /invalid response/);
});
