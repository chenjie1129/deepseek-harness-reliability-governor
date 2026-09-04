/**
 * DeepSeek Harness session-persistence compatibility.
 * @module @chenjie1129/dsh-reliability-governor-plugin/session-compat
 */

/** Session event types this plugin must be able to persist and resume. */
export const RELIABILITY_SESSION_EVENT_TYPES = [
  'reliability/contract',
  'reliability/attempt',
  'reliability/terminal',
  'reliability/code-verification',
  'reliability/contract-draft',
  'reliability/contract-review',
  'reliability/intent-review',
  'reliability/outcome-contract',
  'reliability/outcome-observation',
  'reliability/outcome-terminal',
] as const

interface MutableEventTypeRegistry {
  add(eventType: string): unknown
  has(eventType: string): boolean
}

interface SessionRuntimeWithPersistenceCatalog {
  KNOWN_SESSION_EVENT_TYPES?: unknown
}

function isMutableEventTypeRegistry(value: unknown): value is MutableEventTypeRegistry {
  return typeof value === 'object'
    && value !== null
    && 'add' in value
    && typeof value.add === 'function'
    && 'has' in value
    && typeof value.has === 'function'
}

/**
 * Teach Harness 0.1.2's fail-closed persistence reader about this installed
 * plugin's required event vocabulary. Older Harness builds expose no catalog
 * and already accept merge-extended session events.
 *
 * The registration deliberately lasts for the process lifetime. Removing it
 * during plugin disposal would make already-loaded Governor sessions
 * unreadable after a hot reload.
 *
 * @param sessionRuntime - Runtime exports from `@deepseek-ai/dsh-session`.
 */
export function registerReliabilitySessionEventTypes(sessionRuntime: unknown): void {
  if (typeof sessionRuntime !== 'object' || sessionRuntime === null) {
    throw new Error('reliability-governor: invalid dsh-session runtime module')
  }
  const registry = (sessionRuntime as SessionRuntimeWithPersistenceCatalog).KNOWN_SESSION_EVENT_TYPES
  if (registry === undefined) return
  if (!isMutableEventTypeRegistry(registry)) {
    throw new Error('reliability-governor: Harness exposes an incompatible session-event catalog')
  }
  for (const eventType of RELIABILITY_SESSION_EVENT_TYPES) registry.add(eventType)
  const missing = RELIABILITY_SESSION_EVENT_TYPES.filter(eventType => !registry.has(eventType))
  if (missing.length > 0) {
    throw new Error(`reliability-governor: failed to register session event type(s): ${missing.join(', ')}`)
  }
}
