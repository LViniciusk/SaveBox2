const HEADERS = new Set(['cache-control', 'etag', 'vary', 'age', 'content-range', 'content-length']);
const header = (headers, name) => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? null;

export function backendTraffic(text, fileIds) {
  const pending = new Map(), rows = [];
  let correlationFailures = 0;
  for (const line of text.split(/\r?\n/)) {
    const request = /Request: \S+ (0x[\da-f]+) HTTP\/\S+ (\w+) \/files\/(\d+)\/download\s*$/.exec(line);
    if (request) pending.set(request[1], { method: request[2], fileId: Number(request[3]) });
    const response = /Response: (0x[\da-f]+) \/files\/(\d+)\/download (\d+) \d+\s*$/.exec(line);
    if (!response) continue;
    const requestRow = pending.get(response[1]); pending.delete(response[1]);
    if (fileIds.includes(Number(response[2])) && (!requestRow || requestRow.fileId !== Number(response[2]))) {
      correlationFailures++; continue;
    }
    if (requestRow?.method === 'GET' && fileIds.includes(requestRow.fileId)) {
      rows.push({ fileId: requestRow.fileId, status: Number(response[3]) });
    }
  }
  return { rows, correlationFailures, pendingGets: [...pending.values()].filter(row => row.method === 'GET').length,
    responseBodyBytes: null, byteMetric: 'unavailable: native streaming log does not report body bytes' };
}

export async function observeRangeNetwork(context, page, mapping, { bootstrapHttp = false, optionsHttp = false } = {}) {
  const session = await context.newCDPSession(page);
  const allowed = new Map(mapping.map(row => [`http://127.0.0.1:42187/files/${row.fileId}/download`, row]));
  const data = { enabledBeforeNavigation: false, listenersDetached: false, sessionDetached: false,
    routingInstalled: true, httpCache: 'disabled by Playwright routing', explicitCacheIntervention: false,
    duplicateRequestIds: 0, requests: [] };
  const requests = new Map();
  const bootstrap = new Map([
    ['http://127.0.0.1:42187/login', { kind:'auth',method:'POST' }],
    ['http://127.0.0.1:42187/tree?file_limit=100&file_offset=0', { kind:'tree',method:'GET' }],
    ['http://127.0.0.1:42187/pending-uploads', { kind:'pending',method:'GET' }],
  ]);
  if (bootstrapHttp) data.bootstrapRequests = [];
  if (optionsHttp) data.optionsRequests = [];
  const handlers = {
    'Network.requestWillBeSent': ({ requestId, request, type }) => {
      const fixture = allowed.get(request.url), range = header(request.headers, 'range');
      const other = bootstrapHttp ? bootstrap.get(request.url) : null;
      if (optionsHttp && request.method === 'OPTIONS' && (fixture || other)) {
        if (requests.has(requestId)) { data.duplicateRequestIds++; return; }
        const row = {requestId,method:'OPTIONS',url:request.url,type,status:null,finished:false,failed:false};
        requests.set(requestId,row);data.optionsRequests.push(row);return;
      }
      if (other && request.method === other.method) {
        if (requests.has(requestId)) { data.duplicateRequestIds++; return; }
        const row = { requestId,kind:other.kind,method:request.method,url:request.url,type,status:null,finished:false,failed:false,
          fromDiskCache:null,fromServiceWorker:null,servedFromCache:false,encodedDataLength:null,headers:{} };
        requests.set(requestId,row); data.bootstrapRequests.push(row); return;
      }
      if (!fixture || request.method !== 'GET' || !range) return;
      if (requests.has(requestId)) { data.duplicateRequestIds++; return; }
      const row = { requestId, method:request.method,url:request.url,fixture: fixture.fixture, fileId: fixture.fileId, range, type,
        status: null, fromDiskCache: null, fromServiceWorker: null, servedFromCache: false,
        encodedDataLength: null, finished: false, failed: false, headers: {} };
      requests.set(requestId, row); data.requests.push(row);
    },
    'Network.responseReceived': ({ requestId, response, type }) => {
      const row = requests.get(requestId); if (!row) return;
      Object.assign(row, { type, status: response.status, fromDiskCache: response.fromDiskCache ?? null,
        fromServiceWorker: response.fromServiceWorker ?? null,
        headers: Object.fromEntries(Object.entries(response.headers).filter(([key]) => HEADERS.has(key.toLowerCase()))
          .map(([key, value]) => [key.toLowerCase(), value])) });
    },
    'Network.loadingFinished': ({ requestId, encodedDataLength }) => {
      const row = requests.get(requestId); if (row) Object.assign(row, { finished: true, encodedDataLength });
    },
    'Network.loadingFailed': ({ requestId }) => { const row = requests.get(requestId); if (row) row.failed = true; },
    'Network.requestServedFromCache': ({ requestId }) => { const row = requests.get(requestId); if (row) row.servedFromCache = true; },
  };
  for (const [event, handler] of Object.entries(handlers)) session.on(event, handler);
  const close = async () => {
    for (const [event, handler] of Object.entries(handlers)) session.off(event, handler);
    data.listenersDetached = true; requests.clear();
    await session.detach(); data.sessionDetached = true;
  };
  try { await session.send('Network.enable'); data.enabledBeforeNavigation = true; }
  catch (error) { try { await close(); } catch (cleanupError) { throw new AggregateError([error,cleanupError],'R10_CDP_SETUP_AND_CLEANUP_FAILED'); } throw error; }
  return { data, close };
}
