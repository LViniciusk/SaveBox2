/// <reference lib="webworker" />

import _sodium from 'libsodium-wrappers-sumo';

addEventListener('message', async ({ data }) => {
  try {
    const { passphrase, salt } = data;
    await _sodium.ready;
    const encoder = new TextEncoder();
    const passphraseBytes = encoder.encode(passphrase);
    
    // Hash salt to 16 bytes
    const saltHash = _sodium.crypto_generichash(16, encoder.encode(salt), null);

    const key = _sodium.crypto_pwhash(
      32, // KEY_SIZE
      passphraseBytes,
      saltHash,
      _sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      _sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      _sodium.crypto_pwhash_ALG_ARGON2ID13
    );

    postMessage({ success: true, key });
  } catch (error: any) {
    postMessage({ success: false, error: error.message || error.toString() });
  }
});
