import { z } from 'zod'
import { directoryUser } from './schema/schemas'
import { operations } from './schema/operations'
import { consoleContract, consoleEmptyContract } from '../define'
import { personReader } from './person'
import { accessRequestReader, appReader, createdAccessRequestReader, entryReader, membershipReader, migrationReader, myAccessRequestReader, profileReader, resolvedReader, screenshotReader, settingsReader, toolsReader } from './readers'
import { meContract } from './me'
import { configContract } from './config'
import { groupsContract } from './groups'
import { listCommentsContract, postCommentContract, removeCommentContract } from './comments'

export type AppListInput = { scope?: 'mine' | 'company' | 'all'; groupId?: string; q?: string }
export type DirectoryAppsInput = { groupId?: string; q?: string; ownerId?: string }
export type ShareInput = { scope: 'private' | 'group' | 'company' | 'public'; groupIds: string[]; extraPersonIds: string[] }
export type CreateAppInput = { displayName: string; groupId: string; description?: string; icon?: string; tags?: string[]; slug?: string; share?: ShareInput }
export type UpdateAppInput = Partial<CreateAppInput> & { guide?: string; capabilities?: string[]; ownerIds?: string[] }
const appPath = (id: string) => `/api/console/apps/${encodeURIComponent(id)}`
function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value)
  const result = search.toString()
  return result ? `?${result}` : ''
}
const items = <T extends z.ZodType>(reader: T) => z.object({ items: z.array(reader) }).transform((value) => value.items)

export const appsContract = consoleContract({ ...operations.apps, reader: items(appReader), request: (input: AppListInput = {}) => ({ method: 'GET', path: `/api/console/apps${query({ scope: input.scope, group: input.groupId, q: input.q })}` }) })
export const appContract = consoleContract({ ...operations.app, reader: appReader, request: (appId: string) => ({ method: 'GET', path: appPath(appId) }) })
export const appByPathContract = consoleContract({ ...operations.appByPath, reader: appReader, request: ({ groupPath, slug }: { groupPath: string; slug: string }) => ({ method: 'GET', path: `/api/console/apps/by-path/${groupPath.split('/').filter(Boolean).map(encodeURIComponent).join('/')}/${encodeURIComponent(slug)}` }) })
export const createAppContract = consoleContract({ ...operations.createApp, reader: appReader, request: (body: CreateAppInput) => ({ method: 'POST', path: '/api/console/apps', body }) })
export const updateAppContract = consoleContract({ ...operations.updateApp, reader: appReader, request: ({ appId, input }: { appId: string; input: UpdateAppInput }) => ({ method: 'PATCH', path: appPath(appId), body: input }) })
export const bindAppContract = consoleContract({ ...operations.bindApp, reader: appReader, request: ({ appId, stackId, appName }: { appId: string; stackId: string; appName: string }) => ({ method: 'POST', path: `${appPath(appId)}/bind`, body: { stackId, appName } }) })
export const removeAppContract = consoleEmptyContract({ ...operations.removeApp, request: (appId: string) => ({ method: 'DELETE', path: appPath(appId) }) })
export const directoryAppsContract = consoleContract({ ...operations.directoryApps, reader: items(entryReader), request: (input: DirectoryAppsInput = {}) => ({ method: 'GET', path: `/api/console/apps${query({ scope: 'directory', group: input.groupId, q: input.q, ownerId: input.ownerId })}` }) })
export const directoryEntryContract = consoleContract({ ...operations.directoryEntry, reader: entryReader, request: (appId: string) => ({ method: 'GET', path: `${appPath(appId)}/directory-entry` }) })
export const toolsContract = consoleContract({ ...operations.tools, reader: toolsReader, request: (appId: string) => ({ method: 'GET', path: `${appPath(appId)}/tools` }) })
export const resolveContract = consoleContract({ ...operations.resolve, reader: resolvedReader, request: (path: string) => ({ method: 'GET', path: `/api/console/resolve${query({ path })}` }) })
export const peopleContract = consoleContract({ ...operations.people, reader: items(personReader), request: (input: { q?: string; subject?: string; ids?: string[] }) => ({ method: 'GET', path: `/api/console/directory/people${query({ q: input.q, subject: input.subject, ids: input.ids?.join(',') })}` }) })
export const personContract = consoleContract({ ...operations.person, reader: profileReader, request: (personId: string) => ({ method: 'GET', path: `/api/console/directory/people/${encodeURIComponent(personId)}` }) })
export const createPersonContract = consoleContract({ ...operations.createPerson, reader: personReader, request: (body: { email: string; displayName: string }) => ({ method: 'POST', path: '/api/console/directory/people', body }) })
export const membersContract = consoleContract({ ...operations.members, reader: items(membershipReader), request: (groupId: string) => ({ method: 'GET', path: `/api/console/directory/groups/${encodeURIComponent(groupId)}/members` }) })
export const directoryUsersContract = consoleContract({ ...operations.directoryUsers, reader: items(directoryUser), request: (q: string) => ({ method: 'GET', path: `/api/console/directory/directory-users${query({ q })}` }) })
export const uploadScreenshotContract = consoleContract({ ...operations.uploadScreenshot, reader: screenshotReader, request: ({ appId, file, caption }: { appId: string; file: File; caption?: string }) => {
  const body = new FormData()
  body.set('file', file)
  if (caption) body.set('caption', caption)
  return { method: 'POST', path: `${appPath(appId)}/screenshots`, body }
} })
export const removeScreenshotContract = consoleEmptyContract({ ...operations.removeScreenshot, request: ({ appId, screenshotId }: { appId: string; screenshotId: string }) => ({ method: 'DELETE', path: `${appPath(appId)}/screenshots/${encodeURIComponent(screenshotId)}` }) })
export const reorderScreenshotsContract = consoleContract({ ...operations.reorderScreenshots, reader: z.array(screenshotReader), request: ({ appId, order }: { appId: string; order: string[] }) => ({ method: 'PATCH', path: `${appPath(appId)}/screenshots`, body: { order } }) })
export const myAccessRequestContract = consoleContract({ ...operations.myAccessRequest, reader: myAccessRequestReader, request: (appName: string) => ({ method: 'GET', path: `/api/console/access-requests/mine${query({ appName })}` }) })
export const createAccessRequestContract = consoleContract({ ...operations.createAccessRequest, reader: createdAccessRequestReader, request: (body: { appName: string; message: string }) => ({ method: 'POST', path: '/api/console/access-requests', body }) })
export const pendingAccessRequestsContract = consoleContract({ ...operations.pendingAccessRequests, reader: z.array(accessRequestReader), request: () => ({ method: 'GET', path: '/api/console/access-requests?status=pending' }) })
export const appAccessRequestsContract = consoleContract({ ...operations.appAccessRequests, reader: z.array(accessRequestReader), request: (appId: string) => ({ method: 'GET', path: `${appPath(appId)}/access-requests` }) })
export const approveAccessRequestContract = consoleContract({ ...operations.approveAccessRequest, reader: z.object({ request: accessRequestReader, app: appReader }), request: ({ appId, requestId }: { appId: string; requestId: string }) => ({ method: 'POST', path: `${appPath(appId)}/access-requests/${encodeURIComponent(requestId)}/approve` }) })
export const declineAccessRequestContract = consoleContract({ ...operations.declineAccessRequest, reader: z.object({ request: accessRequestReader }), request: ({ appId, requestId }: { appId: string; requestId: string }) => ({ method: 'POST', path: `${appPath(appId)}/access-requests/${encodeURIComponent(requestId)}/decline` }) })
export const settingsContract = consoleContract({ ...operations.settings, reader: settingsReader, request: () => ({ method: 'GET', path: '/api/console/admin/platform' }) })
export const migrateDirectoryContract = consoleContract({ ...operations.migrateDirectory, reader: migrationReader, request: () => ({ method: 'POST', path: '/api/console/admin/directory-migrate' }) })

export const consoleContracts = {
  me: meContract, config: configContract, groups: groupsContract, people: peopleContract, person: personContract,
  createPerson: createPersonContract, members: membersContract, directoryUsers: directoryUsersContract,
  resolve: resolveContract, apps: appsContract, app: appContract, appByPath: appByPathContract,
  createApp: createAppContract, updateApp: updateAppContract, bindApp: bindAppContract, removeApp: removeAppContract,
  directoryApps: directoryAppsContract, directoryEntry: directoryEntryContract, tools: toolsContract,
  comments: listCommentsContract, postComment: postCommentContract, removeComment: removeCommentContract,
  uploadScreenshot: uploadScreenshotContract, removeScreenshot: removeScreenshotContract, reorderScreenshots: reorderScreenshotsContract,
  myAccessRequest: myAccessRequestContract, createAccessRequest: createAccessRequestContract,
  pendingAccessRequests: pendingAccessRequestsContract, appAccessRequests: appAccessRequestsContract,
  approveAccessRequest: approveAccessRequestContract, declineAccessRequest: declineAccessRequestContract,
  settings: settingsContract, migrateDirectory: migrateDirectoryContract,
} satisfies Record<keyof typeof operations, unknown>
