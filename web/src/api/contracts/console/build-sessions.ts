import { z } from 'zod'
import { defineResponseContract, openEnum } from '../../boundary'
import * as wire from './schema/build-sessions'
import { buildSessionOperations } from './schema/build-session-operations'

const failure = wire.buildReadError.extend({ error: openEnum(wire.buildErrorCodes) })
const projection = wire.buildReadProjection.extend({ state: openEnum(wire.buildProjectionStates) })
const progress = wire.buildReadProgress.extend({ stage: openEnum(wire.buildStages) })
export const buildSessionReader = wire.buildReadSession.extend({
  lifecycle: openEnum(wire.buildLifecycles), nextAction: openEnum(wire.buildNextActions), projection, failure: failure.optional(),
})
const turnFields = { state: openEnum(wire.buildTurnStates), nextAction: openEnum(wire.buildNextActions), progress: progress.optional(), failure: failure.optional() }
export const buildTurnReader = z.discriminatedUnion('kind', [
  wire.buildReadConversationTurn.extend(turnFields),
  wire.buildReadPlanTurn.extend({ ...turnFields, projection }),
])
const publishReader = wire.buildPublishResult.extend({ sync: wire.buildPublishResult.shape.sync.extend({ state: openEnum(wire.buildSyncStates), failure: failure.optional() }) })
const readers = {
  BuildSession: buildSessionReader,
  BuildSessionList: wire.buildSchemas.BuildSessionList.extend({ items: z.array(buildSessionReader) }),
  BuildTurn: buildTurnReader,
  BuildTurnList: wire.buildSchemas.BuildTurnList.extend({ items: z.array(buildTurnReader) }),
  BuildResolve: wire.buildResolve,
  BuildSpecRevision: wire.buildSpecRevision,
  BuildPublishResult: publishReader,
}
// Response boundaries only. No client/route/handler is registered by S4-0.
export const buildSessionContracts = {
  create: defineResponseContract({ ...buildSessionOperations.create, source: 'console', reader: readers.BuildSession }),
  list: defineResponseContract({ ...buildSessionOperations.list, source: 'console', reader: readers.BuildSessionList }),
  get: defineResponseContract({ ...buildSessionOperations.get, source: 'console', reader: readers.BuildSession }),
  resolve: defineResponseContract({ ...buildSessionOperations.resolve, source: 'console', reader: readers.BuildResolve }),
  advance: defineResponseContract({ ...buildSessionOperations.advance, source: 'console', reader: readers.BuildSession }),
  createTurn: defineResponseContract({ ...buildSessionOperations.createTurn, source: 'console', reader: readers.BuildTurn }),
  listTurns: defineResponseContract({ ...buildSessionOperations.listTurns, source: 'console', reader: readers.BuildTurnList }),
  getTurn: defineResponseContract({ ...buildSessionOperations.getTurn, source: 'console', reader: readers.BuildTurn }),
  resolveTurn: defineResponseContract({ ...buildSessionOperations.resolveTurn, source: 'console', reader: readers.BuildTurn }),
  specRevision: defineResponseContract({ ...buildSessionOperations.specRevision, source: 'console', reader: readers.BuildSpecRevision }),
  publishPreferences: defineResponseContract({ ...buildSessionOperations.publishPreferences, source: 'console', reader: readers.BuildPublishResult }),
  archive: defineResponseContract({ ...buildSessionOperations.archive, source: 'console', reader: readers.BuildSession }),
}
export type BuildSession = z.output<typeof buildSessionReader>
export type BuildTurn = z.output<typeof buildTurnReader>
export type BuildReply = z.output<typeof wire.buildReply>
export type BuildSpecification = z.output<typeof wire.buildSpecification>
export type BuildSpecRevision = z.output<typeof wire.buildSpecRevision>
export type BuildError = z.output<typeof failure>
export type BuildCreateSessionInput = z.input<typeof wire.buildCreateSession>
export type BuildTurnInput = z.input<typeof wire.buildTurnRequest>
export type BuildResolutionInput = z.input<typeof wire.buildResolution>
export type BuildPublishInput = z.input<typeof wire.buildPublishInput>
export type BuildPublishResult = z.output<typeof publishReader>
export type BuildResolveResult = z.output<typeof wire.buildResolve>
export type BuildListQuery = z.input<typeof wire.buildListQuery>
export type BuildMutationHeaders = z.input<typeof wire.buildMutationHeaders>
export type BuildCreateHeaders = z.input<typeof wire.buildCreateHeaders>
export type BuildETag = z.output<typeof wire.buildETag>
