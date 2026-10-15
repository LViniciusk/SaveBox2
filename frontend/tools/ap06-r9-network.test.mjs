import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observeRangeNetwork, backendTraffic } from './ap06-r9-network.mjs';

test('passive CDP selects only approved ranges, sanitizes headers, correlates and detaches', async () => {
  const session = new EventEmitter(), calls = [];
  session.send = async command => calls.push(command); session.detach = async () => calls.push('detach');
  const observer = await observeRangeNetwork({ newCDPSession: async () => session }, {}, [{ fixture: 0, fileId: 101 }]);
  assert.deepEqual(calls, ['Network.enable']); assert.equal(observer.data.enabledBeforeNavigation, true);
  session.emit('Network.requestWillBeSent', { requestId: 'a', type: 'XHR', request: {
    url: 'http://127.0.0.1:42187/files/101/download', method: 'GET', headers: { Range:'bytes=0-9', Authorization:'secret unit token' } } });
  session.emit('Network.responseReceived', { requestId: 'a', type:'XHR', response: { status:206,
    fromDiskCache:false, fromServiceWorker:false, headers: { 'Content-Length':'10', 'Content-Range':'bytes 0-9/100',
      'Set-Cookie':'secret unit cookie', 'ETag':'synthetic', 'Cache-Control':'no-cache', 'Age':'0', 'Vary':'Origin' } } });
  assert.equal(observer.data.requests[0].encodedDataLength, null);
  session.emit('Network.loadingFinished', { requestId:'a', encodedDataLength:321 });
  session.emit('Network.requestServedFromCache', { requestId:'a' });
  assert.equal(observer.data.requests[0].encodedDataLength, 321); assert.equal(observer.data.requests[0].servedFromCache, true);
  assert.equal(observer.data.requests[0].finished, true);
  assert.equal(JSON.stringify(observer.data).includes('secret'), false);
  await observer.close();
  assert.equal(observer.data.listenersDetached, true); assert.equal(observer.data.sessionDetached, true);
  assert.equal(session.eventNames().length, 0); assert.deepEqual(calls, ['Network.enable','detach']);
});
test('CDP duplicates and failures remain visible; external URLs and non-Range calls are ignored', async () => {
  const session=new EventEmitter();session.send=async()=>{};session.detach=async()=>{};
  const observer=await observeRangeNetwork({newCDPSession:async()=>session},{},[{fixture:0,fileId:101}]);
  const request={url:'http://127.0.0.1:42187/files/101/download',method:'GET',headers:{Range:'bytes=0-9'}};
  for(const url of ['https://external.test','http://127.0.0.1:42187/files/102/download']) {
    session.emit('Network.requestWillBeSent',{requestId:url,request:{...request,url}});
  }
  session.emit('Network.requestWillBeSent',{requestId:'no-range',request:{...request,headers:{}}});
  session.emit('Network.requestWillBeSent',{requestId:'a',request});
  session.emit('Network.requestWillBeSent',{requestId:'a',request});
  session.emit('Network.loadingFailed',{requestId:'a'});
  assert.equal(observer.data.requests.length,1);assert.equal(observer.data.duplicateRequestIds,1);
  assert.equal(observer.data.requests[0].failed,true);await observer.close();
});
test('backend traffic parser uses method/status and records unavailable bytes honestly', () => {
  const text = `Request: 127.0.0.1:5555 0xabc HTTP/1.1 OPTIONS /files/101/download
Response: 0xabc /files/101/download 204 0
Request: 127.0.0.1:5555 0xabc HTTP/1.1 GET /files/101/download
Response: 0xabc /files/101/download 206 0
Request: 127.0.0.1:5555 0xabc HTTP/1.1 GET /files/102/download
Response: 0xabc /files/102/download 401 0`;
  const data=backendTraffic(text,[101]);assert.deepEqual(data.rows,[{fileId:101,status:206}]);
  assert.equal(data.pendingGets,0);assert.equal(data.responseBodyBytes,null);
  assert.equal(data.correlationFailures,0);
  assert.equal(backendTraffic('Response: 0xabc /files/101/download 206 0',[101]).correlationFailures,1);
  assert.equal(backendTraffic('Request: 127.0.0.1:5555 0xabc HTTP/1.1 GET /files/101/download',[101]).pendingGets,1);
});
