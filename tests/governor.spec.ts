import { describe, expect, it } from 'vitest'
import { posix } from 'node:path'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  createContract,
  evaluateContract,
  receiptFor,
} from '../src/governor.js'
import type { ReliabilityContract } from '../src/types.js'

const LIMITS = { maxAttempts: 3, maxChecks: 20, maxFileBytes: 1024 }

function event<T extends string>(seq: number, type: T, data: unknown): SessionEvent {
  return { seq, time: 1_700_000_000_000 + seq, type, data } as unknown as SessionEvent
}

function fakeFs(files: Record<string, string>) {
  const normalized = new Map(Object.entries(files).map(([path, content]) => [`/workspace/${path}`, content]))
  const resolveTarget = (path: string, cwd = '/workspace'): FsTarget => {
    const absolute = path.startsWith('/') ? posix.normalize(path) : posix.resolve(cwd, path)
    return { targetKey: absolute as FsTarget['targetKey'], displayPath: absolute }
  }
  return {
    resolve: (path: string, opts?: { cwd?: string }) => Promise.resolve(resolveTarget(path, opts?.cwd)),
    contains: (parent: FsTarget, child: FsTarget) => String(child.targetKey) === String(parent.targetKey)
      || String(child.targetKey).startsWith(`${String(parent.targetKey)}/`),
    stat: (target: FsTarget) => {
      const content = normalized.get(String(target.targetKey))
      return Promise.resolve(content === undefined ? undefined : {
        version: 'v1' as never,
        type: 'file' as const,
        size: Buffer.byteLength(content),
      })
    },
    lstat: (path: string, opts?: { cwd?: string }) => {
      const target = resolveTarget(path, opts?.cwd)
      const content = normalized.get(String(target.targetKey))
      return Promise.resolve(content === undefined ? undefined : {
        version: 'v1' as never,
        type: 'file' as const,
        size: Buffer.byteLength(content),
      })
    },
    readBytes: (target: FsTarget, _signal: AbortSignal | undefined, maxBytes: number) => {
      const bytes = new TextEncoder().encode(normalized.get(String(target.targetKey)) ?? '')
      if (bytes.length > maxBytes) return Promise.reject(new Error('file exceeds bounded read'))
      return Promise.resolve(bytes)
    },
  } as Pick<FileSystem, 'resolve' | 'contains' | 'stat' | 'lstat' | 'readBytes'>
}

function contract(checks: ReliabilityContract['checks'], startedAtSeq = 0): ReliabilityContract {
  return {
    version: 1,
    contractId: 'contract-1',
    objective: 'prove the outcome',
    checks,
    maxAttempts: 3,
    startedAtSeq,
  }
}

function session(events: readonly SessionEvent[] = []) {
  return {
    events,
    header: { cwd: '/workspace' },
  } as Pick<Session, 'events' | 'header'>
}

describe('reliability governor core', () => {
  it('produces stable content receipts independent of object key order', () => {
    expect(receiptFor('test', { b: 2, a: 1 })).toBe(receiptFor('test', { a: 1, b: 2 }))
    expect(receiptFor('test', { a: 1 })).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('rejects unsafe paths, duplicate ids, empty checks, and oversized budgets', () => {
    expect(() => createContract({ objective: 'x', checks: [] }, 0, LIMITS)).toThrow('at least one')
    expect(() => createContract({
      objective: 'x',
      checks: [{ id: 'x', kind: 'file_exists', path: '../secret' }],
    }, 0, LIMITS)).toThrow('parent-directory')
    expect(() => createContract({
      objective: 'x',
      checks: [
        { id: 'same', kind: 'file_exists', path: 'a' },
        { id: 'same', kind: 'file_absent', path: 'b' },
      ],
    }, 0, LIMITS)).toThrow('duplicate check id')
    expect(() => createContract({
      objective: 'x',
      checks: [{ id: 'x', kind: 'no_tool_errors' }],
      maxAttempts: 4,
    }, 0, LIMITS)).toThrow('1 to 3')
  })

  it('proves file existence, absence, and literal content without executing anything', async () => {
    const results = await evaluateContract(contract([
      { id: 'exists', kind: 'file_exists', path: 'result.txt' },
      { id: 'literal', kind: 'file_contains', path: 'result.txt', text: 'READY' },
      { id: 'absent', kind: 'file_absent', path: 'error.txt' },
    ]), {
      fs: fakeFs({ 'result.txt': 'READY\n' }),
      session: session(),
      maxFileBytes: 1024,
    })

    expect(results.map(item => item.passed)).toEqual([true, true, true])
  })

  it('fails closed when a file is missing, too large, or outside the workspace', async () => {
    const results = await evaluateContract(contract([
      { id: 'missing', kind: 'file_exists', path: 'missing.txt' },
      { id: 'large', kind: 'file_contains', path: 'large.txt', text: 'x' },
    ]), {
      fs: fakeFs({ 'large.txt': 'x'.repeat(50) }),
      session: session(),
      maxFileBytes: 10,
    })

    expect(results.map(item => item.passed)).toEqual([false, false])
    expect(results[1]?.evidence).toContain('verification limit')
  })

  it('correlates successful tool calls and ignores evidence before the contract boundary', async () => {
    const events = [
      event(0, 'tool/call', { turn: 1, step: 1, callId: 'old', name: 'deploy', arguments: '{"target":"old"}' }),
      event(1, 'tool/result', {
        turn: 1,
        step: 1,
        message: { source: { kind: 'tool', callId: 'old' }, content: [{ isError: false }] },
      }),
      event(2, 'reliability/contract', {}),
      event(3, 'tool/call', { turn: 1, step: 2, callId: 'new', name: 'deploy', arguments: '{"target":"prod"}' }),
      event(4, 'tool/result', {
        turn: 1,
        step: 2,
        message: { source: { kind: 'tool', callId: 'new' }, content: [{ isError: false }] },
      }),
    ]
    const results = await evaluateContract(contract([
      { id: 'deploy', kind: 'tool_succeeded', tool: 'deploy', argumentsContain: 'prod' },
      { id: 'never-delete', kind: 'tool_not_called', tool: 'delete_everything' },
      { id: 'clean', kind: 'no_tool_errors' },
    ], 2), {
      fs: fakeFs({}),
      session: session(events),
      maxFileBytes: 1024,
    })

    expect(results.map(item => item.passed)).toEqual([true, true, true])
  })

  it('treats model-facing tool failures as failed evidence', async () => {
    const events = [
      event(1, 'tool/call', { turn: 1, step: 1, callId: 'bad', name: 'deploy', arguments: '{}' }),
      event(2, 'tool/result', {
        turn: 1,
        step: 1,
        message: { source: { kind: 'tool', callId: 'bad' }, content: [{ isError: true }] },
        error: { name: 'DeployError', code: 'FAILED' },
      }),
    ]
    const results = await evaluateContract(contract([
      { id: 'deploy', kind: 'tool_succeeded', tool: 'deploy' },
      { id: 'clean', kind: 'no_tool_errors' },
    ]), {
      fs: fakeFs({}),
      session: session(events),
      maxFileBytes: 1024,
    })

    expect(results.map(item => item.passed)).toEqual([false, false])
  })

  it('accepts only fresh successful trusted code-verification events', async () => {
    const codeResult = (profile: string, passed: boolean) => ({
      version: 1,
      verificationId: `verification-${profile}`,
      profile,
      profileReceipt: 'sha256:profile',
      passed,
      exitCode: passed ? 0 : 1,
      signal: null,
      durationMs: 10,
      sandboxMode: 'read-only',
      sandboxEnforcement: 'full',
      stdout: { bytes: 0, truncated: false, receipt: 'sha256:stdout' },
      stderr: { bytes: 0, truncated: false, receipt: 'sha256:stderr' },
      receipt: 'sha256:result',
    })
    const events = [
      event(1, 'reliability/code-verification', codeResult('tests', true)),
      event(2, 'reliability/contract', {}),
      event(3, 'reliability/code-verification', codeResult('tests', false)),
      event(4, 'reliability/code-verification', codeResult('typecheck', true)),
      event(5, 'reliability/code-verification', codeResult('tests', true)),
    ]
    const results = await evaluateContract(contract([
      { id: 'tests-twice', kind: 'code_verification_succeeded', profile: 'tests', minCount: 2 },
      { id: 'types', kind: 'code_verification_succeeded', profile: 'typecheck' },
    ], 2), {
      fs: fakeFs({}),
      session: session(events),
      maxFileBytes: 1024,
    })

    expect(results.map(item => item.passed)).toEqual([false, true])
    expect(results[0]?.evidence).toContain('1 trusted successful')
  })
})
