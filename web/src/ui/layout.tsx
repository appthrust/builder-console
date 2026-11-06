import { ChevronRight } from 'lucide-react'
import { Fragment, useId, type ReactNode } from 'react'
import { copy } from '../copy'
import { cn } from './cn'
import { HrefLink } from './link'

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-lg border border-line bg-surface', className)}>{children}</div>
}

export function CardHeader({ title, lead, actions }: { title: ReactNode; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-100 px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-stone-900">{title}</h2>
        {lead ? <p className="mt-0.5 text-sm text-stone-500">{lead}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('px-5 py-4', className)}>{children}</div>
}

export type Breadcrumb = { label: string; href: string }

/**
 * Screen title, optional lead, right-aligned actions and breadcrumbs above. `media` sits left of the title,
 * outside the heading (a profile picture that may be a button). `children` renders under the title row (tabs, meta).
 */
export function PageHeader({
  title,
  lead,
  actions,
  breadcrumbs,
  media,
  children,
}: {
  title: ReactNode
  lead?: ReactNode
  actions?: ReactNode
  breadcrumbs?: Breadcrumb[]
  media?: ReactNode
  children?: ReactNode
}) {
  return (
    <header className="mb-6 sm:mb-8">
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label={copy.common.breadcrumbs} className="mb-2">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-stone-500">
            {breadcrumbs.map((crumb, index) => (
              <Fragment key={crumb.href}>
                {index > 0 ? (
                  <li aria-hidden>
                    <ChevronRight className="size-3.5 text-stone-400" />
                  </li>
                ) : null}
                <li className="min-w-0">
                  <HrefLink href={crumb.href} className="block min-h-10 max-w-48 content-center truncate rounded hover:text-stone-900 hover:underline md:min-h-0">
                    {crumb.label}
                  </HrefLink>
                </li>
              </Fragment>
            ))}
          </ol>
        </nav>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-x-4">
        <div className={cn('min-w-0 sm:flex-1', media ? 'flex items-center gap-4' : undefined)}>
          {media ? <div className="shrink-0">{media}</div> : null}
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight text-stone-900 sm:text-2xl">{title}</h1>
            {lead ? <p className="mt-1.5 max-w-prose text-sm text-stone-500">{lead}</p> : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </header>
  )
}

/** A titled block inside a page; sections are separated by whitespace, not boxes. */
export function Section({
  title,
  lead,
  actions,
  id,
  className,
  children,
}: {
  title: ReactNode
  lead?: ReactNode
  actions?: ReactNode
  id?: string
  className?: string
  children: ReactNode
}) {
  const generated = useId()
  const headingId = id ?? generated
  return (
    <section aria-labelledby={headingId} className={cn('mt-8 first:mt-0', className)}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id={headingId} className="text-base font-semibold text-stone-900">
            {title}
          </h2>
          {lead ? <p className="mt-0.5 text-sm text-stone-500">{lead}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}
