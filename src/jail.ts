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
  // WebRTC has its own network path — it resolves and contacts the STUN server
  // you name, which is a channel `connect-src` never covered. Hence a directive
  // of its own. Chrome honours it; Firefox and Safari do not yet, so on those
  // engines this remains an open hole, documented in the threat model.
  "webrtc 'block'",
].join("; ");

/**
 * Powerful device features the frame may request. Empty means none of them.
 *
 * A third mechanism, independent of sandbox and CSP: Permissions Policy governs
 * camera, microphone, geolocation, sensors, payment and friends. Without this a
 * widget could trigger a browser permission prompt that appears to come from
 * the host app — a phishing surface whether the user accepts or declines.
 */
export const FRAME_ALLOW = "";

/**
 * Keep the host's URL out of anything the frame causes.
 *
 * A navigation normally carries a `Referer` naming the page it came from, and
 * app URLs routinely contain ids and tokens. Since a widget CAN navigate itself
 * away (demonstrated in demo/self-nav.html), this stops that navigation also
 * handing over where it came from.
 */
export const FRAME_REFERRER_POLICY = "no-referrer";

/**
 * Make JavaScript text safe to embed in an inline <script>.
 *
 * The HTML parser does not understand JavaScript: inside a <script> element it
 * simply scans for the characters `</script` (case-insensitive) and ends the
 * element there — even mid-string. Vendored library text is thousands of lines
 * we didn't write, so the sequence must be neutralised. Replacing `</script`
 * with `<\/script` is semantically identical inside a JS string literal
 * ("\/" === "/") and cannot appear as valid syntax outside one.
 */
function inlineScriptSafe(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

/**
 * Wrap the model's HTML in a document whose head we control.
 *
 * The CSP `<meta>` must precede every widget byte, because a meta policy only
 * governs what is parsed after it. Composing the document ourselves is what
 * makes that guarantee — the widget can never get a tag in ahead of ours.
 *
 * Head order matters: the stub first (so `marzi` exists no matter what a
 * library does), then vendored libraries (so their globals exist by the time
 * widget code runs during parse), then the widget's body.
 *
 * `libSources` is library text the HOST vendored and pinned — never fetched,
 * because the frame has no network and must keep having none. A library runs
 * inside the jail and therefore holds no authority: it cannot reach anything
 * the widget could not already reach. Injection is composition, not permission.
 */
export function scaffold(body: string, libSources: string[] = []): string {
  const libs = libSources
    .map((source) => `<script>${inlineScriptSafe(source)}</script>\n`)
    .join("");
  return `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">
<meta charset="utf-8">
<script>${FRAME_STUB}</script>
${libs}</head>
<body>
${body}
</body>
</html>`;
}
