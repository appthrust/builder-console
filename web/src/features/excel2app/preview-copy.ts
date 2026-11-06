// Chrome of the planned app rendered by `ui-preview.tsx`. Field names, values
// and screen titles come from the workbook and the UI design and are shown as written.
import { localized } from '../../shell/language'
import { previewTextEn } from './preview-copy.en'

export const previewTextJa = {
  frame: (appName: string) => `「${appName}」のプレビュー`,
  address: (appName: string) => `https://${appName}.…`,
  nav: '画面',
  noScreens: '表示する画面がありません。アシスタントに画面を戻すよう伝えてください。',
  noRows: 'この Excel にはまだ行がありません。',
  search: 'キーワードで検索',
  filterAll: (field: string) => `${field}: すべて`,
  filterValue: (field: string, value: string) => `${field}: ${value}`,
  shown: (shown: number, total: number) => (shown < total ? `全 ${total} 件中 ${shown} 件を表示` : `全 ${total} 件`),
  noMatch: '条件に合う行がありません。',
  groupCount: (count: number) => `${count} 件`,
  create: '新規登録',
  open: (title: string) => `「${title}」を開く`,
  save: '保存',
  cancel: 'キャンセル',
  edit: '編集',
  required: '必須',
  choose: '選択してください',
  personPlaceholder: '名前で探す',
  example: (value: string) => `例: ${value}`,
  attach: (field: string) => `${field}を追加`,
  attachHint: 'ドラッグで追加、またはクリックして選ぶ',
  computed: '保存すると自動で計算',
  autoNumber: '保存すると自動で採番',
  yes: 'あり',
  empty: '—',
  progress: '進み具合',
  moreCards: (count: number) => `ほか ${count} 件`,
  emptyColumn: 'なし',
  doneOf: (done: number, total: number) => `完了 ${done} / ${total} 件`,
  asOf: (date: string) => `${date} 時点`,
  countUnit: '件',
  sumOf: (count: number) => `${count} 件の合計`,
  overdueNone: '期限切れはありません',
  overdueSince: (days: number) => `${days} 日超過`,
  noCards: 'ダッシュボードに表示するカードがありません。',
  /** The frame before the first design arrives: the AI is deriving it from the specification. */
  preparing: 'AI が仕様書から画面を用意しています…',
  /** The frame when the first design could not be made; the chat offers もう一度. */
  notReady: '画面はまだ用意できていません。',
}

export const previewText = localized({ ja: previewTextJa, en: previewTextEn })
