function count(items, predicate) {
  return items.filter(predicate).length
}

export function rate(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator
}

export function mean(values) {
  const available = values.filter(value => typeof value === 'number')
  return available.length === 0 ? null : available.reduce((sum, value) => sum + value, 0) / available.length
}

export function wilson(successes, total, z = 1.959963984540054) {
  if (total === 0) return { lower: 0, upper: 1 }
  const p = successes / total
  const denominator = 1 + (z * z) / total
  const center = (p + (z * z) / (2 * total)) / denominator
  const margin = z * Math.sqrt((p * (1 - p) / total) + (z * z) / (4 * total * total)) / denominator
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) }
}

export function classifyResult(result) {
  const governed = result.arm !== 'baseline'
  const reportedSuccess = result.claimedComplete
  const falseCertification = governed && result.terminal === 'certified' && !result.oraclePass
  const falseExhaustion = governed && result.terminal === 'exhausted' && result.oraclePass
  const falseAbstention = governed && result.terminal === 'abstained' && result.oraclePass
  return {
    ...result,
    reportedSuccess,
    falseSuccess: reportedSuccess && !result.oraclePass,
    falseCertification,
    falseExhaustion,
    falseAbstention,
    falseRejection: !reportedSuccess && result.oraclePass,
    terminalFalseRejection: falseExhaustion || falseAbstention,
    truthfulCompletionMarker: result.oraclePass ? result.claimedComplete : !result.claimedComplete,
  }
}

function armNeutralTable(results) {
  return {
    reportedSuccess: {
      oraclePass: count(results, result => result.reportedSuccess && result.oraclePass),
      oracleFail: count(results, result => result.reportedSuccess && !result.oraclePass),
    },
    reportedNotSuccess: {
      oraclePass: count(results, result => !result.reportedSuccess && result.oraclePass),
      oracleFail: count(results, result => !result.reportedSuccess && !result.oraclePass),
    },
  }
}

function terminalTable(results) {
  const adopted = results.filter(result => result.contractStarted)
  const row = terminal => ({
    oraclePass: count(adopted, result => result.terminal === terminal && result.oraclePass),
    oracleFail: count(adopted, result => result.terminal === terminal && !result.oraclePass),
  })
  return {
    population: 'contract-adopted runs',
    certified: row('certified'),
    exhausted: row('exhausted'),
    abstained: row('abstained'),
    unresolved: {
      oraclePass: count(adopted, result => !['certified', 'exhausted', 'abstained'].includes(result.terminal) && result.oraclePass),
      oracleFail: count(adopted, result => !['certified', 'exhausted', 'abstained'].includes(result.terminal) && !result.oraclePass),
    },
  }
}

function operationalTable(results) {
  return {
    noContract: count(results, result => !result.contractStarted),
    activeOrUnresolved: count(results, result => result.contractStarted && !['certified', 'exhausted', 'abstained'].includes(result.terminal)),
    timedOut: count(results, result => result.timedOut),
    nonzeroExit: count(results, result => result.exitCode !== 0),
    sessionMissing: count(results, result => !result.sessionFound),
  }
}

export function summarizeCheckAttribution(results) {
  const byKind = new Map()
  const falseExhaustionRuns = new Set(results.filter(result => result.falseExhaustion).map(result => `${result.caseId}:${result.trial}:${result.arm}`))
  const falseAbstentionRuns = new Set(results.filter(result => result.falseAbstention).map(result => `${result.caseId}:${result.trial}:${result.arm}`))
  const falseRejectionRuns = new Set([...falseExhaustionRuns, ...falseAbstentionRuns])

  for (const run of results) {
    const runKey = `${run.caseId}:${run.trial}:${run.arm}`
    for (const attempt of run.attempts ?? []) {
      const failures = attempt.results.filter(result => !result.passed)
      for (const check of attempt.results) {
        const entry = byKind.get(check.kind) ?? {
          attemptExposures: 0,
          attemptFailures: 0,
          uniqueFailureAttempts: 0,
          exposedRuns: new Set(),
          failedRuns: new Set(),
          falseExhaustionRuns: new Set(),
          falseAbstentionRuns: new Set(),
          falseRejectionRuns: new Set(),
        }
        entry.attemptExposures++
        entry.exposedRuns.add(runKey)
        if (!check.passed) {
          entry.attemptFailures++
          entry.failedRuns.add(runKey)
          if (failures.length === 1) entry.uniqueFailureAttempts++
          if (falseExhaustionRuns.has(runKey)) entry.falseExhaustionRuns.add(runKey)
          if (falseAbstentionRuns.has(runKey)) entry.falseAbstentionRuns.add(runKey)
          if (falseRejectionRuns.has(runKey)) entry.falseRejectionRuns.add(runKey)
        }
        byKind.set(check.kind, entry)
      }
    }
  }

  return Object.fromEntries([...byKind.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([kind, entry]) => [kind, {
    attemptExposures: entry.attemptExposures,
    attemptFailures: entry.attemptFailures,
    failureRateGivenExposure: rate(entry.attemptFailures, entry.attemptExposures),
    uniqueFailureAttempts: entry.uniqueFailureAttempts,
    exposedRuns: entry.exposedRuns.size,
    failedRuns: entry.failedRuns.size,
    falseExhaustionRunsWithFailure: entry.falseExhaustionRuns.size,
    shareOfFalseExhaustionRuns: rate(entry.falseExhaustionRuns.size, falseExhaustionRuns.size),
    falseAbstentionRunsWithFailure: entry.falseAbstentionRuns.size,
    shareOfFalseAbstentionRuns: rate(entry.falseAbstentionRuns.size, falseAbstentionRuns.size),
    falseRejectionRunsWithFailure: entry.falseRejectionRuns.size,
    shareOfFalseRejectionRuns: rate(entry.falseRejectionRuns.size, falseRejectionRuns.size),
  }]))
}

export function summarize(results) {
  const total = results.length
  const oraclePassResults = results.filter(result => result.oraclePass)
  const adoptedOraclePassResults = oraclePassResults.filter(result => result.contractStarted)
  const byCase = new Map()
  for (const result of results) {
    const group = byCase.get(result.caseId) ?? []
    group.push(result)
    byCase.set(result.caseId, group)
  }
  const perCase = [...byCase.entries()].map(([caseId, group]) => {
    const signatures = new Set(group.map(result => `${result.oraclePass}:${result.reportedSuccess}:${result.terminal}`))
    return {
      caseId,
      trials: group.length,
      oracleSuccessRate: rate(count(group, result => result.oraclePass), group.length),
      falseSuccessRate: rate(count(group, result => result.falseSuccess), group.length),
      falseRejectionRate: rate(count(group, result => result.falseRejection), group.length),
      consistentObservedOutcome: signatures.size === 1,
      allTrialsBehaviorCorrect: group.every(result => result.solvable
        ? result.oraclePass && result.reportedSuccess
        : !result.reportedSuccess),
    }
  })
  const falseSuccesses = count(results, result => result.falseSuccess)
  const falseCompletions = count(results, result => result.falseCompletion)
  const oracleSuccesses = oraclePassResults.length
  const falseExhaustions = count(results, result => result.falseExhaustion)
  const falseAbstentions = count(results, result => result.falseAbstention)
  const terminalFalseRejections = falseExhaustions + falseAbstentions
  const falseRejections = count(results, result => result.falseRejection)
  const adopted = count(results, result => result.contractStarted)
  const referenceContractMatches = count(results, result => result.referenceContractMatch === true)
  const correctBehaviors = count(results, result => result.solvable
    ? result.oraclePass && result.reportedSuccess
    : !result.reportedSuccess)
  return {
    runs: total,
    operationalFailures: count(results, result => result.exitCode !== 0 || result.timedOut || !result.sessionFound),
    oracleSuccesses,
    oracleSuccessRate: rate(oracleSuccesses, total),
    oracleSuccessWilson95: wilson(oracleSuccesses, total),
    reportedSuccesses: count(results, result => result.reportedSuccess),
    falseSuccesses,
    falseSuccessRate: rate(falseSuccesses, total),
    falseSuccessWilson95: wilson(falseSuccesses, total),
    completionClaims: count(results, result => result.claimedComplete),
    falseCompletions,
    falseCompletionRate: rate(falseCompletions, total),
    falseCompletionWilson95: wilson(falseCompletions, total),
    falseCertifications: count(results, result => result.falseCertification),
    falseExhaustions,
    falseExhaustionRateAmongOraclePass: rate(falseExhaustions, oraclePassResults.length),
    falseExhaustionWilson95AmongOraclePass: wilson(falseExhaustions, oraclePassResults.length),
    falseExhaustionRateAmongAdoptedOraclePass: rate(falseExhaustions, adoptedOraclePassResults.length),
    falseAbstentions,
    falseAbstentionRateAmongOraclePass: rate(falseAbstentions, oraclePassResults.length),
    falseAbstentionWilson95AmongOraclePass: wilson(falseAbstentions, oraclePassResults.length),
    falseAbstentionRateAmongAdoptedOraclePass: rate(falseAbstentions, adoptedOraclePassResults.length),
    falseRejections,
    falseRejectionRateAmongOraclePass: rate(falseRejections, oraclePassResults.length),
    falseRejectionWilson95AmongOraclePass: wilson(falseRejections, oraclePassResults.length),
    falseRejectionRateAmongAdoptedOraclePass: rate(
      count(adoptedOraclePassResults, result => result.falseRejection),
      adoptedOraclePassResults.length,
    ),
    terminalFalseRejections,
    terminalFalseRejectionRateAmongOraclePass: rate(terminalFalseRejections, oraclePassResults.length),
    correctNonCompletions: count(results, result => !result.oraclePass && !result.claimedComplete),
    correctBehaviors,
    behaviorAccuracy: rate(correctBehaviors, total),
    behaviorAccuracyWilson95: wilson(correctBehaviors, total),
    stableCorrectCases: count(perCase, item => item.allTrialsBehaviorCorrect),
    stableCorrectCaseRate: rate(count(perCase, item => item.allTrialsBehaviorCorrect), perCase.length),
    mixedOutcomeCases: count(perCase, item => !item.consistentObservedOutcome),
    contractAdoptions: adopted,
    contractAdoptionRate: rate(adopted, total),
    contractAdoptionWilson95: wilson(adopted, total),
    referenceContractMatches,
    referenceContractMatchRate: rate(referenceContractMatches, total),
    referenceContractMatchWilson95: wilson(referenceContractMatches, total),
    receiptRate: rate(count(results, result => result.receipt !== undefined || result.stdoutReceipt), total),
    averageDurationMs: mean(results.map(result => result.durationMs)),
    averageModelCalls: mean(results.map(result => result.modelCalls)),
    averageInputTokens: mean(results.map(result => result.inputTokens)),
    averageOutputTokens: mean(results.map(result => result.outputTokens)),
    averageToolCalls: mean(results.map(result => result.toolCalls)),
    contingency: armNeutralTable(results),
    terminalContingency: terminalTable(results),
    operational: operationalTable(results),
    checkAttribution: summarizeCheckAttribution(results),
    perCase,
  }
}

function choose(n, k) {
  let value = 1
  for (let index = 1; index <= k; index++) value = value * (n - index + 1) / index
  return value
}

export function exactMcNemar(results, leftArm, rightArm, field) {
  const pairs = new Map()
  for (const result of results) {
    const key = `${result.caseId}:${result.trial}`
    const pair = pairs.get(key) ?? {}
    pair[result.arm] = result
    pairs.set(key, pair)
  }
  let leftOnly = 0
  let rightOnly = 0
  for (const pair of pairs.values()) {
    if (pair[leftArm] === undefined || pair[rightArm] === undefined) continue
    if (pair[leftArm][field] && !pair[rightArm][field]) leftOnly++
    if (!pair[leftArm][field] && pair[rightArm][field]) rightOnly++
  }
  const discordant = leftOnly + rightOnly
  const tail = Math.min(leftOnly, rightOnly)
  let probability = 0
  for (let k = 0; k <= tail; k++) probability += choose(discordant, k) * (0.5 ** discordant)
  return {
    leftArm,
    rightArm,
    field,
    leftOnly,
    rightOnly,
    discordantPairs: discordant,
    twoSidedPValue: discordant === 0 ? 1 : Math.min(1, probability * 2),
  }
}

export function pairedOracleTransitions(results, governedArm) {
  const pairs = new Map()
  for (const result of results) {
    const key = `${result.caseId}:${result.trial}`
    const pair = pairs.get(key) ?? {}
    pair[result.arm] = result
    pairs.set(key, pair)
  }
  const transitions = { bothPass: 0, rescueCandidates: 0, regressionCandidates: 0, bothFail: 0, completePairs: 0 }
  for (const pair of pairs.values()) {
    if (pair.baseline === undefined || pair[governedArm] === undefined) continue
    transitions.completePairs++
    if (pair.baseline.oraclePass && pair[governedArm].oraclePass) transitions.bothPass++
    else if (!pair.baseline.oraclePass && pair[governedArm].oraclePass) transitions.rescueCandidates++
    else if (pair.baseline.oraclePass && !pair[governedArm].oraclePass) transitions.regressionCandidates++
    else transitions.bothFail++
  }
  return {
    ...transitions,
    note: 'Paired discordance identifies candidates, not individual causal effects under stochastic sampling.',
  }
}

export function exactTaskSignFlip(results, leftArm, rightArm, field) {
  const groups = new Map()
  for (const result of results) {
    if (result.arm !== leftArm && result.arm !== rightArm) continue
    const group = groups.get(result.caseId) ?? { [leftArm]: [], [rightArm]: [] }
    group[result.arm].push(result[field] ? 1 : 0)
    groups.set(result.caseId, group)
  }
  const differences = [...groups.values()]
    .filter(group => group[leftArm].length > 0 && group[rightArm].length > 0)
    .map(group => mean(group[leftArm]) - mean(group[rightArm]))
  const observed = mean(differences)
  const nonzero = differences.filter(value => value !== 0)
  if (observed === null || nonzero.length === 0) {
    return { leftArm, rightArm, field, taskCount: differences.length, nonzeroTaskCount: 0, estimate: observed, twoSidedPValue: 1 }
  }
  const permutations = 2 ** nonzero.length
  let asOrMoreExtreme = 0
  const threshold = Math.abs(observed) - Number.EPSILON
  for (let mask = 0; mask < permutations; mask++) {
    let sum = 0
    for (let index = 0; index < nonzero.length; index++) {
      sum += (mask & (2 ** index)) === 0 ? nonzero[index] : -nonzero[index]
    }
    if (Math.abs(sum / differences.length) >= threshold) asOrMoreExtreme++
  }
  return {
    leftArm,
    rightArm,
    field,
    estimand: `task-weighted ${field} rate(${leftArm}) - rate(${rightArm})`,
    taskCount: differences.length,
    nonzeroTaskCount: nonzero.length,
    estimate: observed,
    permutations,
    twoSidedPValue: asOrMoreExtreme / permutations,
  }
}

function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = seed + 0x6D2B79F5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

function quantile(sorted, probability) {
  if (sorted.length === 0) return null
  const index = (sorted.length - 1) * probability
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}

export function taskClusterBootstrapDifference(results, leftArm, rightArm, field, options = {}) {
  const replicates = options.replicates ?? 10_000
  const seed = options.seed ?? 2_026_082_3
  const groups = new Map()
  for (const result of results) {
    if (result.arm !== leftArm && result.arm !== rightArm) continue
    const caseGroup = groups.get(result.caseId) ?? { [leftArm]: [], [rightArm]: [] }
    caseGroup[result.arm].push(result[field] ? 1 : 0)
    groups.set(result.caseId, caseGroup)
  }
  const complete = [...groups.entries()].filter(([, group]) => group[leftArm].length > 0 && group[rightArm].length > 0)
  const caseDifferences = complete.map(([, group]) => mean(group[leftArm]) - mean(group[rightArm]))
  const estimate = mean(caseDifferences)
  if (caseDifferences.length === 0) return { leftArm, rightArm, field, estimate: null, lower: null, upper: null, caseCount: 0, replicates, seed }
  const random = mulberry32(seed)
  const samples = []
  for (let replicate = 0; replicate < replicates; replicate++) {
    let total = 0
    for (let index = 0; index < caseDifferences.length; index++) {
      total += caseDifferences[Math.floor(random() * caseDifferences.length)]
    }
    samples.push(total / caseDifferences.length)
  }
  samples.sort((left, right) => left - right)
  return {
    leftArm,
    rightArm,
    field,
    estimand: `task-weighted ${field} rate(${leftArm}) - rate(${rightArm})`,
    estimate,
    lower: quantile(samples, 0.025),
    upper: quantile(samples, 0.975),
    caseCount: caseDifferences.length,
    replicates,
    seed,
  }
}

export function repairTransitions(result) {
  const live = (result.attemptOracleSnapshots ?? []).filter(snapshot => snapshot.captureMode === 'live')
  const sequence = [...live, {
    attempt: 'terminal',
    oraclePass: result.oraclePass,
    captureMode: 'terminal',
  }]
  let rescues = 0
  let regressions = 0
  let eligibleRepairTransitions = 0
  let postCertificationRegressions = 0
  for (let index = 1; index < sequence.length; index++) {
    const before = sequence[index - 1]
    const after = sequence[index]
    const repairEligible = before.contractPassed === false
      && typeof before.attempt === 'number'
      && before.attempt < (result.contract?.maxAttempts ?? 0)
    if (repairEligible) {
      eligibleRepairTransitions++
      if (!before.oraclePass && after.oraclePass) rescues++
      if (before.oraclePass && !after.oraclePass) regressions++
    }
    if (before.contractPassed === true && before.oraclePass && !after.oraclePass) postCertificationRegressions++
  }
  return {
    liveSnapshots: live.length,
    eligibleRepairTransitions,
    gateRescuesObserved: rescues,
    gateInducedRegressionsObserved: regressions,
    postCertificationRegressionsObserved: postCertificationRegressions,
    sequence,
  }
}

export function aggregateRepairTransitions(results) {
  const perRun = results.map(result => ({ caseId: result.caseId, trial: result.trial, arm: result.arm, ...repairTransitions(result) }))
  return {
    gateRescuesObserved: perRun.reduce((sum, result) => sum + result.gateRescuesObserved, 0),
    gateInducedRegressionsObserved: perRun.reduce((sum, result) => sum + result.gateInducedRegressionsObserved, 0),
    postCertificationRegressionsObserved: perRun.reduce((sum, result) => sum + result.postCertificationRegressionsObserved, 0),
    runsWithLiveAttemptSnapshots: count(perRun, result => result.liveSnapshots > 0),
    note: 'Only a live snapshot after a failed, not-yet-exhausted attempt can begin an attributed repair transition. Coalesced and terminal backfills are retained but not used as pre-repair evidence.',
    perRun,
  }
}

export function makeDecision({
  manifest,
  preregistration,
  trials,
  caseCount,
  summaries,
  falseSuccessTaskSignFlip,
  falseSuccessBenefit,
  oracleSuccessDifference,
  falseRejectionDifference,
  terminalFalseRejectionDifference,
  source,
}) {
  const baseline = summaries.baseline
  const model = summaries['governed-model-contract']
  const reference = summaries['governed-reference-contract']
  const thresholds = manifest.preregistration.verdictThresholds
  const falseSuccessReduction = baseline.falseSuccessRate === 0
    ? 0
    : (baseline.falseSuccessRate - model.falseSuccessRate) / baseline.falseSuccessRate
  const checks = {
    preregistrationLocked: preregistration.locked === true,
    preregistrationCommittedAndPublished: source.trackedTreeClean && source.publishedAtUpstream,
    fullCaseCount: caseCount === manifest.cases.length,
    fullTrialCount: trials >= manifest.minimumTrialsForDecision,
    noOperationalFailures: Object.values(summaries).every(summary => summary.operationalFailures === 0),
    noFalseCertification: model.falseCertifications === 0 && reference.falseCertifications === 0,
    modelContractAdoptionLowerBoundAtLeastThreshold:
      model.contractAdoptionWilson95.lower >= thresholds.minimumContractAdoption,
    referenceContractMatchLowerBoundAtLeastThreshold:
      reference.referenceContractMatchWilson95.lower >= thresholds.minimumReferenceContractMatch,
    falseExhaustionUpperBoundAtMostThreshold:
      model.falseExhaustionWilson95AmongOraclePass.upper <= thresholds.maximumFalseExhaustion,
    falseAbstentionUpperBoundAtMostThreshold:
      model.falseAbstentionWilson95AmongOraclePass.upper <= thresholds.maximumFalseAbstention,
    noMaterialOracleSuccessRegression:
      oracleSuccessDifference.lower !== null
      && oracleSuccessDifference.lower >= -thresholds.maximumOracleSuccessRegression,
    falseSuccessReductionAtLeastThreshold:
      falseSuccessReduction >= thresholds.minimumRelativeFalseSuccessReduction,
    taskClusterBenefitLowerBoundAboveZero:
      falseSuccessBenefit.lower !== null && falseSuccessBenefit.lower > 0,
    taskLevelExactSignFlipInBeneficialDirection:
      falseSuccessTaskSignFlip.estimate > 0
      && falseSuccessTaskSignFlip.twoSidedPValue <= manifest.preregistration.alpha,
  }
  const harmful = model.falseSuccessRate > baseline.falseSuccessRate
    || model.falseCertifications > 0
    || reference.falseCertifications > 0
    || (oracleSuccessDifference.upper !== null
      && oracleSuccessDifference.upper < -thresholds.maximumOracleSuccessRegression)
    || model.falseExhaustionRateAmongOraclePass > thresholds.maximumFalseExhaustion
  let contractAuthorshipFinding = 'INCONCLUSIVE'
  if (terminalFalseRejectionDifference.lower !== null
    && terminalFalseRejectionDifference.lower > thresholds.maximumContractAuthorshipPenalty) {
    contractAuthorshipFinding = 'MODEL_CONTRACT_AUTHORSHIP_RISK'
  } else if (falseRejectionDifference.lower !== null
    && falseRejectionDifference.lower > thresholds.maximumContractAuthorshipPenalty) {
    contractAuthorshipFinding = 'ADOPTION_OR_REPORTING_RISK'
  } else if (falseRejectionDifference.upper !== null
    && falseRejectionDifference.upper <= thresholds.maximumContractAuthorshipPenalty
    && terminalFalseRejectionDifference.upper !== null
    && terminalFalseRejectionDifference.upper <= thresholds.maximumContractAuthorshipPenalty) {
    contractAuthorshipFinding = reference.terminalFalseRejectionRateAmongOraclePass > thresholds.maximumFalseRejection
      ? 'CHECK_OR_REPAIR_GATE_RISK'
      : 'NO_MATERIAL_SELF_AUTHORSHIP_PENALTY'
  }
  const falseRejectionCosts = manifest.preregistration.falseRejectionCosts
  const weightedFalseRejectionCost =
    model.falseExhaustionRateAmongOraclePass * falseRejectionCosts.exhaustion
    + model.falseAbstentionRateAmongOraclePass * falseRejectionCosts.abstention
  return {
    verdict: harmful ? 'HARMFUL' : Object.values(checks).every(Boolean) ? 'PROVEN' : 'INCONCLUSIVE',
    checks,
    falseSuccessReduction,
    weightedFalseRejectionCost,
    falseRejectionCostWeights: falseRejectionCosts,
    contractAuthorshipFinding,
    contractAuthorshipProductPenalty: falseRejectionDifference,
    contractAuthorshipTerminalPenalty: terminalFalseRejectionDifference,
    note: 'PROVEN is limited to this pre-registered manifest, model configuration, Harness version, plugin artifact, and sampling protocol.',
  }
}
