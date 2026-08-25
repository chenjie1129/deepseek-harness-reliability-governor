import { posix } from 'node:path'
import type {
  ReliabilityCheck,
  ReliabilityClaim,
  ReliabilityClaimCoverage,
  ReliabilityCoverageAssessment,
  ReliabilityCoverageFinding,
} from './types.js'
import { receiptFor } from './receipts.js'

const IMPORTANCE_WEIGHT = { critical: 5, important: 3, minor: 1 } as const

function percent(covered: number, total: number): number {
  return total === 0 ? 0 : Math.round((covered / total) * 10_000) / 100
}

function assertClaim(claim: ReliabilityClaim, checkIds: ReadonlySet<string>): void {
  if (claim.id.trim().length === 0) throw new Error('every claim needs a non-empty id')
  if (claim.id.length > 128) throw new Error('claim id must be at most 128 characters')
  if (claim.statement.trim().length === 0) throw new Error(`${claim.id}: statement must be non-empty`)
  if (claim.statement.length > 1_000) throw new Error(`${claim.id}: statement must be at most 1000 characters`)
  if (!['critical', 'important', 'minor'].includes(claim.importance)) {
    throw new Error(`${claim.id}: importance must be critical, important, or minor`)
  }
  if (!['deterministic', 'human-required', 'unsupported'].includes(claim.verification)) {
    throw new Error(`${claim.id}: verification must be deterministic, human-required, or unsupported`)
  }
  if (new Set(claim.checkIds).size !== claim.checkIds.length) {
    throw new Error(`${claim.id}: checkIds must not contain duplicates`)
  }
  for (const checkId of claim.checkIds) {
    if (!checkIds.has(checkId)) throw new Error(`${claim.id}: unknown supporting check id: ${checkId}`)
  }
  if (claim.minimumIndependentSources !== undefined
    && (!Number.isSafeInteger(claim.minimumIndependentSources)
      || claim.minimumIndependentSources < 1
      || claim.minimumIndependentSources > 10)) {
    throw new Error(`${claim.id}: minimumIndependentSources must be an integer from 1 to 10`)
  }
}

/** Checks against one authority are correlated and count as one evidence source. */
export function evidenceSourceFor(check: ReliabilityCheck): string {
  if ('path' in check) return `workspace-file:${posix.normalize(check.path.replaceAll('\\', '/'))}`
  if ('tool' in check) return 'session-trajectory:tool-events'
  if (check.kind === 'code_verification_succeeded') return `trusted-profile:${check.profile}`
  return 'session-trajectory:tool-events'
}

function checkWarnings(check: ReliabilityCheck, claimId: string): ReliabilityCoverageFinding[] {
  if (check.kind === 'file_contains' || check.kind === 'file_not_contains') {
    return [{
      code: 'exact_literal_brittleness',
      severity: 'warning',
      claimId,
      checkId: check.id,
      message: `${check.id} depends on an exact literal and may reject an equivalent outcome`,
    }]
  }
  if (check.kind === 'file_exists') {
    return [{
      code: 'presence_only_evidence',
      severity: 'warning',
      claimId,
      checkId: check.id,
      message: `${check.id} proves only that a regular file exists, not that its contents are correct`,
    }]
  }
  if (check.kind === 'no_tool_errors') {
    return [{
      code: 'trajectory_not_outcome',
      severity: 'warning',
      claimId,
      checkId: check.id,
      message: `${check.id} judges the tool trajectory; a recovered error is not evidence that the final outcome failed`,
    }]
  }
  if (check.kind === 'tool_succeeded') {
    return [{
      code: 'tool_success_not_outcome',
      severity: 'warning',
      claimId,
      checkId: check.id,
      message: `${check.id} proves the tool reported success, not that an external side effect reached the intended state`,
    }]
  }
  return []
}

/**
 * Assess declared-claim coverage without evaluating task output or mutating session state.
 * This answers "is the contract structurally sufficient?", not "did the task pass?".
 */
export function assessContractCoverage(input: {
  objective: string
  claims: ReliabilityClaim[]
  checks: ReliabilityCheck[]
}): ReliabilityCoverageAssessment {
  const objective = input.objective.trim()
  if (objective.length === 0) throw new Error('objective must be non-empty')
  if (objective.length > 2_000) throw new Error('objective must be at most 2000 characters')
  if (input.claims.length === 0) throw new Error('claims must contain at least one success claim')
  if (input.claims.length > 100) throw new Error('claims must contain at most 100 success claims')

  const checkById = new Map(input.checks.map(check => [check.id, check]))
  if (checkById.size !== input.checks.length) throw new Error('check ids must be unique before coverage assessment')
  const claimIds = new Set<string>()
  for (const claim of input.claims) {
    assertClaim(claim, new Set(checkById.keys()))
    if (claimIds.has(claim.id)) throw new Error(`duplicate claim id: ${claim.id}`)
    claimIds.add(claim.id)
  }

  const findings: ReliabilityCoverageFinding[] = [{
    code: 'declared_claims_only',
    severity: 'warning',
    message: 'Coverage applies only to declared claims; an omitted or semantically incorrect claim requires independent review to detect',
  }]
  if (!input.claims.some(claim => claim.importance === 'critical')) {
    findings.push({
      code: 'missing_critical_claim',
      severity: 'error',
      message: 'At least one claim must be marked critical so critical coverage has a meaningful denominator',
    })
  }
  const usedCheckIds = new Set<string>()
  const allSources = new Set<string>()
  const checkClaimCount = new Map<string, number>()
  const claims: ReliabilityClaimCoverage[] = []

  for (const claim of input.claims) {
    const supportingChecks = claim.checkIds.map(id => checkById.get(id) as ReliabilityCheck)
    const evidenceSources = [...new Set(supportingChecks.map(evidenceSourceFor))].sort()
    const requiredIndependentSources = claim.minimumIndependentSources ?? 1
    supportingChecks.forEach((check) => {
      usedCheckIds.add(check.id)
      allSources.add(evidenceSourceFor(check))
      checkClaimCount.set(check.id, (checkClaimCount.get(check.id) ?? 0) + 1)
      findings.push(...checkWarnings(check, claim.id))
    })

    let sufficient = false
    if (claim.verification === 'human-required') {
      findings.push({
        code: 'claim_requires_human',
        severity: 'error',
        claimId: claim.id,
        message: `${claim.id} requires human judgment and cannot be certified by deterministic checks`,
      })
    } else if (claim.verification === 'unsupported') {
      findings.push({
        code: 'claim_unsupported',
        severity: 'error',
        claimId: claim.id,
        message: `${claim.id} has no supported deterministic oracle`,
      })
    } else if (evidenceSources.length < requiredIndependentSources) {
      findings.push({
        code: 'insufficient_independent_sources',
        severity: 'error',
        claimId: claim.id,
        message: `${claim.id} has ${evidenceSources.length} independent evidence source(s); requires ${requiredIndependentSources}`,
      })
    } else {
      sufficient = true
    }

    claims.push({
      claimId: claim.id,
      importance: claim.importance,
      verification: claim.verification,
      supportingCheckIds: [...claim.checkIds],
      evidenceSources,
      requiredIndependentSources,
      sufficient,
    })
  }

  for (const check of input.checks) {
    if (!usedCheckIds.has(check.id)) {
      findings.push({
        code: 'orphan_check',
        severity: 'warning',
        checkId: check.id,
        message: `${check.id} is enforced but is not mapped to any declared claim`,
      })
    }
    const useCount = checkClaimCount.get(check.id) ?? 0
    if (useCount > 1) {
      findings.push({
        code: 'shared_check',
        severity: 'warning',
        checkId: check.id,
        message: `${check.id} supports ${useCount} claims; confirm one observation really proves each claim`,
      })
    }
  }

  const critical = claims.filter(claim => claim.importance === 'critical')
  const coveredCritical = critical.filter(claim => claim.sufficient).length
  const totalWeight = claims.reduce((sum, claim) => sum + IMPORTANCE_WEIGHT[claim.importance], 0)
  const coveredWeight = claims.filter(claim => claim.sufficient)
    .reduce((sum, claim) => sum + IMPORTANCE_WEIGHT[claim.importance], 0)
  const orphanCheckIds = input.checks.filter(check => !usedCheckIds.has(check.id)).map(check => check.id)
  const assessmentWithoutReceipt = {
    version: 1 as const,
    status: findings.some(finding => finding.severity === 'error') ? 'review-required' as const : 'ready' as const,
    claims,
    coverage: {
      critical: { covered: coveredCritical, total: critical.length, percent: percent(coveredCritical, critical.length) },
      weighted: { coveredWeight, totalWeight, percent: percent(coveredWeight, totalWeight) },
    },
    evidence: {
      checkCount: input.checks.length,
      usedCheckCount: usedCheckIds.size,
      independentSourceCount: allSources.size,
      orphanCheckIds,
    },
    findings,
  }
  return {
    ...assessmentWithoutReceipt,
    receipt: receiptFor('coverage-assessment', {
      objective,
      claims: input.claims,
      checks: input.checks,
      assessment: assessmentWithoutReceipt,
    }),
  }
}
