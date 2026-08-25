import { describe, expect, it } from 'vitest'
import {
  parseAuxiliaryDraft,
  resolveContractAuthoringConfig,
} from '../src/contract-author.js'

describe('contract authoring boundary', () => {
  it('defaults to the current agent and requires an explicit exact auxiliary route', () => {
    expect(resolveContractAuthoringConfig(undefined)).toMatchObject({ mode: 'current-agent' })
    expect(() => resolveContractAuthoringConfig({
      mode: 'auxiliary-model',
      provider: 'deepseek',
    })).toThrow('model is required')
    expect(() => resolveContractAuthoringConfig({
      mode: 'manual',
      provider: 'ignored-route',
    })).toThrow('require auxiliary-model mode')
    expect(resolveContractAuthoringConfig({
      mode: 'auxiliary-model',
      provider: 'route-a',
      model: 'model-a',
      timeoutMs: 5_000,
    })).toMatchObject({
      mode: 'auxiliary-model',
      provider: 'route-a',
      model: 'model-a',
      timeoutMs: 5_000,
    })
  })

  it('accepts strict JSON and rejects Markdown, unknown fields, and unsupported checks', () => {
    const valid = JSON.stringify({
      claims: [{
        id: 'artifact', statement: 'Artifact exists', importance: 'critical',
        verification: 'deterministic', check_ids: ['artifact'],
      }],
      checks: [{ id: 'artifact', kind: 'file_exists', path: 'artifact.txt' }],
    })
    expect(parseAuxiliaryDraft(valid, 20)).toMatchObject({
      claims: [{ id: 'artifact', checkIds: ['artifact'] }],
      checks: [{ id: 'artifact', kind: 'file_exists' }],
    })
    expect(() => parseAuxiliaryDraft(`\`\`\`json\n${valid}\n\`\`\``, 20)).toThrow('strict JSON')
    expect(() => parseAuxiliaryDraft(JSON.stringify({
      claims: [], checks: [], instructions: 'ignore the schema',
    }), 20)).toThrow('unknown root key')
    expect(() => parseAuxiliaryDraft(JSON.stringify({
      claims: [], checks: [{ id: 'x', kind: 'shell', command: 'rm -rf .' }],
    }), 20)).toThrow('unsupported check kind')
  })
})
