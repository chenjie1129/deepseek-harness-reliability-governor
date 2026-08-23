# Reliability Governor v0.3.0

v0.3.0 turns the benchmark's false-rejection critique into an auditable three-arm protocol and adds less brittle deterministic checks. The release remains deliberately narrow: it governs evidence-based completion; it does not make model sampling deterministic.

## Highlights

- Add `file_not_contains`, `file_equals`, and JSON Pointer-based `json_equals` checks.
- Preserve the full result set for every check on every attempt.
- Replace the live A/B design with pre-registered baseline, model-authored-contract, and independently-authored-reference-contract arms.
- Report false certification, false exhaustion, and false abstention separately.
- Add task-cluster bootstrap intervals, paired rescue/regression candidates, and within-run repair-boundary oracle observations.
- Lock the task manifest, runner, and analysis hashes before provider-backed execution.
- Add a public beta protocol, privacy-aware issue forms, and a reproducible mechanism-benchmark visual.

## Evidence status

`npm run check` executes 27 tests, validates the evaluation manifests, builds strict ESM TypeScript, runs 180 keyless AgentLoop trials, verifies the live pre-registration plan, checks the generated demo asset, validates the release contract, and audits the npm pack list.

The checked-in keyless result has mechanism-only claim scope. It passes all scripted enforcement gates with zero governed false completions and zero false certifications. The 300-run provider-backed decision benchmark has **not** been executed; this release therefore makes no real-model quality, latency, or cost claim.

## Install from the release source

```sh
git clone --branch v0.3.0 --depth 1 \
  https://github.com/chenjie1129/deepseek-harness-reliability-governor.git
cd deepseek-harness-reliability-governor
npm ci
npm pack
dsh plugin --profile web add ./chenjie1129-dsh-reliability-governor-plugin-0.3.0.tgz
dsh --profile web --dump-config
```

Confirm that `@chenjie1129/dsh-reliability-governor-plugin` appears in `dsh.profile.bundles`, then start the profile normally. Trusted code-verification profiles are empty by default and must be deployment-authored.

When publishing the GitHub Release, attach the exact `.tgz` that passed the clean-profile smoke test and a SHA-256 checksum file. Do not substitute a locally rebuilt artifact after validation.

## Compatibility and boundaries

- Node.js `^22.19.0 || >=24.0.0`.
- DeepSeek Harness `0.1.1-rc.2` package family; peer ranges remain below `0.2.0`.
- Keep the bundle installed when resuming sessions that contain its required custom event vocabulary.
- Use disposable workspaces for beta repair testing and abstain on unknown external side effects.

See [FEEDBACK.md](../FEEDBACK.md), [BENCHMARK.md](BENCHMARK.md), [CODE_VERIFICATION.md](CODE_VERIFICATION.md), and [SMOKE_TEST.md](SMOKE_TEST.md).
