# Clean-profile Harness smoke test

A package test is not a Harness integration test. The exact packed package must be installed into an isolated profile, composed, and booted.

## Prerequisites

- DeepSeek Harness `0.1.1-rc.2` source checkout or installed CLI.
- Node.js compatible with the package engine.
- pnpm available to the Harness profile installer.

## Procedure

From this plugin directory:

```sh
npm run check
npm pack
```

Create an isolated Harness home and install the exact tarball into a fresh profile:

```sh
export DSH_SMOKE_HOME="$(mktemp -d)"
export DSH_HOME="$DSH_SMOKE_HOME"
dsh plugin --profile reliability-smoke add ./chenjie1129-dsh-reliability-governor-plugin-0.4.0.tgz
export GOVERNOR_PACKAGE="$DSH_HOME/profiles/reliability-smoke/node_modules/@chenjie1129/dsh-reliability-governor-plugin"
dsh --profile reliability-smoke \
  --patch "$GOVERNOR_PACKAGE/examples/code-verification.patch.yml" \
  --dump-config
```

The composed output must contain:

```text
id: reliability-governor
name: '@chenjie1129/dsh-reliability-governor-plugin'
```

Then boot the custom profile (it intentionally has no interactive application and remains mounted until interrupted):

```sh
dsh --profile reliability-smoke \
  --patch "$GOVERNOR_PACKAGE/examples/code-verification.patch.yml"
```

Let startup settle, verify there is no activation error, and press Ctrl-C. Harness exits `130` for that deliberate interrupt. The boot must complete with the plugin's `skills` dependency present; package integration tests additionally assert that `reliability-code-verification` appears in `ctx.skills`. A model-backed end-to-end trial additionally requires a configured provider. Run repeated task trials, not one transcript, and compare false completion and certified success against an ungoverned profile.

Delete only the exact temporary directory after recording results. Do not use an existing user profile as the smoke target.
