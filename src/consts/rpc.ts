/**
 * The constants of the message layer: the JSON-RPC error codes, the limit on a
 * request's id, and the limits that `sanitizeParams` puts on the params of each
 * call.
 */

/** Standard JSON-RPC error codes, plus our own reasons in the -320xx range. */
export const RPC = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INTERNAL_ERROR: -32603,
  /** -32000..-32099 is reserved by JSON-RPC for implementation-defined errors. */
  TIMEOUT: -32001,
  RATE_LIMITED: -32002,
} as const;

/**
 * The longest string id of a request, in characters. A reply repeats its id, so
 * with no limit a widget could make the host copy and hold any amount of text.
 * The stub's ids are numbers, so only code on the raw port can reach this limit.
 */
export const MAX_ID_LENGTH = 300;

/**
 * Keys that rewrite an object's prototype chain instead of storing data.
 *
 * `structuredClone` delivers an own property literally named `__proto__`
 * across the port intact (measured). darzi itself never merges params, so the
 * runtime is not vulnerable — but a handler that recursively merges them
 * (lodash.merge, a hand-rolled config merger) would write through that key
 * into `Object.prototype`: the one hidden object every plain object in the
 * page consults for properties it doesn't have. One poisoned call would change
 * the behaviour of every object in the app. Handlers are app-developer code,
 * so the lever is removed here at the boundary rather than trusting every
 * downstream call site to know about a JavaScript-only hazard.
 */
export const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Shape bounds for inbound params. They protect three things at once: this
 * module's own recursion (stack depth), handlers (a 50MB blob of nested junk
 * is perfectly legal structured-clone), and whatever later logs or stores the
 * params.
 */
export const MAX_PARAM_DEPTH = 32;
export const MAX_PARAM_NODES = 10_000;
/** Total budget in characters/bytes across all strings, keys, and binary. */
export const MAX_PARAM_TEXT = 1_000_000;
