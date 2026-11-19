// 「あなたの対応待ち」 wording (role-based-views ux-design §6.3, §8). 敬体;
// headings ≤ 20 字, explanations ≤ 40 字.
import { localized } from '../../shell/language'
import { inboxEn } from './copy.en'

export const inboxJa = {
  title: 'あなたの対応待ち',
  count: (n: number) => `${n} 件`,
  seeAll: 'すべて見る',
  rowsLabel: '対応待ちの一覧',
  pill: {
    problem: () => '問題あり',
    proposal: (n: number) => `提案 ${n} 件`,
    accessRequest: (n: number) => `利用申請 ${n} 件`,
    feedback: (n: number) => `コメント ${n} 件`,
    draft: () => '作りかけ',
  },
  note: {
    proposalBy: (name: string) => `${name} さんの提案が確認を待っています。`,
    proposal: '提案が確認を待っています。',
    accessRequest: '使いたい人が申請しています。',
    feedback: '利用者から新しいコメントが届いています。',
    draft: '作り終えていません。続きから作れます。',
  },
  action: {
    problem: '状況を確認する',
    proposal: '提案を見る',
    accessRequest: '申請を見る',
    feedback: 'コメントを見る',
    draft: '続きから作る',
  },
  actionLabel: (action: string, app: string) => `${app}: ${action}`,
}

export const inboxText = localized({ ja: inboxJa, en: inboxEn })
