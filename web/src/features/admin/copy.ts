// Locale-resolved wording for 基盤の設定 and the one-time Directory migration.
// Read text at render time so language changes do not leave cached Japanese strings.
// Shared keys (`copy.admin`) stay in ../../copy/shell.ts.
import { localized } from '../../shell/language'
import { textEn } from './copy.en'

export const textJa = {
  migration: {
    title: '人とグループをディレクトリへ移す',
    body: '人とグループはディレクトリで管理するようになりました。コンソールに残っている分を一度だけ移してください。アプリの担当者や公開範囲はそのままです。',
    counts: (people: number, groups: number, memberships: number) => `人 ${people} 人・グループ ${groups} 件・所属 ${memberships} 件`,
    start: 'ディレクトリへ移す',
    confirmTitle: '人とグループをディレクトリへ移しますか？',
    confirmBody: 'いまの ID のまま移すので、アプリの担当者や公開範囲は変わりません。もう一度実行しても重複しません。',
    confirm: '移す',
    doneTitle: 'ディレクトリへ移しました',
    imported: (people: number, groups: number, memberships: number) => `移した数: 人 ${people} 人・グループ ${groups} 件・所属 ${memberships} 件`,
    conflicts: (n: number) => `${n} 件は移せませんでした。ディレクトリで確認してください。`,
    conflictsLabel: '移せなかったもの',
    entity: { person: '人', group: 'グループ', membership: '所属' } as Record<string, string>,
    openDirectory: 'ディレクトリを開く',
  },
  platform: {
    summaryReady: 'アプリを作る準備ができています',
    summaryReadyBody: '必要な連携はすべて設定済みです。',
    summaryMissing: (n: number) => `${n} 件の設定が足りません`,
    summaryMissingBody: 'このままではアプリを作れません。基盤の担当者に設定を依頼してください。',
    readOnly: 'この画面は見るだけです。設定の変更は基盤の担当者が行います。',
    ready: '設定済み',
    missing: '未設定',
    checking: '確認中',
    unknown: '確認できません',
    domain: '公開ドメイン',
    domainOn: (domain: string) => `アプリの URL は https://〈URL になる名前〉.${domain} になります。`,
    domainOff: '公開用のドメインがありません。基盤の担当者に設定を依頼してください。',
    domainFailed: '公開ドメインを確認できませんでした。',
    teamYou: 'あなたはアプリを作れます。',
    teamNotYou: 'あなたはまだ「作れる人」に登録されていません。必要なら基盤の担当者に依頼してください。',
    advancedLead: '基盤の担当者に問い合わせるときに伝えてください。',
  },
  conversation: {
    title: '新しい AI 会話',
    lead: 'AI と仕様を相談してから作る新しい会話を、これから始めるアプリで使うかを選びます（作成中のアプリはいまの流れのまま続きます）。',
    legend: '使う人',
    modes: {
      off: { title: '使わない', description: 'だれが始めても、いままでの「AI と作る」の流れになります。' },
      allowlist: { title: '一部の人だけ', description: '下で選んだ人だけが新しい会話で始めます。ほかの人はいままでの流れです。' },
      on: { title: '全員', description: 'アプリを作れる人は全員、新しい会話で始めます。' },
    },
    people: '新しい会話を使う人',
    peopleCount: (n: number) => `${n} 人`,
    empty: 'まだだれも選んでいません。選ぶまで、新しい会話はだれにも出ません。',
    search: '人を追加する',
    add: '追加',
    added: '追加済み',
    remove: '外す',
    removeLabel: (name: string) => `${name} を外す`,
    limit: (n: number) => `${n} 人まで選べます。追加するには、だれかを外してください。`,
    notSignedIn: (name: string) => `${name} さんはまだコンソールにサインインしたことがないため、選べません。`,
    updated: (name: string, when: string) => `最後の変更: ${name}・${when}`,
    neverUpdated: 'まだ変更されていません。',
    unsaved: '新しい AI 会話の変更が保存されていません。',
    conflictTitle: 'ほかの管理者が先に変更しました',
    conflictBody: (current: string) => `いまの設定は「${current}」です。あなたの選択はこの下に残しています。見比べてから、保存し直すか変更をやめてください。`,
    discard: '変更をやめる',
    unknownMode: 'この画面では扱えない設定が保存されています。ページを読み込み直してから変更してください。',
    summaryWithPeople: (mode: string, n: number) => `${mode}（${n} 人）`,
  },
}

export const text = localized({ ja: textJa, en: textEn })
