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
   * keeps running after the runtime stops waiting.
   */
  signal: AbortSignal;
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
   * A description for people and for the model. It is shown at generation time
   * and at approval time.
   *
   * ⚠️ Documentation only. The description does not limit what a widget can do.
   * Only the validation in the handler limits it.
   */
  description: string;
  handler: CapabilityHandler;
}
