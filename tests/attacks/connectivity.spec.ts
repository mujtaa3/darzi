/**
 * Connectivity — what the CSP takes away (rung 1).
 *
 * Ten ways a document can make a request, covering every directive the widget
 * policy re-allows (img, style, script, font) and three it leaves at
 * default-src 'none' (connect, object, frame). The same probes run in a free
 * control frame, and every control request must arrive: that is the proof
 * each probe really fires. The widget's opinion of what happened is not
 * evidence; the witness counts arrivals.
 *
 * Reading a failure: if Chrome fails with a page.goto timeout or a TypeError
 * reading `__log`, suspect a widget frame that DID load something. Playwright
 * can then lose track of the main frame (measured with frame-src loosened:
 * the page was intact, the witness had the request). It only happens after a
 * leak, so it can turn this test red, never green.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../harness/witness";
import { openAttack, settle } from "../harness/attack";

// One per probe in tests/pages/connectivity.html.
const PROBES = ["fetch", "xhr", "websocket", "beacon", "img", "link", "script", "font", "object", "iframe"];

// The labels that reached the host's own origin. Reading them also clears them.
async function localHits(page: Page): Promise<string[]> {
  return (await page.request.get("/witness-local-hits")).json();
}

test("no request from a widget reaches the witness", async ({ page, witness }) => {
  witness.reset();
  await localHits(page);
  const attack = await openAttack(page, "connectivity");

  // Every control request must land first: proof that each probe fires and
  // that the witness hears it.
  const everyControl = PROBES.map((p) => `control-${p}`).sort();
  await expect.poll(() => witness.arrived("control-"), { timeout: 10_000 }).toEqual(everyControl);
  await attack.untilLog("widget-done");
  await settle(page);

  expect(witness.arrived("widget-"), "widget requests that arrived").toEqual([]);

  // The same probes at the host page's own origin. Being the host's own frame must
  // not help: the frame has an opaque origin, and its CSP has no 'self'.
  const hits = await localHits(page);
  expect(hits.filter((h) => h.startsWith("control-host-")).sort(), "control requests to the host's origin")
    .toEqual(PROBES.map((p) => `control-host-${p}`).sort());
  expect(hits.filter((h) => h.startsWith("widget-host-")), "widget requests to the host's origin").toEqual([]);
});
