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
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
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
import { registerCodeVerificationSkill } from './skill.js'
import { foldReliability } from './types.js'
import type {
  ReliabilityCheck,
  ReliabilityCheckResult,
  ReliabilityClaim,
  ReliabilityContractAuthorship,
  ReliabilityContractDraft,
} from './types.js'
import { canonicalJsonForComparison } from './receipts.js'

export * from './governor.js'
export * from './coverage.js'
export * from './types.js'

export const name = 'reliability-governor'
export const inject = ['tools', 'systemPrompt', 'fs', 'skills', 'subprocess', 'sandbox', 'sandboxPolicy', 'llm']

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
  /** Select who proposes the initial claim/check set. Certification remains deterministic in every mode. */
  contractAuthoring?: ContractAuthoringConfig
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

const ContractAuthoringSchema = z.object({
  mode: z.union(['current-agent', 'auxiliary-model', 'manual'] as const).default('current-agent'),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  maxInputBytes: z.number().default(32 * 1024),
  maxOutputTokens: z.number().default(3_000),
  timeoutMs: z.number().default(45_000),
})

export const Config: z<Config> = z.object({
  maxAttempts: z.number().default(3),
  maxChecks: z.number().default(20),
  maxFileBytes: z.number().default(1024 * 1024),
  autoVerifyAtTurnStop: z.boolean().default(true),
  codeVerificationProfiles: z.array(CodeVerificationProfileSchema).default([]),
  codeVerificationMaxOutputBytes: z.number().default(64 * 1024),
  contractAuthoring: ContractAuthoringSchema,
})

interface ResolvedConfig {
  maxAttempts: number
  maxChecks: number
  maxFileBytes: number
  autoVerifyAtTurnStop: boolean
  codeVerificationProfiles: ResolvedCodeVerificationProfile[]
  codeVerificationMaxOutputBytes: number
  contractAuthoring: ResolvedContractAuthoringConfig
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
    'contractAuthoring',
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
    contractAuthoring: resolveContractAuthoringConfig(config.contractAuthoring),
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

function promptFor(mode: ResolvedContractAuthoringConfig['mode']): string {
  const authoring = mode === 'auxiliary-model'
    ? `Contract authorship mode is auxiliary-model. After read-only exploration and before mutation, call reliability_draft with contract_kind (general or code), the objective, and a concise, non-secret context summary. Review its assessment. For general work, pass the returned draft_receipt and exact objective, claims, and checks unchanged to reliability_begin. For code work with required trusted profiles, pass those exact fields to reliability_begin_code; required profiles are injected before the draft receipt is created. The auxiliary model has no tools or certification authority. Do not bypass, edit, reuse, or impersonate its receipt.`
    : mode === 'manual'
      ? `Contract authorship mode is manual. Do not invent a claim set. Use only a contract supplied by the user or a reviewed reference source. The runtime records this as caller-declared provenance, not authenticated human approval. If no such contract is available, explain that manual input is required. Deployment-required code profiles may still be opened through reliability_begin_code.`
      : `Contract authorship mode is current-agent. Draft the claims and checks yourself, then preflight them with reliability_assess before reliability_begin.`
  return `Reliability Governor is available for evidence-gated completion.

${authoring}

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

Coverage is structural, not semantic: it cannot detect a success claim omitted from the contract or decide whether a claim faithfully represents the user's intent. Prefer independently reviewed claim sets for high-impact work. Treat a review-required assessment as a reason to revise the contract or decline certification, never as permission to proceed without evidence.

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
    && event.data.version === 3
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

/** Register the prompt policy, tools, durable events, and bounded stopping hook. */
export function apply(ctx: Context, rawConfig: Config = {}): void {
  const config = resolveConfig(rawConfig)

  registerCodeVerificationSkill(ctx)
  ctx.systemPrompt.section({ name: 'reliability:policy', order: 118, text: promptFor(config.contractAuthoring.mode) })

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
      claims: { type: 'array', required: true, items: CLAIM_SCHEMA, description: 'Every declared success claim mapped to supporting check ids.' },
      checks: { type: 'array', required: true, items: CHECK_SCHEMA, description: 'Deterministic assertions that collectively prove the outcome.' },
      max_attempts: { type: 'integer', description: `Optional repair budget, capped by deployment at ${config.maxAttempts}.` },
      draft_receipt: { type: 'string', description: 'Required in auxiliary-model mode; returned by reliability_draft.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const session = requireAgent(exec).session
      const state = foldReliability(session.events)
      if (state.contract !== undefined && state.terminal === undefined) {
        throw new Error(`contract ${state.contract.contractId} is still active; verify or abstain before opening another`)
      }
      const checks = args.checks as ReliabilityCheck[]
      const claims = normalizeClaims(args.claims as ToolClaim[])
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
      session.append('reliability/contract', contract)
      return asJson({ status: 'active', contract })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'reliability_begin_code',
    description: 'Open a code completion contract that automatically includes every deployment-required trusted code-verification profile. The model may add checks but cannot remove required profiles.',
    parameters: {
      objective: { type: 'string', required: true, description: 'Concrete code outcome to prove.' },
      additional_checks: { type: 'array', items: CHECK_SCHEMA, description: 'Optional deterministic artifact or policy checks in addition to all required code profiles.' },
      additional_claims: { type: 'array', items: CLAIM_SCHEMA, description: 'Optional claims for additional checks. Required profile checks are mapped automatically.' },
      claims: { type: 'array', items: CLAIM_SCHEMA, description: 'Exact full claim set returned by reliability_draft; used only in auxiliary-model mode.' },
      checks: { type: 'array', items: CHECK_SCHEMA, description: 'Exact full check set returned by reliability_draft; used only in auxiliary-model mode.' },
      draft_receipt: { type: 'string', description: 'Exact code-draft receipt; required only in auxiliary-model mode.' },
      max_attempts: { type: 'integer', description: `Optional repair budget, capped by deployment at ${config.maxAttempts}.` },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(args, exec) {
      const session = requireAgent(exec).session
      const state = foldReliability(session.events)
      if (state.contract !== undefined && state.terminal === undefined) {
        throw new Error(`contract ${state.contract.contractId} is still active; verify or abstain before opening another`)
      }
      const requiredProfiles = config.codeVerificationProfiles.filter(profile => profile.required)
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
      session.append('reliability/contract', contract)
      return Promise.resolve(asJson({
        status: 'active',
        requiredProfiles: requiredProfiles.map(profile => profile.id),
        contract,
      }))
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
      if (before.terminal !== undefined) return asJson({ status: before.terminal.status, terminal: before.terminal })
      const { state, attempt } = await verify(ctx, session, config, 'manual', exec.signal)
      if (attempt === undefined || state.contract === undefined) throw new Error('verification produced no attempt')
      if (attempt.passed) {
        const terminal = appendTerminal(session, state.contract, 'certified', 'all deterministic checks passed', attempt.receipt)
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

  if (config.autoVerifyAtTurnStop) {
    ctx.on('agent/turn-stopping', async ({ agent, signal }): Promise<void> => {
      const before = foldReliability(agent.session.events)
      if (before.contract === undefined || before.terminal !== undefined) return
      const { state, attempt } = await verify(ctx, agent.session, config, 'turn-stop', signal)
      if (attempt === undefined || state.contract === undefined) return

      if (attempt.passed) {
        const terminal = appendTerminal(agent.session, state.contract, 'certified', 'all deterministic checks passed', attempt.receipt)
        agent.steer(pluginMessage(`Reliability contract certified. Report the outcome truthfully and include receipt ${terminal.receipt}.`))
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
