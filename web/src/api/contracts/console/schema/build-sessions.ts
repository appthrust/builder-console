import { z } from 'zod'

// JSON Schema counts Unicode scalar values, not JavaScript UTF-16 code units.
// Metadata keeps the generated schema authoritative for the Go consumer too.
const encoder = new TextEncoder()
export function scalarText(min: number, max: number, bytes?: number) {
  return z.string().superRefine((value, ctx) => {
    const length = [...value].length
    if (length < min || length > max || /[\uD800-\uDFFF]/u.test(value)) ctx.addIssue({ code: 'custom', message: 'Invalid Unicode scalar length' })
    if (bytes !== undefined && encoder.encode(value).length > bytes) ctx.addIssue({ code: 'custom', message: 'UTF-8 byte limit exceeded' })
  }).meta({ minLength: min, maxLength: max, ...(bytes === undefined ? {} : { 'x-maxUtf8Bytes': bytes }) })
}
// Literal Unicode whitespace keeps ECMA-262 and Go's regexp engine aligned;
// JavaScript \\S and Go \\S disagree outside ASCII.
const nonblankPattern = '[^\\t\\n\\x0B\\f\\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
const nonblankRE = new RegExp(nonblankPattern, 'u')
const nonblank = (max: number, bytes?: number) => scalarText(1, max, bytes).regex(nonblankRE).meta({ pattern: nonblankPattern })
const id = z.uuid()
const opaqueID = nonblank(512)
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const timestamp = z.iso.datetime({ offset: false })
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const observed = <T extends z.ZodType>(value: T) => value.optional().meta({ presence: 'optionalObservation' })
const total = <T extends z.ZodType>(value: T) => z.array(value).meta({ presence: 'total' })
export const buildLifecycles = ['initializing', 'specifying', 'planning', 'planned', 'created', 'archived'] as const
export const buildTurnStates = ['accepted', 'dispatching', 'running', 'validating', 'awaiting_confirmation', 'repair_required', 'syncing_spec', 'starting_plan', 'planning', 'succeeded', 'failed'] as const
export const buildStages = ['accepted', 'dispatching', 'waking', 'runtime_starting', 'queued', 'thinking', 'validating', 'repair_required', 'repairing', 'awaiting_confirmation', 'syncing_spec', 'starting_plan', 'needs_runtime', 'needs_auth'] as const
export const buildNextActions = ['none', 'observe', 'advance', 'confirm', 'resume'] as const
export const buildProjectionStates = ['not_requested', 'pending', 'syncing', 'applied', 'conflict', 'failed'] as const
export const buildSyncStates = ['pending', 'syncing', 'applied', 'failed'] as const
export const buildIntents = ['auto', 'question', 'suggestions', 'change', 'undecided'] as const
export const buildErrorCodes = [
  'invalid_argument', 'unauthorized', 'forbidden', 'not_found', 'idempotency_conflict', 'precondition_required', 'version_conflict',
  'session_busy', 'workspace_busy', 'needs_runtime', 'conflict', 'artifact_path_changed', 'failed_precondition', 'draft_spec_conflict',
  'artifact_upload_timeout', 'input_too_large', 'payload_too_large', 'artifact_uploads_busy', 'artifact_store_unsupported',
  'artifact_store_unavailable', 'service_unavailable', 'status_unavailable', 'insufficient_storage', 'artifact_lost',
  'reply_invalid', 'artifact_integrity_failed', 'agent_failed', 'agent_timed_out', 'agent_interaction_required',
] as const
export const buildErrorDetails = z.strictObject({
  field: observed(nonblank(256)), reason: observed(nonblank(128)), policy: observed(nonblank(128)),
  currentVersion: observed(version), resource: observed(z.enum(['session', 'operation', 'workspace', 'artifact'])),
  retryable: observed(z.boolean()), limit: observed(z.enum(['files', 'bytes', 'entries', 'depth'])), observedAt: observed(timestamp),
})
export const buildError = z.strictObject({ error: z.enum(buildErrorCodes), message: nonblank(2000), details: observed(buildErrorDetails) })
export const buildETag = z.string().regex(/^"bs-[1-9][0-9]*"$/).refine((value) => {
  const match = /^"bs-([1-9][0-9]*)"$/.exec(value)
  return match !== null && BigInt(match[1]!) <= BigInt(Number.MAX_SAFE_INTEGER)
}, 'Version exceeds safe integer range').meta({ 'x-maxVersion': Number.MAX_SAFE_INTEGER })
export const buildIdempotencyKey = z.string().min(1).max(128).regex(/^[\x20-\x7e]+$/)
export const buildCreateHeaders = z.strictObject({ 'Idempotency-Key': buildIdempotencyKey })
export const buildMutationHeaders = buildCreateHeaders.extend({ 'If-Match': buildETag })
export const buildMessage = nonblank(4000, 16384)
export const buildSpecMarkdown = nonblank(196608, 196608)
export const buildSpecification = z.strictObject({ revision, sha256: digest, markdown: buildSpecMarkdown })
export const buildSpecRevision = buildSpecification.extend({ sourceTurnId: id.nullable(), createdAt: timestamp }).superRefine((value, ctx) => {
  if ((value.revision === 0) !== (value.sourceTurnId === null)) ctx.addIssue({ code: 'custom', path: ['sourceTurnId'], message: 'Only revision zero has no source turn' })
}).meta({ allOf: [{ if: { properties: { revision: { const: 0 } } }, then: { properties: { sourceTurnId: { type: 'null' } } }, else: { properties: { sourceTurnId: { type: 'string' } } } }] })
export const buildProposedSpec = z.strictObject({ sha256: digest, markdown: buildSpecMarkdown })
const optionID = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)
export const buildCandidate = z.strictObject({ id: optionID, label: nonblank(40), description: nonblank(200) })
export const buildOpenDecision = z.strictObject({ topic: nonblank(80), wish: nonblank(200) })
export const buildSuggestedReply = z.strictObject({ id: optionID, label: nonblank(40), message: nonblank(80) })
function uniqueOptions(values: readonly { id: string; label: string }[], ctx: z.RefinementCtx) {
  for (const field of ['id', 'label'] as const) {
    const seen = new Set<string>()
    values.forEach((value, index) => {
      if (seen.has(value[field])) ctx.addIssue({ code: 'custom', path: [index, field], message: 'Duplicate option' })
      seen.add(value[field])
    })
  }
}
export const buildReply = z.strictObject({
  schemaVersion: z.literal(1), turnId: id, attempt: z.number().int().min(0).max(1), baseSpecRevision: revision,
  answer: nonblank(2000), summary: scalarText(0, 200),
  changes: total(nonblank(200)).max(8).refine((items) => new Set(items).size === items.length, 'Duplicate change').meta({ uniqueItems: true }),
  candidates: total(buildCandidate).max(4).superRefine(uniqueOptions).meta({ 'x-uniqueBy': ['id', 'label'] }), openDecisions: total(buildOpenDecision).max(8),
  nextQuestion: nonblank(200).nullable(), suggestedReplies: total(buildSuggestedReply).max(4).superRefine(uniqueOptions).meta({ 'x-uniqueBy': ['id', 'label'] }), specChanged: z.boolean(),
}).superRefine((reply, ctx) => {
  if (reply.specChanged ? !nonblankRE.test(reply.summary) : reply.summary !== '') ctx.addIssue({ code: 'custom', path: ['summary'], message: 'Summary must describe a spec change only' })
  if (reply.specChanged ? reply.changes.length === 0 : reply.changes.length !== 0) ctx.addIssue({ code: 'custom', path: ['changes'], message: 'Changes must match specChanged' })
  const text = [reply.answer, reply.summary, ...reply.changes, ...reply.candidates.flatMap((x) => [x.label, x.description]), ...reply.openDecisions.flatMap((x) => [x.topic, x.wish]), reply.nextQuestion ?? '', ...reply.suggestedReplies.flatMap((x) => [x.label, x.message])]
  if (text.reduce((sum, value) => sum + [...value].length, 0) > 2000) ctx.addIssue({ code: 'custom', message: 'Display text exceeds 2000 scalar values' })
}).meta({
  'x-displayTextMaxLength': 2000,
  allOf: [
    { if: { properties: { specChanged: { const: false } } }, then: { properties: { changes: { maxItems: 0 }, summary: { maxLength: 0 } } } },
    { if: { properties: { specChanged: { const: true } } }, then: { properties: { changes: { minItems: 1 }, summary: { minLength: 1, pattern: nonblankPattern } } } },
  ],
})
// This is the typed context for S4-2, not a natural-language or YAML validator.
export const buildReplyContext = z.strictObject({ turnId: id, attempt: z.number().int().min(0).max(1), baseSpecRevision: revision, intent: z.enum(buildIntents) })
export const buildReplyValidation = z.strictObject({ expected: buildReplyContext, reply: buildReply, inputSpec: buildSpecMarkdown, outputSpec: buildSpecMarkdown }).superRefine((input, ctx) => {
  for (const field of ['turnId', 'attempt', 'baseSpecRevision'] as const) if (input.reply[field] !== input.expected[field]) ctx.addIssue({ code: 'custom', path: ['reply', field], message: 'Reply does not match request' })
  if (['question', 'suggestions', 'undecided'].includes(input.expected.intent) && input.reply.specChanged) ctx.addIssue({ code: 'custom', path: ['reply', 'specChanged'], message: 'This intent cannot change the specification' })
  if (input.expected.intent === 'suggestions' && input.reply.candidates.length < 2) ctx.addIssue({ code: 'custom', path: ['reply', 'candidates'], message: 'Suggestions require 2–4 concrete candidates' })
  if (input.reply.specChanged === (input.inputSpec === input.outputSpec)) ctx.addIssue({ code: 'custom', path: ['outputSpec'], message: 'Specification bytes must agree with specChanged' })
}).meta({ 'x-replyContext': true })
export const buildProjection = z.strictObject({ state: z.enum(buildProjectionStates), appliedRevision: observed(revision) })
export const buildProgress = z.strictObject({ stage: z.enum(buildStages), observedAt: timestamp, activity: total(nonblank(200)).max(3) })
export const buildResolution = z.strictObject({ decision: z.enum(['accept_spec', 'keep_spec']) })
export const buildConversationRequest = z.strictObject({ kind: z.literal('conversation'), message: buildMessage, intent: z.enum(buildIntents), baseSpecRevision: revision })
export const buildPlanRequest = z.strictObject({ kind: z.literal('request_plan'), specRevision: revision })
export const buildTurnRequest = z.discriminatedUnion('kind', [buildConversationRequest, buildPlanRequest])
export const buildTurnCommon = z.strictObject({
  id, ordinal: version, kind: z.enum(['conversation', 'request_plan']), state: z.enum(buildTurnStates), baseSpecRevision: revision,
  sessionVersion: version, createdAt: timestamp, updatedAt: timestamp, progress: observed(buildProgress),
  nextAction: z.enum(buildNextActions), pollAfterMs: observed(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)), failure: observed(buildError),
})
export const buildConversationTurn = buildTurnCommon.extend({
  state: z.enum(buildTurnStates).extract(['accepted', 'dispatching', 'running', 'validating', 'awaiting_confirmation', 'repair_required', 'succeeded', 'failed']),
  kind: z.literal('conversation'), request: buildConversationRequest, attempt: z.number().int().min(0).max(1), promptVersion: nonblank(128),
  reply: observed(buildReply), proposedSpec: observed(buildProposedSpec), resolution: observed(buildResolution),
})
export const buildPlanTurn = buildTurnCommon.extend({
  kind: z.literal('request_plan'), specRevision: revision, platformGenerationId: observed(opaqueID), projection: buildProjection,
  state: z.enum(buildTurnStates).extract(['accepted', 'syncing_spec', 'starting_plan', 'planning', 'succeeded', 'failed']),
})
export const buildTurn = z.discriminatedUnion('kind', [buildConversationTurn, buildPlanTurn])
export const buildSession = z.strictObject({
  id, kind: z.literal('new-app'), engine: z.literal('console-v1'), version, lifecycle: z.enum(buildLifecycles),
  groupId: opaqueID, locale: z.enum(['ja', 'en']), createdAt: timestamp, updatedAt: timestamp, archivedAt: observed(timestamp),
  draftId: observed(opaqueID), specification: buildSpecification, activeTurnId: observed(id), projection: buildProjection,
  capabilities: z.strictObject({ canConverse: z.boolean(), canRequestPlan: z.boolean() }), nextAction: z.enum(buildNextActions),
  pollAfterMs: observed(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)), failure: observed(buildError),
  plan: observed(z.strictObject({ specRevision: revision, stale: z.boolean() })),
})
export const buildCreateSession = z.strictObject({ kind: z.literal('new-app'), groupId: opaqueID, intent: nonblank(4000, 4000), locale: z.enum(['ja', 'en']) })
export const buildPublishInput = z.strictObject({
  name: nonblank(40).refine((value) => !/[\r\n\u0085\u2028\u2029]/u.test(value), 'Name must be one line').meta({ not: { pattern: '[\r\n\u0085\u2028\u2029]' } }),
  shareScope: z.enum(['private', 'group', 'company']),
})
export const buildPublishResult = z.strictObject({ desired: buildPublishInput, sessionVersion: version, sync: z.strictObject({ state: z.enum(buildSyncStates), failure: observed(buildError) }) })
export const buildResolve = z.discriminatedUnion('engine', [z.strictObject({ engine: z.literal('console-v1'), sessionId: id }), z.strictObject({ engine: z.literal('platform-v1'), draftId: opaqueID })])
export const buildListQuery = z.strictObject({ cursor: observed(nonblank(2048)), limit: z.number().int().min(1).max(50).optional() })
const page = <T extends z.ZodType>(item: T) => z.strictObject({ items: total(item), nextCursor: observed(nonblank(2048)) })
// Writer enums stay closed. The SPA tolerates future observations, never future
// commands. These reader wires also participate in the shared Go/TS fixtures.
export const buildReadError = buildError.extend({ error: z.string() })
export const buildReadProjection = buildProjection.extend({ state: z.string() })
export const buildReadProgress = buildProgress.extend({ stage: z.string() })
const readTurnFields = { state: z.string(), nextAction: z.string(), progress: observed(buildReadProgress), failure: observed(buildReadError) }
export const buildReadConversationTurn = buildConversationTurn.extend(readTurnFields)
export const buildReadPlanTurn = buildPlanTurn.extend({ ...readTurnFields, projection: buildReadProjection })
export const buildReadTurn = z.discriminatedUnion('kind', [buildReadConversationTurn, buildReadPlanTurn])
export const buildReadSession = buildSession.extend({ lifecycle: z.string(), nextAction: z.string(), projection: buildReadProjection, failure: observed(buildReadError) })
export const buildSchemas = {
  BuildReply: buildReply, BuildReplyContext: buildReplyContext, BuildReplyValidation: buildReplyValidation,
  BuildSession: buildSession, BuildSessionList: page(buildSession), BuildTurn: buildTurn, BuildTurnList: page(buildTurn),
  BuildConversationTurn: buildConversationTurn, BuildPlanTurn: buildPlanTurn,
  BuildSpecification: buildSpecification, BuildSpecRevision: buildSpecRevision, BuildProposedSpec: buildProposedSpec,
  BuildError: buildError, BuildETag: buildETag, BuildCreateHeaders: buildCreateHeaders, BuildMutationHeaders: buildMutationHeaders,
  BuildCreateSession: buildCreateSession, BuildTurnRequest: buildTurnRequest, BuildConversationRequest: buildConversationRequest, BuildPlanRequest: buildPlanRequest,
  BuildResolution: buildResolution, BuildPublishInput: buildPublishInput, BuildPublishResult: buildPublishResult,
  BuildResolve: buildResolve, BuildListQuery: buildListQuery, BuildEmptyInput: z.strictObject({}),
  BuildSessionRead: buildReadSession, BuildTurnRead: buildReadTurn, BuildErrorRead: buildReadError,
}
export type BuildSchemaName = keyof typeof buildSchemas
