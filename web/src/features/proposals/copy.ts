import type { ProposalPhase } from '../../model/contracts/proposal'
import { localized } from '../../shell/language'
import { textEn } from './copy.en'

export const textJa = {
  title: '提案', sent: '提案を送りました', accept: '反映する', requestChanges: 'やり直してもらう', reject: '見送る',
  by: (name: string) => `${name} さんの提案`,
  waiting: '所有者の確認を待っています', incoming: '確認待ちの提案', outgoing: '送った提案',
  reviewers: (names: string) => `確認する人: ${names}`,
  open: '提案を見る', preview: '変更後の画面を見る',
  tasks: '直すところ', changes: '変更の内容', diff: '詳しい変更を見る', truncated: '変更の一部を表示しています。',
  files: (count: number) => `${count} ファイル`, empty: '確認待ちの提案はありません。',
  comment: '直してほしいところ', commentHelp: 'この内容をもとに、もう一度直してもらいます。',
  feedback: '確認した人からのコメント', continue: '続きから直す', back: 'アプリへ戻る',
  /** A phase this console does not know: never shown as any known phase. */
  phaseUnknown: '状態不明',
  /** Why the review actions are disabled when the proposal holds something this console does not know. */
  unsupported: 'この提案には、この画面ではまだ扱えない内容があります。ここでは反映・やり直し・見送りはできません。',
  phase: {
    Drafting: '準備しています', Proposed: '確認待ち', ChangesRequested: 'やり直し待ち', Accepted: '反映を受け付けました',
    Applying: '反映しています', Applied: '反映しました', ApplyFailed: '反映できませんでした', Rejected: '見送りました',
    Withdrawn: '取り下げました', Expired: '期限が切れました',
  } satisfies Record<ProposalPhase, string>,
}
export const text = localized({ ja: textJa, en: textEn })
