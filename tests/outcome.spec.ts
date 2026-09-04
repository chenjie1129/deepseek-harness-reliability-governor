import { describe, expect, it } from 'vitest'
import {
  createBusinessOutcomeContract,
  evaluateBusinessOutcome,
  parseBusinessOutcomeSnapshot,
  resolveBusinessOutcomeProfiles,
} from '../src/outcome.js'
import type {
  BusinessOutcomeProbe,
  ReliabilityContract,
} from '../src/types.js'

const deliveryContract: ReliabilityContract = {
  version: 1,
  contractId: 'delivery-1',
  objective: 'deliver a measurable change',
  checks: [{ id: 'artifact', kind: 'file_exists', path: 'result.json' }],
  maxAttempts: 2,
  startedAtSeq: 1,
}

function profile(overrides: Record<string, unknown> = {}) {
  return resolveBusinessOutcomeProfiles([{
    id: 'activation-rate',
    description: 'Activation rate reaches the deployment target without increasing complaints.',
    command: 'observe-activation',
    metrics: [
      { name: 'activation_rate', unit: 'ratio' },
      { name: 'complaint_rate', unit: 'ratio' },
    ],
    target: { id: 'activation', metric: 'activation_rate', operator: 'delta-gte', value: 0.05 },
    guardrails: [{ id: 'complaints', metric: 'complaint_rate', operator: 'lte', value: 0.02 }],
    minimumSampleSize: 100,
    notBeforeMs: 1_000,
    deadlineMs: 10_000,
    attribution: 'correlational',
    ...overrides,
  }])[0]
}

function probe(
  selectedProfile: ReturnType<typeof profile>,
  metrics: Record<string, number>,
  sampleSize = 100,
  observedAt = 1_000,
): BusinessOutcomeProbe {
  return {
    version: 1,
    observationId: `observation-${observedAt}`,
    profile: selectedProfile.id,
    profileReceipt: selectedProfile.profileReceipt,
    succeeded: true,
    exitCode: 0,
    signal: null,
    durationMs: 1,
    sandboxEnforcement: 'full',
    snapshot: { observedAt, dataAsOf: observedAt, metrics, sampleSize },
    stdout: { bytes: 1, truncated: false, receipt: 'sha256:stdout' },
    stderr: { bytes: 0, truncated: false, receipt: 'sha256:stderr' },
    receipt: `sha256:probe-${observedAt}`,
  }
}

describe('business outcome layer', () => {
  it('resolves deployment-controlled profiles and excludes executable details from summaries', () => {
    const selected = profile()

    expect(selected.profileReceipt).toMatch(/^sha256:/)
    expect(selected.target).toEqual({
      id: 'activation',
      metric: 'activation_rate',
      operator: 'delta-gte',
      value: 0.05,
    })
    expect(() => profile({ id: 'invalid profile id' })).toThrow('kebab-case')
    expect(() => profile({
      target: { id: 'unknown', metric: 'revenue', operator: 'gte', value: 1 },
    })).toThrow('undeclared metric')
  })

  it('parses only declared finite metrics from strict profile output', () => {
    const selected = profile()
    const snapshot = parseBusinessOutcomeSnapshot(JSON.stringify({
      dataAsOf: 2_000,
      metrics: { activation_rate: 0.2, complaint_rate: 0.01 },
      sampleSize: 120,
    }), selected, 2_100)

    expect(snapshot).toEqual({
      observedAt: 2_100,
      dataAsOf: 2_000,
      metrics: { activation_rate: 0.2, complaint_rate: 0.01 },
      sampleSize: 120,
    })
    expect(() => parseBusinessOutcomeSnapshot(JSON.stringify({
      dataAsOf: 2_000,
      metrics: { activation_rate: 0.2, complaint_rate: 0.01, secret_metric: 1 },
    }), selected, 2_100)).toThrow('undeclared metric')
    expect(() => parseBusinessOutcomeSnapshot(JSON.stringify({
      dataAsOf: 2_000,
      metrics: { activation_rate: 'high', complaint_rate: 0.01 },
    }), selected, 2_100)).toThrow('finite number')
    expect(() => parseBusinessOutcomeSnapshot(JSON.stringify({
      dataAsOf: 2_000,
      metrics: { activation_rate: 0.2, complaint_rate: 0.01 },
    }), selected, 2_000 + selected.maxDataAgeMs + 1)).toThrow('maxDataAgeMs')
  })

  it('keeps delivery and business outcome states separate and reports correlation honestly', () => {
    const selected = profile()
    const baseline = probe(selected, { activation_rate: 0.1, complaint_rate: 0.01 }, 120, 1_000)
    const contract = createBusinessOutcomeContract(deliveryContract, selected, baseline, 1_000)
    const current = probe(selected, { activation_rate: 0.16, complaint_rate: 0.015 }, 150, 3_000)
    const evaluation = evaluateBusinessOutcome(contract, current, 3_000)

    expect(contract.deliveryContractId).toBe(deliveryContract.contractId)
    expect(contract.baseline).toBe(baseline)
    expect(evaluation).toMatchObject({
      status: 'achieved',
      causalClaimPermitted: false,
      target: { comparedValue: 0.06, passed: true },
      guardrails: [{ id: 'complaints', passed: true }],
    })
    expect(evaluation.reason).toContain('correlational')
  })

  it('waits for the observation window and sample size, then misses at the deadline', () => {
    const selected = profile()
    const baseline = probe(selected, { activation_rate: 0.1, complaint_rate: 0.01 })
    const contract = createBusinessOutcomeContract(deliveryContract, selected, baseline, 1_000)
    const lowSample = probe(selected, { activation_rate: 0.2, complaint_rate: 0.01 }, 20, 2_000)

    expect(evaluateBusinessOutcome(contract, lowSample, 1_500)).toMatchObject({
      status: 'observing',
    })
    expect(evaluateBusinessOutcome(contract, lowSample, 11_000)).toMatchObject({
      status: 'inconclusive',
    })

    const missed = probe(selected, { activation_rate: 0.12, complaint_rate: 0.03 }, 150, 11_000)
    expect(evaluateBusinessOutcome(contract, missed, 11_000)).toMatchObject({
      status: 'missed',
      target: { passed: false },
      guardrails: [{ passed: false }],
    })
  })
})
