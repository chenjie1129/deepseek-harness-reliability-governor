import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'reliability-governor'
const SKILL_URL = new URL('../skills/reliability-code-verification/SKILL.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../skills/reliability-code-verification/', import.meta.url)),
} as const
const DESCRIPTION = 'Use trusted, deployment-configured code checks with Reliability Governor for coding and repository changes. Separates model workflow guidance from sandboxed runtime verification and completion enforcement.'
const WHEN_TO_USE = 'Use for substantive code changes when the governor lists one or more required code-verification profiles.'
const CANDIDATE: SkillCandidate = {
  name: 'reliability-code-verification',
  description: DESCRIPTION,
  whenToUse: WHEN_TO_USE,
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_URL,
}

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(): Promise<SkillDefinition> {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      whenToUse: WHEN_TO_USE,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_URL, 'utf8'),
    }
  },
}

/** Register the bundled coding workflow skill through Harness's skill seam. */
export function registerCodeVerificationSkill(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
