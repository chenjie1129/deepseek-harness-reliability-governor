import type {
  BusinessOutcomeProfileSummary,
  ReliabilityCheck,
  ReliabilityClaim,
  ReliabilityApprovedIntent,
  ReliabilityContractAuthorship,
  ReliabilityCoverageAssessment,
  ReliabilityIntent,
} from './types.js'

/** A2UI release implemented by the bundled review renderer. */
export const A2UI_SPEC_VERSION = 'v0.9.1'
/** A2UI wire discriminator used by the v0.9.1 specification. */
export const A2UI_WIRE_VERSION = 'v0.9'
/** Standard MIME type for an A2UI message list. */
export const A2UI_MIME_TYPE = 'application/a2ui+json'
/** Current Basic catalog used by the fixed contract-review surface. */
export const A2UI_BASIC_CATALOG = 'https://a2ui.org/specification/v0_9/basic_catalog.json'

export const REVIEW_APPROVE_LABEL = 'Approve exact contract'
export const REVIEW_REVISE_LABEL = 'Request revision'
export const REVIEW_REJECT_LABEL = 'Reject contract'
export const INTENT_APPROVE_LABEL = 'Approve interpreted intent'
export const INTENT_REVISE_LABEL = 'Request intent revision'
export const INTENT_REJECT_LABEL = 'Reject interpretation'

export type ReliabilityReviewAction =
  | 'reliability.contract.approve'
  | 'reliability.contract.revise'
  | 'reliability.contract.reject'
  | 'reliability.intent.approve'
  | 'reliability.intent.revise'
  | 'reliability.intent.reject'

export interface ReliabilityIntentReviewProposal {
  version: 1
  intent: ReliabilityIntent
  proposalReceipt: string
}

export interface ReliabilityReviewProposal {
  version: 2
  contractId: string
  contractKind: 'general' | 'code'
  objective: string
  claims: ReliabilityClaim[]
  checks: ReliabilityCheck[]
  maxAttempts: number
  authorship: ReliabilityContractAuthorship
  coverageAssessment: ReliabilityCoverageAssessment
  intent: ReliabilityApprovedIntent
  businessOutcome?: BusinessOutcomeProfileSummary
  proposalReceipt: string
}

type A2uiComponent = Record<string, unknown> & { id: string; component: string }

export type A2uiReviewMessage =
  | {
    version: typeof A2UI_WIRE_VERSION
    createSurface: { surfaceId: string; catalogId: string; sendDataModel: boolean }
  }
  | {
    version: typeof A2UI_WIRE_VERSION
    updateComponents: { surfaceId: string; components: A2uiComponent[] }
  }
  | {
    version: typeof A2UI_WIRE_VERSION
    updateDataModel: { surfaceId: string; path: '/'; value: Record<string, unknown> }
  }

/** Fixed-catalog A2UI payload transported inside a Harness user-question detail. */
interface ReliabilityA2uiReviewEnvelopeBase {
  version: 1
  mimeType: typeof A2UI_MIME_TYPE
  specVersion: typeof A2UI_SPEC_VERSION
  proposalReceipt: string
  surfaceId: string
  messages: A2uiReviewMessage[]
}

export interface ReliabilityA2uiContractReviewEnvelope extends ReliabilityA2uiReviewEnvelopeBase {
  kind: 'reliability-contract-review'
}

export interface ReliabilityA2uiIntentReviewEnvelope extends ReliabilityA2uiReviewEnvelopeBase {
  kind: 'reliability-intent-review'
}

export type ReliabilityA2uiReviewEnvelope =
  | ReliabilityA2uiContractReviewEnvelope
  | ReliabilityA2uiIntentReviewEnvelope

const DETAIL_MARKER_OPEN = '<!-- reliability-governor-a2ui:'
const DETAIL_MARKER_CLOSE = ' -->'
const MAX_A2UI_ENVELOPE_BYTES = 256 * 1024

function compactCheck(check: ReliabilityCheck): string {
  const fields = Object.entries(check)
    .filter(([key]) => key !== 'id' && key !== 'kind')
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
  return `${check.id}: ${check.kind}${fields.length === 0 ? '' : ` (${fields.join(', ')})`}`
}

function authorshipText(authorship: ReliabilityContractAuthorship): string {
  if (authorship.mode !== 'auxiliary-model') return `${authorship.mode}; ${authorship.assurance}`
  return `${authorship.mode}; ${authorship.assurance}; ${authorship.provider}/${authorship.model}`
}

function reviewData(proposal: ReliabilityReviewProposal): Record<string, unknown> {
  const intentLines = [
    ...proposal.intent.constraints.map(value => `Constraint: ${value}`),
    ...proposal.intent.assumptions.map(value => `Assumption: ${value}`),
    ...proposal.intent.nonGoals.map(value => `Non-goal: ${value}`),
    ...proposal.intent.ambiguities.map(value => `Ambiguity: ${value}`),
  ]
  const businessOutcome = proposal.businessOutcome
  const outcomeLines = businessOutcome === undefined ? [] : [
    `Profile: ${businessOutcome.id}`,
    `Goal: ${businessOutcome.description}`,
    `Target: ${businessOutcome.target.metric} ${businessOutcome.target.operator} ${businessOutcome.target.value}`,
    `Window: not before ${businessOutcome.notBeforeMs} ms; deadline ${businessOutcome.deadlineMs} ms`,
    `Maximum data age: ${businessOutcome.maxDataAgeMs} ms`,
    `Attribution: ${businessOutcome.attribution}`,
    ...(businessOutcome.minimumSampleSize === undefined
      ? []
      : [`Minimum sample size: ${businessOutcome.minimumSampleSize}`]),
    ...businessOutcome.guardrails.map(item =>
      `Guardrail ${item.id}: ${item.metric} ${item.operator} ${item.value}`),
  ]
  return {
    title: 'Review the evidence contract',
    explanation: 'The intent was approved separately. This approval authorizes only the exact claim, evidence, and repair-budget proposal; it does not certify the future outcome.',
    intentReceipt: `Approved intent receipt: ${proposal.intent.proposalReceipt}`,
    intentTitle: 'Approved intent dimensions',
    intent: intentLines.length === 0 ? ['No additional intent dimensions declared.'] : intentLines,
    objective: `Objective: ${proposal.objective}`,
    contractMeta: `Contract: ${proposal.contractId}; type: ${proposal.contractKind}; maximum attempts: ${proposal.maxAttempts}; authorship: ${authorshipText(proposal.authorship)}`,
    claimsTitle: `Claims (${proposal.claims.length})`,
    claims: proposal.claims.map(claim =>
      `${claim.id} [${claim.importance}; ${claim.verification}]: ${claim.statement}; checks: ${claim.checkIds.join(', ') || 'none'}; minimum independent sources: ${claim.minimumIndependentSources ?? 1}`),
    checksTitle: `Checks (${proposal.checks.length})`,
    checks: proposal.checks.map(check => compactCheck(check)),
    outcomeTitle: businessOutcome === undefined ? '' : 'Business outcome',
    outcome: outcomeLines,
    coverage: `Coverage: ${proposal.coverageAssessment.status}; critical ${proposal.coverageAssessment.coverage.critical.percent}%; weighted ${proposal.coverageAssessment.coverage.weighted.percent}%; independent sources ${proposal.coverageAssessment.evidence.independentSourceCount}; receipt ${proposal.coverageAssessment.receipt}`,
    warningTitle: `Coverage findings (${proposal.coverageAssessment.findings.length})`,
    warnings: proposal.coverageAssessment.findings.map(finding =>
      `${finding.severity}: ${finding.message}`),
    receipt: `Proposal receipt: ${proposal.proposalReceipt}`,
    feedback: '',
    approveLabel: REVIEW_APPROVE_LABEL,
    reviseLabel: REVIEW_REVISE_LABEL,
    rejectLabel: REVIEW_REJECT_LABEL,
  }
}

function intentReviewData(proposal: ReliabilityIntentReviewProposal): Record<string, unknown> {
  const { intent } = proposal
  const values = (items: string[], empty: string) => items.length === 0 ? [empty] : items
  return {
    title: 'Review the interpreted intent',
    explanation: 'Confirm what the agent believes you requested before reviewing how completion will be proved.',
    objective: `Objective: ${intent.objective}`,
    authorship: `Authorship: ${intent.authorship.mode}; ${intent.authorship.assurance}`,
    constraintsTitle: `Constraints (${intent.constraints.length})`,
    constraints: values(intent.constraints, 'No explicit constraints declared.'),
    assumptionsTitle: `Assumptions (${intent.assumptions.length})`,
    assumptions: values(intent.assumptions, 'No assumptions declared.'),
    nonGoalsTitle: `Non-goals (${intent.nonGoals.length})`,
    nonGoals: values(intent.nonGoals, 'No non-goals declared.'),
    ambiguitiesTitle: `Ambiguities (${intent.ambiguities.length})`,
    ambiguities: values(intent.ambiguities, 'No unresolved ambiguities declared.'),
    receipt: `Intent proposal receipt: ${proposal.proposalReceipt}`,
    feedback: '',
    approveLabel: INTENT_APPROVE_LABEL,
    reviseLabel: INTENT_REVISE_LABEL,
    rejectLabel: INTENT_REJECT_LABEL,
  }
}

function textComponents(prefix: string, values: string[], variant: 'body' | 'caption' = 'body'): A2uiComponent[] {
  return values.map((_value, index) => ({
    id: `${prefix}-${index}`,
    component: 'Text',
    text: { path: `/${prefix}/${index}` },
    variant,
  }))
}

/** Build a deterministic, fixed-catalog A2UI v0.9.1 review surface. */
export function createA2uiReviewEnvelope(proposal: ReliabilityReviewProposal): ReliabilityA2uiContractReviewEnvelope {
  const surfaceId = `reliability-review-${proposal.proposalReceipt.slice('sha256:'.length, 'sha256:'.length + 24)}`
  const data = reviewData(proposal)
  const intentComponents = textComponents('intent', data.intent as string[], 'caption')
  const claimComponents = textComponents('claims', proposal.claims.map(claim => claim.statement))
  const checkComponents = textComponents('checks', proposal.checks.map(check => check.id), 'caption')
  const warningComponents = textComponents('warnings', proposal.coverageAssessment.findings.map(item => item.message), 'caption')
  const outcomeComponents = textComponents('outcome', (data.outcome as string[]), 'caption')
  const contentChildren = [
    'title', 'explanation', 'intent-receipt', 'intent-title',
    ...intentComponents.map(component => component.id),
    'objective', 'contract-meta', 'claims-title',
    ...claimComponents.map(component => component.id),
    'checks-title', ...checkComponents.map(component => component.id), 'coverage',
    ...(outcomeComponents.length === 0 ? [] : ['outcome-title', ...outcomeComponents.map(component => component.id)]),
    ...(warningComponents.length === 0 ? [] : ['warning-title', ...warningComponents.map(component => component.id)]),
    'receipt', 'feedback', 'actions',
  ]
  const action = (name: ReliabilityReviewAction, feedback = false) => ({
    event: {
      name,
      context: {
        proposalReceipt: proposal.proposalReceipt,
        ...(feedback ? { feedback: { path: '/feedback' } } : {}),
      },
    },
  })
  const components: A2uiComponent[] = [
    { id: 'root', component: 'Card', child: 'content' },
    { id: 'content', component: 'Column', children: contentChildren, align: 'stretch' },
    { id: 'title', component: 'Text', text: { path: '/title' }, variant: 'h3' },
    { id: 'explanation', component: 'Text', text: { path: '/explanation' }, variant: 'body' },
    { id: 'intent-receipt', component: 'Text', text: { path: '/intentReceipt' }, variant: 'caption' },
    { id: 'intent-title', component: 'Text', text: { path: '/intentTitle' }, variant: 'h5' },
    ...intentComponents,
    { id: 'objective', component: 'Text', text: { path: '/objective' }, variant: 'body' },
    { id: 'contract-meta', component: 'Text', text: { path: '/contractMeta' }, variant: 'caption' },
    { id: 'claims-title', component: 'Text', text: { path: '/claimsTitle' }, variant: 'h5' },
    ...claimComponents,
    { id: 'checks-title', component: 'Text', text: { path: '/checksTitle' }, variant: 'h5' },
    ...checkComponents,
    { id: 'coverage', component: 'Text', text: { path: '/coverage' }, variant: 'caption' },
    ...(outcomeComponents.length === 0 ? [] : [
      { id: 'outcome-title', component: 'Text', text: { path: '/outcomeTitle' }, variant: 'h5' },
      ...outcomeComponents,
    ]),
    ...(warningComponents.length === 0 ? [] : [
      { id: 'warning-title', component: 'Text', text: { path: '/warningTitle' }, variant: 'h5' },
      ...warningComponents,
    ]),
    { id: 'receipt', component: 'Text', text: { path: '/receipt' }, variant: 'caption' },
    {
      id: 'feedback', component: 'TextField', label: 'Revision feedback (optional)',
      value: { path: '/feedback' }, variant: 'longText',
    },
    { id: 'actions', component: 'Row', children: ['reject', 'revise', 'approve'], justify: 'end', align: 'center' },
    { id: 'reject-label', component: 'Text', text: { path: '/rejectLabel' } },
    { id: 'reject', component: 'Button', child: 'reject-label', variant: 'borderless', action: action('reliability.contract.reject') },
    { id: 'revise-label', component: 'Text', text: { path: '/reviseLabel' } },
    { id: 'revise', component: 'Button', child: 'revise-label', variant: 'default', action: action('reliability.contract.revise', true) },
    { id: 'approve-label', component: 'Text', text: { path: '/approveLabel' } },
    { id: 'approve', component: 'Button', child: 'approve-label', variant: 'primary', action: action('reliability.contract.approve') },
  ]
  const messages: A2uiReviewMessage[] = [
    {
      version: A2UI_WIRE_VERSION,
      createSurface: { surfaceId, catalogId: A2UI_BASIC_CATALOG, sendDataModel: false },
    },
    { version: A2UI_WIRE_VERSION, updateComponents: { surfaceId, components } },
    { version: A2UI_WIRE_VERSION, updateDataModel: { surfaceId, path: '/', value: data } },
  ]
  return {
    kind: 'reliability-contract-review',
    version: 1,
    mimeType: A2UI_MIME_TYPE,
    specVersion: A2UI_SPEC_VERSION,
    proposalReceipt: proposal.proposalReceipt,
    surfaceId,
    messages,
  }
}

/** Build the first deterministic A2UI surface for semantic intent review. */
export function createA2uiIntentReviewEnvelope(
  proposal: ReliabilityIntentReviewProposal,
): ReliabilityA2uiIntentReviewEnvelope {
  const surfaceId = `reliability-intent-${proposal.proposalReceipt.slice('sha256:'.length, 'sha256:'.length + 24)}`
  const data = intentReviewData(proposal)
  const groups = [
    ['constraints', data.constraints as string[]],
    ['assumptions', data.assumptions as string[]],
    ['nonGoals', data.nonGoals as string[]],
    ['ambiguities', data.ambiguities as string[]],
  ] as const
  const groupComponents = groups.map(([prefix, values]) => ({
    prefix,
    titleId: `${prefix}-title`,
    items: textComponents(prefix, values, 'caption'),
  }))
  const action = (name: ReliabilityReviewAction, feedback = false) => ({
    event: {
      name,
      context: {
        proposalReceipt: proposal.proposalReceipt,
        ...(feedback ? { feedback: { path: '/feedback' } } : {}),
      },
    },
  })
  const contentChildren = [
    'title', 'explanation', 'objective', 'authorship',
    ...groupComponents.flatMap(group => [group.titleId, ...group.items.map(item => item.id)]),
    'receipt', 'feedback', 'actions',
  ]
  const components: A2uiComponent[] = [
    { id: 'root', component: 'Card', child: 'content' },
    { id: 'content', component: 'Column', children: contentChildren, align: 'stretch' },
    { id: 'title', component: 'Text', text: { path: '/title' }, variant: 'h3' },
    { id: 'explanation', component: 'Text', text: { path: '/explanation' }, variant: 'body' },
    { id: 'objective', component: 'Text', text: { path: '/objective' }, variant: 'body' },
    { id: 'authorship', component: 'Text', text: { path: '/authorship' }, variant: 'caption' },
    ...groupComponents.flatMap(group => [
      { id: group.titleId, component: 'Text', text: { path: `/${group.prefix}Title` }, variant: 'h5' },
      ...group.items,
    ]),
    { id: 'receipt', component: 'Text', text: { path: '/receipt' }, variant: 'caption' },
    {
      id: 'feedback', component: 'TextField', label: 'Correction or clarification (optional)',
      value: { path: '/feedback' }, variant: 'longText',
    },
    { id: 'actions', component: 'Row', children: ['reject', 'revise', 'approve'], justify: 'end', align: 'center' },
    { id: 'reject-label', component: 'Text', text: { path: '/rejectLabel' } },
    { id: 'reject', component: 'Button', child: 'reject-label', variant: 'borderless', action: action('reliability.intent.reject') },
    { id: 'revise-label', component: 'Text', text: { path: '/reviseLabel' } },
    { id: 'revise', component: 'Button', child: 'revise-label', variant: 'default', action: action('reliability.intent.revise', true) },
    { id: 'approve-label', component: 'Text', text: { path: '/approveLabel' } },
    { id: 'approve', component: 'Button', child: 'approve-label', variant: 'primary', action: action('reliability.intent.approve') },
  ]
  const messages: A2uiReviewMessage[] = [
    {
      version: A2UI_WIRE_VERSION,
      createSurface: { surfaceId, catalogId: A2UI_BASIC_CATALOG, sendDataModel: false },
    },
    { version: A2UI_WIRE_VERSION, updateComponents: { surfaceId, components } },
    { version: A2UI_WIRE_VERSION, updateDataModel: { surfaceId, path: '/', value: data } },
  ]
  return {
    kind: 'reliability-intent-review',
    version: 1,
    mimeType: A2UI_MIME_TYPE,
    specVersion: A2UI_SPEC_VERSION,
    proposalReceipt: proposal.proposalReceipt,
    surfaceId,
    messages,
  }
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function utf8ByteLength(value: string): number {
  return utf8Bytes(value).byteLength
}

function base64UrlEncode(value: string): string {
  const bytes = utf8Bytes(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64UrlDecode(value: string): string {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)))
}

/** Add the A2UI envelope as an invisible marker after the readable native fallback. */
export function encodeA2uiReviewDetail(fallbackMarkdown: string, envelope: ReliabilityA2uiReviewEnvelope): string {
  const json = JSON.stringify(envelope)
  if (utf8ByteLength(json) > MAX_A2UI_ENVELOPE_BYTES) {
    throw new Error(`A2UI review envelope exceeds ${MAX_A2UI_ENVELOPE_BYTES} bytes`)
  }
  return `${fallbackMarkdown}\n\n${DETAIL_MARKER_OPEN}${base64UrlEncode(json)}${DETAIL_MARKER_CLOSE}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Parse only the governor's bounded, fixed-purpose A2UI review envelope. */
export function decodeA2uiReviewDetail(detail: string): ReliabilityA2uiReviewEnvelope | undefined {
  const start = detail.lastIndexOf(DETAIL_MARKER_OPEN)
  if (start < 0 || !detail.endsWith(DETAIL_MARKER_CLOSE)) return undefined
  const encodedStart = start + DETAIL_MARKER_OPEN.length
  const encoded = detail.slice(encodedStart, -DETAIL_MARKER_CLOSE.length)
  if (encoded.length === 0 || encoded.length > Math.ceil(MAX_A2UI_ENVELOPE_BYTES * 4 / 3) + 8) return undefined
  let parsed: unknown
  try {
    const decoded = base64UrlDecode(encoded)
    if (utf8ByteLength(decoded) > MAX_A2UI_ENVELOPE_BYTES) return undefined
    parsed = JSON.parse(decoded)
  } catch {
    return undefined
  }
  const envelope = record(parsed)
  if (envelope === undefined
    || !['reliability-contract-review', 'reliability-intent-review'].includes(String(envelope.kind))
    || envelope.version !== 1
    || envelope.mimeType !== A2UI_MIME_TYPE
    || envelope.specVersion !== A2UI_SPEC_VERSION
    || typeof envelope.proposalReceipt !== 'string'
    || typeof envelope.surfaceId !== 'string'
    || !Array.isArray(envelope.messages)
    || envelope.messages.length !== 3) return undefined
  const [create, components, data] = envelope.messages.map(record)
  const createBody = record(create?.createSurface)
  const componentBody = record(components?.updateComponents)
  const dataBody = record(data?.updateDataModel)
  if (create?.version !== A2UI_WIRE_VERSION
    || components?.version !== A2UI_WIRE_VERSION
    || data?.version !== A2UI_WIRE_VERSION
    || createBody?.surfaceId !== envelope.surfaceId
    || createBody.catalogId !== A2UI_BASIC_CATALOG
    || componentBody?.surfaceId !== envelope.surfaceId
    || dataBody?.surfaceId !== envelope.surfaceId
    || !Array.isArray(componentBody.components)
    || componentBody.components.length > 240
    || record(dataBody.value) === undefined) return undefined
  const allowed = new Set(['Card', 'Column', 'Row', 'Text', 'TextField', 'Button'])
  const allowedActions = envelope.kind === 'reliability-intent-review'
    ? ['reliability.intent.approve', 'reliability.intent.revise', 'reliability.intent.reject']
    : ['reliability.contract.approve', 'reliability.contract.revise', 'reliability.contract.reject']
  for (const raw of componentBody.components) {
    const component = record(raw)
    if (component === undefined || typeof component.id !== 'string'
      || typeof component.component !== 'string' || !allowed.has(component.component)) return undefined
    if ('url' in component || 'functionCall' in component) return undefined
    if (component.component === 'Button') {
      const event = record(record(component.action)?.event)
      if (event === undefined || !allowedActions.includes(String(event.name))) return undefined
    }
  }
  return envelope as unknown as ReliabilityA2uiReviewEnvelope
}
