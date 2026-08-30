# Reliability benchmark

This project separates two claims:

1. **Enforcement:** an active contract blocks unsupported completion, evaluates every check, bounds repair, and never certifies a failing deterministic oracle in the scripted fault matrix.
2. **Model behavior:** on a named model and task distribution, the complete governed product reduces oracle-failing success reports without unacceptable false rejection, regression, latency, token, or tool-call cost.

The checked-in keyless benchmark tests the first claim. Only the pre-registered provider-backed benchmark can test the second. Neither makes an LLM deterministic.

v0.7's scripted auxiliary-author and two-stage A2UI review tests prove isolation, protocol compatibility, strict parsing, provenance, review ordering, receipt enforcement, and fail-closed decisions only. They do not measure whether users understand or improve intent or evidence proposals. The current three-arm live protocol was frozen before two-stage review and compares task-agent-authored contracts with independently authored reference contracts while explicitly disabling review; it does not isolate auxiliary authorship or human review. A future decision-quality revision must pre-register separate intent-review and evidence-review arms and report omitted claims, intent corrections, evidence revisions, false certification, false exhaustion, false abstention, latency, token cost, review time, and abandonment before the project claims either review is net-positive.

## Current keyless evidence

Run:

```sh
npm run benchmark:keyless
```

Nine fault classes run ten times in baseline and governed arms through the real `@deepseek-ai/dsh-agent-loop` (180 runs). An out-of-band in-memory oracle, not the governor, decides ground truth. The checked-in [latest-keyless-report.json](../evaluations/latest-keyless-report.json) must pass its lifecycle, false-completion, and false-certification gates.

This proves that the hook and state machine enforce a valid contract. Scripted trials do not estimate model sampling variance, false exhaustion from model-authored contracts, or net product utility.

## Pre-registered live protocol

[live-benchmark.json](../evaluations/live-benchmark.json) fixes 20 safe local tasks, five trials, assignment order, estimands, direction, alpha, effect thresholds, false-rejection cost weights, MDE assumptions, and stopping rules. [live-benchmark.preregistered.json](../evaluations/live-benchmark.preregistered.json) locks SHA-256 hashes for the task manifest, runner, and analysis before a decision run.

Every case/trial block has three arms:

1. `baseline`: clean Harness `headless` profile, with a completion marker but no governor.
2. `governed-model-contract`: otherwise identical profile with the exact packed plugin; the model decides whether and how to author a contract.
3. `governed-reference-contract`: same governed profile, but the benchmark supplies an independently authored contract derived from the pre-registered oracle and requires the model to open it exactly.

Both governed arms explicitly set `contractReview.mode: off`. This is a disclosed unattended benchmark control, not automatic approval: it keeps human choices from changing the already pre-registered three-arm estimand and produces unreviewed version 3 contracts. A later user-review experiment must be a separately pre-registered arm rather than retrofitted after results are seen.

Reference-contract fidelity is measured from the durable contract event. A missing or modified contract is not silently accepted. Execution order uses a fixed three-way rotation within every block. Each run gets a new workspace and persisted Harness session. No outcome may be discarded.

The v5 runner also records the contract coverage status, critical and weighted declared-claim coverage, independent-source count, finding codes, and assessment receipt. These fields audit structural evidence sufficiency. They do not establish that a model-authored claim set is semantically complete; the model-versus-reference arm difference remains the measurement for that authorship risk.

The full default is 20 cases × 5 trials × 3 arms = **300 agent runs**. Provider cost depends on the configured model.

### Plan without spending

```sh
npm run benchmark:live:plan
```

The plan verifies all pre-registration hashes. Any change to the manifest, runner, or analysis invalidates the lock and requires a new reviewed pre-registration before live execution.

For a non-decision pilot:

```sh
# Export DEEPSEEK_API_KEY securely in this shell first.
npm run benchmark:live -- \
  --confirm-cost \
  --max-cases 2 \
  --trials 1 \
  --harness-root /absolute/path/to/deepseek-harness \
  --plugin /absolute/path/to/chenjie1129-dsh-reliability-governor-plugin-0.7.0.tgz \
  --output /absolute/path/to/pilot-report.json
```

A pilot is always `INCONCLUSIVE`. For a decision run, omit `--max-cases` and use at least five trials. The runner refuses a decision-quality execution unless the tracked tree is clean and its current commit equals the configured upstream commit, which makes the pre-registration publication check executable rather than documentary. It also refuses model calls without `--confirm-cost` and a process-level key, never prints the key, hashes the plugin artifact, and deletes temporary profiles/workspaces unless `--keep` is supplied.

## Auditable outcome primitives

The report first emits an arm-neutral table for every arm:

| System result | Oracle pass | Oracle fail |
| --- | --- | --- |
| reports success | true success | **false success** |
| does not report success | **false rejection** | true rejection |

“Reports success” means the model's final `COMPLETE` marker in every arm. This catches non-adoption and a model that claims completion despite `exhausted` or `abstained`; certification remains an independent governed decision. Baseline cannot “false-certify” because it has no certificate. The common benefit estimand is the reduction in false success.

For contract-adopted governed runs, a second table crosses terminal state with the oracle:

| Terminal | Oracle pass | Oracle fail |
| --- | --- | --- |
| `certified` | true certification | **false certification** |
| `exhausted` | **false exhaustion** | true exhaustion |
| `abstained` | **false abstention** | true abstention |
| unresolved | missed decision | unresolved failure |

`no_contract`, unresolved active state, timeout, nonzero exit, and missing session are reported separately. The final completion marker remains orthogonal, so an exhausted run that still claims `COMPLETE` remains visible.

False-exhaustion and false-abstention rates use all oracle-pass runs as the intention-to-treat denominator and also report the contract-adopted oracle-pass denominator for contract-quality diagnosis. Their union is reported as terminal false rejection, but both components remain visible and are gated separately. The pre-registered cost display weights exhaustion at `1.0` and abstention at `0.35`.

## Contract authorship and repair effects

The third arm estimates the self-authorship penalty:

```text
delta_contract = false-rejection(model-contract) - false-rejection(reference-contract)
```

The report computes this for both arm-neutral false rejection and terminal false rejection (`false exhaustion ∪ false abstention`). A terminal penalty points toward contract synthesis or human-confirmed reference contracts; a product-only penalty points toward adoption or final-reporting compliance. A high reference-arm terminal rejection rate points instead toward check semantics or repair policy. These are block-paired product estimands, not structural claims that authorship acts independently of check coverage or repair.

Paired baseline/governed oracle disagreements are reported as **rescue candidates** and **regression candidates**. Stochastic runs do not establish individual causality. For stronger within-run evidence, the runner watches durable `reliability/attempt` events and evaluates the independent oracle at each observed attempt boundary:

```text
first failed attempt (before repair) -> later attempt(s) -> terminal oracle
```

Only a live snapshot following a failed, not-yet-exhausted attempt can begin an attributed repair transition. If several attempts appear between observer polls, earlier ones are labeled `coalesced_backfill`; attempts first seen after process exit are `terminal_backfill`. Both are retained but excluded from pre-repair attribution. Post-certification regressions are counted separately. This observer narrows the causal gap; it is not equivalent to deterministic trajectory replay.

## Per-check attribution

Every `reliability/attempt` already stores the full ordered check-result set. The live report preserves it and aggregates, per check kind:

- attempt exposure and failure counts;
- failure rate conditional on exposure;
- exposed and failed run counts;
- unique-failure attempts;
- co-occurrence with false exhaustion, false abstention, and their union.

No “first failed check” attribution is used. If several checks fail together, their contributions are reported as co-occurrence rather than causal shares.

## Inference and power

Wilson 95% intervals describe rates on this fixed manifest. Repeated trials share a task and are not independent task samples, so arm differences also receive deterministic 10,000-replicate task-cluster bootstrap intervals. An exact task-level sign-flip test, not the run-level McNemar result, controls the verdict's false-success direction. Run-level paired McNemar remains descriptive for the fixed execution matrix.

The pre-registered MDE is a 0.15 absolute rate difference under the declared assumptions. It is larger than the 0.10 false-exhaustion and false-abstention thresholds. This limitation is published before data collection; interval bounds, not favorable point estimates, must satisfy those gates. Broader claims require more distinct task types, not merely more repeats of the same 20 tasks.

## Verdict

`PROVEN` requires all pre-registered checks:

- pre-registration hashes committed and published at the configured upstream;
- complete 20-case, five-trial, three-arm execution and no operational failure;
- no false certification in either governed arm;
- model-contract adoption and reference-contract fidelity Wilson lower bounds at least 0.80;
- model-contract false-exhaustion and false-abstention Wilson upper bounds at most 0.10 separately;
- task-cluster oracle-success difference lower bound no worse than -0.05;
- at least 30% relative false-success reduction;
- a task-cluster false-success benefit interval above zero and exact task-level sign-flip `p <= 0.05` in the beneficial direction.

`HARMFUL` is returned for any false certification, increased false success, a confidently material oracle-success regression, or a false-exhaustion point rate over its gate. Everything else is `INCONCLUSIVE`.

The report also emits an independent contract-authorship finding. It does not turn an inconclusive product verdict into proof.

## Repair safety boundary

Every task declares one action class:

- `read-only`;
- `workspace-reversible`;
- `external-or-non-idempotent`.

The live manifest is local and isolated. Prompts prohibit external actions and automatic retry for the external/non-idempotent class. The runtime governor does not yet possess authoritative tool-side-effect metadata and therefore cannot itself prove reversibility or create a rollback. Outside a disposable workspace, deployment policy must provide snapshots/worktrees for reversible mutation and require abstention or human confirmation for irreversible actions.

## Before accepting a result

- Push the pre-registration commit or immutable tag before the first provider-backed decision run.
- Keep prompts, tasks, hashes, model/provider settings, sampling parameters, plugin artifact, Harness commit, and arm order fixed.
- Retain non-adoption, timeouts, failures, and unresolved states.
- Inspect every false certification and false rejection, plus a random sample of successes.
- Publish the full JSON and rerun after changing any material component.
