# Packaging & distribution

## 2026-08-19 · Package vs copy-paste doc
- npm is the JS world's module registry (think Go modules). Copy-pasted security code can't be patched: when browsers change, stale copies stay broken and unfindable. A package ships the fix as a version bump.
- Blind-install risk is mitigated by design, not by un-packaging: keep the runtime small enough to read in a sitting, write docs that teach the mechanism, ship the escape-attempt test suite so adopters can watch attacks fail themselves.

## 2026-08-20 · A JS library is just exported functions
- Same model as Go/Python: a module `export`s functions, consumers `import` them. No main(); inert until the host app calls it.
- `package.json` ≈ `go.mod`. Unlike Go (consumers compile source), npm ships prebuilt output: compiled `.js` plus `.d.ts` declaration files (API signatures without bodies — needed because types are erased).
- Two module systems exist for history reasons: CommonJS (`require`, legacy) and ES Modules (`import`, the standard). New library in 2026 → ESM-only; skip the dual-format legacy.
- Bundlers (webpack/vite) are for apps, not libraries: we compile with plain `tsc` and publish readable module files. Also an audit win — npm content stays human-readable.
