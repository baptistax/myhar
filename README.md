# myhar

myhar is a Chrome/Edge Manifest V3 extension for making multiple HAR files at once and exporting them to a ZIP file. It is 100% local: nothing is uploaded.

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

Not implemented yet:

- Automated Chrome Web Store assets.
- Unit tests.

## Folder layout

```text
myhar/
  extension/
    manifest.json
    assets/icons/
    src/popup/
    src/capture/
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
4. myhar opens a tab for each URL, attaches the debugger before navigation when Chrome allows it, captures traffic, waits for network quiet or the duration limit, builds HAR files, and downloads a ZIP.

### Refresh capture

Use this when the target pages are already open and can be safely reloaded.

1. Open the pages you want to capture.
2. Open myhar.
3. Select one or more HTTP/HTTPS tabs.
4. Click **Start Refresh Capture**.
5. Wait for automatic export after network quiet or the duration limit. Do not click **Stop & Export ZIP** immediately unless you intentionally want a partial export.
6. The extension attaches the debugger, enables network instrumentation, reloads selected tabs, waits for network quiet or the capture limit, builds HAR files, and downloads a ZIP.

### Live capture

Use this when the page requires login, manual navigation, clicks, or flows that should not be forced by refresh.

1. Select one or more tabs.
2. Click **Start Live Capture**.
3. Navigate or interact with the selected tabs manually.
4. Click **Stop & Export ZIP**.

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
      001_example.com_123.har
      002_app.example.com_124.har
```

The internal `manifest.json` includes:

- Generation timestamp.
- Tool version.
- Capture mode.
- Whether request bodies were included.
- Whether response bodies were included.
- Response body size limit.
- Full original tab URLs.
- Per-tab HAR filename.
- Entry count per HAR.
- Skipped tabs and attach errors, when applicable.

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
