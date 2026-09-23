# Testing Checklist

## Local install

- [ ] Load `extension/` with Developer mode.
- [ ] Popup opens.
- [ ] Capture workspace opens in a normal browser tab.
- [ ] Debug log is hidden by default.
- [ ] Debug log appears when opening `capture.html?debug=1`.
- [ ] Open tabs are listed and grouped.
- [ ] HTTP/HTTPS tabs are capturable.
- [ ] `chrome://`, `edge://`, extension pages, and empty tabs are marked as not capturable.
- [ ] No existing tab is selected automatically.

## Core validation (no test dependencies)

```powershell
node --check extension/src/capture/capture.js
node --check extension/src/capture/capture-policy.js
node --check extension/src/capture/capture-session.js
node --check extension/src/capture/har-builder.js
node --check extension/src/capture/zip-builder.js
node --check tests/har-builder.test.js
node --test tests/har-builder.test.js
```

The one fixture was recorded from actual Chrome CDP against `https://example.com/` in an isolated profile. Preserve its event structure/timing values when refreshing it. Exclude authentication cookies, tokens, private URLs, personal headers and account traffic. Inline edge cases in the same test file cover redirects, ExtraInfo ordering, cache, body failures, settings, size semantics, scheme filtering, finite timings, worker metadata, lifecycle association and shared limits.

## Refresh capture

- [ ] Select one HTTPS tab.
- [ ] Click refresh capture.
- [ ] Browser shows debugger attachment warning while capture is active.
- [ ] Tab reloads.
- [ ] ZIP download prompt appears.
- [ ] ZIP contains one HAR and one manifest.
- [ ] HAR has full URLs.
- [ ] HAR has request headers and response headers.
- [ ] Debugger detaches after export.

## Multi-tab refresh capture

- [ ] Select three HTTPS tabs.
- [ ] Capture all selected tabs.
- [ ] ZIP contains three HAR files.
- [ ] Internal manifest has three capture records.
- [ ] Each record includes full tab URL.

## URL-list capture

- [ ] Paste multiple URLs, one per line.
- [ ] Click Open URLs and Capture.
- [ ] myhar opens one tab per URL.
- [ ] Generated tabs are grouped separately in the table.
- [ ] ZIP contains one HAR per generated tab.
- [ ] Internal manifest contains the pasted URLs.

## Live capture

- [ ] Select one HTTPS tab.
- [ ] Start live capture.
- [ ] Navigate manually.
- [ ] Stop and export.
- [ ] ZIP contains the manual navigation traffic.

## Safety behavior

- [ ] Closing the workspace releases debugger attachments. Treat its export as best effort: Chrome may destroy the page before asynchronous download finishes.
- [ ] Stop without export detaches debugger.
- [ ] Capture cannot start with zero selected tabs.
- [ ] Capture cannot start for non-capturable tabs.
- [ ] UI warns that HAR files may contain sensitive data.

## Store hygiene

- [ ] No remote JavaScript.
- [ ] No CDN imports.
- [ ] No telemetry.
- [ ] No server endpoints.
- [ ] No unnecessary permissions.


## Regression checks added in 0.1.1

- Capture should still export a ZIP when a selected tab records zero network entries.
- If one selected tab has another debugger attached, the capture should skip that tab and continue with the remaining attached tabs.
- After export, the capture workspace should show a Latest ZIP link.
- Automatic download should not require a save dialog.

## Regression checks added in 0.1.4

- New or generated tabs should not be mixed into the middle of the table without a group label.
- Main production UI should show no log panel by default.
- Start Live Capture, Start Refresh Capture, Stop & Export ZIP, Stop without Export, Refresh Tab List, and Clear Selection should be visible as the main action set.
- URL-list capture should capture from the beginning of navigation when Chrome allows debugger-driven navigation from a blank tab.

## Regression checks added in 0.1.6

- Internal ZIP manifest should mark exported captures with `status: "completed"`.
- Internal ZIP manifest should include `entries_total`, `completed_at`, and per-capture `last_runtime_status`.
- Expected user-facing capture errors should not create noisy production console errors unless the workspace is opened with `?debug=1`.

## DevTools-aligned core regression matrix

- [ ] Live Capture stays running through network quiet and ends with `manual_export` when stopped manually.
- [ ] Refresh and URL-list captures end with `network_quiet` after continuous inactivity, including with open requests; captured network activity keeps capture running without a total-duration cutoff. Page lifecycle events do not reset network quiet.
- [ ] Request/response body settings work independently; disabled request bodies are not retained through CDP request objects.
- [ ] Body choices are 1, 5, 25 (default), 50 MiB and No myhar limit. Helper text says browser/CDP limits may still apply.
- [ ] Network quiet timeout says Refresh and URL-list captures only and accepts positive finite custom durations, defaulting to 15 seconds.
- [ ] Redirect chains preserve each hop's URL, status, headers, timing and Location. No body/post-data command uses a synthetic ID or assigns a later hop's body to an earlier one.
- [ ] Repeated cached resources export `_transferSize: 0` and DNS/connect/SSL `-1`. Old cache ResourceTiming does not inflate the current hop's receive time.
- [ ] A 304 network revalidation is not incorrectly treated as zero-transfer traffic.
- [ ] Worker metadata remains present and requests sharing method/URL are not deduplicated.
- [ ] Refresh/URL-list page timings are populated. Unrelated Live navigation/frame/loader events do not leak into another page.
- [ ] Close one target in a three-tab capture: the remaining tabs keep capturing and the closed tab retains `target_closed`.
- [ ] Cancel a target debugger via Chrome's UI: record `canceled_by_user`. If all sessions disappear, export with `debugger_detached_by_user` or `all_targets_closed` instead of remaining Capturing.
- [ ] Switch away from the workspace: capture continues and visibility diagnostics record hidden time.
- [ ] Exercise a long capture reaching 10,000 records across tabs and a large capture approaching 256 MiB retained body representation. Each triggers one `memory_safety_limit` export and refuses additional body retention.
- [ ] Per-resource omissions do not trigger the shared memory limit by themselves; base64 representation counts toward the global limit.
- [ ] Force body retrieval errors: remaining entries still export, diagnostics appear in the manifest, and no myhar body-error fields appear in HAR entries.
- [ ] Force automatic download failure and download using the visible ZIP link.
- [ ] Every export reports HAR/request counts plus its stop cause and persists `har_profile`/`stop_reason` in the manifest.
- [ ] Inspect parsed HARs recursively: all numbers finite, no undefined field values, no data/blob/chrome-extension entries, no internal synthetic IDs.
- [ ] ZIP opens with a standard ZIP reader; stored-file fallback works when deflate-raw is unavailable.

## Readable exports and descriptive filenames (manual verification)

This export-quality patch is validated with Node only. The following browser smoke test is for the user to perform manually:

- [ ] Load the extension manually.
- [ ] Select multiple tabs from the same domain, including at least two whose first three title words are identical.
- [ ] Export the ZIP.
- [ ] Confirm filenames describe the pages using the hostname and up to three title words, with no sequential prefixes or tab IDs.
- [ ] Confirm numbering (`_2`, `_3`, etc.) appears only for actual filename collisions.
- [ ] Open one HAR in Notepad and confirm the JSON is pretty-printed and readable.
- [ ] Confirm `manifest.json` is readable and references each exact HAR filename.
- [ ] Confirm each manifest item retains the original full tab ID, title and URL.

## Fresh DevTools comparison

Use small public, non-sensitive sites and controlled redirect/cache pages. Capture fresh myhar ZIPs and fresh Chrome DevTools HAR exports in separate equivalent navigations. Match by method, URL and occurrence/order; compare field naming, timing phases, page association, sizes, redirects, cache and worker metadata. Different capture boundaries or cache state can change counts and values, so identical total request counts are not required. Keep large ChatGPT/GitHub/Instagram reference HARs outside the repository. Do not claim byte-for-byte parity.

## Network quiet and automatic-capture notice (pending manual validation)

This ticket is validated with Node tests and static checks only. Do not launch or automate Chrome, Chromium, Edge or a headless browser for these checks. The user performs the following steps manually:

Automated coverage in `tests/har-builder.test.js` includes quiet boundaries (10s, 14.999s, 15s and 30s), open requests, pending body finalization, transfer activity, metadata exclusions, positive finite settings without product bounds, mode policy, notice acknowledgement and storage failures. Run the Node and static checks above. Browser validation remains with the user; do not load the extension programmatically.

- [ ] Load the extension manually in Chrome.
- [ ] Leave Network quiet timeout at 15.
- [ ] Start Refresh Capture on a simple page.
- [ ] Confirm the **Automatic capture** notice appears with the actual 15-second value and capture starts immediately, without acknowledgement.
- [ ] Click **Got it**, start another automatic capture and confirm the notice stays hidden, including after reopening the workspace.
- [ ] Confirm regular status still shows auto-export after 15s of network quiet on every automatic capture.
- [ ] In a workspace without acknowledgement, close without clicking **Got it** and confirm the notice reappears on the next automatic capture.
- [ ] Confirm it exports after approximately 15 continuous seconds of quiet, not 15 seconds after capture start.
- [ ] Start Refresh Capture on an active site such as YouTube.
- [ ] Confirm ongoing network activity keeps the capture alive past 15 seconds.
- [ ] Confirm an open media/long-lived request no longer blocks export after approximately 15 continuous seconds without relevant network activity. Incoming data must restart that interval.
- [ ] Confirm unfinished requests remain in the HAR with an incomplete message in `response._error`, and `manifest.json` counts incomplete body omissions.
- [ ] Change Network quiet timeout to 30.
- [ ] Confirm the next capture uses 30 in its regular status and `manifest.json` records `network_quiet_timeout_seconds: 30`. If the notice has not been acknowledged, it must also say 30.
- [ ] Confirm auto-export now requires approximately 30 continuous seconds of quiet.
- [ ] Test a much larger custom value.
- [ ] Confirm there is no separate total-duration cutoff.
- [ ] Confirm URL-list Capture follows the same policy.
- [ ] Confirm Live Capture does not auto-export because of network quiet.
- [ ] Confirm Live status says **Stop & Export when finished** and no automatic-capture notice appears.
- [ ] Confirm manual Stop & Export remains immediate, including before any requests arrive.
- [ ] Check manifest.json for `network_quiet_timeout_seconds` (the configured value for Refresh/URL-list; `null` for Live).
- [ ] Check `stop_reason`: `network_quiet` for quiet completion, `manual_export` for manual export; existing exceptional reasons still apply.
- [ ] Confirm response-body default remains 25 MiB.
- [ ] Confirm memory safety still acts independently and exports with `memory_safety_limit` if reached.
- [ ] Confirm the HAR still contains background/telemetry requests rather than aggressively filtering them.
- [ ] Send the resulting ZIP/HARs for comparison.
- [ ] Enter empty, zero, negative and non-numeric values: Refresh/URL-list startup is prevented with visible feedback and no URL-list tabs are opened. Live Capture remains usable.
- [ ] Confirm pending response bodies do not prevent initiating quiet export; export still waits for their safe finalization and tolerates retrieval errors.
- [ ] Confirm Page/Runtime events and delayed ExtraInfo metadata do not reset network quiet.
- [ ] Confirm the setting is disabled during capture and the manifest records the value used at startup.

## Historical validation run — 2026-09-23 (before this ticket)

The browser results below describe the earlier HAR-fidelity implementation, including its former duration limit. They do not validate the new network quiet policy; that browser validation remains pending with the user.

Loaded the unpacked extension in an isolated Chrome 154.0.8037.58 profile. Browser checks used the actual workspace controls and `chrome.debugger`, driven over local CDP, without adding automation dependencies to the repository. The profile ran in headless mode, so these are browser integration checks rather than a claim of completing every human UI check above.

- Passed Live, Refresh and URL-list capture; multi-tab/manual/network-quiet/30-second duration exports; independent request/response body settings and a 1 MiB per-resource omission; redirects; cached resources; closing one/all targets; normal workspace closure dispatching detach; workspace visibility diagnostics; and forced download failure with a usable ZIP fallback URL.
- Passed production safety thresholds: a two-tab capture exported exactly 10,000 requests, and a large-body capture stopped at 268,435,456 retained bytes. Both persisted `memory_safety_limit` and remained responsive through ZIP export.
- Passed 15 dependency-free tests, JavaScript syntax checks and parsed ZIP/HAR validation, including body failure isolation, immediate detach during workspace teardown and ZIP storage without compression.
- Fresh comparison used a public `https://example.com/` navigation plus a controlled local HTTP page with a redirect, cached script and POST. Six matching requests agreed on status, protocol/resource type, transfer size and standard body size. Decoded sizes agreed where available; the redirect's unknown decoded size remained `-1` in myhar versus DevTools' `0`. Network timings differed between navigations as expected; no stale cache timing inflation remained. Full HAR artifacts are excluded from version control.
- Exercised `canceled_by_user` by detaching two actual debugger sessions and delivering the corresponding event to the existing listener: the first did not end the other session, and the last exported with `debugger_detached_by_user`. **The real Chrome warning-bar Cancel button remains a manual check.** Opening DevTools in this Chrome build allowed concurrent attachment and did not emit that reason.

Workspace-close export remains explicitly best effort, not a durability guarantee. Windows Explorer/macOS Finder/7-Zip UI interoperability remains a release checklist item; generated ZIPs were parsed and decompressed programmatically during this run.
