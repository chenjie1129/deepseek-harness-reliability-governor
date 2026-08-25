import { createHash } from 'node:crypto'

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

/** Stable JSON comparison for structured deterministic checks. */
export function canonicalJsonForComparison(value: unknown): string {
  return canonicalJson(value)
}
