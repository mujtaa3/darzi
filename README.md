# marzi

**marzi lets the users of your web app make their own widgets. A model writes
each widget. The widgets use your app's real API, and marzi never trusts their
code.**

> **Status:** version 0.1.0 contains the runtime. The containment is built and
> tested in three browsers. Per-widget grants are planned for the next release.
> The API may change before 1.0.

> **Known risk:** a widget may send data out through WebRTC in Firefox and
> Safari. In Chrome too, unless it is version 152 or later and you add the header
> in [Known residual risks](#known-residual-risks). This can include any data
> that the widget reads through your capabilities.

## The problem

A model writes each widget from a prompt, and it may follow any instruction in
that prompt. Some of that text may come from someone other than your user.
Examples are a transaction memo with hidden instructions, a support ticket that
an attacker wrote, or text pasted from a web page. So a widget can be hostile
even when your user is honest. For this reason, marzi treats each widget as
hostile, and it limits what a hostile widget can do.

## How marzi contains a widget

**The jail.** Each widget runs in a frame (an iframe) that the browser treats
as part of no site. Two browser controls apply to this frame:

- The [`sandbox`](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox)
  attribute blocks most features of a frame, and each token allows one feature.
  marzi sets only
  [`allow-scripts`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#allow-scripts),
  so the widget's code can run. marzi does not set `allow-same-origin`, so the
  browser gives the frame an
  [opaque origin](https://html.spec.whatwg.org/multipage/browsers.html#concept-origin-opaque),
  which matches no site. Your page, your cookies, and your `localStorage` belong
  to [your origin](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy).
  Thus the browser blocks the widget from all of them.
- A [Content-Security-Policy (CSP)](https://www.w3.org/TR/CSP3/) of
  [`default-src 'none'`](https://www.w3.org/TR/CSP3/#directive-default-src)
  blocks network requests. The widget cannot use `fetch`, load an `<img>` beacon,
  or load a font. This CSP does not block WebRTC (see
  [Known residual risks](#known-residual-risks)).

**The channel.** The widget has one channel to your page: a private
`MessageChannel`. The messages on it use JSON-RPC 2.0. Each data request, each
action, and each saved state is a message on this channel.

**The switchboard.** The switchboard is marzi code that runs in your page. It
checks each message from a widget. A capability is a named operation that you
register, with a handler function. If a call names a registered capability, the
switchboard runs its handler in your page, with your session. Then it sends the
result to the widget. The switchboard refuses all other messages, and you can
record its decisions in an audit log.

**The warden.** A frame can
[navigate](https://html.spec.whatwg.org/multipage/browsing-the-web.html#navigate)
*itself* to a URL such as `https://evil.example/?data=…`. Only the parent of the
frame can block this navigation. Thus marzi puts the widget's frame inside a
second frame that marzi controls: the warden. The warden contains no scripts. Its
CSP [`frame-src 'none'`](https://www.w3.org/TR/CSP3/#directive-frame-src) blocks the
navigation before a packet leaves the machine. Browsers behave this way today, but
the [CSP standard's text is not settled](https://github.com/w3c/webappsec-csp/issues/624),
so the attack suite tests it in each release.

![Diagram. Your page sends the user's request to your server. Your server fills a prompt template from marzi, calls your model, and returns model-generated widget HTML. Your page holds your code, the marzi runtime and your capability handlers, which call your API. The channel, with JSON-RPC 2.0 messages, crosses the trust boundary to the jail. The jail holds the warden frame and the widget frame. The browser blocks network requests, self-navigation and access to your page. WebRTC and DNS prefetch are residual risks.](.github/assets/architecture.svg)

## Who decides what a widget may call

In 0.1.0, **registering a capability is the authorization.** Every widget can
call every capability that you give to `createRuntime`, even one that its
`<capabilities>` block does not list. Only the validation in your handler limits
a call, and a capability's `description` does not. So treat each capability as a
public API: register it only if it is safe for *any* widget to call it.

To confirm a write, show a dialog from your handler, outside the frame. A call's
deadline is 30 s by default (`callTimeoutMs`), and marzi does not stop a handler
that is still running. So watch `signal`, and close the dialog on abort.
Otherwise a person can approve the write after the widget was told that the call
timed out.

Per-widget grants are designed for the next release, with a new approval when a
refinement asks for more capabilities, and a read/write switch.

## Quick start

[QUICKSTART.md](QUICKSTART.md) shows how to install marzi, render a widget, get
widget HTML from your model, and repair a widget that breaks.

## Your page's CSP

marzi's frames are [`srcdoc`](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-srcdoc)
frames. A `srcdoc` frame gets a
[copy of its parent's CSP](https://html.spec.whatwg.org/multipage/browsers.html#determining-navigation-params-policy-container),
so your page's CSP applies to every marzi frame. A page that shows widgets
needs a CSP that allows inline scripts and inline styles.

Tests in Chrome, WebKit, and Firefox show these results:

| In your page's CSP | Result |
|---|---|
| [`script-src 'self'`](https://www.w3.org/TR/CSP3/#directive-script-src) or [`default-src 'self'`](https://www.w3.org/TR/CSP3/#directive-default-src) | These block inline scripts. No widget starts, and `onWidgetFault` reports `never-started`. |
| A [nonce](https://www.w3.org/TR/CSP3/#grammardef-nonce-source) or [hash](https://www.w3.org/TR/CSP3/#grammardef-hash-source) policy | The same, because a widget's script is different each time. If a directive has a nonce, the browser [ignores `'unsafe-inline'`](https://www.w3.org/TR/CSP3/#allow-all-inline) in that directive. |
| A [`style-src`](https://www.w3.org/TR/CSP3/#directive-style-src) limit | The browser removes widget styles. |
| An [`img-src`](https://www.w3.org/TR/CSP3/#directive-img-src) limit | The browser removes widget [`data:`](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/data) images. |
| [`require-trusted-types-for 'script'`](https://www.w3.org/TR/trusted-types/#require-trusted-types-for-csp-directive) | The page cannot show widgets, because `render` throws a `TypeError`. |
| [`base-uri 'none'`](https://www.w3.org/TR/CSP3/#directive-base-uri) or [`base-uri 'self'`](https://www.w3.org/TR/CSP3/#directive-base-uri) | `render` throws and refuses the widget (see the last paragraph). |

**If your app uses a strict CSP,** give a less strict CSP only to the pages that
show widgets. A CSP belongs to the document, so in a
[single-page app](https://developer.mozilla.org/en-US/docs/Glossary/SPA) a route is not enough. The widget page must be a separate HTML document that users reach
with a full page load.

**The narrowest policy that we tested** allows inline `<script>` elements
([`script-src-elem`](https://www.w3.org/TR/CSP3/#directive-script-src-elem)), and blocks inline event
handlers such as `onerror=` ([`script-src-attr`](https://www.w3.org/TR/CSP3/#directive-script-src-attr)),
on that page and in its widgets:

```
Content-Security-Policy: script-src 'self'; script-src-elem 'self' 'unsafe-inline'; script-src-attr 'none'
```

**This has a cost.** A page that allows inline scripts loses a main defense against
[XSS](https://developer.mozilla.org/en-US/docs/Web/Security/Attacks/XSS). If your app has an XSS bug on that page, the injected script runs with your
session. Widgets gain nothing from this. If you can, show widgets on a separate
[origin](https://developer.mozilla.org/en-US/docs/Glossary/Origin). A later release may remove this requirement by loading the warden from a
file.

**A [`base-uri`](https://www.w3.org/TR/CSP3/#directive-base-uri) directive needs one more source.** The warden has a
[`<base href="about:srcdoc">`](https://html.spec.whatwg.org/multipage/semantics.html#the-base-element) tag, which hides your page's URL from the widget. If
your CSP blocks this tag, the widget could read your page's full URL, with its
query and fragment. So `render` throws and refuses the widget. To allow the tag,
use `base-uri 'self' about:` or `base-uri about:`.

## When not to use marzi

Do not use marzi 0.1.0 if one of these is true:

- **A widget's data must not leave the browser.** A widget may send data out
  through WebRTC. You can close this path only in Chrome and Edge 152 or later (see
  [Known residual risks](#known-residual-risks)).
- **Every page must keep a strict script CSP.** A page that shows widgets must allow
  inline scripts, so it loses a main defense against XSS (see
  [Your page's CSP](#your-pages-csp)).
- **Widgets need different authority, and each cannot have its own runtime.** marzi
  does not enforce per-widget grants in 0.1.0 (see
  [Who decides what a widget may call](#who-decides-what-a-widget-may-call)).
- **You only need simple views.** If a chart or a filter is enough, let the model
  return a small spec, and draw it with your own components. No model code then
  runs, so nothing needs a jail.

## What marzi promises and does not promise

> A widget gets no authority over your app from the place where it runs (no
> *ambient authority*). Every operation on your app uses a capability that you
> registered.

marzi does not promise these things:

- That a widget has no network access of any kind.
- That the channel is the only channel out of the widget.
- That any permission system makes hostile code safe.

### Known residual risks

- *[WebRTC](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)*, in every browser tested. A widget can
  connect to a [STUN server](https://developer.mozilla.org/en-US/docs/Glossary/STUN) that it chooses, and it may
  send data that way. marzi sets the
  [`webrtc 'block'`](https://www.w3.org/TR/CSP3/#directive-webrtc) directive,
  but Chrome, WebKit, and Firefox all ignore it. marzi cannot close this path.
  Your server can close it in Chrome 152 or later (see below). If a browser
  starts to obey the directive, the attack suite will show the change.
- [DNS prefetch](https://html.spec.whatwg.org/multipage/links.html#link-type-dns-prefetch) and
  [preconnect](https://html.spec.whatwg.org/multipage/links.html#link-type-preconnect) hints.
- *Window messages.* A widget can call
  [`postMessage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage) on your page and on other
  frames, at any size, and the rate limit does not count these messages. Each
  [`message`](https://developer.mozilla.org/en-US/docs/Web/API/Window/message_event) listener on your page, also in
  third-party scripts, must check
  [`event.source`](https://developer.mozilla.org/en-US/docs/Web/API/MessageEvent/source) or
  [`event.origin`](https://developer.mozilla.org/en-US/docs/Web/API/MessageEvent/origin). A widget's origin is `"null"`.
- *Facts about your page.* In Chrome and WebKit, a widget can read your page's
  origin from [`location.ancestorOrigins`](https://developer.mozilla.org/en-US/docs/Web/API/Location/ancestorOrigins).
  In each browser tested, it can read
  [`history.length`](https://developer.mozilla.org/en-US/docs/Web/API/History/length) and
  [`top.length`](https://developer.mozilla.org/en-US/docs/Web/API/Window/length). Tests found no way to read your URL's path
  or query.
- *Imitation.* A widget can draw anything inside its box, for example a false
  login form. Draw a clear border around each widget, so that users can see where
  your app stops. The [quick start](QUICKSTART.md) shows one way.
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

[`response-origin`](https://w3c.github.io/connection-allowlists/#grammardef-connection-allowlist-response-origin) means your
page's own origin. Add each other origin that your
page connects to, as this example does with `https://api.example.com`.

Chrome then blocks WebRTC and all connections to other origins, from your page and
from its frames. Firefox, WebKit, and older versions of Chrome ignore this header.
We tested this in Chrome 156 on desktop. The header's
[specification](https://w3c.github.io/connection-allowlists/#http-headerdef-connection-allowlist)
is a Community Group draft, not a W3C Standard.

The header has these effects:

- **Your page's own requests.** A request to an origin that is not in the list
  fails.
- **Blank widgets.** A widget that tries WebRTC goes blank, and other widgets on
  the page can go blank with it. No fault reports this. Your page continues to
  work, and you can render new widgets.
- **Other WebRTC code on your page.** If it uses WebRTC in a frame with no
  [`sandbox`](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox), Chrome can close the whole page (tested by hand).
- **`webrtc=allow`.** Do not add it. It also allows WebRTC for widgets.

## The attack suite

In the
[attack suite](https://github.com/mujtaa3/marzi/blob/main/tests/README.md),
hostile widgets try to escape the jail, leak data, and do more than marzi allows.
It is in the repo, not in the npm package. A release gets a tag only when all
tests pass.

## Browsers

By MDN's data, marzi needs Chrome or Edge 98, Firefox 97, or Safari 15.4, or a
later version, all from early 2022. In an older browser, capability calls fail.

Each release is tested only in current versions of Chrome, WebKit, and Firefox.
In a one-time run on
[old builds](https://github.com/mujtaa3/marzi/blob/main/tests/README.md#old-browsers),
no widget request reached our test server. Old browsers do not get security fixes. If you must rely on the
jail, ask your users to run current versions.

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
| `tests/` | the attack suite: test files, attack pages, the witness, the mutation checks, and its own README |
| `QUICKSTART.md` | how to install marzi, render a widget, get widget HTML from a model, and repair a widget |
| `.github/assets/` | the diagram in this README |

marzi has no runtime dependencies.

## License

MIT
