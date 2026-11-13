// データ tab (design/platform/builder-console-app-data.md): orchestration only.
// The URL holds the selected 表 (`?table`), the search (`?q`) and the open row
// (`?row`); sort and page are local to the selected 表. Platform vocabulary
// stays in src/model/data-catalog.ts and src/api/queries.ts.
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Eye, Lock, Plus, Search, Table2 } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { BusinessApp } from '../../../api/console-unverified'
import { dataPreconditionReason, isDataForbidden, useDatabaseCatalog, useDatabaseRows, type DatabaseCatalogQuery } from '../../../api/queries/data'
import { copy, relativeTime } from '../../../copy'
import type { AppView } from '../../../model/app'
import { rowKey, toDataRow, type Catalog, type Collection, type DataRow } from '../../../model/data-catalog'
import { paths, type AppDataSearch } from '../../../routes/paths'
import { Button, Card, EmptyState, LinkButton, Loading, LoadFailed, Notice, TextInput } from '../../../ui'
import { text } from '../copy'
import { OwnerContact } from '../owner-contact'
import { CollectionNav } from './collection-nav'
import { dataText } from './copy'
import { MembershipUnboundNotice } from './membership-unbound'
import { RecordGrid, type GridSort } from './record-grid'
import { RecordSheet } from './record-sheet'

export const DATA_PAGE_SIZE = 50
const SEARCH_DEBOUNCE_MS = 300

export function DataTab({ projectId, app, view, canEdit, isAdmin }: {
  projectId: string
  app: BusinessApp
  view: AppView
  canEdit: boolean
  isAdmin: boolean
}) {
  const databaseId = view.stack?.databaseComponentId
  const catalog = useDatabaseCatalog(projectId, databaseId)
  const search: AppDataSearch = useSearch({ strict: false })
  const navigate = useNavigate()
  const groupPath = app.group.path
  const slug = app.slug
  const go = useCallback(
    (next: AppDataSearch, replace = false) => void navigate({ href: paths.appData(groupPath, slug, next), replace }),
    [navigate, groupPath, slug]
  )

  if (!databaseId) return null
  if (catalog.error) return <Blocked error={catalog.error} app={app} view={view} isAdmin={isAdmin} onRetry={catalog.refetch} />
  if (!catalog.catalog) return <Loading />

  const visible = catalog.catalog.collections.filter((collection) => !collection.hidden)
  if (visible.length === 0) return <EmptyState icon={<Table2 />} title={dataText.noTables} />
  const selected = visible.find((collection) => collection.id === search.table) ?? visible[0]!

  return (
    <CollectionView
      projectId={projectId}
      databaseId={databaseId}
      app={app}
      view={view}
      catalog={catalog.catalog}
      catalogQuery={catalog}
      collections={visible}
      collection={selected}
      search={search}
      go={go}
      canEdit={canEdit}
      isAdmin={isAdmin}
    />
  )
}

/**
 * State that starts over per 表 without remounting the view, so the 表 Select in
 * the toolbar keeps focus across a switch. Another 表 (or coming back) reads `initial`.
 */
function usePerCollection<T>(collectionId: string, initial: T) {
  const [state, setState] = useState({ collectionId, value: initial })
  const switched = state.collectionId !== collectionId
  if (switched) setState({ collectionId, value: initial })
  const set = useCallback((next: T) => setState({ collectionId, value: next }), [collectionId])
  return [switched ? initial : state.value, set] as const
}

function CollectionView({ projectId, databaseId, app, view, catalog, catalogQuery, collections, collection, search, go, canEdit, isAdmin }: {
  projectId: string
  databaseId: string
  app: BusinessApp
  view: AppView
  catalog: Catalog
  catalogQuery: DatabaseCatalogQuery
  /** Visible collections, for the 表 Select. */
  collections: readonly Collection[]
  collection: Collection
  search: AppDataSearch
  go: (next: AppDataSearch, replace?: boolean) => void
  canEdit: boolean
  isAdmin: boolean
}) {
  const q = search.q?.trim() ?? ''
  const [draft, setDraft] = usePerCollection(collection.id, q)
  const [sort, setSort] = usePerCollection<GridSort>(collection.id, { direction: 'asc' })
  // The page belongs to one search term; a new term starts at the first page.
  const [page, setPage] = usePerCollection(collection.id, { q, offset: 0 })
  const offset = page.q === q ? page.offset : 0
  const [creating, setCreating] = usePerCollection(collection.id, false)

  const rows = useDatabaseRows(projectId, databaseId, collection.schema, collection.name, {
    limit: DATA_PAGE_SIZE,
    offset,
    ...(sort.orderBy ? { orderBy: sort.orderBy, direction: sort.direction } : {}),
    ...(q ? { q } : {}),
  })

  // Typing settles for 300 ms before the search reaches the URL (and the server).
  useEffect(() => {
    const term = draft.trim()
    if (term === q) return
    const timer = setTimeout(() => go({ table: collection.id, ...(term ? { q: term } : {}) }, true), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft, q, collection.id, go])

  // Back/forward changed the term: the box follows the URL.
  const [syncedQ, setSyncedQ] = useState(q)
  if (syncedQ !== q) {
    setSyncedQ(q)
    if (draft.trim() !== q) setDraft(q)
  }

  const pageRows = rows.data?.rows ?? []
  const openValues = search.row ? pageRows.find((item) => rowKey(collection, item) === search.row) : undefined
  const openRow: DataRow | undefined = openValues ? toDataRow(collection, openValues) : undefined
  const canAdd = collection.editable && canEdit
  // The 表's size for the Select: the latest read unless a search narrowed it.
  const estimate = (q ? undefined : rows.data?.totalEstimate) ?? collection.rowCountEstimate
  const fetchedAt = rows.dataUpdatedAt ? relativeTime(new Date(rows.dataUpdatedAt).toISOString()) : undefined
  const addButton = canAdd ? (
    <Button tone="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
      {dataText.addRow}
    </Button>
  ) : null

  return (
    <section aria-labelledby="data-collection-title" className="space-y-4">
      <Card className="px-5 py-4">
        <h2 id="data-collection-title" className="sr-only">{collection.label}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <CollectionNav collections={collections} current={collection.id} currentEstimate={estimate} onSelect={(table) => go({ table })} />
          <label className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
            <span className="sr-only">{dataText.search}</span>
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
            <TextInput type="search" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={dataText.searchPlaceholder} className="pl-9" />
          </label>
          {addButton ? <div className="ml-auto">{addButton}</div> : null}
        </div>
        {collection.description ? <p className="mt-2 text-sm text-stone-500">{collection.description}</p> : null}
        {!collection.editable ? (
          <p className="mt-2 inline-flex items-center gap-1.5 text-sm text-stone-600">
            <Eye aria-hidden className="size-4 text-stone-400" />
            {dataText.readOnly}
          </p>
        ) : null}
      </Card>

      {rows.error ? (
        <Blocked error={rows.error} app={app} view={view} isAdmin={isAdmin} onRetry={() => void rows.refetch()} />
      ) : rows.isPending ? (
        <Loading />
      ) : (
        <RecordGrid
          // A fresh grid (and horizontal scroll) per 表; keys are siblings of the sheet's.
          key={`grid:${collection.id}`}
          catalog={catalog}
          collection={collection}
          rows={pageRows}
          sort={sort}
          onSortChange={(next) => {
            setSort(next)
            setPage({ q, offset: 0 })
          }}
          rowHref={collection.primaryKey ? (row) => paths.appData(app.group.path, app.slug, { table: collection.id, q: q || undefined, row: row.key }) : undefined}
          emptyState={
            q ? (
              <EmptyState icon={<Search />} title={dataText.noMatches(q)} action={<Button onClick={() => setDraft('')}>{dataText.clearSearch}</Button>} />
            ) : (
              <EmptyState icon={<Table2 />} title={dataText.noRows} action={offset === 0 ? addButton : undefined} />
            )
          }
          offset={offset}
          limit={DATA_PAGE_SIZE}
          hasNext={rows.data?.truncated ?? false}
          onPage={(next) => setPage({ q, offset: next })}
          fetchedAt={fetchedAt}
          refreshing={rows.isFetching}
          onRefresh={() => {
            void rows.refetch()
            catalogQuery.refetch()
          }}
        />
      )}

      {collection.primaryKey ? (
        <RecordSheet
          key={`sheet:${collection.id}`}
          projectId={projectId}
          databaseId={databaseId}
          collection={collection}
          row={creating ? null : openRow ?? null}
          open={creating || openRow !== undefined}
          onOpenChange={(open) => {
            if (open) return
            if (creating) setCreating(false)
            else go({ table: collection.id, ...(q ? { q } : {}) }, true)
          }}
          canEdit={canEdit}
        />
      ) : null}
    </section>
  )
}

/** 403 / 412 reasons in words; anything else is a load failure with retry. */
function Blocked({ error, app, view, isAdmin, onRetry }: { error: unknown; app: BusinessApp; view: AppView; isAdmin: boolean; onRetry: () => void }) {
  if (isDataForbidden(error)) {
    return (
      <Notice tone="warning" title={dataText.forbiddenTitle} actions={
        <div className="flex flex-wrap gap-2">
          <OwnerContact app={app} />
          {isAdmin ? <LinkButton href={paths.adminPlatform}>{text.logs.platform}</LinkButton> : null}
          <LinkButton href={paths.help}>{text.logs.help}</LinkButton>
        </div>
      }>
        <span className="inline-flex items-center gap-2"><Lock aria-hidden className="size-4 shrink-0" />{dataText.forbiddenBody}</span>
      </Notice>
    )
  }
  const reason = dataPreconditionReason(error)
  const notice = (title: string, actions?: ReactNode) => <Notice title={title} actions={actions} />
  if (reason === 'database_suspended' || reason === 'database_waking') {
    return notice(dataText.suspended, view.url ? <LinkButton external href={view.url}>{copy.app.logs.open}</LinkButton> : undefined)
  }
  if (reason === 'database_data_unsupported') return notice(dataText.unsupported)
  if (reason === 'table_read_only') return notice(dataText.readOnly)
  if (reason === 'database_access_membership_unbound') return <MembershipUnboundNotice error={error} />
  return <LoadFailed error={error} onRetry={onRetry} />
}
