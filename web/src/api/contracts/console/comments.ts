// App comments (cmd/server/internal/api/comments.go): the reference Console
// vertical. The list is a bare array the server always initializes (never
// null); authors may be unknown people (store hydrate of a removed person).
import { z } from 'zod'
import { comment } from './schema/schemas'
import { operations } from './schema/operations'
import type { AppComment } from '../../../model/contracts/console'
import { consoleContract, consoleEmptyContract } from '../define'
import { personRefReader } from './person'

export const commentReader: z.ZodType<AppComment> = comment.strip().extend({ author: personRefReader })

const appComments = (appId: string) => `/api/console/apps/${encodeURIComponent(appId)}/comments`

export const listCommentsContract = consoleContract({
  ...operations.comments,
  reader: z.array(commentReader),
  request: (appId: string) => ({ method: 'GET', path: appComments(appId) }),
})

export const postCommentContract = consoleContract({
  ...operations.postComment,
  reader: commentReader,
  request: ({ appId, body }: { appId: string; body: string }) => ({ method: 'POST', path: appComments(appId), body: { body } }),
})

export const removeCommentContract = consoleEmptyContract({
  ...operations.removeComment,
  request: ({ appId, commentId }: { appId: string; commentId: string }) => ({
    method: 'DELETE',
    path: `${appComments(appId)}/${encodeURIComponent(commentId)}`,
  }),
})
