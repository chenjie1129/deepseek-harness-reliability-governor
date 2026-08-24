# Limitations

## What is not guaranteed

- Identical text across runs.
- Correctness of an objective that is incomplete or encoded by weak checks.
- Semantic correctness beyond configured exact/structured file checks, trusted code profiles, and authoritative tool outcomes.
- Exactly-once side effects.
- Truth of a remote action whose tool returned an unknown or failed outcome.
- Protection against a malicious same-process plugin or compromised filesystem provider.

## Contract selection remains probabilistic

The system-prompt section teaches the model to open contracts for substantive verifiable work, but the model may omit a contract or choose insufficient checks. For high-stakes workflows, a future policy layer should inject a user/deployment-authored contract rather than relying on model-authored criteria.

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

## Custom event compatibility

Governor events are required because dropping them would erase active enforcement state. Resume with the bundle installed. Export/migration across runtimes that do not understand the event vocabulary is not supported.
