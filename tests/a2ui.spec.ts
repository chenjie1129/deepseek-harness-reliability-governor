import { describe, expect, it } from 'vitest'
import { basicCatalog } from '@a2ui/react/v0_9'
import { MessageProcessor } from '@a2ui/web_core/v0_9'
import {
  A2UI_BASIC_CATALOG,
  A2UI_MIME_TYPE,
  A2UI_SPEC_VERSION,
  REVIEW_APPROVE_LABEL,
  REVIEW_REJECT_LABEL,
  REVIEW_REVISE_LABEL,
  createA2uiReviewEnvelope,
  decodeA2uiReviewDetail,
  encodeA2uiReviewDetail,
} from '../src/a2ui.js'
import { createReviewProposal } from '../src/contract-review.js'
import { renderReviewMarkdown, selectA2uiReview } from '../src/client/index.js'

function proposal(overrides: { objective?: string; maxAttempts?: number } = {}) {
  return createReviewProposal({
    contractId: 'contract-test-1',
    contractKind: 'general',
    objective: overrides.objective ?? 'write a verified result',
    claims: [{
      id: 'result-ready',
      statement: 'result.txt exactly contains READY',
      importance: 'critical',
      verification: 'deterministic',
      checkIds: ['exact-result'],
    }],
    checks: [{ id: 'exact-result', kind: 'file_equals', path: 'result.txt', text: 'READY\n' }],
    maxAttempts: overrides.maxAttempts ?? 2,
    authorship: { version: 1, mode: 'current-agent', assurance: 'caller-declared' },
    coverageAssessment: {
      version: 1,
      status: 'ready',
      claims: [{
        claimId: 'result-ready',
        importance: 'critical',
        verification: 'deterministic',
        supportingCheckIds: ['exact-result'],
        evidenceSources: ['file:result.txt'],
        requiredIndependentSources: 1,
        sufficient: true,
      }],
      coverage: {
        critical: { covered: 1, total: 1, percent: 100 },
        weighted: { coveredWeight: 5, totalWeight: 5, percent: 100 },
      },
      evidence: {
        checkCount: 1,
        usedCheckCount: 1,
        independentSourceCount: 1,
        orphanCheckIds: [],
      },
      findings: [{
        code: 'declared_claims_only',
        severity: 'warning',
        message: 'Coverage applies only to the claims declared in this proposal.',
      }],
      receipt: 'sha256:coverage',
    },
  })
}

describe('fixed A2UI contract review surface', () => {
  it('round-trips the exact fixed-catalog proposal through the native fallback', () => {
    const reviewed = proposal()
    const envelope = createA2uiReviewEnvelope(reviewed)
    const detail = encodeA2uiReviewDetail('Readable native fallback', envelope)
    const decoded = decodeA2uiReviewDetail(detail)

    expect(decoded).toEqual(envelope)
    expect(decoded?.mimeType).toBe(A2UI_MIME_TYPE)
    expect(decoded?.specVersion).toBe(A2UI_SPEC_VERSION)
    expect(decoded?.proposalReceipt).toBe(reviewed.proposalReceipt)
    expect(decoded?.messages[0]).toMatchObject({ createSurface: { catalogId: A2UI_BASIC_CATALOG } })
    expect(detail).toContain('Readable native fallback')
    expect(JSON.stringify(envelope)).toContain(REVIEW_APPROVE_LABEL)
    expect(JSON.stringify(envelope)).toContain(REVIEW_REVISE_LABEL)
    expect(JSON.stringify(envelope)).toContain(REVIEW_REJECT_LABEL)

    const processor = new MessageProcessor([basicCatalog], () => undefined)
    expect(() => processor.processMessages(envelope.messages as never)).not.toThrow()
    expect(processor.model.surfacesMap.has(envelope.surfaceId)).toBe(true)
  })

  it('changes the proposal receipt when a reviewed control changes', () => {
    expect(proposal({ maxAttempts: 1 }).proposalReceipt).not.toBe(proposal({ maxAttempts: 2 }).proposalReceipt)
    expect(proposal({ objective: 'first' }).proposalReceipt).not.toBe(proposal({ objective: 'second' }).proposalReceipt)
  })

  it('escapes proposal text at rendering and never emits executable A2UI components', async () => {
    const envelope = createA2uiReviewEnvelope(proposal({ objective: '<script>alert(1)</script> **approve**' }))
    const serialized = JSON.stringify(envelope)
    const components = envelope.messages[1]
    if (!('updateComponents' in components)) throw new Error('missing components update')

    expect(serialized).toContain('<script>')
    expect(await renderReviewMarkdown('<script>alert(1)</script> **approve**')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt; **approve**',
    )
    expect(new Set(components.updateComponents.components.map(item => item.component))).toEqual(
      new Set(['Card', 'Column', 'Row', 'Text', 'TextField', 'Button']),
    )
    expect(serialized).not.toContain('functionCall')
    expect(serialized).not.toContain('"url"')
  })

  it('rejects malformed, tampered, oversized, or non-governor details', () => {
    const reviewed = proposal()
    const detail = encodeA2uiReviewDetail('fallback', createA2uiReviewEnvelope(reviewed))

    expect(decodeA2uiReviewDetail('ordinary question')).toBeUndefined()
    expect(decodeA2uiReviewDetail(`${detail}tamper`)).toBeUndefined()
    expect(decodeA2uiReviewDetail('<!-- reliability-governor-a2ui:not-base64 -->')).toBeUndefined()
    expect(decodeA2uiReviewDetail(`<!-- reliability-governor-a2ui:${'a'.repeat(400_000)} -->`)).toBeUndefined()
  })

  it('claims only a complete receipt-bound Harness question and otherwise falls through', () => {
    const reviewed = proposal()
    const envelope = createA2uiReviewEnvelope(reviewed)
    const detail = encodeA2uiReviewDetail('fallback', envelope)
    const wait = {
      kind: 'question' as const,
      key: 'wait-1',
      sessionId: 'session-1',
      payload: {
        questions: [{
          id: `reliability-contract-review:${reviewed.proposalReceipt}`,
          detail,
          options: [
            { label: REVIEW_APPROVE_LABEL },
            { label: REVIEW_REVISE_LABEL },
            { label: REVIEW_REJECT_LABEL },
          ],
        }],
      },
      respond: async () => ({ accepted: true }),
    }

    expect(selectA2uiReview({ interactions: [wait] })?.envelope.proposalReceipt).toBe(reviewed.proposalReceipt)
    expect(selectA2uiReview({ interactions: [{
      ...wait,
      payload: { questions: [{ ...wait.payload.questions[0], id: 'stale-question' }] },
    }] })).toBeNull()
    expect(selectA2uiReview({ interactions: [{
      ...wait,
      payload: { questions: [{ ...wait.payload.questions[0], options: [{ label: REVIEW_APPROVE_LABEL }] }] },
    }] })).toBeNull()
  })
})
