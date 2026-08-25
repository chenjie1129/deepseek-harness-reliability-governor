import type { JsonValue, SessionEvent } from '@deepseek-ai/dsh-session'

/** A deterministic assertion the governor knows how to evaluate. */
export type ReliabilityCheck =
  | { id: string; kind: 'file_exists'; path: string }
  | { id: string; kind: 'file_absent'; path: string }
  | { id: string; kind: 'file_contains'; path: string; text: string }
  | { id: string; kind: 'file_not_contains'; path: string; text: string }
  | { id: string; kind: 'file_equals'; path: string; text: string }
  | { id: string; kind: 'json_equals'; path: string; pointer: string; value: JsonValue }
  | { id: string; kind: 'tool_succeeded'; tool: string; argumentsContain?: string; minCount?: number }
  | { id: string; kind: 'tool_not_called'; tool: string }
  | { id: string; kind: 'code_verification_succeeded'; profile: string; minCount?: number }
  | { id: string; kind: 'no_tool_errors' }

export type ReliabilityClaimImportance = 'critical' | 'important' | 'minor'
export type ReliabilityClaimVerification = 'deterministic' | 'human-required' | 'unsupported'

/** One outcome claim and the checks intended to support it. */
export interface ReliabilityClaim {
  id: string
  statement: string
  importance: ReliabilityClaimImportance
  verification: ReliabilityClaimVerification
  checkIds: string[]
  /** Distinct evidence authorities required; several checks over one file count once. */
  minimumIndependentSources?: number
}

export interface ReliabilityCoverageFinding {
  code:
    | 'claim_requires_human'
    | 'claim_unsupported'
    | 'missing_critical_claim'
    | 'insufficient_independent_sources'
    | 'exact_literal_brittleness'
    | 'presence_only_evidence'
    | 'trajectory_not_outcome'
    | 'tool_success_not_outcome'
    | 'orphan_check'
    | 'shared_check'
    | 'declared_claims_only'
  severity: 'error' | 'warning'
  message: string
  claimId?: string
  checkId?: string
}

export interface ReliabilityClaimCoverage {
  claimId: string
  importance: ReliabilityClaimImportance
  verification: ReliabilityClaimVerification
  supportingCheckIds: string[]
  evidenceSources: string[]
  requiredIndependentSources: number
  sufficient: boolean
}

/** Structural coverage report. It does not judge whether a declared claim matches the user's intent. */
export interface ReliabilityCoverageAssessment {
  version: 1
  status: 'ready' | 'review-required'
  claims: ReliabilityClaimCoverage[]
  coverage: {
    critical: { covered: number; total: number; percent: number }
    weighted: { coveredWeight: number; totalWeight: number; percent: number }
  }
  evidence: {
    checkCount: number
    usedCheckCount: number
    independentSourceCount: number
    orphanCheckIds: string[]
  }
  findings: ReliabilityCoverageFinding[]
  receipt: string
}

export type ReliabilityContractAuthoringMode = 'current-agent' | 'auxiliary-model' | 'manual'

/** How a claim set entered the governor. This is provenance, not proof that the claims are complete. */
export interface ReliabilityAuxiliaryDraftAuthorship {
  version: 1
  mode: 'auxiliary-model'
  assurance: 'draft-receipt-bound'
  provider: string
  model: string
  reasoningEffort?: string
  promptVersion: string
  inputReceipt: string
  inputBytes: number
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }
}

export type ReliabilityContractAuthorship =
  | {
    version: 1
    mode: 'current-agent' | 'manual'
    assurance: 'caller-declared'
  }
  | (ReliabilityAuxiliaryDraftAuthorship & { draftReceipt: string })

/** Privacy-minimized record of one successful auxiliary contract-authoring call. */
export interface ReliabilityContractDraft {
  version: 1
  contractKind: 'general' | 'code'
  objective: string
  claims: ReliabilityClaim[]
  checks: ReliabilityCheck[]
  coverageAssessment: ReliabilityCoverageAssessment
  authorship: ReliabilityAuxiliaryDraftAuthorship
  receipt: string
}

/** Privacy-minimized result of one deployment-controlled code verifier run. */
export interface CodeVerificationResult {
  version: 1
  verificationId: string
  profile: string
  profileReceipt: string
  passed: boolean
  failureKind?: 'exit' | 'timeout' | 'configuration' | 'infrastructure'
  exitCode: number | null
  signal: string | null
  durationMs: number
  sandboxMode: 'read-only' | 'workspace-write'
  sandboxEnforcement?: 'full' | 'partial'
  stdout: { bytes: number; truncated: boolean; receipt: string }
  stderr: { bytes: number; truncated: boolean; receipt: string }
  receipt: string
}

interface ReliabilityContractBase {
  contractId: string
  objective: string
  checks: ReliabilityCheck[]
  maxAttempts: number
  startedAtSeq: number
}

/** Legacy immutable contract retained so existing session logs remain readable. */
export interface ReliabilityContractV1 extends ReliabilityContractBase {
  version: 1
}

/** Claim-covered immutable contract used by current model-facing tools. */
export interface ReliabilityContractV2 extends ReliabilityContractBase {
  version: 2
  claims: ReliabilityClaim[]
  coverageAssessment: ReliabilityCoverageAssessment
}

/** Claim-covered contract with explicit authorship provenance. */
export interface ReliabilityContractV3 extends ReliabilityContractBase {
  version: 3
  claims: ReliabilityClaim[]
  coverageAssessment: ReliabilityCoverageAssessment
  authorship: ReliabilityContractAuthorship
}

export type ReliabilityContract = ReliabilityContractV1 | ReliabilityContractV2 | ReliabilityContractV3

/** One check's privacy-minimized deterministic verdict. */
export interface ReliabilityCheckResult {
  id: string
  kind: ReliabilityCheck['kind'] | 'governor_error'
  passed: boolean
  evidence: string
}

/** One complete evaluation of a contract. */
export interface ReliabilityAttempt {
  contractId: string
  attempt: number
  trigger: 'manual' | 'turn-stop'
  passed: boolean
  results: ReliabilityCheckResult[]
  receipt: string
}

/** Terminal fail-closed outcome. */
export interface ReliabilityTerminal {
  contractId: string
  status: 'certified' | 'exhausted' | 'abstained'
  reason: string
  attemptReceipt?: string
  receipt: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Opens a new evidence-gated completion contract. */
    'reliability/contract': ReliabilityContract
    /** Records an immutable deterministic verification attempt. */
    'reliability/attempt': ReliabilityAttempt
    /** Records certification, exhausted repair budget, or explicit abstention. */
    'reliability/terminal': ReliabilityTerminal
    /** Records one trusted, deployment-configured code verification result. */
    'reliability/code-verification': CodeVerificationResult
    /** Records one bounded auxiliary-model claim/check draft without raw prompts or reasoning. */
    'reliability/contract-draft': ReliabilityContractDraft
  }
}

export interface FoldedReliabilityState {
  latestDraft?: ReliabilityContractDraft
  contract?: ReliabilityContract
  attempts: ReliabilityAttempt[]
  terminal?: ReliabilityTerminal
}

/** Reconstruct the latest governor state from the durable session log. */
export function foldReliability(events: readonly SessionEvent[]): FoldedReliabilityState {
  let latestDraft: ReliabilityContractDraft | undefined
  let contract: ReliabilityContract | undefined
  let attempts: ReliabilityAttempt[] = []
  let terminal: ReliabilityTerminal | undefined

  for (const event of events) {
    if (event.type === 'reliability/contract-draft') {
      latestDraft = event.data
    } else if (event.type === 'reliability/contract') {
      contract = event.data
      attempts = []
      terminal = undefined
    } else if (event.type === 'reliability/attempt' && event.data.contractId === contract?.contractId) {
      attempts.push(event.data)
    } else if (event.type === 'reliability/terminal' && event.data.contractId === contract?.contractId) {
      terminal = event.data
    }
  }

  return {
    ...(latestDraft === undefined ? {} : { latestDraft }),
    ...(contract === undefined ? {} : { contract }),
    attempts,
    ...(terminal === undefined ? {} : { terminal }),
  }
}
