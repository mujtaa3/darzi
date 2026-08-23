# CSP / frame-src — empirically verified

Verified 2026-08-21 with attack harnesses run in Chrome 145, Firefox 142, WebKit 26, Safari 26.3, plus reading enforcement source in Chromium/Gecko/WebKit. High confidence.

## frame-src DOES stop self-navigation
- The EMBEDDER's `frame-src` is checked against every navigation of a child frame — including the frame navigating ITSELF (`location=`, `location.replace/assign`, meta-refresh, form submit, `<a target=_self>`).
- Blocked BEFORE any DNS/TCP leaves the machine (measured: zero packets reached the exfil server for every blocked vector in every engine; violation reported on the PARENT document).
- Must be `frame-src 'none'` — any allowed origin becomes an exfil channel (`https://allowed/?stolen=…`). `'self'` is an allowed origin.
- Spec-vs-impl gap: shipping browsers check the parent's policy; CSP3 spec text technically implies the initiator's (open bug w3c/webappsec-csp#624). We rely on shipped behavior → the attack suite must re-test every release.

## frame-src works in a <meta> tag
- The meta ignore-list is ONLY: `report-uri`, `frame-ancestors`, `sandbox`. `frame-src` is NOT on it → usable via a meta tag; no server header needed.
- Don't confuse `frame-ancestors` (who may embed ME — header-only) with `frame-src` (what I may embed — works in meta).
- COOP/COEP are truly header-only (not valid `http-equiv` keywords). Process isolation still needs the app's server.
- Myth busted: a meta CSP injected by JS AFTER load is NOT ignored — CSP is additive, so it ADDS a policy (can only tighten, never loosen).

## The warden double-iframe works (zero app config)
- Nest the widget in an outer sandboxed frame WE control, whose own meta `frame-src 'none'` governs the inner frame's navigation. Verified blocking self-nav in all four engines.
- Works for TWO independent reasons: embedder-checked frame-src + srcdoc inherits the parent's policy container.
- Outer and inner get DIFFERENT opaque origins → the widget cannot reach the warden's DOM/location.
- Depends on `about:` URLs skipping the navigation CSP check (true today, spec'd by omission — mild fragility). Cost: the outer frame runs our port-forwarding shim, so it joins the TCB.

## We can detect whether a policy is set
- No enumeration API, BUT `SecurityPolicyViolationEvent.originalPolicy` returns the FULL policy text when a probe triggers a violation. A startup probe can verify enforcement.
- Traps: Report-Only fires the event but blocks NOTHING (false positive); the probe is NOT side-effect-free (real navigation in the not-blocked branch); absence of event ≠ absence of enforcement (async, no latency bound); dedupe (Chrome can fire twice).

## What frame-src does NOT cover (residual)
- Popups (`window.open`, `target=_blank`) and top-nav — close by omitting sandbox flags (we already do).
- **WebRTC** — needs the separate `webrtc` directive; Chrome experimental, Firefox & Safari DON'T implement it → residual leak there.
- DNS-prefetch / preconnect / speculationrules — uncovered.
- Subresource exfil (fetch/img/WebSocket/sendBeacon) — closed separately by OUR OWN srcdoc meta `default-src 'none'` (policies intersect; our 'none' wins over a permissive inherited host CSP).

Harness: scratchpad/fsrc/m_server.py + matrix.js
