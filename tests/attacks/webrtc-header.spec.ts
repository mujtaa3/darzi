/**
 * The Connection-Allowlist response header — the one control that a host can set
 * to stop WebRTC, in Chrome only (decisions.md #22).
 *
 * The header lists where a page and its frames may connect, and it blocks WebRTC
 * unless it says `webrtc=allow`. A `srcdoc` frame inherits it. So the host sends
 * it, and marzi cannot.
 *
 * TESTED 2026-10-31, Chrome 156 on desktop: a widget that tries WebRTC sends
 * nothing. Chrome also closes the widget's process ("No binder found for
 * interface network.mojom.MdnsResponder"), and sibling widgets in that process
 * stop, with no fault. The host page lives, because marzi's sandboxed frames run
 * in another process. A plain same-origin frame shares the host's process, and
 * there the whole page dies. This looks like a Chrome bug, so the test does not
 * require the process to close. It requires what a host relies on: no traffic,
 * a live page, and a new widget that connects.
 *
 * WebKit and Firefox ignore the header. Each engine's result is pinned, as in
 * webrtc.spec.ts, so that an engine that changes turns this red.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { test, expect } from "../harness/witness";

// The page reports to the witness, so the header must allow the witness.
const ALLOWED = `response-origin "http://127.0.0.1:9999"`;
const STOPS_WEBRTC: Record<string, boolean> = { chrome: true, webkit: false, firefox: false };

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PORT = 8011;
let server: Server | undefined;

test.afterEach(() => {
  server?.closeAllConnections();
  server?.close();
});

/**
 * A small server that sends the header. tests/server.js sends no security
 * headers, on purpose. Playwright's `route.fulfill` cannot stand in here: with a
 * fulfilled page, Chrome blocked origins that the header lists (tested).
 */
async function hostPage(policy: string) {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path.startsWith("/dist/")) {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(readFileSync(REPO + path));
      return;
    }
    res.writeHead(200, { "content-type": "text/html", "connection-allowlist": policy });
    res.end(readFileSync(REPO + "tests/pages/webrtc-header.html"));
  });
  await new Promise<void>((r) => server!.listen(PORT, "127.0.0.1", r));
}

for (const [label, policy, control] of [
  ["blocks WebRTC by default", `(${ALLOWED})`, false],
  ["control: webrtc=allow lets it through", `(${ALLOWED}); webrtc=allow`, true],
] as const) {
  test(`Connection-Allowlist ${label}`, async ({ page, witness }, info) => {
    witness.reset();
    await hostPage(policy);
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
    await expect.poll(() => witness.arrived("sibling-").length, { message: "the sibling connects" }).toBeGreaterThan(0);

    await page.evaluate(() => (window as unknown as { __attack(): void }).__attack());
    await expect.poll(() => witness.arrived("hostile-start").length, { message: "the widget starts" }).toBe(1);

    // After the attempt, the host can still render a widget, and it connects.
    await expect.poll(() => witness.arrived("late-").length, { timeout: 10_000, message: "a new widget connects" }).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 800)); // retransmits, if any, arrive within this

    // The host page still runs.
    const beats = witness.arrived("host-").length;
    await expect.poll(() => witness.arrived("host-").length, { message: "the host page runs" }).toBeGreaterThan(beats);

    const engine = info.project.name;
    const siblings = witness.arrived("sibling-").length;
    console.log(`[${engine}] ${label}: udp=${witness.udp()} sibling reports=${siblings} late reports=${witness.arrived("late-").length}`);
    if (STOPS_WEBRTC[engine] && !control) expect(witness.udp(), "datagrams from the widget").toBe(0);
    else expect(witness.udp(), "datagrams from the widget").toBeGreaterThan(0);
  });
}
