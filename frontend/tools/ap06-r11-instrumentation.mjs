export function newR11Counters() {
  return Object.fromEntries(['blobCount','blobBytes','arrayBufferCount','arrayBufferBytes','sliceCount','sliceBytes',
    'transferredBuffers','detachedBuffers','transferBytes','workerOutputBuffers','workerOutputBytes','segmentBytes',
    'materializationsPending','materializationsCompleted','materializationsFailed',
    'sessionsStarted','sessionsCompleted','sessionsFailed','workerProtocolFailures'].map(k=>[k,0]));
}

// Only allowlisted HTTP Blobs and their buffers are observed; weak membership never owns a payload.
export function installR11Instrumentation() {
  const blobs = new WeakSet(), buffers = new WeakSet();
  const counters = () => window.r11Counters;
  window.r11ObserveBlob = blob => {
    if (!blobs.has(blob)) { blobs.add(blob); counters().blobCount++; counters().blobBytes += blob.size; }
  };
  const materialize = Blob.prototype.arrayBuffer, slice = ArrayBuffer.prototype.slice;
  Blob.prototype.arrayBuffer = async function() {
    if (!blobs.has(this)) return Reflect.apply(materialize,this,arguments);
    const c = counters(); c.materializationsPending++;
    try {
      const buffer = await Reflect.apply(materialize,this,arguments);
      buffers.add(buffer); c.arrayBufferCount++; c.arrayBufferBytes += buffer.byteLength; c.materializationsCompleted++;
      return buffer;
    } catch(error) { c.materializationsFailed++; throw error; }
    finally { c.materializationsPending--; }
  };
  ArrayBuffer.prototype.slice = function() {
    const result = Reflect.apply(slice,this,arguments);
    if (buffers.has(this)) { buffers.add(result); counters().sliceCount++; counters().sliceBytes += result.byteLength; }
    return result;
  };
  window.r11ObserveWorkerResponse = data => {
    const c = counters();
    if (data?.type === 'CHUNK_DECRYPTED' && (!(data.decryptedChunk instanceof ArrayBuffer) || !data.decryptedChunk.byteLength) ||
        ['BOOTSTRAP_COMPLETE','CHUNK_TRANSMUXED'].includes(data?.type) && (!Array.isArray(data.segments) ||
          data.segments.some(s=>!Number.isInteger(s.id) || !(s.buffer instanceof ArrayBuffer) || !s.buffer.byteLength)) ||
        data?.type === 'BOOTSTRAP_COMPLETE' && (!Array.isArray(data.initData) || !data.initData.length ||
          data.initData.some(t=>!Number.isInteger(t.id) || typeof t.codecString !== 'string' || !(t.buffer instanceof ArrayBuffer) || !t.buffer.byteLength)))
      c.workerProtocolFailures++;
    const record = buffer => { if (buffer instanceof ArrayBuffer) { c.workerOutputBuffers++; c.workerOutputBytes += buffer.byteLength; } };
    record(data?.decryptedChunk);
    for (const segment of data?.segments ?? []) { record(segment.buffer); c.segmentBytes += segment.buffer.byteLength; }
    for (const track of data?.initData ?? []) { record(track.buffer); c.segmentBytes += track.buffer.byteLength; }
  };
  window.r11ObserveTransfer = (count, bytes, detached) => {
    const c = counters(); c.transferredBuffers += count; c.transferBytes += bytes; c.detachedBuffers += detached;
  };
}

export function validateR11Stage(condition, c, observed) {
  if (Object.values(c).some(v=>!Number.isFinite(v) || v<0) || c.materializationsPending || c.materializationsFailed ||
      c.sessionsFailed || c.workerProtocolFailures || c.sessionsStarted !== c.sessionsCompleted || c.transferredBuffers !== c.detachedBuffers ||
      observed.workerErrors || observed.transferFailures || observed.rangeRequestsFailed || observed.rangeRequestsAborted)
    throw new Error('R11_SCALAR_LIFECYCLE_INVALID');
  if (!c.blobCount || !c.arrayBufferCount) throw new Error('R11_MATERIALIZATION_MISSING');
  if (condition === 'r11.2' && (observed.workersCreated || c.workerOutputBytes || c.transferBytes)) throw new Error('R11_FORBIDDEN_WORKER');
  if (['r11.2','r11.3'].includes(condition) && (observed.mediaSourcesCreated || observed.bytesAppended)) throw new Error('R11_FORBIDDEN_MSE');
  if (condition === 'r11.3' && (!observed.workersCreated || !c.workerOutputBytes || !c.segmentBytes)) throw new Error('R11_WORKER_OUTPUT_MISSING');
}
