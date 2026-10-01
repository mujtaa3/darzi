/**
 * Shared helpers for the app's pages. Multi-page means each page re-imports
 * this and re-derives its state from the URL — nothing hides in memory between
 * navigations, which is the point of the multi-page choice.
 */

/** Inject the top bar. `active` names the current page. */
export function nav(active) {
  const pages = [
    ["index", "Dashboard", "./index.html"],
    ["transactions", "Transactions", "./transactions.html"],
    ["widgets", "My Widgets", "./widgets.html"],
  ];
  const header = document.createElement("header");
  const brand = document.createElement("div");
  brand.className = "brand";
  brand.textContent = "Ledger";
  const small = document.createElement("small");
  small.textContent = "powered by marzi";
  brand.appendChild(small);
  const links = document.createElement("nav");
  for (const [key, label, href] of pages) {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = label;
    if (key === active) a.className = "active";
    links.appendChild(a);
  }
  header.append(brand, links);
  document.body.prepend(header);
}

/**
 * Fetch JSON from the app's own backend; throw the server's error message.
 * No body and no method → GET. A body → POST. Method overrides (e.g. DELETE).
 */
export async function api(path, body, method, signal) {
  const init = body === undefined && method === undefined ? {} : {
    method: method ?? "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  // `signal` lets a caller cancel the request outright (the marzi store
  // contract hands one to getState/putState).
  const res = await fetch(path, { ...init, signal });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `${res.status} on ${path}`);
  return data;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const money = (n) => usd.format(n);

/** Escape before any innerHTML: model- and data-authored text is untrusted. */
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The month to show: ?month=YYYY-MM in the URL, else the latest with data. */
export async function currentMonth() {
  const fromUrl = new URLSearchParams(location.search).get("month");
  const { months, last } = await api("/api/months");
  return { month: months.includes(fromUrl) ? fromUrl : last, months };
}

/** Build a month <select> that navigates the page via the URL. */
export function monthPicker(el, months, selected) {
  el.innerHTML = months
    .map((m) => `<option value="${m}" ${m === selected ? "selected" : ""}>${m}</option>`)
    .join("");
  el.onchange = () => {
    const u = new URL(location.href);
    u.searchParams.set("month", el.value);
    location.href = u; // full navigation: state lives in the URL, not in JS
  };
}
