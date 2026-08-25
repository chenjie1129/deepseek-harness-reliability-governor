# Reliability Governor v0.5.0

v0.5 adds configurable contract authorship without turning another model into the judge. The safe default remains the current task agent with no extra provider request. An optional auxiliary route can make one bounded text-only call to propose claims and checks; a receipt binds the exact draft to contract activation, while deterministic and deployment-controlled evidence retains all certification authority.

## What changed

- Three modes: `current-agent`, `auxiliary-model`, and `manual`.
- New `reliability_draft` tool in auxiliary mode.
- Provider-neutral route selection through Harness's existing Models configuration; no credentials or endpoints are stored by this plugin.
- Strict JSON parsing, input/output/time bounds, no tool schemas, no workspace access, no automatic fallback, and configured verifier-profile allowlisting.
- New `reliability/contract-draft` event and version 3 contracts with explicit authorship provenance.
- Exact draft-receipt enforcement at `reliability_begin`.
- Receipt-bound code drafts that inject deployment-required trusted profiles before hashing and activate through `reliability_begin_code`.
- Honest `caller-declared` labeling for manual and current-agent authorship.

## Evidence scope

The automated suite proves the implementation boundary with scripted streams and repeats the existing 180-run real AgentLoop mechanism benchmark. It does not prove that an auxiliary live model improves contract quality. The existing provider-backed benchmark has not been executed, and it does not yet isolate auxiliary authorship as a separate arm. No live-model quality, latency, cost, or net-utility claim is made for this feature.

## Install

```sh
git clone --branch v0.5.0 --depth 1 \
  https://github.com/chenjie1129/deepseek-harness-reliability-governor.git
cd deepseek-harness-reliability-governor
npm ci
npm pack
dsh plugin --profile web add ./chenjie1129-dsh-reliability-governor-plugin-0.5.0.tgz
```

Start with `current-agent`. Configure `auxiliary-model` only after its exact provider route works in Harness and the extra latency/cost is acceptable. See [Contract authoring](CONTRACT_AUTHORING.md).
