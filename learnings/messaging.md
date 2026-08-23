# Messaging across the isolation wall (postMessage / MessageChannel)

## 2026-08-20 · postMessage basics
- Browser contexts (page, iframe, Worker, popup) are isolated: no shared memory, no direct calls. The one sanctioned bridge is message passing.
- `postMessage(data)` on one side → a `message` event with `event.data` on the other. Async, fire-and-forget.
- Data is deep-COPIED ("structured clone"), not shared by reference — supports Maps/Sets/Dates/ArrayBuffers, not functions/DOM nodes.
- Go analogy: a channel between goroutines, but every send is a deep copy (contexts don't share an address space — may be separate OS processes via Site Isolation). No shared mutable state.
- Request/response (JSON-RPC) is built ON TOP: attach an `id`, match the reply by `id`. The channel has no native notion of a response.

## 2026-08-20 · Two flavors
- `window.postMessage` = party line: every `message` listener on the target window sees it. Why a hostile frame can `parent.postMessage` and hit sibling listeners (threats.md finding B).
- `MessageChannel` = private line: `new MessageChannel()` gives two ports (two ends of one pipe). Transfer one end into the frame in a one-time handshake; after that, messages on the port reach ONLY the other port-holder. This is marzi's "phone line" — the widget's sole sanctioned way out.
- Structured clone means the channel delivers whatever type/size the sender chose → validate every message with real code (threats.md finding G).

## 2026-08-20 · The rendering/containment dial (why a Worker helps)
- The frame has a `location` to abuse because it can RENDER — every window bundles a DOM + a navigable `location`. Rendering power and navigation power are welded together.
- A Web Worker is a JS context with NO DOM/window/location — pure compute, talks only via postMessage. Put untrusted model code there → no self-nav channel, and `fetch` killed by `connect-src 'none'`.
- Trusted renderer (our code) receives the Worker's messages and builds the DOM from a FIXED component vocabulary. Model composes from our menu; never writes raw DOM. Kills self-nav AND phishing pixels at once.
- Cost: model limited to our components (no arbitrary HTML). If fully declarative (description only, no code), the iframe may be unnecessary — the jail exists to contain CODE, not data.
- Dial, not switch: freedom end (arbitrary HTML in sandboxed iframe, our v1) ↔ containment end (description + trusted renderer, Codex's direction). Ship freedom end; keep containment as opt-in hardened mode.

## 2026-08-21 · The handshake, implemented (rung 2)
Working end-to-end; host log shows both directions crossing.

**Sequence:** stub (in `<head>`, before widget code) registers its listener → posts `{marzi:"ready"}` to parent on the party line → host verifies `event.source === frame.contentWindow`, answers **once** with `{marzi:"port"}` + transferred `port2` → stub captures it, flushes queued messages.

**Decisions baked in:**
- **Frame speaks first.** Host-post-on-load is racy: if the frame navigated mid-parse we'd hand a live port to whatever origin it went to. (open-questions #2, now settled)
- **Identity = `event.source`, never origin.** Opaque frames report origin `"null"`; `event.source` is browser-set and unforgeable, so another frame shouting "ready" fails the check.
- **Issue exactly once** (`portIssued` flag + `removeEventListener`). A second port = a second unaccounted line into the same jail.
- **Listener armed before `appendChild`** — the frame doesn't start loading until it's in the document, so no knock can be missed.
- **`targetOrigin:"*"` is fine for the knock** because it carries no payload — it's a knock, not data. Real data only ever rides the private port.

**Gotchas found:**
- The stub must **queue** sends: widget script runs during parse, but the port arrives async after the host replies. Without a queue, early `marzi.send()` calls vanish.
- Setting `port.onmessage` implicitly starts the port; `addEventListener("message")` would need an explicit `port.start()`.
- The stub is a **string of JS in a .ts file**, not compiled TS — the jail has no network, so the code must arrive inside the document.
- `nodenext` resolution forced `import { FRAME_STUB } from "./frame-stub.js"` — `.js` extension in a `.ts` file, exactly as designed.

## 2026-08-22 · JSON-RPC over the port (rung 3)
- The port is fire-and-forget: nothing links a reply to its request. JSON-RPC's whole idea is **every request carries an `id`, every response echoes it** — correlation IDs on an async bus. Plus agreed field names (`method`/`params`/`result`/`error`) and standard codes (-32601 method-not-found, -32603 internal).
- Stub keeps a `pending` map of `id → {resolve, reject}` so `marzi.call()` can return a Promise; a JSON-RPC `error` rejects it.
- **"We speak JSON-RPC" is a shape we impose, not one the channel guarantees.** structuredClone delivers whatever the widget builds. `parseRequest()` is the only enforcement — and it **rebuilds** the request from scratch rather than casting, so smuggled extra properties are dropped rather than carried along.
- Malformed messages with no usable `id` are **dropped, not answered** — replying would mean trusting a field from a message we couldn't parse.
- Handler errors return a generic "capability failed"; the real error goes to the host console. Error messages leak internals otherwise.
- Handlers take `params: unknown` deliberately — it came from hostile code, so the handler must narrow it. TypeScript cannot help: the widget was never type-checked.

**Virtual-time flakiness is worse than first measured (rung 3.6):** the injection test silently under-reported at 8s, 12s, 14s and 15s `--virtual-time-budget`, then reported correctly at 25s. Four consecutive false negatives that each looked like "the attack failed". Any suite that asserts absence-of-effect on a fixed budget will manufacture green results. Playwright must wait on an actual condition (the audit event landing), never a timer.

**Testing note (matters for rung 7):** headless Chrome + `--virtual-time-budget` is FLAKY — identical runs gave a full log, then an empty one. It also often captures before srcdoc frames paint, so screenshots show blank widgets that render fine in a real browser. Ground truth = the host-side log or the exfil listener, never a screenshot. The Playwright suite must wait on real conditions, not fixed budgets.

**Self-verification trick:** a jailed widget has no way to report results outward except a capability. Registering a `demo.report` capability that echoes into the host log makes the whole loop observable from outside the jail — the attack suite will use exactly this.
