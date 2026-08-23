import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  ReliabilityAttempt,
  ReliabilityCheck,
  ReliabilityCheckResult,
  ReliabilityContract,
  ReliabilityTerminal,
} from './types.js'

export interface GovernorLimits {
  maxAttempts: number
  maxChecks: number
  maxFileBytes: number
}

export interface VerificationEnvironment {
  fs: Pick<FileSystem, 'resolve' | 'contains' | 'stat' | 'lstat' | 'readBytes'>
  session: Pick<Session, 'events' | 'header'>
  signal?: AbortSignal
  maxFileBytes: number
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('cannot hash a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().filter(key => record[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  throw new Error(`cannot hash ${typeof value}`)
}

/** A stable content receipt; it proves what the plugin recorded, not external truth. */
export function receiptFor(kind: string, payload: unknown): string {
  const body = canonicalJson({ kind, payload })
  return `sha256:${createHash('sha256').update(body).digest('hex')}`
}

function assertRelativeWorkspacePath(path: string): void {
  if (path.trim().length === 0) throw new Error('path must be non-empty')
  if (isAbsolute(path)) throw new Error('path must be relative to the session workspace')
  const segments = path.split(/[\\/]+/u)
  if (segments.includes('..')) throw new Error('path must not contain a parent-directory segment')
}

function assertCheck(check: ReliabilityCheck): void {
  if (check.id.trim().length === 0) throw new Error('every check needs a non-empty id')
  if (check.id.length > 128) throw new Error('check id must be at most 128 characters')
  if ('path' in check) {
    assertRelativeWorkspacePath(check.path)
    if (check.path.length > 1_024) throw new Error(`${check.id}: path must be at most 1024 characters`)
  }
  if ('tool' in check) {
    if (check.tool.trim().length === 0) throw new Error(`${check.id}: tool must be non-empty`)
    if (check.tool.length > 256) throw new Error(`${check.id}: tool must be at most 256 characters`)
  }
  if (check.kind === 'code_verification_succeeded') {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(check.profile)) {
      throw new Error(`${check.id}: profile must be a kebab-case identifier`)
    }
    if (check.profile.length > 128) throw new Error(`${check.id}: profile must be at most 128 characters`)
  }
  if ((check.kind === 'file_contains' || check.kind === 'file_not_contains') && check.text.length === 0) {
    throw new Error(`${check.id}: ${check.kind} text must be non-empty`)
  }
  if ((check.kind === 'file_contains' || check.kind === 'file_not_contains' || check.kind === 'file_equals')
    && check.text.length > 4_096) {
    throw new Error(`${check.id}: ${check.kind} text must be at most 4096 characters`)
  }
  if (check.kind === 'json_equals') {
    if (check.pointer !== '' && !check.pointer.startsWith('/')) {
      throw new Error(`${check.id}: JSON pointer must be empty or start with /`)
    }
    if (check.pointer.length > 2_048) throw new Error(`${check.id}: JSON pointer must be at most 2048 characters`)
    canonicalJson(check.value)
  }
  if (check.kind === 'tool_succeeded' && check.argumentsContain === '') {
    throw new Error(`${check.id}: argumentsContain must be non-empty when supplied`)
  }
  if (check.kind === 'tool_succeeded' && check.argumentsContain !== undefined && check.argumentsContain.length > 4_096) {
    throw new Error(`${check.id}: argumentsContain must be at most 4096 characters`)
  }
  if ((check.kind === 'tool_succeeded' || check.kind === 'code_verification_succeeded') && check.minCount !== undefined
    && (!Number.isSafeInteger(check.minCount) || check.minCount < 1 || check.minCount > 100)) {
    throw new Error(`${check.id}: minCount must be an integer from 1 to 100`)
  }
}

function codeVerificationSucceeded(
  events: readonly SessionEvent[],
  check: Extract<ReliabilityCheck, { kind: 'code_verification_succeeded' }>,
): ReliabilityCheckResult {
  const successCount = events.filter(event => event.type === 'reliability/code-verification'
    && event.data.profile === check.profile
    && event.data.passed).length
  const required = check.minCount ?? 1
  return result(
    check,
    successCount >= required,
    `${successCount} trusted successful ${check.profile} verification(s); required ${required}`,
  )
}

/** Validate and detach a model-authored contract before it enters the log. */
export function createContract(
  input: { objective: string; checks: ReliabilityCheck[]; maxAttempts?: number },
  startedAtSeq: number,
  limits: GovernorLimits,
): ReliabilityContract {
  const objective = input.objective.trim()
  if (objective.length === 0) throw new Error('objective must be non-empty')
  if (objective.length > 2_000) throw new Error('objective must be at most 2000 characters')
  if (input.checks.length === 0) throw new Error('checks must contain at least one deterministic assertion')
  if (input.checks.length > limits.maxChecks) throw new Error(`checks exceeds configured maxChecks (${limits.maxChecks})`)

  const ids = new Set<string>()
  for (const check of input.checks) {
    assertCheck(check)
    if (ids.has(check.id)) throw new Error(`duplicate check id: ${check.id}`)
    ids.add(check.id)
  }

  const maxAttempts = input.maxAttempts ?? limits.maxAttempts
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > limits.maxAttempts) {
    throw new Error(`max_attempts must be an integer from 1 to ${limits.maxAttempts}`)
  }

  return structuredClone({
    version: 1,
    contractId: randomUUID(),
    objective,
    checks: input.checks,
    maxAttempts,
    startedAtSeq,
  })
}

function result(check: ReliabilityCheck, passed: boolean, evidence: string): ReliabilityCheckResult {
  return { id: check.id, kind: check.kind, passed, evidence }
}

function afterBoundary(events: readonly SessionEvent[], contract: ReliabilityContract): readonly SessionEvent[] {
  return events.filter(event => event.seq > contract.startedAtSeq)
}

function callSucceeded(events: readonly SessionEvent[], check: Extract<ReliabilityCheck, { kind: 'tool_succeeded' }>): ReliabilityCheckResult {
  const calls = events.filter((event): event is Extract<SessionEvent, { type: 'tool/call' }> =>
    event.type === 'tool/call'
      && event.data.name === check.tool
      && (check.argumentsContain === undefined || event.data.arguments.includes(check.argumentsContain)))
  const resultByCall = new Map<string, Extract<SessionEvent, { type: 'tool/result' }>>()
  for (const event of events) {
    if (event.type === 'tool/result') resultByCall.set(String(event.data.message.source.callId), event)
  }
  const successCount = calls.filter((call) => {
    const outcome = resultByCall.get(String(call.data.callId))
    if (outcome === undefined || outcome.data.error !== undefined) return false
    return outcome.data.message.content[0].isError === false
  }).length
  const required = check.minCount ?? 1
  return result(check, successCount >= required, `${successCount} matching successful call(s); required ${required}`)
}

function noToolErrors(events: readonly SessionEvent[], check: Extract<ReliabilityCheck, { kind: 'no_tool_errors' }>): ReliabilityCheckResult {
  let failures = 0
  for (const event of events) {
    if (event.type === 'tool/result'
      && (event.data.error !== undefined || event.data.message.content[0].isError)) failures++
  }
  return result(check, failures === 0, failures === 0 ? 'no failed tool results observed' : `${failures} failed tool result(s) observed`)
}

async function fileResult(
  check: Extract<ReliabilityCheck, {
    kind: 'file_exists' | 'file_absent' | 'file_contains' | 'file_not_contains' | 'file_equals' | 'json_equals'
  }>,
  env: VerificationEnvironment,
): Promise<ReliabilityCheckResult> {
  const cwd = env.session.header.cwd
  if (cwd === undefined) return result(check, false, 'session has no workspace cwd')

  const resolveOptions = { cwd, ...(env.signal === undefined ? {} : { signal: env.signal }) }
  const root = await env.fs.resolve('.', resolveOptions)
  const target = await env.fs.resolve(check.path, resolveOptions)
  if (!env.fs.contains(root, target)) return result(check, false, 'path resolves outside the session workspace')

  if (check.kind === 'file_absent') {
    const pathInfo = await env.fs.lstat(check.path, { cwd }, env.signal)
    return result(check, pathInfo === undefined, pathInfo === undefined ? 'path is absent' : `path exists as ${pathInfo.type}`)
  }

  const info = await env.fs.stat(target, env.signal)
  if (info === undefined) return result(check, false, 'path is absent')
  if (info.type !== 'file') return result(check, false, `path is ${info.type}, not a regular file`)
  if (check.kind === 'file_exists') {
    return result(check, true, `regular file exists${info.size === undefined ? '' : ` (${info.size} bytes)`}`)
  }
  if (info.size !== undefined && info.size > env.maxFileBytes) {
    return result(check, false, `file exceeds verification limit (${info.size} > ${env.maxFileBytes} bytes)`)
  }
  const bytes = await env.fs.readBytes(target, env.signal, env.maxFileBytes)
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return result(check, false, 'file is not valid UTF-8 text')
  }
  if (content.includes('\0')) return result(check, false, 'file contains binary NUL bytes')
  if (check.kind === 'file_contains') {
    const passed = content.includes(check.text)
    return result(check, passed, passed ? 'required literal is present' : 'required literal is absent')
  }
  if (check.kind === 'file_not_contains') {
    const passed = !content.includes(check.text)
    return result(check, passed, passed ? 'forbidden literal is absent' : 'forbidden literal is present')
  }
  if (check.kind === 'file_equals') {
    const passed = content === check.text
    return result(check, passed, passed ? 'file bytes match expected UTF-8 text' : 'file content differs')
  }
  try {
    const parsed = JSON.parse(content) as unknown
    const actual = check.pointer === '' ? parsed : check.pointer.slice(1).split('/').reduce<unknown>((current, raw) => {
      const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
      return current !== null && typeof current === 'object'
        ? (current as Record<string, unknown>)[key]
        : undefined
    }, parsed)
    const passed = actual !== undefined && canonicalJson(actual) === canonicalJson(check.value)
    return result(check, passed, passed ? 'JSON value matches' : `JSON value differs at ${check.pointer || '<root>'}`)
  } catch (error: unknown) {
    return result(check, false, `invalid JSON evidence: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
}

/** Evaluate every contract check in declaration order. Nothing here mutates the world. */
export async function evaluateContract(
  contract: ReliabilityContract,
  env: VerificationEnvironment,
): Promise<ReliabilityCheckResult[]> {
  const events = afterBoundary(env.session.events, contract)
  const results: ReliabilityCheckResult[] = []
  for (const check of contract.checks) {
    env.signal?.throwIfAborted()
    try {
      if (check.kind === 'file_exists' || check.kind === 'file_absent' || check.kind === 'file_contains'
        || check.kind === 'file_not_contains' || check.kind === 'file_equals' || check.kind === 'json_equals') {
        results.push(await fileResult(check, env))
      } else if (check.kind === 'tool_succeeded') {
        results.push(callSucceeded(events, check))
      } else if (check.kind === 'code_verification_succeeded') {
        results.push(codeVerificationSucceeded(events, check))
      } else if (check.kind === 'tool_not_called') {
        const count = events.filter(event => event.type === 'tool/call' && event.data.name === check.tool).length
        results.push(result(check, count === 0, count === 0 ? 'tool was not called' : `tool was called ${count} time(s)`))
      } else {
        results.push(noToolErrors(events, check))
      }
    } catch (error: unknown) {
      env.signal?.throwIfAborted()
      const message = error instanceof Error ? error.message : 'unknown evaluator failure'
      results.push(result(check, false, `evaluator error: ${message}`))
    }
  }
  return results
}

/** Append one immutable attempt and return the logged payload. */
export function appendAttempt(
  session: Session,
  contract: ReliabilityContract,
  priorAttemptCount: number,
  trigger: ReliabilityAttempt['trigger'],
  results: ReliabilityCheckResult[],
): ReliabilityAttempt {
  const attemptWithoutReceipt = {
    contractId: contract.contractId,
    attempt: priorAttemptCount + 1,
    trigger,
    passed: results.every(item => item.passed),
    results,
  }
  const attempt: ReliabilityAttempt = {
    ...attemptWithoutReceipt,
    receipt: receiptFor('attempt', attemptWithoutReceipt),
  }
  session.append('reliability/attempt', attempt)
  return attempt
}

/** Append one terminal receipt and return the logged payload. */
export function appendTerminal(
  session: Session,
  contract: ReliabilityContract,
  status: ReliabilityTerminal['status'],
  reason: string,
  attemptReceipt?: string,
): ReliabilityTerminal {
  const terminalWithoutReceipt = {
    contractId: contract.contractId,
    status,
    reason,
    ...(attemptReceipt === undefined ? {} : { attemptReceipt }),
  }
  const terminal: ReliabilityTerminal = {
    ...terminalWithoutReceipt,
    receipt: receiptFor('terminal', terminalWithoutReceipt),
  }
  session.append('reliability/terminal', terminal)
  return terminal
}
