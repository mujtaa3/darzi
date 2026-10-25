/**
 * The runtime: `createRuntime`, the capability registry and the switchboard.
 *
 * Everything here runs on the host side, in the app's page. The public types
 * are in types/, and index.ts lists what a host can import.
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
  MAX_POSITION,
  VERSION,
} from "./consts/runtime.js";
import { scaffold, warden } from "./jail.js";
import {
  fail,
  justCrossedRate,
  ok,
  parseNotification,
  parseRequest,
  sanitizeParams,
  withinRate,
} from "./helpers/rpc.js";
import type { RateWindow, RpcId, RpcResponse } from "./types/rpc.js";
import type { Capability } from "./types/capability.js";
import type { AuditEvent } from "./types/audit.js";
import type { WidgetFault } from "./types/fault.js";
import type { Runtime, RuntimeOptions } from "./types/runtime.js";
import type { RenderOptions, Widget, WidgetBody } from "./types/widget.js";

/** What the runtime knows about one rendered widget. */
interface LiveWidget {
  id: string;
  frame: HTMLIFrameElement;
  /** The host's end of the widget's channel. It is also the widget's identity. */
  port: MessagePort;
  /** Aborted when the widget is destroyed, so that calls in progress stop too. */
  lifetime: AbortController;
  /** The counter for the rate limit (see RuntimeOptions.rateLimit). */
  rate: RateWindow;
  /** The lines of the frame's document that hold the widget HTML, for fault lines. */
  bodyLines: { first: number; last: number };
}

/** Measures saved state in UTF-8 bytes, the unit that stores count. */
const UTF8 = new TextEncoder();

/**
 * Wait for `work`, but stop waiting when `signal` aborts, even if the work
 * ignores the signal. Then return ABANDONED.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof ABANDONED> {
  // A signal that is already aborted never fires "abort" again, so answer now.
  if (signal.aborted) return Promise.resolve(ABANDONED);
  return Promise.race([
    work,
    new Promise<typeof ABANDONED>((resolve) => {
      signal.addEventListener("abort", () => resolve(ABANDONED), { once: true });
    }),
  ]);
}

/** Why the runtime stopped waiting for a call. For the audit only; the widget never sees it. */
function abandonReason(widget: LiveWidget): string {
  return widget.lifetime.signal.aborted ? "widget destroyed" : "timed out";
}

/**
 * Cut widget text to `max` UTF-16 units or fewer, without splitting a
 * surrogate pair. JavaScript counts string length in UTF-16 units, and a
 * character outside the Basic Multilingual Plane (most emoji) takes two. A cut
 * between the two would give the host broken text that marzi itself made.
 */
function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** A line or column that a widget reported: a positive whole number, or nothing. */
function position(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value < MAX_POSITION
    ? value
    : undefined;
}

/** Make an id for a widget that was rendered without one. */
function newWidgetId(): string {
  // randomUUID needs a secure context. localhost is one, but the fallback stops
  // a plain-http test server from throwing.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `w_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Create a runtime with the app's capabilities.
 *
 * The capabilities belong to the app, not to one widget: each widget gets the
 * same list, and in 0.1.0 each widget can call each capability.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  const registry = new Map<string, Capability>();
  for (const capability of options.capabilities) {
    // The runtime keeps names that start with "marzi/" for its own messages
    // (marzi/fault, marzi/saveState, marzi/loadState). The runtime checks those
    // before the registry, so a registered copy could not run in their place.
    // The check keeps the prefix free, and fails loudly at setup.
    if (capability.name.startsWith("marzi/")) {
      throw new Error(`capability name "${capability.name}" uses the reserved "marzi/" prefix`);
    }
    // A second entry would replace the first without a warning, and the order
    // of the list would then decide which handler runs.
    if (registry.has(capability.name)) {
      throw new Error(`capability "${capability.name}" is registered twice`);
    }
    registry.set(capability.name, capability);
  }

  const forbiddenText = [...(options.forbiddenText ?? DEFAULT_FORBIDDEN_TEXT)];
  for (const entry of forbiddenText) {
    // An empty entry would match every widget HTML, so render would refuse all of them.
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error("forbiddenText entries must be non-empty strings");
    }
  }

  const libraries = new Map<string, string>();
  for (const lib of options.libraries ?? []) {
    if (libraries.has(lib.name)) {
      throw new Error(`library "${lib.name}" is registered twice`);
    }
    libraries.set(lib.name, lib.source);
  }

  /** The ids of the widgets that are rendered and not yet destroyed. */
  const liveIds = new Set<string>();

  /** Send a decision to `onAudit`. A listener that throws cannot stop the switchboard. */
  function audit(event: Omit<AuditEvent, "version">): void {
    if (!options.onAudit) return;
    try {
      options.onAudit({ ...event, version: VERSION });
    } catch (error) {
      console.error("[marzi] onAudit threw:", error);
    }
  }

  /** Send a fault to `onWidgetFault`. A listener that throws cannot stop the runtime. */
  function reportFault(fault: WidgetFault): void {
    if (!options.onWidgetFault) {
      console.warn(`[marzi] widget ${fault.widgetId} ${fault.kind}:`, fault.message);
      return;
    }
    try {
      options.onWidgetFault(fault);
    } catch (error) {
      console.error("[marzi] onWidgetFault threw:", error);
    }
  }

  /**
   * Make a WidgetFault from a widget's `marzi/fault` notification.
   *
   * Each field is a claim. The runtime reads only the four known fields, and
   * drops a field that has the wrong type. It limits the text here, on the
   * host side: the stub limits it too, but the stub is inside the jail, so it
   * is not reliable. The runtime changes the line from a line of the frame's
   * document into a line of the widget HTML. It drops a position outside the
   * widget HTML (in the stub or a library). The id comes from the port, as for
   * every message.
   */
  function reportScriptError(widget: LiveWidget, params: unknown): void {
    const claim = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
    const message = claim["message"];
    const fault: WidgetFault = {
      widgetId: widget.id,
      kind: "script-error",
      // Strings only: String() on an object that the widget made can throw.
      message: clampText(typeof message === "string" ? message : "unknown error", MAX_FAULT_MESSAGE),
    };

    const name = claim["name"];
    if (typeof name === "string" && name !== "") fault.name = clampText(name, MAX_FAULT_NAME);

    const line = position(claim["line"]);
    const { first, last } = widget.bodyLines;
    if (line !== undefined && line >= first && line <= last) {
      fault.line = line - first + 1;
      const column = position(claim["column"]);
      if (column !== undefined) fault.column = column;
    }

    reportFault(fault);
  }

  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const stateLimit = options.stateLimitBytes ?? DEFAULT_STATE_LIMIT_BYTES;

  /**
   * The deadline for each call that leaves the switchboard, to a capability
   * handler or to the store. It aborts after `callTimeoutMs`, or when the
   * widget is destroyed.
   */
  function callSignal(widget: LiveWidget): AbortSignal {
    return AbortSignal.any([
      widget.lifetime.signal,
      AbortSignal.timeout(options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS),
    ]);
  }

  /**
   * Save or load a widget's state, for `marzi/saveState` and `marzi/loadState`.
   *
   * The widget writes the state, so the runtime treats it like params: it
   * cleans it (no prototype keys, limited shape), then turns it into JSON
   * once, here. The store gets an opaque JSON string, and a load parses it
   * back. `sanitizeParams` refuses a cyclic value, because it hits the depth
   * limit. `JSON.stringify` can still throw, for example on a BigInt; that
   * also becomes a refusal.
   *
   * Store calls get the same deadline as capability calls. The store is host
   * code that marzi does not control. A store that hangs must not keep the
   * call open, or finish a write after the widget is destroyed. The store gets
   * the signal, so that a store on the network can cancel its request.
   */
  async function handleState(
    widget: LiveWidget,
    id: RpcId,
    method: string,
    rawParams: unknown,
    signal: AbortSignal,
  ): Promise<RpcResponse> {
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
      if (method === "marzi/loadState") {
        audit({ widgetId: widget.id, method, decision: "dispatched" });
        const json = await untilAborted(options.store.getState(widget.id, signal), signal);
        if (json === ABANDONED) return abandon();
        return ok(id, json === null ? null : JSON.parse(json));
      }

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
      console.error(`[marzi] ${method} failed:`, error);
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
   */
  async function handleMessage(widget: LiveWidget, raw: unknown): Promise<RpcResponse | null> {
    // The rate limit comes first, for EVERY message. A widget can flood with
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
      // A request gets an error, so that its promise rejects at once. Anything
      // else is dropped; faults are best effort.
      const flooded = parseRequest(raw);
      return flooded ? fail(flooded.id, RPC.RATE_LIMITED, "rate limited") : null;
    }

    // Notifications come next. They have no id, so they get no reply, and they
    // can never reach a capability. The runtime knows only one; it drops any
    // other.
    const notification = parseNotification(raw);
    if (notification !== null) {
      if (notification.method === "marzi/fault") reportScriptError(widget, notification.params);
      return null;
    }

    const request = parseRequest(raw);
    if (request === null) {
      // A malformed message has no id to answer, so the only safe action is to
      // drop it. An answer would mean trusting a field of a message that the
      // runtime cannot read.
      audit({
        widgetId: widget.id,
        method: "(unparseable)",
        decision: "refused",
        reason: "malformed message",
      });
      return null;
    }

    // The built-in state methods come before the registry. They are part of
    // the runtime, not app capabilities, and grants will apply only to the
    // registry. The widget id for the state comes from the port, never from
    // the message, so a widget cannot read or write another widget's state.
    if (request.method === "marzi/saveState" || request.method === "marzi/loadState") {
      return handleState(widget, request.id, request.method, request.params, callSignal(widget));
    }

    const capability = registry.get(request.method);
    if (capability === undefined) {
      audit({
        widgetId: widget.id,
        method: request.method,
        decision: "refused",
        reason: "no such capability",
      });
      return fail(request.id, RPC.METHOD_NOT_FOUND, `no such capability: ${request.method}`);
    }

    // The params come in from the widget here. sanitizeParams builds a new
    // copy: it drops the keys that change prototypes (__proto__, constructor,
    // prototype), and limits depth, count and size (see helpers/rpc.ts). So whatever
    // a handler does with the params, that attack is already gone.
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

    audit({ widgetId: widget.id, method: request.method, decision: "dispatched" });

    // Two separate protections, for two different failures:
    //
    //   the signal   lets a handler that listens stop its work: the fetch is
    //                cancelled, and the backend connection is released. Only
    //                this one frees real resources.
    //   the race     stops the RUNTIME waiting for a handler that ignores the
    //                signal, or that is busy in a long computation. Handlers
    //                are app code that marzi does not control.
    //
    // Without the race, a widget could fill memory: it could call a slow
    // handler in a loop, and each waiting promise would stay in memory.
    const signal = callSignal(widget);

    try {
      const outcome = await untilAborted(
        Promise.resolve(capability.handler(params.value, { signal })),
        signal,
      );

      if (outcome === ABANDONED) {
        // The widget may be gone already. A reply to a closed port does nothing.
        audit({ widgetId: widget.id, method: request.method, decision: "refused", reason: abandonReason(widget) });
        return fail(request.id, RPC.TIMEOUT, "capability timed out");
      }

      // The reply crosses the port as a structured clone, and some values
      // cannot be cloned: functions, promises, a fetch Response. postMessage
      // would then throw later, outside this try, after the audit said
      // "dispatched", and the widget would wait for the stub's backstop. So
      // test the result here, where the runtime knows the capability's name
      // and can record the refusal. It costs one extra copy for each result.
      try {
        structuredClone(outcome);
      } catch (error) {
        console.error(`[marzi] capability "${request.method}" returned a value that cannot be sent to a widget:`, error);
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
      // Never give the widget the real error, because error messages can
      // contain internal details. The real error goes to the host's console.
      // The audit records the failure before the widget hears of it, so the
      // host can tell its own failure from a widget bug.
      console.error(`[marzi] capability "${request.method}" threw:`, error);
      audit({ widgetId: widget.id, method: request.method, decision: "refused", reason: "capability failed" });
      return fail(request.id, RPC.INTERNAL_ERROR, "capability failed");
    }
  }

  /**
   * Render widget HTML into `container`, and return the widget's handle.
   *
   * In order, it:
   *   1. picks the id, and refuses an id that is already live;
   *   2. refuses forbidden text and unknown library names, before it changes
   *      the page;
   *   3. makes the outer frame (the warden) and the two documents;
   *   4. opens the channel, and waits for the widget's "ready" message;
   *   5. adds the frame to the page, which starts the widget.
   *
   * The returned `destroy()` undoes all of this.
   */
  function render(body: WidgetBody, container: HTMLElement, renderOptions?: RenderOptions): Widget {
    // A saved widget renders with its record id. That id lets its saved state
    // find it again.
    const id = renderOptions?.id ?? newWidgetId();

    // One live widget for each id. Two frames with one id would share one
    // state slot, and the audit could not tell them apart. To render a saved
    // widget again (refine, rollback, reload), destroy the old one first.
    if (liveIds.has(id)) {
      throw new Error(`widget "${id}" is already rendered — destroy it before rendering it again`);
    }

    // Forbidden text: refuse the widget if its HTML contains a listed sequence
    // anywhere. The runtime only refuses; it never changes the widget HTML. It
    // does this before it changes the page, so a refused widget leaves nothing.
    const hit = forbiddenText.find((entry) => body.includes(entry));
    if (hit !== undefined) {
      audit({ widgetId: id, method: "(forbidden text)", decision: "refused", reason: `widget HTML contains "${hit}"` });
      throw new Error(
        `widget refused: its HTML contains forbidden text "${hit}" ` +
          "(a check for obvious misuse, not a containment control)",
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

    const frame = document.createElement("iframe");

    // This frame is the WARDEN: marzi's frame, with no script. The widget's
    // own frame is inside it. The warden's `frame-src 'none'` stops the widget
    // from navigating itself away with data in the URL (see jail.ts).
    //
    // `sandbox` removes almost every permission, and each token gives one
    // back. marzi gives exactly one. Nested frames inherit sandbox flags, so
    // the warden must allow scripts for the widget's scripts to run, although
    // the warden runs none. Without `allow-same-origin`, both frames belong to
    // no site, and each has a DIFFERENT opaque origin.
    frame.setAttribute("sandbox", SANDBOX_TOKENS);

    // Two more settings for things that the sandbox does not control: the
    // Permissions Policy (device features) and the referrer policy (what a
    // request from the frame says about the host). See jail.ts.
    frame.setAttribute("allow", FRAME_ALLOW);
    frame.setAttribute("referrerpolicy", FRAME_REFERRER_POLICY);

    const composed = scaffold(body, libSources);
    frame.srcdoc = warden(composed.html);

    // The channel. port1 stays here. port2 goes to the widget, and becomes its
    // only way to reach the runtime.
    const channel = new MessageChannel();

    // Made HERE, in the closure that owns the port. The runtime finds who sent
    // a message from the port it came on, never from the message. That is why
    // a widget cannot claim to be another widget.
    const widget: LiveWidget = {
      id,
      frame,
      port: channel.port1,
      lifetime: new AbortController(),
      rate: { start: 0, count: 0 },
      bodyLines: composed.bodyLines,
    };

    // Each message from the widget goes to the switchboard, and the reply, if
    // any, goes back on the same port.
    channel.port1.onmessage = (event: MessageEvent): void => {
      void handleMessage(widget, event.data)
        .then((response) => {
          if (response !== null) channel.port1.postMessage(response);
        })
        .catch((error: unknown) => {
          console.error(`[marzi] reply to widget ${widget.id} failed:`, error);
        });
    };

    // The handshake. Listen on the host window for the widget's "ready"
    // message, check that it really came from the widget's frame, and answer
    // exactly once.
    let portIssued = false;
    const onKnock = (event: MessageEvent): void => {
      if (portIssued) return;

      // The check uses the WINDOW, never the origin. An opaque frame's origin
      // is the string "null", which is no use. The browser sets `event.source`,
      // and no page can fake it. The widget's window is the warden's first
      // child. The host can reach it across origins, because any origin may
      // read `frames[i]`. Any other frame that sends "ready", including the
      // warden, fails this check.
      const inner = frame.contentWindow?.frames[0];
      if (inner === undefined || event.source !== inner) return;

      const data = event.data as { marzi?: unknown } | null;
      if (!data || data.marzi !== "ready") return;

      // Answer once, and stop listening. Never send a second port: it would be
      // a second line into the same jail that nothing tracks. The port goes
      // straight to the widget's window; the warden never touches it.
      portIssued = true;
      clearTimeout(startTimer);
      window.removeEventListener("message", onKnock);
      inner.postMessage({ marzi: "port" }, "*", [channel.port2]);
    };
    window.addEventListener("message", onKnock);

    // A frame that never sends "ready" would leave this listener on the page
    // forever, and give the host an empty box with no explanation. So stop
    // after a while, and report it.
    const startTimer = setTimeout(() => {
      if (portIssued) return;
      window.removeEventListener("message", onKnock);
      reportFault({ widgetId: id, kind: "never-started", message: "widget did not complete its handshake" });
    }, options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);

    // Add the frame last. It starts to load only when it is in the page, so
    // everything above is ready before any widget code runs.
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
        // listen can stop their work.
        widget.lifetime.abort(new DOMException("widget destroyed", "AbortError"));
        clearTimeout(startTimer);
        window.removeEventListener("message", onKnock);
        channel.port1.onmessage = null;
        channel.port1.close();
        frame.remove();
      },
    };
  }

  return { render };
}
