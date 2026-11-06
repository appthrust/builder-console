import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Collection } from '../../../model/data-catalog'
import { mapSaveError, parseFormValues } from '../../../model/data-record'
import { preserveLanguage } from '../../../../test/language'
import { setLanguage } from '../../../shell/language'
import { dataText } from './copy'
import { writeText } from './copy-write'

let restoreLanguage: () => void
beforeEach(() => {
  restoreLanguage = preserveLanguage()
  setLanguage('ja')
})
afterEach(() => restoreLanguage())

const products: Collection = {
  id: 'public.products',
  schema: 'public',
  name: 'products',
  label: 'Products',
  kind: 'table',
  editable: true,
  hidden: false,
  primaryKey: 'id',
  displayField: 'name',
  fields: [
    { name: 'name', label: 'Name', kind: 'text', required: true, readOnly: false, hasDefault: false, nullable: false },
    { name: 'stock', label: 'Stock', kind: 'integer', required: false, readOnly: false, hasDefault: false, nullable: true },
  ],
}

describe('data language catalogs', () => {
  test('browsing labels and counts switch in both directions without changing Japanese', () => {
    expect(dataText.navLabel).toBe('表')
    expect(dataText.collectionLabel('商品', dataText.rowEstimate(1200))).toBe('商品（約 1,200 行）')
    expect(dataText.pageRange(1001, 1050)).toBe('1,001〜1,050 行目')
    expect(dataText.noMatches('PC')).toBe('「PC」に合う行はありません')

    setLanguage('en')
    expect(dataText.navLabel).toBe('Table')
    expect(dataText.searchPlaceholder).toBe('Search this table')
    expect(dataText.rowEstimate(0)).toBe('About 0 rows')
    expect(dataText.rowEstimate(1)).toBe('About 1 row')
    expect(dataText.rowEstimate(2)).toBe('About 2 rows')
    expect(dataText.collectionLabel('Products', dataText.rowEstimate(1200))).toBe('Products (About 1,200 rows)')
    expect(dataText.pageRange(1001, 1050)).toBe('Rows 1,001–1,050')
    expect(dataText.noMatches('PC')).toBe('No rows match “PC”')
    expect(dataText.fetchedAt('2 minutes ago')).toBe('Last loaded 2 minutes ago')

    setLanguage('ja')
    expect(dataText.navLabel).toBe('表')
    expect(dataText.collectionLabel('商品', dataText.rowEstimate(1200))).toBe('商品（約 1,200 行）')
  })

  test('the membership notice names both reasons in both languages, matching the Dashboard members list', () => {
    expect(dataText.membershipUnbound.SubjectUnbound).toStartWith('まだサインインしていません。')
    expect(dataText.teamSettings).toBe('チームの設定を開く')

    setLanguage('en')
    expect(dataText.membershipUnbound).toEqual({
      SubjectUnbound: 'Not signed in yet — database and runtime access is granted after the first sign-in with this email.',
      NotPersisted: 'Role comes from platform admin or a group. Add this user as a team member to grant database and runtime access.',
    })
    expect(dataText.teamSettings).toBe('Open team settings')
  })

  test('sheet actions, reference notes and deletion wording switch together', () => {
    expect(writeText.sheet.menu).toBe('この行の操作')
    expect(writeText.sheet.referenceNote(writeText.field.referenceHint('取引先'))).toBe('（取引先 の行）')
    expect(writeText.deleteDialog.title('ノートPC')).toBe('「ノートPC」の行を削除しますか？')

    setLanguage('en')
    expect(writeText.sheet.menu).toBe('Row actions')
    expect(writeText.sheet.createTitle('Products')).toBe('Add row to Products')
    expect(writeText.sheet.saving).toBe('Saving…')
    expect(writeText.field.yes).toBe('Yes')
    expect(writeText.field.no).toBe('No')
    expect(writeText.field.none).toBe('(None)')
    expect(writeText.field.jsonHint).toBe('Use { } or [ ] to write this value')
    expect(writeText.sheet.referenceNote(writeText.field.referenceHint('Suppliers'))).toBe('(Row in Suppliers)')
    expect(writeText.deleteDialog.title('Laptop')).toBe('Delete the row “Laptop”?')
    expect(writeText.sheet.discardTitle).toBe('Close without saving?')

    setLanguage('ja')
    expect(writeText.sheet.menu).toBe('この行の操作')
    expect(writeText.sheet.referenceNote(writeText.field.referenceHint('取引先'))).toBe('（取引先 の行）')
  })

  test('conflict reload lists use the selected language punctuation', () => {
    expect(writeText.errors.reloaded(['単価', 'メモ'].join(writeText.errors.fieldSeparator)))
      .toBe('ほかの人が変えた内容を読み込みました（単価、メモ）。確認してから保存してください。')

    setLanguage('en')
    expect(writeText.errors.reloaded(['Price', 'Note'].join(writeText.errors.fieldSeparator)))
      .toBe('Loaded changes from someone else (Price, Note); review them before saving.')
  })

  test('form validation resolves the current language outside React', () => {
    const form = { name: '', stock: '1.5' }
    expect(parseFormValues(products, form, 'create').errors).toEqual({
      name: 'Name は必須です',
      stock: 'Stock は整数で入力してください',
    })

    setLanguage('en')
    expect(parseFormValues(products, form, 'create').errors).toEqual({
      name: 'Name is required',
      stock: 'Enter a whole number for Stock',
    })

    setLanguage('ja')
    expect(parseFormValues(products, form, 'create').errors.name).toBe('Name は必須です')
  })

  test('save errors resolve the current language without changing error kinds', () => {
    const conflict = { status: 409, details: { reason: 'row_changed' } }
    expect(mapSaveError(conflict, products)).toEqual({
      kind: 'conflict',
      fieldErrors: {},
      message: 'ほかの人が先に変更しました。最新の内容を確認してから保存してください。',
    })

    setLanguage('en')
    expect(mapSaveError(conflict, products)).toEqual({
      kind: 'conflict',
      fieldErrors: {},
      message: 'Someone else changed this row; review the latest version before saving.',
    })
    expect(mapSaveError({ status: 409, details: { reason: 'constraint_violation', sqlstate: '23505', column: 'name' } }, products)).toEqual({
      kind: 'constraint',
      fieldErrors: { name: 'A row with the same Name already exists' },
      message: 'A row with the same Name already exists',
    })
    expect(mapSaveError(undefined, products, 'delete').message).toBe('Could not delete; please try again later.')

    setLanguage('ja')
    expect(mapSaveError(conflict, products).message).toBe('ほかの人が先に変更しました。最新の内容を確認してから保存してください。')
  })
})
