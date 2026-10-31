/**
 * The base URL — what a widget's relative links resolve against, and one more
 * way to read a URL (pre-publish review SS-1, SF-8).
 *
 * A `srcdoc` document has no URL of its own, so it takes its base URL from its
 * parent. Two `srcdoc` frames deep, that is still the host page's URL, with its
 * query and fragment, and a URL can hold a token. `top.location` throws, but
 * `document.baseURI` does not. The `<base>` in the warden breaks this chain, in
 * a document that the widget cannot change.
 *
 * The same base URL decides where `<a href="#sec">` goes. Against the host URL,
 * the click is a real navigation, which the warden blocks. Chrome then replaces
 * the widget's document, with no fault.
 *
 * A host CSP with `base-uri` also applies in the warden, so it can block the
 * `<base>`. `render` finds this with a hidden frame, and refuses the widget.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../harness/witness";
import { openAttack } from "../harness/attack";

interface Reads {
  baseURI: string;
  link: string;
  newDocument: string;
  parsedDocument: string;
}

/** Open the page at a URL that holds tokens, and collect what the widgets read. */
async function readBase(page: Page) {
  const attack = await openAttack(page, "base?token=SECRET-IN-QUERY#SECRET-IN-FRAGMENT");
  await attack.untilLog('"reads"');
  await attack.untilLog('"moduleUrl"');
  await attack.untilLog("CONTROL baseURI=");

  // Control: the URL holds both tokens, and a srcdoc document gets them.
  const control = (await attack.logged("CONTROL baseURI="))[0]!;
  expect(control).toContain("SECRET-IN-QUERY");
  expect(control).toContain("SECRET-IN-FRAGMENT");

  const reports = await attack.reports();
  const reads = reports.find((r) => r.reads)!.reads as Reads;
  const moduleUrl = reports.find((r) => r.moduleUrl)!.moduleUrl as string;
  console.log(`[${test.info().project.name}] ${JSON.stringify({ ...reads, moduleUrl })}`);
  return { attack, reads, moduleUrl };
}

test("a widget's base URL is not the host URL", async ({ page }) => {
  const { reads, moduleUrl } = await readBase(page);
  expect(reads.baseURI).toBe("about:srcdoc");
  expect(reads.link).toBe("about:srcdoc#sec");
  expect(moduleUrl).toBe("about:srcdoc");
  // The documents that a widget makes for itself do not lead back to the host URL.
  expect(reads.newDocument).toMatch(/^about:(blank|srcdoc)$/);
  expect(reads.parsedDocument).toBe("about:srcdoc");
});

test("an in-page link keeps the widget alive, with no fault", async ({ page }) => {
  const { attack } = await readBase(page);
  await attack.untilLog('"alive"');
  const alive = (await attack.reports()).find((r) => r.alive)!.alive as string;
  expect(alive).toBe("about:srcdoc#sec");
  expect(await attack.logged("FAULT ")).toEqual([]);
});

// The policy comes as a response header, as it does on a real host.
for (const [policy, allowed] of [
  ["base-uri 'none'", false],
  ["base-uri 'self'", false],
  ["base-uri 'self' about:", true],
  ["base-uri about:", true],
] as const) {
  test(`host CSP ${policy}: render ${allowed ? "works" : "refuses"}`, async ({ page }) => {
    await page.route("**/tests/pages/base.html*", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": policy } });
    });
    if (allowed) {
      const { reads } = await readBase(page);
      expect(reads.baseURI).toBe("about:srcdoc");
      return;
    }
    const attack = await openAttack(page, "base?token=SECRET-IN-QUERY#SECRET-IN-FRAGMENT");
    await attack.untilCount("REFUSED ", 2);
    expect((await attack.logged("REFUSED "))[0]).toContain("base-uri");
    expect((await attack.logged("AUDIT "))[0]).toContain("(host CSP)");
    // Nothing stays on the page: no widget frame, and not the check's own frame.
    expect(await page.locator("#slot iframe").count()).toBe(0);
    expect(await page.locator("html > iframe").count()).toBe(0);
    expect(await attack.reports()).toEqual([]);
  });
}
