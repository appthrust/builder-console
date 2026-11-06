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
import { type Group, type Membership } from '../../api/console'
import { membersQuery } from '../../api/queries'
import { copy } from '../../copy'
import { locale } from '../../shell/language'
import { useShell } from '../../shell/use-shell'
import { Avatar, DataTable, EmptyState, LoadFailed, Skeleton } from '../../ui'
import { text } from './copy'

const column = createColumnHelper<Membership>()
const NO_MEMBERS: Membership[] = []

/** Direct + inherited members of a group, read-only: membership is managed in the Directory. */
export function GroupMembers({ group }: { group: Group }) {
  const { me, groups } = useShell()
  const members = useQuery(membersQuery(group.id))
  const [sorting, setSorting] = useState<SortingState>([])

  const columns = useMemo(() => {
    const groupName = (groupId: string) => groups.find((candidate) => candidate.id === groupId)?.name ?? groupId
    return [
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
      column.accessor('role', {
        id: 'role',
        header: copy.members.columns.role,
        meta: { className: 'w-36' },
        cell: ({ getValue }) => <span className="text-stone-700">{copy.members.role[getValue()]}</span>,
      }),
      column.accessor('inheritedFrom', {
        id: 'inherited',
        header: text.members.inheritedColumn,
        enableSorting: false,
        cell: ({ getValue }) => {
          const from = getValue()
          return from ? (
            <span className="whitespace-nowrap text-stone-600">{copy.members.inherited(groupName(from))}</span>
          ) : (
            <span className="whitespace-nowrap text-stone-400">{text.members.direct}</span>
          )
        },
      }),
    ]
  }, [groups, me.person.id])

  const table = useReactTable({
    data: members.data ?? NO_MEMBERS,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (membership) => `${membership.person.id}-${membership.inheritedFrom ?? 'direct'}`,
  })

  return (
    <div className="space-y-4">
      <p className="text-sm text-stone-500">{copy.members.lead}</p>
      {members.isPending ? (
        <div role="status" aria-label={copy.common.loading} className="space-y-2 rounded-lg border border-stone-200 bg-white p-4">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
      ) : members.isError ? (
        <LoadFailed error={members.error} onRetry={() => void members.refetch()} />
      ) : (
        <DataTable
          table={table}
          caption={copy.members.title}
          emptyState={<EmptyState icon={<Users aria-hidden />} title={copy.members.empty} />}
        />
      )}
      <p className="text-xs text-stone-500">{copy.members.readOnly}</p>
    </div>
  )
}
