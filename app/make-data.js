/**
 * Generate app/transactions.csv — thirteen months of plausible personal finance
 * data (2025-09-01 … 2026-09-15), in the same column shape as a Monarch Money
 * export: Date,Merchant,Category,Account,Amount.
 *
 * Deterministic on purpose: a seeded PRNG instead of Math.random, so running it
 * twice produces byte-identical output and the checked-in CSV never churns.
 *
 *   node app/make-data.js        # rewrites app/transactions.csv
 *
 * To use REAL data instead, don't touch this file — point the server at any
 * CSV with the same column names:  TRANSACTIONS_CSV=~/monarch.csv node server.js
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// mulberry32 — a tiny seedable PRNG. Math.random can't be seeded.
function prng(seed) {
  let s = seed;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(42);
const between = (lo, hi) => lo + rand() * (hi - lo);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const cents = (n) => Math.round(n * 100) / 100;

const CHECKING = "Ally Checking ····8830";
const SAVINGS = "Ally Savings ····2201";
const CHASE = "Chase Sapphire ····4412";
const AMEX = "Amex Gold ····1005";

const START = new Date(Date.UTC(2025, 8, 1)); // 2025-09-01
const END = new Date(Date.UTC(2026, 8, 15)); // 2026-09-15 — a partial "current" month

const rows = [];
const add = (date, merchant, category, account, amount) =>
  rows.push({ date, merchant, category, account, amount: cents(amount) });

const iso = (d) => d.toISOString().slice(0, 10);
const day = (y, m, d) => new Date(Date.UTC(y, m - 1, d));

/** Every month in the window as {y, m, days-in-window}. */
const months = [];
for (let d = new Date(START); d <= END; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cutoff = y === 2026 && m === 9 ? 15 : last;
  months.push({ y, m, last: cutoff });
}
const inWindow = (dt) => dt >= START && dt <= END;
const emit = (dt, merchant, category, account, amount) => {
  if (inWindow(dt)) add(iso(dt), merchant, category, account, amount);
};

for (const { y, m, last } of months) {
  // ── Income: semi-monthly payroll into checking ─────────────────────────────
  emit(day(y, m, 1), "Acme Corp Payroll", "Income", CHECKING, 2600);
  if (last >= 15) emit(day(y, m, 15), "Acme Corp Payroll", "Income", CHECKING, 2600);

  // ── Fixed bills from checking ──────────────────────────────────────────────
  // Rent, with a $125 increase at lease renewal in March 2026.
  const rent = y === 2026 && m >= 3 ? 2575 : 2450;
  emit(day(y, m, 1), "Bay Property Mgmt", "Rent", CHECKING, -rent);
  // Netflix price bump in May 2026 — fodder for a "did my subscriptions go up?" widget.
  const netflix = y === 2026 && m >= 5 ? 13.49 : 11.98;
  if (last >= 2) emit(day(y, m, 2), "Netflix", "Subscriptions", CHECKING, -netflix);
  if (last >= 9) emit(day(y, m, 9), "Spotify", "Subscriptions", CHECKING, -10.99);
  if (last >= 17) emit(day(y, m, 17), "Apple iCloud", "Subscriptions", CHECKING, -2.99);
  if (last >= 5) emit(day(y, m, 5), "24 Hour Fitness", "Health", CHECKING, -45);
  if (last >= 20) emit(day(y, m, 20), "Comcast Xfinity", "Utilities", CHECKING, -79.99);
  if (last >= 11) emit(day(y, m, 11), "Verizon Wireless", "Utilities", CHECKING, -68);
  // Electricity is seasonal: AC in high summer, heating in winter.
  const pge = m >= 7 && m <= 8 ? between(125, 155) : m === 12 || m <= 2 ? between(95, 125) : between(60, 85);
  if (last >= 14) emit(day(y, m, 14), "PG&E", "Utilities", CHECKING, -pge);

  // ── Savings: automatic transfer + interest ─────────────────────────────────
  if (last >= 2) {
    emit(day(y, m, 2), "Transfer to Ally Savings", "Transfers", CHECKING, -500);
    emit(day(y, m, 2), "Transfer from Ally Checking", "Transfers", SAVINGS, 500);
  }
  const lastOfMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (last >= lastOfMonth) {
    emit(day(y, m, lastOfMonth), "Interest Paid", "Income", SAVINGS, between(26, 44));
  }

  // ── Card spending ──────────────────────────────────────────────────────────
  const spend = (count, merchants, category, account, lo, hi) => {
    for (let i = 0; i < count; i++) {
      emit(day(y, m, 1 + Math.floor(rand() * last)), pick(merchants), category, account, -between(lo, hi));
    }
  };
  spend(5, ["Trader Joe's", "Safeway", "Whole Foods"], "Groceries", CHASE, 34, 128);
  spend(7, ["Blue Bottle", "Philz Coffee", "Starbucks"], "Coffee", AMEX, 4.2, 7.6);
  spend(5, ["Chipotle", "Sweetgreen", "Souvla", "Burma Superstar", "DoorDash"], "Restaurants", AMEX, 13, 84);
  spend(2, ["Chevron", "Shell"], "Gas", CHASE, 38, 62);
  spend(4, ["Uber", "Lyft", "BART Clipper"], "Transport", AMEX, 8, 42);
  spend(3, ["Amazon", "Target"], "Shopping", CHASE, 12, 150);
  spend(2, ["AMC Theatres", "Steam", "Bandcamp"], "Entertainment", AMEX, 9, 55);
  spend(1, ["CVS Pharmacy", "Walgreens"], "Health", CHASE, 8, 45);
}

// ── One-offs and anomalies (things worth prompting widgets about) ────────────
emit(day(2025, 10, 27), "GEICO", "Insurance", CHECKING, -812.4); // semi-annual premium
emit(day(2026, 4, 27), "GEICO", "Insurance", CHECKING, -812.4);
emit(day(2025, 11, 21), "Apple Store", "Shopping", CHASE, -1899); // the MacBook
emit(day(2025, 12, 18), "United Airlines", "Travel", AMEX, -486.4); // winter trip
emit(day(2025, 12, 19), "Airbnb", "Travel", AMEX, -723.18);
emit(day(2026, 6, 11), "Delta Air Lines", "Travel", AMEX, -512.2); // summer trip
emit(day(2026, 6, 12), "Marriott Hotels", "Travel", AMEX, -834.55);
emit(day(2026, 3, 6), "Amazon Refund", "Shopping", CHASE, 43.99);
emit(day(2026, 2, 14), "DoorDash", "Restaurants", AMEX, -46.35); // duplicate charge —
emit(day(2026, 2, 14), "DoorDash", "Restaurants", AMEX, -46.35); // an anomaly to find
emit(day(2026, 1, 8), "Wire Transfer Fee", "Fees", CHECKING, -25);

// ── Credit card payments: each month's card spend is paid from checking on the
// 25th of the following month. Derived AFTER all card rows exist. ────────────
for (const card of [CHASE, AMEX]) {
  const byMonth = new Map();
  for (const r of rows) {
    if (r.account !== card || r.amount >= 0) continue;
    const key = r.date.slice(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? 0) - r.amount);
  }
  for (const [key, total] of byMonth) {
    const [y, m] = key.split("-").map(Number);
    const due = day(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 25);
    if (!inWindow(due)) continue; // the last statement stays unpaid — realistic
    const name = card.split(" ····")[0];
    emit(due, `Payment to ${name}`, "Credit Card Payment", CHECKING, -cents(total));
    emit(due, "Payment Thank You", "Credit Card Payment", card, cents(total));
  }
}

rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

const quote = (s) => (/[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
const csv =
  "Date,Merchant,Category,Account,Amount\n" +
  rows.map((r) => [r.date, quote(r.merchant), r.category, quote(r.account), r.amount.toFixed(2)].join(",")).join("\n") +
  "\n";

const out = fileURLToPath(new URL("./transactions.csv", import.meta.url));
writeFileSync(out, csv);
console.log(`${rows.length} transactions → ${out}`);
