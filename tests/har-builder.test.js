import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import { buildHarEntry, buildTimings, normalizeProtocol, normalizeResourceType } from '../extension/src/capture/har-builder.js';
import { CaptureBudget, TabCaptureSession } from '../extension/src/capture/capture-session.js';
import { buildCaptureZip, buildHarFileName, createZip } from '../extension/src/capture/zip-builder.js';
import { DEFAULT_NETWORK_QUIET_TIMEOUT_SECONDS, isNetworkQuietMode, parseNetworkQuietTimeoutSeconds } from '../extension/src/capture/capture-policy.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/cdp-network-sample.json', import.meta.url)));
const tab = { id: 123, url: 'https://example.com/', title: 'Example Domain' };
const requestEvent = fixture.events.find((event) => event.method === 'Network.requestWillBeSent').params;
const responseEvent = fixture.events.find((event) => event.method === 'Network.responseReceived').params;
const finishEvent = fixture.events.find((event) => event.method === 'Network.loadingFinished').params;
function session(options = {}) {
  const result = new TabCaptureSession(tab, options.requests ?? true, options.responses ?? true, options.maxBody ?? 26214400,
    { command: async () => fixture.responseBody, ...options });
  result.mainFrameId = requestEvent.frameId;
  return result;
}
function request(s, id = 'r', extra = {}) {
  s.handleEvent('Network.requestWillBeSent', { ...structuredClone(requestEvent), requestId: id, ...extra });
}
function response(s, id = 'r', extra = {}) {
  s.handleEvent('Network.responseReceived', { ...structuredClone(responseEvent), requestId: id, hasExtraInfo: false, ...extra });
}
function finish(s, id = 'r') { s.handleEvent('Network.loadingFinished', { ...finishEvent, requestId: id }); }
function assertFinite(value) {
  assert.notEqual(value, undefined);
  if (typeof value === 'number') assert.ok(Number.isFinite(value));
  if (value && typeof value === 'object') Object.values(value).forEach(assertFinite);
}
function readZip(bytes, parseJson = true) {
  const files = new Map();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 18, true);
    const nameSize = view.getUint16(offset + 26, true);
    const extraSize = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameSize));
    offset += 30 + nameSize + extraSize;
    const data = bytes.subarray(offset, offset + size);
    const text = new TextDecoder().decode(method === 8 ? inflateRawSync(data) : data);
    files.set(name, parseJson ? JSON.parse(text) : text);
    offset += size;
  }
  return files;
}

test('network quiet defaults to 15 seconds and accepts positive finite custom durations without product bounds', () => {
  assert.equal(DEFAULT_NETWORK_QUIET_TIMEOUT_SECONDS, 15);
  for (const [input, expected] of [['15', 15], ['30', 30], ['300', 300], ['3600', 3600],
    [30, 30], [300, 300], [3600, 3600], [' 45 ', 45], ['1', 1], ['0.5', 0.5],
    ['3e2', 300], ['1.', 1], ['.25', 0.25], ['3000000', 3000000], [15, 15], [Number.MAX_VALUE, Number.MAX_VALUE],
    [String(Number.MAX_VALUE), Number.MAX_VALUE], [Number.MIN_VALUE, Number.MIN_VALUE]]) {
    assert.equal(parseNetworkQuietTimeoutSeconds(input), expected, String(input));
  }
  for (const input of ['', ' ', '0', '-1', 'abc', 'NaN', 'Infinity', '-Infinity', '1e309', '15 seconds',
    '0x10', 0, -1, NaN, Infinity, null, undefined, true, []]) {
    assert.equal(parseNetworkQuietTimeoutSeconds(input), null, String(input));
  }
});

test('automatic network quiet applies only to Refresh and URL-list capture', () => {
  assert.equal(isNetworkQuietMode('refresh'), true);
  assert.equal(isNetworkQuietMode('url-list'), true);
  assert.equal(isNetworkQuietMode('live'), false);
  assert.equal(isNetworkQuietMode(''), false);
});

test('quiet measures continuous inactivity, including empty captures and durations above timer limits', () => {
  const s = session();
  s.lastNetworkActivityAt = 0;
  assert.equal(s.isQuiet(10000, 15), false);
  assert.equal(s.isQuiet(14999, 15), false);
  assert.equal(s.isQuiet(15000, 15), true); // No requests is still a quiet capture.
  assert.equal(s.isQuiet(30000, 15), true);
  for (const lastNetworkActivityAt of [2000, 8000, 13000]) {
    s.lastNetworkActivityAt = lastNetworkActivityAt;
    assert.equal(s.isQuiet(lastNetworkActivityAt + 14999, 15), false);
  }
  assert.equal(s.isQuiet(15000, 15), false); // 15 seconds since capture start is insufficient.
  assert.equal(s.isQuiet(28000, 15), true);
  assert.equal(s.isQuiet(42999, 30), false);
  assert.equal(s.isQuiet(43000, 30), true);
  assert.equal(s.isQuiet(120000, 300), false); // No 30/60/120 second cutoff.
  assert.equal(s.isQuiet(313000, 300), true);
  s.lastNetworkActivityAt = 0;
  assert.equal(s.isQuiet(2147483648, 3000000), false);
  assert.equal(s.isQuiet(3000000000, 3000000), true);
  assert.equal(s.isQuiet(Number.MAX_VALUE, Number.MAX_VALUE), false);
});

test('open requests and pending bodies allow quiet; graceful export preserves both and waits for bodies', async () => {
  let resolveBody;
  const body = new Promise((resolve) => { resolveBody = resolve; });
  const s = session({ command: () => body });
  request(s); response(s);
  assert.equal(s.records.size, 1);
  assert.equal(s.isQuiet(s.lastNetworkActivityAt + 15000, 15), true);
  finish(s);
  assert.equal(s.records.size, 0);
  assert.equal(s.pendingFinalizations.size, 1);
  request(s, 'stream', { type: 'Media', request: { url: 'https://example.com/stream', method: 'GET' } });
  response(s, 'stream');
  const openRecord = s.records.get('stream');
  assert.equal(s.isQuiet(s.lastNetworkActivityAt + 14999, 15), false);
  assert.equal(s.isQuiet(s.lastNetworkActivityAt + 15000, 15), true);
  let built = false;
  const building = s.buildHar('test').then((har) => { built = true; return har; });
  assert.equal(s.records.size, 0);
  assert.equal(openRecord.finishedReason, 'incomplete');
  await Promise.resolve();
  assert.equal(built, false);
  assert.equal(s.detached, false); // Body commands remain available during graceful export.
  resolveBody(fixture.responseBody);
  const har = await building;
  assert.equal(har.log.entries.length, 2);
  assert.equal(har.log.entries[0].response.content.text, fixture.responseBody.body);
  assert.equal(har.log.entries[0].response._error, undefined);
  assert.equal(har.log.entries[1].request.url, 'https://example.com/stream');
  assert.equal(har.log.entries[1].response.content.text, undefined);
  assert.match(har.log.entries[1].response._error, /Incomplete request/);
  assert.equal(s.getDiagnostics().omissions.incomplete, 1);
  assert.equal(s.pendingFinalizations.size, 0);
  assert.equal(s.isQuiet(s.lastNetworkActivityAt + 15000, 15), true);
  s.detached = true;
  // A closed tab's recent traffic still counts while other tabs remain attached.
  assert.equal(s.isQuiet(s.lastNetworkActivityAt + 14999, 15), false);
  assert.equal(s.isQuiet(s.lastNetworkActivityAt + 15000, 15), true);
});

test('captured request, response, cache, transfer, completion and failure activity each reset quiet', () => {
  const s = session({ responses: false });
  for (const [name, activity] of [
    ['request', () => request(s)],
    ['response', () => response(s)],
    ['cache', () => s.handleEvent('Network.requestServedFromCache', { requestId: 'r' })],
    ['data', () => s.handleEvent('Network.dataReceived', { requestId: 'r', dataLength: 1024 })],
    ['finished', () => finish(s)],
    ['new request', () => request(s, 'failed')],
    ['failed', () => s.handleEvent('Network.loadingFailed', { requestId: 'failed', timestamp: finishEvent.timestamp })]
  ]) {
    s.lastNetworkActivityAt = -30000;
    activity();
    assert.ok(s.lastNetworkActivityAt >= 0, name);
    assert.equal(s.isQuiet(s.lastNetworkActivityAt + 14999, 15), false, name);
    assert.equal(s.isQuiet(s.lastNetworkActivityAt + 15000, 15), true, name);
  }
  assert.equal(s.allRecords[0].decodedBodyLength, 1024);
});

test('Page, Runtime, metadata-only events and existing excluded schemes do not reset network quiet', () => {
  const s = session({ responses: false });
  request(s);
  for (const [method, params] of [
    ['Page.lifecycleEvent', { loaderId: requestEvent.loaderId, frameId: requestEvent.frameId, name: 'load', timestamp: finishEvent.timestamp }],
    ['Runtime.consoleAPICalled', {}],
    ['Network.resourceChangedPriority', { requestId: 'r', newPriority: 'High' }],
    ['Network.requestWillBeSentExtraInfo', { requestId: 'r', headers: {} }],
    ['Network.responseReceivedExtraInfo', { requestId: 'r', headers: {} }],
    ['Network.dataReceived', { requestId: 'unknown', dataLength: 1 }]
  ]) {
    s.lastNetworkActivityAt = 1000;
    s.handleEvent(method, params);
    assert.equal(s.lastNetworkActivityAt, 1000, method);
    assert.equal(s.isQuiet(16000, 15), true, method);
  }
  for (const url of ['data:text/plain,hello', 'chrome-extension://test/script.js']) {
    s.lastNetworkActivityAt = 1000;
    request(s, 'excluded', { request: { url, method: 'GET' } });
    response(s, 'excluded', { response: { url, status: 200 } });
    s.handleEvent('Network.dataReceived', { requestId: 'excluded', dataLength: 5 });
    finish(s, 'excluded');
    assert.equal(s.lastNetworkActivityAt, 1000, url);
  }
});

// Exercise only the notice functions with minimal DOM/storage state; no browser or CDP mock.
function noticeWorkspace(window) {
  const source = readFileSync(new URL('../extension/src/capture/capture.js', import.meta.url), 'utf8');
  const elements = { autoCaptureNotice: { hidden: true }, autoCaptureNoticeText: { textContent: '' } };
  const declarations = source.match(/^const AUTO_CAPTURE_NOTICE_KEY = .*;$/m)[0];
  const functions = ['showAutoCaptureNotice', 'acknowledgeAutoCaptureNotice']
    .map((name) => source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))[0]).join('\n');
  return { elements, ...runInNewContext(`${declarations}\nlet autoCaptureNoticeAcknowledged = false;\n${functions}\n({ show: showAutoCaptureNotice, acknowledge: acknowledgeAutoCaptureNotice })`,
    { window, elements, isNetworkQuietMode }) };
}

test('automatic notice uses the snapshot, persists only explicit acknowledgement and never appears for Live', () => {
  const saved = new Map();
  const window = { localStorage: { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) } };
  let ui = noticeWorkspace(window);
  ui.show('live', null);
  assert.equal(ui.elements.autoCaptureNotice.hidden, true);
  ui.show('refresh', 15);
  assert.equal(ui.elements.autoCaptureNotice.hidden, false);
  assert.match(ui.elements.autoCaptureNoticeText.textContent, /after 15 seconds of network quiet/);
  assert.equal(saved.size, 0);
  ui = noticeWorkspace(window); // Closing without Got it must not acknowledge.
  ui.show('url-list', 30);
  assert.equal(ui.elements.autoCaptureNotice.hidden, false);
  assert.match(ui.elements.autoCaptureNoticeText.textContent, /after 30 seconds of network quiet/);
  ui.acknowledge();
  assert.equal(ui.elements.autoCaptureNotice.hidden, true);
  assert.deepEqual([...saved], [['myhar.autoCaptureNotice.v1', 'acknowledged']]);
  ui = noticeWorkspace(window);
  ui.show('refresh', 30);
  assert.equal(ui.elements.autoCaptureNotice.hidden, true);
});

test('unavailable localStorage and read/write failures cannot break the notice or capture startup', () => {
  for (const window of [
    {},
    { get localStorage() { throw new Error('unavailable'); } },
    { localStorage: { getItem() { throw new Error('read denied'); }, setItem() { throw new Error('write denied'); } } }
  ]) {
    const ui = noticeWorkspace(window);
    assert.doesNotThrow(() => ui.show('refresh', 15));
    assert.equal(ui.elements.autoCaptureNotice.hidden, false);
    assert.doesNotThrow(() => ui.acknowledge());
    ui.show('url-list', 30);
    assert.equal(ui.elements.autoCaptureNotice.hidden, true); // In-memory dismissal still works.
    const reopened = noticeWorkspace(window);
    reopened.show('refresh', 15);
    assert.equal(reopened.elements.autoCaptureNotice.hidden, false);
  }
});

test('ZIP manifest records the configured quiet duration, with null for manual Live Capture', async () => {
  for (const [mode, seconds] of [['refresh', 15], ['url-list', 30], ['refresh', 3000000], ['refresh', Number.MAX_VALUE], ['live', null]]) {
    const zip = await buildCaptureZip({ sessions: new Map(), startedAt: new Date(), mode,
      skippedTabs: [], includeRequestBodies: true, includeResponseBodies: true, maxResponseBodyBytes: 26214400,
      networkQuietTimeoutSeconds: seconds, stopReason: mode === 'live' ? 'manual_export' : 'network_quiet',
      budget: new CaptureBudget(), visibilitySnapshot: () => ({}) }, 'test');
    const manifest = readZip(zip.bytes).get(`${zip.fileName.slice(0, -4)}/manifest.json`);
    assert.equal(manifest.network_quiet_timeout_seconds, seconds);
    assert.equal(manifest.stop_reason, mode === 'live' ? 'manual_export' : 'network_quiet');
    assert.equal(manifest.max_response_body_bytes, 26214400);
  }
});

test('actual Chrome CDP fixture: HTTP, headers, body, timing, lifecycle and DevTools metadata', async () => {
  const s = session();
  for (const event of fixture.events) s.handleEvent(event.method, structuredClone(event.params));
  const har = await s.buildHar('0.1.6');
  const entry = har.log.entries[0];
  assert.equal(har.log.entries.length, 1);
  assert.equal(entry.response.status, 200);
  assert.equal(entry.response.httpVersion, 'http/2.0');
  assert.equal(entry._resourceType, 'document');
  assert.equal(entry.response.content.text, fixture.responseBody.body);
  assert.equal(entry.response._transferSize, finishEvent.encodedDataLength);
  assert.equal(entry.response.bodySize, -1); // HTTP/2 has no raw header block size.
  assert.equal(entry.response.content.size, 559);
  assert.ok(entry.timings.dns > 0);
  assert.ok(entry.timings.ssl > 0);
  assert.ok(entry.timings.wait > 0);
  assert.ok(har.log.pages[0].pageTimings.onContentLoad > 0);
  assert.ok(har.log.pages[0].pageTimings.onLoad >= har.log.pages[0].pageTimings.onContentLoad);
  assert.equal(entry._requestId, undefined);
  assert.equal(entry.response.content._harzipBodyError, undefined);
  assertFinite(har);
});

test('redirect chain queues late ExtraInfo separately for each hop, including a hop with no ExtraInfo', async () => {
  const commands = [];
  const s = session({ command: async (method, params) => { commands.push([method, params]); return { body: 'final' }; } });
  request(s);
  request(s, 'r', { request: { url: 'https://example.com/second', method: 'GET', headers: { hop: '1' } },
    timestamp: requestEvent.timestamp + 0.1, redirectResponse: { status: 302, headers: { location: '/second' }, protocol: 'http/1.1' }, redirectHasExtraInfo: true });
  request(s, 'r', { request: { url: 'https://example.com/final', method: 'GET', headers: { hop: '2' } },
    timestamp: requestEvent.timestamp + 0.2, redirectResponse: { status: 301, headers: { location: '/final' } }, redirectHasExtraInfo: false });
  response(s, 'r', { hasExtraInfo: true });
  finish(s);
  for (const hop of ['0', '2']) {
    s.handleEvent('Network.requestWillBeSentExtraInfo', { requestId: 'r', headers: { hop } });
    s.handleEvent('Network.responseReceivedExtraInfo', { requestId: 'r', statusCode: hop === '0' ? 302 : 200, headers: { hop } });
  }
  assert.deepEqual(s.allRecords.map((record) => record.id), ['r#0', 'r#1', 'r#2']);
  const entries = (await s.buildHar('test')).log.entries;
  assert.deepEqual(entries.map((entry) => entry.response.status), [302, 301, 200]);
  assert.deepEqual(entries.map((entry) => entry.request.headers.find((header) => header.name === 'hop').value), ['0', '1', '2']);
  assert.equal(entries[0].response.redirectURL, 'https://example.com/second');
  assert.equal(entries[1].response.redirectURL, 'https://example.com/final');
  assert.deepEqual(commands, [['Network.getResponseBody', { requestId: 'r' }]]);
  assert.equal(entries[0].response.content.text, undefined);
});

test('ExtraInfo arriving before base events is FIFO; ambiguous unsignaled hops are never skipped', async () => {
  const s = session({ responses: false });
  for (const hop of ['first', 'second']) s.handleEvent('Network.requestWillBeSentExtraInfo', { requestId: 'r', headers: { hop } });
  request(s);
  request(s, 'r', { redirectResponse: { status: 302 }, redirectHasExtraInfo: true });
  response(s, 'r', { hasExtraInfo: true });
  assert.deepEqual(s.allRecords.map((record) => record.requestHeaders.hop), ['first', 'second']);
  const unknown = session({ responses: false });
  request(unknown);
  request(unknown, 'r', { redirectResponse: { status: 302 }, redirectHasExtraInfo: undefined });
  response(unknown, 'r', { hasExtraInfo: true });
  unknown.handleEvent('Network.requestWillBeSentExtraInfo', { requestId: 'r', headers: { secret: 'prior hop' } });
  assert.equal(unknown.allRecords[1].requestHeaders.secret, undefined);
  assert.equal(unknown.getDiagnostics().unmatchedExtraInfo, 1);
});

test('post-data command racing a redirect cannot write the next hop body onto the old hop', async () => {
  let resolvePost;
  const calls = [];
  const s = session({ responses: false, command: (method, params) => {
    calls.push([method, params]); return new Promise((resolve) => { resolvePost = resolve; });
  } });
  request(s, 'r', { request: { url: tab.url, method: 'POST', hasPostData: true } });
  await Promise.resolve();
  request(s, 'r', { redirectResponse: { status: 302 }, redirectHasExtraInfo: false });
  resolvePost({ postData: 'possibly the next hop' });
  const entries = (await s.buildHar('test')).log.entries;
  assert.equal(entries[0].request.postData, undefined);
  assert.deepEqual(calls, [['Network.getRequestPostData', { requestId: 'r' }]]);
});

test('cache has zero transfer and unavailable connection phases, preserving useful wait/queueing', async () => {
  const s = session();
  request(s);
  s.handleEvent('Network.requestServedFromCache', { requestId: 'r' });
  response(s);
  finish(s);
  const entry = (await s.buildHar('test')).log.entries[0];
  assert.equal(entry._fromCache, 'memory');
  assert.equal(entry.response._transferSize, 0);
  for (const key of ['dns', 'connect', 'ssl']) assert.equal(entry.timings[key], -1);
  assert.ok(entry.timings.wait >= 0);
  assertFinite(entry);
  const cachedRecord = s.allRecords[0];
  cachedRecord.response.timing.requestTime -= 60;
  const stale = buildTimings(cachedRecord);
  assert.ok(stale.receive < 1000, 'Previous fetch timestamps must not inflate cache receive time');
  assert.equal(stale.dns, -1);
});

test('304 revalidation is distinct from a no-network cache hit; entity and transfer sizes stay separate', () => {
  const record = { request: { url: tab.url }, response: { status: 304, fromDiskCache: true },
    responseStatusCode: 304, encodedDataLength: 120, decodedBodyLength: 500 };
  const entry = buildHarEntry(record);
  assert.equal(entry.response._transferSize, 120);
  assert.equal(entry.response.bodySize, 0);
  assert.equal(entry.response.content.size, 500);
});

test('missing/invalid timing inputs never generate NaN, Infinity, undefined or phases below -1', () => {
  for (const timing of [undefined, {}, { dnsStart: -1, dnsEnd: -1 },
    { requestTime: NaN, dnsStart: Infinity, connectEnd: -999999, sendEnd: Infinity, receiveHeadersEnd: -Infinity },
    { requestTime: 10, sendStart: 50, sendEnd: 20, sslStart: 30, sslEnd: 10 }]) {
    const record = { request: { url: tab.url }, response: { timing }, startTimestamp: 10, endTimestamp: 11 };
    const entry = buildHarEntry(record);
    assertFinite(entry);
    Object.values(entry.timings).forEach((value) => assert.ok(value >= -1));
    assert.doesNotMatch(JSON.stringify(entry), /:\s*(NaN|Infinity|-Infinity|undefined)/);
  }
  assert.equal(buildTimings({}).dns, -1);
});

test('body command failures settle and produce valid ZIP plus manifest diagnostics', async () => {
  const s = session({ command: async (_method, params) => {
    if (params.requestId === 'ok') return { body: 'successful body' };
    throw new Error('No resource with given identifier found');
  } });
  request(s, 'r', { request: { url: tab.url, method: 'POST', hasPostData: true } });
  response(s); finish(s);
  request(s, 'ok'); response(s, 'ok'); finish(s, 'ok');
  const coordinator = { sessions: new Map([[tab.id, s]]), startedAt: new Date(), mode: 'live',
    skippedTabs: [], includeRequestBodies: true, includeResponseBodies: true, maxResponseBodyBytes: 26214400,
    stopReason: 'manual_export', budget: s.budget, visibilitySnapshot: () => ({ started_hidden: false, hidden_during_capture: false, hidden_duration_ms: 0 }) };
  const zip = await buildCaptureZip(coordinator, '0.1.6');
  assert.equal(zip.manifest.body_capture_errors.length, 2);
  assert.equal(zip.manifest.omitted_response_bodies, 1);
  assert.equal(zip.manifest.stop_reason, 'manual_export');
  assert.equal(zip.manifest.har_profile, 'chrome-devtools-aligned');
  const files = readZip(zip.bytes);
  assert.equal(files.size, 2);
  const har = [...files].find(([name]) => name.endsWith('.har'))[1];
  assert.deepEqual(har.log.creator, { name: 'myhar', version: '0.1.6' });
  assert.equal(har.log.entries.length, 2);
  assert.equal(har.log.entries[1].response.content.text, 'successful body');
  assertFinite(har);
  assert.equal(s.allRecords.length, 0);
});

test('protocol/resource normalization and service-worker metadata preserve repeated requests', async () => {
  assert.equal(normalizeProtocol('h2'), 'http/2.0');
  assert.equal(normalizeProtocol('h3'), 'h3');
  for (const type of ['Document', 'Script', 'Stylesheet', 'Image', 'XHR', 'Fetch']) assert.equal(normalizeResourceType(type), type.toLowerCase());
  const s = session({ responses: false });
  for (const id of ['one', 'two']) {
    request(s, id);
    response(s, id, { response: { fromServiceWorker: true, serviceWorkerResponseSource: 'cache-storage',
      timing: { workerStart: 1, workerReady: 2, workerFetchStart: 3, workerRespondWithSettled: 4 } } });
    finish(s, id);
  }
  const entries = (await s.buildHar('test')).log.entries;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].response._fetchedViaServiceWorker, true);
  assert.equal(entries[0].response._serviceWorkerResponseSource, 'cache-storage');
  assert.equal(entries[0].timings._workerReady, 2);
});

test('non-network schemes are excluded before body retrieval and counted without retaining data URLs', async () => {
  const s = session({ command: async () => { assert.fail('Excluded scheme triggered a body command'); } });
  for (const url of ['data:text/plain,secret', 'chrome-extension://example/image.png', 'blob:https://example.com/id', 'ws://example.com/']) {
    request(s, url, { request: { url, hasPostData: true, postData: 'secret' } }); finish(s, url);
    assert.equal(buildHarEntry({ request: { url } }), null);
  }
  assert.equal((await s.buildHar('test')).log.entries.length, 0);
  assert.deepEqual(s.excludedEntries, { data: 1, 'chrome-extension': 1, blob: 1, ws: 1 });
});

test('body settings, empty POST, per-resource limit and global UTF-16/base64 accounting are independent', async () => {
  const empty = buildHarEntry({ request: { url: tab.url, method: 'POST' }, requestHasPostData: true, requestPostData: '' });
  assert.equal(empty.request.bodySize, 0);
  assert.equal(empty.request.postData.text, '');
  const disabled = session({ requests: false, responses: false });
  request(disabled, 'r', { request: { url: tab.url, hasPostData: true, postData: 'private', postDataEntries: [{ bytes: 'cHJpdmF0ZQ==' }] } });
  response(disabled); finish(disabled);
  const noBodies = (await disabled.buildHar('test')).log.entries[0];
  assert.equal(noBodies.request.postData, undefined);
  assert.equal(noBodies.response.content.text, undefined);
  assert.equal(disabled.allRecords[0].request.postData, undefined);
  assert.equal(disabled.allRecords[0].request.postDataEntries, undefined);
  let stops = 0;
  const budget = new CaptureBudget(() => { stops += 1; }, { maxBodyBytes: 12, maxRecords: 20 });
  const limited = session({ budget, maxBody: 2, command: async () => ({ body: 'abcdef' }) });
  request(limited); response(limited); finish(limited);
  await limited.buildHar('test');
  assert.equal(limited.allRecords[0].responseBodyOmittedReason, 'per_resource_limit');
  assert.equal(budget.retainedBodyBytes, 0);
  assert.equal(budget.limitReached, false);
  const global = session({ budget, maxBody: 0, command: async () => ({ body: 'YWJjZGU=', base64Encoded: true }) });
  request(global); response(global); finish(global);
  await global.buildHar('test');
  assert.equal(global.allRecords[0].responseBodyOmittedReason, 'memory_safety_limit');
  assert.equal(stops, 1);
  assert.equal(budget.retainedBodyBytes, 0);
});

test('HAR filenames use up to three ASCII title words and Windows-safe readable hosts', () => {
  const cases = [
    ['www.youtube.com', 'YouTube', 'www.youtube.com_YouTube.har'],
    ['www.roblox.com', 'Baixar o aplicativo Roblox', 'www.roblox.com_Baixar_o_aplicativo.har'],
    ['www.youtube.com', 'YouTube Music Premium', 'www.youtube.com_YouTube_Music_Premium.har'],
    ['www.youtube.com', 'Confira o último lançamento', 'www.youtube.com_Confira_o_ultimo.har'],
    ['example.com', 'AÇÃO NÃO DISPONÍVEL', 'example.com_ACAO_NAO_DISPONIVEL.har'],
    ['example.com', 'vídeo', 'example.com_video.har'],
    ['example.com', 'title with / invalid : characters ? *', 'example.com_title_with_invalid.har'],
    ['www.youtube.com', ' .<>:"/\\|?*__ Bem  \t na\n Hora... ', 'www.youtube.com_Bem_na_Hora.har'],
    ['example.com', '', 'example.com_untitled.har'],
    ['example.com', undefined, 'example.com_untitled.har'],
    ['example.com', ' .<>:"/\\|?*__ 🎬 ', 'example.com_untitled.har'],
    ['.example.com.', 'Page', 'example.com_Page.har'],
    ['example__host.com', 'Page', 'example_host.com_Page.har'],
    ['con.example', 'Page', 'host-con.example_Page.har']
  ];
  for (const [host, title, expected] of cases) {
    const sourceTab = { id: 1278132675, url: `https://${host}/`, title };
    const original = { ...sourceTab };
    const name = buildHarFileName(sourceTab);
    assert.equal(name, expected);
    assert.doesNotMatch(name, /[<>:"/\\|?*\s]|__|^[._]|[. ]$/);
    assert.deepEqual(sourceTab, original);
  }
  for (const url of [undefined, '', 'not a URL', 'file:///tmp/page.html', 'https://???']) {
    assert.equal(buildHarFileName({ url, title: 'Page' }), 'unknown-host_Page.har');
  }
});

test('HAR filename collisions use the final case-insensitive name within the current export', () => {
  const usedNames = new Set();
  const sourceTab = { url: 'https://example.com/', title: 'Test Page Title' };
  assert.deepEqual([1, 2, 3].map(() => buildHarFileName(sourceTab, usedNames)), [
    'example.com_Test_Page_Title.har', 'example.com_Test_Page_Title_2.har', 'example.com_Test_Page_Title_3.har'
  ]);
  assert.equal(buildHarFileName({ ...sourceTab, title: 'test page title other words' }, usedNames),
    'example.com_test_page_title_4.har');
  assert.equal(buildHarFileName({ ...sourceTab, url: 'https://other.example.com/' }, usedNames),
    'other.example.com_Test_Page_Title.har');
  assert.equal(buildHarFileName(sourceTab, new Set()), 'example.com_Test_Page_Title.har');

  const naturalSuffixes = new Set();
  assert.equal(buildHarFileName({ ...sourceTab, title: 'Test Page 2' }, naturalSuffixes), 'example.com_Test_Page_2.har');
  assert.equal(buildHarFileName({ ...sourceTab, title: 'Test Page' }, naturalSuffixes), 'example.com_Test_Page.har');
  assert.equal(buildHarFileName({ ...sourceTab, title: 'Test Page' }, naturalSuffixes), 'example.com_Test_Page_3.har');
});

test('HAR filename length includes collision suffixes and preserves ordinary hostnames', () => {
  const usedNames = new Set();
  const sourceTab = { url: 'https://example.com/', title: `${'A'.repeat(500)} second third fourth` };
  const names = Array.from({ length: 12 }, () => buildHarFileName(sourceTab, usedNames));
  assert.equal(new Set(names).size, 12);
  for (const [index, name] of names.entries()) {
    const suffix = index === 0 ? '' : `_${index + 1}`;
    assert.equal(name, `example.com_${'A'.repeat(144 - suffix.length)}${suffix}.har`);
    assert.equal(name.length, 160);
  }
  const endsOnSeparator = buildHarFileName({ ...sourceTab, title: `${'A'.repeat(143)} More Words` });
  assert.equal(endsOnSeparator, `example.com_${'A'.repeat(143)}.har`);
  const longHost = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.com`;
  const longName = buildHarFileName({ url: `https://${longHost}/`, title: 'Title' });
  assert.equal(longName.length, 160);
  assert.ok(longName.endsWith('_T.har'));
  assert.equal(longName, buildHarFileName({ url: `https://${longHost}/`, title: 'Title' }));
});

test('ZIP members and manifest share exact descriptive names and pretty JSON without changing HAR data', async () => {
  const tabs = ['Confira o último lançamento', 'Confira o último vídeo', 'Confira o último áudio', 'Confira o último lançamento']
    .map((title, index) => ({ id: 1278132675 + index, title,
      url: `https://${index === 3 ? 'other.example.com' : 'example.com'}/watch?v=${index}` }));
  const hars = tabs.map((sourceTab) => ({ log: { version: '1.2', creator: { name: 'myhar', version: '0.1.6' },
    pages: [{ id: 'page_1', title: sourceTab.title, startedDateTime: '2026-09-23T12:00:00.000Z', pageTimings: {} }], entries: [] } }));
  const expectedNames = ['example.com_Confira_o_ultimo.har', 'example.com_Confira_o_ultimo_2.har',
    'example.com_Confira_o_ultimo_3.har', 'other.example.com_Confira_o_ultimo.har'];
  // Export twice to ensure collision state never leaks into the next archive.
  for (let exportIndex = 0; exportIndex < 2; exportIndex += 1) {
    const sessions = tabs.map((sourceTab, index) => [sourceTab.id, {
      tab: sourceTab, status: 'stopped', detached: false, detachReason: null, excludedEntries: {},
      startedAt: new Date('2026-09-23T12:00:00Z'), buildHar: async () => hars[index], releaseRecords() {},
      getDiagnostics: () => ({ bodyErrors: [], omittedResponseBodies: 0, omissions: {}, unmatchedExtraInfo: 0, diagnostics: {} })
    }]);
    const zip = await buildCaptureZip({ sessions: new Map(sessions), startedAt: new Date('2026-09-23T12:00:00Z'),
      mode: 'live', skippedTabs: [], includeRequestBodies: true, includeResponseBodies: true, maxResponseBodyBytes: 26214400,
      stopReason: 'manual_export', budget: new CaptureBudget(), visibilitySnapshot: () => ({}) }, '0.1.6');
    const files = readZip(zip.bytes, false);
    const root = zip.fileName.slice(0, -4);
    assert.equal(files.size, tabs.length + 1);
    for (const [index, capture] of zip.manifest.captures.entries()) {
      assert.equal(capture.file, `tabs/${expectedNames[index]}`);
      assert.equal(capture.tab_id, tabs[index].id);
      assert.equal(capture.tab_title, tabs[index].title);
      assert.equal(capture.url, tabs[index].url);
      const text = files.get(`${root}/${capture.file}`);
      assert.ok(text.startsWith('{\n  "log": {\n'));
      assert.ok(text.endsWith('\n'));
      assert.equal(text, `${JSON.stringify(hars[index], null, 2)}\n`);
      assert.deepEqual(JSON.parse(text), hars[index]);
    }
    assert.equal(files.get(`${root}/manifest.json`), `${JSON.stringify(zip.manifest, null, 2)}\n`);
  }
});

test('ZIP store fallback works without CompressionStream', async () => {
  const compression = globalThis.CompressionStream;
  try {
    globalThis.CompressionStream = undefined;
    const bytes = await createZip([{ path: 'manifest.json', data: new TextEncoder().encode('{"local_only":true}') }]);
    assert.equal(new DataView(bytes.buffer).getUint16(8, true), 0);
    assert.deepEqual(readZip(bytes).get('manifest.json'), { local_only: true });
  } finally { globalThis.CompressionStream = compression; }
});

test('global record ceiling stops once across multiple sessions and rejects further records', async () => {
  let stops = 0;
  const budget = new CaptureBudget(() => { stops += 1; }, { maxRecords: 3 });
  const a = session({ budget, responses: false });
  const b = session({ budget, responses: false });
  request(a, '1'); request(b, '2'); request(a, '3'); request(b, '4');
  await Promise.resolve();
  assert.equal(stops, 1);
  assert.equal(a.allRecords.length + b.allRecords.length, 3);
  assert.equal(budget.recordCount, 3);
});

test('detach is terminal for one session while another continues; lifecycle never crosses loaders', async () => {
  const a = session({ responses: false });
  const b = session({ responses: false });
  request(a); response(a);
  await a.handleDetach('target_closed');
  request(a, 'ignored');
  request(b); response(b); finish(b);
  assert.equal(a.allRecords.length, 1);
  assert.equal(a.records.size, 0);
  assert.equal(a.detachReason, 'target_closed');
  b.handleEvent('Page.lifecycleEvent', { frameId: requestEvent.frameId, loaderId: 'unrelated', name: 'load', timestamp: requestEvent.timestamp + 1 });
  const har = await b.buildHar('test');
  assert.equal(har.log.entries.length, 1);
  assert.equal(har.log.pages[0].pageTimings.onLoad, -1);
});

test('workspace closure dispatches detach immediately without awaiting a network command', () => {
  const originalChrome = globalThis.chrome;
  const calls = [];
  globalThis.chrome = { runtime: {}, debugger: { detach: (target, callback) => { calls.push(target); callback(); } } };
  try {
    const s = session({ command: () => assert.fail('Unload must not await Network.disable') });
    s.attached = true;
    s.detachOnWorkspaceClose();
    assert.deepEqual(calls, [{ tabId: tab.id }]);
    assert.equal(s.terminal, true);
    assert.equal(s.detached, true);
    s.detachOnWorkspaceClose();
    assert.equal(calls.length, 1);
  } finally { globalThis.chrome = originalChrome; }
});
