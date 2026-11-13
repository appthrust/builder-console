// App comments (cmd/server/internal/api/comments.go): the reference Console
// vertical. The list is a bare array the server always initializes (never
// null); authors may be unknown people (store hydrate of a removed person).
import { z } from 'zod'
import type { AppComment } from '../../../model/contracts/console'
import { consoleContract, consoleEmptyContract } from '../define'
import { personRefReader } from './person'

const commentReader: z.ZodType<AppComment> = z.object({
  id: z.string().min(1),
  appId: z.string().min(1),
  author: personRefReader,
  body: z.string(),
  createdAt: z.string(),
})

const appComments = (appId: string) => `/api/console/apps/${encodeURIComponent(appId)}/comments`

export const listCommentsContract = consoleContract({
  operationId: 'consoleListAppComments',
  method: 'GET',
  routeTemplate: '/api/console/apps/{id}/comments',
  successStatuses: [200],
  reader: z.array(commentReader),
  request: (appId: string) => ({ method: 'GET', path: appComments(appId) }),
})

export const postCommentContract = consoleContract({
  operationId: 'consolePostAppComment',
  method: 'POST',
  routeTemplate: '/api/console/apps/{id}/comments',
  successStatuses: [201],
  reader: commentReader,
  request: ({ appId, body }: { appId: string; body: string }) => ({ method: 'POST', path: appComments(appId), body: { body } }),
})

export const removeCommentContract = consoleEmptyContract({
  operationId: 'consoleDeleteAppComment',
  method: 'DELETE',
  routeTemplate: '/api/console/apps/{id}/comments/{cid}',
  successStatuses: [204],
  request: ({ appId, commentId }: { appId: string; commentId: string }) => ({
    method: 'DELETE',
    path: `${appComments(appId)}/${encodeURIComponent(commentId)}`,
  }),
})
