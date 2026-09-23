# myhar

myhar is a Chrome/Edge Manifest V3 extension for making multiple HAR files at once and exporting them to a ZIP file. It is 100% local: nothing is uploaded.


*
https://chromewebstore.google.com/detail/myhar/ecaggogjclbagdhggcihihmmagnokakn
*

The project is designed from the beginning for Chrome Web Store review hygiene:

- Single purpose: export browser traffic as local HAR files inside a ZIP archive.
- Local-only processing: captured traffic is not uploaded, synced, sold, or shared.
- No remote code: no CDN scripts, no remotely hosted JavaScript, and no runtime code downloads.
- Explicit user action: capture starts only after the user selects tabs, starts a URL-list capture, or presses a capture button.
- Minimal permissions for the implemented feature set.
- No background capture and no hidden capture.

## Current status

Version: `0.1.6`

This release is intended for GitHub publishing, local testing via `Load unpacked`, and Chrome Web Store submission as an initial public/beta build.

Implemented:

- Lists open browser tabs without automatically selecting any tab.
- Groups selected tabs, tabs opened by myhar, newly detected tabs, other capturable tabs, and non-capturable tabs.
- Allows selecting capturable `http://` and `https://` tabs.
- Captures selected tabs using the official `chrome.debugger` API.
- Supports refresh-based capture using debugger-driven page reload with a browser reload fallback.
- Supports live/manual capture.
- Supports URL-list capture: paste one URL per line, let myhar open tabs, capture navigation, and export one ZIP.
- Builds one HAR per selected or generated tab.
- Builds one local ZIP containing all HAR files plus a completed capture manifest.
- Downloads the ZIP locally with `chrome.downloads` and keeps a visible fallback download link in the capture workspace.
- Includes DevTools-like request/response body capture by default, with an advanced settings panel to disable it or set body-size limits.
- Hides the debug log in normal production UI; open the capture workspace with `?debug=1` to show it.
- Optional ZIP deflate compression when the browser exposes the Compression Streams API.
- Chrome DevTools-aligned HTTP HAR output, with ResourceTiming phases, navigation page timings, cache and Service Worker metadata when Chrome exposes them.
- Graceful per-tab debugger detach and capture-wide memory safety limits.

Not implemented yet:

- Automated Chrome Web Store assets.

## Folder layout

```text
myhar/
  extension/
    manifest.json
    assets/icons/
    src/popup/
    src/capture/
      capture.js          # workspace and multi-tab coordinator
      capture-policy.js   # network quiet setting validation and mode policy
      capture-session.js  # debugger session and request lifecycle
      har-builder.js      # CDP-to-HAR transformations
      zip-builder.js      # manifest, serialization, ZIP/CRC32/compression
  tests/
    har-builder.test.js
    fixtures/cdp-network-sample.json
  docs/
    chrome-web-store-submission.md
    privacy-policy.md
    testing-checklist.md
```

## Install locally

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select the `extension/` folder.
5. Click the myhar icon.
6. Open the capture workspace.

## Usage

### URL-list capture

Use this when you already have a list of pages and want one ZIP without opening each tab manually.

1. Open myhar.
2. Paste one URL per line into **Open URLs and capture them**.
3. Click **Open URLs and Capture**.
4. myhar opens a tab for each URL, attaches the debugger before navigation when Chrome allows it, captures traffic, waits for the configured continuous network quiet interval, builds HAR files, and downloads a ZIP.

### Refresh capture

Use this when the target pages are already open and can be safely reloaded.

1. Open the pages you want to capture.
2. Open myhar.
3. Select one or more HTTP/HTTPS tabs.
4. Click **Start Refresh Capture**.
5. Wait for automatic export after the configured continuous network quiet interval. **Stop & Export ZIP** begins graceful export immediately if you want to stop earlier, even before any requests arrive.
6. The extension attaches the debugger, enables network instrumentation, reloads selected tabs, waits for network quiet, finalizes available requests and pending body collection, builds HAR files, and downloads a ZIP.

### Live capture

Use this when the page requires login, manual navigation, clicks, or flows that should not be forced by refresh.

1. Select one or more tabs.
2. Click **Start Live Capture**.
3. Navigate or interact with the selected tabs manually.
4. Click **Stop & Export ZIP**.

Live Capture has no duration timer. It stops manually, when all captured targets detach, or when a safety limit is reached. Switching to another tab is expected: visibility changes are diagnostic and do not stop capture.

### Advanced export settings

- Request and response bodies can be enabled independently; both default to enabled.
- **Max response body per resource**: 1 MiB, 5 MiB, **25 MiB (default)**, 50 MiB, or **No myhar limit**. Browser/CDP buffer limits may still apply. The per-resource setting measures decoded response bytes.
- **Network quiet timeout**: an editable number of seconds, **15 by default**. Refresh and URL-list captures auto-export after this continuous interval without relevant captured network activity. New HTTP/HTTPS requests, responses, transfer data, completion/failure and cache notifications reset quiet. Page lifecycle events, priority changes and delayed ExtraInfo metadata do not. There is no total-duration cutoff or endpoint filtering; actual background traffic also resets quiet.

Open requests alone do not prevent automatic export. Once quiet is reached, the existing graceful export flushes unfinished records and waits for pending body retrieval. Unfinished requests remain in the HAR with an incomplete message in `response._error`; the manifest also counts incomplete body omissions. Body retrieval errors do not abort the ZIP.

Any positive finite number of seconds is accepted, including fractional or very large values. Invalid values show feedback and prevent Refresh/URL-list startup, before attaching or opening tabs. The value is fixed for each capture at startup; the field is disabled during capture. It defaults to 15 when the workspace opens and is not persisted. Checks run roughly once per second using elapsed time, so large values do not overflow JavaScript timers. Live Capture remains manual, and manual Stop & Export never waits for network quiet.

The first automatic capture displays a non-blocking **Automatic capture** notice with its configured timeout. Capture starts immediately. **Got it** stores only acknowledgement under `myhar.autoCaptureNotice.v1` in extension-page localStorage; closing without acknowledgement leaves the notice eligible to appear again. Storage failures do not affect capture. Every automatic capture still displays its timeout in the regular status after the notice is dismissed. Live Capture does not show the notice.

The workspace stops and exports at 10,000 network records or 256 MiB of retained body representation across all captured tabs. Strings are conservatively counted at two bytes per UTF-16 code unit, including base64 characters. These internal safety limits remain active with **No myhar limit**. They bound retained capture data, not the browser's total heap or transient CDP/ZIP buffers. Large bodies that exceed the shared budget are omitted; existing records are finalized and exported with `memory_safety_limit`. HARs are serialized/compressed one tab at a time to reduce temporary memory use.

### Debugger detach and workspace closure

Closing a captured tab or canceling its debugger finalizes that tab's available records. Other attached tabs continue. When no debugger sessions remain, myhar exports available data automatically instead of remaining in Capturing. Chrome's actual per-tab reason (`target_closed` or `canceled_by_user`) is stored in the manifest.

Keep the workspace open until export completes. Closing it initiates a best-effort export with `workspace_closed`, but Chrome can destroy the page before asynchronous ZIP creation/download finishes. Without a background context, a completed download on workspace closure cannot be guaranteed. The workspace dispatches debugger detaches immediately during teardown, without waiting for body collection or export.

## Troubleshooting

### Another debugger is already attached

Chrome allows only one debugger attachment per tab. If a selected tab is already being inspected by Chrome DevTools or another extension, myhar cannot attach to that tab. Blocked tabs are skipped instead of aborting the whole capture, and skipped tabs are recorded in the internal ZIP manifest.

Close DevTools for the target tab, unselect the blocked tab, or retry with a normal webpage tab.

### Refresh happens but the HAR is empty or very small

For refresh capture, wait for automatic export. Stopping immediately after clicking the refresh capture button can produce a partial or empty HAR because network events may not have arrived yet.

If a long-open tab still does not emit network traffic after refresh, use one of these workflows:

- Start a live capture, reload or navigate the target tab manually, then click **Stop & Export ZIP**.
- Paste the target URL into the URL-list capture area and let myhar open a fresh capture tab.

Sleeping/discarded tabs may need to be activated once by Chrome before a complete capture is available.

### A tab was selected without the user selecting it

myhar does not select any existing browser tab automatically. During URL-list capture, tabs created by myhar are selected because the user explicitly requested that URL capture workflow.

## Output format

Example ZIP layout:

```text
myhar_2026-06-03_00-30-00.zip
  myhar_2026-06-03_00-30-00/
    manifest.json
    tabs/
      example.com_Example_Domain.har
      app.example.com_Project_Dashboard.har
```

HAR filenames use the hostname and up to three title words, with accents normalized and Windows-unsafe characters replaced. Missing titles use `untitled`; unavailable hostnames use `unknown-host`. Names are limited to 160 characters, shortening the title first. Case-insensitive collisions within one ZIP receive `_2`, `_3`, etc. Both HAR files and `manifest.json` use two-space JSON indentation and a final newline. Full tab IDs, titles and URLs remain in the manifest.

The internal `manifest.json` includes:

- Generation timestamp.
- Tool version.
- Capture mode.
- Whether request bodies were included.
- Whether response bodies were included.
- Response body size limit.
- `network_quiet_timeout_seconds`: the quiet interval used when capture began, or `null` for manual Live Capture.
- Full original tab URLs.
- Per-tab HAR filename.
- Entry count per HAR.
- Skipped tabs and attach errors, when applicable.
- `har_profile: "chrome-devtools-aligned"` and `stop_reason`.
- Body capture errors (tab, URL, request/response phase, message), omitted-body counts and reasons.
- Excluded entry counts by scheme; only `http:` and `https:` entries go into HARs.
- Per-session `detach_reason` and unmatched ExtraInfo counts when association remains uncertain.
- Workspace visibility (`started_hidden`, `hidden_during_capture`, `hidden_duration_ms`).
- Shared memory safety thresholds and usage.

Export stop reasons are `network_quiet`, `manual_export`, `debugger_detached_by_user`, `all_targets_closed`, `memory_safety_limit`, and `workspace_closed`. `debugger_detached` is the capture-level fallback for an unrecognized detach reason; per-session values preserve Chrome's reported reason. Mixed detach causes favor `debugger_detached_by_user` when any session was canceled by the user. Historical ZIPs may contain `duration_limit`; new captures have no normal total-duration cutoff. Stop without Export discards data and creates no manifest.

HARs use CDP ResourceTiming for network phases and loader-associated main-frame lifecycle events for page timings. Unknown phases/sizes use `-1`; unrelated Live Capture lifecycle events are not attributed to new pages. Redirect hops remain separate without synthetic request IDs in HAR output. Late ExtraInfo is associated in lifecycle order; ambiguous events remain unassigned and are counted in diagnostics.

Decoded content size and transfer size (`response._transferSize`) have separate meanings. Standard `response.bodySize` stays unknown unless it can be inferred from transfer and raw header sizes. Confirmed no-network cache hits have zero transfer and unavailable DNS/connect/SSL phases; 304 revalidation remains network traffic. Service Worker metadata is retained without deduplicating matching URLs. Body retrieval failures do not abort the ZIP.

This is **Chrome DevTools-aligned HAR output**, not byte-for-byte parity. CDP buffers, capture start/stop boundaries, cache state and unavailable metadata can affect comparisons. Field conventions are informed by [Chromium's HAR exporter](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/har/Log.ts) and [NetworkRequest protocol normalization](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/core/sdk/NetworkRequest.ts).

### Development validation

No build step or test dependencies are needed. Run `node --test tests/har-builder.test.js` with Node 22+ and `node --check` on each JavaScript file. The single fixture contains sanitized real Chrome 154 CDP events from a clean profile visiting `https://example.com/`; provenance is embedded in the JSON. See [the testing checklist](docs/testing-checklist.md) for browser validation and capture-comparison procedures.

## Permission justification

The extension currently requests:

| Permission | Reason |
|---|---|
| `tabs` | Lists open tabs, shows tab titles/URLs, opens URL-list tabs, and reloads selected tabs during refresh capture. |
| `debugger` | Attaches only to selected or user-generated tabs and uses Chrome DevTools Protocol network events to build HAR entries. |
| `downloads` | Saves the generated ZIP archive to the user's machine. |

No host permissions are declared in the MVP.

## Security and privacy notes

HAR files can contain sensitive data, including full URLs, cookies, authorization headers, session identifiers, IP addresses, request metadata, request bodies, and response bodies. Users should review files before sharing them.

The extension itself does not upload captured traffic. The generated files are created locally in the extension page and saved via browser download.

## Chrome Web Store positioning

Recommended single-purpose description:

> Export network activity from selected or user-provided browser tabs into local HAR files grouped inside a ZIP archive for debugging, QA, and authorized analysis.

Avoid marketing terms such as stealth, spy, tracking, bypass, evasion, or hidden monitoring. This extension should be positioned as a developer/QA diagnostic tool.

## Release notes for 0.1.6

- Finalized internal ZIP manifest export status. Successful captures now export with `status: "completed"` instead of transient runtime states such as `capturing`.
- Added `completed_at`, `duration_ms`, `entries_total`, `last_runtime_status`, and `detached_before_export` metadata to improve downstream API parsing.
- Reduced production console noise. Expected runtime errors are shown in the workspace status area; detailed console logging is reserved for `capture.html?debug=1`.
- Updated documentation for GitHub and Chrome Web Store submission.

## Development rules

- Do not add remote scripts.
- Do not add telemetry by default.
- Do not request permissions for future features.
- Do not capture tabs unless the user selected them or explicitly started URL-list capture.
- Do not capture in the background without a visible active capture workspace.
- Keep all processing local.


### 0.1.6 final packaging polish

- Added a production icon set for Chrome Web Store and browser toolbar usage.
- Updated packaged version metadata for final submission.
