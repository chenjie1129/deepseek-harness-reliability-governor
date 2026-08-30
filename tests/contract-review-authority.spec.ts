import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createReviewProposal, requestContractReview } from '../src/contract-review.js'
import { REVIEW_APPROVE_LABEL } from '../src/a2ui.js'
import { INTENT_APPROVE_LABEL } from '../src/a2ui.js'
import {
  createIntent,
  createIntentReviewProposal,
  requestIntentReview,
} from '../src/intent-review.js'

type TestQuestionRequest = { questions: Array<{ id: string }> }
type TestAnswer = { answers: Array<{ id: string; selected?: string[] }> }

function registerTestAnswerer(
  ctx: Context,
  ask: (request: TestQuestionRequest) => Promise<TestAnswer>,
): void {
  const service = ctx.userQuestions as unknown as {
    registerProvider?: (provider: { ask: typeof ask }) => void
  }
  if (service.registerProvider !== undefined) {
    service.registerProvider({ ask })
    return
  }
  const on = ctx.on as unknown as (
    name: string,
    listener: (request: TestQuestionRequest) => Promise<TestAnswer>,
  ) => void
  on('user-questions/request', ask)
}

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
  const intentProposal = createIntentReviewProposal(createIntent('produce result', {
    constraints: [], assumptions: [], non_goals: [], ambiguities: [],
  }, 'current-agent'))
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
    intent: {
      ...intentProposal.intent,
      proposalReceipt: intentProposal.proposalReceipt,
      reviewReceipt: 'sha256:intent-review',
      channel: 'harness-user-questions',
      presentation: 'a2ui-v0.9.1-with-native-fallback',
    },
  })
}

describe('Harness user-question authority boundary', () => {
  it('accepts and receipt-binds the interpreted intent for the exact live root', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const root = agent('intent-root')
    ctx.agents.enter(root, undefined)
    const ask = vi.fn(async (request: { questions: Array<{ id: string }> }) => ({
      answers: [{ id: request.questions[0].id, selected: [INTENT_APPROVE_LABEL] }],
    }))
    registerTestAnswerer(ctx, ask)
    const reviewed = createIntentReviewProposal(createIntent('preserve requested behavior', {
      constraints: ['Do not change the API.'], assumptions: [], non_goals: [], ambiguities: [],
    }, 'current-agent'))

    const result = await requestIntentReview(ctx, root, reviewed, new AbortController().signal)

    expect(result).toMatchObject({
      review: { decision: 'approved', proposalReceipt: reviewed.proposalReceipt },
      approvedIntent: { proposalReceipt: reviewed.proposalReceipt, reviewReceipt: result.review.receipt },
    })
    await ctx.fiber.dispose()
  })

  it('cannot ask for intent approval on behalf of a delegated child', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const root = agent('intent-authority-root')
    const child = agent('intent-authority-child')
    ctx.agents.enter(root, undefined)
    ctx.agents.enter(child, root)
    const ask = vi.fn(async () => ({ answers: [] }))
    registerTestAnswerer(ctx, ask)
    const reviewed = createIntentReviewProposal(createIntent('change the workspace', {
      constraints: [], assumptions: [], non_goals: [], ambiguities: [],
    }, 'current-agent'))

    const result = await requestIntentReview(ctx, child, reviewed, new AbortController().signal)

    expect(result.review.decision).toBe('unavailable')
    expect(result.approvedIntent).toBeUndefined()
    expect(ask).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('accepts the provider decision for the exact live root and receipt-binds it', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const root = agent('review-root')
    ctx.agents.enter(root, undefined)
    const ask = vi.fn(async (request: { questions: Array<{ id: string }> }) => ({
      answers: [{ id: request.questions[0].id, selected: [REVIEW_APPROVE_LABEL] }],
    }))
    registerTestAnswerer(ctx, ask)
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
    registerTestAnswerer(ctx, ask)

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
    registerTestAnswerer(ctx, ask)
    const controller = new AbortController()
    controller.abort()

    const result = await requestContractReview(ctx, root, proposal(), controller.signal)

    expect(result.review.decision).toBe('cancelled')
    expect(result.reference).toBeUndefined()
    expect(ask).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
