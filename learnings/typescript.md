# TypeScript

## 2026-08-19 · TS = JS + compile-time-only types
- The compiler checks types, then deletes them and emits plain JS. Nothing survives to runtime — no reflection, no type switches on live data (unlike Go).
- Typing is structural, like Go interfaces: a value satisfies a type by shape, not by declaration.
- Security consequence: types can't validate hostile input. Every message from the jail gets checked by real runtime code; the TS type on it is documentation.
- TS has a few features that generate runtime code (enums, decorators) — we avoid them; our TS is strictly the erasable kind.

## 2026-08-21 · Erasure, observed (rung 0)
Wrote three things in `src/index.ts`: a `const`, a `type` alias, a `function`. After `tsc`:
- `dist/index.js` — the const and function survive verbatim. **The `type` line is simply gone.** Not emptied, not stubbed: absent.
- `dist/index.d.ts` — all three appear, but with bodies stripped (`export declare function describe(): string`). This is the header file consumers' editors read.
- Confirms the security rule: a type on an inbound message is a comment as far as runtime is concerned. Only real validation code enforces anything.

Strict mode verified live: `items[i].toUpperCase()` errors with "Object is possibly 'undefined'" thanks to `noUncheckedIndexedAccess` — the JS equivalent of being forced to check `v, ok := m[k]`.
