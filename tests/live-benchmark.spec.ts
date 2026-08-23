import { describe, expect, it } from 'vitest'
import {
  aggregateRepairTransitions,
  classifyResult,
  exactMcNemar,
  exactTaskSignFlip,
  makeDecision,
  pairedOracleTransitions,
  summarize,
  taskClusterBootstrapDifference,
} from '../scripts/live-benchmark-analysis.mjs'

function run(overrides: Record<string, unknown>) {
  return classifyResult({
    caseId: 'case-1',
    category: 'test',
    solvable: true,
    arm: 'baseline',
    trial: 1,
    oraclePass: true,
    claimedComplete: true,
    falseCompletion: false,
    terminal: 'none',
    contractStarted: false,
    sessionFound: true,
    attempts: [],
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    modelCalls: 1,
    inputTokens: 1,
    outputTokens: 1,
    toolCalls: 0,
    stdoutReceipt: false,
    ...overrides,
  })
}

describe('live benchmark v2 analysis', () => {
  it('uses arm-neutral false success and separate governed rejection outcomes', () => {
    const results = [
      run({ arm: 'baseline', oraclePass: false, claimedComplete: true, falseCompletion: true }),
      run({ arm: 'governed-model-contract', trial: 2, contractStarted: true, terminal: 'certified', oraclePass: false }),
      run({ arm: 'governed-model-contract', trial: 3, contractStarted: true, terminal: 'exhausted', oraclePass: true, claimedComplete: false }),
      run({ arm: 'governed-model-contract', trial: 4, contractStarted: true, terminal: 'abstained', oraclePass: true, claimedComplete: false }),
    ]
    const summary = summarize(results)

    expect(summary.falseSuccesses).toBe(2)
    expect(summary.falseCertifications).toBe(1)
    expect(summary.falseExhaustions).toBe(1)
    expect(summary.falseAbstentions).toBe(1)
    expect(summary.falseRejections).toBe(2)
    expect(summary.contingency.reportedSuccess.oracleFail).toBe(2)
    expect(summary.terminalContingency.exhausted.oraclePass).toBe(1)
    expect(summary.terminalContingency.abstained.oraclePass).toBe(1)
  })

  it('attributes every failed check in an attempt instead of only the first', () => {
    const result = run({
      arm: 'governed-model-contract',
      contractStarted: true,
      terminal: 'exhausted',
      oraclePass: true,
      attempts: [{
        attempt: 1,
        results: [
          { kind: 'file_contains', passed: false },
          { kind: 'no_tool_errors', passed: false },
          { kind: 'file_exists', passed: true },
        ],
      }],
    })
    const attribution = summarize([result]).checkAttribution

    expect(attribution.file_contains.falseExhaustionRunsWithFailure).toBe(1)
    expect(attribution.no_tool_errors.falseExhaustionRunsWithFailure).toBe(1)
    expect(attribution.file_exists.attemptFailures).toBe(0)
    expect(attribution.file_contains.uniqueFailureAttempts).toBe(0)
  })

  it('labels paired oracle discordance as candidates and bootstraps by task', () => {
    const results = [
      run({ caseId: 'a', arm: 'baseline', oraclePass: false, claimedComplete: true, falseCompletion: true }),
      run({ caseId: 'a', arm: 'governed-model-contract', oraclePass: true, contractStarted: true, terminal: 'certified' }),
      run({ caseId: 'b', arm: 'baseline', oraclePass: true }),
      run({ caseId: 'b', arm: 'governed-model-contract', oraclePass: false, contractStarted: true, terminal: 'exhausted' }),
    ]
    const transitions = pairedOracleTransitions(results, 'governed-model-contract')
    const interval = taskClusterBootstrapDifference(results, 'governed-model-contract', 'baseline', 'oraclePass', {
      replicates: 100,
      seed: 7,
    })

    expect(transitions.rescueCandidates).toBe(1)
    expect(transitions.regressionCandidates).toBe(1)
    expect(transitions.note).toContain('not individual causal effects')
    expect(interval.caseCount).toBe(2)
    expect(interval.estimate).toBe(0)
    expect(interval.lower).toBeLessThanOrEqual(0)
    expect(interval.upper).toBeGreaterThanOrEqual(0)
  })

  it('keeps McNemar direction explicit and only attributes live repair snapshots', () => {
    const baseline = run({ arm: 'baseline', oraclePass: false, claimedComplete: true, falseCompletion: true })
    const governed = run({
      arm: 'governed-model-contract',
      contractStarted: true,
      contract: { maxAttempts: 3 },
      terminal: 'certified',
      oraclePass: true,
      attemptOracleSnapshots: [
        { attempt: 1, contractPassed: false, captureMode: 'live', oraclePass: false },
        { attempt: 2, contractPassed: true, captureMode: 'live', oraclePass: true },
      ],
    })
    const mcnemar = exactMcNemar([baseline, governed], 'baseline', 'governed-model-contract', 'falseSuccess')
    const signFlip = exactTaskSignFlip([baseline, governed], 'baseline', 'governed-model-contract', 'falseSuccess')
    const repairs = aggregateRepairTransitions([governed])

    expect(mcnemar.leftOnly).toBe(1)
    expect(mcnemar.rightOnly).toBe(0)
    expect(signFlip.estimate).toBe(1)
    expect(signFlip.twoSidedPValue).toBe(1)
    expect(repairs.gateRescuesObserved).toBe(1)
    expect(repairs.gateInducedRegressionsObserved).toBe(0)
  })

  it('requires every pre-registered interval, publication, and direction gate for PROVEN', () => {
    const manifest = {
      cases: Array.from({ length: 20 }, (_, index) => ({ id: String(index) })),
      minimumTrialsForDecision: 5,
      preregistration: {
        alpha: 0.05,
        falseRejectionCosts: { exhaustion: 1, abstention: 0.35 },
        verdictThresholds: {
          minimumContractAdoption: 0.8,
          minimumReferenceContractMatch: 0.8,
          maximumFalseExhaustion: 0.1,
          maximumFalseAbstention: 0.1,
          maximumFalseRejection: 0.15,
          maximumContractAuthorshipPenalty: 0.05,
          maximumOracleSuccessRegression: 0.05,
          minimumRelativeFalseSuccessReduction: 0.3,
        },
      },
    }
    const baseline = { operationalFailures: 0, falseSuccessRate: 0.2 }
    const governed = {
      operationalFailures: 0,
      falseSuccessRate: 0.05,
      falseCertifications: 0,
      contractAdoptionWilson95: { lower: 0.9 },
      falseExhaustionRateAmongOraclePass: 0.01,
      falseExhaustionWilson95AmongOraclePass: { upper: 0.05 },
      falseAbstentionRateAmongOraclePass: 0.01,
      falseAbstentionWilson95AmongOraclePass: { upper: 0.05 },
    }
    const reference = {
      operationalFailures: 0,
      falseSuccessRate: 0.04,
      falseCertifications: 0,
      referenceContractMatchWilson95: { lower: 0.9 },
      falseRejectionRateAmongOraclePass: 0.02,
      terminalFalseRejectionRateAmongOraclePass: 0.02,
    }
    const input = {
      manifest,
      preregistration: { locked: true },
      trials: 5,
      caseCount: 20,
      summaries: {
        baseline,
        'governed-model-contract': governed,
        'governed-reference-contract': reference,
      },
      falseSuccessTaskSignFlip: { estimate: 0.15, twoSidedPValue: 0.01 },
      falseSuccessBenefit: { lower: 0.05 },
      oracleSuccessDifference: { lower: -0.02, upper: 0.02 },
      falseRejectionDifference: { lower: -0.01, upper: 0.04 },
      terminalFalseRejectionDifference: { lower: -0.01, upper: 0.04 },
      source: { trackedTreeClean: true, publishedAtUpstream: true },
    }

    expect(makeDecision(input).verdict).toBe('PROVEN')
    const harmful = structuredClone(input)
    harmful.summaries['governed-model-contract'].falseExhaustionRateAmongOraclePass = 0.11
    harmful.summaries['governed-model-contract'].falseExhaustionWilson95AmongOraclePass.upper = 0.2
    expect(makeDecision(harmful).verdict).toBe('HARMFUL')
  })
})
