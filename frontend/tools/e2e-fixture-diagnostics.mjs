const fixtureFailureCodes = new Set([
  'FIXTURE_GUARD_DISABLED',
  'FIXTURE_DATABASE_NOT_ISOLATED',
  'FIXTURE_STORAGE_NOT_CONFIGURED',
  'FIXTURE_STORAGE_IDENTITY_INVALID',
  'FIXTURE_STORAGE_ROOT_INVALID',
  'FIXTURE_STORAGE_UNAVAILABLE',
  'FIXTURE_STORAGE_IDENTITY_MISMATCH',
  'FIXTURE_COMMAND_INVALID',
  'FIXTURE_INPUT_INVALID',
  'FIXTURE_USERNAME_INVALID',
  'FIXTURE_CONFIG_MISSING',
  'FIXTURE_DB_OPERATION_FAILED',
  'FIXTURE_PASSWORD_HASH_FAILED',
  'FIXTURE_USER_ALREADY_EXISTS',
  'FIXTURE_CLEANUP_FAILED',
  'FIXTURE_INTERNAL_ERROR',
]);

export function fixtureFailureCode(stderr) {
  const codes = new Set(
    stderr
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => fixtureFailureCodes.has(line)),
  );
  return codes.size === 1 ? codes.values().next().value : undefined;
}

export function formatFixtureFailure(command, stderr) {
  const code = fixtureFailureCode(stderr);
  return code
    ? `E2E fixture ${command} failed (${code})`
    : `E2E fixture ${command} failed`;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseFixtureResponse(command, output) {
  let response;
  try {
    response = JSON.parse(output);
  } catch {
    throw new Error(`E2E fixture ${command} returned an invalid response`);
  }

  if (!isRecord(response) || response.ok !== true) {
    throw new Error(`E2E fixture ${command} returned an invalid response`);
  }

  if (command === 'provision') {
    if (!Number.isSafeInteger(response.user_id) || response.user_id <= 0) {
      throw new Error(`E2E fixture ${command} returned an invalid response`);
    }
    return [];
  }

  if (!Array.isArray(response.removed_file_ids) ||
      !response.removed_file_ids.every(id => Number.isSafeInteger(id) && id > 0)) {
    throw new Error(`E2E fixture ${command} returned an invalid response`);
  }
  return response.removed_file_ids;
}
