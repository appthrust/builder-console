import { locale } from '../../../shell/language'
import type { dataTextJa } from './copy'

export const dataTextEn: typeof dataTextJa = {
  navLabel: 'Table',
  rowEstimate: (count: number) => `About ${count.toLocaleString(locale())} ${count === 1 ? 'row' : 'rows'}`,
  collectionLabel: (label: string, estimate: string) => `${label} (${estimate})`,
  search: 'Search',
  searchPlaceholder: 'Search this table',
  addRow: 'Add row',
  readOnly: 'This table is view-only',
  gridCaption: (label: string) => `Rows in ${label}`,
  referenceHint: (label: string) => `Row in ${label}`,
  previousPage: 'Previous 50 rows',
  nextPage: 'Next 50 rows',
  pageRange: (from: number, to: number) => `Rows ${from.toLocaleString(locale())}–${to.toLocaleString(locale())}`,
  pagination: 'Pages',
  fetchedAt: (relative: string) => `Last loaded ${relative}`,
  refresh: 'Reload',
  noTables: 'Tables will appear when your app creates its first data.',
  noRows: 'No rows yet',
  noMatches: (q: string) => `No rows match “${q}”`,
  clearSearch: 'Clear search',
  suspended: 'Open the app to wake its database and view your data.',
  unsupported: 'This type of database is not supported yet',
  forbiddenTitle: 'Data access needed',
  forbiddenBody: 'Ask your administrator for permission to view data',
  membershipUnboundTitle: 'Data access is not granted to your current team membership',
  membershipUnbound: {
    SubjectUnbound: 'Not signed in yet — database and runtime access is granted after the first sign-in with this email.',
    NotPersisted: 'Role comes from platform admin or a group. Add this user as a team member to grant database and runtime access.',
  },
  teamSettings: 'Open team settings',
}
