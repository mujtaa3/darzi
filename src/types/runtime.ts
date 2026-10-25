/**
 * The runtime: the options that `createRuntime` takes, and the object that it
 * returns. Types for the whole runtime are here; types for one widget are in
 * widget.ts.
 *
 * Types only. TypeScript removes them at compile time. The code is in
 * ../runtime.ts.
 */

import type { StateStore } from "../store.js";
import type { AuditEvent } from "./audit.js";
import type { Capability } from "./capability.js";
import type { WidgetFault } from "./fault.js";
import type { Library, RenderOptions, Widget, WidgetBody } from "./widget.js";

/** The options for `createRuntime`. You give them once, for the whole runtime. */
export interface RuntimeOptions {
  /** The operations that widgets can call. In 0.1.0, each widget can call each one. */
  capabilities: Capability[];
  /** The libraries that the host vendors. `render` adds them to a widget's frame by name. */
  libraries?: Library[];
  /**
   * Character sequences that make `render` refuse widget HTML that contains
   * any of them. See `DEFAULT_FORBIDDEN_TEXT` for what this can and cannot do.
   *
   * This list is complete: marzi adds nothing to it. To extend the default,
   * give `[...DEFAULT_FORBIDDEN_TEXT, "x"]`. To replace it, give your own list.
   * To turn it off, give `[]`. Matching is exact and case-sensitive. Library
   * sources are not checked, because they are the host's own text.
   */
  forbiddenText?: readonly string[];
  /**
   * Where `marzi.saveState` and `marzi.loadState` save and load. Without a
   * store, the runtime refuses those calls. The store gets an opaque JSON
   * string for each widget id, and it never needs to read the state.
   */
  store?: StateStore;
  /**
   * The largest state that one widget can save, in UTF-8 bytes of its JSON.
   * This is its size on the way to the store, and the unit that most backends
   * count. Default 64 000. The widget writes the state, so it is hostile. This
   * limit stops a widget from filling the host's storage.
   */
  stateLimitBytes?: number;
  /**
   * Called for each switchboard decision. Must not throw. Over the rate limit,
   * only the first refusal in each window is recorded. Notifications, such as
   * faults, are not recorded.
   */
  onAudit?: (event: AuditEvent) => void;
  /** Called when a widget does not start, or when its code throws. Must not throw. */
  onWidgetFault?: (fault: WidgetFault) => void;
  /** How long to wait for a widget's handshake before the runtime reports `never-started`. Default 10 s. */
  startTimeoutMs?: number;
  /**
   * The most messages that one widget can send: `calls` in each window of
   * `windowMs`. Each message counts, including notifications and malformed
   * messages, because a widget can flood with any of them. The windows are
   * fixed, so a burst across two windows can briefly reach twice the limit.
   * That is acceptable for flood control, not for billing. Default 120 in 10 s.
   */
  rateLimit?: { calls: number; windowMs: number };
  /**
   * How long a capability call or a store call can run before the runtime
   * stops waiting. Default 30 s. The handler's `signal` aborts at the same
   * time. Keep it under 60 s, because the in-frame helper gives up after 60 s.
   */
  callTimeoutMs?: number;
}

/** What `createRuntime` returns. */
export interface Runtime {
  /** Render widget HTML into `container`, and return the widget's handle. */
  render(body: WidgetBody, container: HTMLElement, options?: RenderOptions): Widget;
}
