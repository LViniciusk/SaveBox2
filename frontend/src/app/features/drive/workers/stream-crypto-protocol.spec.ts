import { createStreamCryptoMessageHandler } from './stream-crypto-protocol';

interface PostedMessage {
  message: Record<string, any>;
  transferables: Transferable[];
}

describe('stream-crypto protocol', () => {
  function harness(options: {
    decrypt?: (...args: any[]) => Uint8Array;
    ready?: PromiseLike<unknown>;
  } = {}): {
    handle: (data: any) => Promise<void>;
    posts: PostedMessage[];
    decrypt: jasmine.Spy;
  } {
    const posts: PostedMessage[] = [];
    const decryptSpy = jasmine.createSpy('decrypt').and.callFake(
      options.decrypt ?? (() => new Uint8Array([7, 8])),
    );
    const handle = createStreamCryptoMessageHandler(
      (message, transferables = []) => posts.push({ message, transferables }),
      {
        ready: options.ready ?? Promise.resolve(),
        crypto_aead_xchacha20poly1305_ietf_decrypt_detached: decryptSpy,
      } as any,
    );
    return { handle, posts, decrypt: decryptSpy };
  }

  it('preserves successful decryption and plaintext transfer', async () => {
    let capturedFdk!: Uint8Array;
    let capturedChunkNonce!: Uint8Array;
    const { handle, posts, decrypt } = harness({
      decrypt: (...args: any[]) => {
        capturedChunkNonce = args[4];
        capturedFdk = args[5];
        return new Uint8Array([7, 8]);
      },
    });
    const encryptedChunk = new Uint8Array(17).buffer;
    const fdk = new Uint8Array(32).fill(0x5a).buffer;
    const baseNonce = new Uint8Array(24).fill(0x6b).buffer;

    await handle({ type: 'DECRYPT_CHUNK', encryptedChunk, fdk, baseNonce, chunkIndex: 2 });

    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(posts[0].message['type']).toBe('CHUNK_DECRYPTED');
    expect(posts[0].message['chunkIndex']).toBe(2);
    expect(posts[0].transferables).toEqual([posts[0].message['decryptedChunk']]);
    expect(new Uint8Array(fdk)).toEqual(new Uint8Array(32));
    expect(new Uint8Array(baseNonce)).toEqual(new Uint8Array(24));
    expect(capturedFdk).toEqual(new Uint8Array(32));
    expect(capturedChunkNonce).toEqual(new Uint8Array(24));
  });

  it('preserves authentication error responses', async () => {
    let capturedFdk!: Uint8Array;
    let capturedChunkNonce!: Uint8Array;
    const { handle, posts } = harness({
      decrypt: (...args: any[]) => {
        capturedChunkNonce = args[4];
        capturedFdk = args[5];
        throw new Error('authentication failure');
      },
    });
    const fdk = new Uint8Array(32).fill(0x5a).buffer;
    const baseNonce = new Uint8Array(24).fill(0x6b).buffer;

    await handle({
      type: 'DECRYPT_CHUNK',
      encryptedChunk: new Uint8Array(17).buffer,
      fdk,
      baseNonce,
      chunkIndex: 3,
    });

    expect(posts).toEqual([{
      message: { type: 'ERROR', chunkIndex: 3, message: 'authentication failure' },
      transferables: [],
    }]);
    expect(new Uint8Array(fdk)).toEqual(new Uint8Array(32));
    expect(new Uint8Array(baseNonce)).toEqual(new Uint8Array(24));
    expect(capturedFdk).toEqual(new Uint8Array(32));
    expect(capturedChunkNonce).toEqual(new Uint8Array(24));
  });

  it('preserves short-chunk validation and ignores non-decrypt messages', async () => {
    const { handle, posts, decrypt } = harness();
    const fdk = new Uint8Array(32).fill(0x5a).buffer;
    const baseNonce = new Uint8Array(24).fill(0x6b).buffer;

    await handle({ type: 'INIT', logsEnabled: false });
    await handle({ type: 'OTHER' });
    await handle({
      type: 'DECRYPT_CHUNK',
      encryptedChunk: new Uint8Array(15).buffer,
      fdk,
      baseNonce,
      chunkIndex: 4,
    });

    expect(decrypt).not.toHaveBeenCalled();
    expect(posts).toEqual([{
      message: { type: 'ERROR', chunkIndex: 4, message: 'Chunk 4 is too small to contain a MAC tag.' },
      transferables: [],
    }]);
    expect(new Uint8Array(fdk)).toEqual(new Uint8Array(32));
    expect(new Uint8Array(baseNonce)).toEqual(new Uint8Array(24));
  });

  it('wipes transferred key material when Sodium initialization fails', async () => {
    const fdk = new Uint8Array(32).fill(0x5a).buffer;
    const baseNonce = new Uint8Array(24).fill(0x6b).buffer;
    const { handle, posts, decrypt } = harness({
      ready: Promise.reject(new Error('sodium init failed')),
    });

    await handle({
      type: 'DECRYPT_CHUNK',
      encryptedChunk: new Uint8Array(17).buffer,
      fdk,
      baseNonce,
      chunkIndex: 5,
    });

    expect(decrypt).not.toHaveBeenCalled();
    expect(posts).toEqual([{
      message: { type: 'ERROR', chunkIndex: 5, message: 'sodium init failed' },
      transferables: [],
    }]);
    expect(new Uint8Array(fdk)).toEqual(new Uint8Array(32));
    expect(new Uint8Array(baseNonce)).toEqual(new Uint8Array(24));
  });
});
