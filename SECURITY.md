# Security policy

## Trust boundary

This is a same-process DeepSeek Harness Cordis plugin. It is not itself a sandbox or authorization layer. Harness sandbox and session policy continue to own the maximum execution boundary.

File assertions are read-only through `ctx.fs`. Trusted code profiles use `ctx.subprocess`, `ctx.sandbox`, and `ctx.sandboxPolicy`; the plugin never imports Node child-process APIs, accepts model-authored commands, performs direct network I/O, or reads provider credentials. In optional `auxiliary-model` mode it asks Harness's provider-neutral `ctx.llm` service to make one text-only drafting call on the exact configured route. Default contract activation uses Harness's UI-backed `ctx.userQuestions` service with the exact live agent. Profile permission is intersected with session policy, full sandbox enforcement is required, and Harness scrubs credential-shaped ambient environment variables before spawning.

The bundled browser face renders only a bounded, fixed-purpose A2UI v0.9.1 Basic-catalog surface. Proposal strings are treated as display text, and the selector rejects unknown component types, action names, question/option shapes, surface IDs, and proposal receipts. Actions return a structured answer to Harness; they cannot directly execute a business tool. A native Harness question remains the fallback. A2UI is not the approval authority, an execution sandbox, or a certification oracle.

Deployment owners control each profile's executable and exact arguments. Treat that configuration as trusted code. A profile can run arbitrary local software within its effective sandbox and should receive the same review as CI configuration.

## Sensitive data

Contracts and results are persisted in the session log and the proposed contract is displayed to the reviewing client. Do not put secrets, tokens, private keys, passwords, or sensitive file literals in an objective, auxiliary-author `context`, `text`, or `argumentsContain` field. Normal Harness tool events may retain `reliability_draft` arguments, and auxiliary mode sends its objective/context payload to the configured model provider. The custom draft event excludes raw reasoning and raw context but retains a content receipt. The review event stores free-text feedback only as byte count and receipt, although the ordinary tool result returns it to the task agent. Code-verification events store output byte counts, truncation facts, and content receipts—not raw stdout/stderr. The subprocess service removes credential-shaped ambient variables unless a trusted caller explicitly forwards them; this plugin forwards none.

## Side effects

The plugin never retries business tools or trusted profiles automatically. An agent is instructed not to repeat non-idempotent operations with unknown outcomes. Use authoritative read-after-write checks or `reliability_abstain` when the state cannot be proven. A `workspace-write` verification profile may write inside the workspace; prefer `read-only` profiles and review expected build/cache effects.

## Reporting

Report vulnerabilities privately to the repository owner before public disclosure. Include the package version, Harness version, configuration, reproduction, and impact. Never include live credentials.
