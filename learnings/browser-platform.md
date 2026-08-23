# Browser platform

## 2026-08-19 · JS is the page's only programmable interface
- A web page exposes exactly one way to program it: the JS engine, wired to the DOM, iframes, events, and `postMessage`.
- WASM is a compute-only box (compiled Go/Rust/C bytecode) — no DOM, no page access. Every outside interaction is proxied through JS glue: a process with no syscalls. Good for codecs and math, useless for avoiding JS.
- Consequence for marzi: the runtime is necessarily JS, written as TypeScript.

## 2026-08-21 · iframes, origins, sandbox — measured (rung 1)
- **iframe** = a whole second document with its own globals, not a component. **origin** = scheme+host+port, the browser's unit of trust: same origin ⇒ total mutual access; different ⇒ almost none.
- **`srcdoc`** hands the browser HTML as a string (no URL, no network fetch) — but a srcdoc frame **inherits the parent's origin by default**. The widget IS the app until you say otherwise.
- **`sandbox` works by subtraction**: writing the attribute strips nearly everything; each token (`allow-scripts`, `allow-forms`, …) hands one privilege back. Deny-by-default, like a seccomp profile.
- Withholding **`allow-same-origin`** is the whole jail: the frame gets an **opaque origin** matching nothing, not even itself. Footgun: `allow-scripts` + `allow-same-origin` together is worse than no sandbox — the frame can delete its own sandbox attribute.

**Measured, headless Chrome, before → after adding `sandbox="allow-scripts"`:**
| attack | before | after |
|---|---|---|
| read+write host DOM (`parent.document`) | stole balance, defaced page | BLOCKED — SecurityError, box verified clean |
| steal cookie (`document.cookie` — its own jar IS the app's) | leaked session token | BLOCKED — SecurityError |
| `fetch()` to attacker | delivered balance + token | **STILL DELIVERED** (payload now empty) |

- **The lesson:** `sandbox` governs IDENTITY, not CONNECTIVITY. Two independent privileges, two separate mechanisms. Killing the network needs CSP, a different tool.
- Threat-model tie: the channel stayed open, only the data source dried up. Once capabilities feed real data in over the port, that same `fetch` is a live exfil pipeline again — "read-only is containment, not prevention", demonstrated.
- None of the three attacks was an exploit. All three were the browser correctly obeying, because we'd told it the code was ours.

## 2026-08-21 · CSP — closing the network (rung 1, step 3)
- **CSP** = rules a document carries saying what it may load/connect to. Delivered as an HTTP header OR a `<meta>` in `<head>`. A srcdoc widget has no server, so meta is our only option.
- Hard requirement: the meta policy must precede EVERY widget byte (it only governs what's parsed after it). So `render()` must **compose the document** — our head first, widget sealed in the body. That's what guarantees the widget can't get a tag in ahead of ours.
- `default-src` is the fallback for any fetch directive you don't set. We never set `connect-src`, so it inherits `'none'` → fetch/XHR/WebSocket/EventSource/sendBeacon all dead. No remote script/style/img/font source either, so no beacon-by-loading.
- **`'unsafe-inline'` is correct here**, despite the usual smell. Its normal danger is letting INJECTED script run beside a page's trusted script — but this document has no trusted script; it's all untrusted by design. We're not stopping code from running, only from reaching out.

**Measured (Chrome console, after adding CSP):**
```
Connecting to 'http://127.0.0.1:9999/collect?...' violates the following CSP
directive: "default-src 'none'". Note that 'connect-src' was not explicitly
set, so 'default-src' is used as a fallback. The action has been blocked.
```
Listener received nothing. The error also proves the widget's inline script ran (so `'unsafe-inline'` works) — it ran, tried to phone home, and was refused.

- **Browsers deny differently**: reading `document.cookie` in an opaque origin *throws SecurityError* in Chrome but *returns `""`* in Safari. Any attack-suite assertion must accept both shapes of refusal or it will score a block as a leak.
- Headless-screenshot caveat: `--virtual-time-budget` can capture before srcdoc frames paint, showing empty slots that render fine in a real browser. Verify UI in a real browser; use the listener/console as ground truth.
