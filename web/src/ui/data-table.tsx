// Renders a @tanstack/react-table instance: sortable headers with aria-sort,
// zebra rows, horizontal scroll from md up and stacked cards below 768px.
// With `rowHref`, the primary cell (column meta `primary`, else the first
// column) becomes a real link for keyboard / new-tab use and a click anywhere
// on the row navigates.
import { useRouter } from '@tanstack/react-router'
import { flexRender, type Cell, type Column, type Row, type RowData, type Table } from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import type { MouseEvent, ReactNode } from 'react'
import { copy } from '../copy'
import { cn } from './cn'
import { EmptyState } from './feedback'
import { HrefLink } from './link'

declare module '@tanstack/react-table' {
  // Type parameters must match the library's declaration to merge.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Classes for the column's th and td (width, alignment). */
    className?: string
    /** Label in the stacked (<768px) layout; defaults to the header when it is a string. */
    label?: string
    /** Row-link target and card title on narrow screens; defaults to the first column. */
    primary?: boolean
    /** Omit the column from the stacked (<768px) layout. */
    hideOnMobile?: boolean
  }
}

const INTERACTIVE = 'a,button,input,select,textarea,label,[role="button"],[role="checkbox"],[role="menuitem"]'

const ARIA_SORT = { asc: 'ascending', desc: 'descending' } as const

function columnLabel<T>(column: Column<T, unknown>): string {
  const header = column.columnDef.header
  return column.columnDef.meta?.label ?? (typeof header === 'string' ? header : column.id)
}

export function DataTable<T>({
  table,
  emptyState,
  rowHref,
  caption,
  className,
}: {
  table: Table<T>
  emptyState?: ReactNode
  rowHref?: (row: T) => string
  caption?: string
  className?: string
}) {
  const router = useRouter()
  const rows = table.getRowModel().rows
  const columns = table.getVisibleLeafColumns()
  const primaryId = (columns.find((column) => column.columnDef.meta?.primary) ?? columns[0])?.id

  if (rows.length === 0) return <>{emptyState ?? <EmptyState title={copy.common.empty} />}</>

  const openRow = (row: Row<T>) => (event: MouseEvent<HTMLElement>) => {
    if (!rowHref || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if ((event.target as HTMLElement).closest(INTERACTIVE)) return
    if (window.getSelection()?.toString()) return
    void router.navigate({ href: rowHref(row.original) })
  }

  const renderCell = (cell: Cell<T, unknown>) => {
    const content = flexRender(cell.column.columnDef.cell, cell.getContext())
    if (!rowHref || cell.column.id !== primaryId) return content
    return (
      <HrefLink href={rowHref(cell.row.original)} className="block min-h-10 min-w-0 content-center rounded text-stone-900 hover:text-accent-strong md:min-h-0">
        {content}
      </HrefLink>
    )
  }

  return (
    <div className={className}>
      <div className="hidden overflow-x-auto rounded-lg border border-line bg-white md:block">
        <table className="w-full text-left text-sm">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead className="border-b border-line bg-stone-50/80 text-xs text-stone-500">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted()
                  const canSort = header.column.getCanSort()
                  const label = header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      colSpan={header.colSpan}
                      aria-sort={canSort ? (sorted ? ARIA_SORT[sorted] : 'none') : undefined}
                      className={cn('px-4 py-2.5 font-medium whitespace-nowrap', header.column.columnDef.meta?.className)}
                    >
                      {canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="-mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-stone-200/60 hover:text-stone-800"
                        >
                          {label}
                          {sorted === 'asc' ? (
                            <ArrowUp aria-hidden className="size-3.5 text-stone-700" />
                          ) : sorted === 'desc' ? (
                            <ArrowDown aria-hidden className="size-3.5 text-stone-700" />
                          ) : (
                            <ChevronsUpDown aria-hidden className="size-3.5 text-stone-400" />
                          )}
                        </button>
                      ) : (
                        label
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                onClick={rowHref ? openRow(row) : undefined}
                className={cn(
                  'border-t border-stone-100 align-middle first:border-t-0 even:bg-stone-50/50',
                  rowHref && 'cursor-pointer transition-colors hover:bg-accent-soft/50'
                )}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className={cn('px-4 py-3', cell.column.columnDef.meta?.className)}>
                    {renderCell(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul aria-label={caption} className="space-y-2 md:hidden">
        {rows.map((row) => {
          const cells = row.getVisibleCells()
          const primary = cells.find((cell) => cell.column.id === primaryId)
          const rest = cells.filter((cell) => cell.column.id !== primaryId && !cell.column.columnDef.meta?.hideOnMobile)
          return (
            <li
              key={row.id}
              onClick={rowHref ? openRow(row) : undefined}
              className={cn('rounded-lg border border-line bg-white px-4 py-3', rowHref && 'cursor-pointer active:bg-stone-50')}
            >
              {primary ? <div className="min-w-0 text-sm">{renderCell(primary)}</div> : null}
              {rest.length > 0 ? (
                <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                  {rest.map((cell) => (
                    <div key={cell.id} className="contents">
                      <dt className="text-xs leading-5 text-stone-500">{columnLabel(cell.column)}</dt>
                      <dd className="min-w-0 text-stone-700">{flexRender(cell.column.columnDef.cell, cell.getContext())}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
