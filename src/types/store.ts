/**
 * The storage types: a saved widget, its versions, and the contract that an
 * app's store implements.
 *
 * Types only. TypeScript removes them at compile time. The in-memory store is
 * in ../store.ts.
 */

/** One version of a widget's content. Do not change it after it is saved. */
export interface WidgetVersion {
  /** The version number, from 1. A refine or a repair adds the next one. */
  n: number;
  /** The widget HTML, exactly as the model wrote it. Hostile, as always. */
  body: string;
  /**
   * What this version DECLARED that it calls and uses. Each version has its
   * own lists, because a refine can change them. When grants exist, the
   * difference between two versions is what the user approves again.
   */
  capabilities: string[];
  libs: string[];
  /**
   * The user's request that made this version, kept so that the user can see
   * what they asked for. Treat it as text that an attacker could influence.
   */
  request: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
}

/** A saved widget: its identity, its grants, and its versions. */
export interface WidgetRecord {
  /** The widget's lasting identity. The audit and saved state use it, and grants will too. */
  id: string;
  title: string;
  /**
   * The capability names that this widget is approved for.
   *
   * ⚠️ Recorded, NOT enforced in 0.1.0. With per-widget grants (next release),
   * the switchboard will compute `effective = granted − suspended` from this.
   * It is on the record, not on a version, because a grant belongs to the
   * widget across its versions: a version says what it asks for, and the
   * record says what was granted.
   */
  grants: string[];
  /** The `n` of the version that renders. A rollback points this at an older version. */
  activeVersion: number;
  versions: WidgetVersion[];
  createdAt: number;
  updatedAt: number;
}

/** What a list of saved widgets needs, without their versions. */
export interface WidgetSummary {
  id: string;
  title: string;
  updatedAt: number;
}

/**
 * The storage contract. The app implements it over its own backend.
 *
 * The runtime uses only `getState` and `putState`. The app uses the other
 * methods itself, to list, load, save and delete widgets.
 *
 * State is an OPAQUE JSON STRING here. The runtime makes the JSON before
 * `putState` and parses it after `getState`, so a store only keeps the text.
 *
 * The state methods get a `signal`. It aborts when the runtime stops waiting:
 * at `callTimeoutMs`, or when the widget is destroyed. A store can ignore it,
 * and the runtime stops waiting anyway. But a store on the network should
 * pass it to `fetch`, so that the request is cancelled.
 *
 * No signal can undo a write that the backend already made. So destroy a
 * widget BEFORE you delete its state. Otherwise a save that is still on its
 * way can create the state again.
 */
export interface WidgetStore {
  /** All saved widgets, as summaries. */
  list(): Promise<WidgetSummary[]>;
  /** One saved widget, or null when there is none with this id. */
  get(id: string): Promise<WidgetRecord | null>;
  /** Save a widget, or replace the one with the same id. */
  put(record: WidgetRecord): Promise<void>;
  /** Delete a widget and its state. */
  delete(id: string): Promise<void>;
  /** The widget's saved state as JSON text, or null when nothing was saved. */
  getState(widgetId: string, signal?: AbortSignal): Promise<string | null>;
  /** Save the widget's state as JSON text. */
  putState(widgetId: string, json: string, signal?: AbortSignal): Promise<void>;
}

/** The part of the store that the runtime uses, for `darzi.saveState` and `darzi.loadState`. */
export type StateStore = Pick<WidgetStore, "getState" | "putState">;
