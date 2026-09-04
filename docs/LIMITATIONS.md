# Limitations

## What is not guaranteed

- Identical text across runs.
- Correctness of an objective that is incomplete or encoded by weak checks.
- Semantic correctness beyond configured exact/structured file checks, trusted code profiles, and authoritative tool outcomes.
- Exactly-once side effects.
- Truth of a remote action whose tool returned an unknown or failed outcome.
- Protection against a malicious same-process plugin or compromised filesystem provider.

## Contract selection remains probabilistic

The system-prompt section teaches the model to open contracts for substantive verifiable work, but the model may omit a contract. The intent card makes the current interpretation, assumptions, constraints, non-goals, and ambiguities visible before evidence review. It cannot detect a requirement omitted from that interpretation or force a user to notice a subtle error. `reliability_assess` prevents a declared deterministic claim from activating with too few independent sources, but it cannot prove semantic alignment between a claim and even an approved intent. For high-stakes workflows, a policy layer should inject a user/deployment-authored intent and claim set rather than relying only on model-authored criteria.

A `review-required` preflight is not an active contract, so the turn-stopping hook does not enforce it. The model is instructed to revise or decline certification, but a deployment that must prevent bypass needs an outer adoption policy that requires a ready contract before substantive work may settle.

Coverage percentages are not truth probabilities. A single authoritative oracle can be stronger than several correlated observations, while an incorrect test can remain incorrect no matter how many times it runs. The report therefore gates on complete declared-claim coverage and explicit source requirements rather than a raw count threshold.

Optional auxiliary authorship does not remove this gap. A second model can discover a requirement the task agent missed, but it can also omit the same requirement, follow misleading context, or choose brittle checks. It is correlated stochastic planning, not an independent oracle. Receipt binding proves that activation used the recorded draft; it does not prove that the draft was correct.

`manual` mode remains caller-declared authorship provenance. The two default reviews are stronger: Harness collects both through the exact live-root user-question provider, binds evidence review to the approved intent receipt, and embeds the chain in a version 5 contract. They still cannot establish a legal identity, prove comprehension, resist a malicious same-process plugin, or provide dual control. Deployments needing those properties must use external signed policy or a protected approval system.

The Web A2UI renderer is an optional presentation face. The same request always contains a native Markdown/JSON fallback, and the server cannot attest which capable client rendered it. The durable review record therefore describes the presentation offered. Renderer failure, stale/tampered actions, cancellation, malformed answers, and missing providers do not activate a contract.

The standard Harness log normally records tool-call arguments. Although the custom auxiliary draft event excludes raw context and auxiliary reasoning, any context supplied to `reliability_draft` may be durable elsewhere in the session. Never put secrets or private source in that field.

Evidence-source identity is a pre-execution structural proxy. Paths are normalized lexically but not resolved through the filesystem during assessment, and verifier profiles are distinct by configured ID. Symlink aliases, duplicated profile commands, shared upstream dependencies, and other hidden correlations can therefore overstate real independence.

## Coding verification still depends on test quality

`file_contains` is transparent and deterministic but can be gamed by comments or dead code. Trusted code profiles can run deployment-configured tests, typechecks, lint, or builds through Harness-managed subprocess and sandbox services. They prove only that those exact checks exited successfully. Weak tests, mutable test fixtures, or a malicious deployment profile can still certify the wrong outcome.

The plugin does not expose raw verifier stdout/stderr. Agents must use ordinary diagnostic tools to understand failures, then rerun the immutable trusted profile.

`no_tool_errors` describes the whole post-contract trajectory. A recoverable intermediate error therefore makes that check fail even if the final artifact is correct. It should be used only when an error-free trajectory is a real requirement. The live benchmark includes this false-rejection pressure explicitly.

Trusted verifier freshness is enforced against the durable Harness tool log:
any later non-governor tool call invalidates an earlier successful verifier
result, as does a later different verifier profile with `workspace-write`
access. This is deliberately conservative because arbitrary tools do not expose
authoritative side-effect metadata. It does not detect workspace changes made
out of band without a Harness tool event; deployments must prevent concurrent
external writers or rely on stronger CI/protected-check authority.

## Contract adoption remains a policy gap

`reliability_begin_code` prevents the model from omitting required profiles after it chooses the code contract. It cannot reliably infer that every arbitrary prompt is a coding task. A deployment requiring universal adoption still needs an outer task policy or user-authored contract trigger.

## Receipts are not attestations

Receipts detect changes to the recorded payload. They are not signed, do not include an external timestamp authority, and inherit trust in the Harness session persistence and `ctx.fs` provider.

## Repair reversibility is deployment policy

The governor evaluates and steers but does not automatically invoke tools. Harness does not currently provide a universal trusted declaration that every arbitrary tool action is read-only, workspace-reversible, or external/non-idempotent. A model-authored label would not establish that fact. Use snapshots or worktrees for mutable local tasks and do not permit automatic repair of irreversible actions without an authoritative policy layer or human confirmation.

## Business outcomes are observed, not automatically attributed

Business outcome profiles are deployment-controlled read-only observers. They can prove that configured metrics, sample-size requirements, freshness bounds, targets, and guardrails were observed inside the approved window. They do not make an uncontrolled before/after comparison causal. Only profiles configured with a direct or experiment attribution policy authorize a causal claim, and the deployment owner remains responsible for the validity of that policy and metric source.

Outcome observation is manually triggered in this release. The governor persists `observing` state and deadlines but does not run a durable scheduler after the Harness process or session stops. A deployment requiring delayed unattended measurement must invoke `reliability_outcome_observe` through an external scheduler and preserve the same session.

## Custom event compatibility

Governor events are required because dropping them would erase active enforcement state. Resume with the bundle installed. Export/migration across runtimes that do not understand the event vocabulary is not supported.

Harness `0.1.2-alpha.1` introduced a fail-closed persistence catalog but did not yet provide an out-of-tree registration service. The plugin therefore adds its ten required types to the exported process-wide catalog during plugin load. This is a version-adaptive compatibility bridge: older builds have no catalog and need no registration; a future incompatible catalog makes the plugin fail at load rather than write a session it cannot resume. The bridge depends on the current exported catalog remaining mutable and should be replaced when Harness publishes a supported downstream registration API.
