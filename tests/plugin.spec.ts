import { describe, expect, it, vi } from 'vitest'
import { posix } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.js'
import { foldReliability } from '../src/types.js'
import type { ReliabilityCheck } from '../src/types.js'

interface ReturnedToolClaim {
  id: string
  statement: string
  importance: 'critical' | 'important' | 'minor'
  verification: 'deterministic' | 'human-required' | 'unsupported'
  check_ids: string[]
  minimum_independent_sources?: number
}

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

function harness(files: Record<string, string> = {}, llmChunks?: unknown[]) {
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
  const llmStream = vi.fn((_options: unknown) => (async function* () {
    if (llmChunks === undefined) throw new Error('unexpected auxiliary model call')
    for (const chunk of llmChunks) yield chunk
  })())
  const askUser = vi.fn((request: { questions: Array<{ id: string }> }) => Promise.resolve({
    answers: [{ id: request.questions[0]?.id ?? '', selected: ['Approve exact contract'] }],
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
    llm: { stream: llmStream },
    userQuestions: { ask: askUser },
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
    llmStream,
    askUser,
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

const readyContract = {
  objective: 'produce result',
  claims: [{
    id: 'result-ready', statement: 'The result contains READY', importance: 'critical' as const,
    verification: 'deterministic' as const, check_ids: ['ready'],
  }],
  checks: [{ id: 'ready', kind: 'file_contains' as const, path: 'result.txt', text: 'READY' }],
}

describe('DeepSeek Harness plugin composition', () => {
  it('registers one policy section, one skill provider, eight tools, and one turn-stopping hook', () => {
    const mounted = harness()
    apply(mounted.context)

    expect(mounted.sections.map(section => section.name)).toEqual(['reliability:policy'])
    expect(mounted.skillProviders).toHaveLength(1)
    expect(mounted.tools.map(tool => tool.name)).toEqual([
      'reliability_assess',
      'reliability_begin',
      'reliability_begin_code',
      'reliability_verify',
      'reliability_status',
      'reliability_abstain',
      'reliability_code_profiles',
      'reliability_code_verify',
    ])
    expect(mounted.getStopping()).toBeTypeOf('function')
    expect(mounted.llmStream).not.toHaveBeenCalled()
  })

  it('preflights claim coverage and refuses to activate a structurally insufficient contract', async () => {
    const mounted = harness()
    apply(mounted.context)
    const session = createSession('coverage-review')
    const agent = { session, steer: vi.fn() } as unknown as Agent
    const input = {
      objective: 'produce independently corroborated output',
      claims: [{
        id: 'correct',
        statement: 'The output is correct',
        importance: 'critical',
        verification: 'deterministic',
        check_ids: ['exists', 'literal'],
        minimum_independent_sources: 2,
      }],
      checks: [
        { id: 'exists', kind: 'file_exists', path: 'result.txt' },
        { id: 'literal', kind: 'file_contains', path: 'result.txt', text: 'READY' },
      ],
    }

    const assessment = await findTool(mounted.tools, 'reliability_assess').execute(
      input,
      execution(agent, 'reliability_assess'),
    )
    const begin = await findTool(mounted.tools, 'reliability_begin').execute(
      input,
      execution(agent, 'reliability_begin'),
    )

    expect(assessment).toMatchObject({ status: 'review-required' })
    expect(begin).toMatchObject({ status: 'review-required' })
    expect(foldReliability(session.events).contract).toBeUndefined()
  })

  it.each([
    { label: 'Request revision', status: 'revision-requested', decision: 'revision-requested' },
    { label: 'Reject contract', status: 'rejected', decision: 'rejected' },
  ])('does not activate when the user chooses $decision', async ({ label, status, decision }) => {
    const mounted = harness()
    mounted.askUser.mockImplementationOnce((request: { questions: Array<{ id: string }> }) => Promise.resolve({
      answers: [{ id: request.questions[0].id, selected: [label] }],
    }))
    apply(mounted.context)
    const session = createSession(`review-${decision}`)
    const agent = { session, steer: vi.fn() } as unknown as Agent

    const result = await findTool(mounted.tools, 'reliability_begin').execute(
      readyContract,
      execution(agent, 'reliability_begin'),
    )

    expect(result).toMatchObject({ status })
    const state = foldReliability(session.events)
    expect(state.latestReview).toMatchObject({ decision })
    expect(state.contract).toBeUndefined()
  })

  it('returns revision feedback without storing its raw text in the durable review event', async () => {
    const mounted = harness()
    apply(mounted.context)
    const session = createSession('review-feedback')
    const agent = { session, steer: vi.fn() } as unknown as Agent
    mounted.askUser.mockImplementationOnce((request: { questions: Array<{ id: string }> }) => Promise.resolve({
      answers: [{ id: request.questions[0].id, selected: [], custom: 'Use a semantic JSON check instead.' }],
    }))

    const result = await findTool(mounted.tools, 'reliability_begin').execute(
      readyContract,
      execution(agent, 'reliability_begin'),
    )
    const serializedEvents = JSON.stringify(session.events)

    expect(result).toMatchObject({
      status: 'revision-requested',
      feedback: 'Use a semantic JSON check instead.',
    })
    expect(serializedEvents).not.toContain('semantic JSON')
    expect(foldReliability(session.events).latestReview?.feedback).toMatchObject({
      bytes: 34,
      receipt: expect.stringMatching(/^sha256:/),
    })
    expect(foldReliability(session.events).contract).toBeUndefined()
  })

  it('fails closed when the review provider is unavailable or returns a malformed decision', async () => {
    for (const mode of ['throw', 'malformed'] as const) {
      const mounted = harness()
      if (mode === 'throw') mounted.askUser.mockRejectedValueOnce(new Error('no UI provider'))
      else mounted.askUser.mockResolvedValueOnce({ answers: [] })
      apply(mounted.context)
      const session = createSession(`review-${mode}`)
      const agent = { session, steer: vi.fn() } as unknown as Agent

      const result = await findTool(mounted.tools, 'reliability_begin').execute(
        readyContract,
        execution(agent, 'reliability_begin'),
      )

      expect(result).toMatchObject({ status: 'review-unavailable' })
      expect(foldReliability(session.events).contract).toBeUndefined()
    }
  })

  it('allows explicit unattended mode without asking a user and records an unreviewed v3 contract', async () => {
    const mounted = harness()
    apply(mounted.context, { contractReview: { mode: 'off' } })
    const session = createSession('review-off')
    const agent = { session, steer: vi.fn() } as unknown as Agent

    const result = await findTool(mounted.tools, 'reliability_begin').execute(
      readyContract,
      execution(agent, 'reliability_begin'),
    )

    expect(result).toMatchObject({ status: 'active', contract: { version: 3 } })
    expect(mounted.askUser).not.toHaveBeenCalled()
    expect(foldReliability(session.events).latestReview).toBeUndefined()
  })

  it('allows only one pending contract review per live agent', async () => {
    const mounted = harness()
    let answer: ((value: { answers: Array<{ id: string; selected: string[] }> }) => void) | undefined
    mounted.askUser.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    apply(mounted.context)
    const session = createSession('single-pending-review')
    const agent = { session, steer: vi.fn() } as unknown as Agent
    const begin = findTool(mounted.tools, 'reliability_begin')

    const first = begin.execute(readyContract, execution(agent, 'reliability_begin'))
    await vi.waitFor(() => expect(mounted.askUser).toHaveBeenCalledOnce())
    await expect(begin.execute(
      readyContract,
      execution(agent, 'reliability_begin'),
    )).rejects.toThrow('contract review is already pending')

    const questionId = (mounted.askUser.mock.calls[0][0] as { questions: Array<{ id: string }> }).questions[0].id
    answer?.({ answers: [{ id: questionId, selected: ['Approve exact contract'] }] })
    await expect(first).resolves.toMatchObject({ status: 'active', contract: { version: 4 } })
    expect(session.events.filter(event => event.type === 'reliability/contract')).toHaveLength(1)
  })

  it('certifies a passing contract and steers one receipt-bearing final step', async () => {
    const mounted = harness({ 'result.txt': 'READY\n' })
    apply(mounted.context, { maxAttempts: 2 })
    const session = createSession('passing')
    const steer = vi.fn()
    const agent = { session, steer } as unknown as Agent
    await findTool(mounted.tools, 'reliability_begin').execute({
      objective: 'produce result',
      claims: [{
        id: 'result-ready', statement: 'The result contains READY', importance: 'critical',
        verification: 'deterministic', check_ids: ['ready'],
      }],
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
      claims: [{
        id: 'result-exists', statement: 'The result file exists', importance: 'critical',
        verification: 'deterministic', check_ids: ['missing'],
      }],
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
      claims: [{
        id: 'clean-run', statement: 'The tool trajectory has no errors', importance: 'critical',
        verification: 'deterministic', check_ids: ['clean'],
      }],
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
    expect(state.contract?.version).toBe(4)
    expect(state.contract?.version === 4 && state.contract.coverageAssessment.status).toBe('ready')
    expect(state.contract?.version === 4 && state.contract.authorship).toEqual({
      version: 1,
      mode: 'current-agent',
      assurance: 'caller-declared',
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

  it('uses one text-only auxiliary call, stores a privacy-minimized draft event, and binds begin to its receipt', async () => {
    const modelJson = JSON.stringify({
      claims: [{
        id: 'result-ready',
        statement: 'The result file exactly matches READY',
        importance: 'critical',
        verification: 'deterministic',
        check_ids: ['exact-result'],
      }],
      checks: [{ id: 'exact-result', kind: 'file_equals', path: 'result.txt', text: 'READY\n' }],
    })
    const mounted = harness({}, [
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'PRIVATE REASONING' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: modelJson } },
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 80 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    apply(mounted.context, {
      contractAuthoring: {
        mode: 'auxiliary-model',
        provider: 'configured-route',
        model: 'contract-model',
        reasoningEffort: 'low',
      },
    })
    expect(mounted.tools.map(tool => tool.name)).toContain('reliability_draft')
    const session = createSession('auxiliary-author')
    const agent = { session, steer: vi.fn() } as unknown as Agent
    const response = await findTool(mounted.tools, 'reliability_draft').execute({
      contract_kind: 'general',
      objective: 'produce exact result',
      context: 'PRIVATE CONTEXT: result.txt is the requested artifact',
    }, execution(agent, 'reliability_draft')) as unknown as {
      status: string
      draft: { objective: string; claims: ReturnedToolClaim[]; checks: ReliabilityCheck[]; draft_receipt: string }
    }

    expect(response.status).toBe('drafted')
    expect(mounted.llmStream).toHaveBeenCalledOnce()
    const request = mounted.llmStream.mock.calls[0]?.[0] as Record<string, unknown>
    expect(request).toMatchObject({
      provider: 'configured-route',
      model: 'contract-model',
      reasoningEffort: 'low',
      tools: [],
      maxTokens: 3_000,
    })
    expect(request).not.toHaveProperty('purpose')
    expect(request).not.toHaveProperty('temperature')
    expect(JSON.stringify(session.events)).not.toContain('PRIVATE CONTEXT')
    expect(JSON.stringify(session.events)).not.toContain('PRIVATE REASONING')
    expect(foldReliability(session.events).latestDraft?.receipt).toBe(response.draft.draft_receipt)

    const begin = findTool(mounted.tools, 'reliability_begin')
    await expect(begin.execute({
      objective: response.draft.objective,
      claims: response.draft.claims,
      checks: response.draft.checks,
    }, execution(agent, 'reliability_begin'))).rejects.toThrow('requires draft_receipt')
    await expect(begin.execute({
      objective: response.draft.objective,
      claims: response.draft.claims,
      checks: [{ ...response.draft.checks[0], path: 'other.txt' }],
      draft_receipt: response.draft.draft_receipt,
    }, execution(agent, 'reliability_begin'))).rejects.toThrow('must exactly match')

    const activated = await begin.execute({
      objective: response.draft.objective,
      claims: response.draft.claims,
      checks: response.draft.checks,
      draft_receipt: response.draft.draft_receipt,
    }, execution(agent, 'reliability_begin'))
    expect(activated).toMatchObject({
      status: 'active',
      contract: {
        version: 4,
        authorship: {
          mode: 'auxiliary-model',
          assurance: 'draft-receipt-bound',
          provider: 'configured-route',
          model: 'contract-model',
          draftReceipt: response.draft.draft_receipt,
        },
      },
    })

    await findTool(mounted.tools, 'reliability_abstain').execute({
      reason: 'close the first contract for replay testing',
    }, execution(agent, 'reliability_abstain'))
    await expect(begin.execute({
      objective: response.draft.objective,
      claims: response.draft.claims,
      checks: response.draft.checks,
      draft_receipt: response.draft.draft_receipt,
    }, execution(agent, 'reliability_begin'))).rejects.toThrow('already been used')
  })

  it('rejects an auxiliary model action instead of executing or recording it', async () => {
    const mounted = harness({}, [
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'call-1', name: 'write_file', arguments: '{"path":"owned"}' },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    apply(mounted.context, {
      contractAuthoring: { mode: 'auxiliary-model', provider: 'route', model: 'author' },
    })
    const session = createSession('auxiliary-action')
    const agent = { session, steer: vi.fn() } as unknown as Agent

    await expect(findTool(mounted.tools, 'reliability_draft').execute({
      contract_kind: 'general',
      objective: 'produce a file',
    }, execution(agent, 'reliability_draft'))).rejects.toThrow('non-text action')
    expect(session.events.filter(event => event.type === 'reliability/contract-draft')).toHaveLength(0)
    expect(foldReliability(session.events).contract).toBeUndefined()
  })

  it('rejects unconfigured verifier profiles authored by the auxiliary model', async () => {
    const mounted = harness({}, [
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'text',
          text: JSON.stringify({
            claims: [{
              id: 'tests', statement: 'Imaginary tests pass', importance: 'critical',
              verification: 'deterministic', check_ids: ['tests'],
            }],
            checks: [{ id: 'tests', kind: 'code_verification_succeeded', profile: 'imaginary-tests' }],
          }),
        },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    apply(mounted.context, {
      contractAuthoring: { mode: 'auxiliary-model', provider: 'route', model: 'author' },
    })
    const session = createSession('auxiliary-profile-allowlist')
    const agent = { session, steer: vi.fn() } as unknown as Agent

    await expect(findTool(mounted.tools, 'reliability_draft').execute({
      contract_kind: 'general',
      objective: 'make tests pass',
    }, execution(agent, 'reliability_draft'))).rejects.toThrow('unconfigured code-verification profile')
    expect(session.events.filter(event => event.type === 'reliability/contract-draft')).toHaveLength(0)
  })

  it('aborts an auxiliary author that exceeds its configured time bound', async () => {
    const mounted = harness()
    mounted.llmStream.mockImplementationOnce((request: unknown) => (async function* () {
      const signal = (request as { signal: AbortSignal }).signal
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    })())
    apply(mounted.context, {
      contractAuthoring: {
        mode: 'auxiliary-model', provider: 'route', model: 'author', timeoutMs: 1,
      },
    })
    const session = createSession('auxiliary-timeout')
    const agent = { session, steer: vi.fn() } as unknown as Agent

    await expect(findTool(mounted.tools, 'reliability_draft').execute({
      contract_kind: 'general',
      objective: 'produce bounded draft',
    }, execution(agent, 'reliability_draft'))).rejects.toThrow('timed out')
    expect(session.events.filter(event => event.type === 'reliability/contract-draft')).toHaveLength(0)
  })

  it('keeps manual mode model-free and labels its provenance as caller-declared', async () => {
    const mounted = harness()
    apply(mounted.context, { contractAuthoring: { mode: 'manual' } })
    expect(mounted.tools.map(tool => tool.name)).not.toContain('reliability_draft')
    expect(mounted.sections[0]?.text).toContain('not authenticated human approval')
    const session = createSession('manual-author')
    const agent = { session, steer: vi.fn() } as unknown as Agent
    const response = await findTool(mounted.tools, 'reliability_begin').execute({
      objective: 'use a reviewed contract',
      claims: [{
        id: 'artifact', statement: 'The artifact exists', importance: 'critical',
        verification: 'deterministic', check_ids: ['artifact'],
      }],
      checks: [{ id: 'artifact', kind: 'file_exists', path: 'artifact.txt' }],
    }, execution(agent, 'reliability_begin'))

    expect(response).toMatchObject({
      status: 'active',
      contract: { authorship: { mode: 'manual', assurance: 'caller-declared' } },
    })
    expect(mounted.llmStream).not.toHaveBeenCalled()
  })

  it('injects required code profiles into an auxiliary code draft before receipt binding', async () => {
    const modelJson = JSON.stringify({
      claims: [{
        id: 'artifact', statement: 'The implementation file exists', importance: 'critical',
        verification: 'deterministic', check_ids: ['artifact'],
      }],
      checks: [{ id: 'artifact', kind: 'file_exists', path: 'src/index.ts' }],
    })
    const mounted = harness({}, [
      { type: 'block-end', index: 0, block: { type: 'text', text: modelJson } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    apply(mounted.context, {
      contractAuthoring: { mode: 'auxiliary-model', provider: 'route', model: 'author' },
      codeVerificationProfiles: [{
        id: 'unit-tests', description: 'Run trusted tests.', command: 'npm', args: ['test'], required: true,
      }],
    })
    const session = createSession('auxiliary-code')
    const agent = { session, steer: vi.fn() } as unknown as Agent
    const response = await findTool(mounted.tools, 'reliability_draft').execute({
      contract_kind: 'code',
      objective: 'implement the requested code change',
    }, execution(agent, 'reliability_draft')) as unknown as {
      draft: {
        contract_kind: 'code'
        objective: string
        claims: ReturnedToolClaim[]
        checks: ReliabilityCheck[]
        draft_receipt: string
      }
    }

    expect(response.draft.contract_kind).toBe('code')
    expect(response.draft.checks).toContainEqual({
      id: 'code-profile-unit-tests', kind: 'code_verification_succeeded', profile: 'unit-tests',
    })
    expect(response.draft.claims).toContainEqual(expect.objectContaining({
      id: 'required-code-verification', check_ids: ['code-profile-unit-tests'],
    }))
    const activated = await findTool(mounted.tools, 'reliability_begin_code').execute({
      objective: response.draft.objective,
      claims: response.draft.claims,
      checks: response.draft.checks,
      draft_receipt: response.draft.draft_receipt,
    }, execution(agent, 'reliability_begin_code'))
    expect(activated).toMatchObject({
      status: 'active',
      requiredProfiles: ['unit-tests'],
      contract: {
        version: 4,
        authorship: { mode: 'auxiliary-model', draftReceipt: response.draft.draft_receipt },
      },
    })
  })
})
