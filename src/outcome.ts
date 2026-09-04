import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { receiptFor } from './receipts.js'
import type {
  BusinessOutcomeAttribution,
  BusinessOutcomeContract,
  BusinessOutcomeEvaluation,
  BusinessOutcomeObservation,
  BusinessOutcomeOperator,
  BusinessOutcomePredicate,
  BusinessOutcomePredicateResult,
  BusinessOutcomeProbe,
  BusinessOutcomeProfileSummary,
  BusinessOutcomeSnapshot,
  BusinessOutcomeTerminal,
  ReliabilityContract,
} from './types.js'

export interface BusinessOutcomeMetricConfig {
  name: string
  unit: string
}

export interface BusinessOutcomePredicateConfig {
  id: string
  metric: string
  operator: BusinessOutcomeOperator
  value: number
}

export interface BusinessOutcomeProfileConfig {
  id: string
  description: string
  command: string
  args?: string[]
  timeoutMs?: number
  metrics: BusinessOutcomeMetricConfig[]
  target: BusinessOutcomePredicateConfig
  guardrails?: BusinessOutcomePredicateConfig[]
  minimumSampleSize?: number
  maxDataAgeMs?: number
  notBeforeMs?: number
  deadlineMs?: number
  attribution?: BusinessOutcomeAttribution
}

export interface ResolvedBusinessOutcomeProfile extends BusinessOutcomeProfileSummary {
  command: string
  args: string[]
  timeoutMs: number
}

const PROFILE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const METRIC_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/u
const OPERATORS = new Set<BusinessOutcomeOperator>(['gte', 'lte', 'eq', 'delta-gte', 'delta-lte'])
const ATTRIBUTION = new Set<BusinessOutcomeAttribution>(['direct', 'correlational', 'experiment'])
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_DATA_AGE_MS = 24 * 60 * 60 * 1_000
const DEFAULT_DEADLINE_MS = 7 * 24 * 60 * 60 * 1_000
const MAX_DEADLINE_MS = 180 * 24 * 60 * 60 * 1_000

function boundedString(name: string, value: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`reliability-governor: ${name} must be non-empty`)
  if (normalized.length > maxLength) {
    throw new Error(`reliability-governor: ${name} must be at most ${maxLength} characters`)
  }
  if (normalized.includes('\0')) throw new Error(`reliability-governor: ${name} must not contain NUL bytes`)
  return normalized
}

function boundedInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`reliability-governor: ${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function resolvePredicate(
  value: BusinessOutcomePredicateConfig,
  label: string,
  metrics: ReadonlySet<string>,
): BusinessOutcomePredicate {
  const unknown = Object.keys(value).filter(key => !['id', 'metric', 'operator', 'value'].includes(key))
  if (unknown.length > 0) throw new Error(`reliability-governor: ${label} has unknown key(s): ${unknown.join(', ')}`)
  const id = boundedString(`${label}.id`, value.id, 128)
  const metric = boundedString(`${label}.metric`, value.metric, 128)
  if (!metrics.has(metric)) throw new Error(`reliability-governor: ${label} references undeclared metric: ${metric}`)
  if (!OPERATORS.has(value.operator)) throw new Error(`reliability-governor: ${label} has an unsupported operator`)
  if (!Number.isFinite(value.value)) throw new Error(`reliability-governor: ${label}.value must be finite`)
  return { id, metric, operator: value.operator, value: value.value }
}

/** Validate deployment-authored business outcome profiles once at plugin load. */
export function resolveBusinessOutcomeProfiles(
  profiles: readonly BusinessOutcomeProfileConfig[] = [],
): ResolvedBusinessOutcomeProfile[] {
  if (profiles.length > 20) throw new Error('reliability-governor: businessOutcomeProfiles supports at most 20 profiles')
  const seen = new Set<string>()
  return profiles.map((profile, index) => {
    const prefix = `businessOutcomeProfiles[${index}]`
    const unknown = Object.keys(profile).filter(key => ![
      'id', 'description', 'command', 'args', 'timeoutMs', 'metrics', 'target', 'guardrails',
      'minimumSampleSize', 'maxDataAgeMs', 'notBeforeMs', 'deadlineMs', 'attribution',
    ].includes(key))
    if (unknown.length > 0) throw new Error(`reliability-governor: ${prefix} has unknown key(s): ${unknown.join(', ')}`)
    if (!Array.isArray(profile.metrics) || profile.metrics.length === 0 || profile.metrics.length > 20) {
      throw new Error(`reliability-governor: ${prefix}.metrics must contain 1 to 20 entries`)
    }
    const id = boundedString(`${prefix}.id`, profile.id, 128)
    if (!PROFILE_ID.test(id)) throw new Error(`reliability-governor: business outcome profile id must be kebab-case: ${id}`)
    if (seen.has(id)) throw new Error(`reliability-governor: duplicate business outcome profile id: ${id}`)
    seen.add(id)
    const description = boundedString(`${prefix}.description`, profile.description, 500)
    const command = boundedString(`${prefix}.command`, profile.command, 1_024)
    const args = [...(profile.args ?? [])]
    if (args.length > 50 || args.some(argument => typeof argument !== 'string' || argument.length > 4_096)) {
      throw new Error(`reliability-governor: ${id}.args must contain at most 50 bounded strings`)
    }
    const metricNames = new Set<string>()
    const metrics = profile.metrics.map((metric, metricIndex) => {
      const metricName = boundedString(`${prefix}.metrics[${metricIndex}].name`, metric.name, 128)
      if (!METRIC_NAME.test(metricName)) throw new Error(`reliability-governor: invalid metric name: ${metricName}`)
      if (metricNames.has(metricName)) throw new Error(`reliability-governor: duplicate metric name: ${metricName}`)
      metricNames.add(metricName)
      return {
        name: metricName,
        unit: boundedString(`${prefix}.metrics[${metricIndex}].unit`, metric.unit, 64),
      }
    })
    const target = resolvePredicate(profile.target, `${prefix}.target`, metricNames)
    const guardrails = (profile.guardrails ?? []).map((guardrail, guardrailIndex) =>
      resolvePredicate(guardrail, `${prefix}.guardrails[${guardrailIndex}]`, metricNames))
    if (guardrails.length > 10) throw new Error(`reliability-governor: ${id} supports at most 10 guardrails`)
    const predicateIds = [target.id, ...guardrails.map(item => item.id)]
    if (new Set(predicateIds).size !== predicateIds.length) {
      throw new Error(`reliability-governor: ${id} predicate ids must be unique`)
    }
    const timeoutMs = boundedInteger(`${id}.timeoutMs`, profile.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, 900_000)
    const notBeforeMs = boundedInteger(`${id}.notBeforeMs`, profile.notBeforeMs ?? 0, 0, MAX_DEADLINE_MS)
    const deadlineMs = boundedInteger(`${id}.deadlineMs`, profile.deadlineMs ?? DEFAULT_DEADLINE_MS, 1, MAX_DEADLINE_MS)
    if (notBeforeMs > deadlineMs) throw new Error(`reliability-governor: ${id}.notBeforeMs must not exceed deadlineMs`)
    const minimumSampleSize = profile.minimumSampleSize === undefined
      ? undefined
      : boundedInteger(`${id}.minimumSampleSize`, profile.minimumSampleSize, 1, 1_000_000_000)
    const maxDataAgeMs = boundedInteger(
      `${id}.maxDataAgeMs`,
      profile.maxDataAgeMs ?? DEFAULT_MAX_DATA_AGE_MS,
      1,
      MAX_DEADLINE_MS,
    )
    const attribution = profile.attribution ?? 'correlational'
    if (!ATTRIBUTION.has(attribution)) throw new Error(`reliability-governor: ${id} has an unsupported attribution mode`)
    const publicProfile = {
      id,
      description,
      metrics,
      target,
      guardrails,
      ...(minimumSampleSize === undefined ? {} : { minimumSampleSize }),
      maxDataAgeMs,
      notBeforeMs,
      deadlineMs,
      attribution,
    }
    return {
      ...publicProfile,
      command,
      args,
      timeoutMs,
      profileReceipt: receiptFor('business-outcome-profile', {
        ...publicProfile,
        command,
        args,
        timeoutMs,
      }),
    }
  })
}

export function summarizeBusinessOutcomeProfile(
  profile: ResolvedBusinessOutcomeProfile,
): BusinessOutcomeProfileSummary {
  return {
    id: profile.id,
    description: profile.description,
    metrics: structuredClone(profile.metrics),
    target: structuredClone(profile.target),
    guardrails: structuredClone(profile.guardrails),
    ...(profile.minimumSampleSize === undefined ? {} : { minimumSampleSize: profile.minimumSampleSize }),
    maxDataAgeMs: profile.maxDataAgeMs,
    notBeforeMs: profile.notBeforeMs,
    deadlineMs: profile.deadlineMs,
    attribution: profile.attribution,
    profileReceipt: profile.profileReceipt,
  }
}

function captured(reader: SubprocessOutputReader | undefined): {
  text: string
  evidence: { bytes: number; truncated: boolean; receipt: string }
} {
  const output = reader?.readFrom(0) ?? { text: '', nextOffset: 0, lossy: false }
  return {
    text: output.text,
    evidence: {
      bytes: output.nextOffset,
      truncated: output.lossy,
      receipt: receiptFor('business-outcome-output', {
        capturedTail: output.text,
        bytes: output.nextOffset,
        truncated: output.lossy,
      }),
    },
  }
}

function withProbeReceipt(input: Omit<BusinessOutcomeProbe, 'receipt'>): BusinessOutcomeProbe {
  return { ...input, receipt: receiptFor('business-outcome-probe', input) }
}

function failedProbe(
  profile: ResolvedBusinessOutcomeProfile,
  started: number,
  failureKind: NonNullable<BusinessOutcomeProbe['failureKind']>,
  stdout?: ReturnType<typeof captured>['evidence'],
  stderr?: ReturnType<typeof captured>['evidence'],
  exitCode: number | null = null,
  signal: string | null = null,
  sandboxEnforcement?: 'full' | 'partial',
): BusinessOutcomeProbe {
  const empty = captured(undefined).evidence
  return withProbeReceipt({
    version: 1,
    observationId: randomUUID(),
    profile: profile.id,
    profileReceipt: profile.profileReceipt,
    succeeded: false,
    failureKind,
    exitCode,
    signal,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    ...(sandboxEnforcement === undefined ? {} : { sandboxEnforcement }),
    stdout: stdout ?? empty,
    stderr: stderr ?? empty,
  })
}

/** Parse the strict, bounded JSON emitted by one trusted outcome profile. */
export function parseBusinessOutcomeSnapshot(
  text: string,
  profile: ResolvedBusinessOutcomeProfile,
  observedAt: number,
): BusinessOutcomeSnapshot {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('outcome profile stdout must be one JSON object')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('outcome profile stdout must be one JSON object')
  }
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).filter(key => !['dataAsOf', 'metrics', 'sampleSize'].includes(key))
  if (unknown.length > 0) throw new Error(`outcome profile returned unknown key(s): ${unknown.join(', ')}`)
  if (!Number.isSafeInteger(record.dataAsOf) || (record.dataAsOf as number) <= 0) {
    throw new Error('outcome profile dataAsOf must be a positive epoch-millisecond integer')
  }
  if ((record.dataAsOf as number) > observedAt + 5 * 60 * 1_000) {
    throw new Error('outcome profile dataAsOf is implausibly far in the future')
  }
  if (observedAt - (record.dataAsOf as number) > profile.maxDataAgeMs) {
    throw new Error(`outcome profile data exceeds maxDataAgeMs (${profile.maxDataAgeMs})`)
  }
  if (record.metrics === null || typeof record.metrics !== 'object' || Array.isArray(record.metrics)) {
    throw new Error('outcome profile metrics must be an object')
  }
  const rawMetrics = record.metrics as Record<string, unknown>
  const allowed = new Set(profile.metrics.map(metric => metric.name))
  const unexpectedMetrics = Object.keys(rawMetrics).filter(name => !allowed.has(name))
  if (unexpectedMetrics.length > 0) {
    throw new Error(`outcome profile returned undeclared metric(s): ${unexpectedMetrics.join(', ')}`)
  }
  const metrics: Record<string, number> = {}
  for (const metric of profile.metrics) {
    const metricValue = rawMetrics[metric.name]
    if (typeof metricValue !== 'number' || !Number.isFinite(metricValue)) {
      throw new Error(`outcome profile metric ${metric.name} must be a finite number`)
    }
    metrics[metric.name] = metricValue
  }
  let sampleSize: number | undefined
  if (record.sampleSize !== undefined) {
    if (!Number.isSafeInteger(record.sampleSize) || (record.sampleSize as number) < 0) {
      throw new Error('outcome profile sampleSize must be a non-negative integer')
    }
    sampleSize = record.sampleSize as number
  }
  return {
    observedAt,
    dataAsOf: record.dataAsOf as number,
    metrics,
    ...(sampleSize === undefined ? {} : { sampleSize }),
  }
}

/** Execute a deployment-controlled, read-only outcome observation profile. */
export async function runBusinessOutcomeProfile(
  ctx: Context,
  agent: Agent,
  profile: ResolvedBusinessOutcomeProfile,
  maxOutputBytes: number,
  outerSignal: AbortSignal,
  now: () => number = Date.now,
): Promise<BusinessOutcomeProbe> {
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new Error('business outcome observation requires a session workspace')
  outerSignal.throwIfAborted()
  const started = performance.now()
  const currentPolicy = ctx.sandboxPolicy.resolve({ session: agent.session })
  const controller = new AbortController()
  let timedOut = false
  const forwardAbort = (): void => { controller.abort(outerSignal.reason) }
  outerSignal.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`business outcome profile ${profile.id} timed out`))
  }, profile.timeoutMs)

  try {
    let executable: string
    try {
      executable = await ctx.subprocess.resolveExecutable(profile.command, undefined, controller.signal)
    } catch {
      if (outerSignal.aborted) throw outerSignal.reason
      return failedProbe(profile, started, timedOut ? 'timeout' : 'configuration')
    }
    let confined
    try {
      confined = ctx.sandbox.confine([executable, ...profile.args], {
        mode: 'read-only',
        workspaceRoot: currentPolicy.workspaceRoot,
        sessionId: agent.session.id,
      })
    } catch {
      if (outerSignal.aborted) throw outerSignal.reason
      return failedProbe(profile, started, 'infrastructure')
    }
    if (confined.enforcement !== 'full') {
      return failedProbe(profile, started, 'infrastructure', undefined, undefined, null, null, confined.enforcement)
    }
    try {
      const handle = ctx.subprocess.spawn({
        argv: confined.argv,
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: maxOutputBytes },
          stderr: { maxBytes: maxOutputBytes },
        },
        graceMs: 3_000,
        signal: controller.signal,
        env: { NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' },
      })
      const processResult = await handle.done
      if (outerSignal.aborted) throw outerSignal.reason
      const stdout = captured(handle.collected.stdout)
      const stderr = captured(handle.collected.stderr)
      if (timedOut || processResult.exitCode !== 0 || processResult.signal !== null) {
        return failedProbe(
          profile,
          started,
          timedOut ? 'timeout' : 'exit',
          stdout.evidence,
          stderr.evidence,
          processResult.exitCode,
          processResult.signal,
          confined.enforcement,
        )
      }
      let snapshot: BusinessOutcomeSnapshot
      try {
        snapshot = parseBusinessOutcomeSnapshot(stdout.text, profile, now())
      } catch {
        return failedProbe(
          profile,
          started,
          'invalid-output',
          stdout.evidence,
          stderr.evidence,
          processResult.exitCode,
          processResult.signal,
          confined.enforcement,
        )
      }
      return withProbeReceipt({
        version: 1,
        observationId: randomUUID(),
        profile: profile.id,
        profileReceipt: profile.profileReceipt,
        succeeded: true,
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        sandboxEnforcement: confined.enforcement,
        snapshot,
        stdout: stdout.evidence,
        stderr: stderr.evidence,
      })
    } catch {
      if (outerSignal.aborted) throw outerSignal.reason
      return failedProbe(profile, started, timedOut ? 'timeout' : 'infrastructure', undefined, undefined, null, null, confined.enforcement)
    }
  } finally {
    clearTimeout(timer)
    outerSignal.removeEventListener('abort', forwardAbort)
  }
}

export function createBusinessOutcomeContract(
  deliveryContract: ReliabilityContract,
  profile: ResolvedBusinessOutcomeProfile,
  baseline: BusinessOutcomeProbe,
  now: number,
): BusinessOutcomeContract {
  if (!baseline.succeeded || baseline.snapshot === undefined) {
    throw new Error('a successful baseline observation is required before activating a business outcome contract')
  }
  if (baseline.profileReceipt !== profile.profileReceipt) {
    throw new Error('baseline observation does not match the selected business outcome profile')
  }
  const content = {
    version: 1 as const,
    outcomeContractId: randomUUID(),
    deliveryContractId: deliveryContract.contractId,
    deliveryContractReceipt: receiptFor('delivery-contract', deliveryContract),
    profile: summarizeBusinessOutcomeProfile(profile),
    baseline,
    startedAt: now,
    notBeforeAt: now + profile.notBeforeMs,
    deadlineAt: now + profile.deadlineMs,
  }
  return { ...content, receipt: receiptFor('business-outcome-contract', content) }
}

function predicateResult(
  predicate: BusinessOutcomePredicate,
  current: BusinessOutcomeSnapshot,
  baseline: BusinessOutcomeSnapshot,
): BusinessOutcomePredicateResult {
  const observed = current.metrics[predicate.metric]
  const baselineValue = baseline.metrics[predicate.metric]
  if (observed === undefined || baselineValue === undefined) {
    return {
      ...predicate,
      expected: predicate.value,
      passed: false,
      evidence: `metric ${predicate.metric} is missing from the observation or baseline`,
    }
  }
  const comparedValue = predicate.operator === 'delta-gte' || predicate.operator === 'delta-lte'
    ? observed - baselineValue
    : observed
  const passed = predicate.operator === 'gte' || predicate.operator === 'delta-gte'
    ? comparedValue >= predicate.value
    : predicate.operator === 'lte' || predicate.operator === 'delta-lte'
      ? comparedValue <= predicate.value
      : comparedValue === predicate.value
  return {
    ...predicate,
    expected: predicate.value,
    baseline: baselineValue,
    observed,
    comparedValue,
    passed,
    evidence: `${predicate.metric}: observed ${observed}, baseline ${baselineValue}, compared ${comparedValue}, expected ${predicate.operator} ${predicate.value}`,
  }
}

/** Evaluate one observation without executing tools or mutating session state. */
export function evaluateBusinessOutcome(
  contract: BusinessOutcomeContract,
  probe: BusinessOutcomeProbe,
  now: number,
): BusinessOutcomeEvaluation {
  const causalClaimPermitted = contract.profile.attribution !== 'correlational'
  if (probe.profile !== contract.profile.id || probe.profileReceipt !== contract.profile.profileReceipt) {
    return {
      status: now >= contract.deadlineAt ? 'inconclusive' : 'observing',
      reason: 'observation is not bound to the active business outcome profile',
      causalClaimPermitted,
      guardrails: [],
    }
  }
  if (!probe.succeeded || probe.snapshot === undefined) {
    return {
      status: now >= contract.deadlineAt ? 'inconclusive' : 'observing',
      reason: `outcome profile did not produce a valid observation${probe.failureKind === undefined ? '' : ` (${probe.failureKind})`}`,
      causalClaimPermitted,
      guardrails: [],
    }
  }
  if (now < contract.notBeforeAt) {
    return {
      status: 'observing',
      reason: `observation window has not opened; retry at or after ${contract.notBeforeAt}`,
      causalClaimPermitted,
      guardrails: [],
    }
  }
  const minimumSampleSize = contract.profile.minimumSampleSize
  if (minimumSampleSize !== undefined && (probe.snapshot.sampleSize ?? 0) < minimumSampleSize) {
    return {
      status: now >= contract.deadlineAt ? 'inconclusive' : 'observing',
      reason: `sample size ${probe.snapshot.sampleSize ?? 0} is below required ${minimumSampleSize}`,
      causalClaimPermitted,
      guardrails: [],
    }
  }
  const target = predicateResult(contract.profile.target, probe.snapshot, contract.baseline.snapshot as BusinessOutcomeSnapshot)
  const guardrails = contract.profile.guardrails.map(item =>
    predicateResult(item, probe.snapshot as BusinessOutcomeSnapshot, contract.baseline.snapshot as BusinessOutcomeSnapshot))
  const passed = target.passed && guardrails.every(item => item.passed)
  if (passed) {
    return {
      status: 'achieved',
      reason: causalClaimPermitted
        ? 'business target and every guardrail passed with an attribution-capable profile'
        : 'business target and every guardrail were observed, but the profile is correlational',
      causalClaimPermitted,
      target,
      guardrails,
    }
  }
  if (now < contract.deadlineAt) {
    return {
      status: 'observing',
      reason: 'target or guardrail has not passed and the observation deadline remains open',
      causalClaimPermitted,
      target,
      guardrails,
    }
  }
  return {
    status: 'missed',
    reason: 'target or guardrail did not pass by the observation deadline',
    causalClaimPermitted,
    target,
    guardrails,
  }
}

export function appendBusinessOutcomeContract(session: Session, contract: BusinessOutcomeContract): void {
  session.append('reliability/outcome-contract', contract)
}

export function appendBusinessOutcomeObservation(
  session: Session,
  contract: BusinessOutcomeContract,
  probe: BusinessOutcomeProbe,
  evaluation: BusinessOutcomeEvaluation,
): BusinessOutcomeObservation {
  const content = {
    version: 1 as const,
    outcomeContractId: contract.outcomeContractId,
    probe,
    evaluation,
  }
  const observation = { ...content, receipt: receiptFor('business-outcome-observation', content) }
  session.append('reliability/outcome-observation', observation)
  return observation
}

export function appendBusinessOutcomeTerminal(
  session: Session,
  contract: BusinessOutcomeContract,
  status: BusinessOutcomeTerminal['status'],
  reason: string,
  observationReceipt?: string,
): BusinessOutcomeTerminal {
  const content = {
    version: 1 as const,
    outcomeContractId: contract.outcomeContractId,
    status,
    reason,
    ...(observationReceipt === undefined ? {} : { observationReceipt }),
  }
  const terminal = { ...content, receipt: receiptFor('business-outcome-terminal', content) }
  session.append('reliability/outcome-terminal', terminal)
  return terminal
}
