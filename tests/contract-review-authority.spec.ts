import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createReviewProposal, requestContractReview } from '../src/contract-review.js'
import { REVIEW_APPROVE_LABEL } from '../src/a2ui.js'

function session(id: string) {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, {
    version: 0,
    id: sessionId,
    createdAt: 1_700_000_000_000,
    cwd: '/workspace',
  })
}

function agent(id: string): Agent {
  const value = session(id)
  return { id: value.id, session: value } as unknown as Agent
}

function proposal() {
  return createReviewProposal({
    contractId: 'contract-authority-1',
    contractKind: 'general',
    objective: 'produce result',
    claims: [{
      id: 'result', statement: 'result exists', importance: 'critical',
      verification: 'deterministic', checkIds: ['result'],
    }],
    checks: [{ id: 'result', kind: 'file_exists', path: 'result.txt' }],
    maxAttempts: 2,
    authorship: { version: 1, mode: 'current-agent', assurance: 'caller-declared' },
    coverageAssessment: {
      version: 1,
      status: 'ready',
      claims: [{
        claimId: 'result', importance: 'critical', verification: 'deterministic',
        supportingCheckIds: ['result'], evidenceSources: ['file:result.txt'],
        requiredIndependentSources: 1, sufficient: true,
      }],
      coverage: {
        critical: { covered: 1, total: 1, percent: 100 },
        weighted: { coveredWeight: 5, totalWeight: 5, percent: 100 },
      },
      evidence: { checkCount: 1, usedCheckCount: 1, independentSourceCount: 1, orphanCheckIds: [] },
      findings: [],
      receipt: 'sha256:coverage',
    },
  })
}

describe('Harness user-question authority boundary', () => {
  it('accepts the provider decision for the exact live root and receipt-binds it', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const root = agent('review-root')
    ctx.agents.enter(root, undefined)
    const ask = vi.fn(async (request: { questions: Array<{ id: string }> }) => ({
      answers: [{ id: request.questions[0].id, selected: [REVIEW_APPROVE_LABEL] }],
    }))
    ctx.userQuestions.registerProvider({ ask })
    const reviewed = proposal()

    const result = await requestContractReview(ctx, root, reviewed, new AbortController().signal)

    expect(ask).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      review: { decision: 'approved', proposalReceipt: reviewed.proposalReceipt },
      reference: { proposalReceipt: reviewed.proposalReceipt },
    })
    expect(result.reference?.reviewReceipt).toBe(result.review.receipt)
    await ctx.fiber.dispose()
  })

  it('cannot ask on behalf of a delegated child and fails closed before the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const root = agent('authority-root')
    const child = agent('authority-child')
    ctx.agents.enter(root, undefined)
    ctx.agents.enter(child, root)
    const ask = vi.fn(async () => ({ answers: [] }))
    ctx.userQuestions.registerProvider({ ask })

    const result = await requestContractReview(ctx, child, proposal(), new AbortController().signal)

    expect(result.review.decision).toBe('unavailable')
    expect(result.reference).toBeUndefined()
    expect(ask).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('records an aborted review as cancelled and never calls the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const root = agent('cancelled-root')
    ctx.agents.enter(root, undefined)
    const ask = vi.fn(async () => ({ answers: [] }))
    ctx.userQuestions.registerProvider({ ask })
    const controller = new AbortController()
    controller.abort()

    const result = await requestContractReview(ctx, root, proposal(), controller.signal)

    expect(result.review.decision).toBe('cancelled')
    expect(result.reference).toBeUndefined()
    expect(ask).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
