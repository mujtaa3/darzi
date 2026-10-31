/**
 * The jail: how marzi builds a widget's documents so that the browser confines
 * the widget.
 *
 * Three separate mechanisms do the work. Each one controls a different thing:
 *
 *   sandbox attribute  →  IDENTITY. Without `allow-same-origin`, the frame has
 *                         an opaque origin. So the host page and its cookies
 *                         belong to a different site.
 *   CSP                →  CONNECTIONS. `default-src 'none'` blocks all fetches,
 *                         so the frame cannot reach the network.
 *   the warden         →  NAVIGATION. Only the `frame-src` of the page that
 *                         embeds a frame controls that frame's navigation. The
 *                         host page is not ours, so marzi puts a frame that it
 *                         controls between the host and the widget. See
 *                         `warden()`.
 *
 * One mechanism cannot replace another. Three smaller settings also apply: the
 * Permissions Policy (`FRAME_ALLOW`), the referrer policy and the warden's
 * `<base>`. The attack suite (tests/attacks/) tests the three mechanisms in
 * Chrome, WebKit and Firefox.
 */

import { FRAME_ALLOW, FRAME_REFERRER_POLICY, SANDBOX_TOKENS, WARDEN_BASE_URL, WARDEN_CSP, WIDGET_CSP } from "./consts/jail.js";
import { FRAME_STUB } from "./frame-stub.js";
import { attributeSafe, inlineScriptSafe, lineBreaks } from "./helpers/jail.js";
import type { Scaffold } from "./types/jail.js";

/**
 * Put the model's HTML into a document whose head marzi writes.
 *
 * The CSP `<meta>` must come before every byte of the widget, because a meta
 * policy controls only what the parser reads after it. marzi writes the whole
 * document, so the widget can never put a tag before ours.
 *
 * The order in the head matters:
 *   1. the stub, so that `marzi` exists before any library runs;
 *   2. the vendored libraries, so that their globals exist when widget code
 *      runs during the parse;
 *   3. then the widget HTML, in the body.
 *
 * `libSources` is library text that the HOST vendored and pinned. The frame
 * never fetches it, because the frame has no network and must keep none. A
 * library runs inside the jail, so it has no authority: it cannot reach
 * anything that the widget cannot reach. To inject a library is to compose
 * the document, not to give a permission.
 *
 * The function also returns the lines of the document that hold the widget
 * HTML. A browser reports an error's line in the whole document, stub and
 * libraries included. So the runtime needs the start of the widget HTML to
 * turn that number into a line of the widget's own HTML (see WidgetFault.line).
 */
export function scaffold(body: string, libSources: string[] = []): Scaffold {
  const libs = libSources
    .map((source) => `    <script>${inlineScriptSafe(source)}</script>\n`)
    .join("");
  // The document around the widget HTML. `beforeBody` is kept separate so that
  // its lines can be counted. The indents become part of the document; they add
  // no line breaks.
  const beforeBody = `<!doctype html>
<html>
  <head>
    <meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">
    <meta charset="utf-8">
    <script>${FRAME_STUB}</script>
${libs}  </head>
  <body>
`;
  const afterBody = `
  </body>
</html>`;

  const first = lineBreaks(beforeBody) + 1;
  return {
    html: beforeBody + body + afterBody,
    bodyLines: { first, last: first + lineBreaks(body) },
  };
}

/**
 * Put a widget document inside the warden: an outer frame that marzi controls.
 * Its `frame-src 'none'` stops the widget from navigating itself away with
 * data in the URL.
 *
 * The warden has no script, and the handshake does not need one. The widget
 * sends "ready" to `parent.parent` (the host page). The host answers the
 * widget's window directly, through `frames[0]`. A frame with no script has
 * nothing that a widget could trick or change. The warden and the widget have
 * different opaque origins, so the widget can send to the warden but cannot
 * read it.
 *
 * Nested frames inherit `sandbox` flags, so the warden needs `allow-scripts`
 * for the widget's scripts to run. It runs no script of its own.
 *
 * The `<base>` hides the host page's URL. A `srcdoc` document has no URL of its
 * own, so it takes its base URL from its parent. Without this tag, the host
 * URL, with its query and fragment, is the widget's `document.baseURI`, and
 * `<a href="#x">` is a real navigation that the warden blocks. The tag is here
 * because the widget cannot change the warden. A `<base>` in the widget's
 * document does not work: the widget can remove it. A host CSP with `base-uri`
 * can block this tag, so `render` checks first (see `baseTagAllowed`).
 */
export function warden(innerDocument: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta http-equiv="Content-Security-Policy" content="${WARDEN_CSP}">
    <meta charset="utf-8">
    <base href="${WARDEN_BASE_URL}">
    <style>
      html, body { margin: 0; height: 100%; }
      iframe { display: block; width: 100%; height: 100%; border: 0; }
    </style>
  </head>
  <body>
    <iframe
      sandbox="${SANDBOX_TOKENS}"
      allow="${FRAME_ALLOW}"
      referrerpolicy="${FRAME_REFERRER_POLICY}"
      srcdoc="${attributeSafe(innerDocument)}"
    ></iframe>
  </body>
</html>`;
}
