/**
 * Reconnect — a moved widget frame connects again (adversarial review C06).
 *
 * The handshake listener stays installed for the widget's life. When the host
 * moves widget.frame, the browser reloads it and makes a new inner window. The
 * runtime sees "ready" from a window that it has not connected, and opens a
 * new channel to it.
 *
 * The same happens after an in-place reload (`location.reload()`), which
 * keeps the inner window. Two guards keep this safe, and each has its own
 * test here:
 *   - a flood of "ready" messages opens at most the budgeted number of
 *     channels (the same limit as calls, counted apart from them);
 *   - a reply to a call from before the move never reaches the new document,
 *     even when both loads use the same call id.
 *
 * The widget's window messages ("LOADED", "PORTS", "RESULT") do not use the
 * channel, so they show what the widget did even when the channel is dead.
 */
import { test, expect } from "../harness/witness";
import { openAttack } from "../harness/attack";

type Hooks = { __move: () => void; __resolve: (n: number, v: string) => void };

test("a moved widget frame reconnects and keeps calling the host", async ({ page }) => {
  const attack = await openAttack(page, "reconnect");

  // Before the move: the widget loads and its first call reaches the host.
  await attack.untilCount("LOADED ", 1);
  await attack.untilCount("CALL ", 1);

  // Move the frame to another container; the browser reloads it.
  await page.evaluate(() => (window as unknown as Hooks).__move());

  // The reload runs the widget again, and its call reaches the host again.
  await attack.untilCount("LOADED ", 2, 15_000);
  await attack.untilCount("CALL ", 2, 15_000);

  const log = await attack.log();
  // The second load and the second call both come after the move.
  const moved = log.indexOf("MOVED");
  expect(moved, "MOVED before LOADED 2").toBeLessThan(log.indexOf("LOADED 2"));
  expect(moved, "MOVED before CALL 2").toBeLessThan(log.findIndex((l) => l.startsWith("CALL 2")));
  // Both calls are recorded under the same widget id.
  expect(log.filter((l) => l.startsWith("AUDIT ")), "audits").toEqual([
    "AUDIT mover probe.report dispatched",
    "AUDIT mover probe.report dispatched",
  ]);
  // The reconnect makes no fault.
  expect(log.filter((l) => l.startsWith("FAULT ")), "faults").toEqual([]);
});

test("a widget that reloads itself in place reconnects", async ({ page }) => {
  const attack = await openAttack(page, "reconnect?mode=reload");

  // The first load calls the host, then reloads itself.
  await attack.untilCount("CALL ", 1);
  // The reload runs the widget again, and its call reaches the host again.
  await attack.untilCount("LOADED ", 2, 15_000);
  await attack.untilCount("CALL ", 2, 15_000);

  const log = await attack.log();
  // The second call comes from the reloaded document (window.name is "r").
  expect(log.find((l) => l.startsWith("CALL 2")), "second call").toContain('"name":"r"');
  expect(log.filter((l) => l.startsWith("FAULT ")), "faults").toEqual([]);
});

test("a flood of ready messages opens at most the budgeted number of channels", async ({ page }) => {
  const attack = await openAttack(page, "reconnect?mode=flood");

  await attack.untilLog('"at":"first"');
  // The host answers the sync only after it has handled the 1000 "ready" messages.
  await attack.untilLog("SYNC");
  await attack.untilCount("PORTS ", 1);

  // The budget is the call limit, 120 in each 10 s window (the default). The
  // first "ready" uses one, so 119 of the 1000 open a channel: 120 ports in
  // all. Without the budget, all 1001 would.
  expect(await attack.logged("PORTS "), "ports that reached the widget").toEqual(["120"]);
  expect((await attack.log()).filter((l) => l.startsWith("FAULT ")), "faults").toEqual([]);
});

test("a reply to a call from before the move never reaches the moved widget", async ({ page }) => {
  const attack = await openAttack(page, "reconnect?mode=stale");

  // The first load starts its slow call (id 1), then the host moves the frame.
  await attack.untilLog("SLOW 1");
  await page.evaluate(() => (window as unknown as Hooks).__move());
  // The second load starts its own slow call, also id 1.
  await attack.untilCount("LOADED ", 2, 15_000);
  await attack.untilLog("SLOW 2");

  // Resolve the old call first, then the new one.
  await page.evaluate(() => (window as unknown as Hooks).__resolve(1, "STALE"));
  await attack.untilLog("RESOLVED 1");
  await page.evaluate(() => (window as unknown as Hooks).__resolve(2, "FRESH"));
  await attack.untilCount("RESULT ", 1);

  // The moved widget gets only its own result.
  expect(await attack.logged("RESULT "), "results that reached the moved widget").toEqual(["FRESH"]);
});
