import { localized } from '../../shell/language'
import { designTextEn } from './design-copy.en'

export const designTextJa = {
  roles: { records: '台帳', master: 'マスタ', report: '集計', mixed: '台帳・マスタ・集計', unused: '取り込まない表' },
  reading: (sheets: number, rows: number) => `${sheets} シートから、記録として使う ${rows} 行を読み取りました。`,
  summary: (files: number, entities: number, rows: number) => `${files} 件の Excel を、${entities} 種類・${rows} 件の記録を管理するひとつの業務アプリにまとめます。`,
  none: '記録として取り込める表が見つかりませんでした。',
  merged: (entity: string, count: number) => `${count} 枚の表を「${entity}」にまとめます。見出しをそろえて取り込みます。`,
  truncated: (file: string) => `「${file}」は先頭 5,000 行までを読み取りました。残りのデータは移行前に確認してください。`,
  entityLimit: '記録の種類が上限の 50 を超えたため、一部の表を取り込んでいません。対象のファイルを分けて、取り込む範囲を確認してください。',
  sources: (files: string) => `元のファイル: ${files}`,
  fileRole: (file: string, role: string, summary: string) => `「${file}」: ${role}。${summary}`,
  aggregate: '集計表や集計の数式は、記録から計算するダッシュボードに置き換えます。',
  flow: (name: string, steps: string) => `${name}: ${steps}`,
  oneLine: (files: number) => `${files} 件の Excel で行っている業務を、部署で一緒に使うひとつの Web アプリにする`,
  overview: (files: number, sheets: number, rows: number) => `${files} 件の Excel（${sheets} シート）をひとつの業務アプリにまとめ、${rows} 行を取り込む。部署のメンバーが同時に使い、二重管理をなくす。`,
  mapping: '各表の見出しを記録の項目に対応づけ、表ごとに決まった値があれば補って取り込む。空の行は取り込まない。',
  dedupe: (entity: string, fields: string) => `「${entity}」は ${fields} が同じ記録をまとめる。内容が異なる記録は上書きせず、移行前に確認する。`,
  preserve: '元のファイル・表・行をたどれるようにして取り込み、取り込み結果を元のデータと突き合わせる。',
  requestMany: 'これらの Excel を読み取ってください',
}

export const designText = localized({ ja: designTextJa, en: designTextEn })
