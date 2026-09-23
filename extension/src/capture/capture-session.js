import { base64DecodedSize, buildHar, isHttpUrl, schemeOf, textToBytes } from './har-builder.js';

export const MAX_CAPTURE_RECORDS = 10000;
export const MAX_RETAINED_BODY_BYTES = 256 * 1024 * 1024;
const MAX_BODY_COMMANDS = 4;
const NETWORK_ACTIVITY_EVENTS = new Set([
  'Network.requestWillBeSent', 'Network.responseReceived', 'Network.dataReceived',
  'Network.loadingFinished', 'Network.loadingFailed', 'Network.requestServedFromCache'
]);

// Shared by all tabs. UTF-16 length is a conservative retained-string estimate,
// including the encoded representation of base64, rather than wire byte counts.
export class CaptureBudget {
  constructor(onLimit, limits = {}) {
    this.maxRecords = limits.maxRecords ?? MAX_CAPTURE_RECORDS;
    this.maxBodyBytes = limits.maxBodyBytes ?? MAX_RETAINED_BODY_BYTES;
    this.onLimit = onLimit;
    this.recordCount = 0;
    this.retainedBodyBytes = 0;
    this.limitReached = false;
    this.bodyCommands = 0;
    this.bodyQueue = [];
  }

  reachLimit() {
    if (this.limitReached) return;
    this.limitReached = true;
    queueMicrotask(() => this.onLimit());
  }

  reserveRecord() {
    if (this.limitReached || this.recordCount >= this.maxRecords) {
      this.reachLimit();
      return false;
    }
    this.recordCount += 1;
    if (this.recordCount === this.maxRecords) this.reachLimit();
    return true;
  }

  retainBody(value) {
    const bytes = value.length * 2;
    if (this.limitReached || bytes > this.maxBodyBytes - this.retainedBodyBytes) {
      this.reachLimit();
      return false;
    }
    this.retainedBodyBytes += bytes;
    if (this.retainedBodyBytes === this.maxBodyBytes) this.reachLimit();
    return true;
  }

  runBodyCommand(task) {
    return new Promise((resolve, reject) => {
      this.bodyQueue.push({ task, resolve, reject });
      this.drainBodyQueue();
    });
  }

  drainBodyQueue() {
    while (this.bodyCommands < MAX_BODY_COMMANDS && this.bodyQueue.length) {
      const { task, resolve, reject } = this.bodyQueue.shift();
      this.bodyCommands += 1;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        this.bodyCommands -= 1;
        this.drainBodyQueue();
      });
    }
  }
}

export class TabCaptureSession {
  constructor(tab, includeRequestBodies, includeResponseBodies, maxResponseBodyBytes, options = {}) {
    this.tab = { ...tab };
    this.includeRequestBodies = includeRequestBodies;
    this.includeResponseBodies = includeResponseBodies;
    this.maxResponseBodyBytes = maxResponseBodyBytes;
    this.budget = options.budget || new CaptureBudget(() => {});
    this.log = options.log || (() => {});
    this.command = options.command || ((method, params = {}) =>
      chromeCall(chrome.debugger.sendCommand, { tabId: this.tab.id }, method, params));
    this.status = 'pending';
    this.attached = false;
    this.detached = false;
    this.terminal = false;
    this.expectedDetach = false;
    this.detachReason = null;
    this.records = new Map(); // Active hop, keyed by the real CDP ID.
    this.chains = new Map(); // Ordered hops plus independent ExtraInfo FIFOs.
    this.allRecords = []; // Kept mutable until export so late ExtraInfo is retained.
    this.completedCount = 0;
    this.pendingFinalizations = new Set();
    this.startedAt = new Date();
    this.lastNetworkActivityAt = performance.now();
    this.pages = new Map();
    this.framePages = new Map();
    this.mainFrameId = null;
    this.excludedEntries = {};
    this.diagnostics = [];
    this.extraInfoPending = 0;
  }

  async attach() {
    this.status = 'attaching';
    await chromeCall(chrome.debugger.attach, { tabId: this.tab.id }, '1.3');
    this.attached = true;
    if (this.terminal) { await this.detachSafely(); return; }
    this.status = 'attached';
    await this.command('Network.enable', {
      maxTotalBufferSize: 200000000, maxResourceBufferSize: 100000000,
      maxPostDataSize: this.includeRequestBodies ? 10485760 : 0
    });
    await this.command('Page.enable');
    try {
      const tree = await this.command('Page.getFrameTree');
      this.mainFrameId = tree.frameTree?.frame.id || null;
      this.rememberFrame(tree.frameTree);
      await this.command('Page.setLifecycleEventsEnabled', { enabled: true });
    } catch (error) {
      this.diagnostics.push({ phase: 'page_lifecycle', error: error.message });
    }
    this.log(`Attached debugger to tab ${this.tab.id}: ${this.tab.title || this.tab.url}`);
  }

  rememberFrame(tree) {
    if (!tree?.frame) return;
    const parentPage = this.framePages.get(tree.frame.parentId);
    if (parentPage) this.framePages.set(tree.frame.id, parentPage);
    for (const child of tree.childFrames || []) this.rememberFrame(child);
  }

  async navigate(url) {
    try { await this.command('Page.navigate', { url }); }
    catch (error) {
      if (this.terminal) return;
      await chromeCall(chrome.tabs.update, this.tab.id, { url });
      this.log(`Debugger navigation failed for tab ${this.tab.id}; tabs.update fallback used: ${error.message}`);
    }
    if (!this.terminal) this.status = 'navigated';
  }

  async reload() {
    try { await this.command('Page.reload', { ignoreCache: true }); }
    catch (error) {
      if (this.terminal) return;
      await chromeCall(chrome.tabs.reload, this.tab.id, { bypassCache: true });
      this.log(`Debugger reload failed for tab ${this.tab.id}; tabs.reload fallback used: ${error.message}`);
    }
    if (!this.terminal) this.status = 'reloaded';
  }

  chainFor(requestId) {
    if (!this.chains.has(requestId)) {
      if (this.chains.size >= this.budget.maxRecords) { this.budget.reachLimit(); return null; }
      this.chains.set(requestId, { hops: [], requestExtra: [], responseExtra: [] });
    }
    return this.chains.get(requestId);
  }

  handleEvent(method, params) {
    if (this.terminal) return;
    // Count captured HTTP(S) lifecycle/transfer activity before completion removes
    // the active record. Page events, priority changes and late ExtraInfo are metadata.
    if (NETWORK_ACTIVITY_EVENTS.has(method) && (this.records.get(params.requestId)?.included
      || isHttpUrl(params.request?.url) || isHttpUrl(params.response?.url))) {
      this.lastNetworkActivityAt = performance.now();
    }
    switch (method) {
      case 'Network.requestWillBeSent': this.handleRequestWillBeSent(params); break;
      case 'Network.requestWillBeSentExtraInfo': this.queueExtraInfo(params, 'request'); break;
      case 'Network.responseReceivedExtraInfo': this.queueExtraInfo(params, 'response'); break;
      case 'Network.responseReceived': this.handleResponseReceived(params); break;
      case 'Network.requestServedFromCache': {
        const record = this.records.get(params.requestId);
        if (record) record.servedFromCache = true;
        break;
      }
      case 'Network.resourceChangedPriority': {
        const record = this.records.get(params.requestId);
        if (record) record.priority = params.newPriority;
        break;
      }
      case 'Network.dataReceived': {
        const record = this.records.get(params.requestId);
        if (record && Number.isFinite(params.dataLength) && params.dataLength >= 0) {
          record.decodedBodyLength = (record.decodedBodyLength ?? 0) + params.dataLength;
        }
        break;
      }
      case 'Network.loadingFinished': this.finishRequest(params, false); break;
      case 'Network.loadingFailed': this.finishRequest(params, true); break;
      case 'Page.frameNavigated': {
        const frame = params.frame;
        if (!frame.parentId) this.mainFrameId = frame.id;
        const page = this.pages.get(frame.loaderId) || this.framePages.get(frame.parentId);
        if (page) this.framePages.set(frame.id, page);
        break;
      }
      case 'Page.frameAttached': {
        const page = this.framePages.get(params.parentFrameId);
        if (page) this.framePages.set(params.frameId, page);
        break;
      }
      case 'Page.frameDetached': this.framePages.delete(params.frameId); break;
      case 'Page.lifecycleEvent': this.handleLifecycle(params); break;
      // DOM/load events without loader IDs are intentionally not attributed.
      default: break;
    }
  }

  handleRequestWillBeSent(params) {
    const chain = this.chainFor(params.requestId);
    if (!chain) return;
    const previous = this.records.get(params.requestId);
    if (previous && params.redirectResponse) {
      this.setResponse(previous, params.redirectResponse);
      previous.extraExpected = typeof params.redirectHasExtraInfo === 'boolean' ? params.redirectHasExtraInfo : null;
      previous.endTimestamp = params.timestamp;
      previous.redirectedTo = params.request?.url || '';
      previous.finishedReason = 'redirect';
      previous.encodedDataLength = params.redirectResponse.encodedDataLength;
      this.associateExtraInfo(chain);
      this.finalizeRecord(previous);
    } else if (previous) {
      previous.finishedReason = 'incomplete';
      this.finalizeRecord(previous);
    }
    if (!this.budget.reserveRecord()) return;
    const included = isHttpUrl(params.request?.url);
    // Strip payloads even when body capture is disabled, and never retain data: URLs.
    const { postData, postDataEntries: _postDataEntries, ...request } = params.request || {};
    const record = {
      id: `${params.requestId}#${chain.hops.length}`, requestId: params.requestId,
      redirectIndex: chain.hops.length, included, extraExpected: null,
      request: included ? request : { url: `${schemeOf(request.url)}:` },
      requestHeaders: included ? { ...request.headers } : {},
      requestHasPostData: Boolean(request.hasPostData || typeof postData === 'string'),
      includeRequestBodies: this.includeRequestBodies,
      startTimestamp: params.timestamp, wallTime: params.wallTime, receivedAt: new Date().toISOString(),
      type: params.type, initiator: included ? params.initiator : null,
      loaderId: params.loaderId, frameId: params.frameId,
      response: null, responseHeaders: {}, finalized: false
    };
    chain.hops.push(record);
    this.records.set(params.requestId, record);
    if (included) {
      this.allRecords.push(record);
      this.assignPage(record, params);
      if (this.includeRequestBodies && typeof postData === 'string') {
        if (this.budget.retainBody(postData)) record.requestPostData = postData;
        else record.requestBodyOmittedReason = 'memory_safety_limit';
      }
      if (this.includeRequestBodies && record.requestHasPostData && record.requestPostData === undefined && !record.requestBodyOmittedReason) {
        this.trackFinalization(this.collectRequestPostData(record), record, 'request');
      }
    } else {
      const scheme = schemeOf(request.url);
      this.excludedEntries[scheme] = (this.excludedEntries[scheme] || 0) + 1;
    }
    this.associateExtraInfo(chain);
    this.status = 'capturing';
  }

  assignPage(record, params) {
    if (params.type === 'Document' && params.frameId === this.mainFrameId && params.loaderId) {
      if (!this.pages.has(params.loaderId)) {
        this.pages.set(params.loaderId, {
          id: `page_${this.tab.id}_${this.pages.size + 1}`, frameId: params.frameId,
          loaderId: params.loaderId, startTimestamp: params.timestamp, wallTime: params.wallTime,
          receivedAt: record.receivedAt, url: params.request.url
        });
      }
      this.framePages.set(params.frameId, this.pages.get(params.loaderId));
      this.pages.get(params.loaderId).url = params.request.url;
    }
    const page = this.pages.get(params.loaderId) || this.framePages.get(params.frameId);
    if (page) record.pageRef = page.id;
  }

  handleLifecycle(params) {
    const page = this.pages.get(params.loaderId);
    if (!page || params.frameId !== page.frameId || params.timestamp < page.startTimestamp) return;
    if (params.name === 'DOMContentLoaded') page.domContentLoaded = params.timestamp;
    if (params.name === 'load') page.load = params.timestamp;
  }

  queueExtraInfo(params, phase) {
    const chain = this.chainFor(params.requestId);
    if (!chain) return;
    if (this.extraInfoPending >= this.budget.maxRecords * 2) { this.budget.reachLimit(); return; }
    chain[`${phase}Extra`].push({ headers: params.headers, headersText: params.headersText, statusCode: params.statusCode });
    this.extraInfoPending += 1;
    this.associateExtraInfo(chain);
  }

  associateExtraInfo(chain) {
    for (const phase of ['request', 'response']) {
      const queue = chain[`${phase}Extra`];
      for (const record of chain.hops) {
        if (record[`${phase}ExtraApplied`] || record.extraExpected === false) continue;
        // Unknown lifecycle is a barrier: never guess that a late N event is N+1.
        if (record.extraExpected !== true || queue.length === 0) break;
        const extra = queue.shift();
        this.extraInfoPending -= 1;
        record[`${phase}ExtraApplied`] = true;
        if (!record.included) continue;
        record[`${phase}Headers`] = { ...extra.headers };
        if (extra.headersText) record[`${phase}HeadersText`] = extra.headersText;
        if (phase === 'response' && Number.isFinite(extra.statusCode)) record.responseStatusCode = extra.statusCode;
      }
    }
  }

  setResponse(record, response) {
    if (!record.included) return;
    record.response = response;
    if (!record.responseExtraApplied) record.responseHeaders = { ...response?.headers };
    if (!record.requestExtraApplied && response?.requestHeaders) record.requestHeaders = { ...response.requestHeaders };
    if (response?.requestHeadersText) record.requestHeadersText = response.requestHeadersText;
    if (!record.responseHeadersText && response?.headersText) record.responseHeadersText = response.headersText;
  }

  handleResponseReceived(params) {
    const record = this.records.get(params.requestId);
    if (!record) return;
    this.setResponse(record, params.response);
    record.responseTimestamp = params.timestamp;
    record.type = params.type || record.type;
    record.extraExpected = typeof params.hasExtraInfo === 'boolean' ? params.hasExtraInfo : null;
    this.associateExtraInfo(this.chains.get(params.requestId));
  }

  finishRequest(params, failed) {
    const record = this.records.get(params.requestId);
    if (!record) return;
    record.endTimestamp = params.timestamp;
    record.encodedDataLength = params.encodedDataLength;
    record.failed = failed;
    record.errorText = params.errorText || '';
    record.finishedReason = failed ? 'failed' : 'finished';
    this.finalizeRecord(record);
  }

  finalizeRecord(record) {
    if (record.finalized) return;
    record.finalized = true;
    if (this.records.get(record.requestId) === record) this.records.delete(record.requestId);
    if (!record.included) return;
    this.completedCount += 1;
    if (this.includeResponseBodies && record.finishedReason === 'finished') {
      this.trackFinalization(this.collectResponseBody(record), record, 'response');
    }
  }

  trackFinalization(promise, record, phase) {
    const settled = promise.catch((error) => { record[`${phase}BodyError`] = error.message || String(error); })
      .finally(() => this.pendingFinalizations.delete(settled));
    this.pendingFinalizations.add(settled);
  }

  isCurrentHop(record) {
    return this.chains.get(record.requestId)?.hops.at(-1) === record;
  }

  async collectRequestPostData(record) {
    await this.budget.runBodyCommand(async () => {
      if (this.detached || !this.isCurrentHop(record) || record.finishedReason === 'redirect' || this.budget.limitReached) {
        record.requestBodyOmittedReason = this.budget.limitReached ? 'memory_safety_limit' : 'request_no_longer_available';
        return;
      }
      const result = await this.command('Network.getRequestPostData', { requestId: record.requestId });
      // A command response racing a redirect is ambiguous; keep neither hop's data.
      if (!this.isCurrentHop(record) || record.finishedReason === 'redirect') {
        record.requestBodyOmittedReason = 'redirect_post_data_unavailable';
      } else if (typeof result?.postData === 'string') {
        if (this.budget.retainBody(result.postData)) record.requestPostData = result.postData;
        else record.requestBodyOmittedReason = 'memory_safety_limit';
      } else record.requestBodyError = 'CDP returned no request post data';
    });
  }

  async collectResponseBody(record) {
    await this.budget.runBodyCommand(async () => {
      if (this.detached || !this.isCurrentHop(record) || this.budget.limitReached) {
        record.responseBodyOmittedReason = this.budget.limitReached ? 'memory_safety_limit' : 'response_no_longer_available';
        return;
      }
      if (this.maxResponseBodyBytes > 0 && record.decodedBodyLength > this.maxResponseBodyBytes) {
        record.responseBodyOmittedReason = 'per_resource_limit';
        return;
      }
      const result = await this.command('Network.getResponseBody', { requestId: record.requestId });
      if (!this.isCurrentHop(record)) { record.responseBodyOmittedReason = 'response_no_longer_available'; return; }
      if (typeof result?.body !== 'string') { record.responseBodyError = 'CDP returned no response body'; return; }
      record.responseBodySize = result.base64Encoded ? base64DecodedSize(result.body) : textToBytes(result.body).length;
      if (this.maxResponseBodyBytes > 0 && record.responseBodySize > this.maxResponseBodyBytes) {
        record.responseBodyOmittedReason = 'per_resource_limit';
      } else if (this.budget.retainBody(result.body)) {
        record.responseBodyText = result.body;
        record.responseBodyBase64Encoded = Boolean(result.base64Encoded);
      } else record.responseBodyOmittedReason = 'memory_safety_limit';
    });
  }

  async flushOpenRecords() {
    for (const record of Array.from(this.records.values())) {
      record.endTimestamp ??= record.responseTimestamp ?? record.startTimestamp;
      record.finishedReason ||= 'incomplete';
      if (record.finishedReason === 'incomplete') {
        record.errorText ||= 'Incomplete request: capture stopped before completion';
      }
      this.finalizeRecord(record);
    }
    while (this.pendingFinalizations.size) {
      await Promise.allSettled(Array.from(this.pendingFinalizations));
    }
  }

  async handleDetach(reason) {
    this.detached = true;
    this.terminal = true;
    if (!this.expectedDetach) this.detachReason = reason || null;
    this.status = `detached: ${reason || 'unknown'}`;
    await this.flushOpenRecords();
  }

  async buildHar(version) {
    this.terminal = true;
    await this.flushOpenRecords();
    return buildHar(this.allRecords, this.pages.values(), version);
  }

  getDiagnostics() {
    const bodyErrors = [];
    const omissions = {};
    let omittedResponseBodies = 0;
    for (const record of this.allRecords) {
      for (const phase of ['request', 'response']) {
        if (record[`${phase}BodyError`]) bodyErrors.push({ tab_id: this.tab.id, url: record.request.url,
          phase, error: record[`${phase}BodyError`] });
      }
      if (record.requestBodyOmittedReason) {
        const key = `request:${record.requestBodyOmittedReason}`;
        omissions[key] = (omissions[key] || 0) + 1;
      }
      if (record.responseBodyText === undefined) {
        const reason = record.responseBodyOmittedReason || (record.responseBodyError ? 'retrieval_error'
          : !this.includeResponseBodies ? 'disabled' : record.finishedReason || 'unavailable');
        omissions[reason] = (omissions[reason] || 0) + 1;
        omittedResponseBodies += 1;
      }
    }
    return { bodyErrors, omissions, omittedResponseBodies,
      unmatchedExtraInfo: this.extraInfoPending, diagnostics: this.diagnostics };
  }

  isQuiet(now, quietSeconds) {
    // Compare in seconds: multiplying a very large finite setting by 1000 can overflow.
    // Open requests and body collection are finalized by the graceful export path.
    return (now - this.lastNetworkActivityAt) / 1000 >= quietSeconds;
  }

  getUiStatus() {
    return `${this.detached ? 'Detached' : this.status} (${this.completedCount} complete, ${this.records.size} active)`;
  }

  async detachSafely() {
    this.terminal = true;
    if (!this.attached || this.detached) return;
    this.expectedDetach = true;
    try { await this.command('Network.disable'); } catch (error) { this.log(error.message); }
    try {
      await chromeCall(chrome.debugger.detach, { tabId: this.tab.id });
      this.detached = true;
    } catch (error) { this.log(`Detach failed for tab ${this.tab.id}: ${error.message}`); }
  }

  detachOnWorkspaceClose() {
    this.terminal = true;
    this.expectedDetach = true;
    if (this.detached || (!this.attached && this.status !== 'attaching')) return;
    // Dispatch immediately: awaiting Network.disable or body/ZIP work during
    // unload can strand an attachment after this extension context disappears.
    try {
      chrome.debugger.detach({ tabId: this.tab.id }, () => {
        const error = chrome.runtime.lastError;
        if (!error) this.detached = true;
      });
    } catch (error) { this.log(error.message); }
  }

  releaseRecords() {
    this.records.clear();
    this.chains.clear();
    this.allRecords.length = 0;
  }
}

export function chromeCall(apiFunction, ...args) {
  return new Promise((resolve, reject) => {
    // Detach can strand an outstanding command; never leave export waiting forever.
    const timer = setTimeout(() => reject(new Error('Chrome API command timed out')), 15000);
    try {
      apiFunction(...args, (result) => {
        clearTimeout(timer);
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}
