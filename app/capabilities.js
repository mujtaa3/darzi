/**
 * The app's capability handlers — the host side of every `marzi.call`.
 *
 * Each handler is a thin bridge to the app's own HTTP API: exactly the
 * endpoints the Dashboard and Transactions pages use. Widgets get no private
 * data path — if the app can't do it over its API, neither can a widget.
 *
 * Handlers run in the HOST page under the app's session. `params` arrived from
 * hostile code (already sanitized by the runtime: prototype keys stripped,
 * size-bounded) — but VALUES are still whatever the widget chose, so each
 * handler narrows to the exact fields it expects and rejects the rest.
 *
 * On today's runtime every widget may call all of these, writes included.
 * That is rung 5's problem to solve — watch the audit log show why.
 */
import { api } from "./shared.js";

/** Narrow a param object: every field through its check, extras ignored. */
function shape(params, checks) {
  const p = params && typeof params === "object" ? params : {};
  const out = {};
  for (const [key, check] of Object.entries(checks)) {
    const value = check(p[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}
const optMonth = (v) => (typeof v === "string" && /^\d{4}-\d{2}$/.test(v) ? v : undefined);
const optString = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const reqString = (v) => {
  const s = optString(v);
  if (s === undefined) throw new Error("required string param missing");
  return s;
};
const reqNumber = (v) => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("required number param missing");
  return v;
};

/** name → handler. The catalog (names, descriptions) is served by the backend. */
export const HANDLERS = {
  "transactions.list": (params) => {
    const q = new URLSearchParams(shape(params, {
      month: optMonth, category: optString, account: optString,
    }));
    return api(`/api/transactions?${q}`);
  },

  "accounts.list": () => api("/api/accounts"),

  "categories.summary": (params) => {
    const { month } = shape(params, { month: optMonth });
    if (!month) throw new Error("month param required, 'YYYY-MM'");
    return api(`/api/summary?month=${month}`);
  },

  "budgets.list": (params) => {
    const { month } = shape(params, { month: optMonth });
    return api(`/api/budgets${month ? `?month=${month}` : ""}`);
  },

  "budgets.set": (params) =>
    api("/api/budgets", shape(params, { category: reqString, amount: reqNumber })),

  "transactions.categorize": (params) =>
    api("/api/transactions/categorize", shape(params, { id: reqNumber, category: reqString })),

  "transactions.note": (params) => {
    const p = shape(params, { id: reqNumber });
    // note text may legitimately be "" (that clears the note), so reqString
    // does not fit — accept any string.
    const text = params && typeof params.text === "string" ? params.text : "";
    return api("/api/transactions/note", { id: p.id, text });
  },
};

/** Assemble the runtime's capability list from the served catalog. */
export function buildCapabilities(catalog) {
  return catalog
    .filter((c) => HANDLERS[c.name])
    .map((c) => ({ name: c.name, description: c.description, handler: HANDLERS[c.name] }));
}
