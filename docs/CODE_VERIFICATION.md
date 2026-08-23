# Trusted code verification

## Why it is separate

The bundled `reliability-code-verification` skill teaches the model how to collect evidence, but a skill is still prompt guidance to the same model that wrote the code. It cannot be the independent authority.

The runtime verifier therefore owns immutable deployment profiles. The model sees and selects only a profile ID. It cannot supply a command, add `--skip-tests`, replace a test with `true`, or treat an ordinary successful shell call as trusted evidence.

```text
coding skill                 trusted runtime                    governor
workflow guidance  ->  configured argv in sandbox  ->  completion allow/deny
same LLM                 deterministic process result         durable contract
```

## Configuration

Configure profiles in the plugin row. Empty profiles are the safe package default because repositories use different package managers and quality gates.

```yaml
- id: reliability-governor
  name: '@chenjie1129/dsh-reliability-governor-plugin'
  config:
    maxAttempts: 3
    codeVerificationMaxOutputBytes: 65536
    codeVerificationProfiles:
      - id: unit-tests
        description: Run the repository unit test suite.
        command: npm
        args: [test]
        timeoutMs: 120000
        sandboxMode: read-only
        required: true
      - id: typecheck
        description: Run the repository TypeScript check.
        command: npm
        args: [run, typecheck]
        timeoutMs: 120000
        sandboxMode: read-only
        required: true
      - id: build
        description: Build the repository in its workspace.
        command: npm
        args: [run, build]
        timeoutMs: 180000
        sandboxMode: workspace-write
        required: true
```

Profiles are deployment policy. Review them like CI configuration. Pin commands and arguments that actually prove the required outcome. Do not use shell wrappers whose content comes from the model.

A complete editable overlay is included at [`examples/code-verification.patch.yml`](../examples/code-verification.patch.yml). Apply it after adapting the scripts:

```sh
dsh --profile web --patch ./examples/code-verification.patch.yml --dump-config
```

`sandboxMode` is a ceiling, not an escalation. The verifier intersects it with the active session policy:

- a `read-only` session remains read-only even if the profile permits workspace writes;
- a `workspace-write` or full-access session is narrowed to the profile mode;
- partial sandbox enforcement or an unavailable sandbox fails closed.

Some test tools write caches, coverage, snapshots, or build output. Keep profiles read-only where possible. Use `workspace-write` only for commands whose expected writes have been reviewed.

## Runtime flow

1. `reliability_code_profiles` lists profile IDs, descriptions, required status, limits, sandbox mode, and definition receipts. It deliberately hides commands and arguments from the model-facing result.
2. `reliability_begin_code` opens a contract containing every profile marked `required`. The model may add artifact checks but cannot remove required profiles.
3. `reliability_code_verify` accepts one profile ID and resolves the deployment-authored executable through `ctx.subprocess`.
4. The exact argv is confined through `ctx.sandbox` using policy from `ctx.sandboxPolicy`, then executed by the managed subprocess service with credential-shaped ambient environment variables scrubbed by Harness.
5. The plugin records `reliability/code-verification`. The event contains exit facts, timing, sandbox facts, byte counts, truncation flags, content receipts, and the profile-definition receipt. It stores no raw stdout/stderr.
6. `code_verification_succeeded` accepts only successful matching events after the contract boundary.

## Failure and diagnosis

A failed trusted profile records one of:

- `exit`: the configured process exited unsuccessfully;
- `timeout`: its deadline expired;
- `configuration`: the configured executable could not be resolved;
- `infrastructure`: sandbox or managed-process execution could not provide the required boundary.

Raw verifier output is intentionally omitted from the durable event and model-facing result. The agent may use ordinary coding tools to run diagnostic commands and inspect their output, repair the code, then rerun the same trusted profile. Diagnostic commands never count as trusted verification evidence.

## Remaining boundary

The runtime isolates command selection from the model; it does not make repository tests correct. A weak or malicious deployment profile can still certify weak evidence, and a model may omit `reliability_begin_code` unless a higher policy mandates contract adoption. CI or protected external checks remain the stronger authority for release decisions.
