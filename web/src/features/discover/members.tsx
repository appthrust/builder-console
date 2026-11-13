import { useQuery } from '@tanstack/react-query'
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table'
import { Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { type Group } from '../../model/contracts/console'
import { type Membership } from '../../model/contracts/console'
import { knownValue } from '../../model/contracts/build'
import { membersQuery } from '../../api/queries/console'
import { copy } from '../../copy'
import { locale } from '../../shell/language'
import { useShell } from '../../shell/use-shell'
import { Avatar, DataTable, Disclosure, EmptyState, LoadFailed, Skeleton } from '../../ui'
import { text } from './copy'
import { StaleNotice } from '../app/notices'

const column = createColumnHelper<Membership>()

/**
 * Who belongs to the group (no `inheritedFrom`) versus who only has access
 * through an ancestor. Belonging is what a group page counts and lists first.
 */
export function splitMembers(members: Membership[]): { direct: Membership[]; inherited: Membership[] } {
  const direct: Membership[] = []
  const inherited: Membership[] = []
  for (const member of members) (member.inheritedFrom == null ? direct : inherited).push(member)
  return { direct, inherited }
}

/**
 * The group's own members, then the members of upper groups in a collapsed section.
 * Read-only: membership is managed in the Directory.
 */
export function GroupMembers({ group }: { group: Group }) {
  const members = useQuery(membersQuery(group.id))
  const { direct, inherited } = useMemo(() => splitMembers(members.data ?? []), [members.data])

  return (
    <div className="space-y-4">
      <p className="text-sm text-stone-500">{copy.members.lead}</p>
      {members.isPending ? (
        <div role="status" aria-label={copy.common.loading} className="space-y-2 rounded-lg border border-stone-200 bg-white p-4">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
      ) : members.isLoadingError ? (
        <LoadFailed error={members.error} onRetry={() => void members.refetch()} />
      ) : (
        <>
          {members.isRefetchError ? <StaleNotice updatedAt={members.dataUpdatedAt} refetching={members.isFetching} onRetry={() => void members.refetch()} /> : null}
          <MemberTable members={direct} caption={copy.members.title} />
          {inherited.length > 0 ? (
            <Disclosure title={copy.members.inheritedTitle(inherited.length)}>
              <MemberTable members={inherited} caption={copy.members.inheritedTitle(inherited.length)} showSource />
            </Disclosure>
          ) : null}
        </>
      )}
      <p className="text-xs text-stone-500">{copy.members.readOnly}</p>
    </div>
  )
}

/** One sortable member table; `showSource` adds the group each inherited member comes from. */
function MemberTable({ members, caption, showSource = false }: { members: Membership[]; caption: string; showSource?: boolean }) {
  const { me, groups } = useShell()
  const [sorting, setSorting] = useState<SortingState>([])

  const columns = useMemo(() => {
    const base = [
      column.accessor((membership) => membership.person.displayName, {
        id: 'name',
        header: copy.members.columns.name,
        sortingFn: (a, b) => a.original.person.displayName.localeCompare(b.original.person.displayName, locale()),
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-3">
            <Avatar person={row.original.person} />
            <span className="max-w-40 truncate font-medium whitespace-nowrap text-stone-900">
              {row.original.person.displayName}
              {row.original.person.id === me.person.id ? (
                <span className="ml-2 text-xs font-normal text-stone-500">{text.members.you}</span>
              ) : null}
            </span>
          </span>
        ),
      }),
      column.accessor((membership) => membership.person.email, {
        id: 'email',
        header: copy.members.columns.email,
        // Takes the leftover width and truncates, so the table fits narrow panes; never narrower than min-w-32.
        meta: { className: 'w-full max-w-0 min-w-32' },
        cell: ({ getValue }) => {
          const raw = getValue().trim()
          const email = !raw || raw.toLowerCase() === 'unknown' ? text.members.emailMissing : raw
          return <span className="block truncate text-stone-600" title={email}>{email}</span>
        },
      }),
      column.accessor((membership) => knownValue(membership.role) ?? '', {
        id: 'role',
        header: copy.members.columns.role,
        meta: { className: 'w-36' },
        cell: ({ getValue }) => {
          // A role this console does not know is shown as such, never as member or manager.
          const role = getValue()
          return <span className="whitespace-nowrap text-stone-700">{role ? copy.members.role[role] : text.members.roleUnknown}</span>
        },
      }),
    ]
    if (!showSource) return base
    return [
      ...base,
      column.accessor((membership) => groups.find((candidate) => candidate.id === membership.inheritedFrom)?.name ?? membership.inheritedFrom ?? '', {
        id: 'inherited',
        header: text.members.inheritedColumn,
        sortingFn: (a, b) => a.getValue<string>('inherited').localeCompare(b.getValue<string>('inherited'), locale()),
        cell: ({ getValue }) => <span className="whitespace-nowrap text-stone-600">{copy.members.inherited(getValue())}</span>,
      }),
    ]
  }, [groups, me.person.id, showSource])

  const table = useReactTable({
    data: members,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (membership) => `${membership.person.id}-${membership.inheritedFrom ?? 'direct'}`,
  })

  return (
    <DataTable
      table={table}
      caption={caption}
      emptyState={<EmptyState icon={<Users aria-hidden />} title={copy.members.empty} />}
    />
  )
}
