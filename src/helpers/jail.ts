/**
 * The jail's helpers: small text functions that jail.ts uses to build the
 * widget's documents.
 */

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
 * the jail. The stub needs no fix, because marzi wrote it. The widget HTML
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
