// データ tab wording for the row sheet, its form, delete and save errors
// (design/platform/builder-console-app-data.md, States). Spreadsheet words
// only: 表 / 行 / 列; never SQL, PostgREST or status codes.
import { localized } from '../../../shell/language'
import { writeTextEn } from './copy-write.en'

// Japanese wording owns the shape shared by both language catalogs.
export const writeTextJa = {
  sheet: {
    title: (collection: string, row: string) => `${collection} › ${row}`,
    createTitle: (collection: string) => `${collection} に行を追加`,
    edit: '編集',
    save: '保存',
    saving: '保存しています…',
    cancel: 'キャンセル',
    menu: 'この行の操作',
    delete: 'この行を削除',
    saved: '保存しました。',
    created: '行を追加しました。',
    createdAt: '作成',
    updatedAt: '更新',
    readOnlyTable: 'この表は見るだけです',
    referenceNote: (hint: string) => `（${hint}）`,
    unsaved: 'この行に入力した内容は保存されていません。',
    discardTitle: '保存せずに閉じますか？',
    discardBody: '入力した内容は保存されていません。',
    discardConfirm: '保存せずに閉じる',
    discardCancel: '入力を続ける',
  },
  field: {
    auto: '自動で入ります',
    referenceHint: (collection: string) => `${collection} の行`,
    yes: 'はい',
    no: 'いいえ',
    none: '（なし）',
    choose: '選んでください',
    jsonHint: '{ } や [ ] の形で書きます',
    /** A column whose database type has no dedicated input here: the person types the value as text. */
    unlistedType: (type: string) => `専用の入力欄がない型です（${type}）。入力した値をそのまま保存します。`,
  },
  validation: {
    required: (label: string) => `${label} は必須です`,
    integer: (label: string) => `${label} は整数で入力してください`,
    number: (label: string) => `${label} は数値で入力してください`,
    date: (label: string) => `${label} は日付（例: 2026-10-09）で入力してください`,
    timestamp: (label: string) => `${label} は日時で入力してください`,
    enum: (label: string) => `${label} は一覧から選んでください`,
    json: (label: string) => `${label} の書き方が正しくありません`,
    boolean: (label: string) => `${label} は「はい」か「いいえ」を選んでください`,
    uuid: (label: string) => `${label} の形式が正しくありません`,
    fixBelow: '入力内容を確認してください。',
  },
  errors: {
    conflict: 'ほかの人が先に変更しました。最新の内容を確認してから保存してください。',
    reload: '最新の内容を読み込む',
    fieldSeparator: '、',
    reloaded: (labels: string) => `ほかの人が変えた内容を読み込みました（${labels}）。確認してから保存してください。`,
    reloadedSame: '最新の内容を読み込みました。確認してから保存してください。',
    unique: (label: string) => `同じ ${label} がすでにあります`,
    uniqueAny: '同じ内容の行がすでにあります',
    notNull: (label: string) => `${label} は必須です`,
    reference: (label: string) => `${label} に存在しない値です`,
    referenceAny: 'ほかの表に存在しない値が入っています',
    inUse: 'この行はほかの表から使われているため削除できません',
    check: (label: string) => `${label} の値が条件を満たしていません`,
    checkAny: '入力した値が条件を満たしていません',
    invalidValue: (label: string) => `${label} の値が正しくありません`,
    invalidAny: '入力した値が正しくありません',
    forbidden: 'データを編集する権限がまだありません',
    readOnly: 'この表は見るだけです',
    notFound: 'この行はもうありません。ほかの人が削除した可能性があります。',
    editingUnavailable: '行の編集はまだ有効になっていません。基盤の担当者に「データの編集」を依頼してください。',
    stopped: 'データベースは停止中です。アプリを開くと起動し、データが見られます。',
    unsupported: 'この種類のデータベースはまだ対応していません',
    other: '保存できませんでした。時間をおいてもう一度お試しください。',
    deleteOther: '削除できませんでした。時間をおいてもう一度お試しください。',
  },
  deleteDialog: {
    // Together: 「「ノートPC」の行を削除しますか？ この操作はアプリにすぐ反映されます」 (design, States).
    title: (row: string) => `「${row}」の行を削除しますか？`,
    body: 'この操作はアプリにすぐ反映されます',
    confirm: '削除する',
  },
}

export const writeText = localized({ ja: writeTextJa, en: writeTextEn })
