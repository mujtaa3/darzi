/**
 * The runtime's helpers: waiting with a deadline, cleaning what a widget
 * reports in a fault, and making widget ids.
 */

import { ABANDONED, MAX_POSITION } from "../consts/runtime.js";
import type { LiveWidget } from "../types/widget.js";

/**
 * Wait for `work`, but stop waiting when `signal` aborts.
 *
 * The result settles like whichever comes first:
 *   - the work finishes: its value;
 *   - the work fails: the same error (the caller's try/catch records it);
 *   - the signal aborts: ABANDONED, a unique symbol that no handler can
 *     return, so the caller knows for certain that the runtime gave up.
 *
 * This does NOT stop the work. A handler that ignores the signal keeps
 * running; the runtime only stops waiting for it. That still matters: without
 * it, a handler that never finishes would keep the call open for ever.
 *
 * Used for each capability handler and each store call. The signal comes from
 * `callSignal`: it aborts at the deadline, or when the widget is destroyed.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof ABANDONED> {
  // An "abort" event fires only once. If the signal aborted before now, the
  // listener below would never fire, and the race would wait for ever. So
  // answer at once.
  if (signal.aborted) return Promise.resolve(ABANDONED);
  return Promise.race([
    work,
    // Resolves to ABANDONED when the signal aborts. `once` removes the listener
    // after it fires.
    new Promise<typeof ABANDONED>((resolve) => {
      signal.addEventListener("abort", () => resolve(ABANDONED), { once: true });
    }),
  ]);
}

/** Why the runtime stopped waiting for a call. For the audit only; the widget never sees it. */
export function abandonReason(widget: LiveWidget): string {
  return widget.lifetime.signal.aborted ? "widget destroyed" : "timed out";
}

/**
 * Cut widget text to `max` UTF-16 units or fewer, without splitting a
 * surrogate pair. JavaScript counts string length in UTF-16 units, and a
 * character outside the Basic Multilingual Plane (most emoji) takes two. A cut
 * between the two would give the host broken text that marzi itself made.
 */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Make widget text safe for one line of host UI, a log, or a prompt. It
 * replaces each line break with a space, removes the characters that change
 * the direction of text (they can hide or reorder what a reader sees), and
 * replaces a surrogate half that has no partner with U+FFFD. The stub cuts
 * text with `slice`, which can leave such a half. Use it after `clampText`, so
 * that it works on a short text.
 */
export function oneLine(text: string): string {
  return text
    .replace(/\r\n|[\r\n\u2028\u2029]/g, " ")
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[\uD800-\uDFFF]/g, (half: string, at: number, whole: string) => {
      // A high half pairs with the low half after it; a low half with the high
      // half before it. charCodeAt gives NaN past either end, so no partner.
      const code = half.charCodeAt(0);
      const partner = whole.charCodeAt(code <= 0xdbff ? at + 1 : at - 1);
      const paired = code <= 0xdbff ? partner >= 0xdc00 && partner <= 0xdfff : partner >= 0xd800 && partner <= 0xdbff;
      return paired ? half : "\uFFFD";
    });
}

/** A line or column that a widget reported: a positive whole number, or nothing. */
export function position(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value < MAX_POSITION
    ? value
    : undefined;
}

/** Make an id for a widget that was rendered without one. */
export function newWidgetId(): string {
  // randomUUID needs a secure context. localhost is one, but the fallback stops
  // a plain-http test server from throwing.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `w_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
