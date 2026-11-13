import { localized } from '../../shell/language'
import { textEn } from './copy.en'

// Wizard strings not in src/copy (product vocabulary only, ux-design §4).
export const textJa = {
  /** Console admins fix missing setup themselves (non-admins see copy.create.missing). */
  missingAdmin: (labels: string) => `${labels}がまだ用意されていません。「基盤の設定」で用意してください。`,
  domainPending: '公開用のドメインは準備中です。準備ができると、この画面で作成を始められます。',
  openPlatform: '基盤の設定を開く',
  sharePreview: 'この設定で見える人',
  creatingHint: '終わるとアプリの画面に移ります。このままお待ちください。',
  abandon: 'やめる',
  chooseTemplate: 'ひな形を選び直す',
  fix: '直す',
  fieldError: {
    template: 'ひな形を確認してください。',
    existing: 'GitHub の置き場を選び直してください。',
    destination: 'URL になる名前を確認してください。',
  },
  alreadyCreated: (name: string) => `this app was already created as "${name}"; finish it with that URL name`,
  sourceUnavailable: 'source connections unavailable',
  /** A create step answered 2xx with an answer this console cannot read: it may have happened (never resent blindly). */
  unconfirmed: {
    title: '作成の結果を確認できませんでした',
    body: '作成の操作は届いているかもしれません。同じものを二重に作らないよう、最新の状態を確かめてから続けてください。',
    confirm: '最新の状態を確認する',
    stillUnknown: 'まだ最新の状態を確認できません。少し待ってから、もう一度確認してください。',
  },
  loadingDraft: '作成途中のアプリを読み込んでいます…',
  pageTitle: (step: number) => `新しいアプリ (${step}/4)`,
  unsavedChanges: '入力した内容は保存されていません。この画面を離れますか？',
  buildFailed: '作り始められませんでした',
  retryBuild: 'もう一度試す',
  inputKept: '入力した内容は残っています。',
  customizeWithAi: 'AI でカスタマイズ',
  noBusinessTemplates: '業務用テンプレートはまだありません。AI と作るか、作ったコードから作れます。',
  fromImage: 'コンテナイメージから',
  prerequisiteSeparator: '・',
  tagSeparator: '、',
  templates: {
    'biz-inventory-postgres': {
      name: '在庫管理',
      lead: '品物の在庫と入出庫を、ひとつの画面で管理します。',
      includes: ['品物の一覧', '入出庫の記録', 'CSV の取り込み・書き出し'] satisfies [string, string, string],
      seed: '品物の在庫と入出庫を管理するアプリを作りたいです。品物の一覧、入出庫の記録、CSV の取り込み・書き出しが必要です。',
    },
    'biz-master-postgres': {
      name: 'マスター管理',
      lead: '取引先や品目など、業務の基本情報をまとめます。',
      includes: ['情報の登録・編集', '検索・絞り込み', 'CSV の取り込み・書き出し'] satisfies [string, string, string],
      seed: '取引先や品目などの基本情報を管理するアプリを作りたいです。登録・編集、検索・絞り込み、CSV の取り込み・書き出しが必要です。',
    },
    'biz-approval-postgres': {
      name: '申請・承認',
      lead: '申請から承認まで、いま誰の確認待ちかが分かります。',
      includes: ['申請の作成', '承認・差し戻し', '確認状況の一覧'] satisfies [string, string, string],
      seed: '社内の申請・承認アプリを作りたいです。申請の作成、承認・差し戻し、確認状況の一覧が必要です。',
    },
    'biz-reservation-postgres': {
      name: '予約・貸出',
      lead: '会議室や備品の空きを見つけて、予約・貸出できます。',
      includes: ['空き状況の確認', '予約の登録', '貸出・返却の記録'] satisfies [string, string, string],
      seed: '会議室や備品の予約・貸出アプリを作りたいです。空き状況の確認、予約、貸出・返却の記録が必要です。',
    },
  },
}

export const text = localized({ ja: textJa, en: textEn })
