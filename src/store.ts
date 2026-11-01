/**
 * The in-memory store: a ready-made WidgetStore for tests and first demos.
 *
 * marzi defines the storage contract (types/store.ts), and the app supplies
 * the real storage over its own backend, as it does for capabilities and
 * libraries.
 */

import type { WidgetRecord, WidgetStore } from "./types/store.js";

/**
 * An in-memory store: two Maps, which are empty again after a reload.
 *
 * For tests and first demos only, not for real use. It keeps the record
 * object that `put` gets, not a copy, so a later change to that object also
 * changes the saved record.
 */
export function memoryStore(): WidgetStore {
  const records = new Map<string, WidgetRecord>();
  const state = new Map<string, string>();
  return {
    // Newest first.
    list: async () =>
      [...records.values()]
        .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    get: async (id) => records.get(id) ?? null,
    put: async (record) => {
      records.set(record.id, record);
    },
    // Deleting a widget also deletes its state.
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
