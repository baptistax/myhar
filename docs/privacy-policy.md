# Privacy Policy for myhar

Effective date: 2026-06-03

myhar is a browser extension that helps users export network activity from tabs they explicitly select or URLs they explicitly paste into local HAR files grouped inside a ZIP archive.

## Single purpose

The extension's single purpose is to generate local HAR and ZIP files for debugging, QA, and authorized analysis of selected browser tabs and user-provided URL-list tabs.

## Data handled by the extension

The extension may process network metadata from selected tabs, including:

- Full request URLs.
- Request and response headers.
- Cookies present in request or response headers.
- HTTP status codes.
- Resource types.
- Network timing metadata.
- Request payload text when Chrome exposes that data and the advanced request body option is enabled.
- Response body content when the advanced DevTools-like response content option is enabled. Response body content may include HTML, JSON, images encoded as base64, scripts, stylesheets, or other resources exposed by Chrome.

## Local-only processing

All HAR and ZIP files are generated locally in the browser. myhar does not upload, transmit, sell, rent, share, or sync captured traffic to the developer or to any third-party service.

## No remote code

The extension does not load or execute remotely hosted JavaScript. All executable extension code is packaged with the extension.

## User control

Capture starts only after the user selects tabs, pastes URLs, and presses a capture button. The user can stop any capture manually. Refresh and URL-list captures auto-export after a configurable continuous network quiet interval (15 seconds by default), even when long-lived requests remain open. Actual network activity resets the interval. Export preserves unfinished requests and waits for pending body collection. Live Capture remains manual. There is no total capture-duration cutoff. Internal memory safety protection remains active.

## Sensitive data warning

Generated HAR files may contain sensitive information such as cookies, session tokens, authorization headers, full URLs, private route names, account identifiers, IP addresses, request bodies, response bodies, and other data exposed by web traffic. Users should review generated files before sharing them.

## Data retention

The extension does not retain captured traffic after the ZIP is generated and downloaded. Any retained copy exists only where the user's browser downloads the ZIP file.

After the user clicks **Got it** on the automatic-capture notice, the extension stores only the value `acknowledged` under the versioned localStorage key `myhar.autoCaptureNotice.v1`. This local UX preference contains no URLs, tab IDs, titles, traffic or capture results. Failure to store or read it does not affect capture.

## Third-party services

The extension does not use third-party analytics, telemetry, advertising, tracking, or remote processing services.

## Contact

For privacy questions, contact the extension publisher through the support channel listed in the Chrome Web Store listing or project repository.
