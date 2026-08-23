/**
 * The jail — how a widget's document is built so the browser confines it.
 *
 * Two independent mechanisms do the work, and it is worth keeping them apart in
 * your head because they govern different things:
 *
 *   sandbox attribute  →  IDENTITY. Withholding `allow-same-origin` gives the
 *                         frame an opaque origin, so the host DOM and cookies
 *                         are a stranger's property to it.
 *   CSP                →  CONNECTIVITY. `default-src 'none'` denies the whole
 *                         fetch family, so the frame cannot reach the network.
 *
 * Neither substitutes for the other. Measured proof of both lives in
 * learnings/browser-platform.md.
 */

import { FRAME_STUB } from "./frame-stub.js";

/** The single sandbox token we grant. See learnings/browser-platform.md. */
export const SANDBOX_TOKENS = "allow-scripts";

/**
 * The widget's egress firewall, enforced by the browser.
 *
 * `default-src 'none'` denies every category outright; the rest add back the
 * minimum a widget needs to draw itself. Note what is NOT added back: there is
 * no `connect-src`, so it inherits 'none' — fetch, XHR, WebSocket, EventSource
 * and sendBeacon are all dead. Nor is there any remote source for scripts,
 * styles, images or fonts, so a widget cannot beacon out by loading one.
 *
 * `'unsafe-inline'` looks alarming and is correct here. Its usual danger is
 * that it lets INJECTED script run alongside a page's trusted script — but this
 * document has no trusted script. The whole document is untrusted by design.
 * We are not trying to stop code from running; we are stopping it reaching out.
 */
export const WIDGET_CSP = [
  "default-src 'none'", // deny everything, then hand back only what's needed
  "script-src 'unsafe-inline'", // the model writes its JS inline; no remote scripts
  "style-src 'unsafe-inline'", // same for CSS
  "img-src data:", // inline images only — a remote <img> would be a beacon
  "font-src data:",
  "form-action 'none'", // submitting a form is a navigation, i.e. an exfil channel
].join("; ");

/**
 * Wrap the model's HTML in a document whose head we control.
 *
 * The CSP `<meta>` must precede every widget byte, because a meta policy only
 * governs what is parsed after it. Composing the document ourselves is what
 * makes that guarantee — the widget can never get a tag in ahead of ours.
 *
 * The stub goes in the head too, so it captures the port before any widget code
 * has a chance to run.
 */
export function scaffold(body: string): string {
  return `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">
<meta charset="utf-8">
<script>${FRAME_STUB}</script>
</head>
<body>
${body}
</body>
</html>`;
}
