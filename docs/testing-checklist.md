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

- [ ] Closing the workspace detaches debugger.
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
