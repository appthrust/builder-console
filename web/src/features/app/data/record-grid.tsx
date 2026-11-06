// One 表's rows: DataTable (ui kit) with header sort toggles, cells from the
// field-kind registry, the display column as the row link (opens the row sheet
// through `?row=`), and the paging / last-read footer.
import { getCoreRowModel, useReactTable, type ColumnDef, type SortingState, type Updater } from '@tanstack/react-table'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { toDataRow, type Catalog, type Collection, type DataRow } from '../../../model/data-catalog'
import { Button, cn, DataTable, IconButton } from '../../../ui'
import { dataText } from './copy'
import { cellAlign, FieldCell } from './field-kinds/cells'

export interface GridSort {
  orderBy?: string
  direction: 'asc' | 'desc'
}

interface GridRow {
  id: string
  row?: DataRow
  values: Record<string, unknown>
}

export function RecordGrid({
  catalog,
  collection,
  rows,
  sort,
  onSortChange,
  rowHref,
  emptyState,
  offset,
  limit,
  hasNext,
  onPage,
  fetchedAt,
  refreshing,
  onRefresh,
}: {
  catalog: Catalog
  collection: Collection
  rows: readonly Record<string, unknown>[]
  sort: GridSort
  onSortChange: (sort: GridSort) => void
  /** Link that opens the row sheet; omitted for 表 whose rows have no key. */
  rowHref?: (row: DataRow) => string
  emptyState: ReactNode
  offset: number
  limit: number
  hasNext: boolean
  onPage: (offset: number) => void
  /** Relative time of the last read (「3 分前」). */
  fetchedAt?: string
  refreshing: boolean
  onRefresh: () => void
}) {
  const data = useMemo<GridRow[]>(
    () =>
      rows.map((values, index) => {
        const row = toDataRow(collection, values)
        return { id: row ? `k:${row.key}` : `i:${offset + index}`, row, values }
      }),
    [rows, collection, offset]
  )

  const columns = useMemo<ColumnDef<GridRow>[]>(() => {
    const labels = new Map(catalog.collections.map((item) => [`${item.schema}.${item.name}`, item.label]))
    return collection.fields.map((field) => ({
      id: field.name,
      header: field.label,
      accessorFn: (row) => row.values[field.name],
      enableSorting: field.kind !== 'json',
      cell: ({ row }) => (
        <FieldCell
          field={field}
          value={row.original.values[field.name]}
          referenceLabel={field.reference ? labels.get(`${field.reference.schema}.${field.reference.table}`) : undefined}
        />
      ),
      meta: {
        label: field.label,
        primary: field.name === collection.displayField,
        className: cn(cellAlign[field.kind], field.name === collection.primaryKey && field.name !== collection.displayField && 'w-16 text-stone-500'),
      },
    }))
  }, [catalog, collection])

  const sorting: SortingState = sort.orderBy ? [{ id: sort.orderBy, desc: sort.direction === 'desc' }] : []
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    manualSorting: true,
    sortDescFirst: false,
    onSortingChange: (updater: Updater<SortingState>) => {
      const next = (typeof updater === 'function' ? updater(sorting) : updater)[0]
      onSortChange(next ? { orderBy: next.id, direction: next.desc ? 'desc' : 'asc' } : { direction: 'asc' })
    },
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  })

  const first = rows.length ? offset + 1 : offset
  return (
    <div className="space-y-3">
      <DataTable
        table={table}
        caption={dataText.gridCaption(collection.label)}
        emptyState={emptyState}
        rowHref={rowHref ? (row) => (row.row ? rowHref(row.row) : '') : undefined}
      />
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-stone-600">
        <nav aria-label={dataText.pagination} className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon={<ChevronLeft aria-hidden />} disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>
            {dataText.previousPage}
          </Button>
          {rows.length ? <span className="tabular-nums">{dataText.pageRange(first, offset + rows.length)}</span> : null}
          <Button size="sm" disabled={!hasNext} onClick={() => onPage(offset + limit)}>
            {dataText.nextPage}
            <ChevronRight aria-hidden className="ml-1" />
          </Button>
        </nav>
        <span className="flex items-center gap-1 text-xs text-stone-500">
          {fetchedAt ? dataText.fetchedAt(fetchedAt) : null}
          <IconButton label={dataText.refresh} icon={<RefreshCw aria-hidden />} loading={refreshing} onClick={onRefresh} />
        </span>
      </div>
    </div>
  )
}
