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

/** Standard JSON-RPC error codes, plus our own reasons in the -320xx range. */
export const RPC = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INTERNAL_ERROR: -32603,
  /** -32000..-32099 is reserved by JSON-RPC for implementation-defined errors. */
  TIMEOUT: -32001,
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
