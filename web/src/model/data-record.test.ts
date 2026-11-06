import { beforeAll, describe, expect, test } from 'bun:test'
import type { PlatformErrorEnvelope } from '../api/platform-error'
import type { Collection, DataRow, Field } from './data-catalog'
import {
  changedFields,
  diff,
  expectedFor,
  formatTimestampFull,
  mapSaveError,
  parseFormValues,
  rebaseForm,
  toFormValues,
  type SaveError,
} from './data-record'

// Timestamps are typed and shown in local time; pin it so the offsets are known.
beforeAll(() => {
  process.env.TZ = 'Asia/Tokyo'
})

const field = (name: string, label: string, kind: Field['kind'], init: Partial<Field> = {}): Field => ({
  name,
  label,
  kind,
  required: false,
  readOnly: false,
  hasDefault: false,
  nullable: true,
  ...init,
})

const products: Collection = {
  id: 'public.products',
  schema: 'public',
  name: 'products',
  label: '商品',
  kind: 'table',
  editable: true,
  hidden: false,
  primaryKey: 'id',
  displayField: 'name',
  fields: [
    field('id', '番号', 'integer', { readOnly: true, hasDefault: true, nullable: false }),
    field('name', '商品名', 'text', { required: true, nullable: false }),
    field('category', '分類', 'enum', { enumValues: ['PC', '周辺機器', '文具'] }),
    field('unit_price', '単価', 'number', { required: true, nullable: false }),
    field('stock', '在庫', 'integer', { nullable: false, hasDefault: true }),
    field('active', '取扱中', 'boolean', { required: true, nullable: false }),
    field('featured', 'おすすめ', 'boolean', { hasDefault: true, nullable: false }),
    field('supplier_id', '取引先', 'reference', { reference: { schema: 'public', table: 'suppliers', column: 'id' } }),
    field('note', 'メモ', 'longtext'),
    field('released_on', '発売日', 'date'),
    field('checked_at', '確認日時', 'timestamp'),
    field('attributes', '属性', 'json'),
    field('external_id', '外部ID', 'uuid'),
    field('created_at', '作成日時', 'timestamp', { readOnly: true, hasDefault: true, nullable: false }),
    field('updated_at', '更新日時', 'timestamp', { readOnly: true, hasDefault: true, nullable: false }),
  ],
}

const laptop: DataRow = {
  key: '1',
  values: {
    id: 1,
    name: 'ノートPC',
    category: 'PC',
    unit_price: 120000,
    stock: 8,
    active: true,
    featured: false,
    supplier_id: 3,
    note: null,
    released_on: '2026-09-30',
    checked_at: '2026-10-08T05:02:00+00:00',
    attributes: { color: 'gray', ports: ['usb-c'] },
    external_id: '0b6f2c1e-6a43-4c55-9d2e-6d0f3f1d9a10',
    created_at: '2026-09-30T00:00:00+00:00',
    updated_at: '2026-10-08T05:02:00.123456+00:00',
  },
}

/** A complete valid create form; tests override one input at a time. */
const createForm = (overrides: Record<string, string> = {}) => ({
  ...toFormValues(products, null),
  name: 'モニター',
  unit_price: '35000',
  active: 'true',
  ...overrides,
})

describe('toFormValues', () => {
  test('a row becomes input strings per kind', () => {
    const form = toFormValues(products, laptop)
    expect(form).toEqual({
      id: '1',
      name: 'ノートPC',
      category: 'PC',
      unit_price: '120000',
      stock: '8',
      active: 'true',
      featured: 'false',
      supplier_id: '3',
      note: '',
      released_on: '2026-09-30',
      checked_at: '2026-10-08T14:02',
      attributes: '{\n  "color": "gray",\n  "ports": [\n    "usb-c"\n  ]\n}',
      external_id: '0b6f2c1e-6a43-4c55-9d2e-6d0f3f1d9a10',
      created_at: '2026-09-30T09:00',
      updated_at: '2026-10-08T14:02',
    })
  })

  test('create starts empty; a NOT NULL boolean without default starts いいえ', () => {
    const form = toFormValues(products, null)
    expect(form.active).toBe('false')
    expect(form.featured).toBe('')
    expect(form.name).toBe('')
    expect(form.id).toBe('')
  })
})

describe('parseFormValues', () => {
  test('parses every kind and never emits read-only fields', () => {
    const { values, errors } = parseFormValues(products, createForm({
      category: '周辺機器',
      unit_price: '１２０,０００.５',
      stock: '12',
      featured: 'true',
      supplier_id: ' 3 ',
      note: '  改行\nあり ',
      released_on: '2026/10/1',
      checked_at: '2026-10-08T14:02',
      attributes: '{"a": [1, 2]}',
      external_id: '0B6F2C1E-6A43-4C55-9D2E-6D0F3F1D9A10',
      id: '99',
      created_at: '2026-01-01T00:00',
    }), 'create')
    expect(errors).toEqual({})
    expect(values).toEqual({
      name: 'モニター',
      category: '周辺機器',
      unit_price: 120000.5,
      stock: 12,
      active: true,
      featured: true,
      supplier_id: '3',
      note: '  改行\nあり ',
      released_on: '2026-10-01',
      checked_at: '2026-10-08T14:02:00+09:00',
      attributes: { a: [1, 2] },
      external_id: '0b6f2c1e-6a43-4c55-9d2e-6d0f3f1d9a10',
    })
    expect('id' in values || 'created_at' in values || 'updated_at' in values).toBe(false)
  })

  test.each([
    ['stock', '1.5', '在庫 は整数で入力してください'],
    ['stock', '十', '在庫 は整数で入力してください'],
    ['unit_price', '12円', '単価 は数値で入力してください'],
    ['released_on', '2026-02-30', '発売日 は日付（例: 2026-10-09）で入力してください'],
    ['released_on', 'きのう', '発売日 は日付（例: 2026-10-09）で入力してください'],
    ['checked_at', '2026-10-08 25:00', '確認日時 は日時で入力してください'],
    ['category', '家具', '分類 は一覧から選んでください'],
    ['attributes', '{a: 1}', '属性 の書き方が正しくありません'],
    ['external_id', 'abc', '外部ID の形式が正しくありません'],
    ['active', 'maybe', '取扱中 は「はい」か「いいえ」を選んでください'],
  ])('invalid %s %p → %s', (name, input, message) => {
    const { values, errors } = parseFormValues(products, createForm({ [name]: input }), 'create')
    expect(errors).toEqual({ [name]: message })
    expect(name in values).toBe(false)
  })

  test('integers beyond 2^53 travel as digits', () => {
    expect(parseFormValues(products, createForm({ stock: '+9007199254740993' }), 'create').values.stock).toBe('9007199254740993')
  })

  test('empty input: nullable → null, NOT NULL → 必須', () => {
    const { values, errors } = parseFormValues(products, { ...toFormValues(products, laptop), note: '', category: '', name: '  ', unit_price: '' }, 'update')
    expect(values.note).toBeNull()
    expect(values.category).toBeNull()
    expect(errors).toEqual({ name: '商品名 は必須です', unit_price: '単価 は必須です' })
  })

  test('empty input on create leaves defaulted columns to the database; on update NOT NULL stays required', () => {
    const created = parseFormValues(products, createForm({ stock: '', featured: '' }), 'create')
    expect(created.errors).toEqual({})
    expect('stock' in created.values || 'featured' in created.values).toBe(false)

    const updated = parseFormValues(products, { ...toFormValues(products, laptop), stock: '' }, 'update')
    expect(updated.errors).toEqual({ stock: '在庫 は必須です' })
  })
})

describe('diff', () => {
  test('only changed columns; unchanged values survive the form round trip', () => {
    const before = parseFormValues(products, toFormValues(products, laptop), 'update').values
    const after = parseFormValues(products, { ...toFormValues(products, laptop), stock: '7', attributes: '{"ports":["usb-c"],"color":"gray"}' }, 'update').values
    expect(diff(before, after)).toEqual({ stock: 7 })
  })

  test('compares against stored values: text keys equal numbers, null differs from empty text', () => {
    expect(diff({ supplier_id: 3, note: null }, { supplier_id: '3', note: null })).toEqual({})
    expect(diff({ supplier_id: 3, note: null }, { supplier_id: '4', note: '' })).toEqual({ supplier_id: '4', note: '' })
    expect(diff({ note: 'a' }, { note: null })).toEqual({ note: null })
  })
})

describe('expectedFor', () => {
  test('before-values of changed columns plus updated_at', () => {
    expect(expectedFor(products, laptop, { stock: 7, note: 'x' })).toEqual({
      stock: 8,
      note: null,
      updated_at: '2026-10-08T05:02:00.123456+00:00',
    })
  })

  test('without updated_at only the changed columns; JSON columns are never compared', () => {
    const row: DataRow = { key: '1', values: { id: 1, stock: 8, attributes: { a: 1 } } }
    expect(expectedFor(products, row, { stock: 7, attributes: { a: 2 } })).toEqual({ stock: 8 })
    expect(expectedFor(products, { key: '1', values: { stock: 8, updated_at: null } }, { stock: 7 })).toEqual({ stock: 8 })
  })
})

describe('conflict reload', () => {
  test('rebaseForm keeps the user’s edits over the latest row; changedFields names what others changed', () => {
    const latest: DataRow = { key: '1', values: { ...laptop.values, unit_price: 118000, note: '値下げ', updated_at: '2026-10-09T01:00:00+00:00' } }
    const form = { ...toFormValues(products, laptop), stock: '7', note: '' }
    const rebased = rebaseForm(products, laptop, latest, form)
    expect(rebased.stock).toBe('7')
    expect(rebased.unit_price).toBe('118000')
    expect(rebased.note).toBe('値下げ')
    expect(rebased.updated_at).toBe('2026-10-09T10:00')
    expect(changedFields(products, laptop, latest).map((item) => item.label)).toEqual(['単価', 'メモ', '更新日時'])
  })
})

test('formatTimestampFull shows YYYY/MM/DD HH:mm local time', () => {
  expect(formatTimestampFull('2026-10-08T05:02:00+00:00')).toBe('2026/10/08 14:02')
  expect(formatTimestampFull('not a date')).toBeUndefined()
})

describe('mapSaveError', () => {
  const constraint = (status: number, details: Record<string, unknown>): PlatformErrorEnvelope => ({
    status,
    code: status === 409 ? 'conflict' : 'invalid_argument',
    message: 'violates constraint',
    details: { reason: 'constraint_violation', ...details },
  })
  const onField = (name: string, message: string): SaveError => ({ kind: 'constraint', fieldErrors: { [name]: message }, message })
  const onForm = (kind: SaveError['kind'], message: string): SaveError => ({ kind, fieldErrors: {}, message })

  test.each<[string, PlatformErrorEnvelope | undefined, SaveError]>([
    ['23505 with column', constraint(409, { sqlstate: '23505', column: 'name' }), onField('name', '同じ 商品名 がすでにあります')],
    ['23505 by constraint name', constraint(409, { sqlstate: '23505', constraint: 'products_name_key' }), onField('name', '同じ 商品名 がすでにあります')],
    ['23505 unknown column', constraint(409, { sqlstate: '23505', constraint: 'products_pkey' }), onForm('constraint', '同じ内容の行がすでにあります')],
    ['23502 with column', constraint(400, { sqlstate: '23502', column: 'unit_price' }), onField('unit_price', '単価 は必須です')],
    ['23503 by constraint name', constraint(409, { sqlstate: '23503', constraint: 'products_supplier_id_fkey' }), onField('supplier_id', '取引先 に存在しない値です')],
    ['23503 unknown column', constraint(409, { sqlstate: '23503' }), onForm('constraint', 'ほかの表に存在しない値が入っています')],
    ['23514 with column', constraint(400, { sqlstate: '23514', column: 'stock', constraint: 'products_stock_check' }), onField('stock', '在庫 の値が条件を満たしていません')],
    ['23514 table check', constraint(400, { sqlstate: '23514', constraint: 'price_positive' }), onForm('constraint', '入力した値が条件を満たしていません')],
    ['22003 data error with column', constraint(400, { sqlstate: '22003', column: 'stock' }), onField('stock', '在庫 の値が正しくありません')],
    ['column outside the form', constraint(400, { sqlstate: '23502', column: 'internal_code' }), onForm('constraint', '入力した値が正しくありません')],
    ['row_changed', { status: 409, details: { reason: 'row_changed' } }, onForm('conflict', 'ほかの人が先に変更しました。最新の内容を確認してから保存してください。')],
    ['403', { status: 403, code: 'forbidden' }, onForm('forbidden', 'データを編集する権限がまだありません')],
    ['table_read_only', { status: 412, details: { reason: 'table_read_only' } }, onForm('readOnly', 'この表は見るだけです')],
    ['row_editing_unavailable', { status: 412, message: 'row editing is not enabled for this database yet', details: { reason: 'row_editing_unavailable' } }, onForm('editingUnavailable', '行の編集はまだ有効になっていません。基盤の担当者に「データの編集」を依頼してください。')],
    ['row_not_found', { status: 404, details: { reason: 'row_not_found' } }, onForm('other', 'この行はもうありません。ほかの人が削除した可能性があります。')],
    ['database_suspended', { status: 412, details: { reason: 'database_suspended' } }, onForm('other', 'データベースは停止中です。アプリを開くと起動し、データが見られます。')],
    ['database_waking', { status: 412, details: { reason: 'database_waking' } }, onForm('other', 'データベースは停止中です。アプリを開くと起動し、データが見られます。')],
    ['database_data_unsupported', { status: 412, details: { reason: 'database_data_unsupported' } }, onForm('other', 'この種類のデータベースはまだ対応していません')],
    ['500 without envelope details', { status: 500, message: 'boom' }, onForm('other', '保存できませんでした。時間をおいてもう一度お試しください。')],
    ['no envelope (network)', undefined, onForm('other', '保存できませんでした。時間をおいてもう一度お試しください。')],
  ])('%s', (_, envelope, expected) => {
    expect(mapSaveError(envelope, products)).toEqual(expected)
  })

  test('a delete blocked by a referencing row names the row as in use', () => {
    expect(mapSaveError(constraint(409, { sqlstate: '23503', constraint: 'stock_movements_product_id_fkey' }), products, 'delete'))
      .toEqual(onForm('constraint', 'この行はほかの表から使われているため削除できません'))
    expect(mapSaveError({ status: 500 }, products, 'delete')).toEqual(onForm('other', '削除できませんでした。時間をおいてもう一度お試しください。'))
  })
})
