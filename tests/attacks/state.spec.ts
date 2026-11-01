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
  expect(String(by["big"]?.err)).toContain("state too large (100010 bytes > 64000)");
  expect(String(by["cycle"]?.err)).toContain("state rejected");

  const audits = await attack.logged("AUDIT ");
  // The limit is in UTF-8 bytes, not characters: 30 000 euro signs are 30 008
  // characters of JSON — under the limit by .length — but 90 008 bytes. Under
  // a character count this save would have been accepted.
  expect(String(by["euro-over"]?.err)).toContain("state too large (90008 bytes > 64000)");
  // Control: 20 000 euro signs are 60 008 bytes, inside the limit.
  expect(by["euro-under"]).toMatchObject({ saved: true });

  // State goes through JSON: a Date comes back as a string, and NaN as null.
  expect(by["json-round-trip"]).toMatchObject({ when: "1970-01-01T00:00:00.000Z", nothing: null });

  // The option sets the limit, in both directions.
  expect(by["at-limit"]).toMatchObject({ saved: true });
  expect(String(by["over-limit"]?.err)).toContain("state too large (201 bytes > 200)");
  expect(by["large-limit"]).toMatchObject({ saved: true });

  // With no store, state calls are refused and audited, and nothing is dispatched.
  expect(by["no-store-save"]).toMatchObject({ err: "no store configured" });
  expect(by["no-store-load"]).toMatchObject({ err: "no store configured" });
  expect(audits).toContain("marzi/loadState refused · no store configured");

  // big, cycle, euro-over, over-limit, and no store.
  expect(audits.filter((a) => a.startsWith("marzi/saveState refused")).length).toBe(5);
});
