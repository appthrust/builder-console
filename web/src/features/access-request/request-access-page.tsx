import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2, Clock3, FileQuestion, Lock } from 'lucide-react'
import { useState } from 'react'
import { isConsoleError } from '../../api/console'
import { consoleKeys, createAccessRequest, myAccessRequestQuery, useMe } from '../../api/queries/console'
import type { MyAccessRequest } from '../../model/contracts/console'
import { StaleNotice, UnconfirmedNotice, useWriteConfirmation } from '../app/notices'
import { copy } from '../../copy'
import { accessRequestCopy as words } from '../../copy/access-request'
import { appOrigin, stateFromReason } from '../../model/access-request'
import { paths } from '../../routes/paths'
import { locale } from '../../shell/language'
import { ActionError, Button, Card, CardBody, CopyButton, Field, Loading, Notice, TextArea, useDocumentTitle } from '../../ui'

const MAX_MESSAGE_LENGTH = 500

export function RequestAccessPage({ appName, reason }: { appName: string; reason?: string }) {
  useDocumentTitle(`${words.title} · ${appName}`)
  const { data: me } = useMe()
  const queryClient = useQueryClient()
  const [message, setMessage] = useState('')
  const unknownApp = appName === '_' || stateFromReason(reason) === 'unknown_app'
  const mine = useQuery({
    ...myAccessRequestQuery(appName),
    enabled: !unknownApp,
    throwOnError: (error) => isConsoleError(error) && error.status === 401,
  })
  const create = useMutation({
    mutationFn: () => createAccessRequest({ appName, message }),
    throwOnError: (error) => isConsoleError(error) && error.status === 401,
    onSuccess: async (result) => {
      const key = consoleKeys.accessRequestMine(appName)
      // A read that started before the request must not land over its answer; an answer of a kind this console does not know is only read back.
      await queryClient.cancelQueries({ queryKey: key, exact: true })
      if (result.kind === 'supported') {
        const answer = result.value
        const next: MyAccessRequest = answer.state === 'pending'
          ? { appName, exists: true, state: { kind: 'known', value: 'pending' }, requestedAt: answer.requestedAt }
          : { appName, exists: true, state: { kind: 'known', value: 'granted' } }
        queryClient.setQueryData(key, next)
      }
      setMessage('')
      await queryClient.invalidateQueries({ queryKey: key })
    },
  })
  // A request whose answer could not be read may have been sent: read the state back before offering it again (the message stays).
  const confirmation = useWriteConfirmation([create.error], create.reset, () => queryClient.refetchQueries({ queryKey: consoleKeys.accessRequestMine(appName), exact: true }))
  const request = mine.data?.exists ? mine.data : undefined
  const notFound = unknownApp || mine.data?.exists === false || isConsoleError(create.error, 'not_found')
  // A state this console does not know is neither granted nor open for a new request.
  const state = notFound ? 'not_found' : mine.data === undefined ? mine.isError ? 'unavailable' : 'loading' : request?.state.kind === 'unknown' ? 'unavailable' : request?.state.value ?? 'none'
  const stale = mine.isError && mine.data !== undefined
  const messageLength = Array.from(message).length
  const tooLong = messageLength > MAX_MESSAGE_LENGTH
  const canRequest = state === 'none' || state === 'declined'
  const requestBlocked = stale || confirmation.unconfirmed
  const origin = appOrigin(appName, window.location.hostname)
  const showAppUrl = origin !== undefined && (state === 'none' || state === 'pending' || state === 'declined' || state === 'granted')
  const Icon = state === 'not_found' ? FileQuestion : state === 'granted' ? CheckCircle2 : state === 'pending' ? Clock3 : state === 'unavailable' ? AlertCircle : Lock
  const title = state === 'not_found' ? words.notFound : state === 'granted' ? words.granted : state === 'pending' ? words.sent : state === 'declined' ? words.declined : state === 'unavailable' ? words.unavailable : words.needAccess
  let body = words.notShared(appName)
  if (state === 'not_found') body = words.notFoundBody
  if (state === 'granted') body = words.grantedBody
  if (state === 'unavailable') body = words.unavailableBody
  if (state === 'pending') body = request?.requestedAt ? words.waiting(new Date(request.requestedAt).toLocaleString(locale())) : words.waitingWithoutDate
  if (state === 'declined') body = request?.decidedAt ? words.declinedBody(new Date(request.decidedAt).toLocaleString(locale())) : words.declinedWithoutDate

  return (
    <div className="w-full max-w-md">
      <Card>
        <CardBody className="space-y-6 py-8">
          {state === 'loading' ? <Loading className="justify-center" /> : (
            <>
              {stale ? <StaleNotice updatedAt={mine.dataUpdatedAt} refetching={mine.isFetching} onRetry={() => void mine.refetch()} /> : null}
              <div className="text-center" aria-live="polite">
                <Icon aria-hidden className="mx-auto mb-4 size-8 text-stone-500" />
                <h1 className="text-xl font-semibold text-stone-900">{title}</h1>
                <p className="mt-3 break-words text-sm leading-relaxed text-stone-600">{body}</p>
              </div>
              {showAppUrl ? (
                <div className="text-center">
                  <p className="text-xs text-stone-500">{words.appUrl}</p>
                  <div className="mt-1 flex items-center justify-center gap-1">
                    <a href={origin} className="min-w-0 break-all text-sm font-medium text-accent-strong hover:underline">{origin}</a>
                    <CopyButton value={origin} label={words.copyUrl} iconOnly />
                  </div>
                </div>
              ) : null}
              {canRequest ? (
                <form className="space-y-4" onSubmit={(event) => {
                  event.preventDefault()
                  if (!tooLong && !create.isPending && !requestBlocked) create.mutate()
                }}>
                  <Field
                    id="access-request-message"
                    label={words.message}
                    hint={<span className="block text-right">{words.remaining(MAX_MESSAGE_LENGTH - messageLength)}</span>}
                    error={tooLong ? words.messageTooLong : undefined}
                  >
                    <TextArea
                      id="access-request-message"
                      rows={3}
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      disabled={create.isPending}
                      invalid={tooLong}
                    />
                  </Field>
                  {confirmation.unconfirmed
                    ? <UnconfirmedNotice onConfirm={() => void confirmation.confirm()} confirming={confirmation.confirming} />
                    : create.error ? isConsoleError(create.error, 'too_many_requests') ? <Notice tone="error">{words.tooMany}</Notice> : <ActionError error={create.error} /> : null}
                  <Button type="submit" tone="primary" className="w-full" loading={create.isPending} disabled={tooLong || requestBlocked}>
                    {state === 'declined' ? words.requestAgain : words.request}
                  </Button>
                </form>
              ) : null}
              {state === 'pending' ? (
                <div className="flex justify-center">
                  <CopyButton value={words.note(appName, new URL(paths.home, window.location.origin).href)} label={words.copyNote} />
                </div>
              ) : null}
              {state === 'granted' && origin ? <Button asChild tone="primary" className="w-full"><a href={origin}>{words.openApp}</a></Button> : null}
              {state === 'unavailable' ? <Button className="w-full" loading={mine.isFetching} onClick={() => void mine.refetch()}>{copy.common.retry}</Button> : null}
            </>
          )}
          <div className="space-y-1 border-t border-stone-100 pt-5 text-center text-xs text-stone-500">
            <p className="break-all">{words.signedInAs(me.person.email)}</p>
            <a href="/logout" className="inline-flex min-h-10 items-center text-accent-strong hover:underline">{words.switchAccount}</a>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
