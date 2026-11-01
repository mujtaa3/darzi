/**
 * The message path — what the switchboard refuses before any handler runs
 * (rung 4): prototype-rewriting keys, shape bombs, and floods.
 */
import { test, expect } from "../harness/witness";
import { openAttack } from "../harness/attack";

test("params are rebuilt, bounded, and rate-limited at the boundary", async ({ page }) => {
  const attack = await openAttack(page, "messages");
  await attack.untilLog("(rate limit) refused");

  const audits = await attack.logged("AUDIT ");
  const refusals = audits.filter((a) => a.includes("refused"));

  // Control: the well-formed call was dispatched and its params arrived intact.
  const echoes = await attack.reports();
  expect(echoes.find((e) => e.tag === "control")).toMatchObject({ own: "tag", polluted: false });

  // __proto__ arrives as an own key over the port and is stripped: the handler
  // sees only `tag`, the params object keeps a normal prototype, and
  // Object.prototype is untouched.
  expect(echoes.find((e) => e.tag === "proto")).toMatchObject({ own: "tag", protoIntact: true, polluted: false });

  // Shape bombs never reach a handler.
  expect(refusals.some((r) => r.includes("too much data")), "1.1MB string").toBe(true);
  expect(refusals.some((r) => r.includes("nested too deeply")), "depth 40").toBe(true);
  expect(refusals.some((r) => r.includes("too many values")), "10001 nodes").toBe(true);
  expect(echoes.map((e) => e.tag)).not.toContain("big");
  expect(echoes.map((e) => e.tag)).not.toContain("deep");
  expect(echoes.map((e) => e.tag)).not.toContain("wide");

  // The flood: every port message counts against 120 per window, refused ones
  // included (the rate check runs before parsing). 1 control + 4 shape probes
  // + 200 floods → exactly 115 floods reach the handler, and the crossing is
  // audited exactly once.
  expect(audits.filter((a) => a.startsWith("(rate limit)")).length).toBe(1);
  expect(echoes.filter((e) => e.tag === "flood").length).toBe(115);
});

test("a message that is not a request gets an audit line, and a reply only if it has a readable id", async ({ page }) => {
  const attack = await openAttack(page, "messages");
  await attack.untilLog("JUNK-REPLIES ");
  const { replies, callError } = JSON.parse((await attack.logged("JUNK-REPLIES "))[0]!) as { replies: unknown[]; callError: string };

  // Three messages with a readable id and no string method: an error with that id.
  // The other messages get no reply.
  const invalid = (id: string) => ({ id, code: -32600, message: "method must be a string" });
  expect(replies).toEqual([invalid("method-number"), invalid("method-missing"), invalid("method-object")]);
  // Through the stub, the promise rejects at once. At the backstop, 60 s later,
  // the text would be "no answer from the host".
  expect(callError).toBe("method must be a string");

  // The eleven raw messages and the stub's call, with one audit line each.
  const audits = await attack.logged("AUDIT ");
  expect(audits.filter((a) => a === "(unparseable) refused · malformed message"), "audit lines").toHaveLength(12);
  // Control: the channel still works after them.
  expect((await attack.reports()).map((r) => r.tag)).toContain("junk-after");
});

test("over the rate limit, a message with a readable id gets the limit's error", async ({ page }) => {
  const attack = await openAttack(page, "messages");
  await attack.untilLog("FLOODED ");

  // A method that is not a string, a message with no id, and a valid request.
  const rateLimited = -32002;
  expect(JSON.parse((await attack.logged("FLOODED "))[0]!)).toEqual([
    { id: "flooded-method-number", code: rateLimited },
    { id: "flooded-last", code: rateLimited },
  ]);
});
