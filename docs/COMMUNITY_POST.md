# Community announcement draft

Target: [DeepSeek Harness — Show Your Plugins!](https://github.com/deepseek-ai/deepseek-harness/discussions/categories/show-your-plugins)

Suggested title:

```text
DSH | Reliability Governor | Evidence-gated completion with auditable receipts
```

The following copy follows the official category requirements: one project, an `DSH | ...` title, an explicit unofficial label, project URL, introduction, visual, and DSH integration details.

---

> **Unofficial project, independently developed and maintained by a community member.**
>
> Project: https://github.com/chenjie1129/deepseek-harness-reliability-governor

## Reliability Governor

AI agents can misunderstand a request, choose weak proof, or say “done” while the requested artifact disagrees. Reliability Governor is an opt-in DeepSeek Harness bundle that separates those risks. v0.7 first asks the user to review the agent's interpreted intent, then separately reviews how completion will be proved, and only then changes completion from a model assertion into an explicit evidence decision:

- `certified` — all declared observable checks passed;
- `exhausted` — checks still failed after a bounded repair budget;
- `abstained` — the agent declined to invent proof.

It **does not make an LLM deterministic**. It makes the narrower completion decision auditable while a contract is active.

![Reliability Governor mechanism and keyless benchmark](https://raw.githubusercontent.com/chenjie1129/deepseek-harness-reliability-governor/main/docs/assets/keyless-benchmark.svg)

### How it integrates with DSH

The package ships a native `dsh.bundle` patch. Its Cordis plugin registers coverage assessment, contract, status, verification, abstention, and trusted-code-profile tools; hooks `agent/turn-stopping`; performs read-only file checks through `ctx.fs`; and runs deployment-authored code profiles only through Harness subprocess, sandbox, and sandbox-policy services. Attempts and terminal receipts are stored as durable session events.

`reliability_assess` reports declared-claim coverage, distinct evidence authorities, brittle-check warnings, and a content receipt without judging task output. Two checks over one file count as one source. It cannot detect requirements omitted from the claim list, so the live protocol retains independently authored reference contracts.

v0.7 uses two fixed A2UI v0.9.1 Web reviews with native Harness question fallback. The first shows the interpreted objective, constraints, assumptions, non-goals, and ambiguities. Only its exact approval opens the second review for claims, checks, coverage findings, authorship, and repair budget. Both approvals are receipt-bound; revision, rejection, cancellation, stale actions, delegated-agent answers, or a missing UI provider leave no active contract. A2UI presents the choices, Harness owns the live-root decision channel, and deterministic checks still own certification.

Optional receipt-bound contract drafting remains available. The default task agent can remain the author with no extra call, or a configured provider-neutral auxiliary model can make one bounded text-only draft call with no tools, workspace access, repair loop, fallback, or certification authority. These boundaries have scripted mechanism evidence only; no claim is made yet that a live auxiliary model or user review improves contract quality.

### Current evidence and boundaries

The checked-in keyless suite runs nine fault classes ten times in baseline and governed arms through the real Harness AgentLoop: 180 scripted runs. It currently passes its mechanism gates with zero governed false completions and zero false certifications. This proves the enforcement path under scripted faults—it is **not** evidence that a natural-language model became more reliable.

A separate 20-task, five-trial, three-arm provider-backed protocol is pre-registered to measure false success, false exhaustion, false abstention, contract-authorship cost, repair rescue/regression candidates, latency, tokens, and uncertainty. It has not been run, so no live-model improvement claim is being made.

### Quick start

```sh
git clone https://github.com/chenjie1129/deepseek-harness-reliability-governor.git
cd deepseek-harness-reliability-governor
npm ci
npm pack
dsh plugin --profile web add ./chenjie1129-dsh-reliability-governor-plugin-0.7.0.tgz
dsh --profile web --dump-config
dsh --profile web
```

### Counterexamples wanted

I am looking for five to ten Harness users willing to try three to five **disposable local tasks**. The most useful feedback is not praise; it is a redacted reproduction of:

- false certification: incorrect work was certified;
- false exhaustion: correct work burned the repair budget;
- false abstention: correct work was not certified;
- repair regression: a bad check caused repair to damage correct work;
- brittle check semantics or Harness compatibility problems.

The 15-minute protocol and structured issue forms are here:

- Feedback protocol: https://github.com/chenjie1129/deepseek-harness-reliability-governor/blob/main/FEEDBACK.md
- Issues: https://github.com/chenjie1129/deepseek-harness-reliability-governor/issues/new/choose
- Benchmark design: https://github.com/chenjie1129/deepseek-harness-reliability-governor/blob/main/docs/BENCHMARK.md

Please do not submit credentials, private source, customer data, or raw private transcripts. Use a disposable workspace and do not test unknown external side effects.

---

## 中文版

> **非官方项目，由社区成员独立开发和维护。**
>
> 项目地址：https://github.com/chenjie1129/deepseek-harness-reliability-governor

AI Agent 可能误解用户意图、选择薄弱证据，或在实际结果尚未满足要求时直接说“已经完成”。Reliability Governor v0.7 是一个可选启用的 DeepSeek Harness Bundle：先让用户审查 Agent 对意图的解释，再单独审查证据合约，最后把完成从模型自报改成显式证据判定：

- `certified`：预先声明的可观察检查全部通过；
- `exhausted`：有限修复次数用尽后仍未通过；
- `abstained`：无法证明时明确放弃，不伪造结论。

它**不能让大模型本身变成确定性系统**。它提供的是更窄的保证：合约 active 期间，完成判定必须留下可审计证据。

插件通过原生 `dsh.bundle` Patch 接入 Cordis，注册合约、验证、状态、放弃和可信代码 Profile 工具；使用 `agent/turn-stopping` 做结束门禁；文件检查走 `ctx.fs`；部署方固定的代码命令只能通过 Harness subprocess、sandbox 和 sandbox-policy 执行。每次检查和终态都保存在持久会话事件中。

当前仓库包含 180 次真实 Harness AgentLoop 的无密钥故障注入测试，门禁机制检查通过，governed 组 false completion 和 false certification 均为 0。这个结果只证明脚本化故障下的门禁机制，**不代表真实自然语言模型质量已经提升**。真实模型三臂评测已经预注册，但尚未运行，因此项目没有发布真实模型改进结论。

现在希望招募 5–10 位 Harness 用户，在一次性本地工作区各测试 3–5 个任务。最需要的不是好评，而是以下可复现反例：错误认证、正确结果被耗尽、错误放弃、修复导致结果退化、检查语义过脆，或者 Harness 兼容问题。

测试协议：https://github.com/chenjie1129/deepseek-harness-reliability-governor/blob/main/FEEDBACK.md

请勿提交密钥、私有源码、客户数据或未经脱敏的会话内容，也不要使用带未知外部副作用的任务测试。
