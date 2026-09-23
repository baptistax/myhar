// CDP -> HAR only. No Chrome APIs, workspace state, or download side effects.
// Field/phase conventions: Chromium front_end/models/har/Log.ts.
export function schemeOf(url) {
  return /^([a-z][a-z0-9+.-]*):/i.exec(String(url || ''))?.[1].toLowerCase() || 'unknown';
}

export function isHttpUrl(url) {
  return ['http', 'https'].includes(schemeOf(url));
}

export function normalizeProtocol(protocol) {
  const value = String(protocol || '').toLowerCase();
  if (value === 'h2' || value === 'http/2') return 'http/2.0';
  return value.replace(/^http\/2(?:\.0)?\+/, 'http/2.0+') || '';
}

export function normalizeResourceType(type) {
  return String(type || 'other').toLowerCase();
}

const known = (value) => Number.isFinite(value) && value >= 0;
const phase = (start, end) => known(start) && known(end) && end >= start ? end - start : -1;
const milliseconds = (start, end) => {
  const seconds = phase(start, end);
  return seconds < 0 || !Number.isFinite(seconds * 1000) ? -1 : seconds * 1000;
};

export function isNoNetworkCacheHit(record) {
  // A 304 is a network revalidation, even when the entity came from disk.
  if (record.responseStatusCode === 304 || record.response?.status === 304) return false;
  return Boolean(record.servedFromCache || record.response?.fromDiskCache || record.response?.fromPrefetchCache);
}

export function buildTimings(record) {
  const cached = isNoNetworkCacheHit(record);
  const rawTiming = record.response?.timing;
  // Memory-cache responses can repeat ResourceTiming from the original fetch.
  // Those offsets cannot describe this hop; use this hop's event timestamps.
  const timing = cached && (!known(rawTiming?.requestTime) || rawTiming.requestTime < record.startTimestamp)
    ? undefined : rawTiming;
  const result = { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: -1, receive: -1 };
  const issue = record.startTimestamp;
  const base = known(timing?.requestTime) ? timing.requestTime : issue;
  const queueing = milliseconds(issue, base);
  if (timing && queueing >= 0) {
    result._blocked_queueing = queueing;
    result.blocked = queueing;
  }
  let lastPhase = 0;
  if (timing) {
    // Cache/SW timing can still describe meaningful queueing, sending and waiting.
    const starts = (cached ? [timing.sendStart] : [timing.dnsStart, timing.connectStart, timing.sendStart]).filter(known);
    const stalled = starts.length ? Math.min(...starts) : 0;
    if (starts.length) result.blocked = Math.max(0, result.blocked) + stalled;
    const proxy = phase(timing.proxyStart, timing.proxyEnd);
    if (proxy >= 0) {
      result._blocked_proxy = proxy;
      result.blocked = Math.max(result.blocked, proxy);
    }
    if (!cached) {
      result.dns = phase(stalled, timing.dnsEnd);
      const connectionStart = known(timing.dnsEnd) ? timing.dnsEnd : stalled;
      result.connect = phase(connectionStart, timing.connectEnd);
      result.ssl = phase(timing.sslStart, timing.sslEnd);
    }
    const beforeSend = Math.max(stalled, cached ? 0 : Math.max(
      known(timing.dnsEnd) ? timing.dnsEnd : 0, known(timing.connectEnd) ? timing.connectEnd : 0));
    if (known(timing.sendEnd)) result.send = Math.max(0, timing.sendEnd - beforeSend);
    lastPhase = Math.max(beforeSend, known(timing.sendEnd) ? timing.sendEnd : 0);
    for (const key of ['workerStart', 'workerReady', 'workerFetchStart', 'workerRespondWithSettled',
      'workerRouterEvaluationStart', 'workerCacheLookupStart']) {
      if (Number.isFinite(timing[key]) && timing[key] >= -1) result[`_${key}`] = timing[key];
    }
  }
  // DevTools uses receiveHeadersEnd (last header byte), not dispatch latency.
  const headersTime = known(timing?.receiveHeadersEnd) && known(base)
    ? base + timing.receiveHeadersEnd / 1000 : record.responseTimestamp;
  const headerOffset = milliseconds(base, headersTime);
  if (headerOffset >= 0) result.wait = Math.max(0, headerOffset - lastPhase);
  result.receive = milliseconds(headersTime, record.endTimestamp);
  if (!known(headersTime) && !timing) result.blocked = milliseconds(issue, record.endTimestamp);
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isFinite(value) || value < -1) result[key] = -1;
  }
  return result;
}

function dateString(wallTime, fallback) {
  const value = Number.isFinite(wallTime) ? new Date(wallTime * 1000) : new Date(fallback || 0);
  return Number.isFinite(value.getTime()) ? value.toISOString() : new Date(0).toISOString();
}

// Optional CDP metadata may contain unavailable values; never serialize invalid numbers.
function finiteMetadata(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : -1;
  if (Array.isArray(value)) return value.filter((item) => item !== undefined).map(finiteMetadata);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).map(([key, item]) => [key, finiteMetadata(item)]));
  return value;
}

export function buildHarEntry(record, pageRef = record.pageRef) {
  const request = record.request || {};
  if (!isHttpUrl(request.url)) return null;
  const response = record.response || {};
  const requestHeaders = record.requestHeaders || request.headers || {};
  const responseHeaders = record.responseHeaders || response.headers || {};
  const status = normalizeStatus(record.responseStatusCode ?? response.status ?? 0);
  const cached = isNoNetworkCacheHit(record);
  const transferSize = cached ? 0 : known(record.encodedDataLength) ? record.encodedDataLength : -1;
  const headersSize = record.responseHeadersText ? textToBytes(record.responseHeadersText).length : -1;
  const noEntity = request.method === 'HEAD' || [204, 304].includes(status);
  const bodySize = cached || noEntity ? 0 : transferSize >= 0 && headersSize >= 0
    ? Math.max(0, transferSize - headersSize) : -1;
  const content = {
    size: known(record.decodedBodyLength) ? record.decodedBodyLength : known(record.responseBodySize)
      ? record.responseBodySize : noEntity ? 0 : -1,
    mimeType: response.mimeType || headerValue(responseHeaders, 'content-type') || 'x-unknown'
  };
  if (!cached && ![206, 304].includes(status) && content.size >= 0 && bodySize >= 0) {
    content.compression = content.size - bodySize;
  }
  if (typeof record.responseBodyText === 'string') {
    content.text = record.responseBodyText;
    if (record.responseBodyBase64Encoded) content.encoding = 'base64';
  }
  const timings = buildTimings(record);
  const entry = {
    startedDateTime: dateString(record.wallTime, record.receivedAt),
    time: ['blocked', 'dns', 'connect', 'send', 'wait', 'receive']
      .reduce((total, key) => total + Math.max(0, timings[key]), 0),
    request: {
      method: request.method || 'GET', url: request.url.split('#')[0],
      httpVersion: record.requestHeadersText?.split('\r\n')[0].match(/HTTP\/\d+\.\d+$/)?.[0]
        || headerValue(requestHeaders, ':version') || headerValue(requestHeaders, 'version') || normalizeProtocol(response.protocol),
      cookies: parseRequestCookies(requestHeaders), headers: objectToHarHeaders(requestHeaders),
      queryString: parseQueryString(request.url),
      headersSize: record.requestHeadersText ? textToBytes(record.requestHeadersText).length : -1,
      bodySize: requestPostBodySize(record)
    },
    response: {
      status, statusText: response.statusText || '',
      httpVersion: record.responseHeadersText?.match(/^HTTP\/\d+\.\d+/)?.[0] || normalizeProtocol(response.protocol),
      cookies: parseResponseCookies(responseHeaders), headers: objectToHarHeaders(responseHeaders), content,
      redirectURL: record.redirectedTo || headerValue(responseHeaders, 'location') || '',
      headersSize, bodySize, _transferSize: transferSize
    },
    cache: {}, timings, _resourceType: normalizeResourceType(record.type)
  };
  if (pageRef) entry.pageref = pageRef;
  if (record.priority || request.initialPriority) entry._priority = record.priority || request.initialPriority;
  if (record.initiator) entry._initiator = finiteMetadata(record.initiator);
  if (response.remoteIPAddress) entry.serverIPAddress = response.remoteIPAddress.replace(/[\[\]]/g, '');
  if (known(response.remotePort) && response.remotePort > 0) entry.connection = String(response.remotePort);
  if (known(response.connectionId) && response.connectionId !== 0) entry._connectionId = String(response.connectionId);
  if (cached) entry._fromCache = record.servedFromCache ? 'memory' : 'disk';
  if (record.errorText) entry.response._error = record.errorText;
  if (typeof response.fromServiceWorker === 'boolean') entry.response._fetchedViaServiceWorker = response.fromServiceWorker;
  if (response.serviceWorkerResponseSource) entry.response._serviceWorkerResponseSource = response.serviceWorkerResponseSource;
  if (response.cacheStorageCacheName) entry.response._responseCacheStorageCacheName = response.cacheStorageCacheName;
  for (const [source, target] of Object.entries({ ruleIdMatched: '_serviceWorkerRouterRuleIdMatched',
    matchedSourceType: '_serviceWorkerRouterMatchedSourceType', actualSourceType: '_serviceWorkerRouterActualSourceType' })) {
    if (response.serviceWorkerRouterInfo?.[source] !== undefined) entry.response[target] = response.serviceWorkerRouterInfo[source];
  }
  if (record.includeRequestBodies !== false && typeof record.requestPostData === 'string') {
    entry.request.postData = { mimeType: headerValue(requestHeaders, 'content-type'), text: record.requestPostData };
    if (entry.request.postData.mimeType.includes('application/x-www-form-urlencoded')) {
      entry.request.postData.params = Array.from(new URLSearchParams(record.requestPostData), ([name, value]) => ({ name, value }));
    }
  }
  return finiteMetadata(entry);
}

export function buildHarPage(page) {
  return {
    startedDateTime: dateString(page.wallTime, page.receivedAt), id: page.id, title: page.url || '',
    pageTimings: {
      onContentLoad: milliseconds(page.startTimestamp, page.domContentLoaded),
      onLoad: milliseconds(page.startTimestamp, page.load)
    }
  };
}

export function buildHar(records, pages, version) {
  const entries = records.map((record) => buildHarEntry(record)).filter(Boolean);
  const usedPages = new Set(entries.map((entry) => entry.pageref));
  return { log: { version: '1.2', creator: { name: 'myhar', version },
    pages: Array.from(pages).filter((page) => usedPages.has(page.id)).map(buildHarPage), entries } };
}

function objectToHarHeaders(headersObject) {
  return Object.entries(headersObject || {}).filter(([, value]) => value !== undefined).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : String(value).split('\n')).map((item) => ({ name, value: String(item) })));
}

function parseQueryString(url) {
  try {
    const parsedUrl = new URL(url);
    return Array.from(parsedUrl.searchParams.entries()).map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function parseRequestCookies(headersObject) {
  const cookieHeader = headerValue(headersObject, 'cookie');
  if (!cookieHeader) {
    return [];
  }

  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex === -1) {
        return { name: part, value: '' };
      }

      return {
        name: part.slice(0, separatorIndex).trim(),
        value: part.slice(separatorIndex + 1).trim()
      };
    });
}

function parseResponseCookies(headersObject) {
  const cookies = [];

  for (const [name, value] of Object.entries(headersObject || {})) {
    if (name.toLowerCase() !== 'set-cookie') {
      continue;
    }

    const values = Array.isArray(value) ? value : splitSetCookieHeader(String(value));
    for (const cookieValue of values) {
      const cookie = parseSetCookie(cookieValue);
      if (cookie) {
        cookies.push(cookie);
      }
    }
  }

  return cookies;
}

function splitSetCookieHeader(header) {
  // CDP joins duplicate headers with newlines. A comma in an Expires date is
  // not a separator; tolerate combined headers only before another name=value.
  return header.split(/\n|,(?=\s*[^;,=\s]+\s*=)/).map((value) => value.trim()).filter(Boolean);
}

function parseSetCookie(cookieString) {
  const parts = cookieString.split(';').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  const [nameValue, ...attributes] = parts;
  const separatorIndex = nameValue.indexOf('=');
  if (separatorIndex === -1) {
    return null;
  }

  const cookie = {
    name: nameValue.slice(0, separatorIndex),
    value: nameValue.slice(separatorIndex + 1)
  };

  for (const attribute of attributes) {
    const [rawName, ...rawValueParts] = attribute.split('=');
    const attributeName = rawName.toLowerCase();
    const attributeValue = rawValueParts.join('=');

    if (attributeName === 'path') {
      cookie.path = attributeValue;
    } else if (attributeName === 'domain') {
      cookie.domain = attributeValue;
    } else if (attributeName === 'expires') {
      const expiresDate = new Date(attributeValue);
      if (!Number.isNaN(expiresDate.getTime())) {
        cookie.expires = expiresDate.toISOString();
      }
    } else if (attributeName === 'httponly') {
      cookie.httpOnly = true;
    } else if (attributeName === 'secure') {
      cookie.secure = true;
    } else if (attributeName === 'samesite') {
      cookie.sameSite = attributeValue;
    }
  }

  return cookie;
}

export function headerValue(headersObject, headerName) {
  const target = headerName.toLowerCase();

  for (const [name, value] of Object.entries(headersObject || {})) {
    if (name.toLowerCase() === target) {
      return Array.isArray(value) ? value.join('\n') : String(value);
    }
  }

  return '';
}

function requestPostBodySize(record) {
  if (typeof record.requestPostData === 'string') {
    return textToBytes(record.requestPostData).length;
  }

  if (record.requestHasPostData) {
    return -1;
  }

  return 0;
}

function normalizeStatus(status) {
  const numericStatus = Number(status);
  if (Number.isFinite(numericStatus)) {
    return numericStatus;
  }
  return 0;
}

export function textToBytes(text) {
  return new TextEncoder().encode(text);
}

export function base64DecodedSize(value) {
  const normalized = String(value || '').replace(/\s+/g, '');
  if (!normalized) {
    return 0;
  }

  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

