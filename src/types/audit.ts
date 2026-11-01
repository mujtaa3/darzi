/**
 * The audit: one event for each switchboard decision. The host gets them
 * through `onAudit`.
 *
 * Types only. TypeScript removes them at compile time.
 */

/**
 * One switchboard decision about one call from a widget.
 *
 * Without these events, the host cannot see refusals: a refused call and a
 * call that never happened look the same. The audit log is built from them.
 */
export interface AuditEvent {
  /**
   * The widget that sent the call. The runtime takes it from the port that the
   * message came on, never from the message. So a widget cannot claim to be a
   * different widget.
   */
  widgetId: string;
  /**
   * The method that the widget called, or a marker such as "(rate limit)".
   * For "no such capability" it is the widget's own text, cut to 300
   * characters. Show it as text, never as HTML.
   */
  method: string;
  /**
   * `dispatched`: the switchboard sent the call to its handler or to the store.
   * `refused`: the switchboard refused the call, or the call did not complete.
   *
   * One call can log `dispatched` and then `refused`. The reason is then
   * "timed out", "widget destroyed", "result not cloneable", "capability
   * failed" (the handler threw) or "state operation failed" (the store threw).
   * The runtime records the refusal before it tells the widget.
   */
  decision: "dispatched" | "refused";
  /**
   * Why the call was refused. Present only on refusals. Safe to show a developer,
   * not a widget. The README names the reasons that stay the same until 1.0.
   */
  reason?: string;
  /** The marzi `VERSION` that made the decision, so that old log entries stay clear after an upgrade. */
  version: string;
}
