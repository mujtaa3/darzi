/**
 * Capability results must be able to cross the port (Codex N8), and a call
 * that fails must say so in the audit (Codex N4).
 *
 * A handler returning something structured clone can't copy — a function, a
 * fetch Response — used to make postMessage throw outside the error path: no
 * audit outcome, no reply, and the widget hung until the stub's 60 s backstop.
 * It must now fail fast, audited, with a plain message.
 *
 * A handler or store that throws used to leave only "dispatched" in the audit,
 * so a host could not tell its own failure from a widget bug. It must now be
 * audited as refused, before the widget hears about it — and the widget still
 * gets generic text, never the real error.
 */
import { test, expect } from "../harness/witness";
import { openAttack } from "../harness/attack";

test("a failed or unsendable call fails fast, tells the widget nothing internal, and is audited", async ({ page }) => {
  const attack = await openAttack(page, "results");
  // The widget reports only once all its calls settle; before the fix two of
  // them waited 60 s, so this wait alone would time out.
  await attack.untilLog("REPORT", 10_000);
  await attack.untilLog('"widgetId":"unhandled"');

  const [report] = await attack.reports();
  const results = (report as { results: Array<Record<string, unknown>> }).results;
  const by = Object.fromEntries(results.map((r) => [r.name, r]));

  // Control: plain data arrives intact.
  expect(by["probe.plain"]).toMatchObject({ ok: true, value: { rows: [1, 2, 3] } });

  // Both unsendable results reject promptly, with a plain message.
  for (const name of ["probe.callback", "probe.response"]) {
    expect(by[name], name).toMatchObject({ ok: false, error: "capability returned a value that can't be sent to a widget" });
    expect(Number(by[name]?.ms), `${name} settled in ms`).toBeLessThan(2_000);
  }

  // And the audit records the refusal instead of stopping at "dispatched".
  const audits = await attack.logged("AUDIT ");
  expect(audits).toContain("probe.callback refused · result not cloneable");
  expect(audits).toContain("probe.response refused · result not cloneable");

  // A handler that throws, and a store that throws: generic text for the
  // widget, a failure in the audit, and the real message nowhere in the page.
  expect(by["probe.boom"]).toMatchObject({ ok: false, error: "capability failed" });
  expect(by["marzi/loadState"]).toMatchObject({ ok: false, error: "state operation failed" });
  expect(audits).toContain("probe.boom refused · capability failed");
  expect(audits).toContain("marzi/loadState refused · state operation failed");
  expect((await attack.log()).filter((l) => l.includes("SECRET"))).toEqual([]);

  // Left unhandled, the failure becomes the widget's fault — and the host has
  // already audited it, so an app can see the failure was its own.
  const order = (await attack.logged("ORDER ")).filter((l) => l.includes(" unhandled"));
  expect(order).toEqual([
    "audit unhandled probe.boom dispatched",
    "audit unhandled probe.boom refused",
    "fault unhandled",
  ]);
  const [fault] = (await attack.logged("FAULT ")).map((l) => JSON.parse(l) as { message: string });
  expect(fault!.message).toBe("unhandled rejection: capability failed");
});
