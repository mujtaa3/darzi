/**
 * Libraries — host-vendored text rides into the frame intact, including the
 * one sequence that would end an inline script early (rung 4.8), now through
 * the warden's srcdoc attribute as well.
 */
import { test, expect } from "../harness/witness";
import { openAttack } from "../harness/attack";

test("vendored libraries load, draw, and survive the closing-tag trap", async ({ page }) => {
  const attack = await openAttack(page, "libraries");
  await attack.untilLog('"tag":"libs"');

  const [libs] = await attack.reports();
  expect(libs).toMatchObject({ chart: "function", points: 2, trap: "safe</script>still-safe" });
  // A blank 200x100 canvas encodes to ~1KB; a drawn chart to several.
  expect(Number(libs?.pixels)).toBeGreaterThan(2000);

  expect(await attack.logged("THROW ")).toEqual([expect.stringContaining('unknown library "nope"')]);
  expect(await attack.logged("FAULT ")).toEqual([]);
});
