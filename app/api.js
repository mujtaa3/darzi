/**
 * The finance app's data layer and HTTP endpoints.
 *
 * One deliberate property: the app's own UI and marzi widgets consume the SAME
 * endpoints. There is no separate "widget API" — a capability handler in the
 * page is just another caller of these routes. That is the shape marzi's HTTP
 * capability adapter assumes later, so the app doubles as its test bed.
 *
 * Data comes from a CSV in Monarch Money's export shape. Columns are matched by
 * HEADER NAME, not position, and unknown columns are ignored — so the generated
 * file and a real export are interchangeable:
 *
 *   TRANSACTIONS_CSV=~/Downloads/monarch.csv node server.js
 *
 * Writes (budgets, recategorizations, notes) never touch the CSV. They live in
 * app/data.local.json as overlays keyed by transaction id, so swapping the CSV
 * or regenerating it never destroys the file, and your real export stays
 * pristine.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CSV_PATH = process.env.TRANSACTIONS_CSV ?? HERE + "transactions.csv";
const LOCAL_PATH = HERE + "data.local.json";
const WIDGETS_PATH = HERE + "widgets.local.json";

/**
 * Parse CSV with quoted-field support ("Payroll, Inc" and "" escapes).
 * A hand-split on commas would corrupt any real bank export.
 */
function parseCsv(text) {
  const rows = [];
  let field = "", row = [], quoted = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); if (row.length > 1 || row[0] !== "") rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") pushField();
    else if (c === "\n") pushRow();
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

/** Load and index the CSV once at startup. `id` is the data row number. */
function loadTransactions() {
  const [header, ...lines] = parseCsv(readFileSync(CSV_PATH, "utf8"));
  const col = (name) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const c = { date: col("date"), merchant: col("merchant"), category: col("category"), account: col("account"), amount: col("amount") };
  for (const [name, idx] of Object.entries(c)) {
    if (idx === -1) throw new Error(`${CSV_PATH}: missing required column "${name}"`);
  }
  return lines.map((r, i) => ({
    id: i,
    date: r[c.date],
    merchant: r[c.merchant],
    category: r[c.category],
    account: r[c.account],
    amount: Number(r[c.amount]),
  })).filter((t) => t.date && Number.isFinite(t.amount));
}

const BASE = loadTransactions();
console.log(`finance data: ${BASE.length} transactions from ${CSV_PATH}`);

/** Local overlays: survive restarts, never written into the CSV. */
function loadLocal() {
  if (!existsSync(LOCAL_PATH)) return { budgets: {}, categories: {}, notes: {} };
  return JSON.parse(readFileSync(LOCAL_PATH, "utf8"));
}
const local = loadLocal();
const saveLocal = () => writeFileSync(LOCAL_PATH, JSON.stringify(local, null, 2) + "\n");

/** A transaction as the app and widgets see it: overlays applied. */
function view(t) {
  return {
    ...t,
    category: local.categories[t.id] ?? t.category,
    note: local.notes[t.id] ?? "",
  };
}

/**
 * The widget shelf — Ledger's implementation of marzi's WidgetStore idea,
 * server-side so widgets survive reloads and (in a real deployment) follow
 * the user across devices. Records and per-widget state in one gitignored
 * file, same overlay pattern as data.local.json.
 *
 * The page is OUR page, but "never trust the page" still applies: everything
 * is shape-checked and size-capped here too. State arrives as an opaque JSON
 * string — the marzi runtime already sanitized and serialized it; the server
 * only stores bytes.
 */
function loadWidgets() {
  if (!existsSync(WIDGETS_PATH)) return { records: {}, state: {} };
  return JSON.parse(readFileSync(WIDGETS_PATH, "utf8"));
}
const widgets = loadWidgets();
const saveWidgets = () => writeFileSync(WIDGETS_PATH, JSON.stringify(widgets, null, 2) + "\n");

const MAX_BODY = 200_000; // per version; a widget is a fragment, not an app
const MAX_STATE = 100_000; // server-side backstop; the runtime caps at 64k first

/** Throw unless `record` looks like a WidgetRecord we are willing to keep. */
function checkRecord(record) {
  const isStr = (v) => typeof v === "string";
  const isStrArr = (v) => Array.isArray(v) && v.every(isStr);
  if (typeof record !== "object" || record === null) throw new Error("record must be an object");
  if (!isStr(record.id) || !/^[\w-]{1,64}$/.test(record.id)) throw new Error("bad record id");
  if (!isStr(record.title) || record.title.length > 200) throw new Error("bad title");
  if (!isStrArr(record.grants)) throw new Error("bad grants");
  if (!Array.isArray(record.versions) || record.versions.length === 0) throw new Error("no versions");
  for (const v of record.versions) {
    if (typeof v.n !== "number") throw new Error("bad version number");
    if (!isStr(v.body) || v.body.length > MAX_BODY) throw new Error("bad version body");
    if (!isStrArr(v.capabilities) || !isStrArr(v.libs)) throw new Error("bad version metadata");
    if (!isStr(v.request) || v.request.length > 4000) throw new Error("bad version request");
  }
  if (!record.versions.some((v) => v.n === record.activeVersion)) {
    throw new Error("activeVersion points at no version");
  }
}

const monthOf = (t) => t.date.slice(0, 7);
/** Categories that are money moving between own accounts, not spending. */
const NOT_SPEND = new Set(["Transfers", "Credit Card Payment"]);

function monthRange() {
  const ms = [...new Set(BASE.map(monthOf))].sort();
  return { first: ms[0], last: ms[ms.length - 1], months: ms };
}

/** Spending by category for one month (positive numbers), plus totals. */
function summary(month) {
  const byCategory = {};
  let income = 0, spend = 0;
  for (const t of BASE.map(view)) {
    if (monthOf(t) !== month || NOT_SPEND.has(t.category)) continue;
    if (t.amount > 0) { income += t.amount; continue; }
    byCategory[t.category] = (byCategory[t.category] ?? 0) + -t.amount;
    spend += -t.amount;
  }
  const round = (n) => Math.round(n * 100) / 100;
  for (const k of Object.keys(byCategory)) byCategory[k] = round(byCategory[k]);
  return { month, income: round(income), spend: round(spend), net: round(income - spend), byCategory };
}

/** Current balance per account. Cards start at 0; banks get a seed balance. */
const OPENING = { "Ally Checking ····8830": 6200, "Ally Savings ····2201": 15800 };
function accounts() {
  const totals = {};
  for (const t of BASE) totals[t.account] = (totals[t.account] ?? 0) + t.amount;
  return Object.entries(totals).map(([name, delta]) => ({
    name,
    kind: name.includes("Checking") || name.includes("Savings") ? "bank" : "card",
    balance: Math.round(((OPENING[name] ?? 0) + delta) * 100) / 100,
  }));
}

const isMonth = (v) => typeof v === "string" && /^\d{4}-\d{2}$/.test(v);

/**
 * The widget-facing capability catalog. Served to the studio page (which wires
 * each name to a fetch of these endpoints) and substituted into the author
 * prompt. Descriptions are documentation for the model — enforcement stays in
 * the handlers and, from rung 5, in grants.
 */
export function catalog() {
  const { first, last } = monthRange();
  const range = `Data covers ${first} through ${last} (the current month).`;
  return [
    {
      name: "transactions.list",
      kind: "read",
      description:
        "The signed-in user's bank and card transactions.\n" +
        "  params: { month?: 'YYYY-MM', category?: string, account?: string }\n" +
        "  returns: array of { id, date, merchant, category, account, amount, note }\n" +
        "           amount is negative for spending, positive for income.\n" +
        `  ${range}`,
    },
    {
      name: "accounts.list",
      kind: "read",
      description:
        "The user's accounts and current balances.\n" +
        "  params: none\n" +
        "  returns: array of { name, kind: 'bank'|'card', balance }\n" +
        "           a card's balance is negative when there is unpaid spend.",
    },
    {
      name: "categories.summary",
      kind: "read",
      description:
        "One month's income, spending and per-category breakdown.\n" +
        "  params: { month: 'YYYY-MM' }  (required)\n" +
        "  returns: { month, income, spend, net, byCategory: { [category]: spent } }\n" +
        "           Transfers and credit-card payments are excluded.\n" +
        `  ${range}`,
    },
    {
      name: "budgets.list",
      kind: "read",
      description:
        "Monthly budgets the user has set, with actual spend for a month.\n" +
        "  params: { month?: 'YYYY-MM' }  (defaults to the current month)\n" +
        "  returns: array of { category, budget, spent }",
    },
    {
      name: "budgets.set",
      kind: "write",
      description:
        "Set or change the monthly budget for one category. Applies to all months.\n" +
        "  params: { category: string, amount: number }  — amount 0 removes it\n" +
        "  returns: { category, budget }",
    },
    {
      name: "transactions.categorize",
      kind: "write",
      description:
        "Recategorize one transaction (by its id from transactions.list).\n" +
        "  params: { id: number, category: string }\n" +
        "  returns: the updated transaction",
    },
    {
      name: "transactions.note",
      kind: "write",
      description:
        "Attach a short note to one transaction (by id). Empty text removes it.\n" +
        "  params: { id: number, text: string }\n" +
        "  returns: the updated transaction",
    },
  ];
}

/**
 * Route one /api/* request. Returns { status, body } or null if the path is
 * not ours. Throwing is fine — the server turns it into a 400.
 */
export async function handleFinanceApi(url, method, body) {
  const p = url.pathname;

  if (p === "/api/transactions" && method === "GET") {
    const month = url.searchParams.get("month");
    const category = url.searchParams.get("category");
    const account = url.searchParams.get("account");
    let rows = BASE.map(view);
    if (month) rows = rows.filter((t) => monthOf(t) === month);
    if (category) rows = rows.filter((t) => t.category === category);
    if (account) rows = rows.filter((t) => t.account === account);
    return { status: 200, body: rows };
  }

  if (p === "/api/accounts" && method === "GET") {
    return { status: 200, body: accounts() };
  }

  if (p === "/api/months" && method === "GET") {
    return { status: 200, body: monthRange() };
  }

  if (p === "/api/summary" && method === "GET") {
    const month = url.searchParams.get("month");
    if (!isMonth(month)) return { status: 400, body: { error: "month=YYYY-MM required" } };
    return { status: 200, body: summary(month) };
  }

  if (p === "/api/budgets" && method === "GET") {
    const month = url.searchParams.get("month") ?? monthRange().last;
    const spent = summary(month).byCategory;
    const rows = Object.entries(local.budgets)
      .map(([category, budget]) => ({ category, budget, spent: spent[category] ?? 0 }))
      .sort((a, b) => a.category.localeCompare(b.category));
    return { status: 200, body: rows };
  }

  if (p === "/api/budgets" && method === "POST") {
    const { category, amount } = body ?? {};
    if (typeof category !== "string" || !category.trim()) throw new Error("category required");
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) throw new Error("amount must be a number ≥ 0");
    if (amount === 0) delete local.budgets[category.trim()];
    else local.budgets[category.trim()] = Math.round(amount * 100) / 100;
    saveLocal();
    return { status: 200, body: { category: category.trim(), budget: amount || null } };
  }

  if (p === "/api/transactions/categorize" && method === "POST") {
    const { id, category } = body ?? {};
    const t = BASE[id];
    if (typeof id !== "number" || !t) throw new Error("unknown transaction id");
    if (typeof category !== "string" || !category.trim()) throw new Error("category required");
    local.categories[id] = category.trim();
    saveLocal();
    return { status: 200, body: view(t) };
  }

  // ── The widget shelf ───────────────────────────────────────────────────
  if (p === "/api/widgets" && method === "GET") {
    const summaries = Object.values(widgets.records)
      .map(({ id, title, updatedAt, grants, activeVersion, versions }) => {
        const active = versions.find((v) => v.n === activeVersion);
        return { id, title, updatedAt, grants, capabilities: active.capabilities, libs: active.libs };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { status: 200, body: summaries };
  }

  if (p === "/api/widgets" && method === "POST") {
    checkRecord(body);
    widgets.records[body.id] = body;
    saveWidgets();
    return { status: 200, body: { saved: body.id } };
  }

  const widgetPath = /^\/api\/widgets\/([\w-]{1,64})(\/state)?$/.exec(p);
  if (widgetPath) {
    const [, id, isState] = widgetPath;
    if (!isState && method === "GET") {
      const record = widgets.records[id];
      return record ? { status: 200, body: record } : { status: 404, body: { error: "no such widget" } };
    }
    if (!isState && method === "DELETE") {
      delete widgets.records[id];
      delete widgets.state[id];
      saveWidgets();
      return { status: 200, body: { deleted: id } };
    }
    if (isState && method === "GET") {
      return { status: 200, body: { json: widgets.state[id] ?? null } };
    }
    if (isState && method === "POST") {
      // State belongs to a record; never let a late write resurrect it.
      if (!widgets.records[id]) return { status: 404, body: { error: "no such widget" } };
      const { json } = body ?? {};
      if (typeof json !== "string" || json.length > MAX_STATE) throw new Error("bad state payload");
      widgets.state[id] = json;
      saveWidgets();
      return { status: 200, body: { saved: true } };
    }
  }

  if (p === "/api/transactions/note" && method === "POST") {
    const { id, text } = body ?? {};
    const t = BASE[id];
    if (typeof id !== "number" || !t) throw new Error("unknown transaction id");
    if (typeof text !== "string") throw new Error("text required");
    const clean = text.trim().slice(0, 500);
    if (clean === "") delete local.notes[id];
    else local.notes[id] = clean;
    saveLocal();
    return { status: 200, body: view(t) };
  }

  return null;
}
