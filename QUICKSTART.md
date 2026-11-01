# Quick start

> **Check your CSP first.** A page that shows widgets must allow inline scripts.
> See [Your page's CSP](README.md#your-pages-csp).

> **Register with care.** Every widget can call every capability that you register.
> See [Who decides what a widget may call](README.md#who-decides-what-a-widget-may-call).

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
  store: memoryStore(),            // for demos: it empties on a reload; implement yours over your backend
  onAudit: (e) => console.log(e),  // dispatched and refused calls
});

const widget = runtime.render(htmlTheModelWrote, document.getElementById("slot"), { id: savedWidgetId });
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

marzi saves a widget's state, not the widget. Your app saves the widget HTML, and
renders it again with the same `id`. `memoryStore()` empties on a reload, so a real
app implements `getState` and `putState` over its backend.

The store finds this value by the `id` that you give to `render`. So give each
saved widget an `id` that is unique across all your users. A backend store must
also check that the signed-in user owns that `id`.

## Getting the HTML

marzi never calls a model. Your app calls the model:

1. Take the text of `prompts/widget-author.md` (or `widget-refine.md`) after its
   `---` line, for example with `template.split("\n---\n")[1]`. The text above
   that line is for you, not for the model.
2. Replace the placeholders with your values. Replace all placeholders in one
   pass, so that the text of one value cannot fill another placeholder.
3. Send the result to your model.
4. Split the reply. It has four blocks: `<title>`, `<capabilities>`, `<libs>` and
   `<widget>`. Do not give the whole reply to `render`.
5. Give the text of `<widget>` to `render`, and the names in `<libs>` to its
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

`<title>` is a name to show to the user. It is model output, so show it as text.
`<capabilities>` lists the names that the widget says it calls. In 0.1.0, nothing
enforces that list.

Fill `{{CAPABILITIES}}` with each capability's name, parameters and result. The
model knows only what you write there.

The templates teach the model the rules of the jail. All three templates are in
the package. On a server, find a template with
`import.meta.resolve("marzi/prompts/widget-author.md")`, then read the file. In a
browser bundle, import the file as text, for example with Vite's
`marzi/prompts/widget-author.md?raw`.

To use a library such as a charting library, put a copy of its source code in
your app. Give that source code to marzi in the `libraries` option. marzi adds
the source code to the widget's frame as an inline script, because the frame can
never fetch it. A widget gets only the libraries that `libs` names. `render`
throws for a name that you did not register. A library that uses `eval`,
`new Function` or WebAssembly fails in a widget, because the widget's CSP blocks
them.

## When a widget breaks

A model sometimes writes code that does not work. marzi reports each failure to
your page as a fault, through the `onWidgetFault` option. A fault has one of
two kinds:

- `never-started`: the widget did not connect to the channel. The usual cause
  is a CSP that blocks inline scripts (see [Your page's CSP](README.md#your-pages-csp)). A second cause
  is a container that is not on the page. A frame loads only when it is on the
  page, but the runtime starts to wait for the handshake when you call
  `render`. Attach the container to the page before you call `render`. If you
  attach it more than `startTimeoutMs` (10 s by default) after `render`, the
  widget never connects.
- `script-error`: the widget's code threw an error. A promise in the widget
  that failed with no handler also gives this kind.

One failure gives no fault. A widget that navigates itself, for example with a
link or `location`, goes blank. The warden blocks the navigation, so nothing
leaves, but your page gets no signal.

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
with the reason `capability failed`. marzi records it, then gives the widget only
that fixed text. The real error goes to your console. To show the widget a reason,
such as bad params, return it as a value and do not throw.

**To repair a widget with your model:**

1. Show a Repair button for a `script-error` fault.
2. Do not show the button if the audit log recorded one of these reasons for
   that widget just before the fault: `capability failed`, `state operation
   failed`, `timed out` or `result not cloneable`. Each one usually means a failure
   in your code, not in the widget.
3. When the user clicks the button, take the text of `prompts/widget-repair.md`
   after its `---` line, and fill it in with the widget HTML and the fault.
4. Send the result to your model.
5. Split the reply as in [Getting the HTML](#getting-the-html), and render it as the next version
   of the widget.

The reasons in step 2 stay the same until 1.0. Other reasons may change.

The header of the template tells you how to write the fault into the prompt.
Let the user start each repair. A widget can fail many times, and each repair
is a call to your model.
