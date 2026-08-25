# Reliability Governor v0.4.0

v0.4.0 adds contract coverage: the governor now checks whether every declared success claim has enough independent deterministic evidence before a contract can activate. It still does not make an LLM deterministic and cannot detect requirements omitted from the claim list.

## Highlights

- Add `reliability_assess`, a non-mutating preflight for claims, checks, and evidence-source counts.
- Count distinct authorities rather than raw checks: several checks over one file, tool, or trusted verifier profile count once.
- Return `review-required` for human-only, unsupported, or under-supported declared claims.
- Surface exact-literal, presence-only, trajectory, tool-outcome, orphan-check, and shared-check warnings without pretending they are semantic judgments.
- Persist ready assessments and receipts inside version 2 contracts while retaining version 1 session compatibility.
- Extend the three-arm live runner with coverage telemetry and a new pre-registration lock before any v3 provider run.

## Evidence status

`npm run check` executes 32 tests, validates the evaluation manifests, builds strict ESM TypeScript, runs 180 keyless AgentLoop trials, verifies the live pre-registration plan, checks the generated demo asset, validates the release contract, and audits the npm pack list.

The checked-in keyless result remains mechanism-only evidence and currently reports zero governed false completions and zero false certifications. The provider-backed v3 benchmark has **not** been executed, so this release makes no live-model quality, latency, cost, or net-utility claim.

## Install from the release source

```sh
git clone --branch v0.4.0 --depth 1 \
  https://github.com/chenjie1129/deepseek-harness-reliability-governor.git
cd deepseek-harness-reliability-governor
npm ci
npm pack
dsh plugin --profile web add ./chenjie1129-dsh-reliability-governor-plugin-0.4.0.tgz
dsh --profile web --dump-config
```

Confirm that `@chenjie1129/dsh-reliability-governor-plugin` appears in `dsh.profile.bundles`, then start the profile normally. Trusted code-verification profiles remain empty by default and must be deployment-authored.

## Upgrade note

Existing version 1 contract events remain readable. New direct calls to `reliability_begin` must add the required `claims` array and use `check_ids` to map every declared claim to its checks; a structurally insufficient mapping returns `review-required` without opening a contract. `reliability_begin_code` creates the required trusted-profile claim automatically.

See [CONTRACT_COVERAGE.md](CONTRACT_COVERAGE.md), [BENCHMARK.md](BENCHMARK.md), [CODE_VERIFICATION.md](CODE_VERIFICATION.md), and [SMOKE_TEST.md](SMOKE_TEST.md).
