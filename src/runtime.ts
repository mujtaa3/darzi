/**
 * The runtime, on the host side. The app calls `createRuntime` once, then
 * `render` for each widget. The switchboard, `handleMessage`, checks each
 * message that a widget sends.
 */

// The `.js` extension is necessary, although these files are `.ts`.
// TypeScript does not change import paths, and browsers need the full path.
import { FRAME_ALLOW, FRAME_REFERRER_POLICY, SANDBOX_TOKENS } from "./consts/jail.js";
import { RPC } from "./consts/rpc.js";
import {
  ABANDONED,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_FORBIDDEN_TEXT,
  DEFAULT_RATE_LIMIT,
  DEFAULT_START_TIMEOUT_MS,
  DEFAULT_STATE_LIMIT_BYTES,
  MAX_FAULT_MESSAGE,
  MAX_FAULT_NAME,
  MAX_METHOD_LENGTH,
  MAX_TIMER_MS,
  STUB_NO_ANSWER_MS,
  UTF8,
  VERSION,
} from "./consts/runtime.js";
import { abandonReason, clampText, deadlineSignal, newWidgetId, oneLine, position, untilAborted } from "./helpers/runtime.js";
import { baseTagAllowed } from "./helpers/jail.js";
import { scaffold, warden } from "./jail.js";
import {
  fail,
  justCrossedRate,
  ok,
  parseNotification,
  parseRequest,
  readId,
  sanitizeParams,
  withinRate,
} from "./helpers/rpc.js";
import type { RpcId, RpcResponse } from "./types/rpc.js";
import type { Capability } from "./types/capability.js";
import type { AuditEvent } from "./types/audit.js";
import type { WidgetFault } from "./types/fault.js";
import type { Runtime, RuntimeOptions } from "./types/runtime.js";
import type { LiveWidget, RenderOptions, Widget, WidgetBody } from "./types/widget.js";

/**
 * Create a runtime with the app's capabilities. The app calls this once.
 *
 * The capabilities belong to the app, not to one widget: each widget gets the
 * same list, and in 0.1.0 each widget can call each capability.
 *
 * It throws at once for a bad option, so that a host error shows at setup,
 * not later inside a widget.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  // ── Setup: runs once, when the app calls createRuntime ─────────────────────

  // The registry: capability name → capability. The switchboard looks up each
  // call here.
  const registry = new Map<string, Capability>();
  for (const capability of options.capabilities) {
    // The runtime keeps names that start with "darzi/" for its own messages
    // (darzi/fault, darzi/saveState, darzi/loadState). The runtime checks those
    // before the registry, so a registered copy could not run in their place.
    // The check keeps the prefix free, and fails loudly at setup.
    if (capability.name.startsWith("darzi/")) {
      throw new Error(`capability name "${capability.name}" uses the reserved "darzi/" prefix`);
    }
    // A second entry would replace the first without a warning, and the order
    // of the list would then decide which handler runs.
    if (registry.has(capability.name)) {
      throw new Error(`capability "${capability.name}" is registered twice`);
    }
    registry.set(capability.name, capability);
  }

  // The forbidden text that `render` checks. A copy, so that a later change to
  // the host's list does not change this runtime.
  const forbiddenText = [...(options.forbiddenText ?? DEFAULT_FORBIDDEN_TEXT)];
  for (const entry of forbiddenText) {
    // An empty entry would match every widget HTML, so render would refuse all of them.
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error("forbiddenText entries must be non-empty strings");
    }
  }

  // The libraries: name → source text. `render` adds the ones a widget names.
  const libraries = new Map<string, string>();
  for (const lib of options.libraries ?? []) {
    if (libraries.has(lib.name)) {
      throw new Error(`library "${lib.name}" is registered twice`);
    }
    libraries.set(lib.name, lib.source);
  }

  // The number options. Each must be a whole number in its range. A bad value
  // would show only later, inside a widget. A timer delay of NaN, of Infinity or
  // over MAX_TIMER_MS fires at once. Each call then stops at once, or each widget
  // reports `never-started`. A `callTimeoutMs` of STUB_NO_ANSWER_MS or more lets
  // the stub stop before the host does.
  const checkNumber = (name: string, value: unknown, max: number): void => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(`option "${name}" must be a whole number from 1 to ${max}`);
    }
  };
  if (options.callTimeoutMs !== undefined) checkNumber("callTimeoutMs", options.callTimeoutMs, STUB_NO_ANSWER_MS - 1);
  if (options.startTimeoutMs !== undefined) checkNumber("startTimeoutMs", options.startTimeoutMs, MAX_TIMER_MS);
  if (options.stateLimitBytes !== undefined) checkNumber("stateLimitBytes", options.stateLimitBytes, Number.MAX_SAFE_INTEGER);
  if (options.rateLimit !== undefined) {
    checkNumber("rateLimit.calls", options.rateLimit.calls, Number.MAX_SAFE_INTEGER);
    checkNumber("rateLimit.windowMs", options.rateLimit.windowMs, MAX_TIMER_MS);
  }

  /** The ids of the widgets that are rendered and not yet destroyed. */
  const liveIds = new Set<string>();

  // ── Reporting to the host: the two callbacks ───────────────────────────────

  /**
   * Send a decision to `onAudit`, with the darzi `VERSION` added. Without
   * `onAudit`, it does nothing. A listener that throws cannot stop the
   * switchboard: the error goes to the console.
   */
  function audit(event: Omit<AuditEvent, "version">): void {
    if (!options.onAudit) return;
    try {
      options.onAudit({ ...event, version: VERSION });
    } catch (error) {
      console.error("[darzi] onAudit threw:", error);
    }
  }

  /**
   * Send a fault to `onWidgetFault`. Without `onWidgetFault`, the fault goes
   * to the console, so that a broken widget is never silent. A listener that
   * throws cannot stop the runtime.
   */
  function reportFault(fault: WidgetFault): void {
    if (!options.onWidgetFault) {
      console.warn(`[darzi] widget ${fault.widgetId} ${fault.kind}:`, fault.message);
      return;
    }
    try {
      options.onWidgetFault(fault);
    } catch (error) {
      console.error("[darzi] onWidgetFault threw:", error);
    }
  }

  /**
   * Turn a widget's `darzi/fault` notification into a WidgetFault, and send
   * it to `onWidgetFault`.
   *
   * The stub sends a fault when the widget's code throws. But the widget can
   * also send a fault itself, with any values, so each field is only a claim.
   * The runtime builds a NEW fault from four known fields, and checks each one:
   *   - `message`: a string, cut to 300 characters and made one line (no line
   *     breaks, no direction-control characters, no lone surrogate halves);
   *     otherwise "unknown error";
   *   - `name`: a string of letters, digits, `_`, `$` and `.`, cut to 40
   *     characters, as an error class name is; otherwise left out;
   *   - `line`: a whole number inside the widget HTML; otherwise left out;
   *   - `column`: a whole number, kept only when `line` is kept.
   *
   * The stub also cuts the text, but the stub is inside the jail, so the host
   * cannot rely on it. The widget id comes from the port, never from the
   * fault, as for every message.
   */
  function reportScriptError(widget: LiveWidget, params: unknown): void {
    // Read the params as a plain record. Anything that is not an object gives
    // an empty record, so each field below is then missing.
    const claim = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
    const message = claim["message"];
    const fault: WidgetFault = {
      widgetId: widget.id,
      kind: "script-error",
      // Strings only: String() on an object that the widget made can throw.
      message: oneLine(clampText(typeof message === "string" ? message : "unknown error", MAX_FAULT_MESSAGE)),
    };

    // Only a name that looks like an error class name. A repair prompt quotes
    // the name, so a forged name must not carry a heading or a "Where:" line.
    const name = claim["name"];
    if (typeof name === "string") {
      const cut = clampText(name, MAX_FAULT_NAME);
      if (/^[\w$.]+$/.test(cut)) fault.name = cut;
    }

    // The browser counts lines in the whole frame document, and the stub and
    // the libraries come before the widget HTML. bodyLines says where the
    // widget HTML starts and ends, so subtract its first line to get a line of
    // the widget HTML (1-based). A line outside the widget HTML is in the stub
    // or a library, so it would mean nothing to the host: leave it out.
    const line = position(claim["line"]);
    const { first, last } = widget.bodyLines;
    if (line !== undefined && line >= first && line <= last) {
      fault.line = line - first + 1;
      // The column needs no change: the widget HTML starts at column 1 of its
      // first line.
      const column = position(claim["column"]);
      if (column !== undefined) fault.column = column;
    }

    reportFault(fault);
  }

  // ── The switchboard: runs for each message from a widget ───────────────────

  // The limits that the switchboard uses for each message. Read once, here.
  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const stateLimit = options.stateLimitBytes ?? DEFAULT_STATE_LIMIT_BYTES;

  /**
   * The deadline for each call that leaves the switchboard, to a capability
   * handler or to the store. It aborts after `callTimeoutMs`, or when the
   * widget is destroyed, whichever comes first. A new signal for each call,
   * so that each call gets its own full deadline.
   */
  function callSignal(widget: LiveWidget): AbortSignal {
    return deadlineSignal(widget.lifetime.signal, options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
  }

  /**
   * Save or load a widget's state, for `darzi/saveState` and `darzi/loadState`.
   *
   * The widget writes the state, so the runtime treats it like params: it
   * cleans it (no prototype keys, limited shape), then turns it into JSON
   * once, here. The store gets an opaque JSON string, and a load parses it
   * back. `sanitizeParams` refuses a cyclic value, because it hits the depth
   * limit. `JSON.stringify` can still throw, for example on a BigInt; that
   * also becomes a refusal.
   *
   * Store calls get the same deadline as capability calls. The store is host
   * code that darzi does not control. A store that hangs must not keep the
   * call open, or finish a write after the widget is destroyed. The store gets
   * the signal, so that a store on the network can cancel its request.
   *
   * The state is keyed by `widget.id`, which comes from the port. So a widget
   * can read and write only its own state.
   */
  async function handleState(
    widget: LiveWidget,
    id: RpcId,
    method: string,
    rawParams: unknown,
    signal: AbortSignal,
  ): Promise<RpcResponse> {
    // Two small helpers for the two kinds of failure. Each one records the
    // refusal in the audit first, then makes the error reply.
    const refuse = (reason: string): RpcResponse => {
      audit({ widgetId: widget.id, method, decision: "refused", reason });
      return fail(id, RPC.INVALID_REQUEST, reason);
    };
    const abandon = (): RpcResponse => {
      audit({ widgetId: widget.id, method, decision: "refused", reason: abandonReason(widget) });
      return fail(id, RPC.TIMEOUT, "state operation timed out");
    };

    if (!options.store) return refuse("no store configured");

    try {
      // Load: ask the store for the saved JSON, and parse it. null means that
      // nothing was saved.
      if (method === "darzi/loadState") {
        audit({ widgetId: widget.id, method, decision: "dispatched" });
        const json = await untilAborted(options.store.getState(widget.id, signal), signal);
        if (json === ABANDONED) return abandon();
        return ok(id, json === null ? null : JSON.parse(json));
      }

      // Save: clean the params, take `params.value` (the stub sends
      // `{ value }`), turn it into JSON, check its size, then give it to the
      // store.
      const params = sanitizeParams(rawParams);
      if (!params.ok) return refuse(`state rejected: ${params.reason}`);
      const value = (params.value as { value?: unknown } | null)?.value ?? null;

      let json: string;
      try {
        json = JSON.stringify(value) ?? "null";
      } catch {
        return refuse("state rejected: not JSON-serializable");
      }
      // Count bytes, not string.length. A JavaScript string counts UTF-16
      // units, which counts non-Latin text and emoji up to 3 times too small
      // for what a store holds. The params text limit above bounds this encode.
      const bytes = UTF8.encode(json).length;
      if (bytes > stateLimit) {
        return refuse(`state too large (${bytes} bytes > ${stateLimit})`);
      }

      audit({ widgetId: widget.id, method, decision: "dispatched" });
      const written = await untilAborted(options.store.putState(widget.id, json, signal), signal);
      if (written === ABANDONED) return abandon();
      return ok(id, true);
    } catch (error) {
      // As for capability handlers: the host sees the real error, the widget
      // never does, because error messages can contain internal details.
      console.error(`[darzi] ${method} failed:`, error);
      audit({ widgetId: widget.id, method, decision: "refused", reason: "state operation failed" });
      return fail(id, RPC.INTERNAL_ERROR, "state operation failed");
    }
  }

  /**
   * The switchboard: check, look up, dispatch. Every message takes this one
   * path, so there is one place where a call can be refused. Per-widget grants
   * will go between "look up" and "dispatch".
   *
   * The caller gives `widget`: it is the port's own message handler. The
   * runtime never reads the widget from the message. So a widget cannot claim
   * to be a different widget: it has no field to lie in.
   *
   * It returns the reply to send, or null for no reply. The gates, in order:
   *   1. the rate limit;
   *   2. notifications (darzi/fault), which never get a reply;
   *   3. the shape of the request;
   *   4. the built-in state methods;
   *   5. the capability lookup;
   *   6. the params check;
   *   7. the audit records "dispatched", and the handler runs with a deadline;
   *   8. the result must be possible to send across the port.
   */
  async function handleMessage(widget: LiveWidget, raw: unknown): Promise<RpcResponse | null> {
    // 1. The rate limit comes first, for EVERY message. A widget can flood with
    // notifications and junk as easily as with requests, and any work before
    // this check would be free work for an attacker.
    if (!withinRate(widget.rate, Date.now(), rateLimit.calls, rateLimit.windowMs)) {
      // Record only the first refusal in each window. Otherwise the flood would
      // go straight into the audit log.
      if (justCrossedRate(widget.rate, rateLimit.calls)) {
        audit({
          widgetId: widget.id,
          method: "(rate limit)",
          decision: "refused",
          reason: `over ${rateLimit.calls} messages in ${rateLimit.windowMs}ms`,
        });
      }
      // A message with a readable id gets an error, so that its promise rejects
      // at once. Anything else is dropped; faults are best effort.
      const floodedId = readId(raw);
      return floodedId === null ? null : fail(floodedId, RPC.RATE_LIMITED, "rate limited");
    }

    // 2. Notifications come next. They have no id, so they get no reply, and
    // they can never reach a capability. The runtime knows only one; it drops
    // any other.
    const notification = parseNotification(raw);
    if (notification !== null) {
      if (notification.method === "darzi/fault") reportScriptError(widget, notification.params);
      return null;
    }

    // 3. The shape of the request.
    const request = parseRequest(raw);
    if (request === null) {
      audit({
        widgetId: widget.id,
        method: "(unparseable)",
        decision: "refused",
        reason: "malformed message",
      });
      // `parseRequest` checks the id and the method. So when the id is readable,
      // the method is the fault, and the widget's promise can reject at once. Any
      // other message has no id that a reply can carry, so it gets no reply.
      const id = readId(raw);
      return id === null ? null : fail(id, RPC.INVALID_REQUEST, "method must be a string");
    }

    // 4. The built-in state methods come before the registry. They are part
    // of the runtime, not app capabilities, and grants will apply only to the
    // registry. The widget id for the state comes from the port, never from
    // the message, so a widget cannot read or write another widget's state.
    if (request.method === "darzi/saveState" || request.method === "darzi/loadState") {
      return handleState(widget, request.id, request.method, request.params, callSignal(widget));
    }

    // 5. The capability lookup. In 0.1.0, a registered name is the only
    // permission that a call needs.
    const capability = registry.get(request.method);
    if (capability === undefined) {
      // This is the one place where the method reaches the host as the widget
      // wrote it, at any length. Cut it and make it one line, as fault text,
      // so the audit log and the reply stay small and safe to show.
      const method = oneLine(clampText(request.method, MAX_METHOD_LENGTH));
      audit({
        widgetId: widget.id,
        method,
        decision: "refused",
        reason: "no such capability",
      });
      return fail(request.id, RPC.METHOD_NOT_FOUND, `no such capability: ${method}`);
    }

    // 6. The params come in from the widget here. sanitizeParams builds a new
    // copy: it drops the keys that change prototypes (__proto__, constructor,
    // prototype), and limits depth, count and size (see helpers/rpc.ts). So
    // whatever a handler does with the params, that attack is already gone.
    const params = sanitizeParams(request.params);
    if (!params.ok) {
      audit({
        widgetId: widget.id,
        method: request.method,
        decision: "refused",
        reason: `params rejected: ${params.reason}`,
      });
      // The reason is about the widget's own message, so the widget can see it.
      return fail(request.id, RPC.INVALID_REQUEST, `params rejected: ${params.reason}`);
    }

    // 7. All checks passed: record "dispatched", then run the handler. If the
    // call fails later, the audit records "refused" too, with the reason.
    audit({ widgetId: widget.id, method: request.method, decision: "dispatched" });

    // Two separate protections, for two different failures:
    //
    //   the signal   lets a handler that listens stop its work: the fetch is
    //                cancelled, and the backend connection is released. Only
    //                this one frees real resources.
    //   the race     stops the RUNTIME waiting for a handler that ignores the
    //                signal, or that is busy in a long computation. Handlers
    //                are app code that darzi does not control.
    //
    // Without the race, a widget could fill memory: it could call a slow
    // handler in a loop, and each waiting promise would stay in memory.
    const signal = callSignal(widget);

    try {
      // Promise.resolve lets a handler return a plain value or a promise.
      const outcome = await untilAborted(
        Promise.resolve(capability.handler(params.value, { signal, widgetId: widget.id })),
        signal,
      );

      if (outcome === ABANDONED) {
        // The widget may be gone already. A reply to a closed port does nothing.
        audit({ widgetId: widget.id, method: request.method, decision: "refused", reason: abandonReason(widget) });
        return fail(request.id, RPC.TIMEOUT, "capability timed out");
      }

      // 8. The reply crosses the port as a structured clone, and some values
      // cannot be cloned: functions, promises, a fetch Response. postMessage
      // would then throw later, outside this try, after the audit said
      // "dispatched", and the widget would wait for the stub's backstop. So
      // test the result here, where the runtime knows the capability's name
      // and can record the refusal. It costs one extra copy for each result.
      try {
        structuredClone(outcome);
      } catch (error) {
        console.error(`[darzi] capability "${request.method}" returned a value that cannot be sent to a widget:`, error);
        audit({
          widgetId: widget.id,
          method: request.method,
          decision: "refused",
          reason: "result not cloneable",
        });
        return fail(request.id, RPC.INTERNAL_ERROR, "capability returned a value that can't be sent to a widget");
      }

      return ok(request.id, outcome);
    } catch (error) {
      // The handler threw, or its promise failed. Never give the widget the
      // real error, because error messages can contain internal details. The
      // real error goes to the host's console. The audit records the failure
      // before the widget hears of it, so the host can tell its own failure
      // from a widget bug.
      console.error(`[darzi] capability "${request.method}" threw:`, error);
      audit({ widgetId: widget.id, method: request.method, decision: "refused", reason: "capability failed" });
      return fail(request.id, RPC.INTERNAL_ERROR, "capability failed");
    }
  }

  // ── render: runs once for each widget ──────────────────────────────────────

  /**
   * Render widget HTML into `container`, and return the widget's handle.
   *
   * In order, it:
   *   1. picks the id, and refuses an id that is already live;
   *   2. refuses forbidden text and unknown library names, before it changes
   *      the page;
   *   3. makes the outer frame (the warden) and the two documents;
   *   4. listens for the widget's "ready" message, and opens a channel for each
   *      load of the frame;
   *   5. adds the frame to the page, which starts the widget.
   *
   * The returned `destroy()` undoes all of this.
   */
  function render(body: WidgetBody, container: HTMLElement, renderOptions?: RenderOptions): Widget {
    // Step 1. A saved widget renders with its record id. That id lets its
    // saved state find it again. Without an id, the widget is temporary.
    const id = renderOptions?.id ?? newWidgetId();

    // One live widget for each id. Two frames with one id would share one
    // state slot, and the audit could not tell them apart. To render a saved
    // widget again (refine, rollback, reload), destroy the old one first.
    if (liveIds.has(id)) {
      throw new Error(`widget "${id}" is already rendered — destroy it before rendering it again`);
    }

    // Step 2. Forbidden text: refuse the widget if its HTML contains a listed
    // sequence anywhere. The runtime only refuses; it never changes the widget
    // HTML. It does this before it changes the page, so a refused widget
    // leaves nothing.
    const hit = forbiddenText.find((entry) => body.includes(entry));
    if (hit !== undefined) {
      audit({ widgetId: id, method: "(forbidden text)", decision: "refused", reason: `widget HTML contains "${hit}"` });
      throw new Error(
        `widget refused: its HTML contains forbidden text "${hit}" ` +
          "(a check for obvious misuse, not a containment control)",
      );
    }

    // The host's CSP must let the warden's <base> work. If it does not, the
    // widget can read this page's URL, and nothing else would show it.
    if (!baseTagAllowed(container.ownerDocument)) {
      const reason = "this page's CSP blocks the warden's <base>";
      audit({ widgetId: id, method: "(host CSP)", decision: "refused", reason });
      throw new Error(
        `widget refused: ${reason}, so the widget could read this page's URL. ` +
          "Add about: to your base-uri directive, for example base-uri 'self' about:",
      );
    }

    // Find each library before the page changes, so that a bad name costs nothing.
    const libSources = (renderOptions?.libs ?? []).map((name) => {
      const source = libraries.get(name);
      if (source === undefined) {
        throw new Error(`unknown library "${name}" — register it in createRuntime({ libraries })`);
      }
      return source;
    });

    // Step 3. The outer frame. It is not in the page yet (see step 5).
    const frame = document.createElement("iframe");

    // This frame is the WARDEN: darzi's frame, with no script. The widget's
    // own frame is inside it. The warden's `frame-src 'none'` stops the widget
    // from navigating itself away with data in the URL (see jail.ts).
    //
    // `sandbox` removes almost every permission, and each token gives one
    // back. darzi gives exactly one. Nested frames inherit sandbox flags, so
    // the warden must allow scripts for the widget's scripts to run, although
    // the warden runs none. Without `allow-same-origin`, both frames belong to
    // no site, and each has a DIFFERENT opaque origin.
    frame.setAttribute("sandbox", SANDBOX_TOKENS);

    // Two more settings for things that the sandbox does not control: the
    // Permissions Policy (device features) and the referrer policy (what a
    // request from the frame says about the host). See jail.ts.
    frame.setAttribute("allow", FRAME_ALLOW);
    frame.setAttribute("referrerpolicy", FRAME_REFERRER_POLICY);

    // The two documents: `scaffold` builds the widget's document (CSP, stub,
    // libraries, widget HTML); `warden` puts it inside the outer document.
    const composed = scaffold(body, libSources);
    frame.srcdoc = warden(composed.html);

    // Step 4. The widget's identity. The runtime finds who sent a message from
    // the port that it came on, never from the message. So a widget cannot
    // claim to be another widget. `port` is null until the handshake connects it.
    const widget: LiveWidget = {
      id,
      frame,
      port: null,
      lifetime: new AbortController(),
      rate: { start: 0, count: 0 },
      bodyLines: composed.bodyLines,
    };

    // The budget for window messages from the widget's own window: the same
    // limit as calls, but counted apart from them. Each load sends one
    // "ready", so an honest widget uses one for each load.
    const knocks = { start: 0, count: 0 };

    // The handshake. Listen on the host window for a widget's "ready" message,
    // and check that it really came from the widget's frame. The listener stays
    // for the widget's life, so the widget connects again after each move or
    // reload.
    const onKnock = (event: MessageEvent): void => {
      // The check uses the WINDOW, never the origin. An opaque frame's origin
      // is the string "null", which is no use. The browser sets `event.source`,
      // and no page can fake it. The widget's window is the warden's first
      // child. The host can reach it across origins, because any origin may
      // read `frames[i]`. Any other frame that sends "ready", including the
      // warden or a sibling widget, fails this check.
      const inner = frame.contentWindow?.frames[0];
      if (inner === undefined || event.source !== inner) return;

      // Count each window message from this window against the budget, before
      // the data check. So a flood of window messages cannot make the runtime
      // decode message after message, or open channel after channel.
      if (!withinRate(knocks, Date.now(), rateLimit.calls, rateLimit.windowMs)) return;

      const data = event.data as { darzi?: unknown } | null;
      if (!data || data.darzi !== "ready") return;

      // The stub sends "ready" once for each load of the frame. So each "ready"
      // means a new document that needs a port. That is true after a move,
      // which makes a new inner window, and after an in-place reload, which
      // keeps the window. A widget that sends "ready" with no reload only loses
      // its own port. `connect` closes that port, and the stub ignores the new
      // one.
      //
      // `connect` and `startTimer` are declared below this function. That is
      // safe: a "ready" message can arrive only after `render` returns, and by
      // then both exist.
      clearTimeout(startTimer);
      connect(inner);
    };
    window.addEventListener("message", onKnock);

    // Open a new channel to one inner window, and send its messages to the
    // switchboard. port1 stays here. port2 goes to the widget, and becomes its
    // only way to reach the runtime. `connect` first closes the previous port,
    // if there is one.
    const connect = (inner: Window): void => {
      closePort();
      const channel = new MessageChannel();
      widget.port = channel.port1;
      // Each message from the widget goes to the switchboard, and the reply, if
      // any, goes back on the same port. `void` marks that nothing waits for
      // this promise; the `.catch` keeps an error from becoming unhandled.
      //
      // The reply must use this channel's port1, not `widget.port`. After a
      // move or a reload, `widget.port` is a new channel. A late reply for the
      // old document then goes to the closed old port, so the new document
      // never gets it, even with the same id.
      channel.port1.onmessage = (event: MessageEvent): void => {
        void handleMessage(widget, event.data)
          .then((response) => {
            if (response !== null) channel.port1.postMessage(response);
          })
          .catch((error: unknown) => {
            console.error(`[darzi] reply to widget ${widget.id} failed:`, error);
          });
      };
      inner.postMessage({ darzi: "port" }, "*", [channel.port2]);
    };

    // Close the current port. First clear `onmessage`, so the runtime does not
    // handle a message that the widget queued before (for example, a late
    // fault). Then `close` disconnects the port. The widget has no port until
    // the next `connect`.
    const closePort = (): void => {
      if (!widget.port) return;
      widget.port.onmessage = null;
      widget.port.close();
      widget.port = null;
    };

    // A frame that never sends its first "ready" would give the host an empty
    // box with no explanation. So after a while, stop listening, and report
    // it. The timer covers only the first load: a moved frame that never sends
    // "ready" gets no fault.
    //
    // The timer starts when `render` runs, but a frame loads only when it is in
    // the page. So if the host attaches the container after `startTimeoutMs`,
    // the widget never connects. QUICKSTART.md tells the host to attach it first.
    const startTimer = setTimeout(() => {
      // A port means that the widget connected.
      if (widget.port !== null) return;
      window.removeEventListener("message", onKnock);
      reportFault({ widgetId: id, kind: "never-started", message: "widget did not complete its handshake" });
    }, options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);

    // Step 5. Add the frame last. It starts to load only when it is in the
    // page, so everything above is ready before any widget code runs.
    container.appendChild(frame);

    // Record the id last, so that a render that threw above never holds it.
    liveIds.add(id);
    let destroyed = false;

    return {
      id,
      frame,
      destroy(): void {
        // A second call does nothing. An old handle must not release an id
        // that a newer widget now uses.
        if (destroyed) return;
        destroyed = true;
        liveIds.delete(id);

        // Abort first. Each call in progress gets its signal, so handlers that
        // listen can stop their work, and the runtime stops waiting for them.
        widget.lifetime.abort(new DOMException("widget destroyed", "AbortError"));
        // Then release the rest: the start timer, the "ready" listener, the
        // port, and the frame.
        clearTimeout(startTimer);
        window.removeEventListener("message", onKnock);
        closePort();
        frame.remove();
      },
    };
  }

  return { render };
}
