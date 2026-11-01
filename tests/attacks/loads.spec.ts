/**
 * Loads — each other kind of request that a widget can start (bugs.md B21, B22).
 *
 * connectivity.spec.ts has the ten basic probes. Here are resource hints, CSS,
 * SVG, media, scripted requests, nested documents and workers. The same function
 * runs in the widget and in a free control frame, and the witness counts what
 * arrives. The widget's opinion of what happened is not evidence.
 *
 * A probe proves nothing in an engine where its control sends nothing, so
 * SILENT_CONTROLS lists those. A nested document's script also reports that it
 * ran. So for that probe, "nothing arrived" cannot mean "nothing tried".
 */
import { test, expect } from "../harness/witness";
import { openAttack, settle } from "../harness/attack";

// One per probe in tests/pages/loads.html.
const PROBES = ["prefetch", "preload", "modulepreload", "css-import", "css-url", "svg-image", "video", "embed", "eventsource",
  "import", "ping", "fetchlater", "nested-blank", "nested-srcdoc", "nested-data", "nested-blob", "worker-blob", "worker-data"];

// TESTED 2026-10-31. These controls send nothing in this engine. Firefox's
// prefetch is an idle-time hint: it arrived in one run of three, so it cannot be
// required.
const SILENT_CONTROLS: Record<string, string[]> = {
  chrome: [],
  webkit: ["prefetch", "fetchlater"],
  firefox: ["prefetch", "ping", "fetchlater"],
};

test("no other kind of load from a widget reaches the witness", async ({ page, witness }, info) => {
  witness.reset();
  const attack = await openAttack(page, "loads");

  // Each control that can arrive must arrive first: that proves the probe fires.
  const silent = SILENT_CONTROLS[info.project.name]!;
  const required = PROBES.filter((p) => !silent.includes(p)).map((p) => `control-${p}`);
  await expect.poll(() => witness.arrived("control-"), { timeout: 15_000 }).toEqual(expect.arrayContaining(required));
  await attack.untilLog("widget-done");
  await settle(page);

  expect(witness.arrived("widget-"), "widget requests that arrived").toEqual([]);
  // A nested srcdoc document runs its script in the widget, in each engine, and
  // the inherited CSP still stops its request.
  expect(await attack.logged("WIDGET-NESTED-RAN "), "nested scripts that ran in the widget").toContain("nested-srcdoc");
});

test("WebTransport from a widget sends nothing", async ({ page, witness }, info) => {
  // The widget runs first. A control's QUIC retransmits go on after its page has
  // gone, and they would count against the widget (tested).
  witness.reset();
  const widget = await openAttack(page, "webtransport?mode=widget");
  await widget.untilLog("REPORT ");
  await settle(page, 1_500);
  expect(witness.udp(), "datagrams from the widget").toBe(0);

  // Control: a frame with no CSP reaches the same witness.
  const control = await openAttack(page, "webtransport?mode=control");
  await control.untilLog("REPORT ");
  console.log(`[${info.project.name}] webtransport control: ${JSON.stringify((await control.reports())[0])}`);

  // TESTED 2026-11-01, on GitHub's Ubuntu runner: the control sends nothing in WebKit
  // on Linux, so the widget's zero proves nothing there. This pin shows any change.
  if (info.project.name === "webkit" && process.platform === "linux") {
    await settle(page, 1_500);
    expect(witness.udp(), "control datagrams").toBe(0);
    return;
  }
  await expect.poll(() => witness.udp(), { timeout: 5_000, message: "control datagrams" }).toBeGreaterThan(0);
});
