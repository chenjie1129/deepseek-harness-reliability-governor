# Architecture

## Design target

The plugin optimizes for **verified-or-abstain**, not deterministic prose. It narrows a probabilistic agent loop with a deterministic state machine:

```text
inactive
   |
   | reliability_assess: ready
   | or receipt-bound reliability_draft: ready
   | reliability_begin / reliability_begin_code
   v
review-pending -- revise/reject/cancel/unavailable --> inactive
   |
   | exact proposal approved through Harness userQuestions
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

`reliability_assess` is a preflight, not a lifecycle state. It groups checks by evidence authority, maps them to declared claims, and returns `ready` or `review-required` without inspecting output or writing a contract event. In the interactive default, a ready proposal is receipt-bound and sent to the exact live root user's question channel. Only approval stores a version 4 contract containing claims, immutable coverage assessment, authorship provenance, and review reference. Revision, rejection, cancellation, or unavailable UI writes a review event but no contract. Explicit unattended mode stores the unreviewed version 3 contract. Versions 1–3 remain readable for session compatibility.

## DeepSeek Harness integration rules

The implementation is tested against the `0.1.1-rc.2` package floor and the clean `0.1.2-alpha.1` source release:

- one standalone npm bundle declares `dsh.bundle.patch` and inserts one Cordis plugin row;
- ESM and strict TypeScript with explicit `.js` relative imports;
- `inject` declares tools, prompt, filesystem, skill, subprocess, sandbox, sandbox-policy, provider-neutral LLM, and user-question seams;
- the optional Web face declares `dsh.client`, registers ahead of the generic question fallback, and renders only a fixed A2UI v0.9.1 Basic-catalog envelope;
- tool definitions use `ctx.tools.register(defineTool(...))`;
- policy text uses `ctx.systemPrompt.section(...)` and is therefore model-visible;
- bounded continuation uses the serial `agent/turn-stopping` lifecycle hook and `agent.steer(...)`;
- workspace evidence uses `ctx.fs`, including canonical containment, rather than Node filesystem access;
- trusted code checks resolve exact deployment-authored argv through `ctx.subprocess`, confine it through `ctx.sandbox`, and intersect profile permissions with `ctx.sandboxPolicy`;
- the coding workflow is contributed through `ctx.skills` as guidance and never treated as the enforcement authority;
- custom `SessionEventMap` records are lossless-JSON values and are folded from the durable log rather than mirrored in process memory;
- configuration defaults are declared with Schemastery and manually bounded at plugin load;
- no internal Harness module path, provider secret, or direct agent-loop patch is used;
- on `0.1.2-alpha.1`, plugin load adds the six required `reliability/*` types to the public process-wide `KNOWN_SESSION_EVENT_TYPES` set because that release's persistence reader fails closed but exposes no downstream registration service. Older builds skip this bridge; an incompatible future catalog fails plugin load.

## Durable event vocabulary

- `reliability/contract` records the objective, declared claims, structural coverage assessment, ordered checks, budget, and exact event boundary.
- `reliability/attempt` records trigger, ordered results, verdict, and a stable content receipt.
- `reliability/terminal` records certified/exhausted/abstained, reason, linked attempt receipt when present, and terminal receipt.
- `reliability/code-verification` records an immutable profile receipt, exit/timing/sandbox facts, privacy-minimized output receipts, and the trusted verdict.
- `reliability/contract-draft` records a successful auxiliary draft, coverage assessment, route/prompt provenance, usage when available, and a receipt. It excludes auxiliary reasoning and does not duplicate raw context.
- `reliability/contract-review` records a UI-backed decision over an exact proposal receipt, the offered A2UI-with-native-fallback presentation, and a receipt. Optional feedback is represented only by its byte count and hash in this custom event.

These are required events because they alter whether a session may truthfully settle. A runtime that cannot interpret them should refuse continuation rather than silently discard the contract.

Harness `0.1.2-alpha.1` applies that refusal through a static persistence catalog. `registerReliabilitySessionEventTypes` updates the exported catalog before any tool or hook can write a Governor event and confirms every type was accepted. The process-lifetime registration is not removed during hot reload, because removing it could make an already-persisted session unreadable in the same process. This is a temporary compatibility seam, not an authority or evidence source.

## Evidence boundaries

Contract coverage counts authorities, not assertions. Normalized aliases of one workspace path share a source; all ordinary tool and trajectory checks conservatively share the Harness tool-event source; and trusted verifier checks share a source by profile. At least one claim must be critical, and every declared claim must be deterministic and meet its `minimumIndependentSources` value before a version 3 or 4 contract can activate. The assessment warns about brittle check kinds but does not block on warnings.

This is structural coverage only. The runtime cannot infer a requirement omitted from the claim list or decide whether the claim text matches the user's intent. Reference-authored contracts and user review remain stronger sources of semantic completeness, but approval still does not prove completeness.

## Receipt-bound user review

`reliability_begin` and `reliability_begin_code` calculate one proposal receipt over the exact contract kind, objective, normalized claims/checks, effective repair budget, authorship, and coverage assessment. The server passes a deterministic A2UI envelope plus readable native Markdown fallback to `ctx.userQuestions.ask({ agent, ... })`. Harness permits this only for the exact live runtime root and rejects delegated child agents.

The A2UI face is a presentation adapter, not an agent or authority. It uses the official v0.9.1 processor and Basic catalog, accepts only one bounded governor envelope, and returns an ordinary structured Harness answer. Action name, source component, surface ID, question ID, option labels, and proposal receipt must all match. Invalid or stale input never maps to approval. The server records the decision independently and activates only when the approved review receipt references the same proposal. See [Contract review](CONTRACT_REVIEW.md).

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

## Isolated contract authorship

The default and manual modes make no additional model call. In `auxiliary-model` mode, `reliability_draft` makes one bounded provider-neutral `ctx.llm.stream` invocation with one user text block, a fixed system prompt, an empty tool list, an exact configured provider/model route, and no automatic fallback. It is a subcall, not an Agent: it has no workspace, session loop, tools, repair path, or terminal authority.

Only strict JSON claims/checks are accepted. Non-text actions, malformed output, abnormal finishes, oversize input/stream data, unconfigured verifier profiles, and coverage errors fail closed. For a `code` draft, deployment-required profile checks and a critical claim are inserted deterministically before the successful draft event receives its receipt. `reliability_begin` and `reliability_begin_code` require that receipt and a canonical match of the objective, normalized claims, and checks; the version 3 contract records the receipt and rejects reuse. This prevents the task agent from weakening or replaying the draft after the call.

The standard Harness tool log may already contain `reliability_draft` arguments, so context is documented as non-secret. The custom event does not duplicate it and never stores raw auxiliary reasoning. See [Contract authoring](CONTRACT_AUTHORING.md).

## Isolated coding judgment

`reliability_begin_code` injects every deployment profile marked `required`; the model cannot remove them. `reliability_code_verify` accepts only a profile ID. Commands and arguments never enter its model-authored parameter schema.

The verifier requires full sandbox enforcement, scrubs ambient secrets through Harness's subprocess provider, caps output in memory, and persists hashes rather than raw logs. Profile configuration remains trusted deployment policy. See [Trusted code verification](CODE_VERIFICATION.md).

## Bounded repair

`autoVerifyAtTurnStop` evaluates unresolved contracts whenever a turn would otherwise stop. A failing attempt steers exact failed-check evidence into one more step. The contract's `maxAttempts`, capped by deployment `maxAttempts`, prevents an unbounded loop.

The governor never repeats a tool itself. This is intentional: generic automatic retry is unsafe for non-idempotent side effects. The model receives a policy not to repeat unknown-outcome actions and can inspect authoritative state or abstain.

Harness currently exposes no authoritative, universal side-effect classification for arbitrary tools. The governor therefore cannot prove that a model-directed repair is reversible. Deployments must keep automatic repair inside disposable/snapshotted workspaces and require human confirmation or abstention for external, irreversible, or non-idempotent actions. The live benchmark records an explicit repair class per task; prompt-level classification is measured behavior, not a runtime safety proof.

## Why no LLM outcome judge

An LLM outcome evaluator adds cost, latency, correlated blind spots, prompt-injection exposure, and another stochastic decision. Deterministic graders are preferred whenever an outcome can be checked mechanically. v0.6 may use an LLM before mutation to propose what should be examined and a user may approve that proposal, but neither is pass/fail evidence. Semantic and visual evaluators can be added later as explicitly lower-confidence check providers, not mixed into the trusted deterministic core.
