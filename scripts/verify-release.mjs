import { readFile, stat } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const expectedName = '@chenjie1129/dsh-reliability-governor-plugin'
if (manifest.name !== expectedName) throw new Error(`unexpected package name: ${manifest.name}`)
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('missing dsh.bundle patch declaration')

const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')
if (!patch.includes(`name: '${expectedName}'`)) throw new Error('bundle patch does not mount the package')

for (const required of [
  'dist/index.js',
  'dist/index.d.ts',
  'README.md',
  'README.zh-CN.md',
  'FEEDBACK.md',
  'docs/ARCHITECTURE.md',
  'docs/RESEARCH.md',
  'docs/BENCHMARK.md',
  'docs/CODE_VERIFICATION.md',
  'docs/SMOKE_TEST.md',
  'docs/COMMUNITY_POST.md',
  `docs/RELEASE_NOTES_V${manifest.version}.md`,
  'docs/CONTRACT_COVERAGE.md',
  'docs/assets/keyless-benchmark.svg',
  'evaluations/cases.json',
  'evaluations/keyless-benchmark.json',
  'evaluations/latest-keyless-report.json',
  'evaluations/live-benchmark.json',
  'evaluations/live-benchmark.preregistered.json',
  'examples/code-verification.patch.yml',
  'scripts/run-keyless-benchmark.mjs',
  'scripts/run-live-benchmark.mjs',
  'scripts/live-benchmark-analysis.mjs',
  'scripts/render-keyless-demo.mjs',
  'skills/reliability-code-verification/SKILL.md',
  'CONTRIBUTING.md',
  '.github/workflows/ci.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/false-certification.yml',
  '.github/ISSUE_TEMPLATE/false-exhaustion.yml',
  '.github/ISSUE_TEMPLATE/false-abstention.yml',
  '.github/ISSUE_TEMPLATE/repair-regression.yml',
  '.github/ISSUE_TEMPLATE/compatibility-or-check.yml',
  'SECURITY.md',
  'LICENSE',
]) {
  const info = await stat(new URL(required, root))
  if (!info.isFile()) throw new Error(`required artifact is not a file: ${required}`)
}

for (const source of [
  'src/index.ts',
  'src/governor.ts',
  'src/types.ts',
  'src/coverage.ts',
  'src/receipts.ts',
  'src/code-verifier.ts',
]) {
  const text = await readFile(new URL(source, root), 'utf8')
  if (text.includes("from 'node:fs") || text.includes("from 'node:child_process")) {
    throw new Error(`${source} bypasses a Harness capability seam`)
  }
}

const codeVerifier = await readFile(new URL('src/code-verifier.ts', root), 'utf8')
if (!codeVerifier.includes('ctx.subprocess') || !codeVerifier.includes('ctx.sandbox.confine')
  || !codeVerifier.includes('ctx.sandboxPolicy.resolve')) {
  throw new Error('trusted code verifier does not use every required Harness capability seam')
}
if (!(manifest.files ?? []).includes('skills')) throw new Error('packed package omits the bundled coding skill')
if (!(manifest.files ?? []).includes('examples')) throw new Error('packed package omits the code-profile example')

const keylessReport = JSON.parse(await readFile(new URL('evaluations/latest-keyless-report.json', root), 'utf8'))
if (keylessReport.claimScope !== 'mechanism-only') throw new Error('keyless report overstates its claim scope')
if (keylessReport.gates?.passed !== true) throw new Error('latest keyless benchmark did not pass its gates')
if (keylessReport.caseCount !== 9 || keylessReport.trialsPerArmPerCase < 10) {
  throw new Error('latest keyless benchmark does not contain the required repeated matrix')
}
if (keylessReport.summary?.governed?.falseCertifications !== 0) {
  throw new Error('latest keyless benchmark contains a false certification')
}

console.log('release contract verified')
