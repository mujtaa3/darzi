/**
 * Capability results must be able to cross the port (Codex N8).
 *
 * A handler returning something structured clone can't copy — a function, a
 * fetch Response — used to make postMessage throw outside the error path: no
 * audit outcome, no reply, and the widget hung until the stub's 60 s backstop.
 * It must now fail fast, audited, with a plain message.
 */
import { test, expect } from "../harness/witness";
import { openAttack } from "../harness/attack";

test("an unsendable capability result fails fast and is audited", async ({ page }) => {
  const attack = await openAttack(page, "results");
  // The widget reports only once all three calls settle; before the fix two of
  // them waited 60 s, so this wait alone would time out.
  await attack.untilLog("REPORT", 10_000);

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
});
