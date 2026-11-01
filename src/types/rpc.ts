/**
 * The message types on the channel: JSON-RPC 2.0 requests, replies and
 * notifications, plus two internal types of the checks in helpers/rpc.ts.
 *
 * ⚠️ TypeScript removes these types at compile time. They describe the shape
 * that marzi expects. Only `readId`, `parseRequest` and `parseNotification` in
 * helpers/rpc.ts check it, because a widget can send any value at all.
 */

/**
 * The id of a request. The widget chooses it, and its reply has the same id. A
 * string id has `MAX_ID_LENGTH` characters or fewer.
 */
export type RpcId = string | number;

/** A request: the widget asks the host for something, and waits for a reply. */
export interface RpcRequest {
  jsonrpc: "2.0";
  id: RpcId;
  /** A capability name, or a built-in such as "marzi/saveState". */
  method: string;
  /** Anything. The widget chose it, so `sanitizeParams` must clean it. */
  params?: unknown;
}

/** The host's reply to one request. It has a `result` or an `error`, not both. */
export interface RpcResponse {
  jsonrpc: "2.0";
  id: RpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * A notification: a message with NO id, so it gets no reply.
 *
 * A widget sends one to tell the host something, not to ask for something.
 * Today there is only one: `marzi/fault`, when the widget's code throws.
 */
export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** The rate-limit counter for one widget. `withinRate` changes it. */
export interface RateWindow {
  /** When the current window started, in milliseconds (Date.now()). */
  start: number;
  /** How many messages arrived in the current window. */
  count: number;
}

/** What `sanitizeParams` returns: the clean value, or why it refused. */
export type SanitizeResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };
