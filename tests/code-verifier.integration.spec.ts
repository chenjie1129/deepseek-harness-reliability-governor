import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import {
  resolveCodeVerificationProfiles,
  runCodeVerification,
} from '../src/code-verifier.js'

function agent(cwd: string): Agent {
  const id = SessionId('real-managed-verifier')
  const session = Session.create(id, undefined, {
    version: 0,
    id,
    createdAt: 1_700_000_000_000,
    cwd,
  })
  return { session } as unknown as Agent
}

async function context() {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  ctx.provide('sandbox', {
    confine: (argv: readonly string[]) => ({
      argv: [...argv],
      enforcement: 'full' as const,
      denialSignatures: [],
      runnerFailureRules: [],
    }),
  } as never)
  ctx.provide('sandboxPolicy', {
    resolve: ({ session }: { session: Agent['session'] }) => ({
      mode: 'read-only' as const,
      workspaceRoot: session.header.cwd,
    }),
  } as never)
  return ctx
}

describe('trusted verifier managed-process integration', () => {
  it('runs the exact configured argv and persists only privacy-minimized output evidence', async () => {
    const ctx = await context()
    try {
      const profile = resolveCodeVerificationProfiles([{
        id: 'node-probe',
        description: 'Exercise the managed subprocess seam.',
        command: process.execPath,
        args: ['-e', 'process.stdout.write("PRIVATE_TEST_OUTPUT")'],
      }])[0]!
      const result = await runCodeVerification(
        ctx,
        agent(process.cwd()),
        profile,
        64_000,
        new AbortController().signal,
      )

      expect(result).toMatchObject({
        passed: true,
        exitCode: 0,
        sandboxMode: 'read-only',
        sandboxEnforcement: 'full',
        stdout: { bytes: 19, truncated: false },
      })
      expect(result.receipt).toMatch(/^sha256:[a-f0-9]{64}$/u)
      expect(JSON.stringify(result)).not.toContain('PRIVATE_TEST_OUTPUT')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records a nonzero configured check as failed evidence instead of a tool exception', async () => {
    const ctx = await context()
    try {
      const profile = resolveCodeVerificationProfiles([{
        id: 'failing-probe',
        description: 'Return a deterministic failure.',
        command: process.execPath,
        args: ['-e', 'process.exit(7)'],
      }])[0]!
      const result = await runCodeVerification(
        ctx,
        agent(process.cwd()),
        profile,
        64_000,
        new AbortController().signal,
      )

      expect(result).toMatchObject({ passed: false, failureKind: 'exit', exitCode: 7 })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
