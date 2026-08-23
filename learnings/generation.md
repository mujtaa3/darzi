# Generation — what models actually write

## 2026-08-22 · First real run (prompt template v0, Claude Opus 5)

Three widgets generated blind from `prompts/widget-author.md` against one capability
(`transactions.list`). **All three passed all 11 static compliance checks.**

| request | out tokens | bytes | notable |
|---|---|---|---|
| spending by category, bar chart | 2349 | 5370 | built a Jul/Aug toggle from catalog metadata alone |
| "am I overspending?" | 3708 | 6489 | invented a *derivable* baseline instead of fabricating one |
| "set a monthly budget and track it" | 3644 | 7005 | disclosed the missing persistence rather than faking it |

~$0.07–0.10 per widget at Opus 5 rates.

### Predictions that were WRONG
I expected: external CDN resources, `localStorage`, full documents instead of fragments,
missing rejection handling, over-declared capabilities, invented capability names.
**None of these occurred in three samples.** The template's constraint list works better
than expected. (Caveat: n=3, and all three were honest, non-adversarial requests.)

### What actually mattered

**Capability descriptions are part of the spec, not documentation.** A throwaway line —
"Available months: 2026-07 and 2026-08" — became a month-toggle UI nobody asked for.
Rich descriptions buy better widgets; thin ones silently produce worse ones.

**Models hedge against our data.** `typeof t.amount !== "number"`, `Array.isArray(txns)`,
`t.category || "Uncategorised"`. We treat the widget as hostile; it treats our capability
results as unreliable. Mutual suspicion, correct on both sides.

**The refusal framing lands.** Error copy came out as *"The app did not allow this
request"* with no prompting about permissions beyond the template's one line. Good sign
for rung 5, when refusals become routine.

**Faced with a missing capability, the model degraded honestly.** Asked to persist a
budget with no storage capability, it did NOT invent a capability, declare one it never
called, or silently fake it. It made the budget a live input and printed *"Budget is not
saved between sessions."* That was the best of the four possible outcomes.

**Widgets derive "today" from the data, not the clock.** Both time-aware widgets computed
the current day from the max transaction date rather than `new Date()`. Sensible against
a fixture; worth remembering when real data arrives.

### Findings that change what we build

1. **Widget state is now proven necessary, not optional.** The budget widget's honest
   disclosure is still a bad experience — the user sets a budget and loses it on reload.
   Interactive widgets *want* to persist user input. Rung 6 storage / `marzi.saveState`
   is load-bearing.
2. **Static checks cannot catch fabrication.** Nothing we check verifies the widget's
   NUMBERS are right. A widget that silently miscomputes passes all 11 checks. For a
   finance app that is the failure mode that matters most, and it is not statically
   detectable — it needs either a trusted-render path or human review.
3. **Honest disclosure was luck, not policy.** The model chose to disclose the missing
   persistence. Make it a template rule so it is reliable.
4. **Default values get invented.** The budget widget defaulted to $2000 with no basis,
   which rendered the whole thing alarming red on first paint until the user typed a real
   number. Models will guess at values they have no grounds for.

### Still untested
Adversarial generation (prompt injection via capability results — e.g. a hostile merchant
name in the CSV), multi-capability widgets, and write capabilities.
