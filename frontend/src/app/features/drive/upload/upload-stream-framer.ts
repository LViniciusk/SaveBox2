import { DRIVE_TRANSFER_CHUNK_SIZE } from '../transfer-limits';

export interface UploadTransportChunk {
  index: number;
  blob: Blob;
}

function takePrefix(pending: Blob[], size: number): Blob {
  const parts: Blob[] = [];
  let remaining = size;

  while (remaining > 0) {
    const current = pending[0];
    if (!current) {
      throw new Error('Encrypted stream framing error');
    }

    if (current.size <= remaining) {
      parts.push(current);
      pending.shift();
      remaining -= current.size;
      continue;
    }

    parts.push(current.slice(0, remaining));
    pending[0] = current.slice(remaining);
    remaining = 0;
  }

  return new Blob(parts);
}

function* publishCompletedFrames(
  pending: Blob[],
  pendingSize: number,
  expectedSize: number,
  index: number,
): Generator<UploadTransportChunk> {
  while (expectedSize - index * DRIVE_TRANSFER_CHUNK_SIZE > DRIVE_TRANSFER_CHUNK_SIZE) {
    const blob = takePrefix(pending, DRIVE_TRANSFER_CHUNK_SIZE);
    pendingSize -= DRIVE_TRANSFER_CHUNK_SIZE;
    yield { index, blob };
    index++;
  }

  const expectedRemainder = expectedSize - index * DRIVE_TRANSFER_CHUNK_SIZE;
  if (
    expectedRemainder < 0 ||
    expectedRemainder > DRIVE_TRANSFER_CHUNK_SIZE ||
    pendingSize !== expectedRemainder
  ) {
    throw new Error('Encrypted stream framing error');
  }

  if (expectedRemainder === 0) {
    if (pending.length !== 0 || pendingSize !== 0) {
      throw new Error('Encrypted stream framing error');
    }
    return;
  }

  const blob = takePrefix(pending, expectedRemainder);
  pendingSize = 0;

  if (blob.size !== expectedRemainder || pending.length !== 0) {
    throw new Error('Encrypted stream framing error');
  }

  yield { index, blob };
}

export async function* frameUploadChunks(
  parts: AsyncIterable<Blob>,
  expectedSize: number,
): AsyncGenerator<UploadTransportChunk> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new Error('Invalid encrypted stream size');
  }

  const pending: Blob[] = [];
  let pendingSize = 0;
  let seenBytes = 0;
  let index = 0;

  for await (const part of parts) {
    if (!(part instanceof Blob)) {
      throw new Error('Encrypted stream must contain Blob parts');
    }
    if (part.size === 0) {
      continue;
    }

    if (part.size > expectedSize - seenBytes) {
      throw new Error('Encrypted stream size mismatch');
    }

    seenBytes += part.size;
    pending.push(part);
    pendingSize += part.size;

    while (
      pendingSize > DRIVE_TRANSFER_CHUNK_SIZE ||
      (pendingSize === DRIVE_TRANSFER_CHUNK_SIZE && seenBytes < expectedSize)
    ) {
      const blob = takePrefix(pending, DRIVE_TRANSFER_CHUNK_SIZE);
      pendingSize -= DRIVE_TRANSFER_CHUNK_SIZE;
      yield { index, blob };
      index++;
    }
  }

  if (seenBytes !== expectedSize) {
    throw new Error('Encrypted stream size mismatch');
  }

  yield* publishCompletedFrames(pending, pendingSize, expectedSize, index);
}
