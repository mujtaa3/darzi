/**
 * Capabilities: the operations that a host registers, and the arguments that
 * each handler gets.
 *
 * Types only. TypeScript removes them at compile time.
 */

/** The second argument of each handler. */
export interface CallContext {
  /**
   * Aborts when the call passes `callTimeoutMs`, or when the widget is destroyed.
   * Pass it to `fetch` and to any other work that can stop. Otherwise that work
   * keeps running after the runtime stops waiting. The runtime stops waiting when
   * this signal aborts, so a result that you make after the abort may not reach
   * the widget.
   */
  signal: AbortSignal;
  /**
   * The id of the widget that made this call. The runtime takes it from the port
   * that the call came on, never from the message, so a widget cannot claim another
   * id. Use it to say which widget is asking, for example in a confirmation dialog.
   */
  widgetId: string;
}

/**
 * The function that does the work of a capability. The app developer writes it.
 *
 * It runs on the host side, in the app's page, with the app's session. Thus
 * the widget never needs a token and never uses the network.
 *
 * The type of `params` is `unknown` because the params come from hostile code.
 * Check their type and shape before you use them.
 */
export type CapabilityHandler = (
  params: unknown,
  context: CallContext,
) => unknown | Promise<unknown>;

/** A named operation that the host registers. Widgets call it by its name. */
export interface Capability {
  /** The name that widgets call, for example "transactions.list". */
  name: string;
  /**
   * A description for people and for the model. It is shown at generation time.
   *
   * ⚠️ Documentation only. The description does not limit what a widget can do.
   * Only the validation in the handler limits it.
   */
  description: string;
  handler: CapabilityHandler;
}
