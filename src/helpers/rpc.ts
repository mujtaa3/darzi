/**
 * The message layer's helpers: build replies, check each message that comes
 * in from a widget, count messages for the rate limit, and clean params.
 *
 * A port only carries messages. It does not link a reply to its request.
 * JSON-RPC 2.0 adds that link: each request has an `id`, and its reply has
 * the same `id`. A message without an `id` is a notification, which gets no
 * reply. Spec: https://www.jsonrpc.org/specification
 */

import { MAX_PARAM_DEPTH, MAX_PARAM_NODES, MAX_PARAM_TEXT, PROTOTYPE_KEYS } from "../consts/rpc.js";
import type { RateWindow, RpcId, RpcNotification, RpcRequest, RpcResponse, SanitizeResult } from "../types/rpc.js";

/** Make a successful reply. */
export function ok(id: RpcId, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}

/** Make an error reply. The codes are in consts/rpc.ts. */
export function fail(id: RpcId, code: number, message: string): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Check a message from a widget. Returns null if it is not a correct request.
 *
 * It BUILDS A NEW request; it does not use the widget's object. The widget's
 * object could carry extra properties. The new one has only the four known
 * fields, and the rest are dropped.
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
 * Check a message from a widget. Returns null if it is not a notification.
 *
 * A notification has no `id`, so a message with an `id` is not one. Like
 * `parseRequest`, it builds a new object with only the known fields.
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

/**
 * The rate limit. Returns true if this message is within the limit.
 *
 * It changes `w`. It uses no browser APIs, so a unit test could call it
 * directly. Today only the browser suite tests it (messages.spec.ts).
 *
 * The windows are fixed: each one starts when the previous one ends. So a
 * burst across the edge of two windows can briefly reach twice the limit.
 * That is acceptable for flood control, which limits the cost over time. It
 * would not be acceptable for billing.
 */
export function withinRate(w: RateWindow, now: number, calls: number, windowMs: number): boolean {
  if (now - w.start >= windowMs) {
    w.start = now;
    w.count = 0;
  }
  w.count += 1;
  return w.count <= calls;
}

/**
 * True exactly once in each window: for the first message over the limit.
 * The switchboard records only that one in the audit.
 */
export function justCrossedRate(w: RateWindow, calls: number): boolean {
  return w.count === calls + 1;
}

/**
 * Build a clean copy of a value from a widget. It drops the keys that change
 * prototypes, limits the shape, and never changes the widget's object.
 *
 * It builds new plain objects and arrays. Some types cannot carry a prototype
 * key, so they pass through unchanged: Date, RegExp and binary data. Their
 * sizes count against the text limit, so that none of them can be the huge
 * value that a string may not be: a RegExp counts its source and flags, an
 * ArrayBuffer its bytes, and a typed array or DataView the WHOLE buffer behind
 * the view, because the structured clone copies the whole buffer. A view over
 * a SharedArrayBuffer is refused. An array longer than MAX_PARAM_NODES is
 * refused before it is copied, because `map` visits every slot, also the
 * empty ones that the node count never sees. It refuses every other type, for
 * example Map, Set or Error. Params are JSON-like data, plus dates and binary
 * data. A widget that needs more can encode it.
 *
 * The new objects keep the normal prototype. A null prototype would break
 * `params.hasOwnProperty(...)` in handler code, and it adds no protection
 * after the dangerous keys are gone.
 */
export function sanitizeParams(input: unknown): SanitizeResult {
  let nodes = 0;
  let text = 0;

  // Add to the total size of text and binary data; throw over the limit.
  const budget = (amount: number): void => {
    text += amount;
    if (text > MAX_PARAM_TEXT) throw new RangeError("too much data");
  };

  // Copy one value, and the values inside it. A throw means "refuse".
  function walk(value: unknown, depth: number): unknown {
    if (depth > MAX_PARAM_DEPTH) throw new RangeError("nested too deeply");
    if (++nodes > MAX_PARAM_NODES) throw new RangeError("too many values");

    if (typeof value === "string") {
      budget(value.length);
      return value;
    }
    if (value === null || typeof value !== "object") return value;

    if (Array.isArray(value)) {
      // `map` visits every slot up to `length`, also the empty ones, which the
      // node count below never sees. A widget can make `new Array(1e8)` at no
      // cost, so check the length first (tested: one such array blocked the
      // host page for 0.2 to 2.4 s).
      if (value.length > MAX_PARAM_NODES) throw new RangeError("too many values");
      // A copy by index also drops extra properties that are not indexes.
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

    if (value instanceof Date) return value;
    if (value instanceof RegExp) {
      // The source is text that a handler may store or run, so it counts.
      budget(value.source.length + value.flags.length);
      return value;
    }
    if (value instanceof ArrayBuffer) {
      budget(value.byteLength);
      return value;
    }
    if (ArrayBuffer.isView(value)) {
      // The clone copies the whole buffer, not only the view's window on it.
      // A view over a SharedArrayBuffer is refused: shared memory is not data.
      if (!(value.buffer instanceof ArrayBuffer)) throw new RangeError("unsupported value type");
      budget(value.buffer.byteLength);
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
