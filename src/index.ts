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
import { SANDBOX_TOKENS, scaffold } from "./jail.js";
import { fail, ok, parseRequest, RPC, type RpcResponse } from "./rpc.js";

/** Library version. Goes into audit entries, so a log line names the code that produced it. */
export const VERSION = "0.0.0";

/**
 * A widget's HTML body, exactly as the model wrote it.
 *
 * Hostile by assumption: never trusted, never scanned for safety, and never
 * run anywhere but inside the jail.
 */
export type WidgetBody = string;

/**
 * What a capability actually does, written by the app developer.
 *
 * This runs on the HOST side, in the app's page, under the app's existing
 * session — which is why the widget never needs a token and never touches the
 * network. Think of it as a handler on a Go mux.
 *
 * `params` is `unknown` on purpose: it came from hostile code, so the handler
 * must narrow it before use.
 */
export type CapabilityHandler = (params: unknown) => unknown | Promise<unknown>;

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

/** A rendered widget: its frame, and the host's end of its private line. */
export interface Widget {
  /** The jail. Remove it from the DOM to destroy the widget. */
  frame: HTMLIFrameElement;
  /** Stop listening and tear the widget down. */
  destroy(): void;
}

/**
 * What the switchboard decided about one inbound call.
 *
 * Without this the host is blind to refusals — the runtime declines silently and
 * nothing outside can tell an ungranted call from one that never happened. This
 * is the seed of the audit log; it will grow a widget id and a timestamp once
 * rung 3.7 lands the `port → widgetId` map.
 */
export interface AuditEvent {
  method: string;
  decision: "dispatched" | "refused";
  /** Present on refusal: why. Safe to show a developer, not a widget. */
  reason?: string;
}

export interface RuntimeOptions {
  capabilities: Capability[];
  /** Called for every inbound call, allowed or not. Must not throw. */
  onAudit?: (event: AuditEvent) => void;
}

export interface Runtime {
  render(body: WidgetBody, container: HTMLElement): Widget;
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
    registry.set(capability.name, capability);
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

  async function handleMessage(raw: unknown): Promise<RpcResponse | null> {
    const request = parseRequest(raw);
    if (request === null) {
      // Malformed and unidentifiable — there is no id to answer to, so the only
      // safe move is to drop it. Answering a message we cannot parse would mean
      // trusting a field from it.
      audit({ method: "(unparseable)", decision: "refused", reason: "malformed message" });
      return null;
    }

    const capability = registry.get(request.method);
    if (capability === undefined) {
      audit({ method: request.method, decision: "refused", reason: "no such capability" });
      return fail(request.id, RPC.METHOD_NOT_FOUND, `no such capability: ${request.method}`);
    }

    audit({ method: request.method, decision: "dispatched" });

    try {
      const result = await capability.handler(request.params);
      return ok(request.id, result);
    } catch (error) {
      // Never hand the widget a raw error: messages can carry internal detail.
      // The real reason goes to the host's console, not across the wall.
      console.error(`[marzi] capability "${request.method}" threw:`, error);
      return fail(request.id, RPC.INTERNAL_ERROR, "capability failed");
    }
  }

  function render(body: WidgetBody, container: HTMLElement): Widget {
    const frame = document.createElement("iframe");

    // Deny-by-default: `sandbox` strips nearly every privilege, and each token
    // hands one back. We grant exactly one, because a widget that cannot run
    // JavaScript is useless. Withholding `allow-same-origin` is what makes the
    // frame a nobody — see jail.ts.
    frame.setAttribute("sandbox", SANDBOX_TOKENS);
    frame.srcdoc = scaffold(body);

    // The private line. port1 stays here; port2 is handed to the widget and
    // becomes the only way it can reach us.
    const channel = new MessageChannel();

    channel.port1.onmessage = (event: MessageEvent): void => {
      void handleMessage(event.data).then((response) => {
        if (response !== null) channel.port1.postMessage(response);
      });
    };

    // The handshake. We listen on the party line for the widget's knock, verify
    // it really came from this frame, and answer exactly once.
    let portIssued = false;
    const onKnock = (event: MessageEvent): void => {
      if (portIssued) return;

      // Identity is the WINDOW, never the origin: an opaque frame's origin is
      // the useless string "null", but `event.source` is set by the browser and
      // cannot be forged. A different frame shouting "ready" fails this check.
      if (event.source !== frame.contentWindow) return;

      const data = event.data as { marzi?: unknown } | null;
      if (!data || data.marzi !== "ready") return;

      // Answer once and stop listening. Never re-issue: a second port would be
      // a second, unaccounted-for line into the same jail.
      portIssued = true;
      window.removeEventListener("message", onKnock);
      frame.contentWindow?.postMessage({ marzi: "port" }, "*", [channel.port2]);
    };
    window.addEventListener("message", onKnock);

    // Attach last: the frame does not begin loading until it is in the
    // document, so everything above is in place before any widget code runs.
    container.appendChild(frame);

    return {
      frame,
      destroy(): void {
        window.removeEventListener("message", onKnock);
        channel.port1.onmessage = null;
        channel.port1.close();
        frame.remove();
      },
    };
  }

  return { render };
}
