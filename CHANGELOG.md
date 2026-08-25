# Changelog

## Unreleased

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
