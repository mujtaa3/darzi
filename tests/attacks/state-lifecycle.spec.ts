/**
 * State calls get the same deadline and teardown as capability calls (Codex N2).
 *
 * The store is host code the runtime does not control. A hung store must not
 * hold a widget's saveState/loadState forever, and destroying a widget must
 * tell an in-flight store call to stop — through the signal the store is
 * handed — so a late write cannot land after teardown.
 */
import { test, expect } from "../harness/witness";
import { openAttack } from "../harness/attack";

test("store calls are cut off at the deadline and on destroy, and told so", async ({ page }) => {
  const attack = await openAttack(page, "state-lifecycle");
  // Each of these only appears if the runtime gave up on the hung store; before
  // the fix the calls waited out the stub's 60 s backstop instead.
  await attack.untilLog('"tag":"deadline-save"', 10_000);
  await attack.untilLog('"tag":"deadline-load"', 10_000);
  await attack.untilLog("STORE destroy put aborted", 10_000);
  await attack.untilLog('"tag":"healthy"', 10_000);

  const by = Object.fromEntries((await attack.reports()).map((r) => [r.tag, r]));
  const store = await attack.logged("STORE ");
  const audits = await attack.logged("AUDIT ");

  // Deadline: both calls reject promptly with a plain message…
  for (const tag of ["deadline-save", "deadline-load"]) {
    expect(by[tag], tag).toMatchObject({ ok: false, error: "state operation timed out" });
    expect(Number(by[tag]?.ms), `${tag} settled in ms`).toBeLessThan(2_000);
  }
  // …the store was handed a signal and saw it abort on the timeout…
  expect(store).toContain("deadline put started signal=yes");
  expect(store).toContain("deadline get started signal=yes");
  expect(store.some((s) => s.startsWith("deadline put aborted TimeoutError"))).toBe(true);
  expect(store.some((s) => s.startsWith("deadline get aborted TimeoutError"))).toBe(true);
  // …and the audit records it.
  expect(audits).toContain("wid-save marzi/saveState refused · timed out");
  expect(audits).toContain("wid-load marzi/loadState refused · timed out");

  // Destroy mid-write: the in-flight write's signal aborts with the widget.
  expect(store).toContain("destroy put aborted AbortError:widget destroyed");
  expect(audits).toContain("wid-doomed marzi/saveState refused · widget destroyed");

  // Control: a healthy store round-trips.
  expect(by["healthy"]).toMatchObject({ ok: true, value: { n: 7 } });
});
