# DeepSeek Harness Reliability Governor

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/chenjie1129/deepseek-harness-reliability-governor/actions/workflows/ci.yml/badge.svg)](https://github.com/chenjie1129/deepseek-harness-reliability-governor/actions/workflows/ci.yml)

> **Unofficial community project. Public beta testers wanted.** Try three to five disposable local tasks and report counterexamples through the [15-minute feedback protocol](FEEDBACK.md). False certification, false exhaustion, false abstention, repair regression, brittle checks, and Harness compatibility reports are especially useful.

An opt-in DeepSeek Harness bundle that first lets a user review what the agent thinks was requested, then separately review how it will prove completion, and finally changes completion from a model assertion into a deterministic evidence decision.

It does **not** make an LLM deterministic. It makes a narrower promise: while a reliability contract is active, the agent is steered until observable checks pass, its bounded repair budget is exhausted, or it abstains. Every attempt and terminal outcome is recorded in the durable session log with a content receipt.

![Reliability Governor mechanism and checked-in keyless benchmark](docs/assets/keyless-benchmark.svg)

## Evidence status

| Evidence | Current result | Claim allowed |
| --- | --- | --- |
| Keyless Harness AgentLoop fault matrix | 9 cases × 10 trials × 2 arms = 180 runs; mechanism gates pass; zero governed false completions and false certifications | The active contract and lifecycle enforce declared deterministic checks under scripted faults. |
| Scripted auxiliary-author boundary tests | Strict parsing, no-tool calls, provenance, and receipt binding pass | The isolation mechanism works with a scripted stream; this is not evidence that a live model writes better contracts. |
| Two-stage A2UI review boundary tests | Official A2UI v0.9.1 processor accepts both fixed surfaces; intent and evidence approval, revision, rejection, tampering, fallback, delegated-agent, and missing-provider paths fail closed | Exact intent and evidence proposals can require separate UI-backed Harness decisions before activation; this does not prove either proposal is correct. |
| Harness compatibility matrix | Unit/composition tests and strict builds pass against the `0.1.1-rc.2` package floor and `0.1.2-alpha.1` source packages; the exact bundle installs and boots in a clean `0.1.2-alpha.1` profile | The plugin loads on both tested Harness versions and registers its required event vocabulary with the new fail-closed persistence catalog. |
| Pre-registered provider-backed benchmark | 20 tasks × 5 trials × 3 arms planned; not run | No live-model quality, latency, cost, or net-utility claim yet. |

The project is deliberately looking for evidence against its design. See [Beta feedback](FEEDBACK.md) for the independent-oracle protocol and privacy rules.

## Why this plugin exists

LLM sampling is only one source of variation. Tool results, environment state, ambiguous success criteria, context, and the model's tendency to self-report completion also vary. Lower temperature cannot prove that a requested outcome happened, and some reasoning modes ignore temperature entirely.

Harness already has goal and iterative workflow plugins, but their current documentation explicitly leaves independent verification to another layer. This plugin fills that generic runtime gap without replacing those workflows.

## What it adds

- `reliability_assess` — preview declared-claim coverage, independent-source counts, and brittle-evidence warnings without evaluating task output.
- `reliability_draft` — in optional `auxiliary-model` mode, request one bounded text-only claim/check draft and record its provenance and receipt.
- `reliability_begin` — open one explicit completion contract.
- `reliability_begin_code` — open a code contract that automatically includes every deployment-required trusted verification profile.
- `reliability_verify` — run deterministic checks immediately.
- `reliability_status` — read the durable contract, attempts, terminal state, and receipts.
- `reliability_abstain` — stop without fabricating proof.
- `reliability_code_profiles` — list trusted profile metadata without exposing model-rewritable commands.
- `reliability_code_verify` — execute one immutable profile through Harness-managed subprocess and sandbox services.
- `agent/turn-stopping` enforcement — verify before an active contract is allowed to settle, then steer a bounded repair or truthfully report certification/exhaustion.

By default, `reliability_begin` pauses twice before activation. The first fixed [A2UI v0.9.1](https://a2ui.org/) Basic-catalog surface shows the interpreted objective, constraints, assumptions, non-goals, and ambiguities. Only exact intent approval opens a second surface showing claims, checks, authorship, coverage warnings, and repair budget. Clients without the custom renderer receive the same proposals through Harness's native question UI. Both approvals are receipt-bound; failure at either stage leaves no active contract. Version 5 contracts embed the approved intent and bind the evidence review to it. A2UI is presentation—not the approval authority or outcome judge; Harness's live-root user-question channel records choices, and later deterministic checks decide certification. See [Two-stage review](docs/CONTRACT_REVIEW.md).

Supported checks in v0.7:

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

File checks are read-only through Harness `ctx.fs`. Trusted code profiles receive exact deployment-authored argv and execute only through Harness `ctx.subprocess`, `ctx.sandbox`, and `ctx.sandboxPolicy`; the model supplies only a profile ID. The plugin never uses an LLM as the outcome judge, initiates a provider retry/fallback, or repeats a business action. Optional auxiliary authorship is requirement discovery only and has no certification authority.

Trusted verifier evidence is invalidated conservatively by any later non-governor tool call, including nested Code Mode dispatches, and by a later different verifier profile with `workspace-write` access. This prevents a test result from certifying code that the agent or another verifier changed afterward. Because Harness does not expose authoritative side-effect metadata for arbitrary tools, even a later read-only tool call requires the trusted profile to be rerun.

`file_contains` and `no_tool_errors` intentionally have narrow meanings. The policy warns the model not to use an exact literal for equivalent-output requirements and not to treat a recovered intermediate tool error as evidence that the final result failed. The live benchmark includes JSON-format equivalence and a recoverable-tool-error task to measure those authorship mistakes rather than assume them away.

Before activation, v0.7 maps every declared success claim to checks and counts independent evidence authorities rather than raw checks. Two checks over one file count as one source. `human-required`, `unsupported`, and under-supported claims produce `review-required`; brittle checks produce visible warnings. See [Contract coverage](docs/CONTRACT_COVERAGE.md). Coverage remains structural: the separate intent review exposes semantic assumptions to the user but cannot automatically prove that every requirement was understood or mapped to a claim.

Contract authorship is configurable. The zero-setup default is `current-agent`; `auxiliary-model` routes one isolated draft call through Harness's existing provider/model layer; `manual` is for a user or reviewed reference contract but is honestly labeled caller-declared, not authenticated. Auxiliary drafts must match a durable receipt exactly before activation. See [Contract authoring](docs/CONTRACT_AUTHORING.md).

## Install

From the directory containing this checkout:

```sh
git clone https://github.com/chenjie1129/deepseek-harness-reliability-governor.git
cd deepseek-harness-reliability-governor
npm ci
npm pack
dsh plugin --profile web add ./chenjie1129-dsh-reliability-governor-plugin-0.7.0.tgz
dsh --profile web --dump-config
dsh --profile web
```

For a headless profile, replace `web` with its profile name. The interactive default needs a registered Harness user-question provider; without one, intent or evidence review returns unavailable and no contract activates. Controlled unattended workflows may explicitly set `contractReview.mode: off`. The installed profile must list `@chenjie1129/dsh-reliability-governor-plugin` in `dsh.profile.bundles`; merely placing the package beside Harness does not activate it.

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
        contractAuthoring:
          mode: current-agent
          maxInputBytes: 32768
          maxOutputTokens: 3000
          timeoutMs: 45000
        contractReview:
          mode: required
```

The empty code-profile list is a fail-safe default because repositories have different checks. Configure reviewed test/typecheck/build argv as described in [Trusted code verification](docs/CODE_VERIFICATION.md). The bundled `reliability-code-verification` skill teaches the workflow; the runtime profile, not the skill, is the independent judge. `contractReview.mode: required` is the interactive default and now means both intent and evidence review. Unattended evaluation or automation must opt out explicitly with `mode: off`; that creates an unreviewed version 3 contract and must not be reported as intent-approved or evidence-approved.

Keep `current-agent` unless you specifically want an extra authoring call. For `auxiliary-model`, first configure credentials and the exact provider route in Harness Models, then add only `provider`, `model`, and optional `reasoningEffort` under `contractAuthoring`; the governor never stores provider credentials. There is no automatic route fallback.

## Example contract

The model calls:

```json
{
  "objective": "Create a configured application entry point",
  "intent": {
    "constraints": ["Preserve unrelated workspace files and existing public behavior"],
    "assumptions": ["src/index.ts is the requested application entry point"],
    "non_goals": ["Do not redesign unrelated modules"],
    "ambiguities": []
  },
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

The model first previews the claim/check mapping with `reliability_assess`. In interactive mode, `reliability_begin` then asks the user to approve the interpreted intent and the evidence contract separately. Only both approvals create a version 5 contract. At a stopping boundary the plugin evaluates the actual assertions. A failure produces an exact repair message and another model step. A pass records `certified`; the final model step receives the terminal SHA-256 receipt. At the budget limit it records `exhausted` and explicitly tells the model not to claim completion.

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
- Each UI approval establishes only that its exact proposal was accepted through the live Harness question channel. Neither authenticates a legal identity, proves that the user understood it, authorizes side effects beyond the original request, or certifies the outcome.
- v0.7 does not judge visual quality, semantic correctness beyond configured checks, omitted claims, remote state without authoritative evidence, or unknown side-effect outcomes. Two-stage review makes misunderstandings visible; it does not guarantee that users detect them.
- Removing this plugin from a profile that owns sessions containing its required custom events can make those sessions non-continuable by a runtime that does not know the event vocabulary. Keep the bundle installed when resuming those sessions. Harness `0.1.2-alpha.1` has no downstream event-registration service, so v0.7 registers these types in its exported process-wide persistence catalog at load and fails loudly if that compatibility seam becomes unavailable.

See [Contract review](docs/CONTRACT_REVIEW.md), [Contract authoring](docs/CONTRACT_AUTHORING.md), [Contract coverage](docs/CONTRACT_COVERAGE.md), [Beta feedback](FEEDBACK.md), [Architecture](docs/ARCHITECTURE.md), [Trusted code verification](docs/CODE_VERIFICATION.md), [Research](docs/RESEARCH.md), [Benchmark](docs/BENCHMARK.md), [Limitations](docs/LIMITATIONS.md), and [Security](SECURITY.md).

## License

MIT
