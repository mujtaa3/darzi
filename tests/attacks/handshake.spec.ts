/**
 * Handshake — identity is the port, never a field (rung 2).
 *
 * A sibling frame that shouts the knock must never receive a port; a widget
 * that stamps someone else's id on a message is still itself in the audit.
 */
import { test, expect } from "../harness/witness";
import { openAttack, settle } from "../harness/attack";

test("only the widget's own frame gets a port, and it cannot rename itself", async ({ page }) => {
  const attack = await openAttack(page, "handshake");
  await attack.untilLog("SIBLING knocked-twice");
  await attack.untilCount("REPORT", 2); // honest, then forged
  await settle(page);

  const [rendered] = await attack.logged("RENDERED ");
  const audits = (await attack.logged("AUDIT ")).map((l) => l.split(" "));

  // Every audited call — including the one carrying widgetId "someone-else"
  // — is attributed to the port it arrived on.
  expect(audits.length).toBeGreaterThanOrEqual(2);
  for (const [who, method, decision] of audits) {
    expect(who, `audit for ${method}`).toBe(rendered);
    expect(decision).toBe("dispatched");
  }
  expect(await attack.reports()).toEqual([{ at: "honest" }, { at: "forged" }]);

  // The sibling knocked and got nothing.
  const sibling = await attack.logged("SIBLING ");
  expect(sibling).toContain("knocked-twice");
  expect(sibling).not.toContain("got-a-port");
});
