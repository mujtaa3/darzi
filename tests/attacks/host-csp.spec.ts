/**
 * The host page's CSP — what it takes from a widget (bugs.md B24, B41).
 *
 * A `srcdoc` frame inherits its parent's CSP, so the host's policy applies to
 * both of marzi's frames. Each row here is a claim in the README, "Your page's
 * CSP". The policy comes as a response header, as it does on a real host.
 */
import { test, expect } from "../harness/witness";
import { openAttack } from "../harness/attack";

const STYLED = "rgb(1, 2, 3)";

// These policies block inline script, so the widget's stub never runs.
const NO_START = [
  "script-src 'self'",
  "default-src 'self'",
  // A nonce or a hash makes the browser ignore 'unsafe-inline' in that directive.
  "script-src 'self' 'nonce-t1' 'unsafe-inline'",
  "script-src 'self' 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' 'unsafe-inline'",
];
// These policies let the widget start, and take one thing from it.
const STARTS: Array<[string, { color?: string; notColor?: string; image: string }]> = [
  // Control: with no limit, the widget has all three.
  ["script-src 'self' 'unsafe-inline'", { color: STYLED, image: "loaded" }],
  ["script-src 'self' 'unsafe-inline'; style-src 'self'", { notColor: STYLED, image: "loaded" }],
  ["script-src 'self' 'unsafe-inline'; img-src 'self'", { color: STYLED, image: "failed" }],
];

async function openUnder(page: import("@playwright/test").Page, policy: string) {
  await page.route("**/tests/pages/host-csp.html", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": policy } });
  });
  const attack = await openAttack(page, "host-csp");
  // Control: the policy lets the host's own script run.
  await attack.untilLog("PAGE-RAN");
  return attack;
}

test("require-trusted-types-for: render throws, and leaves nothing behind", async ({ page }) => {
  const attack = await openUnder(page, "require-trusted-types-for 'script'");
  await attack.untilLog("THROW TypeError");
  await attack.untilLog("PAST-START-TIMEOUT");
  expect(await attack.logged("FAULT "), "no false never-started").toEqual([]);
  await expect(page.locator("iframe"), "no frame").toHaveCount(0);
});

for (const policy of NO_START) {
  test(`${policy}: no widget starts, and the host hears why`, async ({ page }) => {
    const attack = await openUnder(page, policy);
    await attack.untilLog("FAULT w never-started");
    expect(await attack.reports(), "no script of the widget ran").toEqual([]);
    expect(await attack.logged("INJECTED "), "the page keeps its defence against XSS").toEqual(["blocked"]);
  });
}

for (const [policy, want] of STARTS) {
  test(`${policy}: the widget starts, with the limit that the README states`, async ({ page }) => {
    const attack = await openUnder(page, policy);
    await attack.untilLog("REPORT ");
    const [seen] = await attack.reports();
    expect(seen?.image, "the data: image").toBe(want.image);
    if (want.color) expect(seen?.color, "the widget's style").toBe(want.color);
    if (want.notColor) expect(seen?.color, "the widget's style").not.toBe(want.notColor);
    expect(await attack.logged("FAULT "), "faults").toEqual([]);
    // The cost that the README states: the page that lets a widget start has lost this.
    expect(await attack.logged("INJECTED "), "a script that an XSS bug injected").toEqual(["ran"]);
  });
}
