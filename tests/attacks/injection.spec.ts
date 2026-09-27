/**
 * Injection through the data (rung 3.6).
 *
 * A payload in a merchant name reaches a careless widget's authority — and
 * nothing beyond it. The careful twin renders the same rows inertly.
 */
import { test, expect } from "../harness/witness";
import { openAttack, settle } from "../harness/attack";

test("a data-borne payload is bounded by what the host registered", async ({ page }) => {
  const attack = await openAttack(page, "injection");
  await attack.untilLog('"tag":"textContent-rendered"');
  await attack.untilLog('"tag":"innerHTML-rendered"');
  await settle(page);

  const [safeId] = await attack.logged("SAFE ");
  const [unsafeId] = await attack.logged("UNSAFE ");
  const audits = (await attack.logged("AUDIT ")).map((l) => {
    const [who, method, decision, ...rest] = l.split(" ");
    return { who, method, decision, reason: rest.join(" ").replace(/^· /, "") };
  });

  // The payload fired — once, from the careless widget, using ITS grants.
  const stolen = audits.filter((a) => a.method === "probe.stolen");
  expect(stolen).toEqual([{ who: unsafeId, method: "probe.stolen", decision: "dispatched", reason: "" }]);
  expect(await attack.logged("STOLEN")).toHaveLength(1);

  // What the host never registered stays out of reach, even for injected code.
  const overreach = audits.filter((a) => a.method === "admin.export");
  expect(overreach).toEqual([{ who: unsafeId, method: "admin.export", decision: "refused", reason: "no such capability" }]);

  // The careful twin made exactly its two honest calls and nothing else.
  expect(audits.filter((a) => a.who === safeId).map((a) => a.method).sort()).toEqual(["probe.report", "transactions.list"]);
});
