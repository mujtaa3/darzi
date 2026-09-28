/**
 * The screen — render refuses a body that contains a listed sequence.
 *
 * This checks the screen does what it says: refuse loudly, before any DOM
 * work, with an audit entry; let clean bodies through; honour a host's own
 * list exactly. It does NOT and cannot show the channel is closed — the
 * screen only sees the body at render time. webrtc.spec.ts measures the
 * channel itself, with the screen off.
 */
import { test, expect } from "../harness/witness";
import { openAttack } from "../harness/attack";

test("render refuses a screened body and lets a clean one through", async ({ page }) => {
  const attack = await openAttack(page, "screen");
  await attack.untilLog("DONE");
  await attack.untilLog('"tag":"clean"'); // the control's call reached the switchboard

  const [defaults] = await attack.logged("DEFAULT ");
  expect(JSON.parse(defaults!)).toContain("RTCPeerConnection");

  const thrown = await attack.logged("THROW ");
  const rendered = await attack.logged("RENDERED ");
  const audits = await attack.logged("AUDIT ");

  // Default list: refused, explained, audited, and no frame left behind.
  const hit = thrown.find((t) => t.startsWith("default-hit"));
  expect(hit).toContain('widget refused by screen: body contains "RTCPeerConnection"');
  expect(hit).toContain("not a containment control");
  expect(hit).toMatch(/frames\+0$/);
  expect(audits).toContain('(screen) refused · body contains "RTCPeerConnection"');

  // Control: a clean body renders.
  expect(rendered).toContain("default-clean");

  // A host list replaces the default exactly; [] disables it.
  expect(thrown.find((t) => t.startsWith("custom-hit"))).toContain('"forbidden-word"');
  expect(rendered).toContain("custom-without-default");
  expect(rendered).toContain("off");

  // Misconfiguration fails at setup, not by refusing everything later.
  expect(await attack.logged("SETUP ")).toEqual(["screen entries must be non-empty strings"]);
});
