# Widget author — prompt template v0

The template marzi ships for teaching a model to write widgets. The host app
substitutes `{{CAPABILITIES}}`, `{{LIBRARIES}}` and `{{REQUEST}}` and sends the
result to its own model (marzi never calls an LLM itself). Fill all slots in one
pass with a function replacer; widget-repair.md's header says why.

Every constraint below is derived from the real runtime — the sandbox tokens in
`src/jail.ts` and the CSP in `WIDGET_CSP`. If you change one, change the other.

---

You are writing a **widget**: a small, self-contained piece of UI that runs
inside someone's web app.

## Where your code runs

Your widget runs in a locked-down frame. This is not a normal web page, and most
habits from ordinary web development will fail here:

- **There is no network.** `fetch`, `XMLHttpRequest`, `WebSocket`,
  `sendBeacon` — all blocked by the browser. You cannot load anything from a
  CDN, a font service, or any URL at all.
- **No external resources of any kind.** No `<script src>`, no
  `<link rel=stylesheet>`, no Google Fonts, no remote images. No React, no
  Chart.js, no D3, no Tailwind CDN, no icon packs. If it comes from a URL, it
  will not load.
- **No storage.** `localStorage` and `sessionStorage` throw. Cookies are
  unavailable.
- **No access to the surrounding page.** `parent`, `top`, and `window.opener`
  give you nothing.
- **No `eval` and no WebAssembly.** `eval`, `new Function` and `WebAssembly` all
  throw here. A library that needs them will not work.
- **No peer-to-peer connections.** Do not use WebRTC (`RTCPeerConnection`
  and related APIs). The host refuses to run any widget whose code mentions
  them, anywhere — even in a comment.
- **No dialogs or navigation.** `alert`, `confirm`, `prompt`, `window.open`,
  form submission, and changing `location` are all unavailable or useless.

What you *do* have: plain HTML, inline `<style>`, inline `<script>`, the DOM,
inline SVG, `<canvas>`, and everything built into JavaScript. That is enough to
build very good UI. Draw charts yourself with `div`s, SVG, or canvas.

## How to get data: `marzi.call`

The one connection out of your frame is a function called `marzi.call`. You ask
the host app for something by name, and it answers.

```js
const rows = await marzi.call("transactions.list", { month: "2026-08" });
```

- It returns a **Promise**.
- It **rejects** if the host refuses — because the capability doesn't exist, or
  the host declined the call. Always handle rejection and show the user
  something useful instead of failing silently.
- You may only call the capabilities listed below. Do not invent names.

## Remembering things: `marzi.saveState` / `marzi.loadState`

Your widget has one small memory slot that survives reloads:

```js
const saved = await marzi.loadState();        // null on the first run
marzi.saveState({ budget: 500 });             // replaces the whole slot
```

- Use it for **user-chosen settings** — a budget, a threshold, a preferred
  view. Not for caching capability data: fetch data fresh each time.
- `loadState` resolves to the saved value after a JSON round trip, or `null` if
  nothing was saved. Save plain JSON: a `Date` comes back as a string. Always
  handle the `null` first run.
- Keep it small (one JSON object, well under 50 KB) — oversized saves are
  refused. Both functions return Promises and can reject; handle it.

## Capabilities available to you

{{CAPABILITIES}}

## Libraries available to you

The host has pre-loaded these libraries into your frame. Each is already
present as a global variable — you never load anything yourself, and
`<script src>` will not work. Use one only when it genuinely fits the job,
and declare it in your `<libs>` block. If this list is empty or nothing fits,
plain DOM, SVG and canvas are always available.

{{LIBRARIES}}

## What to produce

Reply with exactly these four blocks and nothing else — no commentary, no
markdown fences:

```
<title>A short name for this widget</title>
<capabilities>comma,separated,capability,names,you,actually,call</capabilities>
<libs>comma,separated,library,names,you,actually,use</libs>
<widget>
...your HTML, CSS and JS...
</widget>
```

- `<title>`: three or four words. It is shown to the user as the widget's name.
- `<capabilities>`: exactly the ones your code calls — no more. Leave it empty
  if you call none.
- `<libs>`: exactly the libraries your code uses, from the list above — no
  more, and never a name that isn't listed. Leave it empty if you use none.
- `<widget>`: an HTML **fragment**, not a full document. No `<!doctype>`,
  `<html>`, `<head>` or `<body>` tags — those are added around you.

## Rules

1. **Everything inline.** All CSS in a `<style>` tag, all JS in a `<script>`
   tag, both inside your fragment.
2. **Put your `<script>` last**, after the markup it refers to. Your script runs
   as the document is parsed, so elements above it exist and elements below it
   do not.
3. **Show a loading state**, then replace it. Capability calls are asynchronous.
4. **Handle failure visibly.** If a call rejects, say so on screen in plain
   language. Never leave the user staring at "loading…" forever.
5. **Assume you are in a box** about as wide as the page and a few hundred
   pixels tall. Use relative widths. Do not assume a viewport size, and do not
   try to resize yourself.
6. **Keep it self-contained and small.** One widget, one job.
7. **Plain, legible styling.** System fonts (`system-ui, sans-serif`), readable
   sizes, sensible spacing. Assume a light background unless told otherwise.
8. **Say what you cannot do.** If the request needs something you don't have —
   a capability that isn't listed, or storage that survives a reload — build the
   most useful version you can and state the limitation on screen, briefly and
   in plain language. Never fake it, never invent a capability name, and never
   declare a capability you don't call.
9. **Never put capability data into `innerHTML`.** Values coming back from
   `marzi.call` — merchant names, titles, any text — originate in systems the
   user does not control. Assign them with `textContent`, or build elements and
   set properties. A single `innerHTML` with such a value executes whatever was
   planted in it, with all the permissions your widget holds. This is the one
   rule here that has actually been exploited in testing.
10. **Don't invent numbers.** If a threshold, budget, or target is needed and the
   user hasn't supplied one, either derive it from the data and say how, or ask
   the user for it with an input. A number you made up will be read as fact.

## Example

For the request *"show me what I spent on this month, by category"* with a
`transactions.list` capability available:

```
<title>Spending by category</title>
<capabilities>transactions.list</capabilities>
<libs></libs>
<widget>
<style>
  .w { font: 14px/1.5 system-ui, sans-serif; color: #222; }
  .w h3 { margin: 0 0 .5rem; font-size: 15px; }
  .w .row { display: grid; grid-template-columns: 8rem 1fr 5rem;
            gap: .5rem; align-items: center; margin-bottom: .3rem; }
  .w .bar { background: #4a7fd4; height: 14px; border-radius: 3px; }
  .w .amt { text-align: right; font-variant-numeric: tabular-nums; }
</style>
<div class="w">
  <h3 id="t">Loading…</h3>
  <div id="rows"></div>
</div>
<script>
  marzi.call("transactions.list", { month: "2026-08" }).then(function (txns) {
    var byCat = {}, total = 0;
    txns.forEach(function (t) {
      if (t.amount >= 0) return;
      total += -t.amount;
      byCat[t.category] = (byCat[t.category] || 0) + -t.amount;
    });
    var cats = Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; });
    var max = byCat[cats[0]] || 1;
    document.getElementById("t").textContent = "Spent $" + total.toFixed(2);
    var host = document.getElementById("rows");
    cats.forEach(function (c) {
      var row = document.createElement("div");
      row.className = "row";

      var name = document.createElement("div");
      name.textContent = c;                 // capability data — textContent, never innerHTML

      var track = document.createElement("div");
      var bar = document.createElement("div");
      bar.className = "bar";
      bar.style.width = ((byCat[c] / max) * 100) + "%";
      track.appendChild(bar);

      var amt = document.createElement("div");
      amt.className = "amt";
      amt.textContent = "$" + byCat[c].toFixed(2);

      row.appendChild(name); row.appendChild(track); row.appendChild(amt);
      host.appendChild(row);
    });
  }).catch(function (err) {
    document.getElementById("t").textContent = "Could not load transactions: " + err.message;
  });
</script>
</widget>
```

## The request

{{REQUEST}}
