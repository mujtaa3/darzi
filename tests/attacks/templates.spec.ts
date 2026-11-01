/**
 * The templates — the part that goes to the model (bugs.md B76).
 *
 * Each template opens with text for the app developer. QUICKSTART.md tells a host to
 * send only the text after the `---` line. No browser is needed, so this runs once,
 * in the first project.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../../prompts/${name}`, import.meta.url)), "utf8");

test.beforeEach(({}, info) => test.skip(info.project.name !== "chrome", "this needs no browser, so it runs once"));

for (const name of ["widget-author.md", "widget-refine.md", "widget-repair.md"]) {
  test(`${name}: the split in QUICKSTART.md gives only the text for the model`, () => {
    const parts = read(name).split("\n---\n");
    expect(parts, "one --- line").toHaveLength(2);
    expect(parts[0], "the header is for the host").toContain("{{CAPABILITIES}}");
    expect(parts[1]!.trim(), "the model's text").toMatch(/^You are /);
  });
}
