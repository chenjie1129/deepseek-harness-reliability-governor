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

/** Immutable completion contract written before verification. */
export interface ReliabilityContract {
  version: 1
  contractId: string
  objective: string
  checks: ReliabilityCheck[]
  maxAttempts: number
  startedAtSeq: number
}

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
  }
}

export interface FoldedReliabilityState {
  contract?: ReliabilityContract
  attempts: ReliabilityAttempt[]
  terminal?: ReliabilityTerminal
}

/** Reconstruct the latest governor state from the durable session log. */
export function foldReliability(events: readonly SessionEvent[]): FoldedReliabilityState {
  let contract: ReliabilityContract | undefined
  let attempts: ReliabilityAttempt[] = []
  let terminal: ReliabilityTerminal | undefined

  for (const event of events) {
    if (event.type === 'reliability/contract') {
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
    ...(contract === undefined ? {} : { contract }),
    attempts,
    ...(terminal === undefined ? {} : { terminal }),
  }
}
