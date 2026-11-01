/**
 * Getting the HTML — the README's steps, as a host follows them (pre-publish
 * review SF-9, bugs.md B62).
 *
 * A template's reply has four blocks, and only the text of `<widget>` is widget
 * HTML. The control gives the whole reply to `render`, as the README once said to.
 */
import { test, expect } from "../harness/witness";
import { openAttack } from "../harness/attack";

type Seen = { closing?: string; text: string; libs: string };

async function seen(page: import("@playwright/test").Page, scenario: string): Promise<Seen> {
  const attack = await openAttack(page, `getting-html?reply=${scenario}`);
  await attack.untilLog("REPORT ");
  return (await attack.reports())[0] as Seen;
}

test("the split gives a widget with no stray text, and the libraries that it names", async ({ page }) => {
  const widget = await seen(page, "libs");
  expect(widget.text, "the widget's own text").toContain("real widget");
  expect(widget.text, "the other blocks are not in the widget").not.toContain("declared.capability");
  expect(widget.text, "the other blocks are not in the widget").not.toContain("A short name");
  // The code runs to its end, past the closing tag in its string.
  expect(widget.closing).toBe("</widget>");
  // A space after the comma is fine, and a library that `libs` does not name stays out.
  expect(widget.libs).toBe("number,number,undefined");
});

test("an empty <libs> block gives no libraries", async ({ page }) => {
  const attack = await openAttack(page, "getting-html?reply=no-libs");
  await attack.untilLog("REPORT ");
  expect(await attack.logged("LIBS ")).toEqual(["[]"]);
  expect((await attack.reports())[0]?.["libs"]).toBe("undefined,undefined,undefined");
});

test("a reply that stops inside <widget> is refused before render", async ({ page }) => {
  const attack = await openAttack(page, "getting-html?reply=cut");
  await attack.untilLog("THROW ");
  expect(await attack.logged("THROW ")).toEqual(["the reply has no <widget> block"]);
});

test("control: the whole reply given to render shows the blocks, and has no library", async ({ page }) => {
  const widget = await seen(page, "whole");
  expect(widget.text).toContain("declared.capability");
  expect(widget.libs).toBe("undefined,undefined,undefined");
});
