import { localized } from '../../../shell/language'
import { textEn } from './copy.en'

export const textJa = {
  title: '作っているアプリ',
  preview: 'アプリのプレビュー',
  preparing: '画面の準備をしています',
  previewError: 'プレビューでエラーが発生しています。AI が変更中の可能性があります。新しいタブで確認できます。',
  previewTimedOut: '画面がまだ開きません。もう少し待つか、新しいタブで開いてください。',
  /** Only for workspaces without a preview database (older or analysis-only ones). */
  previewDatabase: (excel: boolean) => `作っている途中のプレビューはデータベースなしで動いています。${excel ? '公開すると Excel のデータが入ります。' : '公開するとデータが保存・表示されます。'}`,
  /** The workspace's own preview database (design §6.4). Non-Excel drafts get schema only, so they never mention rows. */
  database: {
    starting: '作業用データベースを準備しています。',
    sleeping: '作業環境が休止中です。データは残っています。次に AI が作業を始めると再開します。',
    unavailable: '作業用データベースが止まっています。「データベースを作り直す」で直せます（作業中に入れたデータは消えます）。',
    readyUnverified: (excel: boolean): string => excel ? '作業用データベースは動いています。Excel の行はまだ確認されていません。' : '作業用データベースは動いています。ここで入れたデータは、公開したアプリには移りません。',
    readyVerified: (excel: boolean): string => excel ? '作業用データベースに Excel の行が入っています。公開すると本番のデータベースに入れ直します。' : '作業用データベースは動いています。ここで入れたデータは、公開したアプリには移りません。',
  },
  databaseReset: 'データベースを作り直す',
  databaseResetRunning: 'AI の作業が終わると作り直せます。',
  databaseResetConfirm: '作り直す',
  databaseResetBody: '作業用データベースを作り直します。作業中に入れたデータと確認結果は消えます。ソースコードと Excel は残ります。',
  databaseResetBusy: 'AI が作業している間は作り直せません。作業が終わってから、もう一度お試しください。',
  databaseResetNotEnabled: 'この作業環境には作業用データベースがないため、作り直せません。',
  databaseResetFailed: '作り直しを始められませんでした。少し待ってから、もう一度お試しください。',
  open: '見てみる',
  newTab: '新しいタブで開く',
  retry: 'もう一度試す',
  retryPending: '再開の準備をしています',
  unmetCriteria: (count: number) => `満たせなかった条件 ${count} 件`,
  skip: 'この作業を飛ばす',
  /** Every task was skipped or nothing was pushed: the app is still the bare template. */
  nothingImplemented: 'まだ画面は作られていません。もう一度試すと、画面を作り直せます。',
}

export const implementationCopy = localized({ ja: textJa, en: textEn })
