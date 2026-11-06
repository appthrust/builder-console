import { localized } from '../shell/language'
import { accessRequestCopyEn } from './access-request.en'

export const accessRequestCopyJa = {
  title: 'アクセスのリクエスト',
  needAccess: 'アクセス権が必要です',
  notShared: (app: string) => `${app} はあなたに共有されていません。担当者にアクセスをリクエストできます。`,
  message: 'メッセージ（任意、500 字まで）',
  request: 'アクセスをリクエスト',
  requestAgain: 'もう一度リクエスト',
  sent: 'リクエストを送りました',
  waiting: (at: string) => `担当者の承認待ちです（${at}）。承認されると、下の URL を開けるようになります。`,
  waitingWithoutDate: '担当者の承認待ちです。承認されると、下の URL を開けるようになります。',
  declined: '承認されませんでした',
  declinedBody: (at: string) => `${at} に決定されました。必要なら、もう一度リクエストできます。`,
  declinedWithoutDate: '必要なら、もう一度リクエストできます。',
  granted: 'このアプリは開けます',
  grantedBody: 'アプリを開けるようになりました。',
  openApp: 'アプリを開く',
  appUrl: 'アプリの URL',
  copyUrl: 'URL をコピー',
  notFound: 'このアプリは見つかりません',
  notFoundBody: 'URL を確認してください。',
  signedInAs: (email: string) => `${email} でログイン中`,
  switchAccount: '別のアカウントに切り替える',
  copyNote: '依頼文をコピー',
  note: (app: string, url: string) => `「${app}」へのアクセスをリクエストしました。console の共有ダイアログで承認してください。\n${url}`,
  tooMany: '承認待ちのリクエストが多すぎます。担当者の承認を待ってください。',
  remaining: (count: number) => `残り ${count} 字`,
  messageTooLong: 'メッセージは 500 字以内で入力してください。',
  unavailable: 'いま確認できません',
  unavailableBody: '時間をおいて、もう一度お試しください。',
  // 承認側
  section: 'アクセスのリクエスト',
  approveViewer: '閲覧で承認',
  decline: '承認しない',
  previous: '以前のリクエスト',
  alreadyOpen: 'すでに全員が開けます',
}

export const accessRequestCopy = localized({ ja: accessRequestCopyJa, en: accessRequestCopyEn })
