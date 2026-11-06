import { localized } from '../shell/language'
import { sharingCopyEn } from './sharing.en'

export const sharingCopyJa = {
  title: '共有',
  people: 'アクセスできる人',
  general: '一般的なアクセス',
  search: '名前やメールアドレスで追加',
  add: '追加',
  invite: 'このメールアドレスで招待',
  invalidEmail: 'メールアドレスを正しく入力してください。',
  already: '追加済み',
  viewer: '閲覧',
  editor: '編集',
  role: (name: string) => `${name} の役割`,
  remove: (name: string) => `${name} を外す`,
  pending: '招待中（まだログインしていません）',
  lastOwner: '編集できる人を 1 人以上残してください。',
  group: (name: string) => `${name} のメンバー`,
  company: '社員全員',
  public: '誰でも',
  limited: '指定した人のみ',
  limitedHint: '編集できる人と、個別に追加した人が開けます。',
  copyLink: 'リンクをコピー',
  copyInvitation: '招待文をコピー',
  invitation: (name: string, url: string, email: string) => `「${name}」を共有しました。\n${url}\n${email} でサインインしてください。`,
  noMail: 'メールは送信されません。招待文を相手に渡してください。招待したメールアドレスでサインインできるアカウントが必要です。',
  invitationEmail: '招待文に使うメールアドレス',
  forbidden: '基盤の編集権限（Team Editor）が必要です',
  unavailable: 'URL の準備ができてから、公開範囲を保存してください。',
  status: {
    public: '公開中（誰でも）',
    company: '社員のみ',
    limited: (count: number, groups: string) => `限定（${count} 人${groups ? `・${groups}` : ''}）`,
    pending: '反映中',
    unapplied: '未適用（基盤の権限が必要）',
    failed: '公開範囲の反映に失敗',
    failedPublic: '公開範囲の反映に失敗（現在は誰でもアクセスできます）',
  },
  apply: '公開範囲を反映する',
  progress: '公開範囲',
}

export const sharingCopy = localized({ ja: sharingCopyJa, en: sharingCopyEn })
