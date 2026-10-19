#!/usr/bin/env node
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { canonicalJson } from './verify_scientific_authorization.mjs';
import { pathToFileURL } from 'node:url';

// Generates an ephemeral Ed25519 keypair for offline tests
export function generateTestKeyPair(keyId = 'test-scientific-director') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const fingerprint = createHash('sha256').update(pubPem.trim()).digest('hex');
  const trustAnchor = {
    schema: 1,
    keys: {
      [keyId]: {
        algorithm: 'ed25519',
        publicKey: pubPem,
        fingerprint
      }
    }
  };
  return { keyId, publicKey: pubPem, privateKey: privPem, trustAnchor };
}

// Signs an authorization payload using a test private key
export function signTestPayload(payload, privateKeyPem, keyId = 'test-scientific-director') {
  const canonical = canonicalJson(payload);
  const payloadBytes = Buffer.from(canonical, 'utf8');
  const signatureBytes = sign(null, payloadBytes, privateKeyPem);
  return {
    schema: 1,
    payload,
    signature: signatureBytes.toString('base64'),
    keyId
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode === 'generate-keypair') {
    const keyId = process.argv[3] || 'test-scientific-director';
    const pair = generateTestKeyPair(keyId);
    console.log(JSON.stringify(pair));
  } else if (mode === 'sign') {
    const payloadStr = process.argv[3];
    const privPem = process.argv[4];
    const keyId = process.argv[5] || 'test-scientific-director';
    const signed = signTestPayload(JSON.parse(payloadStr), privPem, keyId);
    console.log(JSON.stringify(signed));
  } else {
    console.error('Usage: sign_test_authorization.mjs [generate-keypair <keyId> | sign <payload-json> <privPem> <keyId>]');
    process.exit(1);
  }
}
