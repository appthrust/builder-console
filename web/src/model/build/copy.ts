import { localized } from '../../shell/language'
import { textEn } from './copy.en'

export const textJa = {
  intent: { reply: '### 追記', publish: '公開: する' },
  questions: {
    firstTurn: 'このアプリを作るために決めるべきことを、一つずつ質問してください。',
    kickoffReply: 'この内容で提案して',
    prepareTurn: 'アプリを用意している間に、公開するときの名前と、誰に見せるかを一つずつ確認してください。',
    /** The excel2app analysis and screen-design turns, collapsed into one line of the conversation. */
    excelReady: 'Excel の解析と画面の決定は済んでいます',
  },
  primary: { prepare: 'この内容で作る', afterPlan: '計画ができたら作る', refresh: '計画を更新して作る', publish: '公開する', continue: '続けて直す' },
  proposal: {
    intro: 'この内容でアプリを作ります。',
    pending: { title: '作る内容をまとめています', hint: 'できたら、ここで内容を確かめられます' },
    stale: '仕様が変わりました。作るときに計画を更新します。',
    url: '公開先（予定）',
    urlLater: '公開先はあとで決めます',
    tasks: '作る内容',
    moreTasks: (n: number) => `ほか ${n} 件`,
  },
  progress: {
    workspace: { title: 'AI の準備をしています', hint: '初回は 1–2 分かかります' },
    turn: { title: '考えています', hint: '通常 30 秒ほどです' },
    plan: { title: '計画を考えています', hint: '通常 1–3 分です' },
    planPrepare: { title: '資料を準備しています' },
    read: { title: '計画を読み込んでいます' },
    prepare: { title: 'アプリを作っています', hint: '通常 10 分ほどです' },
    implement: { title: 'アプリを作っています' },
    implementationSync: { title: '作る内容を確認しています' },
    implementationPush: { title: '新しい版を保存しています' },
    publish: { title: '公開の準備をしています', hint: '通常 1–2 分です' },
    task: {
      fallback: 'アプリ',
      request: 'AI に依頼を送っています',
      working: (hasOutput: boolean): string => hasOutput ? 'AI が作業しています（出力あり）' : 'AI が作業しています',
      pushing: 'できたところを保存しています',
      label: (name: string) => `画面「${name}」`,
      status: { pending: 'これから', running: '作業中', done: 'できました', failed: '止まっています', skipped: '飛ばしました', unknown: '確認できない状態' },
    },
    interrupted: { title: '基盤の更新で中断しました。自動で再開します。', hint: '最大 15 分ほどお待ちください。画面はこのままで大丈夫です。' },
    steps: { check: '内容を確認する', source: '作ったものの置き場', release: '最初の版', url: 'URL', ready: 'アプリの準備を確認する', records: '記録する内容を整える' },
    publishReady: '公開準備',
    observe: {
      source: '置き場',
      phases: {
        syncing: { label: '設計図を反映', expectation: '目安 約 1 分', minutes: 1, activity: '設計図をアプリに反映しています', hint: '設計図の反映を待っています。基盤の担当者に確認してください。' },
        building: { label: '下地を起動', expectation: '目安 3–5 分', minutes: 5, activity: '下地を組み立てています', hint: '下地の組み立てに時間がかかっています。基盤の担当者に確認してください。' },
        starting: { label: '下地を起動', expectation: '目安 1–2 分', minutes: 2, activity: '下地を起動しています', hint: '起動を待っています。基盤の担当者に確認してください。' },
      },
      ready: '下地ができました',
      activity: 'いまの動き',
      buildLink: 'ビルドの様子を見る',
      delayed: (hint: string) => `いつもより時間がかかっています（${hint}）`,
      reasons: {
        build_failed: '下地の組み立てに失敗しました。基盤の担当者に確認してください。',
        build_timeout: '下地の組み立てが時間内に終わりませんでした。基盤の担当者に確認してください。',
        release_failed: '下地を起動できませんでした。基盤の担当者に確認してください。',
        stack_failed: '設計図を反映できませんでした。基盤の担当者に確認してください。',
      },
    },
  },
  sourceBuild: {
    failed: 'アプリのビルドに失敗しています',
    status: 'ビルドに失敗しています',
    run: 'ビルドの実行を見る',
  },
  failure: {
    forbidden: { title: 'アプリを作る権限がありません', reason: '基盤の担当者に「アプリを作る権限」を依頼してください。' },
    group: { title: '所属する部署が確認できませんでした', reason: '管理者に部署への追加を依頼してから、もう一度試してください。' },
    limit: { title: 'この作業で考え直せる回数を使い切りました', reason: '前の提案を使うか、新しい作りかけから始めてください。' },
    unavailable: { title: 'AI がいま使えません', reason: '基盤の更新中かもしれません。少し待ってからもう一度試してください。しばらく待っても使えないときは、基盤の担当者に確認を依頼してください。' },
    quota: { title: 'AI の利用枠が切れています', reason: '管理者に AI の利用枠の回復を依頼してください。回復後に、もう一度試すボタンを押すと止まったところから再開できます。Excel や入力内容の問題ではありません。' },
    waitingForAi: { title: 'AI の準備を待っています', hint: '基盤の更新中かもしれません。そのまま待つと自動で続けます。' },
    workspace: { title: 'AI の作業場所がまだ準備できていません', contact: 'そのまま待つか、もう一度試してください。5 分以上変わらないときは基盤の担当者に確認してください。' },
    storage: 'AI が使う保存場所の準備が止まっています。',
    capacity: 'AI を動かす空きが足りません。',
    files: 'AI を動かすためのファイルを読み込めません。',
    initialization: 'AI の作業場所の初期設定に失敗しました。',
    starting: 'AI の作業場所の起動を待っています。',
    unknownWorkspace: 'AI の作業場所が使える状態か、まだ確認できません。',
    timeout: { title: '処理に時間がかかっています', reason: '相談した内容は残っています。少し待ってから、もう一度試してください。' },
    busy: { title: 'AI が前の作業を進めています', reason: '内容は残っています。前の作業が終わったら続けます。' },
    failed: { turn: 'AI が内容を整理できませんでした', plan: '計画を作れませんでした', implement: 'アプリを作る作業が止まりました', publish: '公開済みの状態を保存できませんでした' },
    retry: '仕様と計画は残っています。もう一度試してください。何度も止まるときは基盤の担当者に確認してください。',
    platform: { title: '基盤の問題で作成が止まりました', reason: 'あなたの入力や操作の問題ではありません。仕様と計画はそのまま残っています。少し待ってもう一度試すか、下の問い合わせ番号を基盤の担当者に伝えてください。' },
    reference: (value: string) => `問い合わせ番号: ${value}`,
    copyReference: '問い合わせ番号をコピー',
    /** The task stream dropped (tab closed, sleep, sign-in expired): nothing is lost, the rerun continues. */
    resumable: { title: 'AI の作業が途中で止まりました', reason: 'この画面を離れていた間に止まったかもしれません。もう一度試すと、できたところの続きから進めます。' },
    nameTaken: '置き場の名前がすでに使われています',
    urlNameTaken: 'URL の名前が別のアプリで使われています',
    suggestName: (name: string) => `「${name}」に変えて、もう一度作りますか？`,
    chooseName: '別の名前に変えて、もう一度作ってください。',
    /** A write answered 2xx but its answer could not be read: it may have happened. Never resent automatically. */
    unconfirmed: { title: '処理結果を確認できませんでした', reason: '送った操作は届いているかもしれません。最新の状態を確かめてから続けてください。自動ではくり返しません。' },
    confirm: '最新の状態を確認する',
  },
  /** A state this console version does not know: the known parts stay visible, only what depends on it stops. */
  unsupported: { title: 'この状態はいまの画面では扱えません', detail: 'ほかの内容はそのまま見られます。この状態に関わる操作は、状態がわかるまで止めています。' },
  artifact: { title: 'いま作っているもの', collapse: '作っているものをたたむ', expand: '作っているものを広げる' },
  discard: {
    action: '削除',
    label: (name: string) => `「${name}」を削除する`,
    title: (name: string) => `「${name}」を削除しますか？`,
    body: 'AI との会話と仕様を消します。元に戻せません。',
    bodyWithResources: 'AI との会話と仕様に加えて、用意した置き場とアプリも消します。元に戻せません。',
    confirm: '削除する',
    pending: '削除しています…',
    running: 'AI が作業中のため、いまは削除できません。終わってからもう一度試してください。',
  },
  /** 用意する: while the app is prepared the AI asks for the published name and who sees it. */
  prepareConversation: {
    ready: '下地ができました。ここから画面を作ります。',
  },
  mockExcelHandoff: {
    screenTitle: '決定した画面とデータを用意する',
    screenDescription: '読み取った項目・型・選択肢・ルールと、プレビューで決めた画面・列・色・入力欄・集計を引き継ぎます。',
    screenCriterion: 'プレビューで決めた画面と入力項目が使える',
    seedTitle: 'Excel の既存行を取り込む',
    seedDescription: 'アップロードした Excel の記録を保存し、アプリから確認・編集できるようにします。',
    seedCriterion: 'Excel の既存行が保存され、画面で確認できる',
    unmetCriterionNote: '一度修正しましたが、この条件はまだ満たしていません。',
  },
}

/** Resolve presentation text and new AI prompts at use time, including outside React. */
export const buildCopy = localized({ ja: textJa, en: textEn })
