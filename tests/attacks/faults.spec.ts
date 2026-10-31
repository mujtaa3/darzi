/**
 * The fault channel — what a widget may tell the host about its own crash.
 *
 * A fault is widget-authored: its text, its error name and the line it names
 * are all claims. The runtime clamps the text, rebuilds only the fields it
 * knows, and translates the frame's line number into a line of the widget's
 * own HTML — or drops it when the position lies outside that HTML. A fault
 * queued behind the call that destroys its widget must never arrive. Faults
 * count against the same rate limit as every other message.
 *
 * Not a containment control: a widget can stay silent or lie. What is under
 * test is that nothing a widget says here reaches the host unchecked.
 *
 * MEASURED 2026-10-24: WebKit hides the details of an error thrown by a script
 * in this document from the document's own listeners — "Script error.", no
 * error object, no line. WebKit shows details only when the document's origin
 * may request the script's URL; an inline script's URL is about:srcdoc, and the
 * sandboxed frame's opaque origin may request nothing. Rejected promises keep
 * their details. Pinned below, so a change in WebKit is noticed.
 */
import { test, expect } from "../harness/witness";
import { openAttack, settle } from "../harness/attack";

interface Fault {
  widgetId: string;
  kind: string;
  message: string;
  name?: string;
  line?: number;
  column?: number;
}

const FIELDS = ["widgetId", "kind", "message", "name", "line", "column"];
const MUTED = { kind: "script-error", message: "Script error." };

test("faults arrive clamped, positioned in the widget's own lines, and never after destroy", async ({ page }) => {
  const attack = await openAttack(page, "faults");
  const muted = test.info().project.name === "webkit";

  // Each widget's last expected sign of life, then a settle for anything in flight.
  for (const id of ["typeerror", "rejection", "oversize", "syntax", "click", "library", "library-caller", "after-destroy-control"]) {
    await attack.untilLog(`"widgetId":"${id}"`);
  }
  await attack.untilLog("forged-extra");
  await attack.untilLog("flood (rate limit) refused");
  await settle(page);

  const faults = (await attack.logged("FAULT ")).map((l) => JSON.parse(l) as Fault);
  const of = (id: string) => faults.filter((f) => f.widgetId === id);
  const one = (id: string): Fault => {
    const list = of(id);
    expect(list, id).toHaveLength(1);
    return list[0]!;
  };

  // Every fault carries exactly the fields the runtime rebuilt — nothing a widget added.
  for (const f of faults) {
    expect(f.kind, JSON.stringify(f)).toBe("script-error");
    expect(Object.keys(f).filter((k) => !FIELDS.includes(k)), JSON.stringify(f)).toEqual([]);
  }

  // A thrown error: its text, its class and the line of the widget's HTML it
  // was thrown on — or, in WebKit, nothing but "Script error.".
  const thrown = (id: string, text: string, name: string, line: number | undefined) => {
    const f = one(id);
    if (muted) {
      expect(f, id).toEqual({ widgetId: id, ...MUTED });
      return;
    }
    expect(f.message, id).toContain(text);
    expect(f.name, id).toBe(name);
    expect(f.line, id).toBe(line);
    if (line === undefined) expect(f.column, id).toBeUndefined();
    else expect(Number.isInteger(f.column) && f.column! >= 1, `${id} column`).toBe(true);
  };

  // Control: a throw on body line 3.
  thrown("typeerror", "boom", "TypeError", 3);
  // A parse error, on the line that failed to parse.
  thrown("syntax", "", "SyntaxError", 3);
  // A listener that throws long after load.
  thrown("click", "from-click", "Error", 4);
  // Thrown inside a library: the position lies in the host's part of the
  // document, so none is reported …
  thrown("library", "from-lib", "Error", undefined);
  // … but widget code that a library calls back into keeps its own line.
  thrown("library-caller", "from-widget", "Error", 2);

  // An unhandled rejection has a class and a reason, but no position — in every engine.
  const rejection = one("rejection");
  expect(rejection.name).toBe("RangeError");
  expect(rejection.message).toMatch(/^unhandled rejection: .*late/);
  expect(rejection.line).toBeUndefined();
  expect(rejection.column).toBeUndefined();

  // 100 KB thrown through the stub, at most 300 characters received.
  const oversize = one("oversize");
  expect(oversize.message.length).toBeLessThanOrEqual(300);
  if (!muted) expect(oversize.message).toContain("xxxx");

  // Forged notifications over the raw port: the host's own checks, in every engine.
  const forged = of("forged");
  const byMessage = (m: string) => forged.find((f) => f.message === m);
  for (const m of ["forged-big", "forged-negative", "forged-string", "forged-float", "forged-head", "forged-beyond"]) {
    expect(byMessage(m), m).toBeDefined();
    expect(byMessage(m)!.line, m).toBeUndefined();
    expect(byMessage(m)!.column, m).toBeUndefined();
  }
  expect(byMessage("forged-name")!.name).toHaveLength(40);
  // 5000 characters sent past the stub: the host clamps on its own.
  expect(forged.find((f) => f.message.startsWith("yyyy"))!.message).toBe("y".repeat(300));
  // A number and an object with an uncallable toString: neither is coerced.
  expect(forged.filter((f) => f.message === "unknown error"), "non-string messages").toHaveLength(2);
  // 299 "a" then an emoji (two UTF-16 units): the cut at 300 would split the
  // pair, so the whole emoji goes and no lone half is left behind.
  expect(forged.find((f) => f.message.startsWith("aaaa"))!.message).toBe("a".repeat(299));
  // Text is made one line, direction marks go, and a lone surrogate half
  // becomes U+FFFD. A name that is not an error class name is left out.
  const lines = forged.find((f) => f.message.startsWith("forged-lines"))!;
  expect(lines.message).toBe("forged-lines line two line three");
  expect(lines.name, "a name with a line break").toBeUndefined();
  const bidi = forged.find((f) => f.message.startsWith("forged-bidi"))!;
  expect(bidi.message).toBe("forged-bidi evil text");
  expect(bidi.name, "a name with a space").toBeUndefined();
  const lone = forged.find((f) => f.message.startsWith("forged-lone"))!;
  expect(lone.message).toBe("forged-lone\uFFFDx");
  expect(lone.name).toBe("My.Error$1");
  // The id names the sending port, even when the widget claims another live widget's.
  const extra = byMessage("forged-extra")!;
  expect(extra.widgetId).toBe("forged");
  expect(extra.kind).toBe("script-error");
  expect(extra).not.toHaveProperty("extra");

  // 500 throws, 20 allowed per window: 20 arrive, and the crossing is audited once.
  expect(of("flood")).toHaveLength(20);
  const audits = await attack.logged("AUDIT ");
  expect(audits.filter((a) => a.startsWith("flood (rate limit) refused"))).toHaveLength(1);

  // The fault queued behind the destroying call never arrives; its twin's does.
  expect(await attack.log()).toContain("DESTROYED after-destroy");
  expect(of("after-destroy")).toHaveLength(0);
  thrown("after-destroy-control", "late-throw", "Error", 3);

  // What this engine says, for the record (learnings/messaging.md).
  const sample = ["typeerror", "rejection", "syntax", "click"].map((id) => one(id));
  console.log(`[${test.info().project.name}] ${JSON.stringify(sample)}`);
});
