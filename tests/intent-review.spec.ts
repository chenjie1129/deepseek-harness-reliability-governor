import { describe, expect, it } from 'vitest'
import { createIntent, createIntentReviewProposal } from '../src/intent-review.js'

describe('interpreted intent review', () => {
  it('normalizes explicit semantic fields and records who drafted them', () => {
    const intent = createIntent('  Preserve existing users  ', {
      constraints: ['  Keep the public API stable. '],
      assumptions: ['Existing users means active accounts.'],
      non_goals: ['Do not redesign authentication.'],
      ambiguities: [],
    }, 'auxiliary-model')

    expect(intent).toEqual({
      version: 1,
      objective: 'Preserve existing users',
      constraints: ['Keep the public API stable.'],
      assumptions: ['Existing users means active accounts.'],
      nonGoals: ['Do not redesign authentication.'],
      ambiguities: [],
      authorship: { version: 1, mode: 'current-agent', assurance: 'caller-declared' },
    })
  })

  it('changes the proposal receipt when any semantic interpretation changes', () => {
    const base = createIntent('retain logs', {
      constraints: ['Keep 30 days.'], assumptions: [], non_goals: [], ambiguities: [],
    }, 'current-agent')
    const changed = createIntent('retain logs', {
      constraints: ['Keep 90 days.'], assumptions: [], non_goals: [], ambiguities: [],
    }, 'current-agent')

    expect(createIntentReviewProposal(base).proposalReceipt)
      .not.toBe(createIntentReviewProposal(changed).proposalReceipt)
  })

  it('fails closed on missing, empty, duplicate, or oversized interpretation fields', () => {
    expect(() => createIntent('objective', undefined, 'current-agent')).toThrow('intent is required')
    expect(() => createIntent('objective', {
      constraints: ['same', 'same'], assumptions: [], non_goals: [], ambiguities: [],
    }, 'current-agent')).toThrow('duplicate')
    expect(() => createIntent('objective', {
      constraints: ['   '], assumptions: [], non_goals: [], ambiguities: [],
    }, 'current-agent')).toThrow('must be non-empty')
    expect(() => createIntent('objective', {
      constraints: ['x'.repeat(2_049)], assumptions: [], non_goals: [], ambiguities: [],
    }, 'current-agent')).toThrow('exceeds 2048 UTF-8 bytes')
  })

  it('preserves model-free manual provenance', () => {
    expect(createIntent('use supplied reference', {
      constraints: [], assumptions: [], non_goals: [], ambiguities: [],
    }, 'manual').authorship.mode).toBe('manual')
  })
})
