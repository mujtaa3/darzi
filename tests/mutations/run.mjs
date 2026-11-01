// Mutation checks — does the attack suite notice when a control breaks?
//
// Each mutation breaks one control in a copy of the repo. The spec that guards
// this control then runs on the copy, in three engines, and must go red. A
// mutation that stays green is a control that can break with all tests passing,
// which is a high bug (docs/architecture/bugs.md, B25). The repo itself does not
// change. `npm test` does not run this, and the package does not ship it.
//
//   node tests/mutations/run.mjs                  # all of them, some minutes
//   node tests/mutations/run.mjs knock port       # names with one of these words
//
// The runs are one at a time, because the witness uses fixed ports. When a
// control's code changes, its `find` text stops matching, and the script stops
// with an error. Update that mutation, and do not delete it.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const ENGINES = ["chrome", "webkit", "firefox"];
// A short list, so that `.env` and local notes stay out of the copies.
const COPIED = ["src", "scripts", "tests", "package.json", "tsconfig.json"];

const JAIL = "src/consts/jail.ts";
const RUNTIME = "src/runtime.ts";
const HELPERS = "src/helpers/runtime.ts";
const ADD_FRAME_SRC = [JAIL, `"form-action 'none'", // a form submit is a navigation, so it can carry data out`,
  `"form-action 'none'",\n  "frame-src *",`];

const SANDBOX_ADDS = (token) => [JAIL, `SANDBOX_TOKENS = "allow-scripts";`, `SANDBOX_TOKENS = "allow-scripts ${token}";`];

const MUTATIONS = [
  { name: "sandbox-allows-same-origin", spec: "identity", edits: [
    [JAIL, `SANDBOX_TOKENS = "allow-scripts";`, `SANDBOX_TOKENS = "allow-scripts allow-same-origin";`]] },
  { name: "no-default-src", spec: "connectivity", edits: [
    [JAIL, `"default-src 'none'", // block everything, then allow back only what is needed`, ""]] },
  // Green on purpose: the warden's `frame-src 'none'` comes first, so it wins.
  { name: "frame-src-added", spec: "navigation", staysGreen: true, edits: [ADD_FRAME_SRC] },
  { name: "warden-rule-comes-last", spec: "navigation", edits: [ADD_FRAME_SRC,
    [JAIL, "`frame-src 'none'; ${WIDGET_CSP}`", "`${WIDGET_CSP}; frame-src 'none'`"]] },
  { name: "no-default-src-for-other-loads", spec: "loads", edits: [
    [JAIL, `"default-src 'none'", // block everything, then allow back only what is needed`, ""]] },
  { name: "connect-src-opened", spec: "loads", edits: [
    [JAIL, `"form-action 'none'", // a form submit is a navigation, so it can carry data out`, `"form-action 'none'",\n  "connect-src *",`]] },
  { name: "sandbox-allows-popups", spec: "escapes", edits: [SANDBOX_ADDS("allow-popups")] },
  { name: "sandbox-allows-top-navigation", spec: "escapes", edits: [SANDBOX_ADDS("allow-top-navigation")] },
  // Green on purpose: the warden's `frame-src 'none'` also stops a download, so this
  // token alone changes nothing (tested: one frame with the token does download).
  { name: "sandbox-allows-downloads", spec: "escapes", staysGreen: true, edits: [SANDBOX_ADDS("allow-downloads")] },
  { name: "sandbox-allows-modals", spec: "escapes", edits: [SANDBOX_ADDS("allow-modals")] },
  { name: "frame-allows-geolocation", spec: "frame-settings", edits: [[JAIL, `FRAME_ALLOW = "";`, `FRAME_ALLOW = "geolocation *";`]] },
  { name: "referrer-policy-opened", spec: "frame-settings", edits: [[JAIL, `FRAME_REFERRER_POLICY = "no-referrer";`, `FRAME_REFERRER_POLICY = "unsafe-url";`]] },
  { name: "no-never-started-fault", spec: "handshake-edges", edits: [
    [RUNTIME, `reportFault({ widgetId: id, kind: "never-started", message: "widget did not complete its handshake" });`, ""]] },
  { name: "start-timeout-ignored", spec: "handshake-edges", edits: [
    [RUNTIME, "options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS", "DEFAULT_START_TIMEOUT_MS"]] },
  { name: "destroy-keeps-lent-port", spec: "handshake-edges", edits: [
    [RUNTIME, `window.removeEventListener("message", onKnock);\n        closePort();`, `window.removeEventListener("message", onKnock);`]] },
  { name: "prefix-not-reserved", spec: "ids", edits: [[RUNTIME, `if (capability.name.startsWith("marzi/")) {`, `if (capability.name === "marzi/") {`]] },
  { name: "no-store-seems-to-work", spec: "attacks/state", edits: [[RUNTIME, `if (!options.store) return refuse("no store configured");`, "if (!options.store) return ok(id, null);"]] },
  { name: "state-limit-ignored", spec: "attacks/state", edits: [
    [RUNTIME, "const stateLimit = options.stateLimitBytes ?? DEFAULT_STATE_LIMIT_BYTES;", "const stateLimit = DEFAULT_STATE_LIMIT_BYTES;"]] },
  { name: "malformed-not-audited", spec: "messages", edits: [
    [RUNTIME, `      audit({\n        widgetId: widget.id,\n        method: "(unparseable)",\n        decision: "refused",\n        reason: "malformed message",\n      });\n`, ""]] },
  { name: "wrong-method-gets-no-reply", spec: "messages", edits: [
    [RUNTIME, `return id === null ? null : fail(id, RPC.INVALID_REQUEST, "method must be a string");`, "return null;"]] },
  { name: "flood-answers-only-requests", spec: "messages", edits: [
    [RUNTIME, "const floodedId = readId(raw);", "const floodedId = parseRequest(raw)?.id ?? null;"]] },
  { name: "request-id-has-no-limit", spec: "messages", edits: [
    ["src/helpers/rpc.ts", `typeof id === "string" && id.length <= MAX_ID_LENGTH ? id : null`, `typeof id === "string" ? id : null`]] },
  { name: "knock-from-any-window", spec: "handshake", edits: [
    [RUNTIME, "if (inner === undefined || event.source !== inner) return;", "if (inner === undefined) return;"]] },
  { name: "no-knock-limit", spec: "reconnect", edits: [
    [RUNTIME, "if (!withinRate(knocks, Date.now(), rateLimit.calls, rateLimit.windowMs)) return;", ""]] },
  { name: "connect-keeps-old-port", spec: "reconnect", edits: [
    [RUNTIME, "      closePort();\n      const channel = new MessageChannel();", "      const channel = new MessageChannel();"]] },
  { name: "live-id-not-recorded", spec: "ids", edits: [[RUNTIME, "liveIds.add(id);", "liveIds.delete(id);"]] },
  { name: "prototype-keys-kept", spec: "messages", edits: [
    ["src/helpers/rpc.ts", "if (PROTOTYPE_KEYS.has(key)) continue;", ""]] },
  { name: "result-not-clone-checked", spec: "results", edits: [[RUNTIME, "structuredClone(outcome);", ""]] },
  { name: "call-has-no-deadline", spec: "deadlines", edits: [
    [RUNTIME, "return deadlineSignal(widget.lifetime.signal, options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);", "return widget.lifetime.signal;"]] },
  { name: "state-deadline-too-long", spec: "deadlines", edits: [
    [RUNTIME, "request.params, callSignal(widget));", "request.params, deadlineSignal(widget.lifetime.signal, (options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS) * 10));"]] },
  { name: "runtime-waits-for-handler", spec: "deadlines", edits: [
    [RUNTIME, "await untilAborted(\n        Promise.resolve(capability.handler(params.value, { signal })),\n        signal,\n      );", "await Promise.resolve(capability.handler(params.value, { signal }));"]] },
  // This option breaks destroy on zone.js before 0.14.3: see `deadlineSignal`.
  { name: "listener-uses-signal-option", spec: "deadlines", edits: [
    [HELPERS, `    parent.removeEventListener("abort", onParentAbort);\n`, ""],
    [HELPERS, `parent.addEventListener("abort", onParentAbort);`, `parent.addEventListener("abort", onParentAbort, { signal: deadline.signal });`]] },
  { name: "destroy-does-not-abort", spec: "state-lifecycle", edits: [
    [RUNTIME, `widget.lifetime.abort(new DOMException("widget destroyed", "AbortError"));`, ""]] },
  { name: "destroy-keeps-port", spec: "faults", edits: [
    [RUNTIME, `window.removeEventListener("message", onKnock);\n        closePort();`, `window.removeEventListener("message", onKnock);`]] },
];

/** Copy the repo, apply the edits, run the specs, and return what each engine did. */
function run(edits, specs, flags = []) {
  const dir = mkdtempSync(join(tmpdir(), "marzi-mutation-"));
  try {
    for (const item of COPIED) cpSync(join(REPO, item), join(dir, item), { recursive: true });
    symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
    for (const [file, find, replace] of edits) {
      const text = readFileSync(join(dir, file), "utf8");
      if (text.split(find).length !== 2) throw new Error(`${file}: this text must appear exactly once: ${find}`);
      writeFileSync(join(dir, file), text.replace(find, () => replace));
    }
    const filters = specs.map((spec) => `${spec.startsWith("attacks/") ? spec : `attacks/${spec}`}.spec`);
    const { stdout } = spawnSync("npx", ["playwright", "test", "-c", "tests/playwright.config.ts", "--reporter=json", ...flags, ...filters],
      { cwd: dir, encoding: "utf8", maxBuffer: 2 ** 30 });
    return summarize(JSON.parse(stdout));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run one mutation in each engine. One red test in an engine is enough, so each
 * run stops at its first. A broken deadline makes every test wait for its timeout,
 * so a full run of one mutation can take many minutes.
 */
function runInEachEngine(mutation) {
  const results = ENGINES.map((engine) => run(mutation.edits, [mutation.spec], [`--project=${engine}`, "--max-failures=1"]));
  return {
    ran: new Set(results.flatMap((result) => [...result.ran])),
    red: new Set(results.flatMap((result) => [...result.red])),
    why: results.find((result) => result.why)?.why ?? "",
  };
}

/** Which engines ran, which went red, and the first error, from Playwright's JSON report. */
function summarize(report) {
  const ran = new Set(), red = new Set();
  let why = "";
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        ran.add(test.projectName);
        if (test.status !== "unexpected") continue;
        red.add(test.projectName);
        why ||= test.results.at(-1)?.error?.message ?? "";
      }
    }
    (suite.suites ?? []).forEach(visit);
  };
  (report.suites ?? []).forEach(visit);
  // A test's own error comes first, because it says why the mutation went red.
  why ||= report.errors?.[0]?.message ?? "";
  return { ran, red, why: why.replace(/\u001b\[[0-9;]*m/g, "").split("\n")[0] };
}

const words = process.argv.slice(2);
const chosen = MUTATIONS.filter((m) => words.length === 0 || words.some((w) => m.name.includes(w)));

// Control: with no edit, each spec must pass. Otherwise a red run proves nothing.
const specs = [...new Set(chosen.map((m) => m.spec))];
const control = run([], specs);
if (control.red.size > 0 || control.ran.size < ENGINES.length) {
  throw new Error(`the specs must pass with no edit, but: ${control.why || "no test ran"}`);
}
console.log(`control: ${specs.length} specs pass with no edit, in ${ENGINES.join(", ")}`);

let problems = 0;
for (const mutation of chosen) {
  const { ran, red, why } = runInEachEngine(mutation);
  const green = ENGINES.filter((engine) => !red.has(engine));
  const good = ran.size === ENGINES.length && (mutation.staysGreen ? red.size === 0 : green.length === 0);
  if (!good) problems += 1;
  const result = ran.size < ENGINES.length ? "NO RUN" : red.size === 0 ? "green" : green.length === 0 ? "red" : `red, but green in ${green.join(" ")}`;
  console.log(`${good ? "ok     " : "PROBLEM"} ${mutation.name}: ${result}${mutation.staysGreen ? " (must stay green)" : ""} · ${mutation.spec}${why ? ` · ${why}` : ""}`);
}
console.log(problems === 0 ? `all ${chosen.length} mutations did what they must` : `${problems} of ${chosen.length} mutations need a look`);
process.exitCode = problems === 0 ? 0 : 1;
