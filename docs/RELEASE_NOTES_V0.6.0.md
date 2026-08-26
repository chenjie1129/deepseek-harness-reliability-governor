# Reliability Governor v0.6.0

v0.6.0 adds a user-controlled contract-activation boundary. Before a proposed evidence contract can govern completion, the interactive default pauses the live root agent and asks the user to approve, request revision, or reject the exact receipt-bound proposal.

## Added

- A fixed A2UI v0.9.1 Basic-catalog Web surface showing the objective, claims, checks, authorship, coverage findings, repair budget, and proposal receipt.
- Native Harness question rendering as a fallback for clients that do not load the A2UI module.
- Version 4 contracts that bind an approved proposal receipt to a durable review receipt.
- Privacy-minimized `reliability/contract-review` events and optional revision feedback returned to the task agent.
- Fail-closed handling for rejection, revision, cancellation, missing providers, malformed answers, stale receipts, invalid actions, and renderer failure.
- Explicit `contractReview.mode: off` for disclosed unattended workflows; it creates an unreviewed version 3 contract rather than pretending approval.

## Trust boundary

A2UI presents the choice. Harness's live-root user-question service owns the decision channel. Deterministic checks still own certification. Approval is not proof that the proposal is complete or that the task succeeded, and the content receipts are hashes rather than signatures.

## Evidence status

The release suite exercises the official A2UI v0.9.1 message processor, A2UI/native selection, exact receipt changes, untrusted text escaping, user decisions, missing UI authority, and the prior deterministic gate benchmarks. It supports mechanism and compatibility claims only. No provider-backed model-quality or user-comprehension study has been run.

## Install

```sh
git clone --branch v0.6.0 --depth 1 \
  https://github.com/chenjie1129/deepseek-harness-reliability-governor.git
cd deepseek-harness-reliability-governor
npm ci
npm pack
dsh plugin --profile web add ./chenjie1129-dsh-reliability-governor-plugin-0.6.0.tgz
dsh --profile web --dump-config
dsh --profile web
```

See [Contract review](CONTRACT_REVIEW.md), [Contract authoring](CONTRACT_AUTHORING.md), [Benchmark](BENCHMARK.md), and [Limitations](LIMITATIONS.md).
