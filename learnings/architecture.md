# marzi architecture

## 2026-08-19 · Integration shape (who does what)
- Three parties: marzi (us), the app developer (our customer), their end users (prompt widgets into existence, never see the wiring).
- The app developer installs the package and registers capabilities in their frontend code: name + description + handler fn — like handlers on a Go mux. Handlers run in the host page under the app's existing auth; the backend needs zero changes.
- The switchboard is router + middleware: grant check, read/write mask, audit log, then dispatch to the handler. The widget iframe never holds tokens and never touches the network.
- marzi is not in the LLM loop: the app calls its own model with our prompt template, saves the result through the storage interface, renders through us.
- The package is secretly two programs: the host-page runtime, plus a tiny in-frame helper that must be embedded into widget HTML as a string at build time (the jail can't fetch anything).

## 2026-08-22 · First real capability (rung 3, demo/transactions.html)
- A widget rendered a spending breakdown from `transactions.csv` — 45 rows, grouped by category — with **no network and no page access**. It called `transactions.list` by name; the HOST fetched and parsed.
- **Parsing lives in the app, not the library.** marzi never sees a CSV, an HTTP client, or a schema. The handler is the app's code running with the app's privileges — which is exactly why the backend needs zero changes.
- The `params` narrowing (`typeof params.month === "string"`) is in the HANDLER, not marzi. The library can't know what a capability's params mean; only the app does. Confirms the rung-5 grant check is about *which* capability, while *what* the arguments may be stays the handler's job (and later, caveats).
- Threat-model consequence, now concrete: the widget holds real financial data. The rung-1 exfil attack is live again against this page — the jail stops the widget *reaching* data it wasn't given, not *forwarding* data it was.
