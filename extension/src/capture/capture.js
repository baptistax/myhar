'use strict';

const DEVTOOLS_PROTOCOL_VERSION = '1.3';
const DEFAULT_CAPTURE_IDLE_MS = 5000;
const ROOT_PREFIX = 'myhar';
const MIN_CAPTURE_LIMIT_SECONDS = 5;
const DEBUG_LOG_ENABLED = new URLSearchParams(window.location.search).get('debug') === '1';


const elements = {
  refreshTabs: document.getElementById('refreshTabs'),
  clearSelection: document.getElementById('clearSelection'),
  captureRefresh: document.getElementById('captureRefresh'),
  startLive: document.getElementById('startLive'),
  stopExport: document.getElementById('stopExport'),
  stopDiscard: document.getElementById('stopDiscard'),
  captureUrls: document.getElementById('captureUrls'),
  clearUrls: document.getElementById('clearUrls'),
  urlInput: document.getElementById('urlInput'),
  includeRequestBodies: document.getElementById('includeRequestBodies'),
  includeResponseBodies: document.getElementById('includeResponseBodies'),
  maxResponseBodyBytes: document.getElementById('maxResponseBodyBytes'),
  captureLimitSeconds: document.getElementById('captureLimitSeconds'),
  statusText: document.getElementById('statusText'),
  tabCount: document.getElementById('tabCount'),
  tabsBody: document.getElementById('tabsBody'),
  logCard: document.getElementById('logCard'),
  clearLog: document.getElementById('clearLog'),
  logOutput: document.getElementById('logOutput'),
  exportCard: document.getElementById('exportCard'),
  downloadLink: document.getElementById('downloadLink'),
  exportDetails: document.getElementById('exportDetails')
};

let openTabs = [];
let activeCapture = null;
let selectedTabIds = new Set();
let initialTabIds = new Set();
let knownTabIds = new Set();
let newlyDetectedTabIds = new Set();
let myharCreatedTabIds = new Set();
let workspaceInitialized = false;
let eventListenerRegistered = false;
let activeExportObjectUrl = null;

class CaptureCoordinator {
  constructor(options) {
    this.mode = options.mode;
    this.includeRequestBodies = options.includeRequestBodies;
    this.includeResponseBodies = options.includeResponseBodies;
    this.maxResponseBodyBytes = options.maxResponseBodyBytes;
    this.captureLimitMs = options.captureLimitSeconds * 1000;
    this.navigationTargets = options.navigationTargets || new Map();
    this.sessions = new Map();
    this.startedAt = new Date();
    this.stopped = false;
    this.exported = false;
    this.quietTimer = null;
    this.limitTimer = null;
    this.skippedTabs = [];
  }

  async start(tabIds) {
    ensureDebuggerEventListener();
    setBusyState(true, this.mode);
    setStatus(`Starting ${this.mode} capture for ${tabIds.length} tab(s).`);

    for (const tabId of tabIds) {
      const tab = openTabs.find((candidate) => candidate.id === tabId);
      if (!tab) {
        continue;
      }

      const session = new TabCaptureSession(tab, this.includeRequestBodies, this.includeResponseBodies, this.maxResponseBodyBytes);
      try {
        await session.attach();
        this.sessions.set(tabId, session);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        session.status = attachmentFailureStatus(message);
        await session.detachSafely().catch(() => {});
        this.skippedTabs.push({
          tab,
          status: session.status,
          message
        });
        logLine(`Skipped tab ${tabId}: ${message}`);
      }
      renderTabs();
    }

    if (this.sessions.size === 0) {
      throw new Error('No selected tabs could be attached. Close DevTools or any other debugger attached to the selected tab, then try again.');
    }

    if (this.skippedTabs.length > 0) {
      logLine(`${this.skippedTabs.length} selected tab(s) were skipped because they could not be attached.`);
    }

    if (this.mode === 'refresh') {
      await this.reloadAttachedTabs();
      this.scheduleRefreshAutoStop();
    } else if (this.mode === 'url-list') {
      await this.navigateAttachedTabs();
      this.scheduleRefreshAutoStop();
    } else {
      setStatus('Live capture is running. Navigate selected tabs, then stop and export.');
    }
  }

  async navigateAttachedTabs() {
    setStatus(`Opening and capturing ${this.sessions.size} URL tab(s).`);

    for (const tabId of this.sessions.keys()) {
      const session = this.sessions.get(tabId);
      const targetUrl = this.navigationTargets.get(tabId);
      if (!targetUrl || !session) {
        continue;
      }

      session.tab.url = targetUrl;
      const openTab = openTabs.find((tab) => tab.id === tabId);
      if (openTab) {
        openTab.url = targetUrl;
        openTab.title = targetUrl;
      }

      try {
        await chromeCall(chrome.debugger.sendCommand, { tabId }, 'Page.navigate', { url: targetUrl });
        session.status = 'navigated';
      } catch (error) {
        const debuggerMessage = error instanceof Error ? error.message : String(error);
        try {
          await chromeCall(chrome.tabs.update, tabId, { url: targetUrl });
          session.status = 'navigated';
          logLine(`Debugger navigation failed for tab ${tabId}; chrome.tabs.update fallback was used: ${debuggerMessage}`);
        } catch (fallbackError) {
          const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          session.status = `navigation failed: ${message}`;
          logLine(`Navigation failed for tab ${tabId}: ${message}`);
        }
      }
    }

    renderTabs();
    setStatus('URL capture is running. Export starts automatically after network quiet or the duration limit.');
  }

  async reloadAttachedTabs() {
    setStatus(`Reloading ${this.sessions.size} attached tab(s).`);

    for (const tabId of this.sessions.keys()) {
      const session = this.sessions.get(tabId);
      try {
        await chromeCall(chrome.debugger.sendCommand, { tabId }, 'Page.reload', { ignoreCache: true });
        if (session) {
          session.status = 'reloaded';
        }
      } catch (error) {
        const debuggerMessage = error instanceof Error ? error.message : String(error);
        try {
          await chromeCall(chrome.tabs.reload, tabId, { bypassCache: true });
          if (session) {
            session.status = 'reloaded';
          }
          logLine(`Debugger reload failed for tab ${tabId}; chrome.tabs.reload fallback was used: ${debuggerMessage}`);
        } catch (fallbackError) {
          const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          if (session) {
            session.status = `reload failed: ${message}`;
          }
          logLine(`Reload failed for tab ${tabId}: ${message}`);
        }
      }
    }

    renderTabs();
    setStatus('Refresh capture is running. Wait for automatic export after network quiet or the duration limit; early manual export can be partial.');
  }

  scheduleRefreshAutoStop() {
    const checkQuiet = () => {
      if (this.stopped) {
        return;
      }

      const now = performance.now();
      const allQuiet = Array.from(this.sessions.values()).every((session) => session.isQuiet(now, DEFAULT_CAPTURE_IDLE_MS));
      const hasRequests = Array.from(this.sessions.values()).some((session) => session.completedEntries.length > 0 || session.records.size > 0);
      if (allQuiet && hasRequests) {
        this.stopAndExport('network quiet').catch((error) => showError(error));
        return;
      }

      this.quietTimer = setTimeout(checkQuiet, 1000);
    };

    this.quietTimer = setTimeout(checkQuiet, DEFAULT_CAPTURE_IDLE_MS);
    this.limitTimer = setTimeout(() => {
      if (!this.stopped) {
        this.stopAndExport('duration limit').catch((error) => showError(error));
      }
    }, this.captureLimitMs);
  }

  handleDebuggerEvent(tabId, method, params) {
    const session = this.sessions.get(tabId);
    if (!session || this.stopped) {
      return;
    }

    session.handleEvent(method, params);
    updateTabStatus(tabId, session.getUiStatus());
  }

  handleDebuggerDetach(tabId, reason) {
    const session = this.sessions.get(tabId);
    if (!session) {
      return;
    }

    session.status = `detached: ${reason || 'unknown'}`;
    session.detached = true;
    updateTabStatus(tabId, session.getUiStatus());
  }

  async stopAndExport(reason) {
    if (this.stopped) {
      return;
    }

    const hasEntries = Array.from(this.sessions.values()).some((session) => session.completedEntries.length > 0 || session.records.size > 0);
    if (this.mode === 'refresh' && reason === 'manual stop' && !hasEntries) {
      setStatus('Refresh capture has not seen network requests yet. Wait for automatic export, or use Stop without Export to cancel.');
      return;
    }

    this.stopped = true;
    this.clearTimers();
    if (!hasEntries) {
      logLine('No network requests were captured before export. The HAR files may be empty; try live capture, URL list capture, or reload/navigate the tab manually.');
    }
    setStatus(`Stopping capture (${reason || 'manual'}). Building HAR files.`);

    let zipFile;
    try {
      zipFile = await buildCaptureZip(this);
    } finally {
      for (const session of this.sessions.values()) {
        await session.detachSafely();
      }
    }

    const downloadResult = await downloadZip(zipFile);
    this.exported = true;
    setBusyState(false);
    if (downloadResult.automatic) {
      setStatus(`Export completed: ${zipFile.fileName}`);
    } else {
      setStatus(`ZIP built: ${zipFile.fileName}. Use the visible download link if the browser did not start the download automatically.`);
    }
    renderTabs();
  }

  async stopWithoutExport(reason) {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.clearTimers();
    setStatus(`Stopping capture without export (${reason || 'manual'}).`);

    for (const session of this.sessions.values()) {
      await session.detachSafely();
    }

    setBusyState(false);
    setStatus('Capture stopped. No files were exported.');
    renderTabs();
  }

  clearTimers() {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }

    if (this.limitTimer) {
      clearTimeout(this.limitTimer);
      this.limitTimer = null;
    }
  }
}

class TabCaptureSession {
  constructor(tab, includeRequestBodies, includeResponseBodies, maxResponseBodyBytes) {
    this.tab = tab;
    this.includeRequestBodies = includeRequestBodies;
    this.includeResponseBodies = includeResponseBodies;
    this.maxResponseBodyBytes = maxResponseBodyBytes;
    this.status = 'pending';
    this.detached = false;
    this.attached = false;
    this.records = new Map();
    this.pendingRequestExtraInfo = new Map();
    this.pendingResponseExtraInfo = new Map();
    this.completedEntries = [];
    this.pendingFinalizations = new Set();
    this.redirectCounters = new Map();
    this.startedAt = new Date();
    this.lastActivityAt = performance.now();
    this.pageRef = `page_${tab.id}`;
    this.pageStartedDateTime = new Date().toISOString();
  }

  async attach() {
    this.status = 'attaching';
    renderTabs();

    await chromeCall(chrome.debugger.attach, { tabId: this.tab.id }, DEVTOOLS_PROTOCOL_VERSION);
    this.attached = true;
    this.status = 'attached';

    await chromeCall(chrome.debugger.sendCommand, { tabId: this.tab.id }, 'Network.enable', {
      maxTotalBufferSize: 200000000,
      maxResourceBufferSize: 100000000,
      maxPostDataSize: 10485760
    });
    await chromeCall(chrome.debugger.sendCommand, { tabId: this.tab.id }, 'Page.enable', {});

    logLine(`Attached debugger to tab ${this.tab.id}: ${this.tab.title || this.tab.url}`);
  }

  handleEvent(method, params) {
    this.lastActivityAt = performance.now();

    switch (method) {
      case 'Network.requestWillBeSent':
        this.handleRequestWillBeSent(params);
        break;
      case 'Network.requestWillBeSentExtraInfo':
        this.handleRequestExtraInfo(params);
        break;
      case 'Network.responseReceived':
        this.handleResponseReceived(params);
        break;
      case 'Network.responseReceivedExtraInfo':
        this.handleResponseExtraInfo(params);
        break;
      case 'Network.loadingFinished':
        this.handleLoadingFinished(params);
        break;
      case 'Network.loadingFailed':
        this.handleLoadingFailed(params);
        break;
      default:
        break;
    }
  }

  handleRequestWillBeSent(params) {
    const existingRecord = this.records.get(params.requestId);
    if (existingRecord && params.redirectResponse) {
      existingRecord.response = params.redirectResponse;
      existingRecord.endTimestamp = params.timestamp;
      existingRecord.redirectedTo = params.request.url;
      existingRecord.finishedReason = 'redirect';
      this.finalizeRecord(params.requestId, existingRecord);
    }

    const recordKey = params.requestId;
    const record = {
      requestId: params.requestId,
      loaderId: params.loaderId || '',
      documentURL: params.documentURL || '',
      frameId: params.frameId || '',
      type: params.type || '',
      initiator: params.initiator || null,
      request: params.request || {},
      requestHeaders: clonePlainObject(params.request?.headers || {}),
      requestHasPostData: Boolean(params.request?.hasPostData),
      requestPostData: this.includeRequestBodies ? params.request?.postData || '' : '',
      requestPostDataError: '',
      response: null,
      responseHeaders: {},
      responseStatusCode: null,
      responseHeadersText: '',
      requestHeadersText: '',
      startTimestamp: params.timestamp,
      wallTime: params.wallTime || null,
      responseTimestamp: null,
      endTimestamp: null,
      encodedDataLength: 0,
      failed: false,
      errorText: '',
      canceled: false,
      finishedReason: '',
      redirectedTo: '',
      responseBodyText: undefined,
      responseBodyBase64Encoded: false,
      responseBodySize: null,
      responseBodyError: '',
      responseBodyOmittedReason: '',
      sequence: this.completedEntries.length + this.records.size + 1
    };

    const pendingRequestExtra = this.pendingRequestExtraInfo.get(params.requestId);
    if (pendingRequestExtra) {
      applyRequestExtraInfo(record, pendingRequestExtra);
      this.pendingRequestExtraInfo.delete(params.requestId);
    }

    const pendingResponseExtra = this.pendingResponseExtraInfo.get(params.requestId);
    if (pendingResponseExtra) {
      applyResponseExtraInfo(record, pendingResponseExtra);
      this.pendingResponseExtraInfo.delete(params.requestId);
    }

    this.records.set(recordKey, record);
    this.status = 'capturing';
  }

  handleRequestExtraInfo(params) {
    const record = this.records.get(params.requestId);
    if (!record) {
      this.pendingRequestExtraInfo.set(params.requestId, params);
      return;
    }

    applyRequestExtraInfo(record, params);
  }

  handleResponseReceived(params) {
    const record = this.records.get(params.requestId);
    if (!record) {
      return;
    }

    record.response = params.response || null;
    record.responseHeaders = clonePlainObject(params.response?.headers || {});
    record.responseTimestamp = params.timestamp;
    record.type = params.type || record.type;
  }

  handleResponseExtraInfo(params) {
    const record = this.records.get(params.requestId);
    if (!record) {
      this.pendingResponseExtraInfo.set(params.requestId, params);
      return;
    }

    applyResponseExtraInfo(record, params);
  }

  handleLoadingFinished(params) {
    const record = this.records.get(params.requestId);
    if (!record) {
      return;
    }

    record.endTimestamp = params.timestamp;
    record.encodedDataLength = params.encodedDataLength || 0;
    record.finishedReason = 'finished';
    this.finalizeRecord(params.requestId, record);
  }

  handleLoadingFailed(params) {
    const record = this.records.get(params.requestId);
    if (!record) {
      return;
    }

    record.endTimestamp = params.timestamp;
    record.failed = true;
    record.canceled = Boolean(params.canceled);
    record.errorText = params.errorText || '';
    record.finishedReason = 'failed';
    this.finalizeRecord(params.requestId, record);
  }

  finalizeRecord(requestId, record) {
    this.records.delete(requestId);

    const finalizePromise = this.enrichAndStoreRecord(record)
      .catch((error) => {
        record.responseBodyError = error instanceof Error ? error.message : String(error);
        this.completedEntries.push(buildHarEntry(record, this.pageRef));
      })
      .finally(() => {
        this.pendingFinalizations.delete(finalizePromise);
      });

    this.pendingFinalizations.add(finalizePromise);
  }

  async enrichAndStoreRecord(record) {
    await this.collectRequestPostData(record);
    await this.collectResponseBody(record);
    this.completedEntries.push(buildHarEntry(record, this.pageRef));
  }

  async collectRequestPostData(record) {
    if (!this.includeRequestBodies || !record.requestHasPostData || record.requestPostData) {
      return;
    }

    try {
      const result = await chromeCall(chrome.debugger.sendCommand, { tabId: this.tab.id }, 'Network.getRequestPostData', {
        requestId: record.requestId
      });
      if (result && typeof result.postData === 'string') {
        record.requestPostData = result.postData;
      }
    } catch (error) {
      record.requestPostDataError = error instanceof Error ? error.message : String(error);
    }
  }

  async collectResponseBody(record) {
    if (!this.includeResponseBodies || record.failed || record.finishedReason !== 'finished') {
      return;
    }

    try {
      const result = await chromeCall(chrome.debugger.sendCommand, { tabId: this.tab.id }, 'Network.getResponseBody', {
        requestId: record.requestId
      });

      if (!result || typeof result.body !== 'string') {
        return;
      }

      const bodySize = result.base64Encoded ? base64DecodedSize(result.body) : textToBytes(result.body).length;
      record.responseBodySize = bodySize;

      if (this.maxResponseBodyBytes > 0 && bodySize > this.maxResponseBodyBytes) {
        record.responseBodyOmittedReason = `response body exceeded ${this.maxResponseBodyBytes} byte limit`;
        return;
      }

      record.responseBodyText = result.body;
      record.responseBodyBase64Encoded = Boolean(result.base64Encoded);
    } catch (error) {
      record.responseBodyError = error instanceof Error ? error.message : String(error);
    }
  }

  async flushOpenRecords() {
    for (const [requestId, record] of Array.from(this.records.entries())) {
      record.endTimestamp = record.endTimestamp || record.responseTimestamp || record.startTimestamp;
      record.finishedReason = record.finishedReason || 'incomplete';
      this.finalizeRecord(requestId, record);
    }

    await this.waitForPendingFinalizations();
  }

  async waitForPendingFinalizations() {
    while (this.pendingFinalizations.size > 0) {
      await Promise.allSettled(Array.from(this.pendingFinalizations));
    }
  }

  async buildHar() {
    await this.flushOpenRecords();
    this.completedEntries.sort((first, second) => (first._sequence || 0) - (second._sequence || 0));
    for (const entry of this.completedEntries) {
      delete entry._sequence;
    }

    return {
      log: {
        version: '1.2',
        creator: {
          name: 'myhar',
          version: chrome.runtime.getManifest().version
        },
        pages: [
          {
            startedDateTime: this.pageStartedDateTime,
            id: this.pageRef,
            title: this.tab.title || this.tab.url || `Tab ${this.tab.id}`,
            pageTimings: {
              onContentLoad: -1,
              onLoad: -1
            },
            _tabId: this.tab.id,
            _url: this.tab.url || ''
          }
        ],
        entries: this.completedEntries
      }
    };
  }

  isQuiet(now, idleMs) {
    return this.records.size === 0 && this.pendingFinalizations.size === 0 && now - this.lastActivityAt >= idleMs;
  }

  getUiStatus() {
    const entryCount = this.completedEntries.length;
    const openCount = this.records.size;
    const suffix = `${entryCount} complete, ${openCount} active`;

    if (this.detached) {
      return `Detached (${suffix})`;
    }

    if (this.status === 'capturing' || this.status === 'reloaded' || this.status === 'navigated') {
      return `Capturing (${suffix})`;
    }

    if (this.status === 'attached') {
      return `Attached (${suffix})`;
    }

    return `${this.status} (${suffix})`;
  }

  async detachSafely() {
    if (!this.attached || this.detached) {
      return;
    }

    try {
      await chromeCall(chrome.debugger.sendCommand, { tabId: this.tab.id }, 'Network.disable', {});
    } catch (error) {
      logLine(`Network.disable failed for tab ${this.tab.id}: ${error.message}`);
    }

    try {
      await chromeCall(chrome.debugger.detach, { tabId: this.tab.id });
      this.detached = true;
      this.status = 'detached';
      logLine(`Detached debugger from tab ${this.tab.id}.`);
    } catch (error) {
      logLine(`Detach failed for tab ${this.tab.id}: ${error.message}`);
    }
  }
}

function applyRequestExtraInfo(record, params) {
  record.requestHeaders = {
    ...record.requestHeaders,
    ...clonePlainObject(params.headers || {})
  };
  record.requestHeadersText = params.headersText || record.requestHeadersText;
}

function applyResponseExtraInfo(record, params) {
  record.responseHeaders = {
    ...record.responseHeaders,
    ...clonePlainObject(params.headers || {})
  };
  record.responseStatusCode = params.statusCode || record.responseStatusCode;
  record.responseHeadersText = params.headersText || record.responseHeadersText;
}

function buildHarEntry(record, pageRef) {
  const request = record.request || {};
  const response = record.response || {};
  const requestUrl = request.url || '';
  const responseHeaders = record.responseHeaders || response.headers || {};
  const requestHeaders = record.requestHeaders || request.headers || {};
  const start = record.startTimestamp || 0;
  const responseStart = record.responseTimestamp || record.endTimestamp || start;
  const end = record.endTimestamp || responseStart;
  const totalTime = Math.max(0, Math.round((end - start) * 1000));
  const waitTime = Math.max(0, Math.round((responseStart - start) * 1000));
  const receiveTime = Math.max(0, Math.round((end - responseStart) * 1000));
  const status = normalizeStatus(record.responseStatusCode || response.status || (record.failed ? 0 : 0));
  const mimeType = response.mimeType || headerValue(responseHeaders, 'content-type') || '';

  const content = {
    size: Number.isFinite(record.responseBodySize) && record.responseBodySize !== null
      ? record.responseBodySize
      : record.encodedDataLength || Number(response.encodedDataLength) || -1,
    mimeType
  };

  if (typeof record.responseBodyText === 'string') {
    content.text = record.responseBodyText;
    if (record.responseBodyBase64Encoded) {
      content.encoding = 'base64';
    }
  }

  if (record.responseBodyError) {
    content._harzipBodyError = record.responseBodyError;
  }

  if (record.responseBodyOmittedReason) {
    content._harzipBodyOmittedReason = record.responseBodyOmittedReason;
  }

  const entry = {
    pageref: pageRef,
    startedDateTime: record.wallTime ? new Date(record.wallTime * 1000).toISOString() : new Date().toISOString(),
    time: totalTime,
    request: {
      method: request.method || 'GET',
      url: requestUrl,
      httpVersion: 'HTTP/1.1',
      cookies: parseRequestCookies(requestHeaders),
      headers: objectToHarHeaders(requestHeaders),
      queryString: parseQueryString(requestUrl),
      headersSize: -1,
      bodySize: requestPostBodySize(record)
    },
    response: {
      status,
      statusText: response.statusText || record.errorText || '',
      httpVersion: response.protocol || 'HTTP/1.1',
      cookies: parseResponseCookies(responseHeaders),
      headers: objectToHarHeaders(responseHeaders),
      content,
      redirectURL: record.redirectedTo || headerValue(responseHeaders, 'location') || '',
      headersSize: -1,
      bodySize: record.encodedDataLength || -1,
      _fromDiskCache: Boolean(response.fromDiskCache),
      _fromServiceWorker: Boolean(response.fromServiceWorker),
      _remoteIPAddress: response.remoteIPAddress || '',
      _remotePort: response.remotePort || ''
    },
    cache: {},
    timings: {
      blocked: -1,
      dns: -1,
      connect: -1,
      send: 0,
      wait: waitTime,
      receive: receiveTime,
      ssl: -1
    },
    _resourceType: record.type || '',
    _requestId: record.requestId || '',
    _loaderId: record.loaderId || '',
    _documentURL: record.documentURL || '',
    _frameId: record.frameId || '',
    _finishedReason: record.finishedReason || '',
    _failed: Boolean(record.failed),
    _canceled: Boolean(record.canceled),
    _errorText: record.errorText || ''
  };

  if (record.includeRequestBodies !== false && record.requestPostData) {
    entry.request.postData = {
      mimeType: headerValue(requestHeaders, 'content-type') || '',
      text: record.requestPostData
    };
  }

  if (record.requestPostDataError) {
    entry.request._harzipPostDataError = record.requestPostDataError;
  }

  entry._sequence = record.sequence || 0;

  if (record.initiator) {
    entry._initiator = record.initiator;
  }

  return entry;
}

async function buildCaptureZip(coordinator) {
  const rootName = `${ROOT_PREFIX}_${formatTimestampForFileName(coordinator.startedAt)}`;
  const files = [];
  const completedAt = new Date();
  const captureManifest = {
    generated_at: completedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: Math.max(0, completedAt.getTime() - coordinator.startedAt.getTime()),
    tool: 'myhar',
    version: chrome.runtime.getManifest().version,
    mode: coordinator.mode,
    status: 'completed',
    local_only: true,
    response_bodies_collected: coordinator.includeResponseBodies,
    max_response_body_bytes: coordinator.maxResponseBodyBytes,
    request_bodies_included: coordinator.includeRequestBodies,
    entries_total: 0,
    captures: [],
    skipped_tabs: coordinator.skippedTabs.map((skipped) => ({
      tab_id: skipped.tab.id,
      tab_title: skipped.tab.title || '',
      url: skipped.tab.url || '',
      status: skipped.status,
      message: skipped.message
    }))
  };

  let index = 1;
  for (const session of coordinator.sessions.values()) {
    const lastRuntimeStatus = session.status || '';
    const wasDetachedBeforeExport = Boolean(session.detached);
    const har = await session.buildHar();
    const tab = session.tab;
    const entryCount = har.log.entries.length;
    const fileName = `${String(index).padStart(3, '0')}_${safeHostFromUrl(tab.url)}_${tab.id}.har`;
    const path = `${rootName}/tabs/${fileName}`;
    const harText = `${JSON.stringify(har, null, 2)}\n`;

    files.push({ path, data: textToBytes(harText) });
    captureManifest.entries_total += entryCount;
    captureManifest.captures.push({
      file: `tabs/${fileName}`,
      tab_id: tab.id,
      tab_title: tab.title || '',
      url: tab.url || '',
      mode: coordinator.mode,
      status: 'completed',
      last_runtime_status: lastRuntimeStatus,
      detached_before_export: wasDetachedBeforeExport,
      entries: entryCount,
      started_at: session.startedAt.toISOString(),
      completed_at: completedAt.toISOString()
    });
    session.status = 'completed';
    index += 1;
  }

  files.unshift({
    path: `${rootName}/manifest.json`,
    data: textToBytes(`${JSON.stringify(captureManifest, null, 2)}\n`)
  });

  const zipBytes = await createZip(files);
  return {
    fileName: `${rootName}.zip`,
    bytes: zipBytes,
    manifest: captureManifest
  };
}

async function downloadZip(zipFile) {
  const blob = new Blob([zipFile.bytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  showExportLink(zipFile, url);

  try {
    await chromeCall(chrome.downloads.download, {
      url,
      filename: zipFile.fileName,
      saveAs: false,
      conflictAction: 'uniquify'
    });
    logLine(`ZIP download requested: ${zipFile.fileName}`);
    return { automatic: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLine(`Automatic ZIP download failed: ${message}`);
    return { automatic: false, error: message };
  }
}

function showExportLink(zipFile, url) {
  if (activeExportObjectUrl) {
    URL.revokeObjectURL(activeExportObjectUrl);
  }

  activeExportObjectUrl = url;
  elements.downloadLink.href = url;
  elements.downloadLink.download = zipFile.fileName;
  elements.downloadLink.textContent = zipFile.fileName;
  elements.exportDetails.textContent = `${zipFile.manifest.captures.length} HAR file(s), ${formatBytes(zipFile.bytes.length)}.`;
  elements.exportCard.hidden = false;
}

async function createZip(files) {
  const fileRecords = [];
  const chunks = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = textToBytes(file.path);
    const data = file.data;
    const compressed = await maybeDeflateRaw(data);
    const dataToWrite = compressed.data;
    const compressionMethod = compressed.method;
    const crc = crc32(data);
    const dosDateTime = getDosDateTime(new Date());
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(localHeader.buffer);

    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, compressionMethod, true);
    view.setUint16(10, dosDateTime.time, true);
    view.setUint16(12, dosDateTime.date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, dataToWrite.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    chunks.push(localHeader, dataToWrite);
    fileRecords.push({
      path: file.path,
      nameBytes,
      crc,
      size: data.length,
      compressedSize: dataToWrite.length,
      compressionMethod,
      localHeaderOffset: offset,
      dosDateTime
    });
    offset += localHeader.length + dataToWrite.length;
  }

  const centralDirectoryOffset = offset;

  for (const record of fileRecords) {
    const centralHeader = new Uint8Array(46 + record.nameBytes.length);
    const view = new DataView(centralHeader.buffer);

    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, record.compressionMethod, true);
    view.setUint16(12, record.dosDateTime.time, true);
    view.setUint16(14, record.dosDateTime.date, true);
    view.setUint32(16, record.crc, true);
    view.setUint32(20, record.compressedSize, true);
    view.setUint32(24, record.size, true);
    view.setUint16(28, record.nameBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, record.localHeaderOffset, true);
    centralHeader.set(record.nameBytes, 46);

    chunks.push(centralHeader);
    offset += centralHeader.length;
  }

  const centralDirectorySize = offset - centralDirectoryOffset;
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);

  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, fileRecords.length, true);
  endView.setUint16(10, fileRecords.length, true);
  endView.setUint32(12, centralDirectorySize, true);
  endView.setUint32(16, centralDirectoryOffset, true);
  endView.setUint16(20, 0, true);

  chunks.push(endRecord);
  return concatenateUint8Arrays(chunks);
}

function ensureDebuggerEventListener() {
  if (eventListenerRegistered) {
    return;
  }

  chrome.debugger.onEvent.addListener((debuggee, method, params) => {
    if (!debuggee || typeof debuggee.tabId !== 'number' || !activeCapture) {
      return;
    }

    activeCapture.handleDebuggerEvent(debuggee.tabId, method, params || {});
  });

  chrome.debugger.onDetach.addListener((debuggee, reason) => {
    if (!debuggee || typeof debuggee.tabId !== 'number' || !activeCapture) {
      return;
    }

    activeCapture.handleDebuggerDetach(debuggee.tabId, reason);
  });

  eventListenerRegistered = true;
}

async function loadTabs(options = {}) {
  const tabs = await chromeCall(chrome.tabs.query, {});
  const sortedTabs = tabs
    .filter((tab) => typeof tab.id === 'number')
    .sort((first, second) => {
      const firstWindow = first.windowId || 0;
      const secondWindow = second.windowId || 0;
      if (firstWindow !== secondWindow) {
        return firstWindow - secondWindow;
      }
      return (first.index || 0) - (second.index || 0);
    });

  const currentIds = new Set(sortedTabs.map((tab) => tab.id));

  if (!workspaceInitialized) {
    initialTabIds = new Set(currentIds);
    knownTabIds = new Set(currentIds);
    workspaceInitialized = true;
  } else {
    for (const tab of sortedTabs) {
      if (!knownTabIds.has(tab.id)) {
        newlyDetectedTabIds.add(tab.id);
        knownTabIds.add(tab.id);
      }
    }
  }

  openTabs = sortedTabs;
  selectedTabIds = new Set(Array.from(selectedTabIds).filter((tabId) => currentIds.has(tabId)));
  newlyDetectedTabIds = new Set(Array.from(newlyDetectedTabIds).filter((tabId) => currentIds.has(tabId)));
  myharCreatedTabIds = new Set(Array.from(myharCreatedTabIds).filter((tabId) => currentIds.has(tabId)));

  renderTabs();
  if (!options.silent) {
    setStatus('Ready. No tab is selected automatically. Select one or more capturable tabs, or paste URLs.');
  }
}

function renderTabs() {
  elements.tabsBody.textContent = '';
  elements.tabCount.textContent = `${openTabs.length} tab${openTabs.length === 1 ? '' : 's'}`;

  const sections = buildTabSections();
  for (const section of sections) {
    if (section.tabs.length === 0) {
      continue;
    }
    appendGroupRow(section.label, section.tabs.length);
    for (const tab of section.tabs) {
      appendTabRow(tab);
    }
  }
}

function buildTabSections() {
  const selected = [];
  const myharCreated = [];
  const newTabs = [];
  const capturable = [];
  const notCapturable = [];

  for (const tab of openTabs) {
    if (selectedTabIds.has(tab.id)) {
      selected.push(tab);
    } else if (myharCreatedTabIds.has(tab.id)) {
      myharCreated.push(tab);
    } else if (newlyDetectedTabIds.has(tab.id) && isCapturableUrl(tab.url)) {
      newTabs.push(tab);
    } else if (isCapturableUrl(tab.url)) {
      capturable.push(tab);
    } else {
      notCapturable.push(tab);
    }
  }

  return [
    { label: 'Selected tabs', tabs: selected },
    { label: 'Tabs opened by myhar', tabs: myharCreated },
    { label: 'New browser tabs', tabs: newTabs },
    { label: 'Other capturable tabs', tabs: capturable },
    { label: 'Not capturable', tabs: notCapturable }
  ];
}

function appendGroupRow(label, count) {
  const row = document.createElement('tr');
  row.className = 'group-row';
  const cell = document.createElement('td');
  cell.colSpan = 4;
  cell.textContent = `${label} · ${count}`;
  row.appendChild(cell);
  elements.tabsBody.appendChild(row);
}

function appendTabRow(tab) {
  const row = document.createElement('tr');
  const isCapturable = isCapturableUrl(tab.url);
  const session = activeCapture?.sessions.get(tab.id);

  if (selectedTabIds.has(tab.id)) {
    row.classList.add('selected-row');
  } else if (newlyDetectedTabIds.has(tab.id) || myharCreatedTabIds.has(tab.id)) {
    row.classList.add('new-row');
  }

  const selectCell = document.createElement('td');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = selectedTabIds.has(tab.id);
  checkbox.disabled = !isCapturable || Boolean(activeCapture && !activeCapture.stopped);
  checkbox.setAttribute('aria-label', `Select tab ${tab.title || tab.url || tab.id}`);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) {
      selectedTabIds.add(tab.id);
    } else {
      selectedTabIds.delete(tab.id);
    }
    renderTabs();
  });
  selectCell.appendChild(checkbox);

  const titleCell = document.createElement('td');
  const title = document.createElement('span');
  title.className = 'tab-title';
  title.title = tab.title || '';
  title.textContent = tab.title || '(untitled tab)';
  titleCell.appendChild(title);

  const urlCell = document.createElement('td');
  urlCell.className = 'url-cell';
  urlCell.textContent = tab.url || '';
  urlCell.title = tab.url || '';

  const statusCell = document.createElement('td');
  statusCell.id = `tab-status-${tab.id}`;
  statusCell.appendChild(createStatusBadge(statusTextForTab(tab, session), isCapturable, session));

  row.append(selectCell, titleCell, urlCell, statusCell);
  elements.tabsBody.appendChild(row);
}

function updateTabStatus(tabId, statusText) {
  const statusCell = document.getElementById(`tab-status-${tabId}`);
  if (!statusCell) {
    return;
  }

  statusCell.textContent = '';
  const session = activeCapture?.sessions.get(tabId);
  const tab = openTabs.find((candidate) => candidate.id === tabId);
  statusCell.appendChild(createStatusBadge(statusText || statusTextForTab(tab, session), Boolean(tab && isCapturableUrl(tab.url)), session));
}

function createStatusBadge(text, isCapturable, session) {
  const badge = document.createElement('span');
  badge.className = 'badge';
  if (session) {
    badge.classList.add('ok');
  } else if (!isCapturable) {
    badge.classList.add('error');
  }
  badge.textContent = text;
  return badge;
}

function statusTextForTab(tab, session) {
  if (session) {
    return session.getUiStatus();
  }

  if (!tab || !isCapturableUrl(tab.url)) {
    return 'Not capturable';
  }

  if (tab.discarded) {
    return 'Ready · sleeping tab';
  }

  return 'Ready';
}

async function startRefreshCapture() {
  const selected = getSelectedCapturableTabs();
  if (selected.length === 0) {
    setStatus('Select at least one HTTP or HTTPS tab before capturing.');
    return;
  }

  if (activeCapture && !activeCapture.stopped) {
    setStatus('A capture is already running. Stop it before starting another one.');
    return;
  }

  activeCapture = new CaptureCoordinator({
    mode: 'refresh',
    includeRequestBodies: elements.includeRequestBodies.checked,
    includeResponseBodies: elements.includeResponseBodies.checked,
    maxResponseBodyBytes: getMaxResponseBodyBytes(),
    captureLimitSeconds: getCaptureLimitSeconds()
  });

  try {
    await activeCapture.start(selected.map((tab) => tab.id));
  } catch (error) {
    const capture = activeCapture;
    if (capture) {
      await capture.stopWithoutExport('startup failed').catch(() => {});
    }
    activeCapture = null;
    setBusyState(false);
    showError(error);
  }
}

async function startLiveCapture() {
  const selected = getSelectedCapturableTabs();
  if (selected.length === 0) {
    setStatus('Select at least one HTTP or HTTPS tab before starting live capture.');
    return;
  }

  if (activeCapture && !activeCapture.stopped) {
    setStatus('A capture is already running. Stop it before starting another one.');
    return;
  }

  activeCapture = new CaptureCoordinator({
    mode: 'live',
    includeRequestBodies: elements.includeRequestBodies.checked,
    includeResponseBodies: elements.includeResponseBodies.checked,
    maxResponseBodyBytes: getMaxResponseBodyBytes(),
    captureLimitSeconds: getCaptureLimitSeconds()
  });

  try {
    await activeCapture.start(selected.map((tab) => tab.id));
  } catch (error) {
    const capture = activeCapture;
    if (capture) {
      await capture.stopWithoutExport('startup failed').catch(() => {});
    }
    activeCapture = null;
    setBusyState(false);
    showError(error);
  }
}

async function startUrlListCapture() {
  const parsed = parseUrlInput(elements.urlInput.value);
  if (parsed.urls.length === 0) {
    setStatus('Paste at least one HTTP or HTTPS URL before starting URL list capture.');
    return;
  }

  if (parsed.invalidLines.length > 0) {
    setStatus(`Ignored ${parsed.invalidLines.length} invalid line(s). Capturing ${parsed.urls.length} valid URL(s).`);
  }

  if (activeCapture && !activeCapture.stopped) {
    setStatus('A capture is already running. Stop it before starting another one.');
    return;
  }

  const createdTabs = [];
  const navigationTargets = new Map();

  try {
    for (const url of parsed.urls) {
      const tab = await chromeCall(chrome.tabs.create, { url: 'about:blank', active: false });
      if (!tab || typeof tab.id !== 'number') {
        continue;
      }
      createdTabs.push(tab);
      myharCreatedTabIds.add(tab.id);
      selectedTabIds.add(tab.id);
      navigationTargets.set(tab.id, url);
    }

    await loadTabs({ silent: true });

    if (createdTabs.length === 0) {
      throw new Error('No capture tabs could be opened.');
    }

    activeCapture = new CaptureCoordinator({
      mode: 'url-list',
      includeRequestBodies: elements.includeRequestBodies.checked,
      includeResponseBodies: elements.includeResponseBodies.checked,
      maxResponseBodyBytes: getMaxResponseBodyBytes(),
      captureLimitSeconds: getCaptureLimitSeconds(),
      navigationTargets
    });

    await activeCapture.start(createdTabs.map((tab) => tab.id));
  } catch (error) {
    const capture = activeCapture;
    if (capture) {
      await capture.stopWithoutExport('startup failed').catch(() => {});
    }
    activeCapture = null;
    setBusyState(false);
    showError(error);
  }
}

function parseUrlInput(value) {
  const urls = [];
  const seen = new Set();
  const invalidLines = [];
  const lines = String(value || '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const normalized = normalizeInputUrl(line);
    if (!normalized) {
      invalidLines.push(line);
      continue;
    }

    if (!seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
    }
  }

  return { urls, invalidLines };
}

function normalizeInputUrl(value) {
  let candidate = value.trim();
  if (!candidate) {
    return '';
  }

  if (candidate.startsWith('//')) {
    candidate = `https:${candidate}`;
  } else if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  try {
    const parsedUrl = new URL(candidate);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return '';
    }
    return parsedUrl.href;
  } catch {
    return '';
  }
}

function getMaxResponseBodyBytes() {
  const selectedValue = Number(elements.maxResponseBodyBytes.value);
  if (Number.isFinite(selectedValue) && selectedValue >= 0) {
    return selectedValue;
  }

  return 26214400;
}

function getCaptureLimitSeconds() {
  const selectedValue = Number(elements.captureLimitSeconds.value);
  if (Number.isFinite(selectedValue) && selectedValue >= MIN_CAPTURE_LIMIT_SECONDS) {
    return selectedValue;
  }

  return 30;
}

function attachmentFailureStatus(message) {
  const normalizedMessage = String(message || '').toLowerCase();
  if (normalizedMessage.includes('another debugger')) {
    return 'skipped: debugger already attached';
  }

  return 'skipped: attach failed';
}

function getSelectedCapturableTabs() {
  return openTabs.filter((tab) => selectedTabIds.has(tab.id) && isCapturableUrl(tab.url));
}

function setBusyState(isBusy, mode = '') {
  elements.refreshTabs.disabled = isBusy;
  elements.clearSelection.disabled = isBusy;
  elements.captureRefresh.disabled = isBusy;
  elements.startLive.disabled = isBusy;
  elements.captureUrls.disabled = isBusy;
  elements.clearUrls.disabled = isBusy;
  elements.urlInput.disabled = isBusy;
  elements.includeRequestBodies.disabled = isBusy;
  elements.includeResponseBodies.disabled = isBusy;
  elements.maxResponseBodyBytes.disabled = isBusy;
  elements.captureLimitSeconds.disabled = isBusy;
  elements.stopExport.disabled = !isBusy;
  elements.stopDiscard.disabled = !isBusy;

  if (!isBusy) {
    activeCapture = null;
  }

  renderTabs();

  if (isBusy && mode) {
    logLine(`Started ${mode} capture.`);
  }
}

function setStatus(message) {
  elements.statusText.textContent = message;
  logLine(message);
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(`Error: ${message}`);
  if (DEBUG_LOG_ENABLED) {
    console.error(error);
  }
}

function logLine(message) {
  if (!DEBUG_LOG_ENABLED) {
    return;
  }

  const timestamp = new Date().toLocaleTimeString();
  elements.logOutput.textContent += `[${timestamp}] ${message}\n`;
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function isCapturableUrl(url) {
  if (!url) {
    return false;
  }

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch {
    return false;
  }
}

function objectToHarHeaders(headersObject) {
  return Object.entries(headersObject || {}).map(([name, value]) => ({
    name,
    value: String(value)
  }));
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
  const result = [];
  let current = '';
  let inExpires = false;

  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    const lookback = header.slice(Math.max(0, index - 8), index + 1).toLowerCase();

    if (lookback.endsWith('expires=')) {
      inExpires = true;
    }

    if (inExpires && char === ';') {
      inExpires = false;
    }

    if (char === ',' && !inExpires) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
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

function headerValue(headersObject, headerName) {
  const target = headerName.toLowerCase();

  for (const [name, value] of Object.entries(headersObject || {})) {
    if (name.toLowerCase() === target) {
      return Array.isArray(value) ? value.join('\n') : String(value);
    }
  }

  return '';
}

function requestPostBodySize(record) {
  if (record.requestPostData) {
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

function safeHostFromUrl(url) {
  try {
    const parsedUrl = new URL(url || '');
    return sanitizeFileName(parsedUrl.hostname || 'tab');
  } catch {
    return 'tab';
  }
}

function sanitizeFileName(value) {
  return String(value || 'file')
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'file';
}

function formatTimestampForFileName(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + '_' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('-');
}

function clonePlainObject(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function textToBytes(text) {
  return new TextEncoder().encode(text);
}

async function maybeDeflateRaw(data) {
  if (typeof CompressionStream !== 'function') {
    return { data, method: 0 };
  }

  try {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const compressedBuffer = await new Response(stream).arrayBuffer();
    const compressedData = new Uint8Array(compressedBuffer);
    if (compressedData.length > 0 && compressedData.length < data.length) {
      return { data: compressedData, method: 8 };
    }
  } catch (error) {
    logLine(`ZIP compression unavailable, storing files without compression: ${error.message}`);
  }

  return { data, method: 0 };
}

function concatenateUint8Arrays(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

function base64DecodedSize(value) {
  const normalized = String(value || '').replace(/\s+/g, '');
  if (!normalized) {
    return 0;
  }

  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function formatBytes(byteLength) {
  if (byteLength < 1024) {
    return `${byteLength} B`;
  }

  const kib = byteLength / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }

  return `${(kib / 1024).toFixed(1)} MiB`;
}

function getDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: dosTime, date: dosDate };
}

function crc32(data) {
  let crc = 0xffffffff;

  for (let index = 0; index < data.length; index += 1) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[index]) & 0xff];
  }

  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  return table;
})();

function chromeCall(apiFunction, ...args) {
  return new Promise((resolve, reject) => {
    try {
      apiFunction(...args, (result) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

elements.refreshTabs.addEventListener('click', () => {
  loadTabs().catch((error) => showError(error));
});

elements.clearSelection.addEventListener('click', () => {
  selectedTabIds.clear();
  renderTabs();
});

elements.captureUrls.addEventListener('click', () => {
  startUrlListCapture().catch((error) => showError(error));
});

elements.clearUrls.addEventListener('click', () => {
  elements.urlInput.value = '';
});

elements.captureRefresh.addEventListener('click', () => {
  startRefreshCapture().catch((error) => showError(error));
});

elements.startLive.addEventListener('click', () => {
  startLiveCapture().catch((error) => showError(error));
});

elements.stopExport.addEventListener('click', () => {
  if (activeCapture) {
    activeCapture.stopAndExport('manual stop').catch((error) => showError(error));
  }
});

elements.stopDiscard.addEventListener('click', () => {
  if (activeCapture) {
    activeCapture.stopWithoutExport('manual stop').catch((error) => showError(error));
  }
});

elements.clearLog.addEventListener('click', () => {
  elements.logOutput.textContent = '';
});

if (DEBUG_LOG_ENABLED) {
  elements.logCard.hidden = false;
}

window.addEventListener('beforeunload', () => {
  if (activeCapture && !activeCapture.stopped) {
    activeCapture.stopWithoutExport('workspace closed').catch(() => {});
  }

  if (activeExportObjectUrl) {
    URL.revokeObjectURL(activeExportObjectUrl);
    activeExportObjectUrl = null;
  }
});

loadTabs().catch((error) => showError(error));
