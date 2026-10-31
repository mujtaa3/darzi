/**
 * Bounds — values that are small on the wire but large in the host (from the
 * 2026-10-25 review: C02, C09).
 *
 * The params budget counts strings, keys and binary data. Two values get past
 * it or around it: an array with a huge length and no items, which the
 * sanitizer walks slot by slot; and a small typed-array view, whose whole
 * buffer the clone copies. Each test asserts the bound that the switchboard
 * should hold, and each has a control: a related value that the switchboard
 * refuses. A control that does not fire fails the test, so a pass is never
 * empty.
 *
 * The page logs the largest gap of a heartbeat on the host page for each step.
 * The gap shows how long one message blocked the main thread. It is evidence,
 * not an assertion.
 */
import { test, expect } from "../harness/witness";
import { openAttack } from "../harness/attack";

// MAX_PARAM_TEXT in src/consts/rpc.ts: the params budget, in characters and bytes.
const PARAM_TEXT = 1_000_000;

async function run(page: import("@playwright/test").Page, probe: string) {
  const attack = await openAttack(page, `bounds?probe=${probe}`);
  await attack.untilLog("MARK done", 25_000);
  const log = await attack.log();
  // A probe that the engine could not build proves nothing: fail loudly.
  expect(log.filter((l) => l.includes("build failed")), "probes that the engine could not build").toEqual([]);
  console.log(`[${test.info().project.name}] ${probe}: ` +
    log.filter((l) => l.startsWith("MARK") || l.startsWith("HANDLER")).join(" | "));
  return {
    log,
    refusals: (reason: string) => log.filter((l) => l.startsWith("AUDIT refused") && l.includes(reason)).length,
    handlers: log.filter((l) => l.startsWith("HANDLER ")).map((l) => JSON.parse(l.slice(8)) as Record<string, number | string>),
  };
}

test("an array with a huge length is refused before the host walks it", async ({ page }) => {
  const r = await run(page, "sparse");
  // Control: a packed array over the node limit is refused.
  expect(r.refusals("too many values"), "refusals for 'too many values'").toBeGreaterThanOrEqual(1);
  // No array of length 1e8 reaches a handler.
  expect(r.handlers.filter((h) => h.kind === "array").map((h) => h.length), "array lengths that reached the handler").toEqual([]);
});

test("a small view over a large buffer does not carry the buffer past the budget", async ({ page }) => {
  const r = await run(page, "view");
  // Control: a plain 50 MB ArrayBuffer is refused.
  expect(r.refusals("too much data"), "refusals for 'too much data'").toBeGreaterThanOrEqual(1);
  // No handler receives more buffer bytes than the budget.
  const bytes = r.handlers.map((h) => Number(h.bufferBytes ?? h.bytes ?? 0));
  expect(bytes.filter((n) => n > PARAM_TEXT), "buffer bytes that reached the handler").toEqual([]);
});
