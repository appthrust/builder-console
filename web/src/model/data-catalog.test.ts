import { describe, expect, test } from 'bun:test'
import type { DatabaseTableColumn, DatabaseTableSchema } from '@appthrust/api-schema/platform-api'
import { deriveCatalog, deriveCollection, displayValue, formatValue, rowKey, toDataRow, type Collection, type Field } from './data-catalog'

const column = (name: string, type: string, init: Partial<DatabaseTableColumn> = {}): DatabaseTableColumn => ({
  name, type, nullable: true, hasDefault: false, primaryKey: false, ...init,
})

const products: DatabaseTableSchema = {
  schema: 'public',
  name: 'products',
  type: 'table',
  description: '商品',
  primaryKey: ['id'],
  columns: [
    column('id', 'integer', { nullable: false, hasDefault: true, primaryKey: true }),
    column('name', 'text', { nullable: false, description: '商品名' }),
    column('unit_price', 'numeric(10,2)', { nullable: false, hasDefault: true }),
    column('stock', 'integer', { description: '在庫' }),
    column('active', 'boolean', { description: '取扱中' }),
    column('category', 'public.item_category', { description: '分類', enumValues: ['PC', '周辺機器'] }),
    column('supplier_id', 'integer', { description: '取引先', references: { schema: 'public', table: 'suppliers', column: 'id' } }),
    column('note', 'text', { description: '@long メモ' }),
    column('internal_code', 'text', { description: '@hidden 社内コード' }),
    column('created_at', 'timestamp with time zone', { nullable: false, hasDefault: true }),
    column('updated_at', 'timestamp with time zone', { nullable: false, hasDefault: true }),
  ],
  editable: true,
  rowCountEstimate: 42,
  fetchedAt: '2026-10-09T00:00:00Z',
}

const field = (collection: Collection, name: string): Field => {
  const found = collection.fields.find((item) => item.name === name)
  if (!found) throw new Error(`no field ${name}`)
  return found
}

describe('deriveCollection labels', () => {
  test('table and column comments are the labels; the first comment line is the label, the rest the description', () => {
    const collection = deriveCollection({ ...products, description: '商品\n販売している備品の一覧' })
    expect(collection).toMatchObject({ id: 'public.products', label: '商品', description: '販売している備品の一覧', rowCountEstimate: 42 })
    expect(field(collection, 'name').label).toBe('商品名')
    expect(field(collection, 'note').label).toBe('メモ')
  })

  test('without a comment: humanised snake_case, and a bare id is 番号', () => {
    const collection = deriveCollection({ ...products, name: 'stock_movements', description: undefined })
    expect(collection.label).toBe('Stock movements')
    expect(collection.description).toBeUndefined()
    expect(field(collection, 'unit_price').label).toBe('Unit price')
    expect(field(collection, 'created_at').label).toBe('Created at')
    expect(field(collection, 'id').label).toBe('番号')
  })

  test('a comment with only tags falls back to the humanised name', () => {
    const collection = deriveCollection({ ...products, columns: [column('memo_text', 'text', { description: '@long' })] })
    expect(field(collection, 'memo_text')).toMatchObject({ label: 'Memo text', kind: 'longtext' })
  })
})

describe('deriveCollection hidden rules', () => {
  test('_-prefixed tables and @hidden table comments are hidden; ordinary tables are not', () => {
    expect(deriveCollection(products).hidden).toBe(false)
    expect(deriveCollection({ ...products, name: '_audit_log', description: undefined })).toMatchObject({ hidden: true, label: 'Audit log' })
    expect(deriveCollection({ ...products, name: 'sessions', description: '@hidden ログイン情報' })).toMatchObject({ hidden: true, label: 'ログイン情報' })
  })

  test.each(['pg_stat_statements', 'pg_stat_statements_info'])('%s is hidden without an @hidden comment', (name) => {
    expect(deriveCollection({ ...products, name, type: 'view', primaryKey: [], editable: false, description: undefined }).hidden).toBe(true)
  })

  test('pgroup_members stays visible because its name does not start with pg_', () => {
    expect(deriveCollection({ ...products, name: 'pgroup_members', description: undefined }).hidden).toBe(false)
  })

  test('@hidden columns leave the fields entirely', () => {
    const names = deriveCollection(products).fields.map((item) => item.name)
    expect(names).not.toContain('internal_code')
    expect(names).toHaveLength(products.columns.length - 1)
  })

  test('deriveCatalog keeps hidden collections (flagged) in the list order and leaves out undescribed tables', () => {
    const audit = { ...products, name: '_audit_log', description: undefined }
    const catalog = deriveCatalog(
      [
        { schema: 'public', name: '_audit_log', type: 'table_or_view' },
        { schema: 'public', name: 'products', type: 'table_or_view' },
        { schema: 'public', name: 'not_described', type: 'table_or_view' },
      ],
      [products, audit],
    )
    expect(catalog.collections.map((item) => [item.id, item.hidden])).toEqual([['public._audit_log', true], ['public.products', false]])
  })
})

describe('deriveCollection editable rules', () => {
  test('a table with exactly one key column is editable', () => {
    expect(deriveCollection(products)).toMatchObject({ kind: 'table', editable: true, primaryKey: 'id' })
  })

  test('a view is read-only, even when the server says editable', () => {
    const view = deriveCollection({ ...products, type: 'view', primaryKey: [] })
    expect(view).toMatchObject({ kind: 'view', editable: false })
    expect(view.primaryKey).toBeUndefined()
    expect(deriveCollection({ ...products, type: 'VIEW' })).toMatchObject({ kind: 'view', editable: false })
  })

  test('no key or a composite key is read-only, even when the server says editable', () => {
    for (const primaryKey of [[], ['id', 'name']]) {
      const collection = deriveCollection({ ...products, primaryKey })
      expect(collection.editable).toBe(false)
      expect(collection.primaryKey).toBeUndefined()
    }
  })

  test('the server saying not editable wins', () => {
    expect(deriveCollection({ ...products, editable: false }).editable).toBe(false)
  })
})

describe('deriveCollection readOnly and required rules', () => {
  const collection = deriveCollection(products)

  test('a key with a default and created_at/updated_at with a default are filled by the database', () => {
    expect(field(collection, 'id')).toMatchObject({ readOnly: true, required: false, hasDefault: true })
    expect(field(collection, 'created_at').readOnly).toBe(true)
    expect(field(collection, 'updated_at').readOnly).toBe(true)
  })

  test('a non-key column with a default stays editable; a key or timestamp without a default is editable', () => {
    expect(field(collection, 'unit_price')).toMatchObject({ readOnly: false, required: false })
    const manual = deriveCollection({
      ...products,
      columns: [
        column('code', 'text', { nullable: false, primaryKey: true }),
        column('updated_at', 'timestamp without time zone'),
      ],
      primaryKey: ['code'],
    })
    expect(field(manual, 'code')).toMatchObject({ readOnly: false, required: true })
    expect(field(manual, 'updated_at')).toMatchObject({ readOnly: false, required: false })
  })

  test('required is NOT NULL without a default', () => {
    expect(field(collection, 'name').required).toBe(true)
    expect(field(collection, 'stock').required).toBe(false)
  })
})

describe('deriveCollection kind mapping', () => {
  test.each([
    ['text', 'text'],
    ['character varying(40)', 'text'],
    ['citext', 'text'],
    ['smallint', 'integer'],
    ['bigint', 'integer'],
    ['numeric', 'number'],
    ['double precision', 'number'],
    ['real', 'number'],
    ['boolean', 'boolean'],
    ['date', 'date'],
    ['timestamp without time zone', 'timestamp'],
    ['timestamp(3) with time zone', 'timestamp'],
    ['jsonb', 'json'],
    ['json', 'json'],
    ['text[]', 'json'],
    ['uuid', 'uuid'],
    ['tsvector', 'text'],
  ] as const)('%s → %s', (type, kind) => {
    expect(field(deriveCollection({ ...products, columns: [column('value', type)] }), 'value').kind).toBe(kind)
  })

  test('@long text is longtext; enum and reference carry their details', () => {
    const collection = deriveCollection(products)
    expect(field(collection, 'note').kind).toBe('longtext')
    expect(field(collection, 'category')).toMatchObject({ kind: 'enum', enumValues: ['PC', '周辺機器'] })
    expect(field(collection, 'supplier_id')).toMatchObject({ kind: 'reference', reference: { schema: 'public', table: 'suppliers', column: 'id' } })
    expect(field(collection, 'stock').enumValues).toBeUndefined()
  })

  test('a user-defined type without enum values is not an enum', () => {
    expect(field(deriveCollection({ ...products, columns: [column('value', 'public.item_category', { enumValues: [] })] }), 'value').kind).toBe('text')
  })
})

describe('deriveCollection displayField', () => {
  test('first visible text column that is not the key', () => {
    expect(deriveCollection(products).displayField).toBe('name')
  })

  test('a hidden text column is skipped; longtext counts as text', () => {
    const collection = deriveCollection({
      ...products,
      columns: [
        column('id', 'integer', { primaryKey: true }),
        column('secret', 'text', { description: '@hidden' }),
        column('qty', 'integer'),
        column('memo', 'text', { description: '@long 備考' }),
      ],
    })
    expect(collection.displayField).toBe('memo')
  })

  test('a text key is not the display field; without other text the key is', () => {
    const collection = deriveCollection({
      ...products,
      primaryKey: ['code'],
      columns: [column('code', 'text', { primaryKey: true }), column('qty', 'integer')],
    })
    expect(collection.displayField).toBe('code')
  })

  test('no key and no text: the first visible column', () => {
    expect(deriveCollection({ ...products, primaryKey: [], columns: [column('qty', 'integer'), column('at', 'date')] }).displayField).toBe('qty')
  })
})

describe('row keys and display values', () => {
  const collection = deriveCollection(products)

  test('rowKey stringifies the single key; no key column or value → undefined', () => {
    expect(rowKey(collection, { id: 7 })).toBe('7')
    expect(rowKey(collection, { id: null })).toBeUndefined()
    expect(rowKey(deriveCollection({ ...products, primaryKey: [] }), { id: 7 })).toBeUndefined()
    expect(toDataRow(collection, { id: 7, name: 'ノートPC' })).toEqual({ key: '7', values: { id: 7, name: 'ノートPC' } })
    expect(toDataRow(collection, { name: 'ノートPC' })).toBeUndefined()
  })

  test('displayValue: the display column, else the key', () => {
    expect(displayValue(collection, { key: '1', values: { id: 1, name: 'ノートPC' } })).toBe('ノートPC')
    expect(displayValue(collection, { key: '1', values: { id: 1, name: null } })).toBe('1')
    expect(displayValue(collection, { key: '1', values: { id: 1, name: '' } })).toBe('1')
  })
})

describe('formatValue', () => {
  const collection = deriveCollection(products)
  const kind = (name: string) => field(collection, name)

  test('null and undefined are （なし） for every kind', () => {
    for (const item of collection.fields) {
      expect(formatValue(item, null)).toBe('（なし）')
      expect(formatValue(item, undefined)).toBe('（なし）')
    }
  })

  test('boolean is はい / いいえ', () => {
    expect(formatValue(kind('active'), true)).toBe('はい')
    expect(formatValue(kind('active'), false)).toBe('いいえ')
  })

  test('numbers are grouped; numeric strings too; zero stays 0', () => {
    expect(formatValue(kind('unit_price'), 120000)).toBe('120,000')
    expect(formatValue(kind('unit_price'), '35000.5')).toBe('35,000.5')
    expect(formatValue(kind('stock'), 0)).toBe('0')
    expect(formatValue(kind('stock'), -1200)).toBe('-1,200')
  })

  test('an integer beyond the safe range stays exactly as stored', () => {
    expect(formatValue(kind('stock'), '9007199254740993')).toBe('9007199254740993')
  })

  test('date is YYYY/MM/DD without a time-zone shift', () => {
    const date = deriveCollection({ ...products, columns: [column('moved_on', 'date')] }).fields[0]!
    expect(formatValue(date, '2026-10-08')).toBe('2026/10/08')
    expect(formatValue(date, '2026-01-01')).toBe('2026/01/01')
  })

  test('timestamp is MM/DD HH:mm in local time', () => {
    expect(formatValue(kind('updated_at'), '2026-10-08T14:02:00')).toBe('10/08 14:02')
    expect(formatValue(kind('updated_at'), '2026-01-05T09:07:59')).toBe('01/05 09:07')
    const at = new Date('2026-10-08T05:02:00Z')
    const local = `${String(at.getMonth() + 1).padStart(2, '0')}/${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    expect(formatValue(kind('updated_at'), '2026-10-08T05:02:00Z')).toBe(local)
  })

  test('json is {…}', () => {
    const json = deriveCollection({ ...products, columns: [column('meta', 'jsonb')] }).fields[0]!
    expect(formatValue(json, { a: 1 })).toBe('{…}')
    expect(formatValue(json, [1, 2])).toBe('{…}')
  })

  test('text is cut after 80 characters', () => {
    const exact = 'あ'.repeat(80)
    expect(formatValue(kind('note'), exact)).toBe(exact)
    expect(formatValue(kind('note'), `${exact}い`)).toBe(`${exact}…`)
    expect(formatValue(kind('name'), '😀'.repeat(81))).toBe(`${'😀'.repeat(80)}…`)
  })

  test('enum, reference and uuid show the stored value', () => {
    expect(formatValue(kind('category'), '周辺機器')).toBe('周辺機器')
    expect(formatValue(kind('supplier_id'), 3)).toBe('3')
  })
})
