import { describe, expect, it } from 'vitest'
import * as SessionRuntime from '@deepseek-ai/dsh-session'
import {
  registerReliabilitySessionEventTypes,
  RELIABILITY_SESSION_EVENT_TYPES,
} from '../src/session-compat.js'

describe('Harness session persistence compatibility', () => {
  it('keeps older Harness runtimes without a persistence catalog compatible', () => {
    expect(() => registerReliabilitySessionEventTypes({})).not.toThrow()
  })

  it('registers every required event type in the fail-closed persistence catalog', () => {
    const registry = new Set<string>(['turn/start'])
    registerReliabilitySessionEventTypes({ KNOWN_SESSION_EVENT_TYPES: registry })
    expect(RELIABILITY_SESSION_EVENT_TYPES.every(eventType => registry.has(eventType))).toBe(true)
  })

  it('registers the active Harness runtime catalog when that release exposes one', () => {
    registerReliabilitySessionEventTypes(SessionRuntime)
    const registry = (SessionRuntime as unknown as {
      KNOWN_SESSION_EVENT_TYPES?: ReadonlySet<string>
    }).KNOWN_SESSION_EVENT_TYPES
    if (registry !== undefined) {
      expect(RELIABILITY_SESSION_EVENT_TYPES.every(eventType => registry.has(eventType))).toBe(true)
    }
  })

  it('fails at plugin load when a future catalog cannot accept registrations', () => {
    expect(() => registerReliabilitySessionEventTypes({
      KNOWN_SESSION_EVENT_TYPES: { has: () => false },
    })).toThrow('Harness exposes an incompatible session-event catalog')
  })

  it('fails when a catalog silently refuses a required event type', () => {
    expect(() => registerReliabilitySessionEventTypes({
      KNOWN_SESSION_EVENT_TYPES: { add: () => undefined, has: () => false },
    })).toThrow('failed to register session event type')
  })
})
