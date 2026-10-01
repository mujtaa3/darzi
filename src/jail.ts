/**
 * The jail — how a widget's document is built so the browser confines it.
 *
 * Three independent mechanisms do the work, and it is worth keeping them apart
 * in your head because they govern different things:
 *
 *   sandbox attribute  →  IDENTITY. Withholding `allow-same-origin` gives the
 *                         frame an opaque origin, so the host DOM and cookies
 *                         are a stranger's property to it.
 *   CSP                →  CONNECTIVITY. `default-src 'none'` denies the whole
 *                         fetch family, so the frame cannot reach the network.
 *   the warden         →  NAVIGATION. A frame navigating ITSELF is neither an
 *                         identity nor a fetch question; only the embedder's
 *                         `frame-src` governs it. We are not the embedder of
 *                         the host page — so we insert a frame we do control
 *                         between the host and the widget. See `warden()`.
 *
 * None substitutes for another. Measured proof lives in
 * learnings/browser-platform.md and learnings/csp-verified.md.
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
  // WebRTC has its own network path, which `connect-src` never covered; this
  // directive exists for it. MEASURED 2026-09-27 (tests/attacks/webrtc.spec.ts):
  // no engine we test honours it — Chrome, WebKit and Firefox all let a widget
  // reach a STUN witness exactly as an unrestricted frame does. It stays in the
  // policy because it costs nothing and engines may ship it; the suite pins the
  // current behaviour so that day is noticed. Documented residual in README.
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

/**
 * The warden's policy: everything the widget document is allowed, plus the one
 * directive that governs the widget's navigation.
 *
 * `frame-src` is checked by the EMBEDDER of a frame against every navigation
 * of that frame — including the frame navigating itself via `location=`,
 * `location.replace`, a meta refresh or a form submit — and the block lands
 * before any DNS or TCP leaves the machine (verified in Chrome, Firefox, WebKit
 * and Safari; see learnings/csp-verified.md). `'none'` is the only safe value:
 * any allowed origin would be a destination for stolen data.
 *
 * Why the rest of the widget's policy is repeated here: a `srcdoc` document
 * inherits its parent's policy container in addition to its own. A bare
 * `default-src 'none'` on the warden would therefore strip the widget of its
 * inline script and style. Same allowances, one extra directive.
 *
 * Strictly, the extra directive is belt and braces: `frame-src` falls back to
 * `child-src`, which falls back to `default-src`, and the widget policy already
 * says `default-src 'none'`. The attack suite's mutation check found this —
 * removing only `frame-src 'none'` changed nothing. It stays because the
 * warden's whole purpose should be legible in its policy, and because a future
 * edit to WIDGET_CSP must not silently take the warden's teeth with it.
 *
 * That is also why it comes FIRST. When a policy names the same directive
 * twice, the browser keeps the first and ignores the rest. Appended, this one
 * would lose to any `frame-src` later added to WIDGET_CSP (measured: with
 * `frame-src *` there, widgets navigated themselves to the witness in every
 * engine). First, it wins whatever WIDGET_CSP says.
 */
export const WARDEN_CSP = `frame-src 'none'; ${WIDGET_CSP}`;

/** Escape a document so it can ride inside an HTML attribute (srcdoc). */
function attributeSafe(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Wrap a widget document in the warden: a frame we control, whose `frame-src
 * 'none'` is what stops the widget from navigating itself away with data in
 * the URL.
 *
 * The warden carries NO script. The handshake does not need one: the widget
 * knocks on `parent.parent` (the host), and the host verifies and answers the
 * widget's window directly through the cross-origin window allowlist
 * (`frames[0]`, `postMessage`). An inert document has nothing to trust and
 * nothing a widget could tamper with — the two frames have different opaque
 * origins, so `parent` is a window the widget can address but never touch.
 *
 * `sandbox` flags are inherited by nested frames, so the warden must carry
 * `allow-scripts` for the widget's scripts to run; it runs none of its own.
 */
export function warden(innerDocument: string): string {
  return `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="${WARDEN_CSP}">
<meta charset="utf-8">
<style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style>
</head>
<body><iframe sandbox="${SANDBOX_TOKENS}" allow="${FRAME_ALLOW}" referrerpolicy="${FRAME_REFERRER_POLICY}" srcdoc="${attributeSafe(innerDocument)}"></iframe></body>
</html>`;
}
