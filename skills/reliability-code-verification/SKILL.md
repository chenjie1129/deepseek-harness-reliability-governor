# Trusted code verification

Use this skill for coding or repository changes when Reliability Governor exposes trusted code-verification profiles.

1. Call `reliability_code_profiles` before changing code. Treat the returned profile IDs as deployment policy, not suggestions you may rewrite.
2. If one or more profiles are marked `required`, call `reliability_begin_code` before implementation. Describe the real requested outcome. In `auxiliary-model` authoring mode, first call `reliability_draft` with `contract_kind: code`, then pass its exact full claims, checks, and single-use receipt to `reliability_begin_code`; the runtime injects required profiles before it receipts the draft. In other modes, required profiles receive a critical claim automatically. For every added artifact check, add the claim it supports and use the smallest independent evidence set that covers that claim; several checks over one file remain one source.
3. Implement the change with ordinary coding and filesystem tools. You may run ordinary tests for diagnostics, but those calls do not replace trusted verification evidence.
4. After all implementation and diagnostic tool calls, run required `workspace-write` profiles first, then call `reliability_code_verify` for each read-only profile. Supply only its profile ID. Never substitute a different command, weaken tests, alter verification configuration, or claim that an ordinary shell call is equivalent.
5. If trusted verification fails, use ordinary diagnostic tools to identify the cause, repair the implementation, and rerun the same trusted profile. Any non-governor tool call after a successful verification invalidates that evidence, so rerun every affected trusted profile last. The verifier intentionally withholds raw output from durable receipts; this prevents logs or secrets from becoming permanent evidence.
6. Report completion only after the active reliability contract is `certified`. If a required profile is unavailable, sandbox enforcement is incomplete, credentials are needed, or safe proof cannot be collected, call `reliability_abstain` and explain the missing evidence.

The runtime verifier, not this skill, holds enforcement authority. A skill is model guidance and must never be presented as an independent judge.
