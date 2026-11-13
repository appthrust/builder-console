import type { decisionsTextJa } from './decisions-copy'

export const decisionsTextEn: typeof decisionsTextJa = {
  order: 'Screen order',
  orderSeparator: ' → ',
  hidden: 'Screens left out',
  list: (entity: string) => `“${entity}” list`,
  layouts: { table: 'Table', cards: 'Cards' },
  columns: (columns: string[]) => `columns: ${columns.join(', ')}`,
  colorBy: (field: string) => `colored by “${field}”`,
  groupBy: (field: string) => `grouped by “${field}”`,
  form: (entity: string) => `“${entity}” form`,
  required: (fields: string[]) => `Required: ${fields.join(', ')}`,
  dashboard: 'Dashboard',
  separator: ', ',
  partSeparator: '; ',
  incomplete: 'Some other decisions cannot be shown on this page.',
}
