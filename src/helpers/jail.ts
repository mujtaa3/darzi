/**
 * The jail's helpers: small text functions that jail.ts uses to build the
 * widget's documents, and one check of the host page's CSP.
 */

import { WARDEN_BASE_URL } from "../consts/jail.js";

/**
 * Stop a library's text from ending its <script> element too early.
 *
 * The browser reads the page in two steps. First the HTML parser finds each
 * <script> element. It does not read JavaScript: it ends the element at the
 * first `</script` that it sees, even inside a string. Then the JavaScript
 * engine runs the text between the tags.
 *
 * So a library line such as `var tag = "</script>";` would end the element
 * in the middle of the library. The engine would get half the library, and
 * the widget would fail with an error such as "Chart is not defined".
 *
 * The fix changes each `</script` (in any case) to `<\/script`. In a
 * JavaScript string, `\/` is the same character as `/`, so the library still
 * works. The HTML parser no longer sees `</script`, so the element ends at
 * the correct place.
 *
 * This is for correctness, not security: a broken library still runs inside
 * the jail. The stub needs no fix, because darzi wrote it. The widget HTML
 * needs none, because its <script> tags are meant to be HTML.
 * tests/pages/libraries.html tests it with a library that contains `</script>`.
 */
export function inlineScriptSafe(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

/**
 * Count line breaks as the HTML parser counts them. The parser changes CR LF
 * into one break, and a CR alone into one break, before it counts lines. To
 * count only "\n" would give a wrong count for text with Windows or old Mac
 * line endings. The `</script` change and the srcdoc escaping add no breaks,
 * so the count of the composed text is the count that the browser sees.
 */
export function lineBreaks(text: string): number {
  return text.match(/\r\n|\r|\n/g)?.length ?? 0;
}

/** Escape a document so that it can go inside an HTML attribute (srcdoc). */
export function attributeSafe(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Whether a document's CSP lets the warden's `<base>` work. A `srcdoc` frame
 * inherits the host's CSP, so `base-uri` can block the tag with no error, and
 * the widget can then read the host's URL. Only a real frame shows the result:
 * this one is same-origin, so the host can read it, and it inherits the same
 * CSP. It stays on the page for no longer than this function runs.
 */
export function baseTagAllowed(doc: Document): boolean {
  const probe = doc.createElement("iframe");
  probe.style.display = "none";
  doc.documentElement.appendChild(probe);
  try {
    const inner = probe.contentDocument;
    // No readable document: the page itself is sandboxed. Nothing to test.
    if (inner === null) return true;
    const base = inner.createElement("base");
    base.setAttribute("href", WARDEN_BASE_URL);
    inner.head.appendChild(base);
    return inner.baseURI === WARDEN_BASE_URL;
  } finally {
    probe.remove();
  }
}
