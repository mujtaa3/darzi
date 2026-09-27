/**
 * The message path — what the switchboard refuses before any handler runs
 * (rung 4): prototype-rewriting keys, shape bombs, and floods.
 */
import { test, expect } from "../harness/witness";
import { openAttack } from "../harness/attack";

test("params are rebuilt, bounded, and rate-limited at the boundary", async ({ page }) => {
  const attack = await openAttack(page, "messages");
  await attack.untilLog("(rate limit) refused");

  const audits = await attack.logged("AUDIT ");
  const refusals = audits.filter((a) => a.includes("refused"));

  // Control: the well-formed call was dispatched and its params arrived intact.
  const echoes = await attack.reports();
  expect(echoes.find((e) => e.tag === "control")).toMatchObject({ own: "tag", polluted: false });

  // __proto__ arrives as an own key over the port and is stripped: the handler
  // sees only `tag`, the params object keeps a normal prototype, and
  // Object.prototype is untouched.
  expect(echoes.find((e) => e.tag === "proto")).toMatchObject({ own: "tag", protoIntact: true, polluted: false });

  // Shape bombs never reach a handler.
  expect(refusals.some((r) => r.includes("too much data")), "1.1MB string").toBe(true);
  expect(refusals.some((r) => r.includes("nested too deeply")), "depth 40").toBe(true);
  expect(refusals.some((r) => r.includes("too many values")), "10001 nodes").toBe(true);
  expect(echoes.map((e) => e.tag)).not.toContain("big");
  expect(echoes.map((e) => e.tag)).not.toContain("deep");
  expect(echoes.map((e) => e.tag)).not.toContain("wide");

  // The flood: 200 messages, budget 120 — audited exactly once, and the
  // handler saw fewer floods than were sent.
  expect(audits.filter((a) => a.startsWith("(rate limit)")).length).toBe(1);
  expect(echoes.filter((e) => e.tag === "flood").length).toBeLessThan(200);
});
