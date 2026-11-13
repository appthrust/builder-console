// データ tab wording (design/platform/builder-console-app-data.md "Product language"
// and "States"). Use spreadsheet language in both languages, not PostgreSQL
// terms such as schema, primary key or PostgREST.
import type { MembershipUnboundReason } from '../../../api/queries/data'
import { locale, localized } from '../../../shell/language'
import { dataTextEn } from './copy.en'

// Japanese wording owns the shape shared by both language catalogs.
export const dataTextJa = {
  navLabel: '表',
  rowEstimate: (count: number) => `約 ${count.toLocaleString(locale())} 行`,
  collectionLabel: (label: string, estimate: string) => `${label}（${estimate}）`,
  search: '検索',
  searchPlaceholder: 'この表を検索',
  addRow: '行を追加',
  readOnly: 'この表は見るだけです',
  unsupportedColumns: 'この表にはこの画面で扱えない列があるため、ここでは行を追加できません',
  gridCaption: (label: string) => `${label}の行`,
  referenceHint: (label: string) => `${label} の行`,
  previousPage: '前の 50 行',
  nextPage: '次の 50 行',
  pageRange: (from: number, to: number) => `${from.toLocaleString(locale())}〜${to.toLocaleString(locale())} 行目`,
  pagination: 'ページ',
  fetchedAt: (relative: string) => `最終読み込み ${relative}`,
  refresh: '読み込み直す',
  noTables: 'まだ表がありません。アプリが最初のデータを作ると表示されます。',
  noRows: 'まだ行がありません',
  noMatches: (q: string) => `「${q}」に合う行はありません`,
  clearSearch: '検索をやめる',
  suspended: 'データベースは停止中です。アプリを開くと起動し、データが見られます。',
  unsupported: 'この種類のデータベースはまだ対応していません',
  forbiddenTitle: 'データを見る権限がまだありません',
  forbiddenBody: '基盤の担当者に「データの閲覧」を依頼してください',
  membershipUnboundTitle: 'いまのチームメンバー登録では、データへのアクセスが許可されていません',
  /** By 412 `details.membershipReason`; the same sentences as the Dashboard's Team members list. */
  membershipUnbound: {
    SubjectUnbound: 'まだサインインしていません。このメールアドレスで最初にサインインすると、データベースと実行環境へのアクセスが許可されます。',
    NotPersisted: '役割は基盤の管理者またはグループから来ています。このユーザーをチームメンバーとして追加すると、データベースと実行環境へのアクセスが許可されます。',
  } satisfies Record<MembershipUnboundReason, string>,
  teamSettings: 'チームの設定を開く',
}

export const dataText = localized({ ja: dataTextJa, en: dataTextEn })
