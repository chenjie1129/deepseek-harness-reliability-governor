/**
 * Evidence-gated completion and bounded repair for DeepSeek Harness.
 * @module @chenjie1129/dsh-reliability-governor-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type { JsonValue, Session } from '@deepseek-ai/dsh-session'
import * as SessionRuntime from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-questions'
import {
  appendAttempt,
  appendTerminal,
  createContract,
  evaluateContract,
  validateChecks,
} from './governor.js'
import { assessContractCoverage } from './coverage.js'
import {
  draftContract,
  resolveContractAuthoringConfig,
} from './contract-author.js'
import type {
  ContractAuthoringConfig,
  ResolvedContractAuthoringConfig,
} from './contract-author.js'
import {
  resolveCodeVerificationProfiles,
  runCodeVerification,
} from './code-verifier.js'
import type {
  CodeVerificationProfileConfig,
  ResolvedCodeVerificationProfile,
} from './code-verifier.js'
import {
  appendBusinessOutcomeContract,
  appendBusinessOutcomeObservation,
  appendBusinessOutcomeTerminal,
  createBusinessOutcomeContract,
  evaluateBusinessOutcome,
  resolveBusinessOutcomeProfiles,
  runBusinessOutcomeProfile,
  summarizeBusinessOutcomeProfile,
} from './outcome.js'
import type {
  BusinessOutcomeProfileConfig,
  ResolvedBusinessOutcomeProfile,
} from './outcome.js'
import { registerCodeVerificationSkill } from './skill.js'
import { foldReliability } from './types.js'
import type {
  BusinessOutcomeContract,
  BusinessOutcomeProbe,
  ReliabilityCheck,
  ReliabilityCheckResult,
  ReliabilityClaim,
  ReliabilityContractAuthorship,
  ReliabilityContractDraft,
} from './types.js'
import { canonicalJsonForComparison } from './receipts.js'
import {
  createReviewProposal,
  requestContractReview,
  resolveContractReviewConfig,
} from './contract-review.js'
import type {
  ContractReviewConfig,
  ResolvedContractReviewConfig,
} from './contract-review.js'
import type { ReliabilityContract, ReliabilityContractV3, ReliabilityContractV5 } from './types.js'
import { registerReliabilitySessionEventTypes } from './session-compat.js'
import {
  createIntent,
  createIntentReviewProposal,
  requestIntentReview,
} from './intent-review.js'
import type { ToolIntentInput } from './intent-review.js'

export * from './governor.js'
export * from './coverage.js'
export * from './types.js'
export * from './a2ui.js'
export * from './contract-review.js'
export * from './intent-review.js'
export * from './session-compat.js'
export * from './outcome.js'

export const name = 'reliability-governor'
export const inject = [
  'tools', 'systemPrompt', 'fs', 'skills', 'subprocess', 'sandbox', 'sandboxPolicy', 'llm', 'userQuestions',
]

export interface Config {
  /** Hard ceiling; a contract may request fewer attempts. */
  maxAttempts?: number
  /** Maximum checks in one contract. */
  maxChecks?: number
  /** Maximum UTF-8 bytes read for one content-bearing file check. */
  maxFileBytes?: number
  /** Verify an unresolved contract whenever the agent would otherwise stop. */
  autoVerifyAtTurnStop?: boolean
  /** Deployment-controlled verifier commands. Model input selects only an id. */
  codeVerificationProfiles?: CodeVerificationProfileConfig[]
  /** Per-stream in-memory output bound. Raw output is never stored in receipts. */
  codeVerificationMaxOutputBytes?: number
  /** Deployment-controlled, read-only business outcome observers and immutable goal policies. */
  businessOutcomeProfiles?: BusinessOutcomeProfileConfig[]
  /** Per-observation output bound. Raw metric output is never stored in receipts. */
  businessOutcomeMaxOutputBytes?: number
  /** Select who proposes the initial claim/check set. Certification remains deterministic in every mode. */
  contractAuthoring?: ContractAuthoringConfig
  /** Require a UI-backed user decision over the exact contract before activation. */
  contractReview?: ContractReviewConfig
}

const CodeVerificationProfileSchema = z.object({
  id: z.string(),
  description: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().default(120_000),
  sandboxMode: z.union(['read-only', 'workspace-write'] as const).default('read-only'),
  required: z.boolean().default(true),
})

const BusinessOutcomePredicateSchema = z.object({
  id: z.string(),
  metric: z.string(),
  operator: z.union(['gte', 'lte', 'eq', 'delta-gte', 'delta-lte'] as const),
  value: z.number(),
})

const BusinessOutcomeProfileSchema = z.object({
  id: z.string(),
  description: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().default(120_000),
  metrics: z.array(z.object({
    name: z.string(),
    unit: z.string(),
  })),
  target: BusinessOutcomePredicateSchema,
  guardrails: z.array(BusinessOutcomePredicateSchema).default([]),
  minimumSampleSize: z.number(),
  maxDataAgeMs: z.number().default(24 * 60 * 60 * 1_000),
  notBeforeMs: z.number().default(0),
  deadlineMs: z.number().default(7 * 24 * 60 * 60 * 1_000),
  attribution: z.union(['direct', 'correlational', 'experiment'] as const).default('correlational'),
})

const ContractAuthoringSchema = z.object({
  mode: z.union(['current-agent', 'auxiliary-model', 'manual'] as const).default('current-agent'),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  maxInputBytes: z.number().default(32 * 1024),
  maxOutputTokens: z.number().default(3_000),
  timeoutMs: z.number().default(45_000),
})

const ContractReviewSchema = z.object({
  mode: z.union(['required', 'off'] as const).default('required'),
})

export const Config: z<Config> = z.object({
  maxAttempts: z.number().default(3),
  maxChecks: z.number().default(20),
  maxFileBytes: z.number().default(1024 * 1024),
  autoVerifyAtTurnStop: z.boolean().default(true),
  codeVerificationProfiles: z.array(CodeVerificationProfileSchema).default([]),
  codeVerificationMaxOutputBytes: z.number().default(64 * 1024),
  businessOutcomeProfiles: z.array(BusinessOutcomeProfileSchema).default([]),
  businessOutcomeMaxOutputBytes: z.number().default(64 * 1024),
  contractAuthoring: ContractAuthoringSchema,
  contractReview: ContractReviewSchema,
})

interface ResolvedConfig {
  maxAttempts: number
  maxChecks: number
  maxFileBytes: number
  autoVerifyAtTurnStop: boolean
  codeVerificationProfiles: ResolvedCodeVerificationProfile[]
  codeVerificationMaxOutputBytes: number
  businessOutcomeProfiles: ResolvedBusinessOutcomeProfile[]
  businessOutcomeMaxOutputBytes: number
  contractAuthoring: ResolvedContractAuthoringConfig
  contractReview: ResolvedContractReviewConfig
}

function positiveSafeInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`reliability-governor: ${name} must be an integer from 1 to ${maximum}`)
  }
  return value
}

export function resolveConfig(config: Config = {}): ResolvedConfig {
  const unknown = Object.keys(config).filter(key => ![
    'maxAttempts',
    'maxChecks',
    'maxFileBytes',
    'autoVerifyAtTurnStop',
    'codeVerificationProfiles',
    'codeVerificationMaxOutputBytes',
    'businessOutcomeProfiles',
    'businessOutcomeMaxOutputBytes',
    'contractAuthoring',
    'contractReview',
  ].includes(key))
  if (unknown.length > 0) throw new Error(`reliability-governor: unknown config key(s): ${unknown.join(', ')}`)
  return {
    maxAttempts: positiveSafeInteger('maxAttempts', config.maxAttempts ?? 3, 10),
    maxChecks: positiveSafeInteger('maxChecks', config.maxChecks ?? 20, 100),
    maxFileBytes: positiveSafeInteger('maxFileBytes', config.maxFileBytes ?? 1024 * 1024, 10 * 1024 * 1024),
    autoVerifyAtTurnStop: config.autoVerifyAtTurnStop ?? true,
    codeVerificationProfiles: resolveCodeVerificationProfiles(config.codeVerificationProfiles),
    codeVerificationMaxOutputBytes: positiveSafeInteger(
      'codeVerificationMaxOutputBytes',
      config.codeVerificationMaxOutputBytes ?? 64 * 1024,
      1024 * 1024,
    ),
    businessOutcomeProfiles: resolveBusinessOutcomeProfiles(config.businessOutcomeProfiles),
    businessOutcomeMaxOutputBytes: positiveSafeInteger(
      'businessOutcomeMaxOutputBytes',
      config.businessOutcomeMaxOutputBytes ?? 64 * 1024,
      1024 * 1024,
    ),
    contractAuthoring: resolveContractAuthoringConfig(config.contractAuthoring),
    contractReview: resolveContractReviewConfig(config.contractReview),
  }
}

const CHECK_SCHEMA = {
  oneOf: [
    {
      type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, kind: { type: 'string', const: 'file_exists', required: true },
        path: { type: 'string', required: true },
      },
    },
    {
      type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, kind: { type: 'string', const: 'file_absent', required: true },
        path: { type: 'string', required: true },
      },
    },
    {
      type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, kind: { type: 'string', const: 'file_contains', required: true },
        path: { type: 'string', required: true }, text: { type: 'string', required: true },
      },
    },
    {
      type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, kind: { type: 'string', const: 'file_not_contains', required: true },
        path: { type: 'string', required: true }, text: { type: 'string', required: true },
      },
    },
    {
      type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, kind: { type: 'string', const: 'file_equals', required: true },
        path: { type: 'string', required: true }, text: { type: 'string', required: true },
      },
    },
    {
      type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, kind: { type: 'string', const: 'json_equals', required: true },
        path: { type: 'string', required: true }, pointer: { type: 'string', required: true },
        value: { type: 'json', required: true },
      },
    },
    {
      type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, kind: { type: 'string', const: 'tool_succeeded', required: true },
        tool: { type: 'string', required: true }, argumentsContain: { type: 'string' }, minCount: { type: 'integer' },
      },
    },
    {
      type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, kind: { type: 'string', const: 'tool_not_called', required: true },
        tool: { type: 'string', required: true },
      },
    },
    {
      type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, kind: { type: 'string', const: 'code_verification_succeeded', required: true },
        profile: { type: 'string', required: true }, minCount: { type: 'integer' },
      },
    },
    {
      type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, kind: { type: 'string', const: 'no_tool_errors', required: true },
      },
    },
  ],
} as const

const CLAIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    statement: { type: 'string', required: true },
    importance: {
      type: 'string',
      enum: ['critical', 'important', 'minor'],
      required: true,
    },
    verification: {
      type: 'string',
      enum: ['deterministic', 'human-required', 'unsupported'],
      required: true,
    },
    check_ids: { type: 'array', required: true, items: { type: 'string' } },
    minimum_independent_sources: { type: 'integer' },
  },
} as const

const INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    constraints: {
      type: 'array', items: { type: 'string' },
      description: 'User constraints that the implementation and evidence contract must preserve.',
    },
    assumptions: {
      type: 'array', items: { type: 'string' },
      description: 'Material assumptions made while interpreting the request.',
    },
    non_goals: {
      type: 'array', items: { type: 'string' },
      description: 'Explicit outcomes or changes outside this task.',
    },
    ambiguities: {
      type: 'array', items: { type: 'string' },
      description: 'Remaining ambiguities the user should resolve or consciously accept.',
    },
  },
} as const

interface ToolClaim {
  id: string
  statement: string
  importance: ReliabilityClaim['importance']
  verification: ReliabilityClaim['verification']
  check_ids: string[]
  minimum_independent_sources?: number
}

function normalizeClaims(claims: ToolClaim[]): ReliabilityClaim[] {
  return claims.map(claim => ({
    id: claim.id,
    statement: claim.statement,
    importance: claim.importance,
    verification: claim.verification,
    checkIds: claim.check_ids,
    ...(claim.minimum_independent_sources === undefined
      ? {}
      : { minimumIndependentSources: claim.minimum_independent_sources }),
  }))
}

function promptFor(
  mode: ResolvedContractAuthoringConfig['mode'],
  reviewMode: ResolvedContractReviewConfig['mode'],
  hasBusinessOutcomeProfiles: boolean,
): string {
  const authoring = mode === 'auxiliary-model'
    ? `Contract authorship mode is auxiliary-model. After read-only exploration and before mutation, call reliability_draft with contract_kind (general or code), the objective, and a concise, non-secret context summary. Review its assessment. For general work, pass the returned draft_receipt and exact objective, claims, and checks unchanged to reliability_begin. For code work with required trusted profiles, pass those exact fields to reliability_begin_code; required profiles are injected before the draft receipt is created. The auxiliary model has no tools or certification authority. Do not bypass, edit, reuse, or impersonate its receipt.`
    : mode === 'manual'
      ? `Contract authorship mode is manual. Do not invent a claim set. Use only a contract supplied by the user or a reviewed reference source. The runtime records this as caller-declared provenance, not authenticated human approval. If no such contract is available, explain that manual input is required. Deployment-required code profiles may still be opened through reliability_begin_code.`
      : `Contract authorship mode is current-agent. Draft the claims and checks yourself, then preflight them with reliability_assess before reliability_begin.`
  const review = reviewMode === 'required'
    ? 'Two-stage review is required. After bounded read-only discovery and before mutation, reliability_begin and reliability_begin_code first show the interpreted objective, constraints, assumptions, non-goals, and ambiguities to the live root user. Only exact intent approval proceeds to a separate evidence-contract review. Only approval of both receipt-bound proposals opens a version 5 contract. Include the intent object on every begin call. Revision, rejection, cancellation, unavailable UI, or malformed response at either stage leaves the contract inactive. Never claim that either approval certifies the later outcome.'
    : 'Contract review mode is off for this unattended deployment. No human approval is claimed or recorded.'
  const outcome = hasBusinessOutcomeProfiles
    ? `Deployment-controlled business outcome profiles are available. Before mutation, list them with reliability_outcome_profiles and pass the exact applicable profile id as outcome_profile to reliability_begin or reliability_begin_code. The evidence review binds the profile's KPI, threshold, observation window, attribution mode, and guardrails. Delivery certification does not mean the business goal was achieved. After delivery certification, use reliability_outcome_observe until the outcome becomes achieved, missed, inconclusive, or expired.`
    : 'No deployment-controlled business outcome profiles are configured. Do not claim that delivery checks prove downstream business impact.'
  return `Reliability Governor is available for evidence-gated completion.

${authoring}

${review}

${outcome}

For a substantive task with observable success criteria—especially code/file changes, tool workflows, or a user request for stable/reliable execution—map every success claim to evidence before opening a contract. Use the smallest independent evidence set that covers every claim; multiple checks over one file or tool are one source, not independent corroboration. The governor evaluates coverage and checks without using an LLM and records durable receipts.

For coding tasks, first load the reliability-code-verification skill. If required trusted profiles are configured, use reliability_begin_code instead of reliability_begin. Run every required profile through reliability_code_verify after implementation; ordinary shell/test calls are useful diagnostics but do not substitute for trusted profile evidence.

While a contract is active:
- Do not say the task is complete until status is certified.
- Repair only the failed checks, then call reliability_verify or let the turn-stop verifier run.
- Run trusted code-verification profiles after all ordinary tool calls, with workspace-write profiles before read-only profiles. Any later non-governor tool call, or a different workspace-write profile, invalidates earlier trusted results and requires a rerun.
- Use file_contains only for requirements that truly demand that literal. Prefer file_equals or json_equals when exact file or structured value semantics are intended.
- Use no_tool_errors only when a clean error-free trajectory is itself required; a recovered intermediate error does not prove the final outcome failed.
- Never repeat a non-idempotent external action merely because its outcome is unknown; inspect state or abstain instead.
- If coverage assessment says a claim needs credentials, human judgment, or an unsupported oracle, do not activate or claim completion; explain the limitation. If proof becomes unavailable after a contract is active, call reliability_abstain.

Coverage is structural, not semantic: it cannot detect a success claim omitted from the contract or decide whether a claim faithfully represents even an approved intent. The two review stages expose that mapping to the user; they do not make it automatically correct. Prefer independently authored references for high-impact work. Treat a review-required assessment as a reason to revise the contract or decline certification, never as permission to proceed without evidence.

Use no contract for casual conversation or work with no meaningful observable completion condition.`
}

function requireAgent(exec: { agent?: Agent }): Agent {
  if (exec.agent === undefined) throw new Error('reliability tools require an Agent-backed session')
  return exec.agent
}

function failures(results: ReliabilityCheckResult[]): string {
  return results.filter(item => !item.passed).map(item => `${item.id}: ${item.evidence}`).join('; ')
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue
}

function callerAuthorship(mode: 'current-agent' | 'manual'): ReliabilityContractAuthorship {
  return { version: 1, mode, assurance: 'caller-declared' }
}

function requireBoundDraft(
  draft: ReliabilityContractDraft | undefined,
  receipt: string | undefined,
  objective: string,
  claims: ReliabilityClaim[],
  checks: ReliabilityCheck[],
): ReliabilityContractDraft {
  if (receipt === undefined || receipt.trim().length === 0) {
    throw new Error('auxiliary-model mode requires draft_receipt from reliability_draft')
  }
  if (draft === undefined || draft.receipt !== receipt) {
    throw new Error('draft_receipt does not match the latest successful reliability_draft event')
  }
  const proposed = { objective: objective.trim(), claims, checks }
  const recorded = { objective: draft.objective, claims: draft.claims, checks: draft.checks }
  if (canonicalJsonForComparison(proposed) !== canonicalJsonForComparison(recorded)) {
    throw new Error('objective, claims, and checks must exactly match the receipt-bound auxiliary draft')
  }
  return draft
}

function bindAuxiliaryDraft(
  session: Session,
  draft: ReliabilityContractDraft | undefined,
  receipt: string | undefined,
  objective: string,
  claims: ReliabilityClaim[],
  checks: ReliabilityCheck[],
): { draft: ReliabilityContractDraft; authorship: ReliabilityContractAuthorship } {
  const boundDraft = requireBoundDraft(draft, receipt, objective, claims, checks)
  if (session.events.some(event => event.type === 'reliability/contract'
    && (event.data.version === 3 || event.data.version === 4 || event.data.version === 5)
    && event.data.authorship.mode === 'auxiliary-model'
    && event.data.authorship.draftReceipt === boundDraft.receipt)) {
    throw new Error('draft_receipt has already been used to open a contract; request a fresh draft')
  }
  return {
    draft: boundDraft,
    authorship: { ...boundDraft.authorship, draftReceipt: boundDraft.receipt },
  }
}

async function verify(
  ctx: Context,
  session: Session,
  config: ResolvedConfig,
  trigger: 'manual' | 'turn-stop',
  signal: AbortSignal,
) {
  const state = foldReliability(session.events)
  if (state.contract === undefined) throw new Error('no reliability contract exists in this session')
  if (state.terminal !== undefined) return { state, attempt: undefined }
  const results = await evaluateContract(state.contract, {
    fs: ctx.fs,
    session,
    signal,
    maxFileBytes: config.maxFileBytes,
  })
  const attempt = appendAttempt(session, state.contract, state.attempts.length, trigger, results)
  return { state: foldReliability(session.events), attempt }
}

function pluginMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name },
  })
}

function requireAuthoredContract(contract: ReliabilityContract): ReliabilityContractV3 {
  if (contract.version !== 3) throw new Error('internal error: reviewed activation requires an authored contract')
  return contract
}

async function activateContract(
  ctx: Context,
  agent: Agent,
  contractKind: 'general' | 'code',
  candidate: ReliabilityContract,
  intentInput: ToolIntentInput | undefined,
  authoringMode: ResolvedContractAuthoringConfig['mode'],
  reviewConfig: ResolvedContractReviewConfig,
  pendingReviews: WeakSet<Agent>,
  signal: AbortSignal,
  outcomeProfile?: ResolvedBusinessOutcomeProfile,
  outcomeMaxOutputBytes?: number,
): Promise<{
  status: string
  contract?: ReliabilityContract
  outcomeContract?: BusinessOutcomeContract
  baseline?: BusinessOutcomeProbe
  intentReview?: unknown
  review?: unknown
  feedback?: string
}> {
  const activate = async (contract: ReliabilityContract): Promise<{
    status: string
    contract?: ReliabilityContract
    outcomeContract?: BusinessOutcomeContract
    baseline?: BusinessOutcomeProbe
  }> => {
    if (outcomeProfile === undefined) {
      agent.session.append('reliability/contract', contract)
      return { status: 'active', contract }
    }
    const baseline = await runBusinessOutcomeProfile(
      ctx,
      agent,
      outcomeProfile,
      outcomeMaxOutputBytes ?? 64 * 1024,
      signal,
    )
    if (!baseline.succeeded) return { status: 'outcome-baseline-failed', baseline }
    const outcomeContract = createBusinessOutcomeContract(contract, outcomeProfile, baseline, Date.now())
    agent.session.append('reliability/contract', contract)
    appendBusinessOutcomeContract(agent.session, outcomeContract)
    return { status: 'active', contract, outcomeContract, baseline }
  }
  if (reviewConfig.mode === 'off') {
    return activate(candidate)
  }
  const authored = requireAuthoredContract(candidate)
  if (pendingReviews.has(agent)) {
    throw new Error('a contract review is already pending for this live agent')
  }
  pendingReviews.add(agent)
  try {
    const intent = createIntent(authored.objective, intentInput, authoringMode)
    const intentResult = await requestIntentReview(
      ctx,
      agent,
      createIntentReviewProposal(intent),
      signal,
    )
    if (intentResult.approvedIntent === undefined) {
      const status = intentResult.review.decision === 'cancelled'
        ? 'intent-review-cancelled'
        : intentResult.review.decision === 'unavailable'
          ? 'intent-review-unavailable'
          : `intent-${intentResult.review.decision}`
      return {
        status,
        intentReview: intentResult.review,
        ...(intentResult.feedback === undefined ? {} : { feedback: intentResult.feedback }),
      }
    }
    const proposal = createReviewProposal({
      contractId: authored.contractId,
      contractKind,
      objective: authored.objective,
      claims: authored.claims,
      checks: authored.checks,
      maxAttempts: authored.maxAttempts,
      authorship: authored.authorship,
      coverageAssessment: authored.coverageAssessment,
      intent: intentResult.approvedIntent,
      ...(outcomeProfile === undefined
        ? {}
        : { businessOutcome: summarizeBusinessOutcomeProfile(outcomeProfile) }),
    })
    const result = await requestContractReview(ctx, agent, proposal, signal)
    if (result.reference === undefined) {
      const status = result.review.decision === 'cancelled'
        ? 'review-cancelled'
        : result.review.decision === 'unavailable'
          ? 'review-unavailable'
          : result.review.decision
      return {
        status,
        intentReview: intentResult.review,
        review: result.review,
        ...(result.feedback === undefined ? {} : { feedback: result.feedback }),
      }
    }
    const contract: ReliabilityContractV5 = structuredClone({
      ...authored,
      version: 5 as const,
      intent: intentResult.approvedIntent,
      review: result.reference,
    })
    const activated = await activate(contract)
    return { ...activated, intentReview: intentResult.review, review: result.review }
  } finally {
    pendingReviews.delete(agent)
  }
}

/** Register the prompt policy, tools, durable events, and bounded stopping hook. */
export function apply(ctx: Context, rawConfig: Config = {}): void {
  registerReliabilitySessionEventTypes(SessionRuntime)
  const config = resolveConfig(rawConfig)
  const pendingReviews = new WeakSet<Agent>()

  registerCodeVerificationSkill(ctx)
  ctx.systemPrompt.section({
    name: 'reliability:policy',
    order: 118,
    text: promptFor(
      config.contractAuthoring.mode,
      config.contractReview.mode,
      config.businessOutcomeProfiles.length > 0,
    ),
  })

  if (config.contractAuthoring.mode === 'auxiliary-model') {
    const authorConfig = config.contractAuthoring
    ctx.tools.register(defineTool({
      name: 'reliability_draft',
      description: 'Ask the configured isolated auxiliary model for a bounded claim/check draft. It receives text only, has no tools, cannot mutate the workspace, cannot certify, and is never used as an outcome judge. Do not include secrets in context.',
      parameters: {
        contract_kind: {
          type: 'string', enum: ['general', 'code'], required: true,
          description: 'Use code when the contract must include every deployment-required trusted code-verification profile.',
        },
        objective: { type: 'string', required: true, description: 'Concise outcome the future contract must cover.' },
        context: { type: 'string', description: 'Optional concise read-only facts needed to identify claims, paths, tool names, and constraints. Never include secrets.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const session = requireAgent(exec).session
        const result = await draftContract(ctx, {
          contractKind: args.contract_kind,
          objective: args.objective,
          ...(args.context === undefined ? {} : { context: args.context }),
          availableCodeProfiles: config.codeVerificationProfiles.map(profile => ({
            id: profile.id,
            description: profile.description,
            required: profile.required,
          })),
        }, authorConfig, config, exec.signal)
        session.append('reliability/contract-draft', result.draft)
        return asJson({
          status: result.draft.coverageAssessment.status === 'ready' ? 'drafted' : 'review-required',
          draft: {
            contract_kind: result.draft.contractKind,
            objective: result.draft.objective,
            claims: result.toolClaims,
            checks: result.draft.checks,
            draft_receipt: result.draft.receipt,
          },
          assessment: result.draft.coverageAssessment,
          authorship: result.draft.authorship,
        })
      },
    }))
  }

  ctx.tools.register(defineTool({
    name: 'reliability_assess',
    description: 'Preview whether declared success claims have enough distinct deterministic evidence before opening a contract. Several checks against one file, tool, or verifier profile count as one evidence source. This does not evaluate task output.',
    parameters: {
      objective: { type: 'string', required: true, description: 'Concise outcome the claims are meant to cover.' },
      claims: { type: 'array', required: true, items: CLAIM_SCHEMA, description: 'Declared success claims and their supporting check ids.' },
      checks: { type: 'array', required: true, items: CHECK_SCHEMA, description: 'Proposed deterministic assertions. May be empty when assessment should expose unsupported or human-only claims.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(args) {
      const checks = args.checks as ReliabilityCheck[]
      validateChecks(checks, config, false)
      const assessment = assessContractCoverage({
        objective: args.objective,
        claims: normalizeClaims(args.claims as ToolClaim[]),
        checks,
      })
      return Promise.resolve(asJson({ status: assessment.status, assessment }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'reliability_begin',
    description: 'Open one durable, evidence-gated completion contract for the current session. Use before claiming a substantive verifiable task is complete. Only deterministic checks are accepted; paths are workspace-relative.',
    parameters: {
      objective: { type: 'string', required: true, description: 'Concise outcome this contract must prove.' },
      intent: { ...INTENT_SCHEMA, description: 'Required in interactive review mode. Makes the interpreted constraints, assumptions, non-goals, and ambiguities explicit before evidence review.' },
      claims: { type: 'array', required: true, items: CLAIM_SCHEMA, description: 'Every declared success claim mapped to supporting check ids.' },
      checks: { type: 'array', required: true, items: CHECK_SCHEMA, description: 'Deterministic assertions that collectively prove the outcome.' },
      outcome_profile: { type: 'string', description: 'Optional deployment-controlled business outcome profile id. Its goal is receipt-bound into evidence review and observed after delivery certification.' },
      max_attempts: { type: 'integer', description: `Optional repair budget, capped by deployment at ${config.maxAttempts}.` },
      draft_receipt: { type: 'string', description: 'Required in auxiliary-model mode; returned by reliability_draft.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const session = agent.session
      const state = foldReliability(session.events)
      if (state.contract !== undefined && state.terminal === undefined) {
        throw new Error(`contract ${state.contract.contractId} is still active; verify or abstain before opening another`)
      }
      const checks = args.checks as ReliabilityCheck[]
      const claims = normalizeClaims(args.claims as ToolClaim[])
      const outcomeProfile = args.outcome_profile === undefined
        ? undefined
        : config.businessOutcomeProfiles.find(profile => profile.id === args.outcome_profile)
      if (args.outcome_profile !== undefined && outcomeProfile === undefined) {
        throw new Error(`unknown business outcome profile: ${args.outcome_profile}`)
      }
      validateChecks(checks, config)
      const assessment = assessContractCoverage({ objective: args.objective, claims, checks })
      if (assessment.status !== 'ready') {
        return asJson({ status: 'review-required', assessment })
      }
      const binding = config.contractAuthoring.mode === 'auxiliary-model'
        ? bindAuxiliaryDraft(session, state.latestDraft, args.draft_receipt, args.objective, claims, checks)
        : undefined
      const authorship: ReliabilityContractAuthorship = binding === undefined
        ? callerAuthorship(config.contractAuthoring.mode as 'current-agent' | 'manual')
        : binding.authorship
      if (config.contractAuthoring.mode !== 'auxiliary-model' && args.draft_receipt !== undefined) {
        throw new Error('draft_receipt is accepted only in auxiliary-model mode')
      }
      const contract = createContract({
        objective: args.objective,
        claims,
        checks,
        authorship,
        ...(args.max_attempts === undefined ? {} : { maxAttempts: args.max_attempts }),
      }, session.seq, config)
      return asJson(await activateContract(
        ctx, agent, 'general', contract, args.intent as ToolIntentInput | undefined,
        config.contractAuthoring.mode, config.contractReview, pendingReviews, exec.signal,
        outcomeProfile, config.businessOutcomeMaxOutputBytes,
      ))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'reliability_begin_code',
    description: 'Open a code completion contract that automatically includes every deployment-required trusted code-verification profile. The model may add checks but cannot remove required profiles.',
    parameters: {
      objective: { type: 'string', required: true, description: 'Concrete code outcome to prove.' },
      intent: { ...INTENT_SCHEMA, description: 'Required in interactive review mode. Makes the interpreted constraints, assumptions, non-goals, and ambiguities explicit before evidence review.' },
      additional_checks: { type: 'array', items: CHECK_SCHEMA, description: 'Optional deterministic artifact or policy checks in addition to all required code profiles.' },
      additional_claims: { type: 'array', items: CLAIM_SCHEMA, description: 'Optional claims for additional checks. Required profile checks are mapped automatically.' },
      claims: { type: 'array', items: CLAIM_SCHEMA, description: 'Exact full claim set returned by reliability_draft; used only in auxiliary-model mode.' },
      checks: { type: 'array', items: CHECK_SCHEMA, description: 'Exact full check set returned by reliability_draft; used only in auxiliary-model mode.' },
      draft_receipt: { type: 'string', description: 'Exact code-draft receipt; required only in auxiliary-model mode.' },
      outcome_profile: { type: 'string', description: 'Optional deployment-controlled business outcome profile id. Its goal is receipt-bound into evidence review and observed after delivery certification.' },
      max_attempts: { type: 'integer', description: `Optional repair budget, capped by deployment at ${config.maxAttempts}.` },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const session = agent.session
      const state = foldReliability(session.events)
      if (state.contract !== undefined && state.terminal === undefined) {
        throw new Error(`contract ${state.contract.contractId} is still active; verify or abstain before opening another`)
      }
      const requiredProfiles = config.codeVerificationProfiles.filter(profile => profile.required)
      const outcomeProfile = args.outcome_profile === undefined
        ? undefined
        : config.businessOutcomeProfiles.find(profile => profile.id === args.outcome_profile)
      if (args.outcome_profile !== undefined && outcomeProfile === undefined) {
        throw new Error(`unknown business outcome profile: ${args.outcome_profile}`)
      }
      if (requiredProfiles.length === 0) {
        throw new Error('no required trusted code-verification profiles are configured; ask the deployment owner to configure codeVerificationProfiles')
      }
      let checks: ReliabilityCheck[]
      let claims: ReliabilityClaim[]
      let authorship: ReliabilityContractAuthorship
      if (config.contractAuthoring.mode === 'auxiliary-model') {
        if (args.additional_checks !== undefined || args.additional_claims !== undefined) {
          throw new Error('auxiliary-model code contracts require the exact full claims/checks draft, not additional fields')
        }
        checks = (args.checks ?? []) as ReliabilityCheck[]
        claims = normalizeClaims((args.claims ?? []) as ToolClaim[])
        const binding = bindAuxiliaryDraft(
          session,
          state.latestDraft,
          args.draft_receipt,
          args.objective,
          claims,
          checks,
        )
        if (binding.draft.contractKind !== 'code') {
          throw new Error('reliability_begin_code requires a reliability_draft with contract_kind code')
        }
        for (const profile of requiredProfiles) {
          if (!checks.some(check => check.kind === 'code_verification_succeeded' && check.profile === profile.id)) {
            throw new Error(`receipt-bound code draft omitted required profile: ${profile.id}`)
          }
        }
        authorship = binding.authorship
      } else {
        if (args.claims !== undefined || args.checks !== undefined || args.draft_receipt !== undefined) {
          throw new Error('claims, checks, and draft_receipt are accepted by reliability_begin_code only in auxiliary-model mode')
        }
        const requiredChecks: ReliabilityCheck[] = requiredProfiles.map(profile => ({
          id: `code-profile-${profile.id}`,
          kind: 'code_verification_succeeded',
          profile: profile.id,
        }))
        const requiredProfileClaim: ReliabilityClaim = {
          id: 'required-code-verification',
          statement: 'Every deployment-required trusted code-verification profile passes on the final workspace state',
          importance: 'critical',
          verification: 'deterministic',
          checkIds: requiredChecks.map(check => check.id),
          minimumIndependentSources: 1,
        }
        checks = [...requiredChecks, ...((args.additional_checks ?? []) as ReliabilityCheck[])]
        claims = [requiredProfileClaim, ...normalizeClaims((args.additional_claims ?? []) as ToolClaim[])]
        authorship = callerAuthorship(config.contractAuthoring.mode)
      }
      validateChecks(checks, config)
      const assessment = assessContractCoverage({ objective: args.objective, claims, checks })
      if (assessment.status !== 'ready') {
        return Promise.resolve(asJson({ status: 'review-required', assessment }))
      }
      const contract = createContract({
        objective: args.objective,
        claims,
        checks,
        authorship,
        ...(args.max_attempts === undefined ? {} : { maxAttempts: args.max_attempts }),
      }, session.seq, config)
      const activated = await activateContract(
        ctx, agent, 'code', contract, args.intent as ToolIntentInput | undefined,
        config.contractAuthoring.mode, config.contractReview, pendingReviews, exec.signal,
        outcomeProfile, config.businessOutcomeMaxOutputBytes,
      )
      return asJson({
        ...activated,
        requiredProfiles: requiredProfiles.map(profile => profile.id),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'reliability_verify',
    description: 'Evaluate the active reliability contract now using deterministic workspace and session evidence. This never executes shell commands or repeats business actions.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      const session = requireAgent(exec).session
      const before = foldReliability(session.events)
      if (before.terminal !== undefined) {
        if (before.terminal.status === 'certified' && before.outcomeContract !== undefined) {
          return asJson({
            status: 'delivery-certified',
            outcomeStatus: before.outcomeTerminal?.status ?? 'observing',
            terminal: before.terminal,
            outcomeContract: before.outcomeContract,
            outcomeTerminal: before.outcomeTerminal,
          })
        }
        return asJson({ status: before.terminal.status, terminal: before.terminal })
      }
      const { state, attempt } = await verify(ctx, session, config, 'manual', exec.signal)
      if (attempt === undefined || state.contract === undefined) throw new Error('verification produced no attempt')
      if (attempt.passed) {
        const terminal = appendTerminal(session, state.contract, 'certified', 'all deterministic checks passed', attempt.receipt)
        if (state.outcomeContract !== undefined) {
          return asJson({
            status: 'delivery-certified',
            outcomeStatus: state.outcomeTerminal?.status ?? 'observing',
            attempt,
            terminal,
            outcomeContract: state.outcomeContract,
          })
        }
        return asJson({ status: 'certified', attempt, terminal })
      }
      if (attempt.attempt >= state.contract.maxAttempts) {
        const terminal = appendTerminal(session, state.contract, 'exhausted', failures(attempt.results), attempt.receipt)
        return asJson({ status: 'exhausted', attempt, terminal })
      }
      return asJson({ status: 'repair-required', attemptsRemaining: state.contract.maxAttempts - attempt.attempt, attempt })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'reliability_status',
    description: 'Read the latest durable reliability contract, attempts, terminal status, and receipts without changing state.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(_args, exec) {
      return Promise.resolve(asJson(foldReliability(requireAgent(exec).session.events)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'reliability_abstain',
    description: 'End the active contract without claiming completion when deterministic proof is impossible, unsafe, credential-blocked, or requires human judgment.',
    parameters: {
      reason: { type: 'string', required: true, description: 'Concrete reason the outcome cannot be certified safely.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(args, exec) {
      const session = requireAgent(exec).session
      const state = foldReliability(session.events)
      if (state.contract === undefined) throw new Error('no reliability contract exists in this session')
      if (state.terminal !== undefined) return Promise.resolve(asJson({ status: state.terminal.status, terminal: state.terminal }))
      const reason = args.reason.trim()
      if (reason.length === 0) throw new Error('reason must be non-empty')
      if (reason.length > 2_000) throw new Error('reason must be at most 2000 characters')
      const terminal = appendTerminal(session, state.contract, 'abstained', reason)
      return Promise.resolve(asJson({ status: 'abstained', terminal }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'reliability_code_profiles',
    description: 'List trusted code-verification profile metadata. Commands and arguments remain deployment-private so the model cannot rewrite the judge.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute() {
      return Promise.resolve(asJson({
        profiles: config.codeVerificationProfiles.map(profile => ({
          id: profile.id,
          description: profile.description,
          required: profile.required,
          timeoutMs: profile.timeoutMs,
          sandboxMode: profile.sandboxMode,
          profileReceipt: profile.profileReceipt,
        })),
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'reliability_code_verify',
    description: 'Run one immutable deployment-configured code verification profile through Harness-managed subprocess and sandbox services. The model supplies only the profile id.',
    parameters: {
      profile: { type: 'string', required: true, description: 'Exact id returned by reliability_code_profiles.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const profile = config.codeVerificationProfiles.find(candidate => candidate.id === args.profile)
      if (profile === undefined) throw new Error(`unknown trusted code-verification profile: ${args.profile}`)
      const result = await runCodeVerification(
        ctx,
        agent,
        profile,
        config.codeVerificationMaxOutputBytes,
        exec.signal,
      )
      agent.session.append('reliability/code-verification', result)
      return asJson({ status: result.passed ? 'passed' : 'failed', result })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'reliability_outcome_profiles',
    description: 'List deployment-controlled business outcome profiles. Profiles bind authoritative metrics, targets, guardrails, observation windows, and attribution policy without exposing executable configuration.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute() {
      return Promise.resolve(asJson({
        profiles: config.businessOutcomeProfiles.map(summarizeBusinessOutcomeProfile),
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'reliability_outcome_observe',
    description: 'Run the active deployment-controlled business outcome profile after delivery certification and evaluate its target, sample-size requirement, observation window, and guardrails.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      const agent = requireAgent(exec)
      const state = foldReliability(agent.session.events)
      if (state.outcomeContract === undefined) throw new Error('no business outcome contract exists in this session')
      if (state.outcomeTerminal !== undefined) {
        return asJson({ status: state.outcomeTerminal.status, terminal: state.outcomeTerminal })
      }
      if (state.terminal?.status !== 'certified') {
        throw new Error('business outcome observation requires certified delivery evidence')
      }
      const now = Date.now()
      if (now < state.outcomeContract.notBeforeAt) {
        return asJson({
          status: 'observing',
          reason: 'observation window has not opened',
          retryAt: state.outcomeContract.notBeforeAt,
          deadlineAt: state.outcomeContract.deadlineAt,
        })
      }
      const profile = config.businessOutcomeProfiles.find(candidate =>
        candidate.id === state.outcomeContract?.profile.id
        && candidate.profileReceipt === state.outcomeContract.profile.profileReceipt)
      if (profile === undefined) {
        throw new Error('business outcome profile is missing or changed since contract activation')
      }
      const probe = await runBusinessOutcomeProfile(
        ctx,
        agent,
        profile,
        config.businessOutcomeMaxOutputBytes,
        exec.signal,
      )
      const evaluatedAt = Date.now()
      const evaluation = evaluateBusinessOutcome(state.outcomeContract, probe, evaluatedAt)
      const observation = appendBusinessOutcomeObservation(agent.session, state.outcomeContract, probe, evaluation)
      if (evaluation.status === 'achieved' || evaluation.status === 'missed' || evaluation.status === 'inconclusive') {
        const terminalStatus = evaluation.status === 'inconclusive' && !probe.succeeded
          ? 'expired'
          : evaluation.status
        const terminal = appendBusinessOutcomeTerminal(
          agent.session,
          state.outcomeContract,
          terminalStatus,
          evaluation.reason,
          observation.receipt,
        )
        return asJson({ status: terminal.status, observation, terminal })
      }
      return asJson({
        status: 'observing',
        observation,
        retryAt: Math.max(evaluatedAt, state.outcomeContract.notBeforeAt),
        deadlineAt: state.outcomeContract.deadlineAt,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'reliability_outcome_status',
    description: 'Read the active business outcome contract, baseline, observations, terminal result, and receipts without running another observation.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(_args, exec) {
      const state = foldReliability(requireAgent(exec).session.events)
      return Promise.resolve(asJson({
        contract: state.outcomeContract,
        observations: state.outcomeObservations,
        terminal: state.outcomeTerminal,
      }))
    },
  }))

  if (config.autoVerifyAtTurnStop) {
    ctx.on('agent/turn-stopping', async ({ agent, signal }): Promise<void> => {
      const before = foldReliability(agent.session.events)
      if (before.contract === undefined || before.terminal !== undefined) return
      const { state, attempt } = await verify(ctx, agent.session, config, 'turn-stop', signal)
      if (attempt === undefined || state.contract === undefined) return

      if (attempt.passed) {
        const terminal = appendTerminal(agent.session, state.contract, 'certified', 'all deterministic checks passed', attempt.receipt)
        if (state.outcomeContract !== undefined) {
          agent.steer(pluginMessage(
            `Delivery evidence is certified, but the business outcome is still observing. `
            + `Do not claim that the business goal was achieved. Report delivery receipt ${terminal.receipt} `
            + `and outcome contract receipt ${state.outcomeContract.receipt}.`,
          ))
        } else {
          agent.steer(pluginMessage(`Reliability contract certified. Report the outcome truthfully and include receipt ${terminal.receipt}.`))
        }
        return
      }

      const detail = failures(attempt.results)
      if (attempt.attempt >= state.contract.maxAttempts) {
        const terminal = appendTerminal(agent.session, state.contract, 'exhausted', detail, attempt.receipt)
        agent.steer(pluginMessage(`Reliability repair budget exhausted. Do not claim completion. Explain these failed checks: ${detail}. Include receipt ${terminal.receipt}.`))
        return
      }

      agent.steer(pluginMessage(
        `Reliability verification failed (attempt ${attempt.attempt}/${state.contract.maxAttempts}). `
        + `Repair only these failed checks, avoid repeating non-idempotent actions with unknown outcomes, then verify again: ${detail}`,
      ))
    })
  }
}
