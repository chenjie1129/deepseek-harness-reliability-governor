import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import {
  resolveBusinessOutcomeProfiles,
  runBusinessOutcomeProfile,
} from '../src/outcome.js'

function agent(cwd: string): Agent {
  const id = SessionId('real-managed-outcome-profile')
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
  const confine = vi.fn((argv: readonly string[], policy: unknown) => ({
    argv: [...argv],
    enforcement: 'full' as const,
    denialSignatures: [],
    runnerFailureRules: [],
    policy,
  }))
  ctx.provide('sandbox', { confine } as never)
  ctx.provide('sandboxPolicy', {
    resolve: ({ session }: { session: Agent['session'] }) => ({
      mode: 'workspace-write' as const,
      workspaceRoot: session.header.cwd,
    }),
  } as never)
  return { ctx, confine }
}

function profile(args: string[]) {
  return resolveBusinessOutcomeProfiles([{
    id: 'activation-rate',
    description: 'Read the authoritative activation metric.',
    command: process.execPath,
    args,
    metrics: [{ name: 'activation_rate', unit: 'ratio' }],
    target: { id: 'activation', metric: 'activation_rate', operator: 'gte', value: 0.2 },
    minimumSampleSize: 100,
    maxDataAgeMs: 60_000,
    notBeforeMs: 0,
    deadlineMs: 60_000,
    attribution: 'correlational',
  }])[0]!
}

describe('business outcome managed-process integration', () => {
  it('runs a real metric probe through the read-only sandbox seam without persisting raw output', async () => {
    const { ctx, confine } = await context()
    const observedAt = 1_700_000_000_000
    const rawOutput = JSON.stringify({
      dataAsOf: observedAt,
      metrics: { activation_rate: 0.25 },
      sampleSize: 150,
    })
    const selected = profile([
      '-e',
      `process.stdout.write(${JSON.stringify(rawOutput)}); process.stderr.write("PRIVATE_OUTCOME_DIAGNOSTIC")`,
    ])
    try {
      const result = await runBusinessOutcomeProfile(
        ctx,
        agent(process.cwd()),
        selected,
        64_000,
        new AbortController().signal,
        () => observedAt,
      )

      expect(result).toMatchObject({
        succeeded: true,
        exitCode: 0,
        sandboxEnforcement: 'full',
        snapshot: {
          observedAt,
          dataAsOf: observedAt,
          metrics: { activation_rate: 0.25 },
          sampleSize: 150,
        },
        stdout: { bytes: Buffer.byteLength(rawOutput), truncated: false },
        stderr: { bytes: 26, truncated: false },
      })
      expect(confine).toHaveBeenCalledWith(
        [process.execPath, ...selected.args],
        expect.objectContaining({ mode: 'read-only', workspaceRoot: process.cwd() }),
      )
      expect(result.receipt).toMatch(/^sha256:[a-f0-9]{64}$/u)
      expect(JSON.stringify(result)).not.toContain('PRIVATE_OUTCOME_DIAGNOSTIC')
      expect(JSON.stringify(result)).not.toContain(rawOutput)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records invalid real-process output as bounded failed evidence instead of throwing', async () => {
    const { ctx } = await context()
    const selected = profile(['-e', 'process.stdout.write("PRIVATE_INVALID_OUTCOME")'])
    try {
      const result = await runBusinessOutcomeProfile(
        ctx,
        agent(process.cwd()),
        selected,
        64_000,
        new AbortController().signal,
      )

      expect(result).toMatchObject({
        succeeded: false,
        failureKind: 'invalid-output',
        exitCode: 0,
        sandboxEnforcement: 'full',
        stdout: { bytes: 23, truncated: false },
      })
      expect(result.receipt).toMatch(/^sha256:[a-f0-9]{64}$/u)
      expect(JSON.stringify(result)).not.toContain('PRIVATE_INVALID_OUTCOME')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
