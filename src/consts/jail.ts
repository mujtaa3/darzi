/**
 * The jail's constants: the sandbox token, the two CSPs, and the two smaller
 * frame settings. jail.ts uses them to build the documents. runtime.ts puts
 * three of them on the outer frame.
 */

/**
 * The only sandbox token that darzi gives. All other permissions stay off:
 * same origin, popups, top navigation, forms and modals.
 */
export const SANDBOX_TOKENS = "allow-scripts";

/**
 * The CSP of the widget's document: the network firewall that the browser
 * enforces.
 *
 * A CSP (Content-Security-Policy) is a list of rules for one document. Each
 * rule is a directive: a type of load, and the sources that it allows. For
 * example, `img-src data:` allows images only from `data:` URLs. darzi puts
 * this CSP in a `<meta>` tag at the top of the widget's document (see
 * `scaffold`).
 *
 * `default-src 'none'` is the fallback for each type of load that has no
 * directive of its own, and `'none'` allows nothing. So a load that no
 * directive below allows is blocked. The other directives allow back only
 * what a widget needs to draw itself: its own inline script and style, and
 * images and fonts from `data:` URLs. There is no `connect-src`, so fetch,
 * XHR, WebSocket, EventSource and sendBeacon fall back to `'none'` and fail.
 *
 * `'unsafe-inline'` allows script and style that are written in the document.
 * When a CSP has `default-src` or `script-src`, it blocks them unless this
 * keyword is present. On a normal page, that block stops an attacker's
 * injected script. Here, the widget's own code is inline, and all of the
 * document is untrusted anyway. So this CSP does not try to stop code from
 * running. It stops code from reaching the network.
 *
 * MDN guide: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP
 * Each directive: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy
 */
export const WIDGET_CSP = [
  "default-src 'none'", // block everything, then allow back only what is needed
  "script-src 'unsafe-inline'", // the model writes its JS inline; no remote scripts
  "style-src 'unsafe-inline'", // the same for CSS
  "img-src data:", // inline images only; a remote <img> would be a beacon
  "font-src data:",
  "form-action 'none'", // a form submit is a navigation, so it can carry data out
  // WebRTC has its own network path, which `connect-src` never covered. This
  // directive is for it. TESTED 2026-09-27 (tests/attacks/webrtc.spec.ts): no
  // engine that we test obeys it. Chrome, WebKit and Firefox all let a widget
  // reach a STUN witness, as a frame with no CSP can. The directive stays
  // because it costs nothing and engines may support it later. The suite pins
  // today's behaviour, so we notice that change. The README lists this risk.
  "webrtc 'block'",
].join("; ");

/**
 * The device features that the frame may ask for. An empty value adds no
 * features.
 *
 * Permissions Policy is separate from the sandbox and the CSP. It controls the
 * camera, the microphone, location, sensors, payment and similar features.
 * Without it, a widget could show a browser permission prompt that seems to
 * come from the host app. That is a phishing risk, whether the user accepts
 * or declines.
 *
 * Each feature has a default. A feature with the default `self` stays denied,
 * because the frame's origin is opaque: the camera, the microphone and location.
 * A feature with the default `*` stays allowed: Chrome 156 lists 17 for a widget,
 * for example `gamepad` and `picture-in-picture` (tested).
 */
export const FRAME_ALLOW = "";

/** The warden's base URL. It hides the host page's URL from the widget (see `warden`). */
export const WARDEN_BASE_URL = "about:srcdoc";

/**
 * The referrer policy of both frames: send no `Referer` header.
 *
 * When a browser loads a page, it usually sends a `Referer` header with the
 * URL of the page that the request came from. App URLs often contain ids and
 * tokens, so that header could tell an outside server about the host page. A
 * referrer policy controls how much of that URL a request sends, and
 * `no-referrer` sends nothing. darzi sets it as the `referrerpolicy` attribute
 * of both iframes (see `warden`, and `render` in runtime.ts).
 *
 * This is a backstop with an uncertain effect. The attribute controls the
 * frame's own load, and a `srcdoc` frame loads nothing from the network. The
 * main protection is the warden, which stops the widget from navigating
 * itself. `frame-settings.spec.ts` checks the attribute, and that a widget's
 * `document.referrer` is empty.
 *
 * MDN: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy
 */
export const FRAME_REFERRER_POLICY = "no-referrer";

/**
 * The warden's policy: everything that the widget document allows, plus the
 * one directive that controls the widget's navigation.
 *
 * The EMBEDDER of a frame checks `frame-src` against each navigation of that
 * frame. This includes the frame navigating itself through `location=`,
 * `location.replace`, a meta refresh or a form submit. A manual test in
 * Chrome, Firefox, WebKit and Safari showed that the block happens before any
 * DNS or TCP traffic leaves the machine. The attack suite's navigation spec
 * tests that no navigation reaches the witness. `'none'` is the only safe
 * value: any allowed origin would be a place to send stolen data.
 *
 * Why the warden repeats the rest of the widget policy: a `srcdoc` document
 * inherits its parent's policy in addition to its own. So a warden with only
 * `default-src 'none'` would also block the widget's inline script and style.
 * The warden has the same allowances, plus one directive.
 *
 * Strictly, this directive is extra protection. `frame-src` falls back to
 * `child-src`, which falls back to `default-src`, and the widget policy
 * already says `default-src 'none'`. The attack suite's mutation check showed
 * this: to remove only `frame-src 'none'` changed nothing. The directive stays
 * because it shows the warden's purpose in its policy, and because a later
 * edit to WIDGET_CSP must not quietly remove the warden's protection.
 *
 * This is also why it comes FIRST. When a policy names a directive twice, the
 * browser keeps the first and ignores the rest. At the end, this directive
 * would lose to a `frame-src` added later to WIDGET_CSP (tested: with
 * `frame-src *` there, widgets navigated themselves to the witness in every
 * engine). At the start, it wins, whatever WIDGET_CSP says.
 */
export const WARDEN_CSP = `frame-src 'none'; ${WIDGET_CSP}`;
