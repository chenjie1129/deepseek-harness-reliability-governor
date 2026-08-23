import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const evaluationUrl = name => new URL(`../evaluations/${name}`, import.meta.url)

function requireUniqueIds(cases, label) {
  const ids = new Set()
  for (const [index, testCase] of cases.entries()) {
    if (typeof testCase.id !== 'string' || testCase.id.length === 0) throw new Error(`${label} case ${index} needs an id`)
    if (ids.has(testCase.id)) throw new Error(`duplicate ${label} id: ${testCase.id}`)
    ids.add(testCase.id)
  }
}

function requireSafeRelativePath(path, label) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path) || path.split(/[\\/]+/u).includes('..')) {
    throw new Error(`${label} must be a safe relative path`)
  }
}

const suite = JSON.parse(await readFile(evaluationUrl('cases.json'), 'utf8'))
if (suite.version !== 1) throw new Error('evaluation suite version must be 1')
if (!Array.isArray(suite.cases) || suite.cases.length < 8) throw new Error('evaluation suite needs at least 8 cases')

requireUniqueIds(suite.cases, 'evaluation')
for (const [index, testCase] of suite.cases.entries()) {
  if (typeof testCase.risk !== 'string' || testCase.risk.length === 0) throw new Error(`${testCase.id} needs a risk`)
  if (!Array.isArray(testCase.checks) || testCase.checks.length === 0) throw new Error(`${testCase.id} needs checks`)
  if (!['certified', 'repair-required', 'exhausted', 'abstained'].includes(testCase.expected)) {
    throw new Error(`${testCase.id} has invalid expected state`)
  }
}

const keyless = JSON.parse(await readFile(evaluationUrl('keyless-benchmark.json'), 'utf8'))
if (keyless.version !== 1 || keyless.claimScope !== 'mechanism-only') throw new Error('invalid keyless benchmark metadata')
if (!Array.isArray(keyless.cases) || keyless.cases.length < 9) throw new Error('keyless benchmark needs at least 9 cases')
if (!Number.isSafeInteger(keyless.defaultTrials) || keyless.defaultTrials < 10) throw new Error('keyless benchmark needs at least 10 default trials')
requireUniqueIds(keyless.cases, 'keyless benchmark')
const keylessOracleKinds = new Set([
  'file_exists',
  'file_absent',
  'file_contains',
  'successful_tool_count',
  'trusted_verifier_count',
  'tool_not_called',
  'unverifiable',
])
for (const testCase of keyless.cases) {
  if (!Array.isArray(testCase.baseline) || testCase.baseline.length === 0) throw new Error(`${testCase.id} needs a baseline script`)
  if (!Array.isArray(testCase.governed) || testCase.governed.length === 0) throw new Error(`${testCase.id} needs a governed script`)
  if (testCase.expected?.baseline === undefined || testCase.expected?.governed === undefined) {
    throw new Error(`${testCase.id} needs paired expected outcomes`)
  }
  for (const path of Object.keys(testCase.setup?.files ?? {})) requireSafeRelativePath(path, `${testCase.id} fixture path`)
  if (testCase.oracle?.path !== undefined) requireSafeRelativePath(testCase.oracle.path, `${testCase.id} oracle path`)
  if (!keylessOracleKinds.has(testCase.oracle?.kind)) throw new Error(`${testCase.id} has unsupported keyless oracle`)
}

const live = JSON.parse(await readFile(evaluationUrl('live-benchmark.json'), 'utf8'))
if (live.version !== 1) throw new Error('live benchmark version must be 1')
if (!Array.isArray(live.cases) || live.cases.length !== 20) throw new Error('live benchmark must contain exactly 20 cases')
if (!Number.isSafeInteger(live.defaultTrials) || live.defaultTrials < 5) throw new Error('live benchmark needs at least 5 default trials')
requireUniqueIds(live.cases, 'live benchmark')
const oracleKinds = new Set(['file_exists', 'file_absent', 'file_contains', 'file_not_contains', 'file_equals', 'json_equals', 'always_false'])
for (const testCase of live.cases) {
  if (typeof testCase.task !== 'string' || testCase.task.length < 10) throw new Error(`${testCase.id} needs a concrete task`)
  if (typeof testCase.solvable !== 'boolean') throw new Error(`${testCase.id} needs a solvable flag`)
  if (!Array.isArray(testCase.oracle) || testCase.oracle.length === 0) throw new Error(`${testCase.id} needs an oracle`)
  for (const path of Object.keys(testCase.setup?.files ?? {})) requireSafeRelativePath(path, `${testCase.id} fixture path`)
  for (const check of testCase.oracle) {
    if (!oracleKinds.has(check.kind)) throw new Error(`${testCase.id} has unsupported oracle kind ${check.kind}`)
    if (check.path !== undefined) requireSafeRelativePath(check.path, `${testCase.id} oracle path`)
  }
  if (testCase.solvable && testCase.oracle.some(check => check.kind === 'always_false')) {
    throw new Error(`${testCase.id} is marked solvable but has an always_false oracle`)
  }
}

console.log(`validated ${suite.cases.length} contract cases, ${keyless.cases.length} keyless cases, and ${live.cases.length} live cases`)
