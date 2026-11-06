// Console URL builders (ux-design §7.1.1). Group and app URLs are dynamic
// splats, so links take these strings through `<HrefLink href>` / `<LinkButton href>`.

export type GroupTab = 'front' | 'apps' | 'members'
export type AppTab = 'overview' | 'guide' | 'data' | 'releases' | 'settings' | 'logs'

/** データ tab deep link: `table` = `<schema>.<name>`, `q` = search, `row` = key of the row whose sheet is open. */
export type AppDataSearch = { table?: string; q?: string; row?: string }

export type NewAppSearch = { group?: string; resume?: string; template?: string; intent?: string }

function withSearch(path: string, values: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value) search.set(key, value)
  }
  return search.size ? `${path}?${search}` : path
}

const encodePath = (path: string) => path.split('/').filter(Boolean).map(encodeURIComponent).join('/')

export const paths = {
  home: '/',
  search: (q: string) => (q ? `/?${new URLSearchParams({ q })}` : '/'),
  mine: ({ status }: { status?: 'problem' } = {}) => withSearch('/mine', { status }),
  drafts: () => '/-/drafts',
  directory: '/company',
  directorySearch: (q: string) => withSearch('/company', { q }),
  account: () => '/-/account',
  help: '/help',
  adminPlatform: '/-/admin/platform',
  new: ({ group, resume, template, intent }: NewAppSearch = {}) => withSearch('/new', { group, resume, template, intent }),
  excel2app: (draft?: string) => withSearch('/-/excel2app', { draft }),
  build: (draftId: string) => `/-/build/${encodeURIComponent(draftId)}`,
  improve: (draftId: string) => `/-/improve/${encodeURIComponent(draftId)}`,
  proposal: (id: string) => `/-/proposals/${encodeURIComponent(id)}`,
  proposals: (applicationId?: string) => withSearch('/-/proposals', { applicationId }),
  group: (path: string, tab: GroupTab = 'front') => `/${encodePath(path)}${tab === 'front' ? '' : `/-/${tab}`}`,
  app: (groupPath: string, slug: string, tab: AppTab = 'overview') =>
    `/${encodePath(groupPath)}/${encodeURIComponent(slug)}${tab === 'overview' ? '' : `/-/${tab}`}`,
  appData: (groupPath: string, slug: string, { table, q, row }: AppDataSearch = {}) =>
    withSearch(`/${encodePath(groupPath)}/${encodeURIComponent(slug)}/-/data`, { table, q, row }),
  appById: (appId: string) => `/-/apps/${encodeURIComponent(appId)}`,
  /** A maker's page: who they are and the apps they own. */
  person: (personId: string) => `/-/people/${encodeURIComponent(personId)}`,
  requestAccess: (appName: string, reason?: string): string =>
    withSearch(`/-/request-access/${encodeURIComponent(appName)}`, { reason }),
}
