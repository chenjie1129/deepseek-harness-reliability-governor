import { describe, expect, it } from 'vitest'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import LlmRuntime, {
  CallId,
  createUserMessage,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.js'
import { foldReliability } from '../src/types.js'

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(rawCallId: string, name: string, args: object): StreamChunk[] {
  const id = CallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.script.shift()
    if (response === undefined) throw new Error('script exhausted')
    for (const chunk of response) yield chunk
  }
}

function memoryFs(files: Map<string, string>) {
  const target = (path: string, cwd = '/workspace'): FsTarget => {
    const value = path.startsWith('/') ? posix.normalize(path) : posix.resolve(cwd, path)
    return { targetKey: value as FsTarget['targetKey'], displayPath: value }
  }
  return {
    resolve: (path: string, opts?: { cwd?: string }) => Promise.resolve(target(path, opts?.cwd)),
    contains: (parent: FsTarget, child: FsTarget) => String(child.targetKey) === String(parent.targetKey)
      || String(child.targetKey).startsWith(`${String(parent.targetKey)}/`),
    stat: (value: FsTarget) => {
      const content = files.get(String(value.targetKey))
      return Promise.resolve(content === undefined ? undefined : {
        version: 'v1' as never, type: 'file' as const, size: Buffer.byteLength(content),
      })
    },
    lstat: (path: string, opts?: { cwd?: string }) => {
      const content = files.get(String(target(path, opts?.cwd).targetKey))
      return Promise.resolve(content === undefined ? undefined : {
        version: 'v1' as never, type: 'file' as const, size: Buffer.byteLength(content),
      })
    },
    readBytes: (value: FsTarget, _signal: AbortSignal | undefined, maxBytes: number) => {
      const bytes = new TextEncoder().encode(files.get(String(value.targetKey)) ?? '')
      if (bytes.length > maxBytes) return Promise.reject(new Error('file exceeds bounded read'))
      return Promise.resolve(bytes)
    },
  } as Pick<FileSystem, 'resolve' | 'contains' | 'stat' | 'lstat' | 'readBytes'>
}

async function loopHarness(adapter: ScriptedAdapter, files: Map<string, string>, governed: boolean) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  if (governed) {
    ctx.provide('fs', memoryFs(files) as FileSystem)
    apply(ctx, { maxAttempts: 2 })
    ctx.tools.register(defineContentToolFixture({
      name: 'make_file',
      description: 'Create a fixture file.',
      parameters: { path: { type: 'string', required: true }, content: { type: 'string', required: true } },
      async execute(args) {
        files.set(posix.resolve('/workspace', args.path), args.content)
        return [{ type: 'text', text: 'file created' }]
      },
    }))
  }
  return ctx
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe('real Harness agent-loop behavior', () => {
  it('turns a false completion into bounded repair and certified completion', async () => {
    const baselineFiles = new Map<string, string>()
    const baselineAdapter = new ScriptedAdapter([textResponse('Done.')])
    const baseline = await loopHarness(baselineAdapter, baselineFiles, false)
    try {
      const agent = baseline.agentLoop.create(SessionId('baseline'), { provider: 'mock', model: 'mock' }, { cwd: '/workspace' })
      send(agent, 'Create result.txt')
      await waitForIdle(baseline, agent)
      expect(baselineAdapter.requests).toHaveLength(1)
      expect(baselineFiles.has('/workspace/result.txt')).toBe(false)
      expect(agent.session.events.some(event => event.type === 'assistant/message')).toBe(true)
    } finally {
      await baseline.fiber.dispose()
    }

    const governedFiles = new Map<string, string>()
    const governedAdapter = new ScriptedAdapter([
      toolCallResponse('begin', 'reliability_begin', {
        objective: 'Create result.txt',
        checks: [{ id: 'artifact', kind: 'file_exists', path: 'result.txt' }],
        max_attempts: 2,
      }),
      textResponse('Done.'),
      toolCallResponse('repair', 'make_file', { path: 'result.txt', content: 'READY\n' }),
      textResponse('Repaired.'),
      textResponse('Verified and complete.'),
    ])
    const governed = await loopHarness(governedAdapter, governedFiles, true)
    try {
      const agent = governed.agentLoop.create(SessionId('governed'), { provider: 'mock', model: 'mock' }, { cwd: '/workspace' })
      send(agent, 'Create result.txt reliably')
      await waitForIdle(governed, agent)

      const state = foldReliability(agent.session.events)
      expect(governedAdapter.requests).toHaveLength(5)
      expect(governedFiles.get('/workspace/result.txt')).toBe('READY\n')
      expect(state.attempts.map(attempt => attempt.passed)).toEqual([false, true])
      expect(state.terminal?.status).toBe('certified')
      const pluginMessages = agent.session.events.filter(event =>
        event.type === 'user/message' && event.data.source.kind === 'plugin')
      expect(pluginMessages).toHaveLength(2)
      expect(JSON.stringify(pluginMessages[0])).toContain('Repair only these failed checks')
      expect(JSON.stringify(pluginMessages[1])).toContain('Reliability contract certified')
    } finally {
      await governed.fiber.dispose()
    }
  })

  it('certifies 20/20 repeated scripted trials with the same fail-repair-pass trajectory', async () => {
    const trialCount = 20
    const files = new Map<string, string>()
    const script = Array.from({ length: trialCount }, (_, index) => {
      const path = `result-${index}.txt`
      return [
        toolCallResponse(`begin-${index}`, 'reliability_begin', {
          objective: `Create ${path}`,
          checks: [{ id: 'artifact', kind: 'file_exists', path }],
          max_attempts: 2,
        }),
        textResponse('Done.'),
        toolCallResponse(`repair-${index}`, 'make_file', { path, content: 'READY\n' }),
        textResponse('Repaired.'),
        textResponse('Verified and complete.'),
      ]
    }).flat()
    const adapter = new ScriptedAdapter(script)
    const ctx = await loopHarness(adapter, files, true)
    const outcomes: string[] = []
    try {
      for (let index = 0; index < trialCount; index++) {
        const path = `result-${index}.txt`
        const agent = ctx.agentLoop.create(SessionId(`repeated-${index}`), { provider: 'mock', model: 'mock' }, { cwd: '/workspace' })
        send(agent, `Create ${path} reliably`)
        await waitForIdle(ctx, agent)
        const state = foldReliability(agent.session.events)
        outcomes.push(state.terminal?.status ?? 'missing')
        expect(state.attempts.map(attempt => attempt.passed)).toEqual([false, true])
        expect(files.get(`/workspace/${path}`)).toBe('READY\n')
      }
    } finally {
      await ctx.fiber.dispose()
    }

    expect(outcomes.filter(outcome => outcome === 'certified')).toHaveLength(trialCount)
    expect(adapter.requests).toHaveLength(trialCount * 5)
  })
})
