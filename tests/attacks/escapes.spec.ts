/**
 * Escapes — what the sandbox takes away, apart from the frame itself (bugs.md B23).
 *
 * The widget's sandbox has only `allow-scripts`. So a widget must not open a
 * window, navigate the host, the warden or another widget, start a download, or
 * show a dialog. navigation.spec.ts covers a frame that navigates itself, which
 * only the warden stops.
 *
 * Each move has a control: the same move, from a frame with no sandbox and no CSP.
 * It gets its own page, because some moves replace the page. All these controls
 * fire in all three engines (tested 2026-10-31), so the widget's zero means
 * something. The witness counts what arrives, and Playwright sees each popup,
 * download and dialog from outside the page.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../harness/witness";
import { openAttack, settle } from "../harness/attack";

// One per move in tests/pages/escapes.html, apart from `meta-static`.
const MOVES = ["window-open", "anchor-blank", "anchor-top", "anchor-parent", "top-assign", "top-replace", "parent-assign",
  "parent-replace", "victim-frame", "victim-inner", "nested-self", "nested-parent", "download", "alert", "confirm"];
const NAVIGATIONS = MOVES.filter((m) => !["download", "alert", "confirm"].includes(m));

function watchPage(page: Page) {
  const seen = { dialogs: [] as string[], downloads: [] as string[], popups: [] as string[] };
  page.on("dialog", (d) => { seen.dialogs.push(d.message()); void d.dismiss(); });
  page.on("download", (d) => seen.downloads.push(d.suggestedFilename()));
  page.on("popup", (p) => seen.popups.push(p.url()));
  return seen;
}

test("a widget cannot open or navigate another document, download, or show a dialog", async ({ page, witness }) => {
  const seen = watchPage(page);
  witness.reset();
  const attack = await openAttack(page, "escapes");

  // Each move has started. The widget with the static meta refresh may not report:
  // in Chrome, its blocked refresh replaces its document at once.
  await attack.untilCount("start:", MOVES.length);
  // The victim comes after all the moves, so it has outlived them.
  await attack.untilLog("victim-alive");
  await settle(page, 1_200);

  expect(witness.arrived("widget-"), "widget navigations that arrived").toEqual([]);
  expect(seen.popups, "popups").toEqual([]);
  expect(seen.downloads, "downloads").toEqual([]);
  expect(seen.dialogs, "dialogs").toEqual([]);
  expect(await page.title(), "the host page is still there").toBe("escapes");
  expect(await attack.logged("FAULT "), "faults").toEqual([]);
  // A move on another document throws, because the widget's origin is opaque.
  const threw = await attack.logged("threw:");
  for (const move of ["top-assign", "top-replace", "parent-assign", "parent-replace", "victim-frame", "victim-inner"]) {
    expect(threw, move).toContain(`${move}:SecurityError`);
  }
});

const openControl = (page: Page, move: string) =>
  page.goto(`/tests/pages/escapes.html?control=${move}`, { waitUntil: "commit" });

for (const move of [...NAVIGATIONS, "meta-static"]) {
  test(`control: a free frame can reach the witness with ${move}`, async ({ page, witness }) => {
    witness.reset();
    await openControl(page, move);
    await expect.poll(() => witness.arrived("control-"), { timeout: 10_000 }).toEqual([`control-${move}`]);
  });
}

test("control: a free frame can start a download", async ({ page }) => {
  const seen = watchPage(page);
  await openControl(page, "download");
  await expect.poll(() => seen.downloads, { timeout: 10_000 }).toEqual(["control.txt"]);
});

for (const move of ["alert", "confirm"]) {
  test(`control: a free frame can show ${move}`, async ({ page }) => {
    const seen = watchPage(page);
    await openControl(page, move);
    await expect.poll(() => seen.dialogs, { timeout: 10_000 }).toEqual(["control"]);
  });
}
