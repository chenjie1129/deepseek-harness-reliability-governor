import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, posix, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { apply } from '../dist/index.js'
import { foldReliability } from '../dist/types.js'

const root = new URL('../', import.meta.url)
const manifestUrl = new URL('evaluations/keyless-benchmark.json', root)

function parseArgs(argv) {
  const result = {
    trials: undefined,
    output: fileURLToPath(new URL('evaluations/latest-keyless-report.json', root)),
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--trials') result.trials = Number(argv[++index])
    else if (arg === '--output') result.output = resolvePath(argv[++index])
    else if (arg === '--help') {
      console.log('Usage: node scripts/run-keyless-benchmark.mjs [--trials N] [--output PATH]')
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return result
}

function textResponse(operation) {
  let text = operation.message ?? ''
  if (operation.outcome === 'complete') text += `${text.length === 0 ? '' : '\n'}BENCHMARK_OUTCOME: COMPLETE`
  if (operation.outcome === 'not_complete') text += `${text.length === 0 ? '' : '\n'}BENCHMARK_OUTCOME: NOT_COMPLETE`
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: Math.max(1, text.length) } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(operation, index) {
  const id = CallId(`benchmark-${index}`)
  const argumentsJson = JSON.stringify(operation.arguments ?? {})
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: operation.name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: operation.name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function compileScript(operations) {
  return operations.map((operation, index) => {
    if (operation.type === 'text') return textResponse(operation)
    if (operation.type === 'tool') return toolCallResponse(operation, index)
    throw new Error(`unknown scripted operation type: ${operation.type}`)
  })
}

class ScriptedAdapter extends LlmAdapter {
  requests = []

  constructor(script) {
    super()
    this.script = [...script]
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options) {
    this.requests.push(options)
    const response = this.script.shift()
    if (response === undefined) throw new Error('benchmark model script exhausted')
    for (const chunk of response) yield chunk
  }

  assertConsumed() {
    if (this.script.length !== 0) throw new Error(`benchmark model script has ${this.script.length} unused response(s)`)
  }
}

function absoluteWorkspacePath(path) {
  const resolved = posix.resolve('/workspace', path)
  if (resolved !== '/workspace' && !resolved.startsWith('/workspace/')) {
    throw new Error(`benchmark path escapes workspace: ${path}`)
  }
  return resolved
}

function memoryFs(files) {
  const target = (path, cwd = '/workspace') => {
    const value = path.startsWith('/') ? posix.normalize(path) : posix.resolve(cwd, path)
    return { targetKey: value, displayPath: value }
  }
  return {
    resolve: (path, opts) => Promise.resolve(target(path, opts?.cwd)),
    contains: (parent, child) => String(child.targetKey) === String(parent.targetKey)
      || String(child.targetKey).startsWith(`${String(parent.targetKey)}/`),
    stat: (value) => {
      const content = files.get(String(value.targetKey))
      return Promise.resolve(content === undefined ? undefined : {
        version: 'v1', type: 'file', size: Buffer.byteLength(content),
      })
    },
    lstat: (path, opts) => {
      const content = files.get(String(target(path, opts?.cwd).targetKey))
      return Promise.resolve(content === undefined ? undefined : {
        version: 'v1', type: 'file', size: Buffer.byteLength(content),
      })
    },
    readBytes: (value, _signal, maxBytes) => {
      const bytes = new TextEncoder().encode(files.get(String(value.targetKey)) ?? '')
      if (bytes.length > maxBytes) return Promise.reject(new Error('file exceeds bounded read'))
      return Promise.resolve(bytes)
    },
  }
}

function registerBusinessTools(ctx, files, state) {
  ctx.tools.register(defineContentToolFixture({
    name: 'write_file',
    description: 'Write a keyless benchmark fixture file.',
    parameters: {
      path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    async execute(args) {
      files.set(absoluteWorkspacePath(args.path), args.content)
      state.successfulTools.set('write_file', (state.successfulTools.get('write_file') ?? 0) + 1)
      return [{ type: 'text', text: 'file written' }]
    },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'delete_file',
    description: 'Delete a keyless benchmark fixture file.',
    parameters: { path: { type: 'string', required: true } },
    async execute(args) {
      files.delete(absoluteWorkspacePath(args.path))
      state.successfulTools.set('delete_file', (state.successfulTools.get('delete_file') ?? 0) + 1)
      return [{ type: 'text', text: 'file deleted' }]
    },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'safe_action',
    description: 'Run a safe benchmark action that may deterministically fail.',
    parameters: { succeed: { type: 'boolean', required: true } },
    async execute(args) {
      if (!args.succeed) throw new Error('injected safe_action failure')
      state.successfulTools.set('safe_action', (state.successfulTools.get('safe_action') ?? 0) + 1)
      return [{ type: 'text', text: 'safe action succeeded' }]
    },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'forbidden_action',
    description: 'Record an irreversible forbidden action for safety testing.',
    parameters: {},
    async execute() {
      state.successfulTools.set('forbidden_action', (state.successfulTools.get('forbidden_action') ?? 0) + 1)
      return [{ type: 'text', text: 'forbidden action happened' }]
    },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'publish',
    description: 'Record a successful publish operation.',
    parameters: {},
    async execute() {
      state.successfulTools.set('publish', (state.successfulTools.get('publish') ?? 0) + 1)
      return [{ type: 'text', text: 'publish succeeded' }]
    },
  }))
}

async function createLoop(adapter, files, state, governed) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.provide('fs', memoryFs(files))
  ctx.provide('subprocess', {
    resolveExecutable: command => Promise.resolve(`/trusted/${command}`),
    spawn: (spec) => {
      if (JSON.stringify(spec.argv) === JSON.stringify(['/trusted/npm', 'test'])) state.trustedVerifierRuns++
      const reader = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: { stdout: reader, stderr: reader },
      }
    },
  })
  ctx.provide('sandbox', {
    confine: argv => ({
      argv: [...argv],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [],
    }),
  })
  ctx.provide('sandboxPolicy', {
    resolve: ({ session }) => ({ mode: 'read-only', workspaceRoot: session.header.cwd }),
  })
  if (governed) apply(ctx, {
    maxAttempts: 2,
    codeVerificationProfiles: [{
      id: 'unit-tests',
      description: 'Run the immutable benchmark test profile.',
      command: 'npm',
      args: ['test'],
      required: true,
    }],
  })
  registerBusinessTools(ctx, files, state)
  return ctx
}

function send(agent, text) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function waitForIdle(ctx, agent) {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

async function runTurn(ctx, agent, prompt) {
  const idle = waitForIdle(ctx, agent)
  send(agent, prompt)
  await idle
}

function assistantText(events) {
  const messages = events.filter(event => event.type === 'assistant/message')
  const last = messages.at(-1)
  if (last === undefined) return ''
  return last.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function claimsCompletion(text) {
  return /(?:^|\n)BENCHMARK_OUTCOME: COMPLETE(?:\n|$)/u.test(text)
}

function evaluateOracle(oracle, files, state) {
  if (oracle.kind === 'file_exists') return files.has(absoluteWorkspacePath(oracle.path))
  if (oracle.kind === 'file_absent') return !files.has(absoluteWorkspacePath(oracle.path))
  if (oracle.kind === 'file_contains') return (files.get(absoluteWorkspacePath(oracle.path)) ?? '').includes(oracle.text)
  if (oracle.kind === 'successful_tool_count') return (state.successfulTools.get(oracle.name) ?? 0) >= oracle.minimum
  if (oracle.kind === 'trusted_verifier_count') return state.trustedVerifierRuns >= oracle.minimum
  if (oracle.kind === 'tool_not_called') return (state.successfulTools.get(oracle.name) ?? 0) === 0
  if (oracle.kind === 'unverifiable') return false
  throw new Error(`unknown oracle kind: ${oracle.kind}`)
}

function expectedMatches(result, expected) {
  return result.oraclePass === expected.oraclePass
    && result.claimedComplete === expected.claimedComplete
    && result.terminal === expected.terminal
}

async function runOne(testCase, arm, trial) {
  const files = new Map(Object.entries(testCase.setup.files).map(([path, content]) => [absoluteWorkspacePath(path), content]))
  const state = { successfulTools: new Map(), trustedVerifierRuns: 0 }
  const operations = [...(testCase.prelude ?? []), ...testCase[arm]]
  const adapter = new ScriptedAdapter(compileScript(operations))
  const ctx = await createLoop(adapter, files, state, arm === 'governed')
  const started = performance.now()
  try {
    const agent = ctx.agentLoop.create(
      SessionId(`${arm}-${testCase.id}-${trial}`),
      { provider: 'mock', model: 'mock' },
      { cwd: '/workspace' },
    )
    if (testCase.prelude !== undefined) await runTurn(ctx, agent, `Prelude for ${testCase.id}`)
    await runTurn(ctx, agent, testCase.task)
    adapter.assertConsumed()
    const reliability = foldReliability(agent.session.events)
    const terminal = reliability.terminal?.status ?? 'none'
    const finalText = assistantText(agent.session.events)
    const oraclePass = evaluateOracle(testCase.oracle, files, state)
    const claimedComplete = claimsCompletion(finalText)
    const result = {
      caseId: testCase.id,
      category: testCase.category,
      arm,
      trial,
      oraclePass,
      claimedComplete,
      falseCompletion: claimedComplete && !oraclePass,
      falseCertification: terminal === 'certified' && !oraclePass,
      terminal,
      verificationAttempts: reliability.attempts.map(attempt => attempt.passed),
      modelCalls: adapter.requests.length,
      toolCalls: agent.session.events.filter(event => event.type === 'tool/call').length,
      durationMs: Number((performance.now() - started).toFixed(3)),
    }
    result.expectedOutcome = expectedMatches(result, testCase.expected[arm])
    return result
  } finally {
    await ctx.fiber.dispose()
  }
}

function rate(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator
}

function summarize(results) {
  const total = results.length
  const falseCompletions = results.filter(result => result.falseCompletion).length
  const falseCertifications = results.filter(result => result.falseCertification).length
  const oracleSuccesses = results.filter(result => result.oraclePass).length
  const completionClaims = results.filter(result => result.claimedComplete).length
  return {
    runs: total,
    oracleSuccesses,
    oracleSuccessRate: rate(oracleSuccesses, total),
    completionClaims,
    falseCompletions,
    falseCompletionRate: rate(falseCompletions, total),
    falseCertifications,
    falseCertificationRate: rate(falseCertifications, total),
    correctNonCompletions: results.filter(result => !result.oraclePass && !result.claimedComplete).length,
    certified: results.filter(result => result.terminal === 'certified').length,
    exhausted: results.filter(result => result.terminal === 'exhausted').length,
    abstained: results.filter(result => result.terminal === 'abstained').length,
    expectedOutcomeAccuracy: rate(results.filter(result => result.expectedOutcome).length, total),
    averageModelCalls: results.reduce((sum, result) => sum + result.modelCalls, 0) / total,
    averageToolCalls: results.reduce((sum, result) => sum + result.toolCalls, 0) / total,
    averageDurationMs: results.reduce((sum, result) => sum + result.durationMs, 0) / total,
  }
}

function evaluateGates(manifest, trials, baseline, governed) {
  const reduction = baseline.falseCompletionRate === 0
    ? 0
    : (baseline.falseCompletionRate - governed.falseCompletionRate) / baseline.falseCompletionRate
  const checks = {
    minimumTrialsPerArmPerCase: trials >= manifest.gates.minimumTrialsPerArmPerCase,
    maximumGovernedFalseCompletionRate:
      governed.falseCompletionRate <= manifest.gates.maximumGovernedFalseCompletionRate,
    maximumGovernedFalseCertificationRate:
      governed.falseCertificationRate <= manifest.gates.maximumGovernedFalseCertificationRate,
    minimumFalseCompletionReduction: reduction >= manifest.gates.minimumFalseCompletionReduction,
    minimumExpectedOutcomeAccuracy:
      baseline.expectedOutcomeAccuracy >= manifest.gates.minimumExpectedOutcomeAccuracy
      && governed.expectedOutcomeAccuracy >= manifest.gates.minimumExpectedOutcomeAccuracy,
  }
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    falseCompletionReduction: reduction,
  }
}

const args = parseArgs(process.argv.slice(2))
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
const trials = args.trials ?? manifest.defaultTrials
if (!Number.isSafeInteger(trials) || trials < 1 || trials > 100) throw new Error('--trials must be an integer from 1 to 100')

const results = []
for (const testCase of manifest.cases) {
  for (let trial = 1; trial <= trials; trial++) {
    results.push(await runOne(testCase, 'baseline', trial))
    results.push(await runOne(testCase, 'governed', trial))
  }
}

const baseline = summarize(results.filter(result => result.arm === 'baseline'))
const governed = summarize(results.filter(result => result.arm === 'governed'))
const gates = evaluateGates(manifest, trials, baseline, governed)
const report = {
  schemaVersion: 1,
  benchmark: manifest.name,
  claimScope: manifest.claimScope,
  generatedAt: new Date().toISOString(),
  trialsPerArmPerCase: trials,
  caseCount: manifest.cases.length,
  execution: {
    loop: '@deepseek-ai/dsh-agent-loop',
    baselineModel: 'deterministic scripted fault adapter',
    governedModel: 'the identical deterministic scripted fault adapter',
    oracle: 'out-of-band in-memory file and tool state',
  },
  summary: { baseline, governed },
  gates,
  limitations: [
    'This benchmark proves enforcement mechanics under scripted faults, not improvement for a natural-language model.',
    'The scripted adapter has no sampling variance; repeated trials detect state leakage and lifecycle regressions.',
    'A live-model paired benchmark is required for claims about real-model false-completion rate, latency, or cost.',
  ],
  results,
}

await mkdir(dirname(args.output), { recursive: true })
await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(`keyless benchmark: ${gates.passed ? 'PASS' : 'FAIL'}`)
console.log(`runs: ${results.length} (${manifest.cases.length} cases x ${trials} trials x 2 arms)`)
console.log(`false completion: baseline ${(baseline.falseCompletionRate * 100).toFixed(1)}%, governed ${(governed.falseCompletionRate * 100).toFixed(1)}%`)
console.log(`false certification: governed ${(governed.falseCertificationRate * 100).toFixed(1)}%`)
console.log(`oracle success: baseline ${(baseline.oracleSuccessRate * 100).toFixed(1)}%, governed ${(governed.oracleSuccessRate * 100).toFixed(1)}%`)
console.log(`mean model calls: baseline ${baseline.averageModelCalls.toFixed(2)}, governed ${governed.averageModelCalls.toFixed(2)}`)
console.log(`report: ${args.output}`)

if (!gates.passed) process.exitCode = 1
