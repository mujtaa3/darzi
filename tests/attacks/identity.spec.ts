/**
 * Identity — what the sandbox takes away (rung 1).
 *
 * A widget must not reach the host document, the host URL, cookies or
 * storage. Engines refuse differently: Chrome throws on `document.cookie`
 * in an opaque origin, Safari hands back an empty string. Both are refusals;
 * a leak would be a non-empty value.
 */
import { test, expect } from "../harness/witness";
import { openAttack } from "../harness/attack";

test("a widget cannot see the host page, its cookies, or storage", async ({ page }) => {
  const attack = await openAttack(page, "identity");
  await attack.untilLog("widget-done");
  await attack.untilLog("CONTROL cookie=");

  const rows = Object.fromEntries((await attack.reports()).map((r) => [r.api, r]));

  // The one row that must SUCCEED: proves the probe can report "allowed" at
  // all, and asserts the mechanism directly — the widget's origin is opaque.
  expect(rows["self.origin"], "self.origin").toMatchObject({ verdict: "allowed", detail: "null" });

  // Host DOM and URL: must throw everywhere.
  expect(rows["parent.document"]?.verdict, "parent.document").toBe("blocked");
  expect(rows["top.location.href"]?.verdict, "top.location.href").toBe("blocked");

  // Cookies and storage: a throw or an empty result are both refusals.
  for (const api of ["document.cookie", "localStorage", "sessionStorage"]) {
    const r = rows[api]!;
    const refused = r.verdict === "blocked" || r.detail === "(empty string)" || r.detail === "null";
    expect(refused, `${api} → ${r.verdict} ${r.detail}`).toBe(true);
  }

  // Control: the same reads from an unsandboxed frame work, so the refusals
  // above are the sandbox's doing and not a broken page.
  const control = await attack.logged("CONTROL ");
  expect(control).toContain("parent.document=identity");
  expect(control.some((c) => c.startsWith("cookie=") && c.includes("ctl=1")), "control frame reads its cookie").toBe(true);
});
