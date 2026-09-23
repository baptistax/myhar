import { TabCaptureSession, CaptureBudget, chromeCall } from './capture-session.js';
import { buildCaptureZip } from './zip-builder.js';
import { DEFAULT_NETWORK_QUIET_TIMEOUT_SECONDS, isNetworkQuietMode, parseNetworkQuietTimeoutSeconds } from './capture-policy.js';

'use strict';

const DEBUG_LOG_ENABLED = new URLSearchParams(window.location.search).get('debug') === '1';
const AUTO_CAPTURE_NOTICE_KEY = 'myhar.autoCaptureNotice.v1';

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
  networkQuietTimeoutSeconds: document.getElementById('networkQuietTimeoutSeconds'),
  networkQuietError: document.getElementById('networkQuietError'),
  statusText: document.getElementById('statusText'),
  autoCaptureNotice: document.getElementById('autoCaptureNotice'),
  autoCaptureNoticeText: document.getElementById('autoCaptureNoticeText'),
  acknowledgeAutoCaptureNotice: document.getElementById('acknowledgeAutoCaptureNotice'),
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
let autoCaptureNoticeAcknowledged = false;

class CaptureCoordinator {
  constructor(options) {
    this.mode = options.mode;
    this.includeRequestBodies = options.includeRequestBodies;
    this.includeResponseBodies = options.includeResponseBodies;
    this.maxResponseBodyBytes = options.maxResponseBodyBytes;
    // Snapshot at startup; Live Capture has no automatic quiet policy.
    this.networkQuietTimeoutSeconds = isNetworkQuietMode(this.mode) ? options.networkQuietTimeoutSeconds : null;
    this.navigationTargets = options.navigationTargets || new Map();
    this.sessions = new Map();
    this.startedAt = new Date();
    this.stopped = false;
    this.exported = false;
    this.quietTimer = null;
    this.skippedTabs = [];
    this.starting = false;
    this.stopReason = null;
    this.budget = new CaptureBudget(() => this.handleSafetyLimit());
    const hidden = document.visibilityState === 'hidden';
    this.visibility = { started_hidden: hidden, hidden_during_capture: hidden, hidden_duration_ms: 0 };
    this.hiddenSince = hidden ? performance.now() : null;
    this.onVisibilityChange = () => this.trackVisibility();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  async start(tabIds) {
    this.starting = true;
    ensureDebuggerEventListener();
    setBusyState(true, this.mode);
    setStatus(`Starting ${this.mode} capture for ${tabIds.length} tab(s).`);
    showAutoCaptureNotice(this.mode, this.networkQuietTimeoutSeconds);

    for (const tabId of tabIds) {
      if (this.pendingStopReason || this.pendingDiscard) break;
      const tab = openTabs.find((candidate) => candidate.id === tabId);
      if (!tab) {
        continue;
      }

      const session = new TabCaptureSession(tab, this.includeRequestBodies, this.includeResponseBodies, this.maxResponseBodyBytes,
        { budget: this.budget, log: logLine });
      // Register before enabling domains so early events/detaches cannot be lost.
      this.sessions.set(tabId, session);
      try {
        await session.attach();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (session.attached && session.detached) {
          // A target can disappear while domains are still being enabled. Keep
          // its captured data and actual detach reason in the final export.
          logLine(`Tab ${tabId} detached during setup: ${message}`);
          renderTabs();
          continue;
        }
        session.status = attachmentFailureStatus(message);
        await session.detachSafely().catch(() => {});
        this.sessions.delete(tabId);
        this.skippedTabs.push({
          tab,
          status: session.status,
          message
        });
        logLine(`Skipped tab ${tabId}: ${message}`);
      }
      renderTabs();
    }

    this.starting = false;
    if (this.pendingDiscard) { await this.stopWithoutExport(this.pendingDiscard); return; }
    if (this.pendingStopReason) { await this.stopAndExport(this.pendingStopReason); return; }
    if (this.sessions.size === 0) {
      throw new Error('No selected tabs could be attached. Close DevTools or any other debugger attached to the selected tab, then try again.');
    }

    if (this.skippedTabs.length > 0) {
      logLine(`${this.skippedTabs.length} selected tab(s) were skipped because they could not be attached.`);
    }

    if (this.allSessionsDetached()) { await this.stopAndExport(this.detachStopReason()); return; }

    if (this.mode === 'refresh') {
      await this.reloadAttachedTabs();
      this.scheduleNetworkQuietAutoStop();
    } else if (this.mode === 'url-list') {
      await this.navigateAttachedTabs();
      this.scheduleNetworkQuietAutoStop();
    } else {
      setStatus('Live capture is running · Stop & Export when finished.');
    }
  }

  async navigateAttachedTabs() {
    setStatus(`Opening and capturing ${this.sessions.size} URL tab(s).`);

    for (const tabId of this.sessions.keys()) {
      const session = this.sessions.get(tabId);
      const targetUrl = this.navigationTargets.get(tabId);
      if (this.stopped) return;
      if (!targetUrl || !session || session.detached) {
        continue;
      }

      session.tab.url = targetUrl;
      const openTab = openTabs.find((tab) => tab.id === tabId);
      if (openTab) {
        openTab.url = targetUrl;
        openTab.title = targetUrl;
      }

      try {
        session.lastNetworkActivityAt = performance.now();
        await session.navigate(targetUrl);
      } catch (error) {
        session.status = `navigation failed: ${error.message}`;
        logLine(`Navigation failed for tab ${tabId}: ${error.message}`);
      }
    }

    renderTabs();
    if (!this.stopped) setStatus(`Capturing URLs · Auto-export after ${this.networkQuietTimeoutSeconds}s of network quiet.`);
  }

  async reloadAttachedTabs() {
    setStatus(`Reloading ${this.sessions.size} attached tab(s).`);

    for (const tabId of this.sessions.keys()) {
      const session = this.sessions.get(tabId);
      if (this.stopped) return;
      if (session.detached) continue;
      try {
        session.lastNetworkActivityAt = performance.now();
        await session.reload();
      } catch (error) {
        session.status = `reload failed: ${error.message}`;
        logLine(`Reload failed for tab ${tabId}: ${error.message}`);
      }
    }

    renderTabs();
    if (!this.stopped) setStatus(`Capturing refreshed tabs · Auto-export after ${this.networkQuietTimeoutSeconds}s of network quiet.`);
  }

  scheduleNetworkQuietAutoStop() {
    if (this.stopped || !isNetworkQuietMode(this.mode)) return;
    this.clearTimers();
    const checkQuiet = () => {
      if (this.stopped) {
        return;
      }

      const now = performance.now();
      const allQuiet = Array.from(this.sessions.values()).every((session) => session.isQuiet(now, this.networkQuietTimeoutSeconds));
      if (allQuiet) {
        this.stopAndExport('network_quiet').catch((error) => showError(error));
        return;
      }

      this.quietTimer = setTimeout(checkQuiet, 1000);
    };

    // Always use bounded checks, even for values above JavaScript timer limits.
    this.quietTimer = setTimeout(checkQuiet, 1000);
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

    session.handleDetach(reason).catch((error) => logLine(error.message));
    updateTabStatus(tabId, session.getUiStatus());
    if (!this.stopped && !this.starting && this.allSessionsDetached()) {
      this.stopAndExport(this.detachStopReason()).catch(showError);
    }
  }

  allSessionsDetached() {
    return this.sessions.size > 0 && Array.from(this.sessions.values()).every((session) => session.detached);
  }

  detachStopReason() {
    const reasons = Array.from(this.sessions.values(), (session) => session.detachReason);
    if (reasons.includes('canceled_by_user')) return 'debugger_detached_by_user';
    return reasons.every((reason) => reason === 'target_closed') ? 'all_targets_closed' : 'debugger_detached';
  }

  hasCapturedContent() {
    return Array.from(this.sessions.values()).some((session) => session.allRecords.length > 0);
  }

  handleSafetyLimit() {
    if (this.exported) return;
    if (this.stopped) { this.stopReason = 'memory_safety_limit'; return; }
    setStatus('Memory safety limit reached. Stopping capture and exporting available requests.');
    this.stopAndExport('memory_safety_limit').catch(showError);
  }

  trackVisibility() {
    const now = performance.now();
    if (document.visibilityState === 'hidden') {
      this.visibility.hidden_during_capture = true;
      this.hiddenSince ??= now;
    } else if (this.hiddenSince !== null) {
      this.visibility.hidden_duration_ms += now - this.hiddenSince;
      this.hiddenSince = null;
    }
  }

  finishVisibility() {
    if (this.hiddenSince !== null) {
      this.visibility.hidden_duration_ms += performance.now() - this.hiddenSince;
      this.hiddenSince = null;
    }
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  visibilitySnapshot() {
    return { ...this.visibility, hidden_duration_ms: Math.round(this.visibility.hidden_duration_ms) };
  }

  async stopAndExport(reason) {
    if (this.stopped) {
      return;
    }

    if (this.starting) { this.pendingStopReason = reason; return; }

    const hasEntries = this.hasCapturedContent();
    this.stopped = true;
    this.stopReason = reason || 'manual_export';
    this.clearTimers();
    this.finishVisibility();
    if (!hasEntries) {
      logLine('No network requests were captured before export. The HAR files may be empty; try live capture, URL list capture, or reload/navigate the tab manually.');
    }
    setStatus(this.stopReason === 'network_quiet'
      ? `Network quiet for ${this.networkQuietTimeoutSeconds} seconds. Building HAR files.`
      : `Stopping capture (${stopReasonLabel(this.stopReason)}). Building HAR files.`);

    let zipFile;
    try {
      zipFile = await buildCaptureZip(this, chrome.runtime.getManifest().version);
    } catch (error) {
      setBusyState(false);
      throw error;
    } finally {
      for (const session of this.sessions.values()) {
        await session.detachSafely();
      }
    }

    const downloadResult = await downloadZip(zipFile);
    this.exported = true;
    setBusyState(false);
    if (downloadResult.automatic) {
      setStatus(`Export completed: ${zipFile.manifest.captures.length} HAR files · ${zipFile.manifest.entries_total.toLocaleString()} requests · ${stopReasonLabel(this.stopReason)}`);
    } else {
      setStatus(`Export ready: ${zipFile.manifest.captures.length} HAR files · ${zipFile.manifest.entries_total.toLocaleString()} requests · ${stopReasonLabel(this.stopReason)}. Use the download link.`);
    }
    renderTabs();
  }

  async stopWithoutExport(reason) {
    if (this.stopped) {
      return;
    }
    if (this.starting) { this.pendingDiscard = reason; return; }

    this.stopped = true;
    this.stopReason = reason;
    this.clearTimers();
    this.finishVisibility();
    setStatus(`Stopping capture without export (${reason || 'manual'}).`);

    for (const session of this.sessions.values()) {
      await session.detachSafely();
      await session.flushOpenRecords();
      session.releaseRecords();
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
  }
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

  const networkQuietTimeoutSeconds = validateNetworkQuietTimeout();
  if (networkQuietTimeoutSeconds === null) return;

  activeCapture = new CaptureCoordinator({
    mode: 'refresh',
    includeRequestBodies: elements.includeRequestBodies.checked,
    includeResponseBodies: elements.includeResponseBodies.checked,
    maxResponseBodyBytes: getMaxResponseBodyBytes(),
    networkQuietTimeoutSeconds
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
    maxResponseBodyBytes: getMaxResponseBodyBytes()
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

  // Validate and snapshot before opening tabs or performing other async work.
  const networkQuietTimeoutSeconds = validateNetworkQuietTimeout();
  if (networkQuietTimeoutSeconds === null) return;

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
      networkQuietTimeoutSeconds,
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

function validateNetworkQuietTimeout() {
  const input = elements.networkQuietTimeoutSeconds;
  const seconds = parseNetworkQuietTimeoutSeconds(input.value);
  const message = seconds === null ? 'Enter a positive, finite number of seconds for network quiet.' : '';
  input.setCustomValidity(message);
  input.setAttribute('aria-invalid', String(seconds === null));
  elements.networkQuietError.textContent = message;
  elements.networkQuietError.hidden = seconds !== null;
  if (seconds === null) {
    input.closest('details').open = true;
    setStatus(message);
    input.focus();
    input.reportValidity();
  }
  return seconds;
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
  elements.networkQuietTimeoutSeconds.disabled = isBusy;
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

function stopReasonLabel(reason) {
  return {
    network_quiet: 'stopped by network quiet',
    manual_export: 'manual export', debugger_detached_by_user: 'debugger canceled by user',
    all_targets_closed: 'all target tabs closed', debugger_detached: 'all debuggers detached',
    memory_safety_limit: 'memory safety limit reached', workspace_closed: 'workspace closed'
  }[reason] || reason;
}

function setStatus(message) {
  elements.statusText.textContent = message;
  logLine(message);
}

function showAutoCaptureNotice(mode, quietSeconds) {
  elements.autoCaptureNotice.hidden = true;
  if (!isNetworkQuietMode(mode) || autoCaptureNoticeAcknowledged) return;
  try {
    if (window.localStorage.getItem(AUTO_CAPTURE_NOTICE_KEY) === 'acknowledged') return;
  } catch {
    // Optional UX persistence must never prevent capture startup.
  }
  elements.autoCaptureNoticeText.textContent = `This capture will stop and export automatically after ${quietSeconds} seconds of network quiet.`;
  elements.autoCaptureNotice.hidden = false;
}

function acknowledgeAutoCaptureNotice() {
  autoCaptureNoticeAcknowledged = true;
  elements.autoCaptureNotice.hidden = true;
  try {
    window.localStorage.setItem(AUTO_CAPTURE_NOTICE_KEY, 'acknowledged');
  } catch {
    // Dismiss for this workspace even when localStorage is unavailable.
  }
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

elements.acknowledgeAutoCaptureNotice.addEventListener('click', acknowledgeAutoCaptureNotice);

elements.networkQuietTimeoutSeconds.defaultValue = String(DEFAULT_NETWORK_QUIET_TIMEOUT_SECONDS);
elements.networkQuietTimeoutSeconds.addEventListener('input', () => {
  elements.networkQuietTimeoutSeconds.setCustomValidity('');
  elements.networkQuietTimeoutSeconds.removeAttribute('aria-invalid');
  elements.networkQuietError.hidden = true;
  elements.networkQuietError.textContent = '';
});

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
    activeCapture.stopAndExport('manual_export').catch((error) => showError(error));
  }
});

elements.stopDiscard.addEventListener('click', () => {
  if (activeCapture) {
    activeCapture.stopWithoutExport('manual_discard').catch((error) => showError(error));
  }
});

elements.clearLog.addEventListener('click', () => {
  elements.logOutput.textContent = '';
});

if (DEBUG_LOG_ENABLED) {
  elements.logCard.hidden = false;
}

window.addEventListener('beforeunload', () => {
  if (activeCapture) {
    // Best effort only: Chrome can destroy this page before async export finishes.
    // No background context is introduced to keep a closed workspace alive.
    if (!activeCapture.stopped) activeCapture.stopAndExport('workspace_closed').catch(() => {});
    for (const session of activeCapture.sessions.values()) session.detachOnWorkspaceClose();
  }

  if (activeExportObjectUrl) {
    URL.revokeObjectURL(activeExportObjectUrl);
    activeExportObjectUrl = null;
  }
});

loadTabs().catch((error) => showError(error));
