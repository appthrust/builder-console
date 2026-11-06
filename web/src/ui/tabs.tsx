import type { ReactNode } from 'react'
import { cn } from './cn'
import { HrefLink } from './link'

export type LinkTab = { id: string; label: ReactNode; href: string }

/** URL-driven tab strip: every tab is its own page URL (`/<path>/-/<tab>`), so these are links, not Radix tabs. */
export function LinkTabs({ label, tabs, current }: { label: string; tabs: LinkTab[]; current: string }) {
  return (
    <nav aria-label={label} className="-mx-4 mb-6 border-b border-stone-200 px-4 sm:mx-0 sm:px-0">
      <ul className="-mb-px flex gap-1 overflow-x-auto [scrollbar-width:none]">
        {tabs.map((tab) => {
          const active = tab.id === current
          return (
            <li key={tab.id} className="shrink-0">
              <HrefLink
                href={tab.href}
                className={cn(
                  'inline-flex h-10 items-center border-b-2 px-3 text-sm whitespace-nowrap transition-colors',
                  active ? 'border-accent font-medium text-stone-900' : 'border-transparent text-stone-500 hover:border-stone-300 hover:text-stone-800'
                )}
              >
                {tab.label}
              </HrefLink>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
