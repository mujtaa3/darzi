/**
 * State — the filing cabinet's slot is per widget, sanitized, and bounded (rung 6).
 */
import { test, expect } from "../harness/witness";
import { openAttack } from "../harness/attack";

test("saved state comes back to its own widget only, cleaned and capped", async ({ page }) => {
  const attack = await openAttack(page, "state");
  await attack.untilLog("DONE");
  const by = Object.fromEntries((await attack.reports()).map((r) => [r.tag, r]));

  expect(by["load-A"]).toMatchObject({ n: 42, protoKey: false, polluted: false });
  expect(by["load-B"]).toMatchObject({ value: null });
  expect(String(by["big"]?.err)).toContain("state too large (100010 > 64000)");
  expect(String(by["cycle"]?.err)).toContain("state rejected");

  const audits = await attack.logged("AUDIT ");
  expect(audits.filter((a) => a.startsWith("marzi/saveState refused")).length).toBe(2);
});
