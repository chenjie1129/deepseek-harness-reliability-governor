# DeepSeek Harness Reliability Governor

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/chenjie1129/deepseek-harness-reliability-governor/actions/workflows/ci.yml/badge.svg)](https://github.com/chenjie1129/deepseek-harness-reliability-governor/actions/workflows/ci.yml)

> **Unofficial community project. Public beta testers wanted.** Try three to five disposable local tasks and report counterexamples through the [15-minute feedback protocol](FEEDBACK.md). False certification, false exhaustion, false abstention, repair regression, brittle checks, and Harness compatibility reports are especially useful.

An opt-in DeepSeek Harness bundle that changes completion from a model assertion into a deterministic evidence decision.

It does **not** make an LLM deterministic. It makes a narrower promise: while a reliability contract is active, the agent is steered until observable checks pass, its bounded repair budget is exhausted, or it abstains. Every attempt and terminal outcome is recorded in the durable session log with a content receipt.

![Reliability Governor mechanism and checked-in keyless benchmark](docs/assets/keyless-benchmark.svg)

## Evidence status

| Evidence | Current result | Claim allowed |
| --- | --- | --- |
| Keyless Harness AgentLoop fault matrix | 9 cases × 10 trials × 2 arms = 180 runs; mechanism gates pass; zero governed false completions and false certifications | The active contract and lifecycle enforce declared deterministic checks under scripted faults. |
| Pre-registered provider-backed benchmark | 20 tasks × 5 trials × 3 arms planned; not run | No live-model quality, latency, cost, or net-utility claim yet. |

The project is deliberately looking for evidence against its design. See [Beta feedback](FEEDBACK.md) for the independent-oracle protocol and privacy rules.

## Why this plugin exists

LLM sampling is only one source of variation. Tool results, environment state, ambiguous success criteria, context, and the model's tendency to self-report completion also vary. Lower temperature cannot prove that a requested outcome happened, and some reasoning modes ignore temperature entirely.

Harness already has goal and iterative workflow plugins, but their current documentation explicitly leaves independent verification to another layer. This plugin fills that generic runtime gap without replacing those workflows.

## What it adds

- `reliability_assess` — preview declared-claim coverage, independent-source counts, and brittle-evidence warnings without evaluating task output.
- `reliability_begin` — open one explicit completion contract.
- `reliability_begin_code` — open a code contract that automatically includes every deployment-required trusted verification profile.
- `reliability_verify` — run deterministic checks immediately.
- `reliability_status` — read the durable contract, attempts, terminal state, and receipts.
- `reliability_abstain` — stop without fabricating proof.
- `reliability_code_profiles` — list trusted profile metadata without exposing model-rewritable commands.
- `reliability_code_verify` — execute one immutable profile through Harness-managed subprocess and sandbox services.
- `agent/turn-stopping` enforcement — verify before an active contract is allowed to settle, then steer a bounded repair or truthfully report certification/exhaustion.

Supported checks in v0.4:

| Check | Pass condition |
| --- | --- |
| `file_exists` | A workspace-relative path resolves to a regular file. |
| `file_absent` | No path entry exists at the workspace-relative path. |
| `file_contains` | A bounded regular text file contains an exact literal. |
| `file_not_contains` | A bounded regular text file excludes an exact literal. |
| `file_equals` | A bounded regular text file exactly matches expected UTF-8 text. |
| `json_equals` | A JSON Pointer resolves to the exact predeclared JSON value. |
| `tool_succeeded` | The session log contains the required matching tool call and a correlated non-error result after the contract began. |
| `tool_not_called` | The named tool was not called after the contract began. |
| `code_verification_succeeded` | The latest required results from a named deployment-configured verifier profile succeeded after the last non-governor tool call. |
| `no_tool_errors` | No model-facing tool result after the contract began is an error. |

File checks are read-only through Harness `ctx.fs`. Trusted code profiles receive exact deployment-authored argv and execute only through Harness `ctx.subprocess`, `ctx.sandbox`, and `ctx.sandboxPolicy`; the model supplies only a profile ID. The plugin never calls an LLM judge, retries a provider, or repeats a business action.

Trusted verifier evidence is invalidated conservatively by any later non-governor tool call, including nested Code Mode dispatches, and by a later different verifier profile with `workspace-write` access. This prevents a test result from certifying code that the agent or another verifier changed afterward. Because Harness does not expose authoritative side-effect metadata for arbitrary tools, even a later read-only tool call requires the trusted profile to be rerun.

`file_contains` and `no_tool_errors` intentionally have narrow meanings. The policy warns the model not to use an exact literal for equivalent-output requirements and not to treat a recovered intermediate tool error as evidence that the final result failed. The live benchmark includes JSON-format equivalence and a recoverable-tool-error task to measure those authorship mistakes rather than assume them away.

Before activation, v0.4 maps every declared success claim to checks and counts independent evidence authorities rather than raw checks. Two checks over one file count as one source. `human-required`, `unsupported`, and under-supported claims produce `review-required`; brittle checks produce visible warnings. See [Contract coverage](docs/CONTRACT_COVERAGE.md). Coverage is structural: it cannot detect a requirement the model omitted or prove that a claim faithfully represents the user's intent.

## Install

From the directory containing this checkout:

```sh
git clone https://github.com/chenjie1129/deepseek-harness-reliability-governor.git
cd deepseek-harness-reliability-governor
npm ci
npm pack
dsh plugin --profile web add ./chenjie1129-dsh-reliability-governor-plugin-0.4.0.tgz
dsh --profile web --dump-config
dsh --profile web
```

For a headless profile, replace `web` with its profile name. The installed profile must list `@chenjie1129/dsh-reliability-governor-plugin` in `dsh.profile.bundles`; merely placing the package beside Harness does not activate it.

The shipped bundle layer mounts one plugin row:

```yaml
- insert:
    - id: reliability-governor
      name: '@chenjie1129/dsh-reliability-governor-plugin'
      config:
        maxAttempts: 3
        maxChecks: 20
        maxFileBytes: 1048576
        autoVerifyAtTurnStop: true
        codeVerificationMaxOutputBytes: 65536
        codeVerificationProfiles: []
```

The empty code-profile list is a fail-safe default because repositories have different checks. Configure reviewed test/typecheck/build argv as described in [Trusted code verification](docs/CODE_VERIFICATION.md). The bundled `reliability-code-verification` skill teaches the workflow; the runtime profile, not the skill, is the independent judge.

## Example contract

The model calls:

```json
{
  "objective": "Create a configured application entry point",
  "claims": [
    {
      "id": "entry-configured",
      "statement": "src/index.ts exists and exports apply",
      "importance": "critical",
      "verification": "deterministic",
      "check_ids": ["entry", "export"],
      "minimum_independent_sources": 1
    },
    {
      "id": "trusted-tests-pass",
      "statement": "The deployment-approved unit tests pass on the final workspace state",
      "importance": "critical",
      "verification": "deterministic",
      "check_ids": ["tests"]
    }
  ],
  "checks": [
    { "id": "entry", "kind": "file_exists", "path": "src/index.ts" },
    { "id": "export", "kind": "file_contains", "path": "src/index.ts", "text": "export function apply" },
    { "id": "tests", "kind": "code_verification_succeeded", "profile": "unit-tests" }
  ],
  "max_attempts": 3
}
```

The model first previews this mapping with `reliability_assess`; `reliability_begin` activates it only when structural coverage is ready. At a stopping boundary the plugin evaluates the actual assertions. A failure produces an exact repair message and another model step. A pass records `certified`; the final model step receives the terminal SHA-256 receipt. At the budget limit it records `exhausted` and explicitly tells the model not to claim completion.

## Develop and verify

```sh
npm install
npm run check
```

`npm run check` runs unit/composition tests, validates all evaluation manifests, builds strict ESM TypeScript, executes the 180-run keyless A/B benchmark, verifies the release contract, and audits the npm pack list. Follow [docs/SMOKE_TEST.md](docs/SMOKE_TEST.md) for the required clean-profile Harness test.

To regenerate the promotion visual directly from the checked-in keyless report:

```sh
npm run demo:render
```

Benchmark commands:

```sh
npm run benchmark:keyless
npm run benchmark:live:plan
```

The keyless benchmark proves the governor's enforcement mechanics using the real Harness agent loop and an independent oracle. It does not prove that a natural-language model became deterministic. The provider-backed, pre-registered 20-task three-arm protocol measures false success, false exhaustion, false abstention, contract-authorship cost, repair transitions, overhead, and uncertainty; see [docs/BENCHMARK.md](docs/BENCHMARK.md).

## Boundaries

- A receipt hashes the recorded contract/outcome; it is not a signature and does not prove the external world independently.
- The model still chooses whether a task needs a contract and which checks express success. A bad contract can certify the wrong thing.
- Out-of-band workspace changes that produce no Harness tool event are not detected; use isolated workspaces and prevent concurrent external writers.
- Deterministic checks improve outcome reliability, not wording consistency.
- v0.4 does not judge visual quality, semantic correctness beyond configured checks, omitted claims, remote state without authoritative evidence, or unknown side-effect outcomes.
- Removing this plugin from a profile that owns sessions containing its required custom events can make those sessions non-continuable by a runtime that does not know the event vocabulary. Keep the bundle installed when resuming those sessions.

See [Contract coverage](docs/CONTRACT_COVERAGE.md), [Beta feedback](FEEDBACK.md), [Architecture](docs/ARCHITECTURE.md), [Trusted code verification](docs/CODE_VERIFICATION.md), [Research](docs/RESEARCH.md), [Benchmark](docs/BENCHMARK.md), [Limitations](docs/LIMITATIONS.md), and [Security](SECURITY.md).

## License

MIT
