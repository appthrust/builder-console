// 「自分の作業場所」 wording (devworkspace builder-console.md §1–§4). 敬体;
// headings ≤ 20 字, explanations ≤ 40 字. 作業場所 = DevWorkspace, 置き場 = repository,
// 休止 = Sleeping (compute stops when the lease runs out; the data stays).
import { localized } from '../../shell/language'
import { workspacesEn } from './copy.en'

export const workspacesJa = {
  title: '自分の作業場所',
  entry: (running: number) => (running > 0 ? `自分の作業場所（動いているもの ${running} 件）` : '自分の作業場所'),
  description: 'AI と作るときに使う、あなた専用の作業場所です。',
  groups: {
    running: '動いている',
    sleeping: '休止中',
    other: '停止・使用終了・失敗',
  },
  groupCount: (n: number) => `${n} 件`,
  state: {
    Ready: '稼働中',
    Starting: '起動中',
    Degraded: '一部不調',
    Committing: '保存中',
    Sleeping: '休止中',
    Stopped: '停止',
    Retired: '使用終了',
    Failed: '失敗',
    Deleting: '削除中',
    unknown: '不明',
  },
  target: {
    draft: '新しいアプリ',
    application: (app: string) => `アプリ ${app}`,
    branch: (app: string, branch: string) => `アプリ ${app} / ${branch}`,
    unknown: '対象不明',
  },
  line: {
    lease: (minutes: number) => `あと ${minutes} 分で休止します`,
    leaseExpired: 'まもなく休止します',
    dataUntil: (date: string) => `データは ${date} まで残ります`,
    dataKept: 'データは削除するまで残ります',
    dataReleasing: 'データを解放しています',
    dataReleased: 'データは解放されました',
    stopped: '停止した作業場所のデータは、削除するまで残ります',
    retired: (date: string) => `もう使えません。${date} に自動で削除されます。`,
    retiredUndated: 'もう使えません。自動で削除されます。',
    unknown: 'この状態はまだ表示できません',
  },
  summary: {
    kept: (n: number) => `データを残している作業場所 ${n} 件`,
    idle: (n: number, idleAfter: string) => `${idleAfter}以上使っていないもの ${n} 件`,
    separator: ' · ',
  },
  duration: {
    days: (n: number) => `${n} 日`,
    hours: (n: number) => `${n} 時間`,
  },
  cleanup: '片づける',
  cleanupSelected: (n: number) => `使っていない ${n} 件を選びました。内容を確かめて削除してください。`,
  select: (name: string) => `「${name}」を選ぶ`,
  selection: (n: number) => `${n} 件を選択中`,
  clearSelection: '選択を外す',
  deleteSelected: (n: number) => `選んだ ${n} 件を削除`,
  action: {
    open: '開く',
    resume: '再開する',
    restart: '再開する',
    extend: '延長する',
    stop: '停止する',
    delete: '削除する',
  },
  actionLabel: (name: string, action: string) => `「${name}」を${action}`,
  extended: (name: string) => `「${name}」の休止までの時間を延ばしました。`,
  stopped: (name: string) => `「${name}」を停止しました。`,
  restarted: (name: string) => `「${name}」を再開しています。`,
  stop: {
    title: (name: string) => `「${name}」を停止しますか？`,
    body: '停止した作業場所のデータは、削除するまで残ります。',
    confirm: '停止する',
  },
  remove: {
    title: (n: number) => (n === 1 ? '作業場所を削除しますか？' : `作業場所 ${n} 件を削除しますか？`),
    warning: '置き場に送っていない変更は消えます。',
    body: '作業場所とそのデータを削除します。置き場に送った変更と提案は残ります。',
    rows: '削除する作業場所',
    unpublished: '置き場に未送信',
    retired: '使用終了・もう使えません',
    unpublishedNote: (n: number) => `${n} 件は置き場に送っていません。変更はこの作業場所にしかありません。`,
    confirm: (n: number) => (n === 1 ? '削除する' : `${n} 件を削除する`),
    deleting: '削除しています',
    deleted: '削除を受け付けました',
    retryFailed: '失敗したものをもう一度',
  },
  empty: {
    title: '作業場所はまだありません',
    body: 'AI と作り始めると、ここに出ます。',
  },
  leaseHint: {
    remaining: (minutes: number) => `あと ${minutes} 分で休止`,
    expired: 'まもなく休止',
    /** The button's name starts with what it shows, then says what pressing it does. */
    extendLabel: (shown: string) => `${shown}（押すと休止までの時間を延ばします）`,
    extended: '休止までの時間を延ばしました',
    failed: '延ばせませんでした',
  },
}

export const workspacesText = localized({ ja: workspacesJa, en: workspacesEn })
