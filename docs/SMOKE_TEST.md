# Clean-profile Harness smoke test

A package test is not a Harness integration test. The exact packed package must be installed into an isolated profile, composed, and booted.

## Prerequisites

- DeepSeek Harness `0.1.1-rc.2` package floor or the `0.1.2-alpha.1` source release.
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
dsh plugin --profile reliability-smoke add ./chenjie1129-dsh-reliability-governor-plugin-0.6.1.tgz
export GOVERNOR_PACKAGE="$DSH_HOME/profiles/reliability-smoke/node_modules/@chenjie1129/dsh-reliability-governor-plugin"
dsh --profile reliability-smoke \
  --patch "$GOVERNOR_PACKAGE/examples/code-verification.patch.yml" \
  --dump-config
```

The composed output must contain:

```text
id: reliability-governor
name: '@chenjie1129/dsh-reliability-governor-plugin'
contractReview:
  mode: required
```

Then boot the custom profile (it intentionally has no interactive application and remains mounted until interrupted). This proves server composition only; because it has no question provider, an attempted contract review must return `review-unavailable` and leave no active contract:

```sh
dsh --profile reliability-smoke \
  --patch "$GOVERNOR_PACKAGE/examples/code-verification.patch.yml"
```

Let startup settle, verify there is no activation error, and press Ctrl-C. Harness exits `130` for that deliberate interrupt. The boot must complete with the plugin's `skills`, `llm`, and `userQuestions` dependencies present; package integration tests additionally assert that `reliability-code-verification` appears in `ctx.skills`, default `current-agent` mode makes no auxiliary call, and review failures do not activate contracts. A model-backed auxiliary-author trial additionally requires a configured Harness provider route and a patched `contractAuthoring.mode: auxiliary-model`; it is not proven by a default-profile boot.

On Harness `0.1.2-alpha.1`, also persist a disposable session containing a Governor contract, stop the profile, and resume that exact session. Resume must not report an unknown `reliability/*` event type. The plugin registers its six required events in Harness's fail-closed persistence catalog before any contract can activate; a boot-only test does not prove that read path.

For the Web face, also boot a disposable `web` profile with the exact tarball. Authenticate through the process-token startup URL, verify the page's client-module preload includes `@chenjie1129/dsh-reliability-governor-plugin/client.js`, a pending Governor review displays the A2UI objective/claims/checks/budget, all three decisions respond once, and the browser console has no module or renderer error. Harness `0.1.2-alpha.1` serves client modules through a combined `/plugins/??...` request rather than the earlier package-specific URL, so inspect the declared module list instead of assuming one route. Native fallback and A2UI are two presentations of the same Harness question; do not claim A2UI was validated from a headless boot alone.

Run repeated task trials, not one transcript, and compare false completion and certified success against an ungoverned profile. Automated trials must explicitly set `contractReview.mode: off` and disclose that the resulting contracts were unreviewed.

Delete only the exact temporary directory after recording results. Do not use an existing user profile as the smoke target.
