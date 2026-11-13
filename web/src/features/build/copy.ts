import type { BuildStage } from '../../model/build/types'
import { localized } from '../../shell/language'
import { textEn } from './copy.en'

/** Japanese wording is the default contract; keep the English tree in sync. */
export const textJa = {
  artifact: {
    users: '使う人',
    rules: 'ルール',
    approval: '承認・通知',
    approvals: { none: 'なし', 'one-step': '1 段', 'two-step': '2 段', 'notify-only': '通知だけ' },
    importFrom: '元のデータ',
    imports: { none: 'なし', csv: 'Excel・CSV がある', excel: 'Excel から取り込む' },
    /** Stored workbook membership takes precedence over specification import hints. */
    workbook: (fileName: string, sheets: number, rows?: number) => `${fileName}（${sheets} シート）から${rows === undefined ? '' : ` ${rows} 行を`}取り込む`,
    workbookSet: (first: string, others: number, sheets: number, rows?: number) => `${first} ほか ${others} ファイル（${sheets} シート）から${rows === undefined ? '' : ` ${rows} 行を`}取り込む`,
    uiDecisions: '画面の決定',
    screens: '画面',
    records: '記録',
    spec: '仕様',
    contents: '含まれるもの',
    undecided: (labels: string[]) => `これから決めること: ${labels.join('・')}`,
    listSeparator: '・',
    progress: '進行状況',
    preparation: 'アプリの準備',
    states: { todo: 'これから', doing: '進行中', done: '完了', failed: '失敗', unknown: '確認できない状態' },
    publishedApp: '公開したアプリ',
    published: '公開しました',
    openResult: 'できた画面を開く',
    copyUrl: 'URL をコピー',
    open: '開く',
    nextRequests: '次に頼めること: 画面を増やす、入力項目を変える、使いやすくする。',
    waitingForApp: '画面が動いてから表示します',
    advanced: '詳しい人向け',
    workspace: (id: string) => `workspace: ${id}`,
    phase: (phase: string) => `phase: ${phase}`,
  },
  conversation: {
    changesPlaceholder: '変えたいところを書く',
    replyPlaceholder: '答えや、変えたいところを書く',
    title: '会話',
    log: 'AI との会話',
    reflected: '話した内容は「いま作っているもの」にすぐ反映されます。',
    retry: 'もう一度試す',
    queuedAfter: (title: string) => `「${title}」が終わったら、送った内容を AI に伝えます`,
    queuedSoon: '送った内容を、まもなく AI に伝えます',
    elapsed: (label: string) => `（${label}）`,
    you: 'あなた: ',
    ai: 'AI',
    labelSeparator: '・',
    changed: '変えたところ',
    /** The collapsed Excel → app line links back to the analysis and the UI preview. */
    excelReview: '解析と画面を見る',
  },
  page: {
    title: (name: string) => `${name} — AI と作る`,
    updatingPlan: (elapsed: string) => `計画を更新中… ${elapsed}`,
    waitingForPublish: '公開の準備がまだです。自動で続けます。',
    tabs: '作業の表示',
    artifactTab: '作っているもの',
    noGroup: {
      title: '所属する部署がありません',
      body: 'アプリは部署に属します。管理者にあなたを部署に追加してもらってから、このページを開き直してください。',
      directory: '組織と人',
    },
    /** The draft GET answered 404: it was deleted, or it belongs to another account (drafts are visible only to their owner). */
    notFound: {
      title: 'この作りかけは開けません',
      body: '削除されたか、別のアカウントで作ったものです。作りかけは作った本人だけが開けます。',
      signedInAs: (email: string) => `いまは ${email} でサインインしています。作った本人のアカウントでサインインし直してください。`,
      back: '作りかけ一覧へ',
    },
  },
  session: {
    stageLabels: { ask: '聞く', decide: '決める', build: '作る', publish: '公開' } satisfies Record<BuildStage, string>,
    newApp: '新しいアプリ',
    retryPlan: '計画を作れませんでした。もう一度考えます。',
    missingExecution: 'The server did not return a creation execution',
    operationFailed: 'The operation failed',
    missingAppName: 'The creation plan has no application name',
  },
  header: {
    stateWord: { ask: '作りかけ', decide: '作りかけ', build: '作っています', publish: '公開中' } satisfies Record<BuildStage, string>,
    myApps: '自分のアプリ',
    drafts: '作りかけ',
    back: (label: string) => `${label}へ戻る`,
  },
  proposal: {
    title: (name: string) => `提案: ${name}`,
    purposeSeparator: '\u3000',
    record: (name: string, fields: string[]) => `${name}${fields.length ? `（${fields.join('・')}）` : ''}`,
    recordSeparator: '、',
  },
  implement: {
    steps: 'アプリを作る手順',
    elapsed: '経過',
    buildLink: '下地を作る様子を見る',
    cancelled: 'Implementation cancelled',
    failed: 'Implementation failed',
  },
  publish: {
    waitingForUrl: 'URL の準備ができるまでお待ちください。',
    title: '誰に見せますか？',
    name: '公開する名前',
    confirmName: '確認のためアプリの名前を入力',
    submit: 'この範囲で公開する',
    back: '戻る',
  },
  composer: {
    keyHint: 'Enter で送信、Shift + Enter で改行',
    suggestions: '返答の候補',
    label: 'AI に伝えること',
    send: '送信',
  },
  nameChoice: {
    useSuggestion: (name: string) => `${name} にする`,
    alternative: '別の名前',
    hint: '半角の英小文字・数字・ハイフンで 63 文字まで。',
    submit: 'この名前にする',
  },
}

export const text = localized({ ja: textJa, en: textEn })
