#!/usr/bin/env node
import { readFileSync, statSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { verify, createPublicKey, createHash } from 'node:crypto';

// Strict JSON parser that rejects duplicate keys, illegal formats, control chars, unpaired surrogates, and leading zeros
export function parseStrictJson(text, maxDepth = 16) {
  if (typeof text !== 'string') throw new Error('INPUT_NOT_STRING');
  // Strip UTF-8 BOM if present
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }
  if (text.length > 65536) throw new Error('DOCUMENT_TOO_LARGE');

  let pos = 0;
  function skipWhitespace() {
    while (pos < text.length && (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\n' || text[pos] === '\r')) {
      pos++;
    }
  }

  function parseValue(depth = 0) {
    if (depth > maxDepth) throw new Error('MAX_DEPTH_EXCEEDED');
    skipWhitespace();
    if (pos >= text.length) throw new Error('UNEXPECTED_EOF');
    const ch = text[pos];
    if (ch === '{') return parseObject(depth);
    if (ch === '[') return parseArray(depth);
    if (ch === '"') return parseString();
    if (ch === 't' && text.slice(pos, pos + 4) === 'true') { pos += 4; return true; }
    if (ch === 'f' && text.slice(pos, pos + 5) === 'false') { pos += 5; return false; }
    if (ch === 'n' && text.slice(pos, pos + 4) === 'null') { pos += 4; return null; }
    if (ch === '-' || (ch >= '0' && ch <= '9')) return parseNumber();
    throw new Error(`UNEXPECTED_CHAR: ${ch} at ${pos}`);
  }

  function parseString() {
    pos++; // skip opening quote
    let str = '';
    while (pos < text.length) {
      const ch = text[pos++];
      if (ch === '"') return str;
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        throw new Error(`INVALID_CONTROL_CHAR_IN_STRING: 0x${code.toString(16)} at ${pos - 1}`);
      }
      if (ch === '\\') {
        if (pos >= text.length) throw new Error('UNTERMINATED_ESCAPE');
        const esc = text[pos++];
        if (esc === '"') str += '"';
        else if (esc === '\\') str += '\\';
        else if (esc === '/') str += '/';
        else if (esc === 'b') str += '\b';
        else if (esc === 'f') str += '\f';
        else if (esc === 'n') str += '\n';
        else if (esc === 'r') str += '\r';
        else if (esc === 't') str += '\t';
        else if (esc === 'u') {
          if (pos + 4 > text.length) throw new Error('UNTERMINATED_UNICODE_ESCAPE');
          const hex = text.slice(pos, pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`INVALID_HEX_ESCAPE: \\u${hex}`);
          pos += 4;
          const uCode = parseInt(hex, 16);
          // High surrogate
          if (uCode >= 0xD800 && uCode <= 0xDBFF) {
            if (text.slice(pos, pos + 2) !== '\\u') {
              throw new Error('UNPAIRED_HIGH_SURROGATE');
            }
            pos += 2;
            const lowHex = text.slice(pos, pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) throw new Error('INVALID_LOW_SURROGATE_HEX');
            const lowCode = parseInt(lowHex, 16);
            if (lowCode < 0xDC00 || lowCode > 0xDFFF) {
              throw new Error('INVALID_LOW_SURROGATE');
            }
            pos += 4;
            const fullCode = 0x10000 + ((uCode - 0xD800) << 10) + (lowCode - 0xDC00);
            str += String.fromCodePoint(fullCode);
          } else if (uCode >= 0xDC00 && uCode <= 0xDFFF) {
            throw new Error('UNPAIRED_LOW_SURROGATE');
          } else {
            str += String.fromCharCode(uCode);
          }
        } else {
          throw new Error(`INVALID_ESCAPE: \\${esc}`);
        }
      } else {
        str += ch;
      }
    }
    throw new Error('UNTERMINATED_STRING');
  }

  function parseNumber() {
    const start = pos;
    if (text[pos] === '-') pos++;
    if (pos >= text.length) throw new Error('INVALID_NUMBER');
    if (text[pos] === '0') {
      pos++;
      if (pos < text.length && text[pos] >= '0' && text[pos] <= '9') {
        throw new Error('LEADING_ZERO_FORBIDDEN');
      }
    } else if (text[pos] >= '1' && text[pos] <= '9') {
      while (pos < text.length && text[pos] >= '0' && text[pos] <= '9') pos++;
    } else {
      throw new Error(`INVALID_NUMBER_CHAR: ${text[pos]}`);
    }

    if (pos < text.length && text[pos] === '.') {
      pos++;
      if (pos >= text.length || !(text[pos] >= '0' && text[pos] <= '9')) {
        throw new Error('FRACTION_MISSING_DIGITS');
      }
      while (pos < text.length && text[pos] >= '0' && text[pos] <= '9') pos++;
    }

    if (pos < text.length && (text[pos] === 'e' || text[pos] === 'E')) {
      pos++;
      if (pos < text.length && (text[pos] === '+' || text[pos] === '-')) pos++;
      if (pos >= text.length || !(text[pos] >= '0' && text[pos] <= '9')) {
        throw new Error('EXPONENT_MISSING_DIGITS');
      }
      while (pos < text.length && text[pos] >= '0' && text[pos] <= '9') pos++;
    }

    const numStr = text.slice(start, pos);
    const num = Number(numStr);
    if (!Number.isFinite(num)) throw new Error('NON_FINITE_NUMBER');
    return num;
  }

  function parseArray(depth) {
    pos++; // skip '['
    const arr = [];
    skipWhitespace();
    if (pos < text.length && text[pos] === ']') { pos++; return arr; }
    while (pos < text.length) {
      arr.push(parseValue(depth + 1));
      skipWhitespace();
      if (pos < text.length && text[pos] === ']') { pos++; return arr; }
      if (pos >= text.length || text[pos] !== ',') throw new Error(`EXPECTED_COMMA_AT ${pos}`);
      pos++; // skip ','
    }
    throw new Error('UNTERMINATED_ARRAY');
  }

  function parseObject(depth) {
    pos++; // skip '{'
    const obj = Object.create(null);
    const keysSeen = new Set();
    skipWhitespace();
    if (pos < text.length && text[pos] === '}') { pos++; return obj; }
    while (pos < text.length) {
      skipWhitespace();
      if (pos >= text.length || text[pos] !== '"') throw new Error(`EXPECTED_STRING_KEY_AT ${pos}`);
      const key = parseString();
      if (keysSeen.has(key) || Object.hasOwn(obj, key)) {
        throw new Error(`DUPLICATE_KEY: ${key}`);
      }
      keysSeen.add(key);
      skipWhitespace();
      if (pos >= text.length || text[pos] !== ':') throw new Error(`EXPECTED_COLON_AT ${pos}`);
      pos++; // skip ':'
      const val = parseValue(depth + 1);
      obj[key] = val;
      skipWhitespace();
      if (pos < text.length && text[pos] === '}') { pos++; return obj; }
      if (pos >= text.length || text[pos] !== ',') throw new Error(`EXPECTED_COMMA_OR_CLOSE_BRACE_AT ${pos}`);
      pos++; // skip ','
    }
    throw new Error('UNTERMINATED_OBJECT');
  }

  const result = parseValue(0);
  skipWhitespace();
  if (pos < text.length) throw new Error(`TRAILING_DATA: ${text.slice(pos, pos + 20)}`);
  return result;
}

// Canonical JSON serializer adhering to RFC 8785 subset
export function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

function fail(code, status, reason, extra = {}) {
  console.log(JSON.stringify({ status, reason, ...extra }));
  process.exit(code);
}

export function verifyAuthorizationFile(authPath, trustAnchorPath) {
  // 1. Verify paths and files
  let authStat;
  try {
    authStat = statSync(authPath);
    const lstat = lstatSync(authPath);
    if (lstat.isSymbolicLink()) {
      return fail(2, 'ERROR', 'R16_AUTHORIZATION_SYMLINK_REJECTED');
    }
  } catch (err) {
    return fail(2, 'ERROR', 'R16_AUTHORIZATION_FILE_NOT_FOUND', { detail: err.message });
  }

  if (authStat.size > 65536) {
    return fail(2, 'ERROR', 'R16_AUTHORIZATION_FILE_TOO_LARGE');
  }

  let authContent;
  try {
    authContent = readFileSync(authPath, 'utf8');
  } catch (err) {
    return fail(2, 'ERROR', 'R16_AUTHORIZATION_READ_ERROR', { detail: err.message });
  }

  let authDoc;
  try {
    authDoc = parseStrictJson(authContent);
  } catch (err) {
    return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID', { parseError: err.message });
  }

  // 2. Validate Authorization Schema
  if (!authDoc || typeof authDoc !== 'object' || Array.isArray(authDoc)) {
    return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID');
  }

  const expectedRootKeys = new Set(['schema', 'payload', 'signature', 'keyId']);
  const actualRootKeys = new Set(Object.keys(authDoc));
  if (actualRootKeys.size !== expectedRootKeys.size || [...actualRootKeys].some(k => !expectedRootKeys.has(k))) {
    return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID');
  }

  if (authDoc.schema !== 1) {
    return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID');
  }

  if (typeof authDoc.keyId !== 'string' || !/^[a-zA-Z0-9_\-\.]{1,64}$/.test(authDoc.keyId)) {
    return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID');
  }

  if (typeof authDoc.signature !== 'string') {
    return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID');
  }

  if (!/^[A-Za-z0-9+/=]{86,88}$/.test(authDoc.signature)) {
    return fail(1, 'INVALID', 'R16_AUTHORIZATION_SIGNATURE_ENCODING_INVALID');
  }

  // Canonical Base64 signature verification: exact 64 bytes and canonical encoding round-trip
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(authDoc.signature, 'base64');
  } catch {
    return fail(1, 'INVALID', 'R16_AUTHORIZATION_SIGNATURE_ENCODING_INVALID');
  }

  if (signatureBytes.length !== 64 || signatureBytes.toString('base64') !== authDoc.signature) {
    return fail(1, 'INVALID', 'R16_AUTHORIZATION_SIGNATURE_ENCODING_INVALID');
  }

  const payload = authDoc.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID');
  }

  const expectedPayloadKeys = new Set([
    'campaign', 'scope', 'implementationHead', 'taskSha256',
    'freezeSha256', 'authorityIdentity', 'budget'
  ]);
  const actualPayloadKeys = new Set(Object.keys(payload));
  if (actualPayloadKeys.size !== expectedPayloadKeys.size || [...actualPayloadKeys].some(k => !expectedPayloadKeys.has(k))) {
    return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID');
  }

  if (payload.campaign !== 'AP-06-R12-R16-native') {
    return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID');
  }

  if (payload.scope !== 'capability-only') {
    return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID');
  }

  if (typeof payload.implementationHead !== 'string' || !/^[0-9a-f]{40}$/.test(payload.implementationHead)) {
    return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID');
  }

  if (typeof payload.taskSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(payload.taskSha256)) {
    return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID');
  }

  if (typeof payload.freezeSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(payload.freezeSha256)) {
    return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID');
  }

  if (typeof payload.authorityIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(payload.authorityIdentity)) {
    return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID');
  }

  // Budget validation: strict integer types, no booleans, exact values
  const budget = payload.budget;
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
    return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID');
  }

  const expectedBudgetKeys = new Set(['capability', 'profiledA', 'profiledB', 'maximum', 'retries']);
  const actualBudgetKeys = new Set(Object.keys(budget));
  if (actualBudgetKeys.size !== expectedBudgetKeys.size || [...actualBudgetKeys].some(k => !expectedBudgetKeys.has(k))) {
    return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID');
  }

  for (const k of expectedBudgetKeys) {
    if (typeof budget[k] !== 'number' || !Number.isInteger(budget[k]) || typeof budget[k] === 'boolean') {
      return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID');
    }
  }

  if (budget.capability !== 1 || budget.profiledA !== 0 || budget.profiledB !== 0 ||
      budget.maximum !== 1 || budget.retries !== 0) {
    return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID');
  }

  // 3. Verify Trust Anchor Location and File
  const isTestHarness = process.env.AP06_TEST_HARNESS === '1';
  let anchorStat;
  try {
    anchorStat = statSync(trustAnchorPath);
    const lstat = lstatSync(trustAnchorPath);
    if (lstat.isSymbolicLink()) {
      return fail(2, 'ERROR', 'R16_AUTHORIZATION_TRUST_ANCHOR_SYMLINK_REJECTED');
    }
  } catch (err) {
    return fail(2, 'ERROR', 'R16_AUTHORIZATION_TRUST_ANCHOR_MISSING', { detail: err.message });
  }

  if (!isTestHarness) {
    const resolvedAnchor = resolve(trustAnchorPath);
    const resolvedCwd = resolve(process.cwd());
    if (resolvedAnchor.startsWith(resolvedCwd) || resolvedAnchor.includes('.quality') || resolvedAnchor.includes('baseline')) {
      return fail(2, 'ERROR', 'R16_AUTHORIZATION_TRUST_ANCHOR_UNTRUSTED_LOCATION');
    }
  }

  let anchorContent;
  try {
    anchorContent = readFileSync(trustAnchorPath, 'utf8');
  } catch (err) {
    return fail(2, 'ERROR', 'R16_AUTHORIZATION_TRUST_ANCHOR_READ_ERROR', { detail: err.message });
  }

  let anchorDoc;
  try {
    anchorDoc = parseStrictJson(anchorContent);
  } catch (err) {
    return fail(2, 'ERROR', 'R16_AUTHORIZATION_TRUST_ANCHOR_INVALID', { parseError: err.message });
  }

  if (!anchorDoc || typeof anchorDoc !== 'object' || anchorDoc.schema !== 1 || !anchorDoc.keys || typeof anchorDoc.keys !== 'object') {
    return fail(2, 'ERROR', 'R16_AUTHORIZATION_TRUST_ANCHOR_INVALID');
  }

  const keyConfig = anchorDoc.keys[authDoc.keyId];
  if (!keyConfig || typeof keyConfig !== 'object') {
    return fail(3, 'ERROR', 'R16_AUTHORIZATION_KEY_NOT_FOUND', { keyId: authDoc.keyId });
  }

  if (keyConfig.algorithm !== 'ed25519' || typeof keyConfig.publicKey !== 'string') {
    return fail(3, 'ERROR', 'R16_AUTHORIZATION_ALGORITHM_UNSUPPORTED');
  }

  // 4. Ed25519 Cryptographic Verification with SPKI DER Fingerprint
  let pubKeyObj;
  try {
    pubKeyObj = createPublicKey(keyConfig.publicKey);
  } catch (err) {
    return fail(2, 'ERROR', 'R16_AUTHORIZATION_PUBLIC_KEY_INVALID', { detail: err.message });
  }

  if (pubKeyObj.asymmetricKeyType !== 'ed25519') {
    return fail(2, 'ERROR', 'R16_AUTHORIZATION_KEY_TYPE_INVALID');
  }

  const der = pubKeyObj.export({ type: 'spki', format: 'der' });
  const derFingerprint = createHash('sha256').update(der).digest('hex');

  // Verify SPKI DER Fingerprint against trust anchor config
  const expectedFingerprint = (keyConfig.spkiFingerprint || keyConfig.fingerprint || '').toLowerCase();
  if (!expectedFingerprint || derFingerprint !== expectedFingerprint) {
    return fail(2, 'ERROR', 'R16_AUTHORIZATION_TRUST_ANCHOR_FINGERPRINT_MISMATCH');
  }

  // Verify against operator policy environment override if present
  const operatorFingerprint = (process.env.SAVEBOX2_TRUSTED_OPERATOR_FINGERPRINT || '').toLowerCase();
  if (operatorFingerprint && derFingerprint !== operatorFingerprint) {
    return fail(2, 'ERROR', 'R16_AUTHORIZATION_OPERATOR_POLICY_MISMATCH');
  }

  const canonicalPayload = canonicalJson(payload);
  const payloadBytes = Buffer.from(canonicalPayload, 'utf8');

  let valid = false;
  try {
    valid = verify(null, payloadBytes, pubKeyObj, signatureBytes);
  } catch (err) {
    return fail(1, 'INVALID', 'R16_AUTHORIZATION_SIGNATURE_INVALID', { detail: err.message });
  }

  if (!valid) {
    return fail(1, 'INVALID', 'R16_AUTHORIZATION_SIGNATURE_INVALID');
  }

  // Successful verification
  console.log(JSON.stringify({
    status: 'VALID',
    keyId: authDoc.keyId,
    payload,
    payloadSha256: createHash('sha256').update(payloadBytes).digest('hex'),
    canonicalBytes: payloadBytes.length,
    spkiFingerprint: derFingerprint
  }));
  process.exit(0);
}

import { pathToFileURL } from 'node:url';

// Entrypoint when invoked from CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: verify_scientific_authorization.mjs <auth-file> <trust-anchor-file>');
    process.exit(2);
  }
  verifyAuthorizationFile(args[0], args[1]);
}
