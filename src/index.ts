/**
 * marzi — run LLM-generated widgets safely inside your web app.
 *
 * Rung 3 of the build ladder: the jail and the phone line work, and widgets can
 * now call named capabilities. There are no grants yet — every registered
 * capability is callable by every widget. Rung 5 fixes that.
 * See docs/architecture/roadmap.md.
 */

// The `.js` extension is required even though these files are `.ts`:
// TypeScript never rewrites import paths, and browsers demand the full path.
import { FRAME_ALLOW, FRAME_REFERRER_POLICY, SANDBOX_TOKENS, scaffold, warden } from "./jail.js";
import {
  fail,
  justCrossedRate,
  ok,
  parseNotification,
  parseRequest,
  RPC,
  sanitizeParams,
  withinRate,
  type RateWindow,
  type RpcId,
  type RpcResponse,
} from "./rpc.js";
import type { StateStore } from "./store.js";

export type {
  StateStore,
  WidgetRecord,
  WidgetStore,
  WidgetSummary,
  WidgetVersion,
} from "./store.js";
export { memoryStore } from "./store.js";

/** Library version. Goes into audit entries, so a log line names the code that produced it. */
export const VERSION = "0.0.0";

/**
 * A widget's HTML body, exactly as the model wrote it.
 *
 * Hostile by assumption: never trusted, never scanned for safety, and never
 * run anywhere but inside the jail.
 */
export type WidgetBody = string;

/** Passed to every handler as its second argument. */
export interface CallContext {
  /**
   * Aborted when the call exceeds `callTimeoutMs`, or when the widget that made
   * it is destroyed.
   *
   * Pass it to anything cancellable — `fetch(url, { signal })` above all.
   * Honouring it is what actually releases the work: the runtime's own deadline
   * stops the runtime waiting, but it cannot reach inside your handler.
   */
  signal: AbortSignal;
}

/**
 * What a capability actually does, written by the app developer.
 *
 * This runs on the HOST side, in the app's page, under the app's existing
 * session — which is why the widget never needs a token and never touches the
 * network. Think of it as a handler on a Go mux, with `context` playing the
 * part of `ctx context.Context`.
 *
 * `params` is `unknown` on purpose: it came from hostile code, so the handler
 * must narrow it before use.
 */
export type CapabilityHandler = (
  params: unknown,
  context: CallContext,
) => unknown | Promise<unknown>;

export interface Capability {
  /** The name widgets call, e.g. "transactions.list". */
  name: string;
  /**
   * Human- and model-readable explanation, shown at generation and approval time.
   *
   * ⚠️ Documentation only. Descriptions carry ZERO enforcement significance:
   * nothing here restricts what the handler does.
   */
  description: string;
  handler: CapabilityHandler;
}

/**
 * A library the host vendors for widgets to use — e.g. Chart.js as a string.
 *
 * `source` is browser-ready JavaScript text (an IIFE/UMD build that assigns a
 * global), injected inline into the frame's <head> when a widget asks for it
 * by name. The host obtains and pins this text at its own build time; marzi
 * never fetches anything, so the no-network wall stands.
 *
 * Security position: the text runs INSIDE the jail, so it carries zero
 * authority — it cannot call anything the widget could not already call.
 * Which library text to trust is the host's supply-chain decision, same as
 * any dependency it ships to its own pages.
 */
export interface Library {
  /** The name widgets request, e.g. "chartjs". Opaque to marzi. */
  name: string;
  /** The complete library source, ready to run as one inline script. */
  source: string;
}

/**
 * The default screen: character sequences that make `render` refuse a widget
 * whose body contains any of them, anywhere — code, comments and prose alike.
 * Currently the WebRTC API names, because WebRTC is a network path no CSP
 * setting closes in any engine we test (tests/attacks/webrtc.spec.ts).
 *
 * ⚠️ A screen for obvious misuse, NOT a containment control. It sees only the
 * body at render time: text that reaches the widget later through capability
 * data never passes through it, and JavaScript can reach names it assembles
 * while running. The WebRTC residual in the README stands regardless.
 */
export const DEFAULT_SCREEN: readonly string[] = Object.freeze([
  "RTCPeerConnection",
  "RTCDataChannel",
  "RTCSessionDescription",
  "RTCIceCandidate",
]);

/** Per-render choices. */
export interface RenderOptions {
  /**
   * Names of registered libraries to inject into this widget's frame.
   * Unknown names throw: that is a host programming error, and failing loudly
   * here beats a widget dying inside the jail on an undefined global.
   */
  libs?: string[];
  /**
   * The widget's DURABLE identity — the id of its saved record. State saved
   * via `marzi.saveState` is namespaced by this, so rendering a saved widget
   * with its record id is what makes its state come back tomorrow. Omitted:
   * a fresh id is minted and the widget is ephemeral.
   */
  id?: string;
}

/** A rendered widget: its identity, its frame, and how to tear it down. */
export interface Widget {
  /** Stable id. Grants, audit entries and stored state all key off this. */
  id: string;
  /**
   * The outer frame in the host's DOM — the warden, which contains the
   * widget's own frame. Size and place this one. Removing it from the DOM
   * removes both frames but does NOT release the runtime's listeners and port;
   * call `destroy()` for that.
   */
  frame: HTMLIFrameElement;
  /** Stop listening and tear the widget down. */
  destroy(): void;
}

/**
 * What the switchboard decided about one inbound call.
 *
 * Without this the host is blind to refusals — the runtime declines silently and
 * nothing outside can tell an ungranted call from one that never happened. This
 * is the seed of the audit log.
 */
export interface AuditEvent {
  /**
   * Which widget asked.
   *
   * Derived from the port the message arrived on, never from anything the widget
   * said. A widget cannot claim to be another widget, because it does not supply
   * this value at all.
   */
  widgetId: string;
  method: string;
  decision: "dispatched" | "refused";
  /** Present on refusal: why. Safe to show a developer, not a widget. */
  reason?: string;
}

/**
 * A widget that is not working, so the host can say so instead of leaving a
 * blank rectangle on the page.
 */
export interface WidgetFault {
  widgetId: string;
  /**
   * `never-started` — the frame never completed its handshake. Broken scaffold,
   * a widget that killed the stub, or a frame that navigated away on load.
   * `script-error` — the widget's own code threw.
   */
  kind: "never-started" | "script-error";
  /**
   * ⚠️ For `script-error` this is **widget-authored text**, and it arrives in
   * the host origin. Escape it, never assign it to innerHTML. The runtime
   * clamps its length; it does not and cannot vouch for its content.
   */
  message: string;
}

export interface RuntimeOptions {
  capabilities: Capability[];
  /** Vendored libraries widgets may request by name at render. */
  libraries?: Library[];
  /**
   * Sequences whose presence anywhere in a widget body makes `render` refuse
   * it (see DEFAULT_SCREEN for what this can and cannot do). This is the
   * COMPLETE list — nothing is merged behind your back: extend with
   * `[...DEFAULT_SCREEN, "x"]`, replace with your own, disable with `[]`.
   * Matching is exact and case-sensitive. Library sources are not screened:
   * they are the host's own vendored text.
   */
  screen?: readonly string[];
  /**
   * Where `marzi.saveState` / `marzi.loadState` land. Without one, those
   * calls are refused. The runtime hands this an opaque JSON string keyed by
   * widget id — it never asks the store to interpret state.
   */
  store?: StateStore;
  /**
   * Ceiling on one widget's serialized state, in JSON characters.
   * Default 64 000. State is widget-authored and therefore hostile; the cap
   * is what stops a widget using the host's storage as a landfill.
   */
  stateLimitBytes?: number;
  /** Called for every inbound call, allowed or not. Must not throw. */
  onAudit?: (event: AuditEvent) => void;
  /** Called when a widget fails to start or its code throws. Must not throw. */
  onWidgetFault?: (fault: WidgetFault) => void;
  /**
   * How long to wait for a widget's handshake before declaring it dead.
   * Default 10s.
   */
  startTimeoutMs?: number;
  /**
   * Ceiling on inbound messages per widget: at most `calls` in any window of
   * `windowMs`. Counts EVERY message — requests, notifications, junk — since a
   * widget can flood with any of them. Fixed windows, so a burst straddling a
   * boundary can briefly reach 2×: fine for flood control, not for billing.
   * Default 120 per 10 seconds.
   */
  rateLimit?: { calls: number; windowMs: number };
  /**
   * How long a capability call may run before the runtime gives up on it.
   * Default 30s. The handler's `signal` aborts at the same moment.
   */
  callTimeoutMs?: number;
}

export interface Runtime {
  render(body: WidgetBody, container: HTMLElement, options?: RenderOptions): Widget;
}

/** Everything the runtime knows about one rendered widget. */
interface LiveWidget {
  id: string;
  frame: HTMLIFrameElement;
  /** The host end of its private line. Identity, not just transport. */
  port: MessagePort;
  /** Aborted on teardown, so calls still in flight are cancelled with it. */
  lifetime: AbortController;
  /** Fixed-window flood counter — see RuntimeOptions.rateLimit. */
  rate: RateWindow;
}

/** Distinguishes "the runtime gave up" from a value a handler actually returned. */
const ABANDONED = Symbol("abandoned");

function newWidgetId(): string {
  // randomUUID needs a secure context; localhost qualifies, but fall back so a
  // plain-http staging box does not throw.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `w_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Create a runtime holding the app's capability catalog.
 *
 * The catalog is per-app rather than per-widget: every widget is offered the
 * same menu, and (from rung 5) each widget's grants decide which entries it may
 * actually order from.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  const registry = new Map<string, Capability>();
  for (const capability of options.capabilities) {
    // "marzi/" names are runtime built-ins (marzi/fault, marzi/saveState…).
    // Letting an app register one would let it shadow or spoof the runtime's
    // own protocol, so the collision is refused at setup, loudly.
    if (capability.name.startsWith("marzi/")) {
      throw new Error(`capability name "${capability.name}" uses the reserved "marzi/" prefix`);
    }
    registry.set(capability.name, capability);
  }

  const screen = [...(options.screen ?? DEFAULT_SCREEN)];
  for (const entry of screen) {
    // An empty sequence would match every body and silently refuse them all.
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error("screen entries must be non-empty strings");
    }
  }

  const libraries = new Map<string, string>();
  for (const lib of options.libraries ?? []) {
    libraries.set(lib.name, lib.source);
  }

  /**
   * The switchboard, in its rung-3 form: validate, look up, dispatch.
   *
   * Rung 5 inserts the grant check between "look up" and "dispatch". Everything
   * here is deliberately one path, so there is one place where a call can be
   * refused rather than several that might disagree.
   */
  /** Report a decision without letting a bad listener break dispatch. */
  function audit(event: AuditEvent): void {
    if (!options.onAudit) return;
    try {
      options.onAudit(event);
    } catch (error) {
      console.error("[marzi] onAudit threw:", error);
    }
  }

  /** Longest widget-authored message we will carry across the wall. */
  const MAX_FAULT_MESSAGE = 300;

  function reportFault(widgetId: string, kind: WidgetFault["kind"], message: string): void {
    const fault: WidgetFault = {
      widgetId,
      kind,
      // Clamp here, host-side. The stub clamps too, but the stub is inside the
      // jail and its cooperation cannot be assumed.
      message: String(message).slice(0, MAX_FAULT_MESSAGE),
    };
    if (!options.onWidgetFault) {
      console.warn(`[marzi] widget ${widgetId} ${kind}:`, fault.message);
      return;
    }
    try {
      options.onWidgetFault(fault);
    } catch (error) {
      console.error("[marzi] onWidgetFault threw:", error);
    }
  }

  const rateLimit = options.rateLimit ?? { calls: 120, windowMs: 10_000 };
  const stateLimit = options.stateLimitBytes ?? 64_000;

  /**
   * The widget's own settings, through the switchboard.
   *
   * State is widget-authored, so it crosses the trust boundary like params do:
   * sanitized (prototype keys stripped, shape bounded), then serialized ONCE
   * here — the store receives an opaque JSON string, and load parses it back.
   * JSON.stringify also throws on cycles, which lands in the refusal path.
   */
  async function handleState(
    widget: LiveWidget,
    id: RpcId,
    method: string,
    rawParams: unknown,
  ): Promise<RpcResponse> {
    const refuse = (reason: string): RpcResponse => {
      audit({ widgetId: widget.id, method, decision: "refused", reason });
      return fail(id, RPC.INVALID_REQUEST, reason);
    };

    if (!options.store) return refuse("no store configured");

    try {
      if (method === "marzi/loadState") {
        audit({ widgetId: widget.id, method, decision: "dispatched" });
        const json = await options.store.getState(widget.id);
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
      if (json.length > stateLimit) {
        return refuse(`state too large (${json.length} > ${stateLimit})`);
      }

      audit({ widgetId: widget.id, method, decision: "dispatched" });
      await options.store.putState(widget.id, json);
      return ok(id, true);
    } catch (error) {
      // Same posture as capability handlers: the real error is the host's to
      // see, never the widget's — messages can carry internal detail.
      console.error(`[marzi] ${method} failed:`, error);
      return fail(id, RPC.INTERNAL_ERROR, "state operation failed");
    }
  }

  /**
   * `widget` is supplied by the caller, which is the port's own message handler.
   * It is never read out of the message. That is the whole reason a widget
   * cannot impersonate another one: it has no field to lie in.
   */
  async function handleMessage(widget: LiveWidget, raw: unknown): Promise<RpcResponse | null> {
    // Flood control before any other work, for EVERY message — a widget can
    // spam notifications and junk as easily as requests, and whatever runs
    // before this line is amplification the attacker gets for free.
    if (!withinRate(widget.rate, Date.now(), rateLimit.calls, rateLimit.windowMs)) {
      // Audit the transition once per window, not once per flooded message —
      // otherwise the flood would simply be forwarded into the audit sink.
      if (justCrossedRate(widget.rate, rateLimit.calls)) {
        audit({
          widgetId: widget.id,
          method: "(rate limit)",
          decision: "refused",
          reason: `over ${rateLimit.calls} messages in ${rateLimit.windowMs}ms`,
        });
      }
      // Requests get an error so their promises reject promptly; anything else
      // is dropped — the fault channel is best-effort by design.
      const flooded = parseRequest(raw);
      return flooded ? fail(flooded.id, RPC.RATE_LIMITED, "rate limited") : null;
    }

    // Notifications come first: they carry no id, so they get no reply and can
    // never reach a capability. Only one is understood, and an unknown one is
    // dropped rather than answered.
    const notification = parseNotification(raw);
    if (notification !== null) {
      if (notification.method === "marzi/fault") {
        const params = notification.params as { message?: unknown } | null;
        reportFault(widget.id, "script-error", String(params?.message ?? "unknown error"));
      }
      return null;
    }

    const request = parseRequest(raw);
    if (request === null) {
      // Malformed and unidentifiable — there is no id to answer to, so the only
      // safe move is to drop it. Answering a message we cannot parse would mean
      // trusting a field from it.
      audit({
        widgetId: widget.id,
        method: "(unparseable)",
        decision: "refused",
        reason: "malformed message",
      });
      return null;
    }

    // Built-ins before the registry: these are runtime protocol, not app
    // capabilities, and (note for rung 5) they are runtime-governed — grants
    // will apply to the capability registry only. The widget id used for
    // namespacing comes from the port's closure, never from the message, so
    // one widget cannot read or write another widget's state.
    if (request.method === "marzi/saveState" || request.method === "marzi/loadState") {
      return handleState(widget, request.id, request.method, request.params);
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

    // Params cross the trust boundary here. sanitizeParams rebuilds them,
    // dropping the prototype-rewriting keys (__proto__, constructor,
    // prototype) and bounding depth, node count and total size — see rpc.ts
    // for the full reasoning. Whatever a handler does with params afterwards,
    // the pollution lever is already gone.
    const params = sanitizeParams(request.params);
    if (!params.ok) {
      audit({
        widgetId: widget.id,
        method: request.method,
        decision: "refused",
        reason: `params rejected: ${params.reason}`,
      });
      // The reason is about the widget's own message, so it is safe to return.
      return fail(request.id, RPC.INVALID_REQUEST, `params rejected: ${params.reason}`);
    }

    audit({ widgetId: widget.id, method: request.method, decision: "dispatched" });

    // Two independent protections, because they cover different failures:
    //
    //   the signal   lets a cooperative handler actually stop working — the
    //                fetch is cancelled, the backend connection released. This
    //                is the one that reclaims real resources.
    //   the race     stops the RUNTIME waiting on a handler that ignores the
    //                signal, or that is stuck in pure computation. Handlers are
    //                app code we do not control, so we cannot rely on courtesy.
    //
    // Without the race, a widget could pin unbounded memory by calling a slow
    // handler in a loop: each pending promise holds its closure forever.
    const signal = AbortSignal.any([
      widget.lifetime.signal,
      AbortSignal.timeout(options.callTimeoutMs ?? 30_000),
    ]);

    try {
      const outcome = await Promise.race([
        Promise.resolve(capability.handler(params.value, { signal })),
        new Promise<typeof ABANDONED>((resolve) => {
          signal.addEventListener("abort", () => resolve(ABANDONED), { once: true });
        }),
      ]);

      if (outcome === ABANDONED) {
        // The widget may already be gone; replying to a closed port is a no-op.
        audit({
          widgetId: widget.id,
          method: request.method,
          decision: "refused",
          reason: widget.lifetime.signal.aborted ? "widget destroyed" : "timed out",
        });
        return fail(request.id, RPC.TIMEOUT, "capability timed out");
      }

      return ok(request.id, outcome);
    } catch (error) {
      // Never hand the widget a raw error: messages can carry internal detail.
      // The real reason goes to the host's console, not across the wall.
      console.error(`[marzi] capability "${request.method}" threw:`, error);
      return fail(request.id, RPC.INTERNAL_ERROR, "capability failed");
    }
  }

  function render(body: WidgetBody, container: HTMLElement, renderOptions?: RenderOptions): Widget {
    // A saved widget renders under its record id — that continuity is what
    // makes its stored state (and, from rung 5, its grants) find it again.
    const id = renderOptions?.id ?? newWidgetId();

    // The screen: refuse outright if the body contains a listed sequence
    // anywhere. Refusal only — the body is never edited — and it happens
    // before any DOM work, so a refused widget leaves no trace in the page.
    const hit = screen.find((entry) => body.includes(entry));
    if (hit !== undefined) {
      audit({ widgetId: id, method: "(screen)", decision: "refused", reason: `body contains "${hit}"` });
      throw new Error(
        `widget refused by screen: body contains "${hit}" ` +
          "(a screen for obvious misuse, not a containment control)",
      );
    }

    // Resolve library names before any DOM work, so a bad name costs nothing.
    const libSources = (renderOptions?.libs ?? []).map((name) => {
      const source = libraries.get(name);
      if (source === undefined) {
        throw new Error(`unknown library "${name}" — register it in createRuntime({ libraries })`);
      }
      return source;
    });

    const frame = document.createElement("iframe");

    // This frame is the WARDEN — ours, script-free — and the widget's own frame
    // lives inside it. The warden's `frame-src 'none'` is what stops the widget
    // navigating itself away with data in the URL; see jail.ts.
    //
    // Deny-by-default: `sandbox` strips nearly every privilege, and each token
    // hands one back. We grant exactly one — sandbox flags are inherited by
    // nested frames, so the widget's scripts need the warden to allow scripts,
    // though the warden itself runs none. Withholding `allow-same-origin` is
    // what makes both frames nobodies, with DIFFERENT opaque origins.
    frame.setAttribute("sandbox", SANDBOX_TOKENS);

    // Two further mechanisms, each governing an axis the sandbox does not:
    // Permissions Policy (device features) and referrer policy (what the frame
    // discloses about us when it causes a request). See jail.ts.
    frame.setAttribute("allow", FRAME_ALLOW);
    frame.setAttribute("referrerpolicy", FRAME_REFERRER_POLICY);

    frame.srcdoc = warden(scaffold(body, libSources));

    // The private line. port1 stays here; port2 is handed to the widget and
    // becomes the only way it can reach us.
    const channel = new MessageChannel();

    // Created HERE, in the closure that owns the port. Everything downstream
    // learns who is calling from the channel the message arrived on, never from
    // the message itself — which is why a widget cannot impersonate another.
    const widget: LiveWidget = {
      id,
      frame,
      port: channel.port1,
      lifetime: new AbortController(),
      rate: { start: 0, count: 0 },
    };

    channel.port1.onmessage = (event: MessageEvent): void => {
      void handleMessage(widget, event.data).then((response) => {
        if (response !== null) channel.port1.postMessage(response);
      });
    };

    // The handshake. We listen on the party line for the widget's knock, verify
    // it really came from the widget's frame, and answer exactly once.
    let portIssued = false;
    const onKnock = (event: MessageEvent): void => {
      if (portIssued) return;

      // Identity is the WINDOW, never the origin: an opaque frame's origin is
      // the useless string "null", but `event.source` is set by the browser and
      // cannot be forged. The widget's window is the warden's first child —
      // reachable cross-origin because `frames[i]` is on the small allowlist of
      // window properties any origin may read. A different frame (including
      // the warden itself) shouting "ready" fails this check.
      const inner = frame.contentWindow?.frames[0];
      if (inner === undefined || event.source !== inner) return;

      const data = event.data as { marzi?: unknown } | null;
      if (!data || data.marzi !== "ready") return;

      // Answer once and stop listening. Never re-issue: a second port would be
      // a second, unaccounted-for line into the same jail. The port goes
      // straight to the widget's window; the warden never handles it.
      portIssued = true;
      clearTimeout(startTimer);
      window.removeEventListener("message", onKnock);
      inner.postMessage({ marzi: "port" }, "*", [channel.port2]);
    };
    window.addEventListener("message", onKnock);

    // A frame that never knocks would otherwise leave this listener attached
    // for the life of the page, and leave the host with a blank rectangle and
    // no idea why. Give up after a while and say so.
    const startTimer = setTimeout(() => {
      if (portIssued) return;
      window.removeEventListener("message", onKnock);
      reportFault(id, "never-started", "widget did not complete its handshake");
    }, options.startTimeoutMs ?? 10_000);

    // Attach last: the frame does not begin loading until it is in the
    // document, so everything above is in place before any widget code runs.
    container.appendChild(frame);

    return {
      id,
      frame,
      destroy(): void {
        // Abort first: any call still in flight gets its signal, so handlers
        // that honour it release their work instead of finishing into a void.
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
