# Research decision

Research snapshot: 2026-08-23.

## Finding

A reliability layer is needed, but a plugin cannot make general LLM output deterministic. The feasible target is to reduce **outcome variance and false completion** for tasks with observable success criteria.

The need is strongest where agents use tools. A model may produce plausible prose even when the tool failed, the expected artifact is absent, or a prior successful result is incorrectly reused. Prompting and low temperature help presentation consistency but do not independently verify world state.

## Evidence

- [τ-bench](https://arxiv.org/abs/2406.12045) introduced pass^k for repeated agent trials and found consistency remained difficult even where single-run pass rates looked acceptable.
- Anthropic's [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) recommends multiple trials, outcome-based grading, and deterministic graders where possible instead of trusting an agent's self-report.
- Anthropic's [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) describes evaluator-optimizer loops but also emphasizes starting with the simplest composable pattern that works.
- DeepSeek's [temperature settings](https://api-docs.deepseek.com/quick_start/parameter_settings) describe sampling control, while [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode) documents that temperature and related sampling parameters have no effect there. Temperature is therefore not a universal reliability control.
- Research on [LLM-as-a-Verifier](https://arxiv.org/abs/2607.05391) supports verifier-based inference but does not remove the need to evaluate the verifier itself; a model judge remains probabilistic.

## Harness gap analysis

The official clean Harness source provides the extension seams needed for a plugin:

- `agent/turn-stopping` can steer another step before closure;
- `SessionEventMap` is merge-extensible and persisted;
- `ctx.fs` provides backend-owned path identity and canonical containment;
- tools expose structured call/result events.
- `ctx.skills` separates reusable model guidance from executable enforcement;
- `ctx.subprocess`, `ctx.sandbox`, and `ctx.sandboxPolicy` provide managed, secret-scrubbed, policy-bounded execution for deployment-authored code checks.

The current goal-round-driver and Ralph workflow documentation explicitly say they have no independent evaluator. Session checkpoint policy also says it is not a generic exactly-once mechanism and unknown side-effect outcomes must not be blindly retried. A separate, generic evidence gate therefore belongs in a Cordis plugin rather than in a prompt-only skill or a patch to the core loop.

## Adjacent implementations

- [dsh-eval](https://github.com/hccccc01333/dsh-eval) is oriented toward offline evaluation rather than same-session completion enforcement.
- [dsh-plugin-llm-verifier](https://github.com/uson1x/dsh-plugin-llm-verifier) uses best-of-N plus model grading; useful for candidate selection, but costly and still stochastic.
- [dsh-doublecheck](https://github.com/PerryLink/dsh-doublecheck) is a coding-oriented verification gate. The generic gap remains for explicit cross-tool/file completion contracts.

## Decision

Build a narrow deterministic governor first:

1. explicit contract rather than inferred success criteria;
2. deterministic checks before any learned evaluator;
3. evidence after the contract boundary only;
4. bounded repair, then fail closed;
5. explicit abstention for unsupported proof;
6. durable receipts and repeated-trial evaluation.

This can materially improve stable task outcomes. It cannot guarantee identical answers, correct contract selection, or correctness that no available check can observe.

## v0.2 coding-verifier decision

A coding skill alone would leave implementation and judgment inside the same probabilistic model. v0.2 therefore packages the skill for workflow consistency while assigning authority to immutable runtime profiles. The model supplies only a profile ID; deployment controls the argv, Harness owns confinement and managed execution, and the governor accepts only fresh durable verifier events. This reduces self-grading and command-substitution risk without introducing an LLM judge.
