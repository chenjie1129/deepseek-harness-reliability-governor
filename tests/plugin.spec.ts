import { describe, expect, it, vi } from 'vitest'
import { posix } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.js'
import { foldReliability } from '../src/types.js'

function fakeFs(files: Record<string, string>) {
  const entries = new Map(Object.entries(files).map(([path, content]) => [`/workspace/${path}`, content]))
  const target = (path: string, cwd = '/workspace'): FsTarget => {
    const value = path.startsWith('/') ? posix.normalize(path) : posix.resolve(cwd, path)
    return { targetKey: value as FsTarget['targetKey'], displayPath: value }
  }
  return {
    resolve: (path: string, opts?: { cwd?: string }) => Promise.resolve(target(path, opts?.cwd)),
    contains: (parent: FsTarget, child: FsTarget) => String(child.targetKey) === String(parent.targetKey)
      || String(child.targetKey).startsWith(`${String(parent.targetKey)}/`),
    stat: (value: FsTarget) => {
      const content = entries.get(String(value.targetKey))
      return Promise.resolve(content === undefined ? undefined : {
        version: 'v1' as never, type: 'file' as const, size: Buffer.byteLength(content),
      })
    },
    lstat: (path: string, opts?: { cwd?: string }) => {
      const content = entries.get(String(target(path, opts?.cwd).targetKey))
      return Promise.resolve(content === undefined ? undefined : {
        version: 'v1' as never, type: 'file' as const, size: Buffer.byteLength(content),
      })
    },
    readBytes: (value: FsTarget, _signal: AbortSignal | undefined, maxBytes: number) => {
      const bytes = new TextEncoder().encode(entries.get(String(value.targetKey)) ?? '')
      if (bytes.length > maxBytes) return Promise.reject(new Error('file exceeds bounded read'))
      return Promise.resolve(bytes)
    },
  } as Pick<FileSystem, 'resolve' | 'contains' | 'stat' | 'lstat' | 'readBytes'>
}

function harness(files: Record<string, string> = {}) {
  const tools: ToolDefinition[] = []
  const sections: Array<{ name: string; text: string }> = []
  const skillProviders: unknown[] = []
  const outputReader = (text: string) => ({
    readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }),
  })
  const resolveExecutable = vi.fn((command: string) => Promise.resolve(`/trusted/${command}`))
  const spawn = vi.fn(() => ({
    done: Promise.resolve({ exitCode: 0, signal: null }),
    collected: { stdout: outputReader('trusted output\n'), stderr: outputReader('') },
  }))
  const confine = vi.fn((argv: readonly string[], policy: unknown) => ({
    argv: [...argv],
    enforcement: 'full' as const,
    denialSignatures: [],
    runnerFailureRules: [],
    policy,
  }))
  let stopping: ((payload: { agent: Agent; turn: number; signal: AbortSignal }) => Promise<void>) | undefined
  const context = {
    fs: fakeFs(files),
    tools: { register: (tool: ToolDefinition) => { tools.push(tool); return () => undefined } },
    systemPrompt: { section: (section: { name: string; text: string }) => { sections.push(section); return () => undefined } },
    skills: {
      registerProvider: (create: (control: { signal: AbortSignal; invalidate: () => void }) => unknown) => {
        skillProviders.push(create({ signal: new AbortController().signal, invalidate: () => undefined }))
        return () => undefined
      },
    },
    subprocess: { resolveExecutable, spawn },
    sandbox: { confine },
    sandboxPolicy: {
      resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/workspace' }),
    },
    on: (name: string, listener: typeof stopping) => {
      if (name === 'agent/turn-stopping') stopping = listener
      return () => undefined
    },
  } as unknown as Context
  return {
    context,
    tools,
    sections,
    skillProviders,
    resolveExecutable,
    spawn,
    confine,
    getStopping: () => stopping,
  }
}

function createSession(id: string) {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, {
    version: 0,
    id: sessionId,
    createdAt: 1_700_000_000_000,
    cwd: '/workspace',
  })
}

function execution(agent: Agent, name: string): ToolRunContext {
  return {
    agent,
    name,
    callId: `${name}-call` as ToolRunContext['callId'],
    rootCallId: `${name}-call` as ToolRunContext['rootCallId'],
    arguments: {},
    signal: new AbortController().signal,
    token: Symbol(name) as ToolRunContext['token'],
    deferContext: () => undefined,
    concludeTurn: () => undefined,
  }
}

function findTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find(item => item.name === name)
  if (tool === undefined) throw new Error(`missing tool ${name}`)
  return tool
}

describe('DeepSeek Harness plugin composition', () => {
  it('registers one policy section, one skill provider, seven tools, and one turn-stopping hook', () => {
    const mounted = harness()
    apply(mounted.context)

    expect(mounted.sections.map(section => section.name)).toEqual(['reliability:policy'])
    expect(mounted.skillProviders).toHaveLength(1)
    expect(mounted.tools.map(tool => tool.name)).toEqual([
      'reliability_begin',
      'reliability_begin_code',
      'reliability_verify',
      'reliability_status',
      'reliability_abstain',
      'reliability_code_profiles',
      'reliability_code_verify',
    ])
    expect(mounted.getStopping()).toBeTypeOf('function')
  })

  it('certifies a passing contract and steers one receipt-bearing final step', async () => {
    const mounted = harness({ 'result.txt': 'READY\n' })
    apply(mounted.context, { maxAttempts: 2 })
    const session = createSession('passing')
    const steer = vi.fn()
    const agent = { session, steer } as unknown as Agent
    await findTool(mounted.tools, 'reliability_begin').execute({
      objective: 'produce result',
      checks: [{ id: 'ready', kind: 'file_contains', path: 'result.txt', text: 'READY' }],
    }, execution(agent, 'reliability_begin'))

    await mounted.getStopping()?.({ agent, turn: 1, signal: new AbortController().signal })

    const state = foldReliability(session.events)
    expect(state.attempts).toHaveLength(1)
    expect(state.terminal?.status).toBe('certified')
    expect(state.terminal?.receipt).toMatch(/^sha256:/)
    expect(steer).toHaveBeenCalledOnce()
    expect(JSON.stringify(steer.mock.calls[0])).toContain(state.terminal?.receipt)
  })

  it('fails closed after the configured repair budget', async () => {
    const mounted = harness()
    apply(mounted.context, { maxAttempts: 1 })
    const session = createSession('failing')
    const steer = vi.fn()
    const agent = { session, steer } as unknown as Agent
    await findTool(mounted.tools, 'reliability_begin').execute({
      objective: 'produce result',
      checks: [{ id: 'missing', kind: 'file_exists', path: 'result.txt' }],
    }, execution(agent, 'reliability_begin'))

    await mounted.getStopping()?.({ agent, turn: 1, signal: new AbortController().signal })

    const state = foldReliability(session.events)
    expect(state.terminal?.status).toBe('exhausted')
    expect(state.terminal?.reason).toContain('missing')
    expect(JSON.stringify(steer.mock.calls[0])).toContain('Do not claim completion')
  })

  it('supports explicit abstention without fabricating proof', async () => {
    const mounted = harness()
    apply(mounted.context)
    const session = createSession('abstain')
    const agent = { session, steer: vi.fn() } as unknown as Agent
    await findTool(mounted.tools, 'reliability_begin').execute({
      objective: 'judge visual quality',
      checks: [{ id: 'clean', kind: 'no_tool_errors' }],
    }, execution(agent, 'reliability_begin'))
    const response = await findTool(mounted.tools, 'reliability_abstain').execute({
      reason: 'requires human visual judgment',
    }, execution(agent, 'reliability_abstain'))

    expect(response).toMatchObject({ status: 'abstained' })
    expect(foldReliability(session.events).terminal?.status).toBe('abstained')
  })

  it('bundles a discoverable coding workflow skill', async () => {
    const mounted = harness()
    apply(mounted.context)
    const provider = mounted.skillProviders[0] as {
      list(): Promise<Array<{ name: string }>>
      get(candidate: unknown): Promise<{ content: string }>
    }
    const candidates = await provider.list()
    expect(candidates.map(candidate => candidate.name)).toEqual(['reliability-code-verification'])
    const skill = await provider.get(candidates[0])
    expect(skill.content).toContain('runtime verifier, not this skill, holds enforcement authority')
  })

  it('enforces immutable configured code profiles and certifies their durable evidence', async () => {
    const mounted = harness()
    apply(mounted.context, {
      maxAttempts: 2,
      codeVerificationProfiles: [{
        id: 'unit-tests',
        description: 'Run the deployment-approved unit test command.',
        command: 'npm',
        args: ['test'],
        sandboxMode: 'read-only',
      }],
    })
    const session = createSession('trusted-code')
    const agent = { session, steer: vi.fn() } as unknown as Agent
    const profileList = await findTool(mounted.tools, 'reliability_code_profiles').execute(
      {},
      execution(agent, 'reliability_code_profiles'),
    )
    expect(JSON.stringify(profileList)).not.toContain('"command"')
    expect(JSON.stringify(profileList)).not.toContain('"args"')

    await findTool(mounted.tools, 'reliability_begin_code').execute({
      objective: 'make the code pass trusted tests',
    }, execution(agent, 'reliability_begin_code'))
    const codeTool = findTool(mounted.tools, 'reliability_code_verify')
    const response = await codeTool.execute({
      profile: 'unit-tests',
      command: 'false',
      args: ['--skip-tests'],
    } as never, execution(agent, 'reliability_code_verify'))

    expect(response).toMatchObject({ status: 'passed' })
    expect(mounted.resolveExecutable).toHaveBeenCalledWith('npm', undefined, expect.any(AbortSignal))
    expect(mounted.confine).toHaveBeenCalledWith(['/trusted/npm', 'test'], expect.objectContaining({
      mode: 'read-only',
      workspaceRoot: '/workspace',
    }))
    expect(mounted.spawn).toHaveBeenCalledWith(expect.objectContaining({
      argv: ['/trusted/npm', 'test'],
      cwd: '/workspace',
    }))
    expect(JSON.stringify(response)).not.toContain('trusted output')

    await findTool(mounted.tools, 'reliability_verify').execute(
      {},
      execution(agent, 'reliability_verify'),
    )
    const state = foldReliability(session.events)
    expect(state.contract?.checks).toContainEqual({
      id: 'code-profile-unit-tests',
      kind: 'code_verification_succeeded',
      profile: 'unit-tests',
    })
    expect(state.terminal?.status).toBe('certified')
    expect(session.events.filter(event => event.type === 'reliability/code-verification')).toHaveLength(1)
  })

  it('rejects missing, duplicate, or invalid trusted profile configuration', () => {
    const mounted = harness()
    expect(() => apply(mounted.context, {
      codeVerificationProfiles: [{ id: 'Bad ID', description: 'bad', command: 'npm' }],
    })).toThrow('kebab-case')
    expect(() => apply(mounted.context, {
      codeVerificationProfiles: [
        { id: 'tests', description: 'first', command: 'npm' },
        { id: 'tests', description: 'second', command: 'node' },
      ],
    })).toThrow('duplicate code verification profile')
  })

  it('fails closed without full sandbox enforcement', async () => {
    const mounted = harness()
    ;(mounted.confine as unknown as { mockReturnValueOnce(value: unknown): void }).mockReturnValueOnce({
      argv: ['/trusted/npm', 'test'],
      enforcement: 'partial',
      denialSignatures: [],
      runnerFailureRules: [],
    })
    apply(mounted.context, {
      codeVerificationProfiles: [{
        id: 'unit-tests',
        description: 'Run tests.',
        command: 'npm',
        args: ['test'],
      }],
    })
    const session = createSession('partial-sandbox')
    const agent = { session, steer: vi.fn() } as unknown as Agent
    const response = await findTool(mounted.tools, 'reliability_code_verify').execute(
      { profile: 'unit-tests' },
      execution(agent, 'reliability_code_verify'),
    )

    expect(response).toMatchObject({
      status: 'failed',
      result: { passed: false, failureKind: 'infrastructure', sandboxEnforcement: 'partial' },
    })
    expect(mounted.spawn).not.toHaveBeenCalled()
  })

  it('refuses a code contract when deployment configured no required profiles', async () => {
    const mounted = harness()
    apply(mounted.context, {
      codeVerificationProfiles: [{
        id: 'optional-lint',
        description: 'Optional lint.',
        command: 'npm',
        args: ['run', 'lint'],
        required: false,
      }],
    })
    const session = createSession('no-required-profile')
    const agent = { session, steer: vi.fn() } as unknown as Agent

    await expect(findTool(mounted.tools, 'reliability_begin_code').execute(
      { objective: 'finish code' },
      execution(agent, 'reliability_begin_code'),
    )).rejects.toThrow('no required trusted code-verification profiles')
  })
})
