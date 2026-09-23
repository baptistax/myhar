import { textToBytes } from './har-builder.js';

export async function buildCaptureZip(coordinator, version) {
  const rootName = `myhar_${formatTimestampForFileName(coordinator.startedAt)}`;
  const manifest = {
    tool: 'myhar', version, har_profile: 'chrome-devtools-aligned',
    mode: coordinator.mode, status: 'completed', local_only: true,
    response_bodies_collected: coordinator.includeResponseBodies,
    request_bodies_included: coordinator.includeRequestBodies,
    max_response_body_bytes: coordinator.maxResponseBodyBytes,
    network_quiet_timeout_seconds: coordinator.networkQuietTimeoutSeconds ?? null,
    entries_total: 0, captures: [], body_capture_errors: [], omitted_response_bodies: 0,
    body_omissions: {}, excluded_entries: {},
    skipped_tabs: coordinator.skippedTabs.map(({ tab, status, message }) => ({
      tab_id: tab.id, tab_title: tab.title || '', url: tab.url || '', status, message
    }))
  };
  const addCounts = (target, source) => {
    for (const [key, count] of Object.entries(source)) target[key] = (target[key] || 0) + count;
  };

  // Serialize/compress one tab at a time. Do not retain every HAR JSON/UTF-8
  // buffer alongside all bodies and the assembled ZIP.
  async function* files() {
    const usedNames = new Set();
    for (const session of coordinator.sessions.values()) {
      const runtimeStatus = session.status;
      const wasDetached = session.detached;
      const har = await session.buildHar(version);
      const tab = session.tab;
      const name = buildHarFileName(tab, usedNames);
      const diagnostics = session.getDiagnostics();
      manifest.entries_total += har.log.entries.length;
      manifest.body_capture_errors.push(...diagnostics.bodyErrors);
      manifest.omitted_response_bodies += diagnostics.omittedResponseBodies;
      addCounts(manifest.body_omissions, diagnostics.omissions);
      addCounts(manifest.excluded_entries, session.excludedEntries);
      manifest.captures.push({
        file: `tabs/${name}`, tab_id: tab.id, tab_title: tab.title || '', url: tab.url || '',
        mode: coordinator.mode, status: 'completed', last_runtime_status: runtimeStatus,
        detached_before_export: wasDetached, detach_reason: session.detachReason,
        entries: har.log.entries.length, started_at: session.startedAt.toISOString(),
        completed_at: new Date().toISOString(), unmatched_extra_info_events: diagnostics.unmatchedExtraInfo,
        diagnostics: diagnostics.diagnostics
      });
      yield { path: `${rootName}/tabs/${name}`, data: textToBytes(`${JSON.stringify(har, null, 2)}\n`) };
      session.status = 'completed';
      session.releaseRecords();
    }
    const completedAt = new Date();
    Object.assign(manifest, {
      generated_at: completedAt.toISOString(), completed_at: completedAt.toISOString(),
      duration_ms: Math.max(0, completedAt - coordinator.startedAt),
      stop_reason: coordinator.stopReason,
      workspace_visibility: coordinator.visibilitySnapshot(),
      memory_safety: {
        max_records: coordinator.budget.maxRecords, max_retained_body_bytes: coordinator.budget.maxBodyBytes,
        records_seen: coordinator.budget.recordCount, retained_body_bytes: coordinator.budget.retainedBodyBytes,
        limit_reached: coordinator.budget.limitReached
      }
    });
    yield { path: `${rootName}/manifest.json`, data: textToBytes(`${JSON.stringify(manifest, null, 2)}\n`) };
  }
  return { fileName: `${rootName}.zip`, bytes: await createZip(files()), manifest };
}

export async function createZip(files) {
  const fileRecords = [];
  const chunks = [];
  let offset = 0;

  for await (const file of files) {
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

// Includes the extension and any collision suffix; leave room for extraction paths.
const MAX_HAR_FILE_NAME_LENGTH = 160;

export function buildHarFileName(tab, usedNames = new Set()) {
  const host = safeHostFromUrl(tab.url);
  const words = normalizeFileNameText(tab.title).match(/[a-z0-9]+/gi) || [];
  const title = words.slice(0, 3).join('_') || 'untitled';

  for (let occurrence = 1; ; occurrence += 1) {
    const suffix = occurrence === 1 ? '' : `_${occurrence}`;
    const availableLength = MAX_HAR_FILE_NAME_LENGTH - '.har'.length - suffix.length;
    // Shorten the title first. Only shorten an unusually long host when even
    // one title character plus the separator would otherwise exceed the limit.
    const hostPart = host.slice(0, availableLength - 2).replace(/[._]+$/g, '');
    const titlePart = title.slice(0, availableLength - hostPart.length - 1).replace(/_+$/g, '');
    const name = `${hostPart}_${titlePart}${suffix}.har`;
    // Store case-folded names because Windows treats case variants as collisions.
    const key = name.toLowerCase();
    if (!usedNames.has(key)) {
      usedNames.add(key);
      return name;
    }
  }
}

function safeHostFromUrl(url) {
  try {
    const host = normalizeFileNameText(new URL(url || '').hostname)
      .replace(/[^a-z0-9.-]+/gi, '_')
      .replace(/^[._]+|[._]+$/g, '');
    // Windows reserves device names even when followed by a dot/extension.
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(host) ? `host-${host}` : host || 'unknown-host';
  } catch {
    return 'unknown-host';
  }
}

function normalizeFileNameText(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '');
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
    // Older Chrome versions may not support deflate-raw; ZIP store is valid.
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

