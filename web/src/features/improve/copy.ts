import type { ImprovePhase, ImproveStage } from '../../model/improve'
import { localized } from '../../shell/language'
import { textEn } from './copy.en'

/** Japanese wording is the default contract; keep the English tree in sync. */
export const textJa = {
  stageLabels: { ask: '聞く', fix: '直す', check: '確認' } satisfies Record<ImproveStage, string>,
  /** The session's state in one word (header pill, 作りかけ list); `done` is `updated(version)`. */
  state: { asking: '直しています', proposed: '変更案があります', running: '直しています', failed: '止まっています' } satisfies Record<Exclude<ImprovePhase, 'done'>, string>,
  updated: (version?: string) => (version ? `${version} に更新しました` : '更新しました'),
  entry: {
    action: 'AIで直す',
    title: 'AIで直す',
    description: (app: string) => `「${app}」のどこを直したいか書いてください。AI がいまの作りを読んで、直しかたを提案します。`,
    label: 'どこを直しますか？',
    placeholder: '例: 一覧に絞り込みを足したい',
    submit: '相談をはじめる',
    noSource: 'このアプリには置き場がないため、AI では直せません。',
    noReviewers: '所有者がまだログインしていません。所有者がログインしてから、もう一度試してください。',
    busy: 'いま別の相談を進めています。少し待ってから、もう一度試してください。',
  },
  page: {
    title: (name: string) => `${name} — AI で直す`,
    back: (name: string) => `「${name}」へ戻る`,
    drafts: '作りかけ',
    tabs: '作業の表示',
    sideTab: '直しているもの',
  },
  conversation: {
    intro: '話した内容から、AI が直しかたを提案します。できた変更は、所有者が確認してから反映します。',
    placeholder: '直したいところを書く',
    thinking: 'いまの作りを読んでいます',
  },
  proposal: {
    label: '変更案',
    lead: 'この内容で直します。',
    apply: 'この内容で直す',
  },
  run: {
    running: '直しています',
    starting: '直す準備をしています',
    changed: '直したところ',
    openApp: 'アプリを開く',
    continue: '続けて直す',
    preview: '途中の画面を見る',
    previewPreparing: '途中の画面を準備しています',
  },
  pane: {
    title: 'いま直しているもの',
    empty: '話がまとまると、ここに直すところが出ます。',
    proposal: 'これから直すところ',
    progress: '進み具合',
    versions: 'これまでの更新',
    appUrl: 'アプリの URL',
    collapse: '直しているものをたたむ',
    expand: '直しているものを広げる',
  },
  drafts: {
    resume: '続きから直す',
  },
}

export const text = localized({ ja: textJa, en: textEn })

/** The session's state in one phrase: the header pill and the 作りかけ list. */
export function improveStateWord(phase: ImprovePhase, version?: string): string {
  return phase === 'done' ? text.updated(version) : text.state[phase]
}
