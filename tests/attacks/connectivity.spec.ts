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
import { test, expect } from "../harness/witness";
import { openAttack, settle } from "../harness/attack";

// One per probe in tests/pages/connectivity.html.
const PROBES = ["fetch", "xhr", "websocket", "beacon", "img", "link", "script", "font", "object", "iframe"];

test("no request from a widget reaches the witness", async ({ page, witness }) => {
  witness.reset();
  const attack = await openAttack(page, "connectivity");

  // Every control request must land first: proof that each probe fires and
  // that the witness hears it.
  const everyControl = PROBES.map((p) => `control-${p}`).sort();
  await expect.poll(() => witness.arrived("control-"), { timeout: 10_000 }).toEqual(everyControl);
  await attack.untilLog("widget-done");
  await settle(page);

  expect(witness.arrived("widget-"), "widget requests that arrived").toEqual([]);
});
