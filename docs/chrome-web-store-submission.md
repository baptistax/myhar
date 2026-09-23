# Chrome Web Store Submission Notes

This document keeps the extension aligned with Chrome Web Store review expectations.

## Product purpose

Export network activity from selected browser tabs or user-provided URLs into local HAR files grouped inside a ZIP archive for debugging, QA, and authorized analysis.

## Store listing draft

### Short description

Export multiple HAR files locally into one ZIP archive.

### Detailed description

myhar helps developers, QA analysts, support teams, and authorized security reviewers export network activity from selected browser tabs or pasted URL lists into HAR files grouped inside one ZIP archive.

The extension only captures tabs explicitly selected by the user or tabs opened after the user starts URL-list capture. Refresh and URL-list captures auto-export after a configurable continuous network quiet interval (15 seconds by default), even when long-lived requests remain open. Actual captured network activity, including received data, resets the interval. Graceful export preserves unfinished requests and waits for pending body collection. There is no total capture-duration cutoff. Live Capture is manually controlled, with graceful automatic export when all targets detach or an internal memory safety limit is reached. All HAR and ZIP files are generated locally in the browser and downloaded to the user's machine. No captured data is uploaded, synced, sold, shared, or transferred to any external server.

Exports provide Chrome DevTools-aligned HAR output, including network/page timings, distinct redirects, cache semantics and Service Worker metadata when available. Do not claim byte-for-byte equivalence with DevTools. Only HTTP/HTTPS entries are exported. Per-tab detach reasons, excluded schemes, body failures, visibility diagnostics and the capture stop reason are recorded in the local ZIP manifest.

Advanced settings offer 1, 5, 25 (default), or 50 MiB per response, plus No myhar limit; browser/CDP buffer limits may still apply. A separate shared safety limit stops capture at 10,000 records or 256 MiB of retained body representation. One detached tab does not stop unrelated captures. Switching the workspace into the background is supported and does not trigger a stop. Closing the workspace permits only a best-effort export; no background process is added to keep it alive.

Version remains `0.1.6` for this development phase. The engine remains `chrome.debugger`, with the existing `tabs`, `debugger`, and `downloads` permissions. No host permissions, service worker, content scripts, DevTools page, remote code, framework, or runtime dependencies are introduced.

Use cases:

- Reproduce web application bugs.
- Collect browser traffic for support tickets.
- Export multiple tab or URL-list captures into one ZIP archive.
- Gather authorized diagnostic data for QA and development workflows.

Important: HAR files can contain sensitive data such as cookies, tokens, authorization headers, full URLs, private request metadata, request bodies, and response bodies when content capture is enabled. Review generated files before sharing them.

## Permission justifications

### tabs

Used to list currently open tabs, display tab title and full URL to the user, open URL-list tabs, and reload only the tabs selected by the user during refresh-based capture.

### debugger

Used to attach to user-selected tabs or tabs created by the URL-list workflow and subscribe to Chrome DevTools Protocol network events required to build HAR files. The extension does not attach to unrelated tabs and does not run hidden capture.

### downloads

Used to save the generated ZIP archive to the user's local machine.

## Privacy practices summary

Recommended answer direction:

- The extension handles website traffic data only locally to provide the user-requested HAR export feature.
- The developer does not collect, transmit, sell, or share captured data.
- No analytics or telemetry are included.
- No remote code is executed.
- DevTools-like request/response content is enabled by default for useful HAR exports and can be disabled in advanced settings.

## Review risk notes

The `debugger` permission is powerful and may trigger closer review. Reduce review risk by keeping the extension narrowly scoped and making the UI explicit:

- Show selected tabs before capture.
- Start capture only after a button click.
- Provide a visible active capture workspace.
- Provide manual stop/export controls.
- Do not capture all tabs automatically.
- Do not add background capture.
- Do not add remote endpoints.
- Do not add telemetry.
- Do not obfuscate code.

## Metadata to avoid

Avoid words that imply hidden monitoring or abuse:

- spy
- stealth
- bypass
- evasion
- surveillance
- credential capture
- session hijack
- takedown-resistant

## Pre-submit checklist

- [ ] Extension loads with no console syntax errors.
- [ ] Refresh capture works on at least three normal HTTPS pages.
- [ ] Live capture works with manual navigation.
- [ ] Debugger detaches after export.
- [ ] Debugger detaches when the workspace closes.
- [ ] One detached target leaves other captures running; all detached targets trigger graceful export.
- [ ] Manifest records the actual detach reason and a persistent capture stop reason.
- [ ] Safety-limit export and download-link fallback work.
- [ ] Advanced settings show an editable Network quiet timeout (15 seconds by default, Refresh/URL-list only) and No myhar limit with their helper text.
- [ ] Cache hits have valid timings and zero network transfer; HAR sizes do not conflate decoded and transferred bytes.
- [ ] ZIP opens in Windows Explorer, macOS Finder, and 7-Zip.
- [ ] Internal manifest contains full URLs.
- [ ] Internal manifest marks successful captures as `completed`.
- [ ] HAR entries contain full request URLs.
- [ ] Advanced settings clearly disclose that request/response body content may be sensitive/larger.
- [ ] No remote scripts are present.
- [ ] No analytics or telemetry code is present.
- [ ] Privacy policy is linked in the listing.
- [ ] Store screenshots show user-controlled capture, local export, and sensitive data warning.

## Final package notes

Use `myhar-extension-v0.1.6.zip` for Chrome Web Store upload. That ZIP has `manifest.json` at the archive root. Use `myhar-repo-v0.1.6.zip` for the GitHub repository source package.


## Icon assets

The extension package includes PNG icons at 16, 32, 48, and 128 px. Source package also includes larger brand assets under `assets/brand/` for store listing or README usage.
