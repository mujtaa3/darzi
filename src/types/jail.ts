/**
 * The jail's types: what `scaffold` returns. Internal: index.ts does not
 * export them.
 *
 * Types only. TypeScript removes them at compile time.
 */

/** A composed widget document, and the lines of it that hold the widget HTML. */
export interface Scaffold {
  /** The complete document, ready to put in the warden. */
  html: string;
  /** The first and the last document line of the widget HTML. 1-based; both lines included. */
  bodyLines: { first: number; last: number };
}
