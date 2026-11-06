// Dev-only fixture for the データ tab: the app database of a 備品在庫 (equipment
// stock) app, as the Platform API describes it (PostgREST-shaped: comments as
// descriptions, `@hidden` / `@long` tags, an enum, foreign keys, timestamps,
// views including a PostgreSQL extension, a table without a key and a
// `_`-prefixed internal table). One catalog answers for every app database the
// mock knows (`<app>-db`).
//
// `state` is a const object: `resetDatabaseData()` replaces its fields in place,
// so importers (mock-platform.ts read and write routes) keep one reference.
import type { DatabaseTableColumn, DatabaseTableSchema } from '@appthrust/api-schema/platform-api'

export type DataMode = 'ok' | 'forbidden' | 'suspended' | 'unsupported' | 'empty' | 'subject-unbound' | 'not-persisted'

export interface MockDataTable {
  schema: DatabaseTableSchema
  rows: Record<string, unknown>[]
  /** Next value of a serial key (uuid keys use crypto.randomUUID()). */
  nextId: number
}

export interface MockDataFailure {
  status: number
  code: string
  message: string
  details: { reason: string; membershipReason?: string; teamId?: string }
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const col = (name: string, type: string, init: Partial<DatabaseTableColumn> = {}): DatabaseTableColumn => ({
  name, type, nullable: true, hasDefault: false, primaryKey: false, ...init,
})
const serialKey = () => col('id', 'integer', { nullable: false, hasDefault: true, primaryKey: true })
const createdAt = (description = '作成日時') => col('created_at', 'timestamp with time zone', { nullable: false, hasDefault: true, description })
const ref = (table: string) => ({ schema: 'public', table, column: 'id' })

function table(name: string, init: Omit<DatabaseTableSchema, 'schema' | 'name' | 'fetchedAt' | 'editable'>, rows: Record<string, unknown>[]): MockDataTable {
  const editable = init.type === 'table' && init.primaryKey.length === 1
  const serial = init.columns.find((column) => column.primaryKey && column.type === 'integer')
  const nextId = serial ? Math.max(0, ...rows.map((row) => Number(row[serial.name]) || 0)) + 1 : 1
  return { schema: { schema: 'public', name, editable, fetchedAt: new Date().toISOString(), ...init }, rows, nextId }
}

const CATEGORIES = ['PC', '周辺機器', '文具', '家具']

const suppliers = [
  { id: 1, name: '○○商事', phone: '03-1234-5678', email: 'order@maru-shoji.example' },
  { id: 2, name: '△△オフィス', phone: '06-2345-6789', email: 'sales@sankaku-office.example' },
  { id: 3, name: '□□電機', phone: '052-345-6789', email: null },
  { id: 4, name: 'ステーショナリー山田', phone: null, email: 'yamada@stationery.example' },
  { id: 5, name: '家具のミドリ', phone: '011-456-7890', email: 'info@midori-kagu.example' },
]

const staff = [
  { id: 1, name: '山田 太郎', department: '総務部', email: 'yamada@example.com' },
  { id: 2, name: '佐藤 花子', department: '総務部', email: 'sato@example.com' },
  { id: 3, name: '鈴木 一郎', department: '営業1課', email: 'suzuki@example.com' },
  { id: 4, name: '田中 美咲', department: '営業2課', email: 'tanaka@example.com' },
  { id: 5, name: '高橋 健', department: '情報システム部', email: 'takahashi@example.com' },
  { id: 6, name: '伊藤 さくら', department: '経理部', email: null },
]

function seedProducts() {
  const items: Array<[name: string, category: string, price: number, stock: number, active: boolean, supplier: number | null, note: string | null]> = [
    ['ノートPC', 'PC', 120000, 8, true, 3, '新入社員向けの標準機。メモリ 16GB、SSD 512GB。リース満了は 2028 年 3 月で、返却時は情報システム部に初期化を依頼すること。'],
    ['モニター', '周辺機器', 35000, 0, true, 3, null],
    ['キーボード', '周辺機器', 4800, 23, true, 2, null],
    ['マウス', '周辺機器', 2200, 41, true, 2, '無線タイプ'],
    ['USB-C ハブ', '周辺機器', 6500, 12, true, 3, null],
    ['ボールペン（黒）', '文具', 120, 480, true, 4, '10 本入りの箱単位で発注'],
    ['ノート A4', '文具', 180, 260, true, 4, null],
    ['ホワイトボードマーカー', '文具', 150, 75, true, 4, null],
    ['事務椅子', '家具', 28000, 3, true, 5, null],
    ['デスク', '家具', 45000, 2, true, 5, null],
    ['タブレット', 'PC', 68000, 4, false, null, '取扱終了。在庫がなくなり次第、一覧から外す'],
    ['プロジェクター', '周辺機器', 89000, 1, true, 1, null],
  ]
  return items.map(([name, category, unitPrice, stock, active, supplierId, note], index) => ({
    id: index + 1,
    name,
    category,
    unit_price: unitPrice,
    stock,
    active,
    supplier_id: supplierId,
    note,
    internal_code: `EQ-${String(index + 1).padStart(4, '0')}`,
    created_at: minutesAgo(60 * 24 * (40 - index)),
    updated_at: minutesAgo(60 * (index * 7 + 2)),
  }))
}

function seedMovements(productCount: number) {
  return Array.from({ length: 120 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    product_id: (index % productCount) + 1,
    direction: index % 3 === 0 ? '出庫' : '入庫',
    quantity: (index % 7) + 1,
    moved_on: new Date(Date.now() - Math.floor(index / 2) * 86_400_000).toISOString().slice(0, 10),
    staff_id: (index % staff.length) + 1,
    created_at: minutesAgo(60 * 12 * index + 5),
  }))
}

function seedTables(): Map<string, MockDataTable> {
  const products = seedProducts()
  const movements = seedMovements(products.length)
  const tables = [
    table('pg_stat_statements', {
      type: 'view',
      primaryKey: [],
      columns: [
        col('calls', 'bigint'),
        col('total_exec_time', 'double precision'),
        col('rows', 'bigint'),
      ],
    }, [
      { calls: 42, total_exec_time: 18.75, rows: 120 },
    ]),
    table('products', {
      type: 'table',
      description: '商品\n貸し出しや配布に使う備品です。',
      primaryKey: ['id'],
      columns: [
        serialKey(),
        col('name', 'text', { nullable: false, description: '商品名' }),
        col('category', 'public.item_category', { nullable: false, hasDefault: true, description: '分類', enumValues: CATEGORIES }),
        col('unit_price', 'numeric', { nullable: false, description: '単価' }),
        col('stock', 'integer', { nullable: false, hasDefault: true, description: '在庫' }),
        col('active', 'boolean', { nullable: false, hasDefault: true, description: '取扱中' }),
        col('supplier_id', 'integer', { description: '取引先', references: ref('suppliers') }),
        col('note', 'text', { description: '@long メモ' }),
        col('internal_code', 'text', { description: '@hidden 社内コード' }),
        createdAt(),
        col('updated_at', 'timestamp with time zone', { nullable: false, hasDefault: true, description: '更新日時' }),
      ],
    }, products),
    table('suppliers', {
      type: 'table',
      description: '取引先',
      primaryKey: ['id'],
      columns: [
        serialKey(),
        col('name', 'text', { nullable: false, description: '会社名' }),
        col('phone', 'character varying(20)', { description: '電話番号' }),
        col('email', 'text', { description: 'メール' }),
      ],
    }, suppliers.map((row) => ({ ...row }))),
    table('stock_movements', {
      type: 'table',
      description: '入出庫',
      primaryKey: ['id'],
      columns: [
        col('id', 'uuid', { nullable: false, hasDefault: true, primaryKey: true }),
        col('product_id', 'integer', { nullable: false, description: '商品', references: ref('products') }),
        col('direction', 'public.movement_direction', { nullable: false, description: '区分', enumValues: ['入庫', '出庫'] }),
        col('quantity', 'integer', { nullable: false, description: '数量' }),
        col('moved_on', 'date', { nullable: false, hasDefault: true, description: '日付' }),
        col('staff_id', 'integer', { description: '担当者', references: ref('staff') }),
        createdAt('記録日時'),
      ],
    }, movements),
    table('staff', {
      type: 'table',
      description: '担当者',
      primaryKey: ['id'],
      columns: [
        serialKey(),
        col('name', 'text', { nullable: false, description: '氏名' }),
        col('department', 'text', { description: '部署' }),
        col('email', 'text', { description: 'メール' }),
      ],
    }, staff.map((row) => ({ ...row }))),
    table('inventory_summary', {
      type: 'view',
      description: '在庫サマリー\n商品ごとの在庫と最後の入出庫日です。',
      primaryKey: [],
      columns: [
        col('product_name', 'text', { description: '商品名' }),
        col('stock', 'integer', { description: '在庫' }),
        col('last_moved_on', 'date', { description: '最後の入出庫' }),
      ],
    }, products.map((product) => ({
      product_name: product.name,
      stock: product.stock,
      last_moved_on: movements.find((movement) => movement.product_id === product.id)?.moved_on ?? null,
    }))),
    table('legacy_import', {
      type: 'table',
      description: '旧システムの取込データ',
      primaryKey: [],
      columns: [
        col('item_name', 'text', { description: '品名' }),
        col('quantity', 'integer', { description: '数量' }),
        col('imported_at', 'timestamp without time zone', { description: '取込日時' }),
      ],
    }, [
      { item_name: 'ノートPC（旧型）', quantity: 3, imported_at: '2026-04-01T09:00:00' },
      { item_name: 'FAX 用紙', quantity: 20, imported_at: '2026-04-01T09:00:00' },
      { item_name: '電卓', quantity: 7, imported_at: '2026-04-01T09:00:00' },
    ]),
    table('_audit_log', {
      type: 'table',
      primaryKey: ['id'],
      columns: [serialKey(), col('action', 'text'), col('payload', 'jsonb'), createdAt()],
    }, [
      { id: 1, action: 'products.update', payload: { id: 1, stock: 8 }, created_at: minutesAgo(30) },
      { id: 2, action: 'products.insert', payload: { id: 12 }, created_at: minutesAgo(90) },
    ]),
  ]
  return new Map(tables.map((item) => [`${item.schema.schema}.${item.schema.name}`, item]))
}

export const state: { mode: DataMode; tables: Map<string, MockDataTable> } = { mode: 'ok', tables: seedTables() }

/** Back to the seeded catalog and `mode: 'ok'` (`POST /api/v1/__mock/reset`). */
export function resetDatabaseData(): void {
  state.mode = 'ok'
  state.tables = seedTables()
}

export function findTable(schema: string, name: string): MockDataTable | undefined {
  return state.tables.get(`${schema}.${name}`)
}

/** Rows cannot be changed by key: a view, or not exactly one key column. */
export function isTableReadOnly(table: MockDataTable): boolean {
  return table.schema.type !== 'table' || table.schema.primaryKey.length !== 1
}

/** The Platform API's answer for the current `mode`, for every data route (read and write); undefined when served. */
export function dataModeFailure(): MockDataFailure | undefined {
  switch (state.mode) {
    case 'forbidden':
      return { status: 403, code: 'forbidden', message: 'caller may not read database data', details: { reason: 'forbidden' } }
    case 'suspended':
      return { status: 412, code: 'failed_precondition', message: 'database is suspended', details: { reason: 'database_suspended' } }
    case 'unsupported':
      return { status: 412, code: 'failed_precondition', message: 'database engine has no data broker', details: { reason: 'database_data_unsupported' } }
    // A 403 from the WLC for a caller whose Team membership has no immutable subject (never signed in) or no row at all.
    case 'subject-unbound':
    case 'not-persisted':
      return {
        status: 412,
        code: 'failed_precondition',
        message: 'team membership grants no database access',
        details: { reason: 'database_access_membership_unbound', membershipReason: state.mode === 'subject-unbound' ? 'SubjectUnbound' : 'NotPersisted', teamId: 'tm-mock' },
      }
    default:
      return undefined
  }
}

const TEXT_TYPE = /^(text|character varying|varchar|citext|character|char)\b/

/** Text-like columns (enums included) that `q` searches, like the Platform API's PostgREST `ilike` over text columns. */
function searchable(table: MockDataTable): string[] {
  return table.schema.columns.filter((column) => TEXT_TYPE.test(column.type) || column.enumValues?.length).map((column) => column.name)
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0
  // PostgreSQL puts NULL last ascending.
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return String(a).localeCompare(String(b), 'ja')
}

export interface RowsQuery {
  limit: number
  offset: number
  orderBy?: string
  direction: 'asc' | 'desc'
  q?: string
}

/** One page of `table` filtered by `q` and sorted by `orderBy`; `orderBy` must already be a known column. */
export function selectRows(table: MockDataTable, query: RowsQuery) {
  const term = query.q?.trim().toLowerCase()
  const columns = term ? searchable(table) : []
  const matched = term
    ? table.rows.filter((row) => columns.some((name) => typeof row[name] === 'string' && (row[name] as string).toLowerCase().includes(term)))
    : [...table.rows]
  if (query.orderBy) {
    const name = query.orderBy
    const sign = query.direction === 'desc' ? -1 : 1
    matched.sort((a, b) => {
      const order = compare(a[name], b[name])
      // NULL stays last in both directions (NULLS LAST).
      return a[name] === null || a[name] === undefined || b[name] === null || b[name] === undefined ? order : sign * order
    })
  }
  const page = matched.slice(query.offset, query.offset + query.limit)
  return {
    columns: table.schema.columns.map((column) => ({ name: column.name, type: column.type })),
    rows: page,
    rowCount: page.length,
    limit: query.limit,
    offset: query.offset,
    truncated: page.length >= query.limit,
    totalEstimate: matched.length,
    fetchedAt: new Date().toISOString(),
  }
}
