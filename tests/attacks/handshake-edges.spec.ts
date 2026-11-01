/**
 * Handshake edges — the cases around a widget's connection (bugs.md B24, B26).
 *
 * handshake.spec.ts has the main path: a sibling that knocks, and a widget that
 * renames itself. Here are a flood during a handshake, a nested frame's knock, a
 * destroy before the connection, a lent port that outlives its owner, a claimed
 * id on each kind of call, and a widget that never connects.
 */
import { test, expect } from "../harness/witness";
import { openAttack, settle } from "../harness/attack";

test("a flood of window messages from another frame does not stop a handshake", async ({ page }) => {
  const attack = await openAttack(page, "handshake-edges?probe=flood");
  await attack.untilLog('"tag":"connected"');
  await attack.untilLog("SIBLING flooded");
  await settle(page);

  expect(await attack.logged("SIBLING "), "the sibling gets no port").toEqual(["flooded"]);
  expect(await attack.logged("FAULT "), "faults").toEqual([]);
});

test("a frame nested in a widget gets no port, and cuts no one off", async ({ page }) => {
  const attack = await openAttack(page, "handshake-edges?probe=nested-knock");
  await attack.untilLog('"tag":"victim-after"');

  const reports = await attack.reports();
  expect(reports.find((r) => r.tag === "nested-ports")?.n, "ports that reached the nested frame").toBe(0);
  const audits = await attack.logged("AUDIT ");
  expect(audits.filter((a) => a.startsWith("victim ")), "the victim's calls").toHaveLength(2);
  expect(audits.filter((a) => a.startsWith("knocker ")), "the knocker's call").toHaveLength(1);
  expect(await attack.logged("FAULT "), "faults").toEqual([]);
});

test("destroy before the connection gives no fault, and frees the id", async ({ page }) => {
  const attack = await openAttack(page, "handshake-edges?probe=destroy-early");
  await attack.untilLog("PAST-START-TIMEOUT");

  // Control: the new widget under this id connected, so the page works.
  await attack.untilLog('"tag":"same-id"');
  // Past `startTimeoutMs`, the destroyed widget has reported nothing.
  expect(await attack.logged("FAULT "), "faults").toEqual([]);
});

test("a lent port dies with its owner, and does not reach a new widget with that id", async ({ page }) => {
  const attack = await openAttack(page, "handshake-edges?probe=lent-port");
  await attack.untilLog('"tag":"helper-sent"');
  await settle(page);

  const tags = (await attack.reports()).map((r) => r.tag);
  // Control: the lent port worked while its owner was alive.
  expect(tags, "before the destroy").toContain("lent-before");
  expect(tags, "the new widget connects").toContain("new-owner");
  expect(tags, "after the destroy").not.toContain("lent-after");
  // Under the owner's id: its first call, the lent port's call, and the new widget's
  // call. The lent port's call was still open at the destroy, so it is also refused.
  expect(await attack.logged("AUDIT owner "), "the owner's id").toEqual([
    "probe.report dispatched", "probe.report dispatched", "probe.report refused · widget destroyed", "probe.report dispatched",
  ]);
});

test("a claimed id changes nothing on a call, a refusal, or saved state", async ({ page }) => {
  const attack = await openAttack(page, "handshake-edges?probe=claimed-id");
  await attack.untilLog('"tag":"claimer-done"');

  // The other widget made one call. Nothing that the claimer sent is under its id.
  expect(await attack.logged("AUDIT other "), "under the other widget's id").toEqual(["probe.report dispatched"]);
  const audits = await attack.logged("AUDIT claimer ");
  expect(audits, "the refusal").toContain("no.such refused · no such capability");
  expect(audits, "the state call").toContain("marzi/saveState dispatched");
  expect(await attack.logged("PUT "), "the store's key").toEqual(["claimer"]);
  // In params, the claim is only data.
  expect((await attack.reports()).find((r) => r.tag === "claimed")?.widgetId).toBe("other");
  // The handler's own widgetId comes from the port, also for the call that claims another.
  expect(await attack.logged("CALLER "), "the id that each handler got").toEqual(expect.arrayContaining([
    "other-ready other", "claimer-ready claimer", "claimed claimer", "claimer-done claimer",
  ]));
});

test("a widget that never connects is reported at startTimeoutMs, and only that widget", async ({ page }) => {
  const attack = await openAttack(page, "handshake-edges?probe=never-started");
  await attack.untilLog("AFTER-THE-TIMEOUT");
  // Control: a widget that can connect does.
  await attack.untilLog('"tag":"alive"');

  const log = await attack.log();
  const fault = log.indexOf("FAULT orphan never-started");
  expect(fault, "the fault, for the orphan").toBeGreaterThanOrEqual(0);
  expect(fault, "not before startTimeoutMs").toBeGreaterThan(log.indexOf("BEFORE-THE-TIMEOUT"));
  expect(fault, "not after startTimeoutMs").toBeLessThan(log.indexOf("AFTER-THE-TIMEOUT"));
  expect(await attack.logged("FAULT "), "only the orphan").toEqual(["orphan never-started"]);
});

test("a widget can call only what its own runtime registered", async ({ page }) => {
  const attack = await openAttack(page, "handshake-edges?probe=separate-runtimes");
  await attack.untilLog('"tag":"writer-done"');
  await attack.untilLog('"tag":"reader-done"');

  expect((await attack.log()).filter((l) => l === "WRITE-RAN"), "only the writer's call").toHaveLength(1);
  expect(String((await attack.reports()).find((r) => r["tag"] === "reader-done")?.["result"])).toContain("no such capability");
  expect(await attack.logged("AUDIT reader "), "the refusal").toContain("probe.write refused · no such capability");
});
