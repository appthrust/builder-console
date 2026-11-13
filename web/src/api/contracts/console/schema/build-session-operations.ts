import type { BuildSchemaName } from './build-sessions'

// Declarations only: S4-3 registers handlers; S4-U1 supplies the HTTP client.
// ETags always identify the session version, including a Turn response.
export type BuildOperation = {
  operationId: string
  method: 'GET' | 'POST' | 'PATCH'
  routeTemplate: string
  successStatuses: readonly number[]
  schema: BuildSchemaName
  requestSchema?: BuildSchemaName
  headersSchema?: 'BuildCreateHeaders' | 'BuildMutationHeaders'
  query?: 'page' | 'draft'
  etag?: true
  location?: true
}
export const buildSessionOperations = {
  create: { operationId: 'consoleCreateBuildSession', method: 'POST', routeTemplate: '/api/console/v1/build-sessions', successStatuses: [202], schema: 'BuildSession', requestSchema: 'BuildCreateSession', headersSchema: 'BuildCreateHeaders', etag: true },
  list: { operationId: 'consoleListBuildSessions', method: 'GET', routeTemplate: '/api/console/v1/build-sessions', successStatuses: [200], schema: 'BuildSessionList', query: 'page' },
  get: { operationId: 'consoleGetBuildSession', method: 'GET', routeTemplate: '/api/console/v1/build-sessions/{id}', successStatuses: [200], schema: 'BuildSession', etag: true },
  resolve: { operationId: 'consoleResolveBuildSession', method: 'GET', routeTemplate: '/api/console/v1/build-sessions/resolve', successStatuses: [200], schema: 'BuildResolve', query: 'draft' },
  advance: { operationId: 'consoleAdvanceBuildSession', method: 'POST', routeTemplate: '/api/console/v1/build-sessions/{id}/advance', successStatuses: [202], schema: 'BuildSession', requestSchema: 'BuildEmptyInput', headersSchema: 'BuildMutationHeaders', etag: true },
  createTurn: { operationId: 'consoleCreateBuildTurn', method: 'POST', routeTemplate: '/api/console/v1/build-sessions/{id}/turns', successStatuses: [202], schema: 'BuildTurn', requestSchema: 'BuildTurnRequest', headersSchema: 'BuildMutationHeaders', etag: true, location: true },
  listTurns: { operationId: 'consoleListBuildTurns', method: 'GET', routeTemplate: '/api/console/v1/build-sessions/{id}/turns', successStatuses: [200], schema: 'BuildTurnList', query: 'page' },
  getTurn: { operationId: 'consoleGetBuildTurn', method: 'GET', routeTemplate: '/api/console/v1/build-sessions/{id}/turns/{turnId}', successStatuses: [200], schema: 'BuildTurn', etag: true },
  resolveTurn: { operationId: 'consoleResolveBuildTurn', method: 'POST', routeTemplate: '/api/console/v1/build-sessions/{id}/turns/{turnId}/resolution', successStatuses: [200], schema: 'BuildTurn', requestSchema: 'BuildResolution', headersSchema: 'BuildMutationHeaders', etag: true },
  specRevision: { operationId: 'consoleGetBuildSpecRevision', method: 'GET', routeTemplate: '/api/console/v1/build-sessions/{id}/spec-revisions/{n}', successStatuses: [200], schema: 'BuildSpecRevision' },
  publishPreferences: { operationId: 'consoleSetBuildPublishPreferences', method: 'PATCH', routeTemplate: '/api/console/v1/build-sessions/{id}/publish-preferences', successStatuses: [202], schema: 'BuildPublishResult', requestSchema: 'BuildPublishInput', headersSchema: 'BuildMutationHeaders', etag: true },
  archive: { operationId: 'consoleArchiveBuildSession', method: 'POST', routeTemplate: '/api/console/v1/build-sessions/{id}/archive', successStatuses: [202], schema: 'BuildSession', requestSchema: 'BuildEmptyInput', headersSchema: 'BuildMutationHeaders', etag: true },
} as const satisfies Record<string, BuildOperation>
