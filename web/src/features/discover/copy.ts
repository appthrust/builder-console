// Discover-only wording (home, lists, group pages). Shared keys stay in
// src/copy/shell.ts; this file only adds what the rebuilt screens need.
// 敬体; headings ≤ 20 字, explanations ≤ 40 字 (ux-design §10).
import { localized } from '../../shell/language'
import { textEn } from './copy.en'

export const textJa = {
  home: {
    searching: '探しています…',
    resultsCount: (n: number) => `${n} 件`,
    groupLead: (name: string) => `${name} と、その下のグループのアプリです。`,
    sharedLead: '上位のグループから共有されて、あなたも使えるアプリです。',
    companyLead: '会社の全員が使える、最近できたアプリです。',
  },
  list: {
    ownerSeparator: '、',
    urlLabel: (name: string) => `${name} の URL`,
    open: '開く ↗',
    copyUrl: 'URL をコピー',
    statusFailed: 'アプリの状態を確認できませんでした。',
    created: (time: string) => `${time}に追加`,
    resume: '続きから作る',
    check: '状況を確認する',
    discard: '削除',
    discardLabel: (name: string) => `「${name}」を削除する`,
    discardTitle: (name: string) => `「${name}」を削除しますか？`,
    discardBody: '作りかけのアプリを一覧から消します。元に戻せません。',
    discardConfirm: '削除する',
    discarding: '削除しています…',
  },
  drafts: {
    title: '作りかけ',
    create: 'AI と作る',
    lead: '作り終えていないアプリです。続きから作れます。',
    building: (stage: string) => `AI と作成中（${stage}）`,
    updated: (time: string) => `・${time}に更新`,
    empty: '作りかけのアプリはありません',
    emptyBody: 'やりたいことを書いて「AI と作る」を押すと、ここから続きを作れます。',
  },
  mine: {
    problemLead: '問題ありのアプリと、次にできることを表示しています。',
    seeAll: 'すべて見る',
    statusFailed: '状態を確認できませんでした',
    noProblems: '問題ありのアプリはありません',
    emptyBody: 'アプリを作ると、ここに表示されます。',
    cannotCreate: 'アプリを作るには、管理者に「作れる人」への追加を依頼してください。',
  },
  group: {
    emptyBody: 'アプリを作ると、このグループに表示されます。',
    createHere: 'このグループにアプリを作る',
  },
  entry: {
    ofGroup: (name: string) => `${name} のアプリ`,
    wantToUse: '使いたい',
    restricted: (name: string) => `このアプリは ${name} の人向けに公開されています。使いたいときは「使いたい」から申請できます。`,
    owner: '担当',
    requestUnavailable: '申請先を確認できません。担当者に聞いてみてください。',
  },
  store: {
    makers: 'この部署で作っている人',
    makerApps: (n: number) => `${n} 件`,
    trial: (n: number) => `試用・準備中（${n} 件）`,
    trialLead: '紹介の写真や「できること」がまだないアプリです。',
    open: (name: string) => `${name}を開く`,
    want: (name: string) => `${name}を使いたい`,
  },
  person: {
    apps: (n: number) => `作ったアプリ（${n} 件）`,
    appsLoading: '作ったアプリ',
    noApps: 'まだアプリはありません。',
    memberships: '所属',
  },
  members: {
    inheritedColumn: '継承元',
    you: 'あなた',
    emailMissing: 'メールアドレス未登録',
  },
  help: {
    lead: 'はじめて使うときに知っておきたいことです。',
  },
}

export const text = localized({ ja: textJa, en: textEn })
