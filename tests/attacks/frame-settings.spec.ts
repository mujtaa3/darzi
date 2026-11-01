/**
 * Frame settings — the two smaller settings on both of marzi's frames (bugs.md B24).
 *
 * `allow=""` gives a frame no device features, so a widget cannot show a browser's
 * permission prompt that seems to come from the host. `referrerpolicy="no-referrer"`
 * keeps the host's URL out of a request's `Referer` header.
 *
 * The attributes are checked on the frames themselves. The inner frame's tag is in
 * the text that the host wrote. The behaviour is checked with a control: a frame
 * with no sandbox, that the host lets use the feature.
 */
import { test, expect } from "../harness/witness";
import { openAttack } from "../harness/attack";

test.use({ permissions: ["geolocation"], geolocation: { latitude: 1, longitude: 2 } });

const SETTINGS = { allow: "", referrerpolicy: "no-referrer", sandbox: "allow-scripts" };

test("a widget's frames have no device features, and show no referrer", async ({ page }, info) => {
  const attack = await openAttack(page, "frame-settings");
  await attack.untilLog("WIDGET ");
  await attack.untilLog("CONTROL ");

  const [attrs] = await attack.logged("ATTRS ");
  expect(JSON.parse(attrs!)).toEqual({ outer: SETTINGS, inner: SETTINGS });

  type Seen = { referrer: string; geolocation: string; compiled: unknown };
  const widget = JSON.parse((await attack.logged("WIDGET "))[0]!) as Seen;
  const control = JSON.parse((await attack.logged("CONTROL "))[0]!) as Seen;
  // Control: the browser gives a location to a frame that may have one.
  expect(control.geolocation, "the control's location").toBe("allowed");
  // Code 1 is PERMISSION_DENIED.
  expect(widget.geolocation, "the widget's location").toBe("refused 1");

  // The widget's CSP has no 'unsafe-eval' or 'wasm-unsafe-eval'. The README and the
  // templates say so, because a vendored library may need them.
  expect(control.compiled, "the control compiles").toEqual({ eval: "2", fn: "2", wasm: "compiled" });
  expect(widget.compiled, "the widget does not").toEqual({ eval: "EvalError", fn: "EvalError", wasm: "CompileError" });

  // TESTED 2026-10-31: Firefox gives any srcdoc frame an empty referrer, so there
  // only the attribute check above means something.
  if (info.project.name !== "firefox") expect(control.referrer, "the control's referrer").toContain("127.0.0.1:8009");
  expect(widget.referrer, "the widget's referrer").toBe("");
});
