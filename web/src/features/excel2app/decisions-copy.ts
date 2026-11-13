// The compact 「画面の決定」 summary (`ui-decisions.tsx`) shown outside Excel → app,
// e.g. in the build page's spec panel. Screen titles, entity and field names come
// from the UI design and are shown as written.
import { localized } from '../../shell/language'
import { decisionsTextEn } from './decisions-copy.en'

export const decisionsTextJa = {
  order: '画面の順番',
  orderSeparator: ' → ',
  hidden: '作らない画面',
  list: (entity: string) => `「${entity}」の一覧`,
  layouts: { table: '表', cards: 'カード表示' },
  columns: (columns: string[]) => `列: ${columns.join('、')}`,
  colorBy: (field: string) => `「${field}」で色分け`,
  groupBy: (field: string) => `「${field}」でグループ化`,
  form: (entity: string) => `「${entity}」の登録`,
  required: (fields: string[]) => `必須: ${fields.join('・')}`,
  dashboard: 'ダッシュボード',
  separator: '・',
  partSeparator: '／',
  /** Shown under the decisions when the design holds a part this console cannot read. */
  incomplete: 'ほかに、この画面では表示できない決定があります。',
}

export const decisionsText = localized({ ja: decisionsTextJa, en: decisionsTextEn })
