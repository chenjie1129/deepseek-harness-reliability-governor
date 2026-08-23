# Limitations

## What is not guaranteed

- Identical text across runs.
- Correctness of an objective that is incomplete or encoded by weak checks.
- Semantic correctness beyond exact file literals, trusted code profiles, and authoritative tool outcomes.
- Exactly-once side effects.
- Truth of a remote action whose tool returned an unknown or failed outcome.
- Protection against a malicious same-process plugin or compromised filesystem provider.

## Contract selection remains probabilistic

The system-prompt section teaches the model to open contracts for substantive verifiable work, but the model may omit a contract or choose insufficient checks. For high-stakes workflows, a future policy layer should inject a user/deployment-authored contract rather than relying on model-authored criteria.

## Coding verification still depends on test quality

`file_contains` is transparent and deterministic but can be gamed by comments or dead code. Trusted code profiles can run deployment-configured tests, typechecks, lint, or builds through Harness-managed subprocess and sandbox services. They prove only that those exact checks exited successfully. Weak tests, mutable test fixtures, or a malicious deployment profile can still certify the wrong outcome.

The plugin does not expose raw verifier stdout/stderr. Agents must use ordinary diagnostic tools to understand failures, then rerun the immutable trusted profile.

## Contract adoption remains a policy gap

`reliability_begin_code` prevents the model from omitting required profiles after it chooses the code contract. It cannot reliably infer that every arbitrary prompt is a coding task. A deployment requiring universal adoption still needs an outer task policy or user-authored contract trigger.

## Receipts are not attestations

Receipts detect changes to the recorded payload. They are not signed, do not include an external timestamp authority, and inherit trust in the Harness session persistence and `ctx.fs` provider.

## Custom event compatibility

Governor events are required because dropping them would erase active enforcement state. Resume with the bundle installed. Export/migration across runtimes that do not understand the event vocabulary is not supported.
