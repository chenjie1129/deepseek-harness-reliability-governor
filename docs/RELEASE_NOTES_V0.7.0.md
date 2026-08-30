# Reliability Governor v0.7.0

v0.7.0 separates “did the agent understand the request?” from “how will completion be proved?”

## What changed

- Interactive `reliability_begin` and `reliability_begin_code` now require two consecutive, receipt-bound live-root decisions.
- The first card reviews a bounded interpreted intent: objective, constraints, assumptions, non-goals, ambiguities, and caller-declared authorship.
- Only exact intent approval opens the separate evidence-contract card, which repeats the approved intent and shows complete claim mappings and check parameters.
- The evidence proposal receipt includes the approved intent, so it cannot be transplanted onto a different interpretation.
- Successful activation creates a version 5 contract containing the approved intent and both review references.
- `reliability/intent-review` records privacy-minimized intent decisions; evidence-review events are version 2 and record the intent proposal receipt.
- The fixed Web client supports both A2UI v0.9.1 Basic-catalog surfaces with native Harness question fallback.

## Model involvement

No second model is required. The default current task model drafts both proposals and the user owns both approvals. `auxiliary-model` remains an optional isolated author for claims/checks only. `manual` keeps model-free caller/reference authorship. Schema validation, coverage, receipts, lifecycle ordering, evidence evaluation, and terminal judgment remain deterministic.

## Compatibility

`contractReview.mode: required` now means both intent and evidence review. Calls must include:

```json
{
  "objective": "Concrete requested outcome",
  "intent": {
    "constraints": [],
    "assumptions": [],
    "non_goals": [],
    "ambiguities": []
  }
}
```

Explicit unattended `contractReview.mode: off` retains unreviewed version 3 contracts and does not require intent fields. Existing version 1–4 contract events remain readable. On Harness `0.1.2-alpha.1`, the compatibility bridge now registers seven Governor event types.

## Evidence boundary

The tests prove review ordering, exact receipt binding, fail-closed decisions, live-root authority, A2UI protocol compatibility, strict field bounds, and old/new Harness loading. They do not prove that users notice every misunderstanding or that two review cards improve provider-backed task outcomes. Those remain separate pre-registered usability and net-utility questions.
