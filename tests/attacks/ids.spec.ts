/**
 * Identity at the host's edge (Codex N6): one live widget per id, and no name
 * registered twice.
 *
 * Two frames under one id would share one state slot and be indistinguishable
 * in the audit; a duplicate capability or library name would silently replace
 * the first. Both are host configuration errors and must fail loudly.
 */
import { test, expect } from "../harness/witness";
import { openAttack } from "../harness/attack";

test("duplicate ids and names are refused; destroy releases an id exactly once", async ({ page }) => {
  const attack = await openAttack(page, "ids");
  await attack.untilLog("DONE");

  const ok = await attack.logged("OK ");
  const thrown = await attack.logged("THROW ");
  const threw = (label: string) => thrown.find((t) => t.startsWith(label + " · "));

  // Setup refusals, with distinct names as the control.
  expect(threw("dup-capability")).toContain('capability "a.read" is registered twice');
  expect(threw("dup-library")).toContain('library "lib" is registered twice');
  expect(ok).toContain("distinct-names");

  // A live id cannot be rendered twice …
  expect(ok).toContain("render-first");
  expect(threw("render-duplicate")).toContain('widget "wid-1" is already rendered');
  // … destroy releases it …
  expect(ok).toContain("render-after-destroy");
  // … and a stale handle's second destroy does not release the newer widget's id.
  expect(ok).toContain("stale-destroy");
  expect(threw("render-while-second-live")).toContain('widget "wid-1" is already rendered');

  // Minted ids never collide (control).
  expect(ok).toEqual(expect.arrayContaining(["minted-1", "minted-2"]));

  // Refused renders leave nothing behind: 1 frame, still 1, then 3.
  expect(await attack.logged("FRAMES ")).toEqual(["1", "1", "3"]);
});
