/**
 * Navigation — what the warden takes away (rungs 3.5 and 8).
 *
 * Neither the sandbox nor the widget's own CSP governs a frame navigating
 * itself; only the embedder's frame-src does, and the warden is that
 * embedder. Four vectors from a rendered widget; raw sandboxed controls prove
 * the vectors and the witness work.
 *
 * This is the spec that must go red if a browser ever starts checking the
 * initiator's policy instead of the embedder's (open CSP3 spec bug).
 */
import { test, expect } from "../harness/witness";
import { openAttack, settle } from "../harness/attack";

test("a widget cannot navigate itself to the witness", async ({ page, witness }, info) => {
  witness.reset();
  const attack = await openAttack(page, "navigation");

  await attack.untilCount("start:", 4);
  // Three controls can arrive (form needs allow-forms, which nobody grants).
  await expect.poll(() => witness.arrived("control-").length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  await settle(page, 1_200);

  expect(witness.arrived("control-")).toEqual(["control-href", "control-meta", "control-replace"]);
  expect(witness.arrived("runtime-"), "runtime widgets that arrived").toEqual([]);

  // Documented aftermath per engine: WebKit and Firefox keep the blocked
  // document alive; Chrome replaces it with its blocked-page.
  const alive = await attack.logged("alive:");
  if (info.project.name === "chrome") {
    expect(alive).toContain("form");
  } else {
    expect(alive.sort()).toEqual(["form", "href", "meta", "replace"]);
  }
});
