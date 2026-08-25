import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
import {
  aggregateRepairTransitions,
  classifyResult,
  exactMcNemar,
  exactTaskSignFlip,
  makeDecision,
  pairedOracleTransitions,
  summarize,
  taskClusterBootstrapDifference,
} from './live-benchmark-analysis.mjs'

const root = new URL('../', import.meta.url)
const defaultHarnessRoot = fileURLToPath(new URL('../../deepseek-harness-main/', import.meta.url))
const defaultPlugin = fileURLToPath(new URL('../chenjie1129-dsh-reliability-governor-plugin-0.5.0.tgz', import.meta.url))
const defaultOutput = fileURLToPath(new URL('../evaluations/latest-live-report.json', import.meta.url))
const manifestUrl = new URL('evaluations/live-benchmark.json', root)
const preregistrationUrl = new URL('evaluations/live-benchmark.preregistered.json', root)
const analysisUrl = new URL('scripts/live-benchmark-analysis.mjs', root)
const runnerUrl = new URL('scripts/run-live-benchmark.mjs', root)

function parseArgs(argv) {
  const args = {
    trials: undefined,
    maxCases: undefined,
    harnessRoot: defaultHarnessRoot,
    plugin: defaultPlugin,
    output: defaultOutput,
    timeoutMs: 180_000,
    plan: false,
    confirmCost: false,
    keep: false,
    includeTranscripts: false,
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--trials') args.trials = Number(argv[++index])
    else if (arg === '--max-cases') args.maxCases = Number(argv[++index])
    else if (arg === '--harness-root') args.harnessRoot = resolve(argv[++index])
    else if (arg === '--plugin') args.plugin = resolve(argv[++index])
    else if (arg === '--output') args.output = resolve(argv[++index])
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++index])
    else if (arg === '--plan') args.plan = true
    else if (arg === '--confirm-cost') args.confirmCost = true
    else if (arg === '--keep') args.keep = true
    else if (arg === '--include-transcripts') args.includeTranscripts = true
    else if (arg === '--help') {
      console.log(`Usage: node scripts/run-live-benchmark.mjs [options]

Options:
  --plan                 Print the run plan without contacting a model
  --confirm-cost         Required for live execution
  --trials N             Repetitions per arm and case (default from manifest)
  --max-cases N          Run only the first N cases for a pilot
  --harness-root PATH    Built DeepSeek Harness checkout
  --plugin PATH          Exact plugin .tgz to install in both governed arms
  --output PATH          JSON report path
  --timeout-ms N         Per-run timeout (default 180000)
  --keep                 Keep temporary profiles and workspaces
  --include-transcripts  Include bounded final stdout in the report`)
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

function requireInteger(name, value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
}

function inside(rootPath, candidate) {
  const relative = candidate.slice(rootPath.length)
  return candidate === rootPath || (candidate.startsWith(`${rootPath}${sep}`) && relative.length > 1)
}

function fixturePath(workspace, path) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('fixture path must be non-empty')
  const candidate = resolve(workspace, path)
  if (!inside(workspace, candidate)) throw new Error(`path escapes benchmark workspace: ${path}`)
  return candidate
}

async function materialize(workspace, files) {
  await mkdir(workspace, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    const target = fixturePath(workspace, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function jsonPointer(value, pointer) {
  if (pointer === '') return value
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw new Error(`invalid JSON pointer: ${pointer}`)
  return pointer.slice(1).split('/').reduce((current, raw) => {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    return current !== null && typeof current === 'object' ? current[key] : undefined
  }, value)
}

async function oracleCheck(workspace, check) {
  if (check.kind === 'always_false') return { passed: false, evidence: check.reason }
  const target = fixturePath(workspace, check.path)
  const present = await exists(target)
  if (check.kind === 'file_exists') return { passed: present, evidence: present ? 'file exists' : 'file is absent' }
  if (check.kind === 'file_absent') return { passed: !present, evidence: present ? 'path still exists' : 'path is absent' }
  if (!present) return { passed: false, evidence: 'file is absent' }
  const content = await readFile(target, 'utf8')
  if (check.kind === 'file_contains') {
    return { passed: content.includes(check.text), evidence: content.includes(check.text) ? 'literal present' : 'literal absent' }
  }
  if (check.kind === 'file_not_contains') {
    return { passed: !content.includes(check.text), evidence: content.includes(check.text) ? 'forbidden literal present' : 'literal absent' }
  }
  if (check.kind === 'file_equals') {
    return { passed: content === check.text, evidence: content === check.text ? 'exact bytes match' : 'content differs' }
  }
  if (check.kind === 'json_equals') {
    try {
      const actual = jsonPointer(JSON.parse(content), check.pointer)
      const passed = JSON.stringify(actual) === JSON.stringify(check.value)
      return { passed, evidence: passed ? 'JSON value matches' : `JSON value differs at ${check.pointer}` }
    } catch (error) {
      return { passed: false, evidence: `invalid JSON: ${error instanceof Error ? error.message : 'unknown error'}` }
    }
  }
  throw new Error(`unknown oracle kind: ${check.kind}`)
}

async function evaluateOracle(workspace, checks) {
  const results = []
  for (const check of checks) results.push({ kind: check.kind, ...await oracleCheck(workspace, check) })
  return { passed: results.every(result => result.passed), results }
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function referenceContractFor(testCase, maxAttempts) {
  const checks = testCase.oracle.map((check, index) => {
    const id = `reference-${index + 1}`
    if (check.kind === 'always_false') {
      return { id, kind: 'file_exists', path: `.reliability-evidence/${testCase.id}.authoritative.json` }
    }
    return { id, ...check }
  })
  return {
    objective: testCase.task,
    claims: [{
      id: 'reference-outcome',
      statement: testCase.task,
      importance: 'critical',
      verification: 'deterministic',
      check_ids: checks.map(check => check.id),
      minimum_independent_sources: 1,
    }],
    checks,
    max_attempts: maxAttempts,
  }
}

function promptFor(testCase, arm, referenceMaxAttempts) {
  const reference = arm === 'governed-reference-contract'
    ? referenceContractFor(testCase, referenceMaxAttempts)
    : undefined
  const repairPolicy = testCase.repairClass === 'workspace-reversible'
    ? 'Repairs may change only this isolated workspace. Do not perform external actions.'
    : testCase.repairClass === 'read-only'
      ? 'This task is read-only. Do not modify files or perform external actions while trying to satisfy a failed check.'
      : 'Do not automatically retry external, irreversible, or non-idempotent actions. Inspect authoritative state or abstain.'
  const referenceInstruction = reference === undefined ? '' : `
This is the independently authored reference-contract arm. Before doing the task, call reliability_begin with exactly this JSON object; do not add, remove, weaken, reorder, or rewrite any field:
${JSON.stringify(reference)}
${testCase.oracle.some(check => check.kind === 'always_false') ? `The .reliability-evidence path represents unavailable authoritative evidence. Never fabricate or create it; open the contract and then abstain.` : ''}
`
  return `You are participating in a reliability benchmark in an isolated local workspace.
Complete the task using available tools. Do not weaken or reinterpret any requirement.
${repairPolicy}${referenceInstruction}
Do not mention either benchmark marker before the final line of your final answer.
End the final answer with exactly BENCHMARK_OUTCOME: COMPLETE only if you believe every requirement is satisfied.
Otherwise end it with exactly BENCHMARK_OUTCOME: NOT_COMPLETE.

Task: ${testCase.task}`
}

function stripAnsi(text) {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, '')
}

function claimedComplete(stdout) {
  return /(?:^|\n)BENCHMARK_OUTCOME: COMPLETE\s*$/u.test(stripAnsi(stdout).trimEnd())
}

function redact(text) {
  return text
    .replace(/(?:sk|ak)-[A-Za-z0-9_-]{12,}/gu, '[REDACTED]')
    .replace(/(api[_-]?key|secret|token)(\s*[=:]\s*)\S+/giu, '$1$2[REDACTED]')
}

function runProcess(command, args, options) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const maxCapture = 1024 * 1024
    child.stdout.on('data', chunk => { if (stdout.length < maxCapture) stdout += chunk.toString() })
    child.stderr.on('data', chunk => { if (stderr.length < maxCapture) stderr += chunk.toString() })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    }, options.timeoutMs)
    child.on('error', error => {
      clearTimeout(timer)
      resolvePromise({ exitCode: null, signal: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut })
    })
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      resolvePromise({ exitCode, signal, stdout, stderr, timedOut })
    })
  })
}

async function ensurePnpmPath(temporaryRoot, originalPath) {
  const probe = await runProcess('pnpm', ['--version'], {
    cwd: temporaryRoot,
    env: process.env,
    timeoutMs: 10_000,
  })
  if (probe.exitCode === 0) return originalPath
  const shimDir = join(temporaryRoot, 'bin')
  const shim = join(shimDir, 'pnpm')
  await mkdir(shimDir, { recursive: true })
  await writeFile(shim, '#!/bin/sh\nexec corepack pnpm "$@"\n', 'utf8')
  await chmod(shim, 0o755)
  return `${shimDir}${sep === '\\' ? ';' : ':'}${originalPath ?? ''}`
}

async function walkFiles(directory) {
  if (!await exists(directory)) return []
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await walkFiles(path))
    else if (entry.isFile()) paths.push(path)
  }
  return paths
}

function decodeSession(buffer, path) {
  const text = path.endsWith('.zstd') ? zstdDecompressSync(buffer).toString('utf8') : buffer.toString('utf8')
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function readWorkspaceSession(home, workspace, knownPath) {
  const candidates = knownPath === undefined
    ? (await walkFiles(home)).filter(path => path.endsWith('.jsonl') || path.endsWith('.jsonl.zstd'))
    : [knownPath]
  for (const path of candidates) {
    try {
      const records = decodeSession(await readFile(path), path)
      const header = records[0]
      if (header?.type === 'session' && resolve(header.cwd ?? '') === workspace) {
        return { path, header, events: records.slice(1) }
      }
    } catch {
      // A session can be between append and flush; the live observer retries.
    }
  }
  if (knownPath !== undefined) return readWorkspaceSession(home, workspace)
  return undefined
}

async function sessionMetrics(home, workspace) {
  const session = await readWorkspaceSession(home, workspace)
  if (session !== undefined) {
    const { events } = session
    const messages = events.filter(event => event.type === 'assistant/message')
    const contract = events.filter(event => event.type === 'reliability/contract').at(-1)?.data
    const terminal = events.filter(event => event.type === 'reliability/terminal').at(-1)?.data
    const attempts = events.filter(event => event.type === 'reliability/attempt').map(event => ({
      eventSeq: event.seq,
      attempt: event.data?.attempt,
      trigger: event.data?.trigger,
      passed: event.data?.passed,
      results: Array.isArray(event.data?.results) ? event.data.results : [],
      receipt: event.data?.receipt,
    }))
    return {
      sessionFound: true,
      modelCalls: messages.length,
      inputTokens: messages.reduce((sum, event) => sum + (event.data?.usage?.inputTokens ?? 0), 0),
      outputTokens: messages.reduce((sum, event) => sum + (event.data?.usage?.outputTokens ?? 0), 0),
      toolCalls: events.filter(event => event.type === 'tool/call').length,
      contractStarted: contract !== undefined,
      contract: contract === undefined ? undefined : {
        objective: contract.objective,
        claims: contract.claims,
        checks: contract.checks,
        maxAttempts: contract.maxAttempts,
      },
      coverage: contract?.coverageAssessment === undefined ? undefined : {
        status: contract.coverageAssessment.status,
        criticalPercent: contract.coverageAssessment.coverage?.critical?.percent,
        weightedPercent: contract.coverageAssessment.coverage?.weighted?.percent,
        independentSourceCount: contract.coverageAssessment.evidence?.independentSourceCount,
        findingCodes: contract.coverageAssessment.findings?.map(finding => finding.code) ?? [],
        receipt: contract.coverageAssessment.receipt,
      },
      contractHash: contract === undefined ? undefined : sha256(canonicalJson({
        objective: contract.objective,
        claims: contract.claims,
        checks: contract.checks,
        maxAttempts: contract.maxAttempts,
      })),
      attempts,
      terminal: terminal?.status ?? 'none',
      receipt: typeof terminal?.receipt === 'string' ? terminal.receipt : undefined,
    }
  }
  return {
    sessionFound: false,
    modelCalls: null,
    inputTokens: null,
    outputTokens: null,
    toolCalls: null,
    contractStarted: false,
    attempts: [],
    terminal: 'unknown',
  }
}

function delay(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

async function observeAttemptOracles({ home, workspace, checks, signal }) {
  const snapshots = []
  const observed = new Set()
  let sessionPath
  while (!signal.aborted) {
    const session = await readWorkspaceSession(home, workspace, sessionPath)
    sessionPath = session?.path ?? sessionPath
    const attempts = session?.events.filter(event => event.type === 'reliability/attempt') ?? []
    const unseen = attempts.filter(event => !observed.has(event.seq))
    for (const [index, event] of unseen.entries()) {
      observed.add(event.seq)
      const oracle = await evaluateOracle(workspace, checks)
      snapshots.push({
        eventSeq: event.seq,
        attempt: event.data?.attempt,
        contractPassed: event.data?.passed,
        observedAt: new Date().toISOString(),
        captureMode: index === unseen.length - 1 ? 'live' : 'coalesced_backfill',
        oraclePass: oracle.passed,
        oracleResults: oracle.results,
      })
    }
    await delay(25)
  }
  const finalSession = await readWorkspaceSession(home, workspace, sessionPath)
  for (const event of finalSession?.events.filter(item => item.type === 'reliability/attempt') ?? []) {
    if (observed.has(event.seq)) continue
    const oracle = await evaluateOracle(workspace, checks)
    snapshots.push({
      eventSeq: event.seq,
      attempt: event.data?.attempt,
      contractPassed: event.data?.passed,
      observedAt: new Date().toISOString(),
      captureMode: 'terminal_backfill',
      oraclePass: oracle.passed,
      oracleResults: oracle.results,
    })
  }
  return snapshots
}

function sha256(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

function boundedTranscript(text) {
  const cleaned = redact(stripAnsi(text)).trim()
  return cleaned.length <= 4_000 ? cleaned : `[truncated]\n${cleaned.slice(-4_000)}`
}

async function runOne({
  arm,
  testCase,
  trial,
  workspace,
  home,
  dshBin,
  env,
  timeoutMs,
  includeTranscripts,
  referenceMaxAttempts,
}) {
  await materialize(workspace, testCase.setup.files)
  const observerController = new AbortController()
  const observer = observeAttemptOracles({
    home,
    workspace,
    checks: testCase.oracle,
    signal: observerController.signal,
  })
  const started = performance.now()
  const execution = await runProcess(process.execPath, [dshBin, '--profile', 'headless', promptFor(testCase, arm, referenceMaxAttempts)], {
    cwd: workspace,
    env: { ...env, DSH_HOME: home },
    timeoutMs,
  })
  observerController.abort()
  const attemptOracleSnapshots = await observer
  const durationMs = Number((performance.now() - started).toFixed(3))
  const oracle = await evaluateOracle(workspace, testCase.oracle)
  const completion = claimedComplete(execution.stdout)
  const metrics = await sessionMetrics(home, workspace)
  const expectedReference = referenceContractFor(testCase, referenceMaxAttempts)
  const referenceContractMatch = arm !== 'governed-reference-contract' ? undefined : metrics.contract !== undefined
    && canonicalJson(metrics.contract) === canonicalJson({
      objective: expectedReference.objective,
      claims: expectedReference.claims.map(claim => ({
        id: claim.id,
        statement: claim.statement,
        importance: claim.importance,
        verification: claim.verification,
        checkIds: claim.check_ids,
        minimumIndependentSources: claim.minimum_independent_sources,
      })),
      checks: expectedReference.checks,
      maxAttempts: expectedReference.max_attempts,
    })
  return classifyResult({
    caseId: testCase.id,
    category: testCase.category,
    solvable: testCase.solvable,
    repairClass: testCase.repairClass,
    arm,
    trial,
    oraclePass: oracle.passed,
    oracleResults: oracle.results,
    claimedComplete: completion,
    falseCompletion: completion && !oracle.passed,
    correctNonCompletion: !oracle.passed && !completion,
    durationMs,
    exitCode: execution.exitCode,
    signal: execution.signal,
    timedOut: execution.timedOut,
    stdoutReceipt: /sha256:[a-f0-9]{64}/u.test(execution.stdout),
    stdoutHash: sha256(execution.stdout),
    stderrTail: execution.stderr.length === 0 ? '' : boundedTranscript(execution.stderr).slice(-500),
    attemptOracleSnapshots,
    ...(referenceContractMatch === undefined ? {} : { referenceContractMatch }),
    ...(includeTranscripts ? { finalOutput: boundedTranscript(execution.stdout) } : {}),
    ...metrics,
  })
}

async function verifyPreregistration() {
  const preregistration = JSON.parse(await readFile(preregistrationUrl, 'utf8'))
  const files = {
    'evaluations/live-benchmark.json': manifestUrl,
    'scripts/run-live-benchmark.mjs': runnerUrl,
    'scripts/live-benchmark-analysis.mjs': analysisUrl,
  }
  const observed = {}
  for (const [name, url] of Object.entries(files)) observed[name] = sha256(await readFile(url))
  const mismatches = Object.entries(observed).filter(([name, digest]) => preregistration.files?.[name] !== digest)
  if (mismatches.length > 0) {
    throw new Error(`live benchmark pre-registration hash mismatch: ${mismatches.map(([name]) => name).join(', ')}`)
  }
  return { ...preregistration, observedFiles: observed, locked: true }
}

async function gitMetadata() {
  const cwd = fileURLToPath(root)
  const commit = await runProcess('git', ['rev-parse', 'HEAD'], { cwd, env: process.env, timeoutMs: 10_000 })
  const status = await runProcess('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd,
    env: process.env,
    timeoutMs: 10_000,
  })
  const upstream = await runProcess('git', ['rev-parse', '@{upstream}'], { cwd, env: process.env, timeoutMs: 10_000 })
  const commitId = commit.exitCode === 0 ? commit.stdout.trim() : null
  const upstreamCommit = upstream.exitCode === 0 ? upstream.stdout.trim() : null
  return {
    commit: commitId,
    upstreamCommit,
    trackedTreeClean: status.exitCode === 0 && status.stdout.trim().length === 0,
    publishedAtUpstream: commitId !== null && commitId === upstreamCommit,
  }
}

const args = parseArgs(process.argv.slice(2))
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
const preregistration = await verifyPreregistration()
const trials = args.trials ?? manifest.defaultTrials
const maxCases = args.maxCases ?? manifest.cases.length
requireInteger('--trials', trials, 1, 20)
requireInteger('--max-cases', maxCases, 1, manifest.cases.length)
requireInteger('--timeout-ms', args.timeoutMs, 1_000, 900_000)
const cases = manifest.cases.slice(0, maxCases)
const arms = ['baseline', 'governed-model-contract', 'governed-reference-contract']
const plannedRuns = cases.length * trials * arms.length

if (args.plan) {
  console.log(`live benchmark plan: ${plannedRuns} agent runs`)
  console.log(`${cases.length} cases x ${trials} trials x 3 arms`)
  console.log(`arms: ${arms.join('; ')}`)
  console.log('order: deterministic three-way rotation within each case/trial block')
  console.log(`pre-registration: ${preregistration.id} (hashes verified)`)
  console.log('decision: arm-neutral false success, separate false-exhaustion/abstention gates, task-cluster intervals, and an exact task-level sign-flip test')
  console.log(`declared MDE: ${manifest.preregistration.minimumDetectableEffect.absoluteRateDifference} absolute rate difference`)
  console.log('cost: provider-dependent; inspect the provider price before using --confirm-cost')
  process.exit(0)
}

if (!args.confirmCost) throw new Error(`live execution would make ${plannedRuns} agent runs; pass --confirm-cost after reviewing provider pricing`)
if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY.length === 0) {
  throw new Error('DEEPSEEK_API_KEY is not configured in this process; the live benchmark was not started')
}

const source = await gitMetadata()
const decisionQualityRequested = cases.length === manifest.cases.length
  && trials >= manifest.minimumTrialsForDecision
if (decisionQualityRequested && (!source.trackedTreeClean || !source.publishedAtUpstream)) {
  throw new Error('decision-quality execution requires a clean tracked tree whose current commit is published at the configured upstream')
}

const dshBin = join(args.harnessRoot, 'apps/cli/lib/bin.js')
for (const required of [dshBin, args.plugin]) {
  if (!await exists(required)) throw new Error(`required live benchmark artifact is missing: ${required}`)
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-reliability-live-benchmark-'))
const homes = Object.fromEntries(arms.map(arm => [arm, join(temporaryRoot, `${arm}-home`)]))
const workspaces = join(temporaryRoot, 'workspaces')
await Promise.all([...Object.values(homes).map(home => mkdir(home)), mkdir(workspaces)])
const pathValue = await ensurePnpmPath(temporaryRoot, process.env.PATH)
const childEnv = { ...process.env, PATH: pathValue }
const results = []

try {
  for (const arm of arms.filter(arm => arm !== 'baseline')) {
    const install = await runProcess(process.execPath, [dshBin, 'plugin', '--profile', 'headless', 'add', args.plugin], {
      cwd: temporaryRoot,
      env: { ...childEnv, DSH_HOME: homes[arm] },
      timeoutMs: args.timeoutMs,
    })
    if (install.exitCode !== 0) {
      throw new Error(`${arm} profile plugin installation failed: ${boundedTranscript(install.stderr).slice(-1000)}`)
    }
  }

  for (const [caseIndex, testCase] of cases.entries()) {
    for (let trial = 1; trial <= trials; trial++) {
      const offset = (caseIndex + trial - 1) % arms.length
      const order = [...arms.slice(offset), ...arms.slice(0, offset)]
      for (const arm of order) {
        const workspace = join(workspaces, arm, testCase.id, String(trial))
        const result = await runOne({
          arm,
          testCase,
          trial,
          workspace,
          home: homes[arm],
          dshBin,
          env: childEnv,
          timeoutMs: args.timeoutMs,
          includeTranscripts: args.includeTranscripts,
          referenceMaxAttempts: manifest.preregistration.referenceContractMaxAttempts,
        })
        results.push(result)
        console.log(`${testCase.id} trial ${trial} ${arm}: oracle=${result.oraclePass ? 'pass' : 'fail'} claim=${result.claimedComplete ? 'complete' : 'not-complete'} exit=${result.exitCode}`)
      }
    }
  }

  const summaries = Object.fromEntries(arms.map(arm => [arm, summarize(results.filter(result => result.arm === arm))]))
  const falseSuccessMcNemar = exactMcNemar(
    results,
    'baseline',
    'governed-model-contract',
    'falseSuccess',
  )
  const falseSuccessTaskSignFlip = exactTaskSignFlip(
    results,
    'baseline',
    'governed-model-contract',
    'falseSuccess',
  )
  const pairedEffects = {
    modelContract: pairedOracleTransitions(results, 'governed-model-contract'),
    referenceContract: pairedOracleTransitions(results, 'governed-reference-contract'),
  }
  const clusterBootstrap = {
    falseSuccessBenefit: taskClusterBootstrapDifference(
      results,
      'baseline',
      'governed-model-contract',
      'falseSuccess',
    ),
    oracleSuccessDifference: taskClusterBootstrapDifference(
      results,
      'governed-model-contract',
      'baseline',
      'oraclePass',
    ),
    contractAuthorshipFalseRejectionPenalty: taskClusterBootstrapDifference(
      results,
      'governed-model-contract',
      'governed-reference-contract',
      'falseRejection',
    ),
    contractAuthorshipTerminalFalseRejectionPenalty: taskClusterBootstrapDifference(
      results,
      'governed-model-contract',
      'governed-reference-contract',
      'terminalFalseRejection',
    ),
  }
  const repairTransitionEvidence = aggregateRepairTransitions(
    results.filter(result => result.arm !== 'baseline'),
  )
  const resultDecision = makeDecision({
    manifest,
    preregistration,
    trials,
    caseCount: cases.length,
    summaries,
    falseSuccessTaskSignFlip,
    falseSuccessBenefit: clusterBootstrap.falseSuccessBenefit,
    oracleSuccessDifference: clusterBootstrap.oracleSuccessDifference,
    falseRejectionDifference: clusterBootstrap.contractAuthorshipFalseRejectionPenalty,
    terminalFalseRejectionDifference: clusterBootstrap.contractAuthorshipTerminalFalseRejectionPenalty,
    source,
  })
  const report = {
    schemaVersion: 2,
    benchmark: manifest.name,
    generatedAt: new Date().toISOString(),
    harnessRoot: args.harnessRoot,
    pluginArtifact: { path: args.plugin, sha256: sha256(await readFile(args.plugin)) },
    source,
    preregistration,
    trialsPerArmPerCase: trials,
    caseCount: cases.length,
    runCount: results.length,
    transcriptPolicy: args.includeTranscripts ? 'bounded final stdout included' : 'stdout hash only',
    arms,
    summary: summaries,
    pairedExactMcNemar: falseSuccessMcNemar,
    pairedTaskExactSignFlip: falseSuccessTaskSignFlip,
    pairedEffects,
    taskClusterBootstrap95: clusterBootstrap,
    repairTransitionEvidence,
    decision: resultDecision,
    results,
  }
  await mkdir(dirname(args.output), { recursive: true })
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`live benchmark verdict: ${resultDecision.verdict}`)
  console.log(`report: ${args.output}`)
} finally {
  if (args.keep) console.log(`kept temporary benchmark data: ${temporaryRoot}`)
  else await rm(temporaryRoot, { recursive: true, force: true })
}
