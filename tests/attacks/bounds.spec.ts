/**
 * Bounds — values that are small on the wire but large in the host (from the
 * 2026-10-25 review: C02, C08, C09, C10; pre-publish review: SF-10).
 *
 * The params budget counts strings, keys and binary data. Five values get past
 * it or around it: an array with a huge length and no items, which the
 * sanitizer walks slot by slot; a method name, which no check bounds; a small
 * typed-array view, whose whole buffer the clone copies; a RegExp, whose source
 * the budget does not count; and an empty File or Blob, whose name or type the
 * budget does not count. Each test asserts the bound that the
 * switchboard should hold, and each has a control: a related value that the
 * switchboard refuses. A control that does not fire fails the test, so a pass
 * is never empty.
 *
 * The page logs the largest gap of a heartbeat on the host page for each step.
 * The gap shows how long one message blocked the main thread. It is evidence,
 * not an assertion.
 */
import { test, expect } from "../harness/witness";
import { openAttack } from "../harness/attack";

// MAX_METHOD_LENGTH in src/consts/runtime.ts: the most of a widget's method
// name that an audit event or an error reply carries.
const METHOD_BOUND = 300;
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

test("a widget's method name reaches onAudit and the reply with a bound", async ({ page }) => {
  const r = await run(page, "method");
  // Control: an unknown short method is refused and audited.
  expect(r.log.some((l) => l.startsWith("AUDIT refused len=4 method=nope reason=no such capability")), "control audit").toBe(true);
  // No audit event carries a method longer than the bound.
  const lengths = r.log.filter((l) => l.startsWith("AUDIT ")).map((l) => Number(/len=(\d+)/.exec(l)![1]));
  expect(lengths.filter((n) => n > METHOD_BOUND), "audited method lengths over the bound").toEqual([]);
  // The reply to the widget is bounded too: the refusal text plus the cut method.
  const reply = r.log.find((l) => l.startsWith("MARK long-method:end"))!;
  expect(Number(/reply length (\d+)/.exec(reply)![1]), "reply length").toBeLessThanOrEqual(METHOD_BOUND + 40);
});

test("a small view over a large buffer does not carry the buffer past the budget", async ({ page }) => {
  const r = await run(page, "view");
  // Control: a plain 50 MB ArrayBuffer is refused.
  expect(r.refusals("too much data"), "refusals for 'too much data'").toBeGreaterThanOrEqual(1);
  // No handler receives more buffer bytes than the budget.
  const bytes = r.handlers.map((h) => Number(h.bufferBytes ?? h.bytes ?? 0));
  expect(bytes.filter((n) => n > PARAM_TEXT), "buffer bytes that reached the handler").toEqual([]);
});

test("a RegExp's source counts against the budget", async ({ page }) => {
  const r = await run(page, "regexp");
  // Control: a 1.1 MB string is refused.
  expect(r.refusals("too much data"), "refusals for 'too much data'").toBeGreaterThanOrEqual(1);
  // No handler receives a RegExp source longer than the budget.
  const sources = r.handlers.filter((h) => h.kind === "regexp").map((h) => Number(h.sourceLength));
  expect(sources.filter((n) => n > PARAM_TEXT), "RegExp source lengths that reached the handler").toEqual([]);
});

test("a File's name and a Blob's type count against the budget", async ({ page }) => {
  const r = await run(page, "file");
  // Control: a 1.1 MB string is refused.
  expect(r.refusals("too much data"), "refusals for 'too much data'").toBeGreaterThanOrEqual(1);
  // Control: a small File still reaches the handler, so the check is not a blanket refusal.
  const files = r.handlers.filter((h) => h.kind === "file");
  expect(files.filter((h) => h.nameLength === 5 && h.typeLength === 10), "the small File").toHaveLength(1);
  // No handler receives a name or a type longer than the budget.
  const lengths = r.handlers.flatMap((h) => [Number(h.nameLength ?? 0), Number(h.typeLength ?? 0)]);
  expect(lengths.filter((n) => n > PARAM_TEXT), "name and type lengths that reached the handler").toEqual([]);
});
