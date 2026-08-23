# Security policy

## Trust boundary

This is a same-process DeepSeek Harness Cordis plugin. It is not itself a sandbox or authorization layer. Harness sandbox and session policy continue to own the maximum execution boundary.

File assertions are read-only through `ctx.fs`. Trusted code profiles use `ctx.subprocess`, `ctx.sandbox`, and `ctx.sandboxPolicy`; the plugin never imports Node child-process APIs, accepts model-authored commands, makes network requests itself, or reads provider credentials. Profile permission is intersected with session policy, full sandbox enforcement is required, and Harness scrubs credential-shaped ambient environment variables before spawning.

Deployment owners control each profile's executable and exact arguments. Treat that configuration as trusted code. A profile can run arbitrary local software within its effective sandbox and should receive the same review as CI configuration.

## Sensitive data

Contracts and results are persisted in the session log. Do not put secrets, tokens, private keys, passwords, or sensitive file literals in an objective, `text`, or `argumentsContain` field. Code-verification events store output byte counts, truncation facts, and content receipts—not raw stdout/stderr. The subprocess service removes credential-shaped ambient variables unless a trusted caller explicitly forwards them; this plugin forwards none.

## Side effects

The plugin never retries business tools or trusted profiles automatically. An agent is instructed not to repeat non-idempotent operations with unknown outcomes. Use authoritative read-after-write checks or `reliability_abstain` when the state cannot be proven. A `workspace-write` verification profile may write inside the workspace; prefer `read-only` profiles and review expected build/cache effects.

## Reporting

Report vulnerabilities privately to the repository owner before public disclosure. Include the package version, Harness version, configuration, reproduction, and impact. Never include live credentials.
