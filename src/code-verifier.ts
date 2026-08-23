import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { receiptFor } from './governor.js'
import type { CodeVerificationResult } from './types.js'

export interface CodeVerificationProfileConfig {
  /** Stable model-facing identifier. */
  id: string
  /** Human-readable purpose; never interpreted as executable source. */
  description: string
  /** Deployment-controlled executable: absolute path or bare PATH name. */
  command: string
  /** Exact arguments. The model cannot add, remove, or replace them. */
  args?: string[]
  /** Per-run deadline. */
  timeoutMs?: number
  /** Maximum file permission granted to the verifier; current session policy may narrow it. */
  sandboxMode?: 'read-only' | 'workspace-write'
  /** Include this profile automatically in reliability_begin_code contracts. */
  required?: boolean
}

export interface ResolvedCodeVerificationProfile {
  id: string
  description: string
  command: string
  args: string[]
  timeoutMs: number
  sandboxMode: 'read-only' | 'workspace-write'
  required: boolean
  profileReceipt: string
}

const PROFILE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const DEFAULT_TIMEOUT_MS = 120_000

function boundedString(name: string, value: string, maxLength: number): string {
  if (value.length === 0) throw new Error(`reliability-governor: ${name} must be non-empty`)
  if (value.length > maxLength) throw new Error(`reliability-governor: ${name} must be at most ${maxLength} characters`)
  if (value.includes('\0')) throw new Error(`reliability-governor: ${name} must not contain NUL bytes`)
  return value
}

/** Validate deployment-authored profiles once; model inputs never reach this path. */
export function resolveCodeVerificationProfiles(
  profiles: readonly CodeVerificationProfileConfig[] = [],
): ResolvedCodeVerificationProfile[] {
  if (profiles.length > 20) throw new Error('reliability-governor: codeVerificationProfiles supports at most 20 profiles')
  const seen = new Set<string>()
  return profiles.map((profile, index) => {
    const unknown = Object.keys(profile).filter(key => ![
      'id', 'description', 'command', 'args', 'timeoutMs', 'sandboxMode', 'required',
    ].includes(key))
    if (unknown.length > 0) {
      throw new Error(`reliability-governor: codeVerificationProfiles[${index}] has unknown key(s): ${unknown.join(', ')}`)
    }
    if (typeof profile.id !== 'string' || typeof profile.description !== 'string' || typeof profile.command !== 'string') {
      throw new Error(`reliability-governor: codeVerificationProfiles[${index}] id, description, and command must be strings`)
    }
    if (profile.args !== undefined && (!Array.isArray(profile.args) || profile.args.some(argument => typeof argument !== 'string'))) {
      throw new Error(`reliability-governor: codeVerificationProfiles[${index}].args must be an array of strings`)
    }
    if (profile.required !== undefined && typeof profile.required !== 'boolean') {
      throw new Error(`reliability-governor: codeVerificationProfiles[${index}].required must be boolean`)
    }
    const id = boundedString(`codeVerificationProfiles[${index}].id`, profile.id.trim(), 128)
    if (!PROFILE_ID.test(id)) throw new Error(`reliability-governor: code verification profile id must be kebab-case: ${id}`)
    if (seen.has(id)) throw new Error(`reliability-governor: duplicate code verification profile id: ${id}`)
    seen.add(id)
    const description = boundedString(`codeVerificationProfiles[${index}].description`, profile.description.trim(), 500)
    const command = boundedString(`codeVerificationProfiles[${index}].command`, profile.command, 1_024)
    const args = [...(profile.args ?? [])]
    if (args.length > 50) throw new Error(`reliability-governor: ${id} supports at most 50 arguments`)
    for (const [argumentIndex, argument] of args.entries()) {
      boundedString(`${id}.args[${argumentIndex}]`, argument, 4_096)
    }
    const timeoutMs = profile.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
      throw new Error(`reliability-governor: ${id}.timeoutMs must be an integer from 1000 to 900000`)
    }
    const sandboxMode = profile.sandboxMode ?? 'read-only'
    if (sandboxMode !== 'read-only' && sandboxMode !== 'workspace-write') {
      throw new Error(`reliability-governor: ${id}.sandboxMode must be read-only or workspace-write`)
    }
    const normalized = {
      id,
      description,
      command,
      args,
      timeoutMs,
      sandboxMode,
      required: profile.required ?? true,
    }
    return {
      ...normalized,
      profileReceipt: receiptFor('code-verification-profile', normalized),
    }
  })
}

function narrowerMode(current: SandboxMode, configured: 'read-only' | 'workspace-write'): 'read-only' | 'workspace-write' {
  if (current === 'read-only') return 'read-only'
  return configured
}

function outputEvidence(reader: SubprocessOutputReader | undefined) {
  const output = reader?.readFrom(0) ?? { text: '', nextOffset: 0, lossy: false }
  return {
    bytes: output.nextOffset,
    truncated: output.lossy,
    receipt: receiptFor('code-verification-output', {
      capturedTail: output.text,
      bytes: output.nextOffset,
      truncated: output.lossy,
    }),
  }
}

function withReceipt(input: Omit<CodeVerificationResult, 'receipt'>): CodeVerificationResult {
  return { ...input, receipt: receiptFor('code-verification-result', input) }
}

function failedResult(
  profile: ResolvedCodeVerificationProfile,
  started: number,
  sandboxMode: 'read-only' | 'workspace-write',
  failureKind: NonNullable<CodeVerificationResult['failureKind']>,
  sandboxEnforcement?: 'full' | 'partial',
): CodeVerificationResult {
  return withReceipt({
    version: 1,
    verificationId: randomUUID(),
    profile: profile.id,
    profileReceipt: profile.profileReceipt,
    passed: false,
    failureKind,
    exitCode: null,
    signal: null,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    sandboxMode,
    ...(sandboxEnforcement === undefined ? {} : { sandboxEnforcement }),
    stdout: outputEvidence(undefined),
    stderr: outputEvidence(undefined),
  })
}

/** Execute one immutable profile through Harness-managed subprocess and sandbox services. */
export async function runCodeVerification(
  ctx: Context,
  agent: Agent,
  profile: ResolvedCodeVerificationProfile,
  maxOutputBytes: number,
  outerSignal: AbortSignal,
): Promise<CodeVerificationResult> {
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new Error('reliability code verification requires a session workspace')
  outerSignal.throwIfAborted()
  const started = performance.now()
  const currentPolicy = ctx.sandboxPolicy.resolve({ session: agent.session })
  const sandboxMode = narrowerMode(currentPolicy.mode, profile.sandboxMode)
  const controller = new AbortController()
  let timedOut = false
  const forwardAbort = (): void => { controller.abort(outerSignal.reason) }
  outerSignal.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`trusted verifier ${profile.id} timed out`))
  }, profile.timeoutMs)

  try {
    let executable: string
    try {
      executable = await ctx.subprocess.resolveExecutable(profile.command, undefined, controller.signal)
    } catch (error) {
      if (outerSignal.aborted) throw outerSignal.reason
      if (timedOut) return failedResult(profile, started, sandboxMode, 'timeout')
      return failedResult(profile, started, sandboxMode, 'configuration')
    }

    let confined
    try {
      confined = ctx.sandbox.confine([executable, ...profile.args], {
        mode: sandboxMode,
        workspaceRoot: currentPolicy.workspaceRoot,
        sessionId: agent.session.id,
      })
    } catch (error) {
      if (outerSignal.aborted) throw outerSignal.reason
      return failedResult(profile, started, sandboxMode, 'infrastructure')
    }
    if (confined.enforcement !== 'full') {
      return failedResult(profile, started, sandboxMode, 'infrastructure', confined.enforcement)
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
      const outcome = await handle.done
      if (outerSignal.aborted) throw outerSignal.reason
      const passed = !timedOut && outcome.exitCode === 0 && outcome.signal === null
      return withReceipt({
        version: 1,
        verificationId: randomUUID(),
        profile: profile.id,
        profileReceipt: profile.profileReceipt,
        passed,
        ...passed ? {} : { failureKind: timedOut ? 'timeout' : 'exit' },
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        sandboxMode,
        sandboxEnforcement: confined.enforcement,
        stdout: outputEvidence(handle.collected.stdout),
        stderr: outputEvidence(handle.collected.stderr),
      })
    } catch (error) {
      if (outerSignal.aborted) throw outerSignal.reason
      return failedResult(profile, started, sandboxMode, timedOut ? 'timeout' : 'infrastructure', confined.enforcement)
    }
  } finally {
    clearTimeout(timer)
    outerSignal.removeEventListener('abort', forwardAbort)
  }
}
