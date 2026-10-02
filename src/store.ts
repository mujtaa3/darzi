/**
 * The filing cabinet — how widgets survive tomorrow.
 *
 * marzi defines the CONTRACT and ships one trivial implementation; real
 * storage is the host's, same as capabilities (host handlers) and libraries
 * (host text). The runtime itself touches only the two state methods — record
 * CRUD is between the app and its store directly, because listing and loading
 * widgets is app UI, not switchboard business.
 */

/** One immutable iteration of a widget's content. */
export interface WidgetVersion {
  /** 1-based version number; refinement appends the next one. */
  n: number;
  /** The HTML fragment exactly as the model wrote it. Hostile, as always. */
  body: string;
  /**
   * What this version DECLARED it calls and uses. Per-version on purpose: a
   * refinement can change both, and the difference between two versions is
   * exactly what a re-consent step will show the user once grants exist.
   */
  capabilities: string[];
  libs: string[];
  /**
   * The user's request that produced this version. Stored for provenance
   * ("what did I ask for?"); whether it is ever fed back into a refine prompt
   * is a separate decision — this text is attacker-influenceable by assumption.
   */
  request: string;
  /** Milliseconds since epoch. */
  createdAt: number;
}

/** A saved widget: identity, standing authority, and its history. */
export interface WidgetRecord {
  /** The durable identity. Grants, audit and state all key off this. */
  id: string;
  title: string;
  /**
   * The capability names this widget stands approved for.
   *
   * ⚠️ Recorded, NOT enforced in 0.1.0 — per-widget grants (next release) make
   * the switchboard compute `effective = granted − suspended` from this. Lives
   * on the record rather than a version because authority belongs to the
   * widget across versions; versions carry what they *ask* for, the record
   * carries what was *granted*.
   */
  grants: string[];
  /** Which entry in `versions` renders. Rollback = point this at an older n. */
  activeVersion: number;
  versions: WidgetVersion[];
  createdAt: number;
  updatedAt: number;
}

/** What a shelf UI needs to list widgets without loading their bodies. */
export interface WidgetSummary {
  id: string;
  title: string;
  updatedAt: number;
}

/**
 * The storage contract.
 *
 * State is an OPAQUE JSON STRING at this boundary: the runtime serializes
 * before `putState` and parses after `getState`, so implementations store
 * bytes and never re-encode — round-trip fidelity is the runtime's problem,
 * solved once, not every store's.
 *
 * The state methods receive a `signal`, aborted when the runtime stops
 * waiting: the call exceeded `callTimeoutMs`, or the widget was destroyed.
 * Honouring it is optional, and the runtime stops waiting either way — but a
 * store backed by a network should pass it on to `fetch`, so the request is
 * actually cancelled rather than finishing into a void.
 *
 * What no signal can do is recall a write the backend has already applied.
 * So destroy a widget BEFORE deleting its state, or a save already in flight
 * can recreate the state you just removed.
 */
export interface WidgetStore {
  list(): Promise<WidgetSummary[]>;
  get(id: string): Promise<WidgetRecord | null>;
  put(record: WidgetRecord): Promise<void>;
  delete(id: string): Promise<void>;
  getState(widgetId: string, signal?: AbortSignal): Promise<string | null>;
  putState(widgetId: string, json: string, signal?: AbortSignal): Promise<void>;
}

/** The slice of the store the runtime itself consumes (for marzi.saveState). */
export type StateStore = Pick<WidgetStore, "getState" | "putState">;

/**
 * An in-memory store: two Maps, gone on reload.
 *
 * For tests and first-run demos — honest scaffolding, not a storage offering.
 * Real hosts implement WidgetStore over their own backend.
 */
export function memoryStore(): WidgetStore {
  const records = new Map<string, WidgetRecord>();
  const state = new Map<string, string>();
  return {
    list: async () =>
      [...records.values()]
        .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    get: async (id) => records.get(id) ?? null,
    put: async (record) => {
      records.set(record.id, record);
    },
    delete: async (id) => {
      records.delete(id);
      state.delete(id);
    },
    getState: async (widgetId) => state.get(widgetId) ?? null,
    putState: async (widgetId, json) => {
      state.set(widgetId, json);
    },
  };
}
