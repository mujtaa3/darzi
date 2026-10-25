/**
 * The runtime's constants: the version, the default forbidden text, the
 * default limits of `RuntimeOptions`, the limits on fault text, and the UTF-8
 * encoder that measures saved state.
 */

/** Library version, exported so a host can record which marzi produced a log line or a saved widget. */
export const VERSION = "0.1.0";

/**
 * The default forbidden text: character sequences that make `render` refuse a widget
 * whose body contains any of them, anywhere — code, comments and prose alike.
 * Currently the WebRTC API names, because WebRTC is a network path no CSP
 * setting closes in any engine we test (tests/attacks/webrtc.spec.ts).
 *
 * ⚠️ A check for obvious misuse, NOT a containment control. It sees only the
 * body at render time: text that reaches the widget later through capability
 * data never passes through it, and JavaScript can reach names it assembles
 * while running. The WebRTC residual in the README stands regardless.
 */
export const DEFAULT_FORBIDDEN_TEXT: readonly string[] = Object.freeze([
  "RTCPeerConnection",
  "RTCDataChannel",
  "RTCSessionDescription",
  "RTCIceCandidate",
]);

/** Default for `RuntimeOptions.rateLimit`: at most 120 messages in each 10 s window. */
export const DEFAULT_RATE_LIMIT = Object.freeze({ calls: 120, windowMs: 10_000 });

/** Default for `RuntimeOptions.stateLimitBytes`. */
export const DEFAULT_STATE_LIMIT_BYTES = 64_000;

/** Default for `RuntimeOptions.callTimeoutMs`. Keep it under the stub's 60 s backstop (`NO_ANSWER_MS` in frame-stub.js). */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** Default for `RuntimeOptions.startTimeoutMs`. */
export const DEFAULT_START_TIMEOUT_MS = 10_000;

/** Distinguishes "the runtime gave up" from a value a handler actually returned. */
export const ABANDONED = Symbol("abandoned");

/** Sanity ceiling for a reported line or column. */
export const MAX_POSITION = 1_000_000;

/** Longest widget-authored message we will carry across the wall. */
export const MAX_FAULT_MESSAGE = 300;
/** Longest error class name we will carry ("TypeError" is 9). */
export const MAX_FAULT_NAME = 40;

/** Measures saved state in UTF-8 bytes, the unit that stores count. */
export const UTF8 = new TextEncoder();
