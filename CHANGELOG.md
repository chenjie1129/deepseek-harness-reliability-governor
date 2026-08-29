# Changelog

## Unreleased

## 0.6.1

- Restore persisted-session resume on DeepSeek Harness `0.1.2-alpha.1` by registering the Governor's six required event types in the release's fail-closed persistence catalog at plugin load.
- Keep the compatibility path inert on older Harness builds that do not expose the catalog, while failing loudly if a future catalog is present but cannot accept the vocabulary.
- Exercise the plugin against both the original `0.1.1-rc.2` package floor and the updated `0.1.2-alpha.1` source packages, including the renamed tool-call brand and scoped user-question answerer test seams.

## 0.6.0

- Require a UI-backed Harness decision over the exact proposed evidence contract before activation by default.
- Add a fixed, bounded A2UI v0.9.1 Basic-catalog Web surface with native Harness question fallback.
- Add receipt-bound version 4 contracts and privacy-minimized `reliability/contract-review` events.
- Fail closed on revision, rejection, cancellation, unavailable providers, malformed answers, stale actions, and renderer errors.
- Add explicit `contractReview.mode: off` for disclosed unattended runs, preserving unreviewed version 3 contracts.
- Add official A2UI processor compatibility and adversarial review-boundary tests without making a user-comprehension or model-quality claim.

## 0.5.0

- Add configurable `current-agent`, `auxiliary-model`, and `manual` contract-authoring modes while keeping deterministic/external checks as the only certification authority.
- Add `reliability_draft`, a single bounded provider-neutral Harness LLM call with no tools, workspace access, repair loop, or automatic route fallback.
- Bind auxiliary drafts to `reliability_begin` through a durable single-use receipt, recorded on the version 3 contract, so the task agent cannot silently weaken, rewrite, or replay the objective, claims, or checks.
- Support receipt-bound `code` drafts by injecting all deployment-required verifier profiles before hashing and requiring the exact draft at `reliability_begin_code`.
- Record version 3 contract authorship and privacy-minimized draft provenance without persisting auxiliary reasoning or duplicating raw context in the custom draft event.
- Reject malformed JSON, action/tool output, non-normal finishes, oversized input/output, unknown code-verification profiles, and invalid authoring configuration before activation.
- Preserve a zero-configuration, zero-extra-model-call default and label manual provenance honestly as caller-declared rather than authenticated human review.

## 0.4.0

- Add `reliability_assess` to preflight declared-claim coverage without evaluating task output or mutating session state.
- Count independent evidence authorities rather than raw checks, so multiple assertions over one file, tool, or verifier profile cannot masquerade as corroboration.
- Require every declared claim to use deterministic evidence and meet its explicit minimum source count before a version 2 contract activates.
- Report critical and weighted coverage, used and orphan checks, evidence-source counts, brittle-check warnings, and stable assessment receipts.
- Preserve compatibility with existing version 1 contract events while storing claims and their coverage assessment in new contracts.
- Record structural coverage telemetry in the pre-registered live runner and retain model-authored versus independently authored contract arms to measure omitted-claim risk.

## 0.3.0

- Invalidate trusted code-verification evidence after any later non-governor tool call, including nested Code Mode dispatches, or a later different workspace-write verifier.
- Require the latest configured number of fresh profile results to all pass, preventing an older success from masking a newer failure.
- Add exact-negative, exact-file, and JSON Pointer equality checks for less brittle artifact contracts.
- Replace the live A/B protocol with a pre-registered three-arm benchmark: baseline, model-authored contract, and independently authored reference contract.
- Make arm-neutral and governed terminal contingency tables the primitive report outputs.
- Report false exhaustion and false abstention separately, with explicit cost weights and interval-based gates.
- Preserve every check result per attempt and report exposure-conditioned, co-occurrence-aware per-kind attribution.
- Add task-cluster bootstrap intervals, paired rescue/regression candidates, and live attempt-boundary oracle observations for repair-transition evidence.
- Lock the manifest, runner, and analysis hashes before any provider-backed decision run.
- Add a public beta feedback protocol and structured issue forms for false certification, false exhaustion, false abstention, repair regressions, and compatibility feedback.
- Add a deterministic promotion visual generated from the checked-in mechanism report, plus release and official-community announcement drafts.

## 0.2.0

- Add bundled `reliability-code-verification` workflow guidance through the Harness skill registry.
- Add immutable deployment-controlled code profiles executed through Harness subprocess, sandbox, and sandbox-policy seams.
- Add `reliability_begin_code`, `reliability_code_profiles`, `reliability_code_verify`, and `code_verification_succeeded`.
- Persist privacy-minimized trusted-verifier receipts without raw stdout or stderr.
- Add adversarial coverage proving ordinary tools and model-supplied command fields cannot replace configured profiles.
- Expand the real AgentLoop keyless benchmark to 180 paired fault-injection runs.

## 0.1.0

- Add durable reliability contracts, attempts, terminal states, and SHA-256 content receipts.
- Add six deterministic file/session evidence checks.
- Add bounded `agent/turn-stopping` verification and repair steering.
- Add explicit abstention, strict configuration bounds, evaluation cases, release checks, and clean-profile smoke documentation.
- Add a 160-run keyless paired A/B fault benchmark on the real Harness agent loop with independent oracles and hard gates.
- Add a cost-confirmed 20-task live-model paired runner with isolated profiles, persisted-session metrics, Wilson intervals, exact McNemar testing, and scoped verdicts.
