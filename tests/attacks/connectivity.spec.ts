/**
 * Connectivity — what the CSP takes away (rung 1).
 *
 * Six ways a document can make a request. The widget's opinion of what
 * happened is not evidence; the witness counts arrivals.
 */
import { test, expect } from "../harness/witness";
import { openAttack, settle } from "../harness/attack";

test("no request from a widget reaches the witness", async ({ page, witness }) => {
  witness.reset();
  const attack = await openAttack(page, "connectivity");

  // The control must land first — it is the proof that the witness hears.
  await attack.untilLog("CONTROL fetch-arrived");
  await attack.untilLog("widget-done");
  await settle(page);

  expect(witness.arrived("control-"), "control frame reaches the witness").toEqual(["control-fetch", "control-img"]);
  expect(witness.arrived("widget-"), "widget requests that arrived").toEqual([]);
});
