import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import {
  REVIEW_APPROVE_LABEL,
  REVIEW_REJECT_LABEL,
  REVIEW_REVISE_LABEL,
  createA2uiReviewEnvelope,
  encodeA2uiReviewDetail,
} from './a2ui.js'
import type { ReliabilityReviewProposal } from './a2ui.js'
import { receiptFor } from './receipts.js'
import type {
  ReliabilityContractReview,
  ReliabilityContractReviewDecision,
  ReliabilityContractReviewReference,
} from './types.js'

export interface ContractReviewConfig {
  /** Require an exact-contract user decision before activation. */
  mode?: 'required' | 'off'
}

export interface ResolvedContractReviewConfig {
  mode: 'required' | 'off'
}

/** Resolve the small fail-closed contract-review configuration. */
export function resolveContractReviewConfig(input: ContractReviewConfig | undefined): ResolvedContractReviewConfig {
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
    throw new Error('reliability-governor: contractReview must be an object')
  }
  const config = input ?? {}
  const unknown = Object.keys(config).filter(key => key !== 'mode')
  if (unknown.length > 0) {
    throw new Error(`reliability-governor: unknown contractReview key(s): ${unknown.join(', ')}`)
  }
  const mode = config.mode ?? 'required'
  if (mode !== 'required' && mode !== 'off') {
    throw new Error('reliability-governor: contractReview.mode must be required or off')
  }
  return { mode }
}

/** Receipt-bind the exact proposal fields the user will review. */
export function createReviewProposal(
  input: Omit<ReliabilityReviewProposal, 'version' | 'proposalReceipt'>,
): ReliabilityReviewProposal {
  const content = structuredClone(input)
  return {
    version: 1,
    ...content,
    proposalReceipt: receiptFor('reliability-contract-proposal-v1', content),
  }
}

function fallbackMarkdown(proposal: ReliabilityReviewProposal): string {
  const exact = JSON.stringify({
    contractId: proposal.contractId,
    contractKind: proposal.contractKind,
    objective: proposal.objective,
    claims: proposal.claims,
    checks: proposal.checks,
    maxAttempts: proposal.maxAttempts,
    authorship: proposal.authorship,
    coverageAssessment: proposal.coverageAssessment,
    proposalReceipt: proposal.proposalReceipt,
  }, null, 2).split('\n').map(line => `    ${line}`).join('\n')
  return `### Review the evidence contract

Approval authorizes this exact claim, evidence, and repair-budget proposal. It does not certify the future outcome.

${exact}`
}

function answerDecision(answer: AskUserQuestionAnswer, questionId: string): {
  decision: ReliabilityContractReviewDecision
  feedback?: string
} {
  if (answer.answers.length !== 1 || answer.answers[0]?.id !== questionId) return { decision: 'unavailable' }
  const item = answer.answers[0]
  const custom = item.custom?.trim()
  if (custom !== undefined && custom.length > 0) {
    if (custom.length > 2_000) return { decision: 'unavailable' }
    return { decision: 'revision-requested', feedback: custom }
  }
  if (item.selected.length !== 1) return { decision: 'unavailable' }
  if (item.selected[0] === REVIEW_APPROVE_LABEL) return { decision: 'approved' }
  if (item.selected[0] === REVIEW_REVISE_LABEL) return { decision: 'revision-requested' }
  if (item.selected[0] === REVIEW_REJECT_LABEL) return { decision: 'rejected' }
  return { decision: 'unavailable' }
}

function feedbackRecord(feedback: string | undefined): ReliabilityContractReview['feedback'] | undefined {
  if (feedback === undefined) return undefined
  return {
    bytes: new TextEncoder().encode(feedback).byteLength,
    receipt: receiptFor('reliability-contract-review-feedback-v1', feedback),
  }
}

function appendReview(
  agent: Agent,
  proposal: ReliabilityReviewProposal,
  decision: ReliabilityContractReviewDecision,
  feedback?: string,
): ReliabilityContractReview {
  const recordedFeedback = feedbackRecord(feedback)
  const content = {
    version: 1 as const,
    proposalReceipt: proposal.proposalReceipt,
    contractKind: proposal.contractKind,
    decision,
    channel: 'harness-user-questions' as const,
    presentation: 'a2ui-v0.9.1-with-native-fallback' as const,
    ...(recordedFeedback === undefined ? {} : { feedback: recordedFeedback }),
  }
  const review: ReliabilityContractReview = {
    ...content,
    receipt: receiptFor('reliability-contract-review-v1', content),
  }
  agent.session.append('reliability/contract-review', review)
  return review
}

function unavailableDecision(cause: unknown): 'cancelled' | 'unavailable' {
  if (cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ASK_ABORTED') return 'cancelled'
  return 'unavailable'
}

export interface ContractReviewResult {
  review: ReliabilityContractReview
  reference?: ReliabilityContractReviewReference
  feedback?: string
}

/** Ask the exact live root user's UI to approve, revise, or reject one proposal. */
export async function requestContractReview(
  ctx: Context,
  agent: Agent,
  proposal: ReliabilityReviewProposal,
  signal: AbortSignal,
): Promise<ContractReviewResult> {
  const envelope = createA2uiReviewEnvelope(proposal)
  const questionId = `reliability-contract-review:${proposal.proposalReceipt}`
  let decision: ReliabilityContractReviewDecision
  let feedback: string | undefined
  try {
    const answer = await ctx.userQuestions.ask({
      agent,
      signal,
      questions: [{
        id: questionId,
        header: 'Evidence contract',
        question: 'Should this exact evidence contract control completion?',
        detail: encodeA2uiReviewDetail(fallbackMarkdown(proposal), envelope),
        options: [
          { label: REVIEW_APPROVE_LABEL, description: 'Activate only this exact proposal and its repair budget.' },
          { label: REVIEW_REVISE_LABEL, description: 'Return it to the agent without activating a contract.' },
          { label: REVIEW_REJECT_LABEL, description: 'Decline this proposal and keep the task uncertified.' },
        ],
      }],
    })
    const interpreted = answerDecision(answer, questionId)
    decision = interpreted.decision
    feedback = interpreted.feedback
  } catch (cause) {
    decision = unavailableDecision(cause)
  }
  const review = appendReview(agent, proposal, decision, feedback)
  if (decision !== 'approved') {
    return { review, ...(feedback === undefined ? {} : { feedback }) }
  }
  return {
    review,
    reference: {
      version: 1,
      proposalReceipt: proposal.proposalReceipt,
      reviewReceipt: review.receipt,
      channel: review.channel,
      presentation: review.presentation,
    },
  }
}
