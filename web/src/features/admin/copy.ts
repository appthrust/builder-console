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
}

export const text = localized({ ja: textJa, en: textEn })
