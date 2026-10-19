#!/usr/bin/env node
import { readFileSync, statSync, lstatSync } from 'node:fs';
import { verify, createPublicKey, createHash } from 'node:crypto';

// Strict JSON parser that rejects duplicate keys
export function parseStrictJson(text) {
  let pos = 0;
  function skipWhitespace() {
    while (pos < text.length && /\s/.test(text[pos])) pos++;
  }
  function parseValue() {
    skipWhitespace();
    if (pos >= text.length) throw new Error('UNEXPECTED_EOF');
    const ch = text[pos];
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (ch === '"') return parseString();
    if (ch === 't' && text.slice(pos, pos + 4) === 'true') { pos += 4; return true; }
    if (ch === 'f' && text.slice(pos, pos + 5) === 'false') { pos += 5; return false; }
    if (ch === 'n' && text.slice(pos, pos + 4) === 'null') { pos += 4; return null; }
    if (ch === '-' || /\d/.test(ch)) return parseNumber();
    throw new Error(`UNEXPECTED_CHAR: ${ch} at ${pos}`);
  }
  function parseString() {
    pos++; // skip opening quote
    let str = '';
    while (pos < text.length) {
      const ch = text[pos++];
      if (ch === '"') return str;
      if (ch === '\\') {
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
          str += String.fromCharCode(parseInt(text.slice(pos, pos + 4), 16));
          pos += 4;
        } else throw new Error(`INVALID_ESCAPE: \\${esc}`);
      } else {
        str += ch;
      }
    }
    throw new Error('UNTERMINATED_STRING');
  }
  function parseNumber() {
    const start = pos;
    if (text[pos] === '-') pos++;
    while (pos < text.length && /\d/.test(text[pos])) pos++;
    if (text[pos] === '.') {
      pos++;
      while (pos < text.length && /\d/.test(text[pos])) pos++;
    }
    if (text[pos] === 'e' || text[pos] === 'E') {
      pos++;
      if (text[pos] === '+' || text[pos] === '-') pos++;
      while (pos < text.length && /\d/.test(text[pos])) pos++;
    }
    const num = Number(text.slice(start, pos));
    if (!Number.isFinite(num)) throw new Error('NON_FINITE_NUMBER');
    return num;
  }
  function parseArray() {
    pos++; // skip '['
    const arr = [];
    skipWhitespace();
    if (text[pos] === ']') { pos++; return arr; }
    while (pos < text.length) {
      arr.push(parseValue());
      skipWhitespace();
      if (text[pos] === ']') { pos++; return arr; }
      if (text[pos] !== ',') throw new Error(`EXPECTED_COMMA_AT ${pos}`);
      pos++; // skip ','
    }
    throw new Error('UNTERMINATED_ARRAY');
  }
  function parseObject() {
    pos++; // skip '{'
    const obj = {};
    const keysSeen = new Set();
    skipWhitespace();
    if (text[pos] === '}') { pos++; return obj; }
    while (pos < text.length) {
      skipWhitespace();
      if (text[pos] !== '"') throw new Error(`EXPECTED_STRING_KEY_AT ${pos}`);
      const key = parseString();
      if (keysSeen.has(key)) throw new Error(`DUPLICATE_KEY: ${key}`);
      keysSeen.add(key);
      skipWhitespace();
      if (text[pos] !== ':') throw new Error(`EXPECTED_COLON_AT ${pos}`);
      pos++; // skip ':'
      const val = parseValue();
      obj[key] = val;
      skipWhitespace();
      if (text[pos] === '}') { pos++; return obj; }
      if (text[pos] !== ',') throw new Error(`EXPECTED_COMMA_OR_CLOSE_BRACE_AT ${pos}`);
      pos++; // skip ','
    }
    throw new Error('UNTERMINATED_OBJECT');
  }
  const result = parseValue();
  skipWhitespace();
  if (pos < text.length) throw new Error('TRAILING_DATA');
  return result;
}

export function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
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

  if (typeof authDoc.signature !== 'string' || !/^[A-Za-z0-9+/=]{86,88}$/.test(authDoc.signature)) {
    return fail(3, 'ERROR', 'R12R16_SCIENTIFIC_AUTHORIZATION_INVALID');
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

  // 3. Verify Trust Anchor
  let anchorStat;
  try {
    anchorStat = statSync(trustAnchorPath);
    const lstat = lstatSync(trustAnchorPath);
    if (lstat.isSymbolicLink()) {
      return fail(2, 'ERROR', 'R16_AUTHORIZATION_TRUST_ANCHOR_SYMLINK_REJECTED');
    }
  } catch (err) {
    return fail(2, 'ERROR', 'R16_AUTHORIZATION_TRUST_ANCHOR_MISSING');
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

  // If fingerprint specified, check SHA-256 of public key string
  if (keyConfig.fingerprint) {
    const keyHash = createHash('sha256').update(keyConfig.publicKey.trim()).digest('hex');
    if (keyHash !== keyConfig.fingerprint.toLowerCase()) {
      return fail(2, 'ERROR', 'R16_AUTHORIZATION_TRUST_ANCHOR_FINGERPRINT_MISMATCH');
    }
  }

  // 4. Ed25519 Cryptographic Signature Verification
  let pubKeyObj;
  try {
    pubKeyObj = createPublicKey(keyConfig.publicKey);
  } catch (err) {
    return fail(2, 'ERROR', 'R16_AUTHORIZATION_PUBLIC_KEY_INVALID', { detail: err.message });
  }

  const canonicalPayload = canonicalJson(payload);
  const payloadBytes = Buffer.from(canonicalPayload, 'utf8');

  let signatureBytes;
  try {
    signatureBytes = Buffer.from(authDoc.signature, 'base64');
  } catch (err) {
    return fail(1, 'INVALID', 'R16_AUTHORIZATION_SIGNATURE_INVALID');
  }

  if (signatureBytes.length !== 64) {
    return fail(1, 'INVALID', 'R16_AUTHORIZATION_SIGNATURE_INVALID');
  }

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
    canonicalBytes: payloadBytes.length
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
