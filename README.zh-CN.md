# DeepSeek Harness Reliability Governor

这是一个可选启用的 DeepSeek Harness 组合包，把“模型说做完了”改成“确定性证据检查通过了”。

它**不能让大模型本身变成确定性系统**。它提供的是更窄、可验证的保证：只要可靠性合约仍处于 active 状态，Agent 就不能自然结束；插件会检查证据、引导有限次数修复，最终只记录 `certified`、`exhausted` 或 `abstained`。每次检查和终态都写入持久会话日志，并带内容收据。

## 为什么需要它

随机性不只来自 temperature。工具返回、环境状态、上下文、成功标准不清晰，以及模型“自报完成”都会造成波动。降低 temperature 不能证明事情真的完成；某些推理模式甚至会忽略 temperature。

Harness 已有 goal 和迭代工作流能力，但其当前文档明确没有提供独立验证器。本插件补的是这个通用运行时缺口，不替代原有工作流。

## 提供的能力

- `reliability_begin`：建立一个明确、持久的完成合约。
- `reliability_begin_code`：建立代码合约，并自动加入部署方要求的全部可信验证 Profile。
- `reliability_verify`：立即运行确定性检查。
- `reliability_status`：读取合约、尝试记录、终态和收据。
- `reliability_abstain`：无法安全证明时明确放弃，不伪造结论。
- `reliability_code_profiles`：列出可信 Profile 元数据，但不向模型暴露可改写的命令。
- `reliability_code_verify`：通过 Harness 托管的 subprocess 和 sandbox 执行固定 Profile。
- `agent/turn-stopping` 门禁：active 合约在 Agent 结束前自动检查；失败时仅引导修复失败项，达到上限后 fail closed。

v0.2 支持 `file_exists`、`file_absent`、`file_contains`、`tool_succeeded`、`tool_not_called`、`code_verification_succeeded` 和 `no_tool_errors` 七种检查。

文件验证只通过 Harness 的 `ctx.fs` 做只读检查。可信代码 Profile 的完整 argv 由部署方配置，模型只能提交 Profile ID；执行必须经过 Harness 的 `ctx.subprocess`、`ctx.sandbox` 和 `ctx.sandboxPolicy`。插件不会调用另一个大模型裁判、不会重试供应商请求，也不会自动重复业务副作用。

## 安装

在包含本目录的上级目录执行：

```sh
git clone https://github.com/chenjie1129/deepseek-harness-reliability-governor.git
cd deepseek-harness-reliability-governor
npm ci
npm pack
dsh plugin --profile web add ./chenjie1129-dsh-reliability-governor-plugin-0.2.0.tgz
dsh --profile web --dump-config
dsh --profile web
```

Profile 的 `dsh.profile.bundles` 必须真正包含 `@chenjie1129/dsh-reliability-governor-plugin`。只把源码放在 Harness 旁边不算启用。

## 默认配置

```yaml
maxAttempts: 3
maxChecks: 20
maxFileBytes: 1048576
autoVerifyAtTurnStop: true
codeVerificationMaxOutputBytes: 65536
codeVerificationProfiles: []
```

代码 Profile 默认为空，因为不同仓库的测试门禁不同。请按 [可信代码验证](docs/CODE_VERIFICATION.md) 配置经过审查的测试、类型检查和构建命令。内置 Skill 负责教模型如何工作；真正拥有判定权的是固定的运行时 Profile，而不是 Skill。

## 重要边界

- 收据是对日志内容的 SHA-256 摘要，不是数字签名，也不是第三方证明。
- 模型仍负责决定是否建立合约、以及哪些检查能代表成功；错误的合约仍可能验证错误目标。
- 本插件改善结果可靠性，不保证每次回答措辞完全一致。
- v0.2 不判断视觉质量、超出配置检查范围的开放式语义正确性、缺少权威证据的远程状态，也不会猜测未知副作用是否成功。
- 含本插件自定义必要事件的会话，在恢复时应继续安装本组合包。

开发验证：

```sh
npm install
npm run check
npm run benchmark:live:plan
```

`npm run check` 还会执行 180 次真实 Harness AgentLoop 的无密钥 A/B 故障注入基准，其中包含“普通成功工具不能替代可信代码 Profile”的对抗用例。该结果能证明门禁机制和生命周期符合预期，但不能证明自然语言模型本身变成确定性系统。

20 个任务、每组 5 次重复的真实模型 A/B 协议、独立 Oracle、成本确认、统计显著性和 `PROVEN / INCONCLUSIVE / HARMFUL` 判定规则，见 [docs/BENCHMARK.md](docs/BENCHMARK.md)。代码判定边界见 [docs/CODE_VERIFICATION.md](docs/CODE_VERIFICATION.md)。真实 Harness 安装验证步骤见 [docs/SMOKE_TEST.md](docs/SMOKE_TEST.md)。

## 许可证

MIT
