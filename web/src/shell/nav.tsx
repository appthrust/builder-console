// Left navigation (ux-design §7.1): fixed items, the group tree under
// 組織のアプリ, the Directory link (groups and people are managed there) and
// the console admin item. `RailNav` is the folded form: the fixed items as icons
// with their names as tooltips, badges reduced to a dot; the group tree needs the full width.
import { Building2, ChevronRight, CircleHelp, Globe, House, PencilLine, Settings2, UserRound, UsersRound } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { buildGroupTree, pathPrefixes, type GroupNode } from '../model/contracts/console'
import { directoryLinks } from '../api/console'
import { useApps } from '../api/queries/console'
import { copy } from '../copy'
import { useAppViews } from '../features/app/use-app-views'
import { useUnfinished } from '../features/discover/drafts'
import { paths } from '../routes/paths'
import { cn, Collapsible, CollapsibleContent, CollapsibleTrigger, HrefLink } from '../ui'
import { useShell } from './use-shell'

const itemClasses =
  'flex h-10 items-center gap-2.5 rounded-md px-2.5 text-sm whitespace-nowrap text-stone-600 transition-colors md:h-9 hover:bg-stone-100 hover:text-stone-900 data-[status=active]:bg-accent-soft data-[status=active]:font-medium data-[status=active]:text-accent-strong [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-stone-400 data-[status=active]:[&>svg]:text-accent'


/** Number of the caller's own apps whose status is 問題あり (same derivation as the app lists). */
function useProblemCount(projectId: string): number {
  const mine = useApps({ scope: 'mine' })
  const views = useAppViews(projectId)
  if (views.loading || !mine.data) return 0
  return mine.data.filter((app) => views.viewFor(app).status === 'failed').length
}

function ProblemBadge({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <HrefLink
      href={paths.mine({ status: 'problem' })}
      aria-label={copy.nav.problemsLabel(count)}
      className="ml-auto inline-flex min-h-10 shrink-0 items-center gap-1 rounded-md bg-bad-soft px-2 text-[11px] font-medium whitespace-nowrap text-bad-ink ring-1 ring-red-200 ring-inset md:min-h-0 md:rounded-full md:py-0.5"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-bad" />
      {copy.nav.problems(count)}
    </HrefLink>
  )
}

const railItemClasses =
  'relative flex size-10 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900 data-[status=active]:bg-accent-soft data-[status=active]:text-accent-strong [&>svg]:size-5'

export function RailNav() {
  const { me } = useShell()
  const problems = useProblemCount(me.projectId)
  const unfinished = useUnfinished(me, { poll: false }).items.length
  const item = (href: string, label: string, icon: ReactNode, dot?: 'bad' | 'count') => (
    <HrefLink href={href} aria-label={label} title={label} className={railItemClasses}>
      {icon}
      {dot ? <span aria-hidden className={cn('absolute top-2 right-2 size-1.5 rounded-full', dot === 'bad' ? 'bg-bad' : 'bg-stone-400')} /> : null}
    </HrefLink>
  )
  return (
    <nav aria-label={copy.nav.label} className="flex flex-col items-center gap-px px-2 py-2">
      {item(paths.home, copy.nav.home, <House aria-hidden />)}
      {item(paths.mine(), problems > 0 ? copy.nav.problemsLabel(problems) : copy.nav.mine, <UserRound aria-hidden />, problems > 0 ? 'bad' : undefined)}
      {item(paths.drafts(), unfinished > 0 ? copy.nav.draftsLabel(unfinished) : copy.nav.drafts, <PencilLine aria-hidden />, unfinished > 0 ? 'count' : undefined)}
      {item(paths.directory, copy.nav.directory, <Globe aria-hidden />)}
      <hr className="my-2 w-6 border-stone-200" />
      {me.directoryPublicURL ? (
        <a href={directoryLinks.groups(me.directoryPublicURL)} target="_blank" rel="noreferrer noopener" aria-label={copy.nav.people} title={copy.nav.people} className={railItemClasses}>
          <UsersRound aria-hidden />
        </a>
      ) : null}
      {me.isConsoleAdmin ? item(paths.adminPlatform, copy.nav.platform, <Settings2 aria-hidden />) : null}
      {item(paths.help, copy.nav.help, <CircleHelp aria-hidden />)}
    </nav>
  )
}

export function Nav() {
  const { me, groups, homeGroups, pageGroupPath } = useShell()
  const problems = useProblemCount(me.projectId)
  const unfinished = useUnfinished(me, { poll: false }).items.length
  const tree = useMemo(() => buildGroupTree(groups), [groups])

  // Open the caller's membership paths by default, plus the page's own path.
  const [open, setOpen] = useState<Set<string>>(() => {
    const byPath = new Map(groups.map((group) => [group.path, group.id]))
    const ids = new Set<string>()
    for (const group of homeGroups) {
      for (const prefix of pathPrefixes(group.path).slice(0, -1)) {
        const id = byPath.get(prefix)
        if (id) ids.add(id)
      }
    }
    return ids
  })
  // A page inside a collapsed subtree reveals its ancestors; derived during render, not in an effect.
  const [revealedPath, setRevealedPath] = useState(pageGroupPath)
  if (revealedPath !== pageGroupPath) {
    setRevealedPath(pageGroupPath)
    if (pageGroupPath) {
      const ancestors = pathPrefixes(pageGroupPath)
        .slice(0, -1)
        .map((prefix) => groups.find((group) => group.path === prefix)?.id)
        .filter((id): id is string => Boolean(id))
      if (!ancestors.every((id) => open.has(id))) setOpen(new Set([...open, ...ancestors]))
    }
  }

  const toggle = (id: string, next: boolean) =>
    setOpen((previous) => {
      const updated = new Set(previous)
      if (next) updated.add(id)
      else updated.delete(id)
      return updated
    })

  const renderNodes = (nodes: GroupNode[]): ReactNode => (
    <ul className="space-y-px">
      {nodes.map((node) => {
        const expanded = open.has(node.id)
        const active = pageGroupPath === node.path
        const row = (
          <div className="flex items-center gap-0.5" style={{ paddingLeft: `${node.depth * 0.875}rem` }}>
            {node.children.length > 0 ? (
              <CollapsibleTrigger
                aria-label={expanded ? copy.nav.collapse(node.name) : copy.nav.expand(node.name)}
                className="flex size-10 shrink-0 items-center justify-center rounded-md text-stone-400 hover:bg-stone-100 hover:text-stone-700 md:size-7"
              >
                <ChevronRight aria-hidden className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
              </CollapsibleTrigger>
            ) : (
              <span aria-hidden className="size-10 shrink-0 md:size-7" />
            )}
            <HrefLink
              href={paths.group(node.path)}
              title={node.path}
              className={cn(
                'flex h-10 min-w-0 flex-1 items-center truncate rounded-md px-2 text-sm transition-colors md:h-8',
                active ? 'bg-accent-soft font-medium text-accent-strong' : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900'
              )}
            >
              <span className="truncate">{node.name}</span>
            </HrefLink>
          </div>
        )
        return (
          <li key={node.id}>
            {node.children.length > 0 ? (
              <Collapsible open={expanded} onOpenChange={(next) => toggle(node.id, next)}>
                {row}
                <CollapsibleContent>{renderNodes(node.children)}</CollapsibleContent>
              </Collapsible>
            ) : (
              row
            )}
          </li>
        )
      })}
    </ul>
  )

  return (
    <nav aria-label={copy.nav.label} className="flex flex-col gap-px px-3 py-4">
      <HrefLink href={paths.home} className={itemClasses}>
        <House aria-hidden />
        {copy.nav.home}
      </HrefLink>
      <div className="flex items-center gap-1">
        <HrefLink href={paths.mine()} className={cn(itemClasses, 'min-w-0 flex-1 pr-2')} title={copy.nav.mine}>
          <UserRound aria-hidden />
          <span className="truncate">{copy.nav.mine}</span>
        </HrefLink>
        <ProblemBadge count={problems} />
      </div>
      <HrefLink href={paths.drafts()} className={itemClasses} aria-label={unfinished > 0 ? copy.nav.draftsLabel(unfinished) : undefined}>
        <PencilLine aria-hidden />
        {copy.nav.drafts}
        {unfinished > 0 ? <span aria-hidden className="ml-auto rounded-full bg-stone-100 px-1.5 text-[11px] font-medium tabular-nums text-stone-600">{unfinished}</span> : null}
      </HrefLink>

      <p className="mt-5 mb-1 flex items-center gap-2.5 px-2.5 text-xs font-medium text-stone-500">
        <Building2 aria-hidden className="size-4 text-stone-400" />
        {copy.nav.groups}
      </p>
      {tree.length > 0 ? renderNodes(tree) : <p className="px-2.5 py-1 text-xs text-stone-400">{copy.nav.noGroups}</p>}

      <div className="mt-4">
        <HrefLink href={paths.directory} className={itemClasses}>
          <Globe aria-hidden />
          {copy.nav.directory}
        </HrefLink>
      </div>

      <hr className="mx-2.5 my-4 border-stone-200" />
      {me.directoryPublicURL ? (
        <a href={directoryLinks.groups(me.directoryPublicURL)} target="_blank" rel="noreferrer noopener" className={itemClasses}>
          <UsersRound aria-hidden />
          {copy.nav.people}
        </a>
      ) : null}
      {me.isConsoleAdmin ? (
        <HrefLink href={paths.adminPlatform} className={itemClasses}>
          <Settings2 aria-hidden />
          {copy.nav.platform}
        </HrefLink>
      ) : null}
      <HrefLink href={paths.help} className={itemClasses}>
        <CircleHelp aria-hidden />
        {copy.nav.help}
      </HrefLink>
    </nav>
  )
}
