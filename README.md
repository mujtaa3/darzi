# marzi

**Let your users build their own widgets. Run what the model writes without trusting it.**

Every app has a long tail of things users want and nobody will build: spending
by weekday, invoices thirty days overdue, a button that archives last year. With
marzi that's a sentence. The user describes it, a model writes it, and marzi
runs it inside your app, against your real API, as a mod the user keeps.

> **Status: 0.1.0, the runtime.** Containment is built and measured in three
> browsers. Per-widget permissions come next; the API may still change
> before 1.0.

## The catch

Code a model wrote on a user's say-so is code *anyone who can influence that
prompt* wrote: a poisoned transaction memo, a crafted support ticket, text
pasted from a web page. So marzi never trusts a widget. It treats each one as
hostile, forever, and arranges things so a hostile widget can't do much.

## How it does that

**The jail.** The widget runs in an iframe the browser treats as a nobody: a
sandbox that grants `allow-scripts` and nothing else, so it can't touch your
page or cookies, and a Content-Security-Policy of `default-src 'none'`, so it
can't use the network. Not `fetch`, not an `<img>` beacon, not a font.

**The phone line.** One way out: a private `MessageChannel` to your page,
carrying JSON-RPC 2.0. Data, actions, saved state: all of it is a message on
that line.

**The switchboard.** Your page checks every message. If a call names a
capability you registered, its handler runs in your page, with your session,
and the result goes back. Anything else is refused. Every decision can be
logged.

**The warden.** A frame can navigate *itself* to `https://evil.example/?data=…`,
and only its parent can forbid that. So a second, script-free frame marzi
controls wraps the widget; its `frame-src 'none'` stops the navigation before a
packet leaves the machine.

```
  your page (trusted)                        the jail (hostile by assumption)
 ┌───────────────────────────┐   one port   ┌─────────────────────────────┐
 │ registry: name → handler  │◄────────────►│ warden (frame-src 'none')   │
 │ switchboard: validate,    │   JSON-RPC   │  └ widget: opaque origin,   │
 │   look up, dispatch, log  │              │    no network, model-written│
 └─────────────┬─────────────┘              │    HTML + JS                │
               ▼ handler runs here,         └─────────────────────────────┘
       your existing API, your session
```

## Quick start

```bash
npm install marzi
```

```js
import { createRuntime, memoryStore } from "marzi";

const runtime = createRuntime({
  // What widgets may call. Each handler runs in your page, with your session.
  capabilities: [{
    name: "transactions.list",
    description: "The signed-in user's transactions, newest first.",
    handler: (params, { signal }) =>
      fetch("/api/transactions", { signal }).then((r) => r.json()),
  }],
  store: memoryStore(),            // where marzi.saveState lands; implement yours over your backend
  onAudit: (e) => console.log(e),  // every call, dispatched or refused
});

const widget = runtime.render(htmlTheModelWrote, document.getElementById("slot"));
widget.frame.style.height = "320px";   // the outer frame is yours to size
// later:
widget.destroy();
```

Inside the widget, the model's code gets one object:

```html
<ul id="out"></ul>
<script>
  var out = document.getElementById("out");
  marzi.call("transactions.list").then(function (rows) {
    rows.forEach(function (r) {
      var li = document.createElement("li");
      li.textContent = r.memo + "  " + r.amount;
      out.appendChild(li);
    });
  }, function (err) {
    out.textContent = "couldn't load: " + err.message;
  });
</script>
```

`marzi.call(name, params)` returns a promise; `marzi.saveState(value)` and
`marzi.loadState()` keep one small JSON value per saved widget. That's the whole
in-frame API.

**Getting the HTML.** marzi never calls a model; you do. Fill in the
placeholders in `prompts/widget-author.md` (or `widget-refine.md`), send it to
your model, hand the HTML back to `render`. The templates teach the model the
jail's rules. For a charting library, vendor its source and pass it in
`libraries`; marzi injects it inline, since the frame can never fetch it.

## Who decides what a widget may call

In 0.1.0, **registering a capability is the authorization.** Everything you pass
to `createRuntime` is callable by every widget. Register the way you'd expose a
public API: if you wouldn't want *any* widget calling it, leave it out.
Descriptions carry no enforcement weight; only your handler's validation does.
Per-widget grants, re-approval when a refinement asks for more, and a
read/write switch are designed for the next release.

## What marzi promises, and what it doesn't

> Generated widgets receive no ambient authority over the host; every
> application operation is mediated through explicit host capabilities.

Not promised: "no network of any kind", "the message channel is the only
channel", or that any permission system makes hostile code safe.

**Known residuals.** *WebRTC*, in every browser tested: a widget can reach a
STUN server of its choosing; the `webrtc 'block'` directive marzi sets is
honoured by none of Chrome, WebKit or Firefox, and the attack suite will flag
the day that changes. As a screen for the obvious case, `render` refuses any
body containing a WebRTC API name (`DEFAULT_SCREEN`; the `screen` option
changes the list). A filter, not containment: it can't see text that arrives
later through data. Also: DNS prefetch and preconnect hints; no CPU or memory
isolation; and nothing checks that a widget's *numbers* are right.

## Your page's Content-Security-Policy

marzi's frames are `srcdoc` frames, which get a copy of the parent page's
policy. If yours forbids inline scripts (`script-src 'self'`, `default-src
'self'`, any nonce or hash policy), no widget starts and `onWidgetFault`
reports `never-started`; `'unsafe-inline'` beside a nonce is ignored. A
`style-src` or `img-src` limit strips widgets' styles or `data:` images.
Measured in Chrome, WebKit and Firefox.

Pages that show widgets need a policy that allows inline scripts and styles. If
your app runs a strict policy, give only those pages a looser one. A later
release may lift this by loading the warden from a file.

## Try it

From a checkout of this repository:

```bash
npm install && npm run build
node --env-file=.env server.js        # → http://127.0.0.1:8000/
```

That's Ledger, a small finance app over a transactions CSV: describe a widget,
watch the model write it, save it, refine it, roll it back. It's the reference
for wiring capabilities, libraries, storage and the audit log. Generation needs
`ANTHROPIC_API_KEY` in `.env`, read by the server only. `demo/` keeps the older
single-purpose pages, including the self-navigation leak and the listener that
proves whether anything left the machine.

## The attack suite

```bash
npx playwright install webkit firefox    # once; Chrome itself must be installed
npm test                                 # build, then every attack in three browsers
```

Hostile widgets try to escape, exfiltrate and overreach: thirteen classes under
`tests/attacks/`, each negative paired with a positive control. The witness is
a server outside the browser (HTTP on `127.0.0.1:9999`, UDP on `:3478`),
because a page can't be trusted to report on itself. Retries are off, so a
flaky pass can't hide a leak. Nothing is tagged unless it's green.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | `createRuntime`, the registry, the switchboard |
| `src/jail.ts` | sandbox tokens, CSP, the warden, document composition |
| `src/rpc.ts` | JSON-RPC types and the inbound validator |
| `src/frame-stub.ts` | the in-frame helper: **untrusted**, ergonomics only |
| `src/store.ts` | the storage contract and an in-memory store |
| `prompts/` | the author and refine templates |
| `app/` | Ledger, the reference host app |
| `tests/` | the attack suite: specs, attack pages, the outside witness |

Zero runtime dependencies.

## License

MIT
