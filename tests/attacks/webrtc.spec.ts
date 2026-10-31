/**
 * WebRTC — the network path CSP's fetch directives never covered.
 *
 * The jail's policy carries `webrtc 'block'`. Whether an engine honours it is
 * a measured fact, not a claim: the witness listens on UDP 3478, a control
 * frame proves STUN traffic reaches it, then a real widget tries the same.
 *
 * EXPECTED encodes what we have measured per engine. "measure" records and
 * asserts nothing about the widget (first run); "blocked" requires zero
 * datagrams; "leaks" documents a residual — and fails if the engine ever
 * starts blocking, because that is news the threat model must hear.
 *
 * The one control that a host can set is a response header, in Chrome only:
 * webrtc-header.spec.ts.
 */
import { test, expect } from "../harness/witness";
import { openAttack } from "../harness/attack";

// Measured 2026-09-27, stable across repeated runs: in every engine the
// widget's datagram count equals the no-CSP control's. The directive stops
// nothing anywhere we test (Chrome logs it as unrecognized). This is a
// DOCUMENTED RESIDUAL, pinned so that an engine that starts honouring the
// directive turns this red and the threat model gets updated.
const EXPECTED: Record<string, "blocked" | "leaks" | "measure"> = {
  chrome: "leaks",
  webkit: "leaks",
  firefox: "leaks",
};

test("webrtc 'block' — measured against a UDP witness", async ({ page, witness }, info) => {
  // Control first: a frame with no CSP at all must reach the witness, or the
  // witness is inconclusive and nothing below means anything.
  witness.reset();
  let attack = await openAttack(page, "webrtc?mode=control");
  await attack.untilLog('"tag":"control"');
  const [control] = await attack.reports();
  await expect
    .poll(() => witness.udp(), { timeout: 5_000, message: `witness inconclusive — control frame sent nothing: ${JSON.stringify(control)}` })
    .toBeGreaterThan(0);
  const controlUdp = witness.udp();

  // Tear the control down BEFORE resetting, so none of its retransmits can be
  // counted as the widget's.
  await page.goto("about:blank");
  await page.waitForTimeout(800);

  // Then the widget, on a fresh page load, from zero.
  witness.reset();
  attack = await openAttack(page, "webrtc?mode=widget");
  await attack.untilLog('"tag":"widget"');
  await page.waitForTimeout(800); // retransmits, if any, arrive within this
  const [widget] = await attack.reports();
  const widgetUdp = witness.udp();

  const summary = `control: udp=${controlUdp} ${JSON.stringify(control)} | widget: udp=${widgetUdp} ${JSON.stringify(widget)}`;
  info.annotations.push({ type: "webrtc", description: summary });
  console.log(`[${info.project.name}] ${summary}`);

  // Structural: the widget document really carries the directive. Without
  // this, deleting it from WIDGET_CSP would leave a "leaks" pin green.
  expect(String(widget?.policy), "widget CSP").toContain("webrtc 'block'");
  // And the widget really tried: a probe that never constructed a peer
  // connection would make "0 datagrams" meaningless.
  expect(widget?.constructed, "widget constructed an RTCPeerConnection").toBe(true);

  const expected = EXPECTED[info.project.name];
  expect(expected, `a pinned expectation for ${info.project.name}`).toMatch(/^(blocked|leaks)$/);
  if (expected === "blocked") expect(widgetUdp, "datagrams from a widget").toBe(0);
  if (expected === "leaks") expect(widgetUdp, "documented residual: engine does not honour webrtc 'block'").toBeGreaterThan(0);
});
