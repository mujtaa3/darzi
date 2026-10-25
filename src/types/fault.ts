/**
 * Faults: one report for each widget that fails to start or throws an error.
 * The host gets them through `onWidgetFault`.
 *
 * Types only. TypeScript removes them at compile time.
 */

/**
 * A widget that does not work. With it, the host can show an error instead of
 * an empty box.
 */
export interface WidgetFault {
  /** The widget, taken from its port. */
  widgetId: string;
  /**
   * `never-started`: the frame did not complete its handshake. Causes: a broken
   * scaffold, a widget that disabled the stub, or a frame that navigated away
   * while it loaded.
   *
   * `script-error`: the widget's code threw an error, or one of its promises
   * failed and no code handled the failure.
   */
  kind: "never-started" | "script-error";
  /**
   * ⚠️ For `script-error`, the widget wrote this text, and it arrives in the
   * host page. Escape it. Never put it in `innerHTML`. The runtime limits its
   * length, but it cannot check its content. Browsers often copy values into
   * error messages ("reading 'merchant'", or a JSON error that quotes its
   * input), so the text can contain data that the widget received.
   */
  message: string;
  /**
   * `script-error` only: the error's type as the widget reported it, for
   * example "TypeError". The widget wrote it; 40 characters or fewer. Absent
   * when the thrown value had no name.
   */
  name?: string;
  /**
   * `script-error` only: the line where the error was thrown, counted from line
   * 1 of the HTML given to `render`. Absent for a failed promise, and for a
   * position outside the widget HTML, for example in a vendored library. The
   * widget reports this line, so it is a claim, not a measurement.
   */
  line?: number;
  /** `script-error` only: the column on `line`, counted from 1. Present only with `line`. */
  column?: number;
}
