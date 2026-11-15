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
  destinationUnavailable: 'repository destination unavailable',
  /** Where a new repository goes (Platform's resolved repository destination); never its reason or message. */
  destination: {
    blocked: '新しい置き場の作成先が決まっていないため、AI やテンプレートからは作れません。プロジェクトの管理者に設定を依頼してください。',
    repository: '新しく作る置き場',
    image: 'アプリの保管場所',
    imageChecking: '確認しています…',
    imageUnknown: '確認できませんでした',
    changedTitle: '置き場の作成先が変わりました',
    changed: 'まだ何も作っていません。上の「新しく作る置き場」と「アプリの保管場所」を新しい作成先にしました。確かめてから「作る」を押してください。',
    mismatchTitle: '置き場の作成先を確かめられませんでした',
    mismatch: 'まだ何も作っていません。最新の作成先を表示しました。確かめてから、もう一度作ってください。続くときは管理者に相談してください。',
    /** A repository already made (or adopted) by an earlier attempt: the next attempt uses it where it is. */
    created: '作成済みの置き場',
    createdNote: 'この置き場は前回の操作で作成済みです。続きは、この置き場とアプリの保管場所で作ります。',
    /** An earlier create whose outcome is unknown: the next attempt resends it exactly, to where it went. */
    pending: '前回作ろうとした置き場',
    pendingNote: '前回の作成の結果がまだ分かりません。二重に作らないよう、続きは前回と同じ内容をもう一度送って確かめます。ほかの作成先や名前では作りません。',
    retainedChecking: '作成済みの置き場を確認しています…',
    retainedUnknown: '前回作成した置き場がどこにあるかを表示できないため、続きから作れません。「最初から作り直す」を選ぶと、その置き場は使わずに、いまの作成先へ新しく作ります。',
    startOver: '最初から作り直す',
  },
  /**
   * The resend of an earlier, uncertain create was refused, or it cannot be resent exactly. The refusal does not prove
   * the earlier create failed, so nothing more is sent: a readback that finds what it made lets the user go on, and
   * only after a readback that did not find it may the user explicitly give the earlier create up (`where` = where it went).
   */
  unsettled: {
    title: '前回の作成が受け付けられたかを確かめられません',
    body: (where: string) => `前回 ${where} を作ろうとした操作の結果を確かめられません。作られている、または後から作られる可能性があるため、二重に作らないよう、ここからは何も送りません。「最新の状態を確認する」で見つかれば、その置き場で続きを作れます。`,
    previous: '前回の作成先',
    repository: (repository: string, image?: string) => image ? `「${repository}」（アプリの保管場所 ${image}）` : `「${repository}」`,
    app: (name: string) => `アプリ「${name}」`,
    notFound: (where: string) => `${where} はまだ見つかりません。少し待ってから、もう一度確認できます。前回の操作をあきらめて作り直すこともできますが、前回の操作によって後から ${where} が作られることがあり、そのときは二つになります。`,
    startOver: '前回の操作をあきらめて作り直す',
  },
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
