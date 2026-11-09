// Page frame (ux-design §7.1): 240px fixed left nav from md up, foldable to a
// 56px icon rail (the fold toggle lives in the nav itself; the choice
// persists), a drawer below 768px, and a top bar with the 所属 switcher, the
// single primary action (＋ 新しいアプリ) and the user menu. The AI build and
// improve sessions are workspaces, not pages: they get a viewport-height frame with no
// page scroll or padding and scroll their own panes (features/build/build-page.tsx).
import { AppSwitcher } from '@appthrust/app-launcher'
import { useMatches, useMatchRoute, useRouterState } from '@tanstack/react-router'
import { useSelector } from '@tanstack/react-store'
import { Check, ChevronDown, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Settings, UserRound, X } from 'lucide-react'
import { Dialog as RDialog, Popover } from 'radix-ui'
import { useEffect, type ReactNode } from 'react'
import { useMe } from '../api/queries'
import { copy } from '../copy'
import { paths } from '../routes/paths'
import {
  Avatar,
  buttonClasses,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  HrefLink,
  LinkButton,
  PersonLink,
  useReturnFocus,
} from '../ui'
import { useLanguage } from './language'
import { Nav, RailNav } from './nav'
import { setNavCollapsed, setNavOpen, shellStore } from './store'
import { useShell } from './use-shell'

export function Shell({ children }: { children: ReactNode }) {
  const { data: me } = useMe()
  const navOpen = useSelector(shellStore, (state) => state.navOpen)
  const navCollapsed = useSelector(shellStore, (state) => state.navCollapsed)
  const location = useRouterState({ select: (state) => state.location.href })
  const drawerFocus = useReturnFocus(navOpen)
  const matchRoute = useMatchRoute()
  const workspace = Boolean(matchRoute({ to: '/-/build/$draftId' }) || matchRoute({ to: '/-/improve/$draftId' }))
  const account = Boolean(matchRoute({ to: '/-/account' }))
  const headerOnly = useMatches().some((match) => match.staticData.memberGate === false)

  // The drawer closes on every navigation (a nav link was followed).
  useEffect(() => setNavOpen(false), [location])

  if (headerOnly || me.notMember) {
    return (
      <div className="flex min-h-dvh flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-white pr-3 sm:pr-6">
          <Brand />
          <UserMenu />
        </header>
        <main id="main" tabIndex={-1} className="flex flex-1 items-center justify-center px-6 py-12 focus:outline-none">
          {headerOnly || account ? children : (
            <div className="max-w-xl text-center">
              <h1 className="text-xl font-semibold text-stone-900">{copy.topbar.notMemberTitle}</h1>
              <p className="mt-3 break-words text-sm leading-relaxed text-stone-600">{copy.topbar.notMemberBody}</p>
            </div>
          )}
        </main>
      </div>
    )
  }

  return (
    <div className={cn(workspace ? 'flex h-dvh flex-col' : 'min-h-dvh', navCollapsed ? 'md:pl-14' : 'md:pl-60')}>
      <a
        href="#main"
        className="sr-only z-50 min-h-10 content-center rounded-md bg-white px-3 py-2 text-sm font-medium shadow focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {copy.nav.skip}
      </a>

      <aside id="desktop-nav" className={cn('fixed inset-y-0 left-0 z-20 hidden flex-col overflow-x-hidden overflow-y-auto border-r border-line bg-white md:flex', navCollapsed ? 'w-14' : 'w-60')}>
        {navCollapsed ? (
          <>
            <HrefLink href="/" aria-label={copy.product} title={copy.product} className="flex h-14 shrink-0 items-center justify-center">
              <span aria-hidden className="grid size-6 place-items-center rounded-md bg-accent text-xs font-bold text-white">{copy.productMark}</span>
            </HrefLink>
            <div className="flex justify-center px-2"><FoldToggle collapsed /></div>
            <RailNav />
          </>
        ) : (
          <>
            <div className="flex items-center pr-2">
              <Brand />
              <FoldToggle collapsed={false} />
            </div>
            <Nav />
          </>
        )}
      </aside>

      <RDialog.Root open={navOpen} onOpenChange={setNavOpen}>
        <RDialog.Portal>
          <RDialog.Overlay className="fixed inset-0 z-40 bg-stone-900/40 animate-fade-in md:hidden" />
          <RDialog.Content {...drawerFocus} className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col overflow-y-auto bg-white shadow-xl animate-slide-in-left focus:outline-none md:hidden">
            <RDialog.Title className="sr-only">{copy.nav.label}</RDialog.Title>
            <RDialog.Description className="sr-only">{copy.product}</RDialog.Description>
            <div className="flex items-center justify-between pr-2">
              <Brand />
              <RDialog.Close
                aria-label={copy.nav.closeMenu}
                className="flex size-10 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 hover:text-stone-800"
              >
                <X aria-hidden className="size-5" />
              </RDialog.Close>
            </div>
            <Nav />
          </RDialog.Content>
        </RDialog.Portal>
      </RDialog.Root>

      <TopBar />
      <main id="main" tabIndex={-1} className={workspace ? 'relative flex min-h-0 w-full flex-1 flex-col overflow-hidden focus:outline-none' : 'mx-auto w-full max-w-6xl px-4 py-6 focus:outline-none sm:px-6 md:px-8 md:py-8'}>
        {children}
      </main>
    </div>
  )
}

/** Folds the desktop nav to the rail or opens it again; sits inside the nav so it leaves with it. */
function FoldToggle({ collapsed }: { collapsed: boolean }) {
  const label = collapsed ? copy.nav.expandNav : copy.nav.collapseNav
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={!collapsed}
      aria-controls="desktop-nav"
      title={label}
      onClick={() => setNavCollapsed(!collapsed)}
      className={cn('flex shrink-0 items-center justify-center rounded-md text-stone-400 hover:bg-stone-100 hover:text-stone-900', collapsed ? 'size-10' : 'ml-auto size-8')}
    >
      {collapsed ? <PanelLeftOpen aria-hidden className="size-5" /> : <PanelLeftClose aria-hidden className="size-4" />}
    </button>
  )
}

function Brand() {
  return (
    <HrefLink href="/" className="flex h-14 shrink-0 items-center gap-2.5 px-5 text-[15px] font-semibold tracking-tight text-stone-900">
      <span aria-hidden className="grid size-6 place-items-center rounded-md bg-accent text-xs font-bold text-white">
        {copy.productMark}
      </span>
      {copy.product}
    </HrefLink>
  )
}

function TopBar() {
  const { me, currentGroup, membershipGroup, viewingOtherGroup, homeGroups, setMembershipGroup } = useShell()
  const language = useLanguage()
  const matchRoute = useMatchRoute()
  const onCreate = Boolean(matchRoute({ to: '/new' }))
  const contextName = currentGroup?.name ?? copy.topbar.noContext
  const contextLabel = viewingOtherGroup ? copy.topbar.viewing : copy.topbar.context

  return (
    <header className="sticky top-0 z-10 border-b border-line bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/80">
      <div className="flex h-14 items-center gap-1.5 px-3 sm:gap-2 sm:px-6 md:px-8">
        <button
          type="button"
          aria-label={copy.nav.openMenu}
          onClick={() => setNavOpen(true)}
          className="flex size-10 shrink-0 items-center justify-center rounded-md text-stone-700 hover:bg-stone-100 md:hidden"
        >
          <Menu aria-hidden className="size-5" />
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`${copy.topbar.switchContext}（${contextLabel}: ${contextName}）`}
            className="flex min-h-10 min-w-0 items-center gap-1 rounded-md px-1.5 py-1.5 text-sm hover:bg-stone-100 data-[state=open]:bg-stone-100 md:min-h-0 sm:px-2"
          >
            <span className="shrink-0 text-xs text-stone-500">{contextLabel}:</span>
            <span className="truncate font-medium text-stone-900">{contextName}</span>
            <ChevronDown aria-hidden className="size-4 shrink-0 text-stone-400" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel>{copy.topbar.switchContext}</DropdownMenuLabel>
            {homeGroups.length > 0 ? (
              homeGroups.map((group) => {
                const selected = group.id === membershipGroup?.id
                return (
                  <DropdownMenuItem key={group.id} asChild onSelect={() => setMembershipGroup(group.id)}>
                    <HrefLink href={paths.group(group.path)} title={group.path}>
                      <span className="min-w-0 flex-1 truncate font-medium text-stone-900">{group.name}</span>
                      {selected ? <><Check aria-hidden className="text-accent!" /><span className="sr-only">{copy.topbar.selectedMembership}</span></> : null}
                    </HrefLink>
                  </DropdownMenuItem>
                )
              })
            ) : (
              <p className="px-2.5 py-2 text-sm text-stone-500">{copy.home.noMembership}</p>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          {me.platformUnavailable ? (
            <p role="status" className="hidden text-xs text-stone-500 lg:block">
              {copy.topbar.platformUnavailable}
            </p>
          ) : null}
          {onCreate ? null : <CreateButton groupPath={currentGroup?.path} />}
          <AppSwitcher language={language} />
          <UserMenu />
        </div>
      </div>
    </header>
  )
}

function CreateButton({ groupPath }: { groupPath: string | undefined }) {
  const { me } = useShell()
  if (me.canCreateApps) {
    return (
      <LinkButton href={paths.new({ group: groupPath })} tone="primary">
        {copy.nav.create}
      </LinkButton>
    )
  }
  // Not a creator: keep the entry visible but explain who to ask (ux-design §7.1).
  const title = me.platformUnavailable ? copy.topbar.platformUnavailable : copy.topbar.cannotCreateTitle
  const body = me.platformUnavailable ? copy.topbar.platformUnavailableBody : copy.topbar.cannotCreateBody
  return (
    <Popover.Root>
      <Popover.Trigger aria-label={`${copy.nav.create}（${title}）`} className={buttonClasses('secondary', 'md', 'text-stone-500')}>
        {copy.nav.create}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 w-72 rounded-lg border border-line bg-white p-4 shadow-lg animate-pop-in"
        >
          <p className="text-sm font-medium text-stone-900">{title}</p>
          <p className="mt-1 text-sm text-stone-600">{body}</p>
          <HrefLink href="/help" className="mt-3 inline-flex min-h-10 items-center text-sm font-medium text-accent-strong hover:underline md:min-h-0">
            {copy.nav.help}
          </HrefLink>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function UserMenu() {
  const { data: me } = useMe()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={copy.topbar.userMenu}
        className="flex min-h-10 min-w-10 items-center gap-2 rounded-full py-1 pr-1 pl-1 text-sm text-stone-700 hover:bg-stone-100 data-[state=open]:bg-stone-100 md:min-h-0 sm:rounded-md sm:pr-2"
      >
        <Avatar person={me.person} />
        <span className="hidden max-w-32 truncate sm:inline">{me.person.displayName}</span>
        <ChevronDown aria-hidden className="hidden size-4 text-stone-400 sm:block" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <div className="px-2.5 py-2">
          <p className="truncate text-sm font-medium text-stone-900">{me.person.displayName}</p>
          <p className="truncate text-xs text-stone-500">{me.person.email}</p>
        </div>
        {me.platformUnavailable ? <p className="px-2.5 pb-2 text-xs text-stone-500 lg:hidden">{copy.topbar.platformUnavailable}</p> : null}
        <DropdownMenuSeparator />
        {me.notMember ? null : (
          <DropdownMenuItem asChild>
            <PersonLink personId={me.person.id}>
              <UserRound aria-hidden />
              {copy.topbar.profile}
            </PersonLink>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <HrefLink href={paths.account()}>
            <Settings aria-hidden />
            {copy.nav.account}
          </HrefLink>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Envoy's OIDC edge owns /logout: a full navigation, never a router link or fetch. */}
        <DropdownMenuItem asChild>
          <a href="/logout">
            <LogOut aria-hidden />
            {copy.nav.logout}
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
