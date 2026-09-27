# marzi

Run LLM-generated UI widgets inside your web app without trusting them.

A user describes a widget, a model writes it, and marzi runs the result in a jail
where it has no access to your page, your cookies, or the network — and can reach
your app only through capabilities you register by name.

> **Status: early and incomplete.** The jail, the message channel, the
> capability layer, persistence and refinement work and are demonstrated. The
> attack suite and the navigation fix below do **not** exist yet. Not usable in
> production.

## Who decides what a widget may call

In 0.1.0, **registering a capability is the authorization.** Every capability
you pass to `createRuntime` is callable by every widget you render — there are
no per-widget grants, no consent step, and no read/write switch yet. Choose what
to register the way you would choose what to put in a public API: if you would
not want *any* widget calling it, do not register it. Descriptions carry no
enforcement weight; only the handler's own validation does.

Per-widget grants (a widget gets only what the user approved at creation), a
consent flow with re-approval when a refinement asks for more, and a host-side
read/write mask are designed and scheduled for the first release after 0.1.0.

## How it works

```
  your page (trusted)                     the jail (hostile by assumption)
 ┌─────────────────────────┐   one port  ┌──────────────────────────────┐
 │ registry: name→handler  │◄───────────►│ sandboxed srcdoc iframe      │
 │ switchboard: validate,  │   JSON-RPC  │ opaque origin, no cookies    │
 │   authorize, dispatch   │             │ CSP default-src 'none'       │
 └───────────┬─────────────┘             │ model-written HTML + JS      │
             │ handler runs here,        └──────────────────────────────┘
             ▼ with your app's session
     your existing API — no changes
```

Two independent browser mechanisms do the containment, and they are not
interchangeable: the **`sandbox` attribute** takes away *identity* (no host DOM,
no cookies), and **CSP** takes away *connectivity* (no fetch, no beacons).

## The honest claim

> Generated widgets receive no ambient authority over the host; every application
> operation is mediated through explicit host capabilities.

Claims deliberately **not** made: "no network of any kind", "the message channel
is the only channel", "write grants make hostile code safe".

**Known residual:** a widget can navigate *itself* away, carrying data in the URL.
`sandbox` governs identity, CSP governs fetches, and neither governs navigation —
only the embedder's `frame-src` does. Reproduced in `demo/self-nav.html`; a
zero-config fix is planned.

## Try it

```bash
npm install
npm run build                      # the app and demos load from dist/
node --env-file=.env server.js     # → http://127.0.0.1:8000/  (Ledger, the reference app)
```

`app/` is Ledger, a small finance app over a transactions CSV that embeds marzi:
generate widgets, save them to a shelf, refine them, roll versions back. It is the
reference for how a host wires capabilities, libraries, storage and the audit log.
Generation needs `ANTHROPIC_API_KEY` in `.env` (read by the server only — it never
reaches the browser). The older single-purpose demos are under `demo/`:

| Demo | Shows |
|---|---|
| `demo/` | three attacks against the jail, before and after |
| `demo/capabilities.html` | calling capabilities by name; refusals |
| `demo/transactions.html` | a widget over real data, plus a hostile twin |
| `demo/injection.html` | a payload arriving through the *data*, bounded by what the host registered |
| `demo/self-nav.html` | the leak CSP cannot close — run the exfil listener |
| `demo/nav-matrix.html` | sandbox × CSP × navigation, four ways |
| `demo/jail-probe.html` | which browser APIs the jail actually blocks |
| `demo/studio.html` | describe a widget, a model writes it, marzi runs it |

`python3 demo/exfil-listener.py` stands in for an attacker's collection server.
It is the only trustworthy witness for whether data actually left the machine —
a page cannot be trusted to report on itself.

## Layout

| Path | What |
|---|---|
| `src/jail.ts` | sandbox tokens, CSP, document composition |
| `src/index.ts` | `createRuntime`, the registry, the switchboard |
| `src/rpc.ts` | JSON-RPC types and the inbound validator |
| `src/frame-stub.ts` | the in-frame helper — **untrusted**, ergonomics only |
| `src/store.ts` | the storage contract (`WidgetStore`) and an in-memory store |
| `prompts/` | the author and refine templates shipped for widget generation |
| `app/` | Ledger, the reference host app |

Zero runtime dependencies. TypeScript is a devDependency; so is the Anthropic SDK,
which only the demo server uses.

## License

MIT
