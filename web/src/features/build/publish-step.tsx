import type { PublishPreferences } from '../../model/contracts/build'
import { useStore } from '@tanstack/react-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { buildGroupTree, flattenGroupTree, type BusinessApp } from '../../model/contracts/console'
import { keys } from '../../api/queries/shared'
import { consoleKeys, updateApp, useGroups, useMe } from '../../api/queries/console'
import { putAppAccess, retryAccess } from '../../api/access'
import { knownScope, shareSentence } from '../../model/share'
import { UnconfirmedNotice, useWriteConfirmation } from '../app/notices'
import { ActionError, Button, Card, CardBody, Field, TextInput } from '../../ui'
import { effectiveShareGroupIds, initialValues, useCreateForm } from '../create/form'
import { ShareStep } from '../create/steps/share-step'
import { text } from './copy'

/** The saved draft determines defaults even in a new tab, before console metadata catches up. */
export function PublishStep({ app, publishId, publishPreferences, onPublished, onCancel }: { app: BusinessApp; publishId?: string; publishPreferences?: PublishPreferences; onPublished(app: BusinessApp): void; onCancel(): void }) {
  const me = useMe().data
  const groups = useGroups().data
  const queryClient = useQueryClient()
  // A saved scope this console does not know is not offered back: the form starts from the narrowest audience.
  const scope = publishPreferences?.shareScope ?? knownScope(app.share.scope) ?? 'private'
  const [name, setName] = useState(publishPreferences?.name ?? app.displayName)
  const form = useCreateForm(app.group.id, { ...initialValues(app.group.id), scope, shareGroupIds: app.share.groupIds.length ? [...app.share.groupIds] : null })
  const values = useStore(form.store, (state) => state.values)
  const [confirmName, setConfirmName] = useState('')
  const share = { scope: values.scope, groupIds: values.scope === 'group' ? effectiveShareGroupIds(values) : [], extraPersonIds: [...app.share.extraPersonIds] }
  const expanding = values.scope === 'company' || values.scope === 'public'
  const valid = name.trim().length > 0 && name.trim().length <= 200 && (values.scope !== 'group' || share.groupIds.length > 0) && (values.scope !== 'public' || me.isConsoleAdmin) && (!expanding || confirmName === name.trim())
  const requestKey = useRef('')
  const mutation = useMutation({
    mutationFn: async () => {
      if (!publishId) throw new Error(text.publish.waitingForUrl)
      await putAppAccess(me.projectId, publishId, share.scope, requestKey.current)
      return updateApp(app.id, { displayName: name.trim(), share })
    },
    retry: retryAccess,
    retryDelay: 3_000,
    onSuccess: async (updated) => {
      // A read of the app that started before the write must not land over its answer.
      await queryClient.cancelQueries({ queryKey: consoleKeys.app(app.id), exact: true })
      queryClient.setQueryData(consoleKeys.app(app.id), updated)
      await queryClient.invalidateQueries({ queryKey: ['console', 'apps'] })
      await queryClient.invalidateQueries({ queryKey: keys.publishes(me.projectId) })
      onPublished(updated)
    },
  })
  // A publish whose answer could not be read may have happened: read the app and its publish back first.
  const confirmation = useWriteConfirmation([mutation.error], mutation.reset, () => Promise.all([
    queryClient.refetchQueries({ queryKey: consoleKeys.app(app.id), exact: true }),
    queryClient.refetchQueries({ queryKey: keys.publishes(me.projectId) }),
  ]))
  return <section aria-labelledby="build-share-title"><Card><CardBody>
    <h3 id="build-share-title" className="mb-4 text-lg font-semibold text-stone-900">{text.publish.title}</h3>
    <form onSubmit={(event) => { event.preventDefault(); if (valid && publishId && !mutation.isPending && !confirmation.unconfirmed) { requestKey.current = crypto.randomUUID(); mutation.mutate() } }} className="space-y-5">
      <Field id="publish-name" label={text.publish.name}><TextInput id="publish-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={200} autoComplete="off" /></Field>
      <ShareStep form={form} groups={flattenGroupTree(buildGroupTree(groups))} isConsoleAdmin={me.isConsoleAdmin} shareText={shareSentence(share, groups, app.group)} />
      {expanding ? <Field id="publish-confirm-name" label={text.publish.confirmName} hint={name.trim()}><TextInput id="publish-confirm-name" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} autoComplete="off" /></Field> : null}
      {confirmation.unconfirmed ? <UnconfirmedNotice onConfirm={() => void confirmation.confirm()} confirming={confirmation.confirming} /> : mutation.isError ? <ActionError error={mutation.error} /> : null}
      <div className="flex flex-wrap gap-2"><Button type="submit" tone="primary" loading={mutation.isPending} disabled={!valid || !publishId || confirmation.unconfirmed}>{text.publish.submit}</Button><Button disabled={mutation.isPending} onClick={onCancel}>{text.publish.back}</Button></div>
    </form>
  </CardBody></Card></section>
}
