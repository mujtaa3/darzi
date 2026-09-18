/**
 * JSON-RPC 2.0 — the request/response convention we run over the port.
 *
 * The port is fire-and-forget: nothing links a reply to its request. JSON-RPC
 * fixes that with one idea — every request carries an `id`, and its response
 * echoes the same `id` back. Correlation IDs on an async bus.
 *
 * ⚠️ These interfaces are erased at compile time. They describe the shape we
 * INTEND; `parseRequest` below is the only thing that enforces it. A widget can
 * put anything on the wire, so every inbound message is checked by real code.
 */

export type RpcId = string | number;

export interface RpcRequest {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: RpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * A notification: a method with **no id**, which therefore gets no reply.
 *
 * The widget uses these to tell the host something rather than ask for
 * something — currently only that its own code threw.
 */
export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** Standard JSON-RPC error codes, plus our own reasons in the -320xx range. */
export const RPC = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INTERNAL_ERROR: -32603,
  /** -32000..-32099 is reserved by JSON-RPC for implementation-defined errors. */
  TIMEOUT: -32001,
  RATE_LIMITED: -32002,
} as const;

export function ok(id: RpcId, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function fail(id: RpcId, code: number, message: string): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Validate an inbound message. Returns null if it is not a well-formed request.
 *
 * Note that this REBUILDS the request from scratch rather than casting the
 * incoming object. Casting would keep whatever extra properties the widget
 * smuggled in; rebuilding keeps exactly the four fields we know about and drops
 * the rest on the floor.
 */
export function parseRequest(raw: unknown): RpcRequest | null {
  if (typeof raw !== "object" || raw === null) return null;

  const msg = raw as Record<string, unknown>;
  if (msg["jsonrpc"] !== "2.0") return null;

  const id = msg["id"];
  if (typeof id !== "string" && typeof id !== "number") return null;

  const method = msg["method"];
  if (typeof method !== "string") return null;

  return { jsonrpc: "2.0", id, method, params: msg["params"] };
}

/**
 * Validate an inbound notification. Returns null if it is not one.
 *
 * The absence of `id` is what makes it a notification, so a message carrying an
 * id is a request and is rejected here. Rebuilt rather than cast, for the same
 * reason as `parseRequest`.
 */
export function parseNotification(raw: unknown): RpcNotification | null {
  if (typeof raw !== "object" || raw === null) return null;

  const msg = raw as Record<string, unknown>;
  if (msg["jsonrpc"] !== "2.0") return null;
  if ("id" in msg) return null;

  const method = msg["method"];
  if (typeof method !== "string") return null;

  return { jsonrpc: "2.0", method, params: msg["params"] };
}

/** Mutable counter state for one widget's flood window. */
export interface RateWindow {
  start: number;
  count: number;
}

/**
 * Fixed-window flood check. Returns true if this message is within budget.
 *
 * Mutates `w`. Lives here, away from the DOM, so it can be exercised directly
 * in a test runner — the browser harness has proven unreliable for anything
 * timing-dependent, and this is the kind of logic that must not be trusted to
 * eyeballing.
 *
 * Fixed windows, not a token bucket: a burst straddling a boundary can briefly
 * reach 2× the nominal rate. That is acceptable for flood control (the point is
 * bounding sustained cost) and would not be for billing.
 */
export function withinRate(w: RateWindow, now: number, calls: number, windowMs: number): boolean {
  if (now - w.start >= windowMs) {
    w.start = now;
    w.count = 0;
  }
  w.count += 1;
  return w.count <= calls;
}

/** True exactly once per window, on the message that crosses the limit. */
export function justCrossedRate(w: RateWindow, calls: number): boolean {
  return w.count === calls + 1;
}

/**
 * Keys that rewrite an object's prototype chain instead of storing data.
 *
 * `structuredClone` delivers an own property literally named `__proto__`
 * across the port intact (measured). marzi itself never merges params, so the
 * runtime is not vulnerable — but a handler that recursively merges them
 * (lodash.merge, a hand-rolled config merger) would write through that key
 * into `Object.prototype`: the one hidden object every plain object in the
 * page consults for properties it doesn't have. One poisoned call would change
 * the behaviour of every object in the app. Handlers are app-developer code,
 * so the lever is removed here at the boundary rather than trusting every
 * downstream call site to know about a JavaScript-only hazard.
 */
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Shape bounds for inbound params. They protect three things at once: this
 * module's own recursion (stack depth), handlers (a 50MB blob of nested junk
 * is perfectly legal structured-clone), and whatever later logs or stores the
 * params.
 */
const MAX_PARAM_DEPTH = 32;
const MAX_PARAM_NODES = 10_000;
/** Total budget in characters/bytes across all strings, keys, and binary. */
const MAX_PARAM_TEXT = 1_000_000;

export type SanitizeResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

/**
 * Rebuild an inbound value: drop prototype-rewriting keys, enforce shape
 * bounds, never mutate the widget's object.
 *
 * Plain objects and arrays are rebuilt. A short allowlist of clonable types
 * that cannot smuggle a prototype lever (Date, RegExp, binary) passes through,
 * with binary sizes charged against the text budget so an ArrayBuffer cannot
 * be the byte bomb a string is not allowed to be. Anything else — Map, Set,
 * Error, whatever the platform adds next — is refused rather than guessed at:
 * params are JSON-shaped data plus dates and binary, and a widget that needs
 * more can encode it.
 *
 * Rebuilt objects keep their normal prototype. A null prototype would also
 * break `params.hasOwnProperty(...)` in handler code, and buys nothing extra
 * once the dangerous keys are gone.
 */
export function sanitizeParams(input: unknown): SanitizeResult {
  let nodes = 0;
  let text = 0;

  const budget = (amount: number): void => {
    text += amount;
    if (text > MAX_PARAM_TEXT) throw new RangeError("too much data");
  };

  function walk(value: unknown, depth: number): unknown {
    if (depth > MAX_PARAM_DEPTH) throw new RangeError("nested too deeply");
    if (++nodes > MAX_PARAM_NODES) throw new RangeError("too many values");

    if (typeof value === "string") {
      budget(value.length);
      return value;
    }
    if (value === null || typeof value !== "object") return value;

    if (Array.isArray(value)) {
      // Rebuilding by index also sheds any smuggled non-index properties.
      return value.map((item) => walk(item, depth + 1));
    }

    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const clean: Record<string, unknown> = {};
      for (const key of Object.getOwnPropertyNames(value)) {
        if (PROTOTYPE_KEYS.has(key)) continue;
        budget(key.length);
        clean[key] = walk((value as Record<string, unknown>)[key], depth + 1);
      }
      return clean;
    }

    if (value instanceof Date || value instanceof RegExp) return value;
    if (value instanceof ArrayBuffer) {
      budget(value.byteLength);
      return value;
    }
    if (ArrayBuffer.isView(value)) {
      budget(value.byteLength);
      return value;
    }
    if (typeof Blob !== "undefined" && value instanceof Blob) {
      budget(value.size);
      return value;
    }

    throw new RangeError("unsupported value type");
  }

  try {
    return { ok: true, value: walk(input, 0) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "invalid params" };
  }
}
