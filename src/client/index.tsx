import { useCallback, useMemo, useRef, useState } from 'react'
import { A2uiSurface, MarkdownContext, basicCatalog } from '@a2ui/react/v0_9'
import { MessageProcessor } from '@a2ui/web_core/v0_9'
import {
  REVIEW_APPROVE_LABEL,
  REVIEW_REJECT_LABEL,
  REVIEW_REVISE_LABEL,
  decodeA2uiReviewDetail,
} from '../a2ui.js'
import type { ReliabilityA2uiReviewEnvelope, ReliabilityReviewAction } from '../a2ui.js'

interface QuestionItem {
  id: string
  detail?: string
  options?: Array<{ label: string }>
}

interface QuestionWait {
  kind: 'question'
  key: string
  sessionId: string
  payload: { questions: QuestionItem[] }
  respond(payload: unknown): Promise<{ accepted: boolean; reason?: string }>
}

interface ComposerOwner {
  interactions: Array<{ kind: string }>
}

interface ClientContext {
  slots: {
    inject(name: string, install: () => void): void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
}

export interface MatchedReview {
  wait: QuestionWait
  questionId: string
  envelope: ReliabilityA2uiReviewEnvelope
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Render only the small Markdown decoration the Basic Text component adds; proposal text always stays escaped. */
export function renderReviewMarkdown(markdown: string): Promise<string> {
  const heading = /^(#{1,5}) ([\s\S]*)$/u.exec(markdown)
  const caption = heading === null && markdown.startsWith('*') && markdown.endsWith('*')
    ? markdown.slice(1, -1)
    : undefined
  const content = heading?.[2] ?? caption ?? markdown
  const safe = escapeHtml(content).replaceAll('\n', '<br>')
  return Promise.resolve(heading === null ? safe : `<strong>${safe}</strong>`)
}

function isQuestionWait(value: { kind: string }): value is QuestionWait {
  return value.kind === 'question' && 'payload' in value && 'respond' in value
}

/** Select only a complete governor review request; malformed payloads fall through to the native question UI. */
export function selectA2uiReview({ interactions }: ComposerOwner): MatchedReview | null {
  for (const interaction of interactions) {
    if (!isQuestionWait(interaction)) continue
    if (interaction.payload.questions.length !== 1) continue
    const question = interaction.payload.questions[0]
    if (question?.detail === undefined) continue
    const envelope = decodeA2uiReviewDetail(question.detail)
    if (envelope === undefined) continue
    if (question.id !== `reliability-contract-review:${envelope.proposalReceipt}`) continue
    const labels = question.options?.map(option => option.label) ?? []
    if (labels.length !== 3
      || labels[0] !== REVIEW_APPROVE_LABEL
      || labels[1] !== REVIEW_REVISE_LABEL
      || labels[2] !== REVIEW_REJECT_LABEL) continue
    return { wait: interaction, questionId: question.id, envelope }
  }
  return null
}

interface A2uiAction {
  name: string
  surfaceId: string
  sourceComponentId: string
  context: Record<string, unknown>
}

function decisionFor(action: A2uiAction, proposalReceipt: string): {
  selected: string[]
  custom?: string
} | undefined {
  if (action.context.proposalReceipt !== proposalReceipt) return undefined
  const expected: Record<ReliabilityReviewAction, { source: string; label: string }> = {
    'reliability.contract.approve': { source: 'approve', label: REVIEW_APPROVE_LABEL },
    'reliability.contract.revise': { source: 'revise', label: REVIEW_REVISE_LABEL },
    'reliability.contract.reject': { source: 'reject', label: REVIEW_REJECT_LABEL },
  }
  if (!(action.name in expected)) return undefined
  const match = expected[action.name as ReliabilityReviewAction]
  if (action.sourceComponentId !== match.source) return undefined
  if (action.name !== 'reliability.contract.revise') return { selected: [match.label] }
  const feedback = typeof action.context.feedback === 'string' ? action.context.feedback.trim() : ''
  if (feedback.length > 2_000) return undefined
  return feedback === '' ? { selected: [match.label] } : { selected: [], custom: feedback }
}

function ReviewSurface({ matched }: { matched: MatchedReview }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const settled = useRef(false)

  const answer = useCallback(async (action: A2uiAction): Promise<void> => {
    if (settled.current) return
    if (action.surfaceId !== matched.envelope.surfaceId) {
      setError('The review action did not match this surface.')
      return
    }
    const decision = decisionFor(action, matched.envelope.proposalReceipt)
    if (decision === undefined) {
      setError('The review action was invalid or stale. Nothing was approved.')
      return
    }
    settled.current = true
    setBusy(true)
    setError(null)
    try {
      const receipt = await matched.wait.respond({
        ok: true,
        value: {
          sessionId: matched.wait.sessionId,
          answer: { answers: [{ id: matched.questionId, ...decision }] },
        },
      })
      if (!receipt.accepted) throw new Error(receipt.reason ?? 'response rejected')
    } catch (cause) {
      settled.current = false
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [matched])

  const rendered = useMemo(() => {
    try {
      const processor = new MessageProcessor([basicCatalog], action => answer(action as A2uiAction))
      processor.processMessages(matched.envelope.messages as never)
      const surface = processor.model.surfacesMap.get(matched.envelope.surfaceId)
      return surface === undefined
        ? { error: 'A2UI did not create the expected review surface.' as const }
        : { surface }
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [answer, matched.envelope])

  return <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 20px 12px' }}>
    <div style={{
      background: 'var(--dsw-specific-input-major, #fff)',
      border: '1px solid var(--dsw-alias-state-warn-secondary, #d7a928)',
      borderRadius: 18,
      boxSizing: 'border-box',
      maxHeight: 'min(68vh, 620px)',
      maxWidth: 'var(--dsh-chat-content-width, 860px)',
      overflow: 'auto',
      padding: 14,
      pointerEvents: busy ? 'none' : 'auto',
      opacity: busy ? 0.65 : 1,
      width: '100%',
    }}>
      {'surface' in rendered
        ? <MarkdownContext.Provider value={renderReviewMarkdown}>
            <A2uiSurface surface={rendered.surface} />
          </MarkdownContext.Provider>
        : <div role="alert">A2UI review could not render. Nothing was approved: {rendered.error}</div>}
      {busy ? <div aria-live="polite">Recording your decision…</div> : null}
      {error === null ? null : <div role="alert" style={{ color: 'var(--dsw-alias-state-error-primary, #b42318)' }}>{error}</div>}
    </div>
  </div>
}

function ReviewComposer({ matched }: { matched: MatchedReview }) {
  return <ReviewSurface key={matched.wait.key} matched={matched} />
}

/** Required browser services: the conversation-owned composer chain. */
export const inject = ['slots']

/** Register the A2UI review renderer ahead of the generic question fallback. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    select: selectA2uiReview,
    priority: -10,
  }, ReviewComposer))
}
