const NONCE_SIZE = 24;
const MAC_SIZE = 16;

type PostMessage = (
  message: Record<string, unknown>,
  transferables?: Transferable[],
) => void;

type Sodium = {
  ready: PromiseLike<unknown>;
  crypto_aead_xchacha20poly1305_ietf_decrypt_detached: (...args: any[]) => Uint8Array;
};

function deriveChunkNonce(baseNonce: Uint8Array, chunkIndex: number): Uint8Array {
  const nonce = new Uint8Array(baseNonce);
  let remaining = chunkIndex;
  for (let i = 0; i < 8; i++) {
    nonce[NONCE_SIZE - 1 - i] ^= remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return nonce;
}

export function createStreamCryptoMessageHandler(
  postMessage: PostMessage,
  sodium: Sodium,
): (data: any) => Promise<void> {
  let sodiumReady = false;
  let logsEnabled = false;

  async function ensureSodium(): Promise<void> {
    if (!sodiumReady) {
      await sodium.ready;
      sodiumReady = true;
    }
  }

  return async (data: any): Promise<void> => {
    if (data.type === 'INIT') {
      logsEnabled = !!data.logsEnabled;
      return;
    }

    if (logsEnabled) {
      console.log('[CryptoWorker] Received message:', data.type, 'chunkIndex:', data.chunkIndex);
    }

    const { type, encryptedChunk, fdk, baseNonce, chunkIndex } = data as {
      type: string;
      encryptedChunk: ArrayBuffer;
      fdk: ArrayBuffer;
      baseNonce: ArrayBuffer;
      chunkIndex: number;
    };

    if (type !== 'DECRYPT_CHUNK') return;

    let fdkBytes: Uint8Array | undefined;
    let nonceBytes: Uint8Array | undefined;
    let chunkNonce: Uint8Array | undefined;

    try {
      fdkBytes = new Uint8Array(fdk);
      nonceBytes = new Uint8Array(baseNonce);
      await ensureSodium();

      const chunkBytes = new Uint8Array(encryptedChunk);

      if (chunkBytes.length < MAC_SIZE) {
        throw new Error(`Chunk ${chunkIndex} is too small to contain a MAC tag.`);
      }

      const mac = chunkBytes.slice(0, MAC_SIZE);
      const ciphertext = chunkBytes.slice(MAC_SIZE);
      chunkNonce = deriveChunkNonce(nonceBytes, chunkIndex);
      const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt_detached(
        null,
        ciphertext,
        mac,
        null,
        chunkNonce,
        fdkBytes,
      );

      const transferable = plaintext.buffer as ArrayBuffer;
      postMessage(
        { type: 'CHUNK_DECRYPTED', decryptedChunk: transferable, chunkIndex },
        [transferable],
      );
    } catch (err: any) {
      postMessage({
        type: 'ERROR',
        chunkIndex,
        message: err?.message ?? 'Unknown decryption error.',
      });
    } finally {
      fdkBytes?.fill(0);
      nonceBytes?.fill(0);
      chunkNonce?.fill(0);
    }
  };
}
