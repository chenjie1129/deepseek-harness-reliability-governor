import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import {
  INTENT_APPROVE_LABEL,
  INTENT_REJECT_LABEL,
  INTENT_REVISE_LABEL,
  createA2uiIntentReviewEnvelope,
  encodeA2uiReviewDetail,
} from './a2ui.js'
import type { ReliabilityIntentReviewProposal } from './a2ui.js'
import { receiptFor } from './receipts.js'
import type {
  ReliabilityApprovedIntent,
  ReliabilityContractAuthoringMode,
  ReliabilityIntent,
  ReliabilityIntentReview,
  ReliabilityReviewDecision,
} from './types.js'

export interface ToolIntentInput {
  constraints?: string[]
  assumptions?: string[]
  non_goals?: string[]
  ambiguities?: string[]
}

const MAX_OBJECTIVE_BYTES = 4 * 1024
const MAX_ITEM_BYTES = 2 * 1024
const MAX_ITEMS_PER_GROUP = 20
const MAX_INTENT_BYTES = 24 * 1024

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function normalizeText(value: string, label: string, maxBytes: number): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`reliability-governor: ${label} must be non-empty`)
  if (byteLength(normalized) > maxBytes) {
    throw new Error(`reliability-governor: ${label} exceeds ${maxBytes} UTF-8 bytes`)
  }
  return normalized
}

function normalizeGroup(value: string[] | undefined, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`reliability-governor: intent.${label} must be a string array`)
  }
  if (value.length > MAX_ITEMS_PER_GROUP) {
    throw new Error(`reliability-governor: intent.${label} must contain at most ${MAX_ITEMS_PER_GROUP} items`)
  }
  const normalized = value.map((item, index) => normalizeText(
    item,
    `intent.${label}[${index}]`,
    MAX_ITEM_BYTES,
  ))
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`reliability-governor: intent.${label} contains duplicate items`)
  }
  return normalized
}

/** Normalize and bound the semantic interpretation before it is shown to a user. */
export function createIntent(
  objective: string,
  input: ToolIntentInput | undefined,
  contractAuthoringMode: ReliabilityContractAuthoringMode,
): ReliabilityIntent {
  if (input === undefined || input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('reliability-governor: intent is required when contract review is enabled')
  }
  const unknown = Object.keys(input).filter(key => ![
    'constraints', 'assumptions', 'non_goals', 'ambiguities',
  ].includes(key))
  if (unknown.length > 0) throw new Error(`reliability-governor: unknown intent key(s): ${unknown.join(', ')}`)
  const intent: ReliabilityIntent = {
    version: 1,
    objective: normalizeText(objective, 'objective', MAX_OBJECTIVE_BYTES),
    constraints: normalizeGroup(input.constraints, 'constraints'),
    assumptions: normalizeGroup(input.assumptions, 'assumptions'),
    nonGoals: normalizeGroup(input.non_goals, 'non_goals'),
    ambiguities: normalizeGroup(input.ambiguities, 'ambiguities'),
    authorship: {
      version: 1,
      mode: contractAuthoringMode === 'manual' ? 'manual' : 'current-agent',
      assurance: 'caller-declared',
    },
  }
  if (byteLength(JSON.stringify(intent)) > MAX_INTENT_BYTES) {
    throw new Error(`reliability-governor: interpreted intent exceeds ${MAX_INTENT_BYTES} UTF-8 bytes`)
  }
  return intent
}

/** Receipt-bind the exact semantic interpretation presented to the user. */
export function createIntentReviewProposal(intent: ReliabilityIntent): ReliabilityIntentReviewProposal {
  const content = structuredClone(intent)
  return {
    version: 1,
    intent: content,
    proposalReceipt: receiptFor('reliability-intent-proposal-v1', content),
  }
}

function fallbackMarkdown(proposal: ReliabilityIntentReviewProposal): string {
  const exact = JSON.stringify({
    intent: proposal.intent,
    proposalReceipt: proposal.proposalReceipt,
  }, null, 2).split('\n').map(line => `    ${line}`).join('\n')
  return `### Review the interpreted intent

Confirm what the agent believes you requested. Approval does not approve an evidence contract or certify an outcome.

${exact}`
}

function answerDecision(answer: AskUserQuestionAnswer, questionId: string): {
  decision: ReliabilityReviewDecision
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
  if (item.selected[0] === INTENT_APPROVE_LABEL) return { decision: 'approved' }
  if (item.selected[0] === INTENT_REVISE_LABEL) return { decision: 'revision-requested' }
  if (item.selected[0] === INTENT_REJECT_LABEL) return { decision: 'rejected' }
  return { decision: 'unavailable' }
}

function feedbackRecord(feedback: string | undefined): ReliabilityIntentReview['feedback'] | undefined {
  if (feedback === undefined) return undefined
  return {
    bytes: byteLength(feedback),
    receipt: receiptFor('reliability-intent-review-feedback-v1', feedback),
  }
}

function appendReview(
  agent: Agent,
  proposal: ReliabilityIntentReviewProposal,
  decision: ReliabilityReviewDecision,
  feedback?: string,
): ReliabilityIntentReview {
  const recordedFeedback = feedbackRecord(feedback)
  const content = {
    version: 1 as const,
    proposalReceipt: proposal.proposalReceipt,
    decision,
    channel: 'harness-user-questions' as const,
    presentation: 'a2ui-v0.9.1-with-native-fallback' as const,
    ...(recordedFeedback === undefined ? {} : { feedback: recordedFeedback }),
  }
  const review: ReliabilityIntentReview = {
    ...content,
    receipt: receiptFor('reliability-intent-review-v1', content),
  }
  agent.session.append('reliability/intent-review', review)
  return review
}

function unavailableDecision(cause: unknown): 'cancelled' | 'unavailable' {
  if (cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ASK_ABORTED') return 'cancelled'
  return 'unavailable'
}

export interface IntentReviewResult {
  review: ReliabilityIntentReview
  approvedIntent?: ReliabilityApprovedIntent
  feedback?: string
}

/** Ask the exact live root user to approve, revise, or reject one interpreted intent. */
export async function requestIntentReview(
  ctx: Context,
  agent: Agent,
  proposal: ReliabilityIntentReviewProposal,
  signal: AbortSignal,
): Promise<IntentReviewResult> {
  const envelope = createA2uiIntentReviewEnvelope(proposal)
  const questionId = `reliability-intent-review:${proposal.proposalReceipt}`
  let decision: ReliabilityReviewDecision
  let feedback: string | undefined
  try {
    const answer = await ctx.userQuestions.ask({
      agent,
      signal,
      questions: [{
        id: questionId,
        header: 'Interpreted intent',
        question: 'Did the agent understand your requested outcome correctly?',
        detail: encodeA2uiReviewDetail(fallbackMarkdown(proposal), envelope),
        options: [
          { label: INTENT_APPROVE_LABEL, description: 'Accept this exact objective, constraints, assumptions, and non-goals.' },
          { label: INTENT_REVISE_LABEL, description: 'Return corrections to the agent; no contract will be reviewed.' },
          { label: INTENT_REJECT_LABEL, description: 'Reject this interpretation and keep the task uncertified.' },
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
    approvedIntent: {
      ...proposal.intent,
      proposalReceipt: proposal.proposalReceipt,
      reviewReceipt: review.receipt,
      channel: review.channel,
      presentation: review.presentation,
    },
  }
}
