/**
 * Deadlines — what stops a call that leaves the switchboard (pre-publish review
 * SF-2, bugs.md B24).
 *
 * A capability handler is host code that marzi does not control. So each call
 * gets a signal that aborts at `callTimeoutMs`, or when the widget is destroyed.
 * The runtime also stops waiting at that moment, whatever the handler does.
 *
 * The first version built this signal with `AbortSignal.any` and
 * `AbortSignal.timeout`. Safari got `any` only in 17.4, Firefox in 124 and Chrome
 * in 116. Without it, a capability call threw after the audit said "dispatched",
 * and a store call threw before any audit. In each case the widget waited for
 * the stub's backstop. So each scenario in the loop below runs twice: in the
 * browser as it is, and with both functions removed.
 *
 * The attack suite runs in current browsers only, so the second run does not
 * test an old browser. TESTED BY HAND 2026-10-31, with the Playwright builds of
 * Chromium 101 and 115, Firefox 97 and 115, and WebKit 15.4 and 17.0: all of
 * these scenarios pass. Before this fix they failed in 115, 115 and 17.0.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../harness/witness";
import { openAttack, removeNewAbortFunctions } from "../harness/attack";

// MS in tests/pages/deadlines.html.
const MS = 400;
// A timer can fire a little before the handler's own clock says so, because the
// timer starts before the handler does.
const EARLY = 50;

const after = (line: string) => Number(/after=(\d+)/.exec(line)![1]);
const lines = (log: string[], prefix: string) => log.filter((l) => l.startsWith(prefix));
// The abort came before the control timer of that call: see `watch` in the page.
const beforeControl = (log: string[], tag: string) =>
  log.findIndex((l) => l.startsWith(`ABORT ${tag}`)) < log.indexOf(`PAST ${tag}`);

for (const mode of ["as it is", "without the new functions"] as const) {
  const old = mode !== "as it is";

  async function open(page: Page, probe: string) {
    if (old) await removeNewAbortFunctions(page);
    const attack = await openAttack(page, `deadlines?probe=${probe}`);
    if (old) {
      // Control: the two functions are gone from this page.
      const kinds = await page.evaluate(() => {
        const signal = AbortSignal as unknown as { any?: unknown; timeout?: unknown };
        return [typeof signal.any, typeof signal.timeout];
      });
      expect(kinds, "the functions were removed").toEqual(["undefined", "undefined"]);
    }
    return attack;
  }

  test.describe(`${mode}:`, () => {
    test("a call that answers gets its answer, and its deadline then has no effect", async ({ page }) => {
      const attack = await open(page, "answers");
      await attack.untilLog('"tag":"quick"');
      await attack.untilLog("ABORT quick");

      const reports = await attack.reports();
      expect(reports, "one answer").toEqual([{ tag: "quick", ok: true, value: "answer" }]);
      const log = await attack.log();
      expect(lines(log, "START quick")).toEqual(["START quick aborted=false"]);
      // The signal still aborts at the deadline, but the call has ended: no refusal.
      expect(lines(log, "ABORT quick")[0]).toContain("TimeoutError");
      expect(await attack.logged("AUDIT wid probe.quick")).toEqual([" dispatched"]);
    });

    test("a handler that never answers stops at the deadline", async ({ page }) => {
      const attack = await open(page, "deadline");
      await attack.untilLog('"tag":"hang"');
      await attack.untilLog("PAST hang");

      const [reply] = await attack.reports();
      expect(reply, "the widget's error").toEqual({ tag: "hang", ok: false, error: "capability timed out" });
      const log = await attack.log();
      expect(lines(log, "START hang")).toEqual(["START hang aborted=false"]);
      const [aborted] = lines(log, "ABORT hang");
      expect(aborted, "the reason").toContain("ABORT hang TimeoutError:");
      expect(after(aborted!), "not before the deadline").toBeGreaterThanOrEqual(MS - EARLY);
      expect(beforeControl(log, "hang"), "not after the deadline").toBe(true);
      expect(await attack.logged("AUDIT wid probe.hang")).toEqual([" dispatched", " refused · timed out"]);
    });

    test("the signal stops a fetch, as the README shows", async ({ page }) => {
      // This route never answers, so only the signal can end the fetch.
      await page.route("**/hang-forever", () => {});
      const attack = await open(page, "fetch");
      await attack.untilLog('"tag":"fetch"');
      await attack.untilLog("FETCH rejected");

      expect((await attack.reports())[0]).toEqual({ tag: "fetch", ok: false, error: "capability timed out" });
      // The fetch stopped. Chrome and Firefox reject with the signal's reason, and
      // WebKit with an AbortError (tested with the native functions too).
      expect(await attack.logged("FETCH ")).toEqual([expect.stringMatching(/^rejected (TimeoutError|AbortError)$/)]);
      expect(await attack.logged("AUDIT wid probe.fetch")).toEqual([" dispatched", " refused · timed out"]);
    });

    test("a handler's own result after the abort does not count", async ({ page }) => {
      const attack = await open(page, "abort-aware");
      await attack.untilLog('"tag":"aware"');

      expect((await attack.reports())[0]).toEqual({ tag: "aware", ok: false, error: "capability timed out" });
      expect(await attack.logged("AUDIT wid probe.aware")).toEqual([" dispatched", " refused · timed out"]);
    });

    test("a handler that answers inside its abort listener still answers", async ({ page }) => {
      const attack = await open(page, "direct-resolve");
      await attack.untilLog('"tag":"direct"');

      expect((await attack.reports())[0]).toEqual({ tag: "direct", ok: true, value: { partial: true } });
      expect(await attack.logged("AUDIT wid probe.direct")).toEqual([" dispatched"]);
    });

    test("a handler that rejects inside its abort listener counts as failed", async ({ page }) => {
      const attack = await open(page, "direct-reject");
      await attack.untilLog('"tag":"direct"');

      expect((await attack.reports())[0]).toEqual({ tag: "direct", ok: false, error: "capability failed" });
      expect(await attack.logged("AUDIT wid probe.direct")).toEqual([" dispatched", " refused · capability failed"]);
    });

    test("a store that never answers stops at the deadline", async ({ page }) => {
      const attack = await open(page, "store-deadline");
      await attack.untilLog('"tag":"load"');
      await attack.untilLog('"tag":"save"');
      await attack.untilLog("PAST get");
      await attack.untilLog("PAST put");

      const log = await attack.log();
      for (const tag of ["get", "put"]) {
        expect(lines(log, `ABORT ${tag}`)[0], tag).toContain("TimeoutError:");
        expect(beforeControl(log, tag), `${tag} ends in time`).toBe(true);
      }
      const replies = Object.fromEntries((await attack.reports()).map((r) => [r.tag, r.error]));
      expect(replies).toEqual({ load: "state operation timed out", save: "state operation timed out" });
      expect(await attack.logged("AUDIT wid marzi/loadState")).toEqual([" dispatched", " refused · timed out"]);
      expect(await attack.logged("AUDIT wid marzi/saveState")).toEqual([" dispatched", " refused · timed out"]);
    });

    test("a store's own result after the abort does not count", async ({ page }) => {
      const attack = await open(page, "store-abort-aware");
      await attack.untilLog('"tag":"load"');

      expect((await attack.reports())[0]).toEqual({ tag: "load", ok: false, error: "state operation timed out" });
      expect(await attack.logged("AUDIT wid marzi/loadState")).toEqual([" dispatched", " refused · timed out"]);
    });

    test("each call gets its own full deadline", async ({ page }) => {
      const attack = await open(page, "own-deadline");
      await attack.untilLog("PAST first");
      await attack.untilLog("PAST second");

      const log = await attack.log();
      // One timer that each call restarts would pass the lower bound below.
      for (const tag of ["first", "second"]) expect(beforeControl(log, tag), `${tag} ends in time`).toBe(true);
      const aborts = await attack.logged("ABORT ");
      expect(aborts.map((l) => l.split(" ")[0]), "the first call ends first").toEqual(["first", "second"]);
      for (const line of aborts) {
        expect(line, "the reason").toContain("TimeoutError:");
        // A shared deadline would end the second call about 200 ms too early.
        expect(after(line), line).toBeGreaterThanOrEqual(MS - EARLY);
      }
    });

    test("destroy stops the call once, and the deadline then has no effect", async ({ page }) => {
      const attack = await open(page, "destroy");
      await attack.untilLog("PAST-DEADLINE");

      const aborts = await attack.logged("ABORT doomed");
      expect(aborts, "one abort").toHaveLength(1);
      expect(aborts[0], "the reason").toContain(" AbortError:widget destroyed");
      expect(await attack.logged("AUDIT wid probe.hang")).toEqual([" dispatched", " refused · widget destroyed"]);
    });

    test("destroy stops every call of that widget, and no call of another", async ({ page }) => {
      const attack = await open(page, "isolation");
      await attack.untilLog("ABORT other");

      const log = await attack.log();
      for (const tag of ["doomed-1", "doomed-2"]) {
        const [line] = lines(log, `ABORT ${tag}`);
        expect(line, tag).toContain(" AbortError:widget destroyed");
        expect(log.indexOf(line!), `${tag} stops with its own destroy`).toBeLessThan(log.indexOf("DESTROYED doomed"));
      }
      // The other widget's call was still open, and that widget could still call,
      // after the first widget's destroy.
      expect(log.indexOf("OTHER-ALIVE")).toBeGreaterThan(log.indexOf("DESTROYED doomed"));
      expect(log.findIndex((l) => l.startsWith("ABORT other")), "the other call lives until its own destroy")
        .toBeGreaterThan(log.indexOf("OTHER-ALIVE"));
    });

    test("a widget destroyed in onAudit gives its handler an aborted signal", async ({ page }) => {
      const attack = await open(page, "audit-destroy");
      await attack.untilLog("refused · widget destroyed");

      const log = await attack.log();
      expect(lines(log, "START late")).toEqual(["START late aborted=true"]);
      expect(lines(log, "ABORT late")[0]).toContain(" AbortError:widget destroyed");
      expect(await attack.logged("AUDIT wid probe.hang")).toEqual([" dispatched", " refused · widget destroyed"]);
    });

    test("a widget destroyed in onAudit gives its store an aborted signal", async ({ page }) => {
      const attack = await open(page, "audit-destroy-state");
      await attack.untilLog("refused · widget destroyed");

      const log = await attack.log();
      expect(lines(log, "START get")).toEqual(["START get aborted=true"]);
      expect(lines(log, "ABORT get")[0]).toContain(" AbortError:widget destroyed");
      expect(await attack.logged("AUDIT wid marzi/loadState")).toEqual([" dispatched", " refused · widget destroyed"]);
    });
  });
}

test("deadlineSignal removes its timer and its listener", async ({ page }) => {
  const attack = await openAttack(page, "deadlines?probe=helper");
  await attack.untilLog("HELPER-DONE");
  const results = Object.assign({}, ...(await attack.logged("RESULT ")).map((l) => JSON.parse(l))) as Record<string, unknown>;

  // A parent that has ended: no timer starts, and no listener is added.
  expect(results["ended-parent"]).toEqual({ aborted: true, set: 0, live: 0, reached: 0 });
  // The parent ends first: the abort reaches the one listener, and no timer stays.
  expect(results["parent-first"]).toEqual({ set: 1, live: 0, reached: 1 });
  // The deadline comes first: a later abort of the parent reaches nothing.
  expect(results["deadline-first"]).toEqual({ name: "TimeoutError", afterLateAbort: "TimeoutError", set: 1, live: 0, reached: 0 });
  // 1000 calls, all past their deadlines: the parent holds no listener for them.
  expect(results["many"]).toEqual({ aborted: 1000, timedOut: 1000, set: 1000, live: 0, reached: 0 });
});

// This compares state and reasons, not the order of abort listeners. That order
// differs at the deadline: see "a handler's own result after the abort".
test("deadlineSignal gives the same state and reasons as the native functions", async ({ page }) => {
  const attack = await openAttack(page, "deadlines?probe=parity");
  await attack.untilLog("PARITY");
  const [line] = await attack.logged("PARITY ");
  const { mine, native } = JSON.parse(line!) as { mine: unknown; native: unknown };
  // Not an empty comparison: these are the results that both give.
  expect(mine).toMatchObject({
    endedParent: { aborted: true, sameReason: true, events: 0 },
    parentFirst: { before: false, atOnce: true, sameReason: true, events: 1, name: "AbortError" },
    noReason: { name: "AbortError" },
    deadlineFirst: { before: false, aborted: true, name: "TimeoutError", isDomException: true, code: 23, events: 1, sameAfterLateAbort: true },
    twoCalls: { shortName: "TimeoutError", longAlive: true, longSame: true, shortUnchanged: true },
  });
  test.skip(native === null, "this browser has no native functions to compare");
  expect(mine).toEqual(native);
});
