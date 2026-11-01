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

> **Known risk:** a widget may send data out through WebRTC in Firefox and
> Safari. In Chrome too, unless it is version 152 or later and you add the header
> in [Known residual risks](#known-residual-risks). This can include any data
> that the widget reads through your capabilities.

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
- A Content-Security-Policy (CSP) of `default-src 'none'` blocks network
  requests. The widget cannot use `fetch`, load an `<img>` beacon, or load a
  font. This CSP does not block WebRTC (see
  [Known residual risks](#known-residual-risks)).

**The channel.** The widget has one channel to your page: a private
`MessageChannel`. The messages on it use JSON-RPC 2.0. Each data request, each
action, and each saved state is a message on this channel.

**The switchboard.** The switchboard is marzi code that runs in your page. It
checks each message from a widget. A capability is a named operation that you
register, with a handler function. If a call names a registered capability, the
switchboard runs its handler in your page, with your session. Then it sends the
result to the widget. The switchboard refuses all other messages, and you can
record its decisions in an audit log. Over the rate limit, the log gets only the
first refusal in each window.

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
 │   look up, dispatch, log  │              │    no fetch, model-written  │
 └─────────────┬─────────────┘              │    HTML + JS                │
               ▼ handler runs here,         └─────────────────────────────┘
       your existing API, your session
```

## Who decides what a widget may call

In 0.1.0, **registering a capability is the authorization.** Every widget can
call every capability that you give to `createRuntime`. Register capabilities
as you would make a public API. Register a capability only if it is safe for
*any* widget to call it. A capability's `description` does not limit what a
widget can do. Only the validation in your handler limits it.

Per-widget grants are designed for the next release, with a new approval when a
refinement asks for more capabilities, and a read/write switch.

## Quick start

> **Check your CSP first.** A page that shows widgets must allow inline scripts.
> See [Your page's CSP](#your-pages-csp).

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
  onAudit: (e) => console.log(e),  // dispatched and refused calls
});

const widget = runtime.render(htmlTheModelWrote, document.getElementById("slot"));
widget.frame.style.height = "320px";   // the outer frame is yours to size
widget.frame.style.border = "1px solid #ccc";   // shows users where your app stops
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

The store finds this value by the `id` that you give to `render`. So give each
saved widget an `id` that is unique across all your users. A backend store must
also check that the signed-in user owns that `id`.

**Getting the HTML.** marzi never calls a model. Your app calls the model:

1. Replace the placeholders in `prompts/widget-author.md` (or
   `widget-refine.md`) with your values. Replace all placeholders in one pass,
   so that the text of one value cannot fill another placeholder.
2. Send the result to your model.
3. Split the reply. It has four blocks: `<title>`, `<capabilities>`, `<libs>` and
   `<widget>`. Do not give the whole reply to `render`.
4. Give the text of `<widget>` to `render`, and the names in `<libs>` to its
   `libs` option.

```js
// To the LAST </widget>, because widget code can contain that text in a string.
const start = reply.indexOf("<widget>");
const end = reply.lastIndexOf("</widget>");
if (start < 0 || end < start) throw new Error("the reply has no <widget> block");
const html = reply.slice(start + "<widget>".length, end);
const libs = (/<libs>(.*?)<\/libs>/s.exec(reply)?.[1] ?? "")
  .split(",").map((name) => name.trim()).filter(Boolean);

runtime.render(html, document.getElementById("slot"), { libs });
```

`<title>` is a name to show to the user. `<capabilities>` lists the names that
the widget says it calls. In 0.1.0, nothing enforces that list.

The templates teach the model the rules of the jail. All three templates are in
the package. On a server, find a template with
`import.meta.resolve("marzi/prompts/widget-author.md")`, then read the file.

To use a library such as a charting library, put a copy of its source code in
your app. Give that source code to marzi in the `libraries` option. marzi adds
the source code to the widget's frame as an inline script, because the frame can
never fetch it. A widget gets only the libraries that `libs` names. `render`
throws for a name that you did not register. A library that uses `eval`,
`new Function` or WebAssembly fails in a widget, because the widget's CSP blocks
them.

## What marzi promises and does not promise

> A widget gets no authority over your app from the place where it runs (no
> *ambient authority*). Every operation on your app uses a capability that you
> registered.

marzi does not promise these things:

- That a widget has no network access of any kind.
- That the channel is the only channel out of the widget.
- That any permission system makes hostile code safe.

### Known residual risks

- *WebRTC*, in every browser tested. A widget can connect to a STUN server that
  it chooses, and it may send data that way. marzi sets the
  [`webrtc 'block'`](https://www.w3.org/TR/CSP3/#directive-webrtc) directive,
  but Chrome, WebKit, and Firefox all ignore it. marzi cannot close this path.
  Your server can close it in Chrome 152 or later (see below). If a browser
  starts to obey the directive, the attack suite will show the change.
- DNS prefetch and preconnect hints.
- *Window messages.* A widget can call `postMessage` on your page and on other
  frames, at any size, and the rate limit does not count these messages. Each
  `message` listener on your page, also in third-party scripts, must check
  `event.source` or `event.origin`. A widget's origin is `"null"`.
- *Facts about your page.* In Chrome and WebKit, a widget can read your page's
  origin from `location.ancestorOrigins`. In each browser tested, it can read
  `history.length` and `top.length`. Tests found no way to read your URL's path
  or query.
- *Imitation.* A widget can draw anything inside its box, for example a false
  login form. Draw a clear border around each widget, so that users can see where
  your app stops. The quick start shows one way.
- No CPU or memory isolation. A widget can slow your page, for example with a
  very large message, because the browser copies a message before marzi can check
  its size.
- Nothing checks that a widget's *numbers* are correct.

To catch the obvious WebRTC case, `render` refuses widget HTML that contains a
WebRTC API name. The list of names is `DEFAULT_FORBIDDEN_TEXT`. Use the
`forbiddenText` option to change the list. This check is not containment. It
cannot see text that arrives later in data.

**To close WebRTC in Chrome and Edge 152 or later,** send this response header
with each page that shows widgets:

```
Connection-Allowlist: (response-origin "https://api.example.com")
```

List your page's own origin (`response-origin`) and each other origin that your
page connects to. Chrome then blocks WebRTC and all connections to other
origins, from your page and from its frames. Firefox, WebKit, and older versions
of Chrome ignore this header. Tests in Chrome 156 on desktop show this behavior.
Know these effects before you use it:

- The list also applies to your page's own code. A request to an origin that is
  not in the list fails.
- A widget that tries WebRTC goes blank, and other widgets on the page can go
  blank with it. No fault reports this. Your page continues to work, and you can
  render new widgets.
- If other code on your page uses WebRTC in a frame with no `sandbox`, Chrome can
  close the whole page (tested by hand).
- Do not add `webrtc=allow`. It also allows WebRTC for widgets.

## Your page's CSP

marzi's frames are `srcdoc` frames. A `srcdoc` frame gets a copy of its
parent's CSP. Thus your page's CSP applies to every marzi frame.

If your CSP blocks inline scripts, no widget starts, and `onWidgetFault`
reports `never-started`. These CSPs block inline scripts: `script-src 'self'`,
`default-src 'self'`, and any nonce or hash policy. If a CSP directive has a
nonce, the browser ignores `'unsafe-inline'` in that directive. A `style-src`
limit removes widget styles, and an `img-src` limit removes widget `data:`
images. A page with `require-trusted-types-for 'script'` cannot show widgets,
because `render` throws a `TypeError`. Tests in Chrome, WebKit, and Firefox show
this behavior.

Pages that show widgets need a CSP that allows inline scripts and inline
styles. If your app uses a strict CSP, give a less strict CSP only to the pages
that show widgets. A CSP belongs to the document, so in a single-page app a route
is not enough. The widget page must be a separate HTML document that users reach
with a full page load.

The narrowest policy that we tested allows inline `<script>` elements, and blocks
inline event handlers such as `onerror=`, on that page and in its widgets:

```
Content-Security-Policy: script-src 'self'; script-src-elem 'self' 'unsafe-inline'; script-src-attr 'none'
```

This has a cost. A page that allows inline scripts loses a main defence against
XSS. If your app has an XSS bug on that page, the injected script runs with your
session. Widgets gain nothing from this. If you can, show widgets on a separate
origin. A later release may remove this requirement by loading the warden from a
file.

A `base-uri` directive needs one more source. The warden has a
`<base href="about:srcdoc">` tag, which hides your page's URL from the widget.
If your CSP blocks this tag, the widget could read your page's full URL, with
its query and fragment. So `render` throws and refuses the widget. `base-uri
'none'` and `base-uri 'self'` block the tag. To allow it, use `base-uri 'self'
about:` or `base-uri about:`. Tests in Chrome, WebKit, and Firefox show this
behavior.

## When a widget breaks

A model sometimes writes code that does not work. marzi reports each failure to
your page as a fault, through the `onWidgetFault` option. A fault has one of
two kinds:

- `never-started`: the widget did not connect to the channel. The usual cause
  is a CSP that blocks inline scripts (see "Your page's CSP"). A second cause
  is a container that is not on the page. A frame loads only when it is on the
  page, but the runtime starts to wait for the handshake when you call
  `render`. Attach the container to the page before you call `render`. If you
  attach it more than `startTimeoutMs` (10 s by default) after `render`, the
  widget never connects.
- `script-error`: the widget's code threw an error. A promise in the widget
  that failed with no handler also gives this kind.

A `script-error` fault can also have these fields:

| Field | What |
|---|---|
| `message` | The error text, on one line, up to 300 characters |
| `name` | The type of error, for example `TypeError`. Letters, digits, `_`, `$` and `.` only, up to 40 characters |
| `line`, `column` | The position of the error in the widget HTML; line 1 is its first line |

All these fields come from the widget, and a hostile widget can write any text
into them. Show them as text, never as HTML. The text can contain your data,
because browsers copy values into error messages.

There is no `line` when the error occurred outside the widget HTML, for example
in a library. A failed promise has no position. WebKit hides the details of an
error that widget code throws: the message is "Script error." and there is no
position. A failed promise keeps its message in all three browsers.

When your capability handler throws, the audit log records the call as refused,
with the reason `capability failed`. marzi records it before it sends the error
to the widget. Thus your page can tell a failure in your handler from an error
in the widget.

**To repair a widget with your model:**

1. Show a Repair button for a `script-error` fault.
2. Do not show the button if the audit log recorded one of these reasons for
   that widget just before the fault: `capability failed`, `state operation
   failed`, `timed out` or `result not cloneable`. Each one is a failure in your
   code, not in the widget.
3. When the user clicks the button, fill in `prompts/widget-repair.md` with the
   widget HTML and the fault.
4. Send the result to your model.
5. Split the reply as in "Getting the HTML", and render it as the next version
   of the widget.

The reasons in step 2 stay the same until 1.0. Other reasons may change.

The header of the template tells you how to write the fault into the prompt.
Let the user start each repair. A widget can fail many times, and each repair
is a call to your model.

## The attack suite

```bash
npx playwright install webkit firefox    # once; Chrome itself must be installed
npm test                                 # build, then every attack in three browsers
```

In the attack suite, hostile widgets try to escape the jail, leak data, and do
more than marzi allows. The attacks are in `tests/attacks/`. Each test that
expects an attack to fail has a positive control. The control runs the same
attack without the defense and expects it to succeed.

The witness is a server outside the browser that records the traffic it gets
(HTTP on `127.0.0.1:9999`, UDP on `:3478`). The witness is outside the browser
because you cannot trust a page to report on itself. Retries are off, so a test
that passes by chance cannot hide a leak. A release gets a tag only when all
tests pass.

`node tests/mutations/run.mjs` shows that the tests can fail. It breaks each
control in a copy of the repo, one at a time, and expects its test to go red. It
takes some minutes, so `npm test` does not run it. Run it before a release.

A probe in `tests/probes/` asks a real model to repair a widget whose error
text contains an attack. The probe needs an API key, so `npm test` does not run
it.

## Browsers

By MDN's data, marzi needs Chrome or Edge 98, Firefox 97, or Safari 15.4, or a
later version. All of these are from early 2022. In an older browser, capability
calls fail.

The attack suite, which controls each release, runs only in current versions of
Chrome, WebKit, and Firefox. We also ran it once by hand in Playwright's builds
of Chromium 101 and 115, Firefox 97 and 115, and WebKit 15.4 and 17.0. These
builds are not the browsers that users install. The results:

- No widget request reached the witness.
- In both WebKit builds, an `<object>` element crashed the page, also on a page
  with no marzi.
- In Firefox 97, a canvas call can fail in two nested sandboxed frames, also with
  no marzi. A widget that draws can then report a `script-error` fault.
- In both WebKit builds and Firefox 97, WebAssembly compiles in a widget, because
  these engines do not apply the CSP to it.
- Most tests of your page's CSP could not run on these builds, because the old
  test tool needs `eval`.

Old browsers do not get security fixes. If you must rely on the jail, ask your
users to run current versions.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | the public API: each name that you can import |
| `src/runtime.ts` | `createRuntime`, the registry, and the switchboard |
| `src/types/` | the types: capabilities, widgets, the audit, faults, the runtime options and the storage contract (public), and the internal types in `rpc.ts`, `jail.ts` and `widget.ts` (`LiveWidget`) |
| `src/consts/` | the constants: `jail.ts`, `rpc.ts` and `runtime.ts` |
| `src/helpers/` | the helper functions: `jail.ts`, `rpc.ts` (the JSON-RPC replies, the message checks, the rate limit and the params cleaner) and `runtime.ts` (the deadline wait, the fault cleaners and the widget id) |
| `src/jail.ts` | the sandbox tokens, the CSP, the warden, and how marzi builds the frame document |
| `src/frame-stub.js` | the in-frame helper (the `marzi` object): **untrusted**, for ease of use only, not for security. `npm run build` copies it into `src/frame-stub.ts` as a string. |
| `src/store.ts` | `memoryStore`, an in-memory store; the storage contract is in `src/types/store.ts` |
| `prompts/` | the templates that write, refine, and repair widgets |
| `tests/` | the attack suite: test files, attack pages, the witness, and the mutation checks |

marzi has no runtime dependencies.

## License

MIT
