import type { SchemaName } from './schemas'

type Operation = {
  operationId: string
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  routeTemplate: string
  successStatuses: readonly number[]
  schema: SchemaName | null
  multipart?: true
}
const op = <const T extends Operation>(value: T): T => value

// One entry per SPA operation, not per caller. The two /apps list projections
// deliberately share their HTTP route but have different response contracts.
export const operations = {
  me: op({ operationId: 'consoleGetMe', method: 'GET', routeTemplate: '/api/console/me', successStatuses: [200], schema: 'Me' }),
  config: op({ operationId: 'consoleGetConfig', method: 'GET', routeTemplate: '/config', successStatuses: [200], schema: 'Config' }),
  groups: op({ operationId: 'consoleListDirectoryGroups', method: 'GET', routeTemplate: '/api/console/directory/groups', successStatuses: [200], schema: 'GroupList' }),
  people: op({ operationId: 'consoleListDirectoryPeople', method: 'GET', routeTemplate: '/api/console/directory/people', successStatuses: [200], schema: 'PersonList' }),
  person: op({ operationId: 'consoleGetDirectoryPerson', method: 'GET', routeTemplate: '/api/console/directory/people/{id}', successStatuses: [200], schema: 'PersonProfile' }),
  createPerson: op({ operationId: 'consoleCreateDirectoryPerson', method: 'POST', routeTemplate: '/api/console/directory/people', successStatuses: [201], schema: 'Person' }),
  members: op({ operationId: 'consoleListDirectoryMembers', method: 'GET', routeTemplate: '/api/console/directory/groups/{id}/members', successStatuses: [200], schema: 'MembershipList' }),
  directoryUsers: op({ operationId: 'consoleListDirectoryUsers', method: 'GET', routeTemplate: '/api/console/directory/directory-users', successStatuses: [200], schema: 'DirectoryUserList' }),
  resolve: op({ operationId: 'consoleResolvePath', method: 'GET', routeTemplate: '/api/console/resolve', successStatuses: [200], schema: 'Resolved' }),
  apps: op({ operationId: 'consoleListApps', method: 'GET', routeTemplate: '/api/console/apps', successStatuses: [200], schema: 'AppList' }),
  app: op({ operationId: 'consoleGetApp', method: 'GET', routeTemplate: '/api/console/apps/{id}', successStatuses: [200], schema: 'App' }),
  appByPath: op({ operationId: 'consoleGetAppByPath', method: 'GET', routeTemplate: '/api/console/apps/by-path/{path}', successStatuses: [200], schema: 'App' }),
  createApp: op({ operationId: 'consoleCreateApp', method: 'POST', routeTemplate: '/api/console/apps', successStatuses: [201], schema: 'App' }),
  updateApp: op({ operationId: 'consoleUpdateApp', method: 'PATCH', routeTemplate: '/api/console/apps/{id}', successStatuses: [200], schema: 'App' }),
  bindApp: op({ operationId: 'consoleBindApp', method: 'POST', routeTemplate: '/api/console/apps/{id}/bind', successStatuses: [200], schema: 'App' }),
  removeApp: op({ operationId: 'consoleDeleteApp', method: 'DELETE', routeTemplate: '/api/console/apps/{id}', successStatuses: [204], schema: null }),
  directoryApps: op({ operationId: 'consoleListDirectoryApps', method: 'GET', routeTemplate: '/api/console/apps', successStatuses: [200], schema: 'DirectoryEntryList' }),
  directoryEntry: op({ operationId: 'consoleGetDirectoryEntry', method: 'GET', routeTemplate: '/api/console/apps/{id}/directory-entry', successStatuses: [200], schema: 'DirectoryEntry' }),
  tools: op({ operationId: 'consoleGetAppTools', method: 'GET', routeTemplate: '/api/console/apps/{id}/tools', successStatuses: [200], schema: 'Tools' }),
  comments: op({ operationId: 'consoleListAppComments', method: 'GET', routeTemplate: '/api/console/apps/{id}/comments', successStatuses: [200], schema: 'CommentList' }),
  postComment: op({ operationId: 'consolePostAppComment', method: 'POST', routeTemplate: '/api/console/apps/{id}/comments', successStatuses: [201], schema: 'Comment' }),
  removeComment: op({ operationId: 'consoleDeleteAppComment', method: 'DELETE', routeTemplate: '/api/console/apps/{id}/comments/{cid}', successStatuses: [204], schema: null }),
  uploadScreenshot: op({ operationId: 'consoleUploadScreenshot', method: 'POST', routeTemplate: '/api/console/apps/{id}/screenshots', successStatuses: [201], schema: 'Screenshot', multipart: true }),
  removeScreenshot: op({ operationId: 'consoleDeleteScreenshot', method: 'DELETE', routeTemplate: '/api/console/apps/{id}/screenshots/{sid}', successStatuses: [204], schema: null }),
  reorderScreenshots: op({ operationId: 'consoleReorderScreenshots', method: 'PATCH', routeTemplate: '/api/console/apps/{id}/screenshots', successStatuses: [200], schema: 'ScreenshotList' }),
  myAccessRequest: op({ operationId: 'consoleGetMyAccessRequest', method: 'GET', routeTemplate: '/api/console/access-requests/mine', successStatuses: [200], schema: 'MyAccessRequest' }),
  createAccessRequest: op({ operationId: 'consoleCreateAccessRequest', method: 'POST', routeTemplate: '/api/console/access-requests', successStatuses: [200, 201], schema: 'CreateAccessRequest' }),
  pendingAccessRequests: op({ operationId: 'consoleListPendingAccessRequests', method: 'GET', routeTemplate: '/api/console/access-requests', successStatuses: [200], schema: 'AccessRequestList' }),
  appAccessRequests: op({ operationId: 'consoleListAppAccessRequests', method: 'GET', routeTemplate: '/api/console/apps/{id}/access-requests', successStatuses: [200], schema: 'AccessRequestList' }),
  approveAccessRequest: op({ operationId: 'consoleApproveAccessRequest', method: 'POST', routeTemplate: '/api/console/apps/{id}/access-requests/{rid}/approve', successStatuses: [200], schema: 'ApproveAccessRequest' }),
  declineAccessRequest: op({ operationId: 'consoleDeclineAccessRequest', method: 'POST', routeTemplate: '/api/console/apps/{id}/access-requests/{rid}/decline', successStatuses: [200], schema: 'DeclineAccessRequest' }),
  settings: op({ operationId: 'consoleGetPlatformSettings', method: 'GET', routeTemplate: '/api/console/admin/platform', successStatuses: [200], schema: 'Settings' }),
  migrateDirectory: op({ operationId: 'consoleMigrateDirectory', method: 'POST', routeTemplate: '/api/console/admin/directory-migrate', successStatuses: [200], schema: 'MigrationResult' }),
} as const
