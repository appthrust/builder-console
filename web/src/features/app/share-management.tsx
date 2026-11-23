import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { assignOrganizationGroups, readShareDiff, removeOrganizationGroups, shareAccessQuery, startAccessCutover, type ShareAccess, type ShareDiff } from '../../api/sharing'
import type { BusinessApp } from '../../model/contracts/console'
import { sharingCopy as words } from '../../copy/sharing'
import { ActionError, Button, ConfirmDialog, LoadFailed, Notice, Select } from '../../ui'

export function organizationGroupsDisabledReason(access: ShareAccess | undefined): string | undefined {
  if (!access) return words.organization.failed
  if (!access.canManageBindings) return words.organization.denied
  if (!access.organizationGroups.declared) return words.organization.undeclared
  if (!access.organizationGroups.accepted) return words.organization.unaccepted
  if (!access.organizationGroups.roles.length) return words.organization.applying
  if (!access.organizationSource) return words.organization.unavailable
  if (!access.organizationSource.initialSyncComplete) return words.organization.syncing
  if (!access.organizationSource.ready) return words.organization.failed
  return undefined
}

/** Membership disclosure is independent of the four URL-sharing scopes. */
export function ShareManagement({ app, open }: { app: BusinessApp; open: boolean }) {
  const queryClient = useQueryClient()
  const query = shareAccessQuery(app.id)
  const access = useQuery({ ...query, enabled: open && Boolean(app.stackId), refetchInterval: (state) => {
    const phase = state.state.data?.cutover?.phase
    return open && phase && !['AppEnforced', 'Restored'].includes(phase) ? 3_000 : false
  } })
  const [role, setRole] = useState('')
  const [disclosure, setDisclosure] = useState<{ role: string; binding?: string }>()
  const [confirmCutover, setConfirmCutover] = useState<{ diff: ShareDiff; previousDigest?: string }>()
  const selectedRole = access.data?.organizationGroups.roles.includes(role) ? role : access.data?.organizationGroups.roles[0] ?? ''
  const reason = organizationGroupsDisabledReason(access.data)
  const existing = access.data?.bindings.filter((binding) => binding.organizationGroupSourceRef) ?? []
  const save = useMutation({
    mutationFn: async (change: { role: string; binding?: string }) => change.binding
      ? removeOrganizationGroups(app.id, change.binding, crypto.randomUUID())
      : assignOrganizationGroups(app.id, change.role, crypto.randomUUID()),
    onSuccess: (data) => { queryClient.setQueryData(query.queryKey, data); setDisclosure(undefined) },
    onSettled: () => queryClient.invalidateQueries({ queryKey: query.queryKey }),
  })
  const diff = useMutation({ mutationFn: () => readShareDiff(app.id) })
  const cutover = useMutation({
    mutationFn: (snapshot: { diff: ShareDiff; previousDigest?: string }) => startAccessCutover(app.id, snapshot.diff, crypto.randomUUID(), snapshot.previousDigest),
    onSuccess: () => { setConfirmCutover(undefined); diff.reset() },
    onSettled: () => queryClient.invalidateQueries({ queryKey: query.queryKey }),
  })
  const restore = useMutation({
    mutationFn: () => readShareDiff(app.id),
    onSuccess: (diff) => {
      const previousDigest = access.data?.cutover?.previousDigest
      if (previousDigest && diff.unresolvedCount === 0) setConfirmCutover({ diff, previousDigest })
    },
  })
  const snapshot = diff.data
  const source = access.data?.organizationSource
  const phase = access.data?.cutover?.phase
  const applied = phase === 'AppEnforced'
  const running = Boolean(phase && !['AppEnforced', 'Restored'].includes(phase))
  return <>
    <section aria-label={words.organization.title} className="space-y-3 border-t border-stone-100 pt-4">
      <h3 className="font-medium text-stone-900">{words.organization.title}</h3>
      {access.data?.shareSync === 'conflict' ? <Notice tone="warning">{words.divergence}</Notice> : null}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={existing.length > 0} disabled={Boolean(reason) || save.isPending || existing.length > 0} onChange={() => setDisclosure({ role: selectedRole })} />
        {words.organization.all}
      </label>
      <Select aria-label={words.organization.role} value={selectedRole} onChange={setRole} disabled={Boolean(reason) || save.isPending || existing.length > 0} options={(access.data?.organizationGroups.roles ?? []).map((name) => ({ value: name, label: name }))} />
      {reason ? <p role="status" className="text-sm text-stone-600">{reason}</p> : null}
      {access.isError ? <LoadFailed error={access.error} onRetry={() => void access.refetch()} /> : null}
      {source?.initialSyncComplete && (!source.ready || source.consecutiveFailures > 0) ? <p className="text-sm text-stone-600">{words.organization.version(source.appliedVersion)}</p> : null}
      {existing.length ? <ul>{existing.map((binding) => <li key={binding.name} className="flex items-center justify-between gap-3 text-sm">
        <span>{words.organization.all} · {binding.role}</span>
        <Button size="sm" disabled={!access.data?.canManageBindings || save.isPending} onClick={() => setDisclosure({ role: binding.role, binding: binding.name })}>{words.organization.remove}</Button>
      </li>)}</ul> : access.isSuccess ? <p className="text-sm text-stone-500">{words.organization.none}</p> : null}
    </section>
    {access.data?.isOwner && access.data.canManageBindings ? <section aria-label={words.cutover.title} className="space-y-3 border-t border-stone-100 pt-4">
      <h3 className="font-medium text-stone-900">{words.cutover.title}</h3>
      {applied ? <p role="status">{words.cutover.applied}</p> : running ? <p role="status">{words.cutover.running}</p> : <Button disabled={diff.isPending || cutover.isPending || app.shareSync !== 'applied' || access.data.shareSync !== 'applied'} onClick={() => { setConfirmCutover(undefined); diff.mutate() }}>{words.cutover.compare}</Button>}
      {applied ? <Button disabled={!access.data.cutover?.previousDigest || restore.isPending || cutover.isPending} onClick={() => restore.mutate()}>{words.cutover.restore}</Button> : null}
      {snapshot && !applied && !running ? <>
        <div className="grid gap-4 sm:grid-cols-2">{(['added', 'removed'] as const).map((direction) => <div key={direction}>
          <h4 className="font-medium">{words.cutover[direction]} ({direction === 'added' ? snapshot.addedCount : snapshot.removedCount})</h4>
          {(direction === 'added' ? snapshot.newAuthenticated && !snapshot.oldAuthenticated : snapshot.oldAuthenticated && !snapshot.newAuthenticated) ? <p>{words.cutover.authenticated}</p> : null}
          <ul>{snapshot[direction].map((person) => <li key={person.principal}>{person.displayName ?? person.principal}</li>)}</ul>
        </div>)}</div>
        {snapshot.unresolvedCount > 0 || !snapshot.candidateDigest ? <Notice tone="warning">{words.cutover.unresolved}</Notice> : <Button tone="primary" disabled={cutover.isPending} onClick={() => setConfirmCutover({ diff: snapshot })}>{words.cutover.confirm}</Button>}
      </> : null}
      {diff.error ? <ActionError error={diff.error} /> : null}
      {restore.error ? <ActionError error={restore.error} /> : null}
      {restore.data && restore.data.unresolvedCount > 0 ? <Notice tone="warning">{words.cutover.unresolved}</Notice> : null}
      {cutover.error ? <ActionError error={cutover.error} /> : null}
    </section> : null}
    <ConfirmDialog open={Boolean(disclosure)} onOpenChange={(next) => { if (!next) setDisclosure(undefined) }} title={disclosure?.binding ? words.organization.remove : words.organization.add} body={disclosure ? words.organization.confirm(disclosure.role, Boolean(disclosure.binding)) : ''} confirmLabel={disclosure?.binding ? words.organization.remove : words.organization.add} pending={save.isPending} error={save.error ?? undefined} onConfirm={() => { if (disclosure) save.mutate(disclosure) }} />
    <ConfirmDialog open={Boolean(confirmCutover)} onOpenChange={(next) => { if (!next) setConfirmCutover(undefined) }} title={confirmCutover?.previousDigest ? words.cutover.restore : words.cutover.title} body={words.cutover.confirmation} confirmText={app.displayName} confirmLabel={confirmCutover?.previousDigest ? words.cutover.restore : words.cutover.confirm} pending={cutover.isPending} error={cutover.error ?? undefined} onConfirm={() => { if (confirmCutover) cutover.mutate(confirmCutover) }} />
  </>
}
