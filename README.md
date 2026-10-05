# marzi

**marzi lets the users of your web app make their own widgets. A model writes
the code, and marzi runs that code but does not trust it.**

Every app has many small features that users want and that no one will build.
Examples are spending by weekday, invoices that are thirty days overdue, or a
button that archives last year. With marzi, a user describes the feature in one
sentence. A model writes a widget, and marzi runs it in your app with your real
API. The user keeps the widget.

> **Status:** version 0.1.0 contains the runtime. The containment is built and
> tested in three browsers. Per-widget grants are planned for the next release.
> The API may change before 1.0.

## The problem

A model writes a widget from a prompt. Anyone who can put text into that prompt
can affect the code. Examples are a transaction memo with hidden instructions,
a support ticket that an attacker wrote, or text pasted from a web page. Thus
marzi never trusts a widget. It always treats each widget as hostile, and it
limits what a hostile widget can do.

## How marzi contains a widget

**The jail.** Each widget runs in a frame (an iframe) that the browser treats
as part of no site. Two browser controls apply to this frame:

- The `sandbox` attribute has only the `allow-scripts` token. Thus the widget
  cannot access your page or your cookies.
- A Content-Security-Policy (CSP) of `default-src 'none'` blocks the network.
  The widget cannot use `fetch`, load an `<img>` beacon, or load a font.

**The channel.** The widget has one channel to your page: a private
`MessageChannel`. The messages on it use JSON-RPC 2.0. Each data request, each
action, and each saved state is a message on this channel.

**The switchboard.** The switchboard is marzi code that runs in your page. It
checks each message from a widget. A capability is a named operation that you
register, with a handler function. If a call names a registered capability, the
switchboard runs its handler in your page, with your session. Then it sends the
result to the widget. The switchboard refuses all other messages, and you can
record each decision in an audit log.

**The warden.** A frame can navigate *itself* to a URL such as
`https://evil.example/?data=…`. Only the parent of the frame can block this
navigation. Thus marzi puts the widget's frame inside a second frame that marzi
controls: the warden. The warden contains no scripts. Its CSP
`frame-src 'none'` blocks the navigation before a packet leaves the machine.

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

In the widget, the model's code gets one object, `marzi`:

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

`marzi.call(name, params)` returns a promise. `marzi.saveState(value)` and
`marzi.loadState()` save and load one small JSON value for each saved widget.
These three methods are the full in-frame API.

**Getting the HTML.** marzi never calls a model. Your app calls the model:

1. Replace the placeholders in `prompts/widget-author.md` (or
   `widget-refine.md`) with your values.
2. Send the result to your model.
3. Give the HTML that the model returns to `render`.

The templates teach the model the rules of the jail. Both templates are in the
package. On a server, find a template with
`import.meta.resolve("marzi/prompts/widget-author.md")`, then read the file.

To use a library such as a charting library, put a copy of its source code in
your app. Give that source code to marzi in the `libraries` option. marzi adds
the source code to the widget's frame as an inline script, because the frame can
never fetch it.

## Who decides what a widget may call

In 0.1.0, **registering a capability is the authorization.** Every widget can
call every capability that you give to `createRuntime`. Register capabilities
as you would make a public API. Register a capability only if it is safe for
*any* widget to call it. A capability's `description` does not limit what a
widget can do. Only the validation in your handler limits it.

These features are designed for the next release:

- Per-widget grants.
- A new approval when a refinement (a new version of a widget) asks for more
  capabilities.
- A read/write switch.

## What marzi promises and does not promise

> A widget gets no authority over your app from the place where it runs (no
> *ambient authority*). Every operation on your app uses a capability that you
> registered.

marzi does not promise these things:

- That a widget has no network access of any kind.
- That the channel is the only channel out of the widget.
- That any permission system makes hostile code safe.

**Known residual risks:**

- *WebRTC*, in every browser tested. A widget can connect to a STUN server that
  it chooses. marzi sets the `webrtc 'block'` directive, but Chrome, WebKit, and
  Firefox all ignore it. If a browser starts to obey it, the attack suite will
  show the change.
- DNS prefetch and preconnect hints.
- No CPU or memory isolation.
- Nothing checks that a widget's *numbers* are correct.

To catch the obvious WebRTC case, `render` refuses widget HTML that contains a
WebRTC API name. The list of names is `DEFAULT_SCREEN`. Use the `screen` option
to change the list. The screen is not containment. It cannot see text that
arrives later in data.

## Your page's CSP

marzi's frames are `srcdoc` frames. A `srcdoc` frame gets a copy of its
parent's CSP. Thus your page's CSP applies to every marzi frame.

If your CSP blocks inline scripts, no widget starts, and `onWidgetFault`
reports `never-started`. These CSPs block inline scripts: `script-src 'self'`,
`default-src 'self'`, and any nonce or hash policy. If a CSP directive has a
nonce, the browser ignores `'unsafe-inline'` in that directive. A `style-src`
limit removes widget styles, and an `img-src` limit removes widget `data:`
images. Tests in Chrome, WebKit, and Firefox show this behavior.

Pages that show widgets need a CSP that allows inline scripts and inline
styles. If your app uses a strict CSP, give a less strict CSP only to the pages
that show widgets. A later release may remove this requirement by loading the
warden from a file.

## Try it

In a clone of this repository, run these commands:

```bash
npm install && npm run build
node --env-file=.env server.js        # → http://127.0.0.1:8000/
```

This starts Ledger, a small finance app that uses a CSV file of transactions.
In Ledger, you describe a widget and see the model write it. You can save the
widget, refine it, and restore an earlier version. Ledger is the reference
example for how to connect capabilities, libraries, storage, and the audit log.

To generate widgets, put `ANTHROPIC_API_KEY` in `.env`. Only the server reads
this key. The `demo/` folder has the older single-purpose pages. These include
the self-navigation leak and the listener that proves if anything left the
machine.

## The attack suite

```bash
npx playwright install webkit firefox    # once; Chrome itself must be installed
npm test                                 # build, then every attack in three browsers
```

In the attack suite, hostile widgets try to escape the jail, leak data, and do
more than marzi allows. There are thirteen classes of attack in
`tests/attacks/`. Each test that expects an attack to fail has a positive
control. The control runs the same attack without the defense and expects it to
succeed.

The witness is a server outside the browser that records the traffic it gets
(HTTP on `127.0.0.1:9999`, UDP on `:3478`). The witness is outside the browser
because you cannot trust a page to report on itself. Retries are off, so a test
that passes by chance cannot hide a leak. A release gets a tag only when all
tests pass.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | `createRuntime`, the registry, and the switchboard |
| `src/jail.ts` | the sandbox tokens, the CSP, the warden, and how marzi builds the frame document |
| `src/rpc.ts` | JSON-RPC types and the validator for incoming messages |
| `src/frame-stub.ts` | the in-frame helper (the `marzi` object): **untrusted**, for ease of use only, not for security |
| `src/store.ts` | the storage interface and an in-memory store |
| `prompts/` | the templates that write and refine widgets |
| `app/` | Ledger, the reference app |
| `tests/` | the attack suite: test files, attack pages, and the witness |

marzi has no runtime dependencies.

## License

MIT
