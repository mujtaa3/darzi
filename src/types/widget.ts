/**
 * Widgets: the HTML that a host renders, the libraries that it can add to the
 * frame, the handle that `render` returns, and the runtime's own record of a
 * rendered widget (`LiveWidget`, internal).
 *
 * Types only. TypeScript removes them at compile time.
 */

import type { RateWindow } from "./rpc.js";

/**
 * A widget's HTML, exactly as the model wrote it.
 *
 * Hostile by assumption. marzi never trusts it, and runs it only inside the
 * jail.
 */
export type WidgetBody = string;

/**
 * A library that the host gives to widgets, for example Chart.js as a string.
 *
 * `source` is JavaScript text that runs in a browser and sets a global (an
 * IIFE or UMD build). The runtime puts it inline in the frame's `<head>` when
 * the host names it in `RenderOptions.libs`. The host gets and pins this text
 * when it builds. marzi never fetches anything, so the frame stays without a
 * network.
 *
 * The text runs inside the jail, so it has no authority: it cannot call
 * anything that the widget cannot call. The host decides which library text
 * to trust, as it does for any other dependency.
 */
export interface Library {
  /** The name that the host uses in `RenderOptions.libs`, for example "chartjs". marzi does not interpret it. */
  name: string;
  /** The full library source, ready to run as one inline script. */
  source: string;
}

/** Options for one call to `render`. */
export interface RenderOptions {
  /**
   * The registered libraries to put in this widget's frame. An unknown name
   * throws, because it is a host error. It is better to fail here than to let
   * the widget fail in the jail on a missing global.
   */
  libs?: string[];
  /**
   * The widget's lasting identity: the id of its saved record. The runtime
   * keys saved state by this id. So a saved widget that renders with its
   * record id gets its state back. Without an id, the runtime makes a new one,
   * and the widget is temporary.
   *
   * Make it unique across all your users, because the store finds state by this
   * id. A backend store must also check that the signed-in user owns it.
   */
  id?: string;
}

/** A rendered widget: its id, its frame, and how to remove it. */
export interface Widget {
  /** The widget's id. Audit entries and saved state use it, and grants will use it too. */
  id: string;
  /**
   * The outer frame in the host page: the warden, which holds the widget's own
   * frame. Size and place this frame. If you remove it from the page, both
   * frames go, but the runtime keeps its listeners and its port. Call
   * `destroy()` to release them.
   */
  frame: HTMLIFrameElement;
  /** Stop listening, and remove the widget. */
  destroy(): void;
}

/**
 * What the runtime knows about one rendered widget. Internal: index.ts does
 * not export it, and a host never sees it. `render` makes one for each widget.
 */
export interface LiveWidget {
  id: string;
  frame: HTMLIFrameElement;
  /**
   * The host's end of the widget's current channel, or null when no channel is
   * open: before the first handshake, and after `destroy()`. Each load of the
   * frame, after a move or a reload, gets a new channel. The port that a
   * message arrives on is the widget's identity.
   */
  port: MessagePort | null;
  /** Aborted when the widget is destroyed, so that calls in progress stop too. */
  lifetime: AbortController;
  /** The counter for the rate limit (see RuntimeOptions.rateLimit). */
  rate: RateWindow;
  /** The lines of the frame's document that hold the widget HTML, for fault lines. */
  bodyLines: { first: number; last: number };
}
