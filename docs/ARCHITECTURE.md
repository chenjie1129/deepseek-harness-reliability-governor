# Architecture

## Design target

The plugin optimizes for **verified-or-abstain**, not deterministic prose. It narrows a probabilistic agent loop with a deterministic state machine:

```text
inactive
   |
   | reliability_begin / reliability_begin_code
   v
active -- check passes ------------------------> certified
   |
   | check fails, attempts remain
   +----------------> repair step ----------------+
   |
   | check fails at limit
   +-------------------------------------------> exhausted
   |
   | proof is unsafe or unsupported
   +-------------------------------------------> abstained
```

Only `active` causes turn-stopping enforcement. Every transition is reconstructed from the append-only session log.

## DeepSeek Harness integration rules

The implementation follows the official clean `0.1.1-rc.2` source contracts:

- one standalone npm bundle declares `dsh.bundle.patch` and inserts one Cordis plugin row;
- ESM and strict TypeScript with explicit `.js` relative imports;
- `inject` declares tools, prompt, filesystem, skill, subprocess, sandbox, and sandbox-policy seams;
- tool definitions use `ctx.tools.register(defineTool(...))`;
- policy text uses `ctx.systemPrompt.section(...)` and is therefore model-visible;
- bounded continuation uses the serial `agent/turn-stopping` lifecycle hook and `agent.steer(...)`;
- workspace evidence uses `ctx.fs`, including canonical containment, rather than Node filesystem access;
- trusted code checks resolve exact deployment-authored argv through `ctx.subprocess`, confine it through `ctx.sandbox`, and intersect profile permissions with `ctx.sandboxPolicy`;
- the coding workflow is contributed through `ctx.skills` as guidance and never treated as the enforcement authority;
- custom `SessionEventMap` records are lossless-JSON values and are folded from the durable log rather than mirrored in process memory;
- configuration defaults are declared with Schemastery and manually bounded at plugin load;
- no internal Harness module path, mutable global, provider secret, or direct agent-loop patch is used.

## Durable event vocabulary

- `reliability/contract` records the objective, ordered checks, budget, and exact event boundary.
- `reliability/attempt` records trigger, ordered results, verdict, and a stable content receipt.
- `reliability/terminal` records certified/exhausted/abstained, reason, linked attempt receipt when present, and terminal receipt.
- `reliability/code-verification` records an immutable profile receipt, exit/timing/sandbox facts, privacy-minimized output receipts, and the trusted verdict.

These are required events because they alter whether a session may truthfully settle. A runtime that cannot interpret them should refuse continuation rather than silently discard the contract.

## Evidence boundaries

File checks:

1. require a relative path with no `..` segment;
2. resolve both workspace root and target through `ctx.fs`;
3. require canonical containment;
4. read only regular UTF-8 text;
5. cap content at `maxFileBytes`.

`file_equals` compares the complete decoded UTF-8 text, `file_not_contains` proves literal exclusion, and `json_equals` resolves an RFC 6901-style JSON Pointer before comparing canonical JSON values. These avoid forcing an independently authored benchmark contract to approximate structured or exact outcomes with substring checks.

Tool checks correlate `tool/call.callId` with `tool/result.message.source.callId`. Only events after `startedAtSeq` count, preventing stale pre-contract evidence from certifying later work.

`code_verification_succeeded` considers only the latest required
`reliability/code-verification` events for the named immutable profile after
both the contract boundary and the last non-governor tool call. The latest
required results must all pass. Native calls and nested Code Mode dispatches
both advance this conservative freshness boundary. A later different verifier
profile with `workspace-write` access also advances it, so one profile cannot
certify state that another profile may have changed. An ordinary `bash`, test,
or successful tool call cannot substitute.

Harness does not currently expose authoritative side-effect metadata for every
tool. The boundary therefore treats even read-only non-governor calls as
potential mutations. This may require an unnecessary verifier rerun, but fails
closed instead of certifying stale evidence. Out-of-band writes that create no
session event remain a deployment isolation concern.

## Isolated coding judgment

`reliability_begin_code` injects every deployment profile marked `required`; the model cannot remove them. `reliability_code_verify` accepts only a profile ID. Commands and arguments never enter its model-authored parameter schema.

The verifier requires full sandbox enforcement, scrubs ambient secrets through Harness's subprocess provider, caps output in memory, and persists hashes rather than raw logs. Profile configuration remains trusted deployment policy. See [Trusted code verification](CODE_VERIFICATION.md).

## Bounded repair

`autoVerifyAtTurnStop` evaluates unresolved contracts whenever a turn would otherwise stop. A failing attempt steers exact failed-check evidence into one more step. The contract's `maxAttempts`, capped by deployment `maxAttempts`, prevents an unbounded loop.

The governor never repeats a tool itself. This is intentional: generic automatic retry is unsafe for non-idempotent side effects. The model receives a policy not to repeat unknown-outcome actions and can inspect authoritative state or abstain.

Harness currently exposes no authoritative, universal side-effect classification for arbitrary tools. The governor therefore cannot prove that a model-directed repair is reversible. Deployments must keep automatic repair inside disposable/snapshotted workspaces and require human confirmation or abstention for external, irreversible, or non-idempotent actions. The live benchmark records an explicit repair class per task; prompt-level classification is measured behavior, not a runtime safety proof.

## Why no LLM judge

An LLM evaluator adds cost, latency, correlated blind spots, prompt-injection exposure, and another stochastic decision. Deterministic graders are preferred whenever an outcome can be checked mechanically. Semantic and visual evaluators can be added later as explicitly lower-confidence check providers, not mixed into the trusted deterministic core.
