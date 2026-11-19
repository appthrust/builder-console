import { useLocation } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { copy } from '../../copy'
import { Collapsible, CollapsibleContent, CollapsibleTrigger, PageHeader, useDocumentTitle } from '../../ui'
import { useConsoleView } from '../inbox'
import { text } from './copy'

type Article = (typeof copy.help.articles)[number]

/**
 * Four short articles in the order of the caller's view (role-based-views
 * ux-design §6.9). A `#id` link to an article of the other view (e.g.
 * `/help#share`) still opens it, after the four.
 */
export function HelpPage() {
  useDocumentTitle(copy.help.title)
  const view = useConsoleView()
  const hash = useLocation({ select: (location) => location.hash })
  const ids = copy.help.order[view]
  const articles = copy.help.articles
    .filter((article) => ids.includes(article.id) || article.id === hash)
    .sort((a, b) => (ids.indexOf(a.id) + 1 || Infinity) - (ids.indexOf(b.id) + 1 || Infinity))
  const target = articles.find((article) => article.id === hash)
  const [open, setOpen] = useState<Partial<Record<Article['id'], boolean>>>(() => ({ [target?.id ?? articles[0].id]: true }))

  // `#share` arriving while mounted (in-page link) opens that article; scrolling is a DOM effect.
  const [followedHash, setFollowedHash] = useState(hash)
  if (followedHash !== hash) {
    setFollowedHash(hash)
    if (target) setOpen((current) => ({ ...current, [target.id]: true }))
  }
  useEffect(() => {
    if (target) document.getElementById(target.id)?.scrollIntoView({ block: 'start' })
  }, [target])

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title={copy.help.title} lead={text.help.lead} />
      <div className="space-y-3">
        {articles.map((article, index) => (
          <Collapsible
            key={article.id}
            open={open[article.id] ?? false}
            onOpenChange={(next) => setOpen((current) => ({ ...current, [article.id]: next }))}
            asChild
          >
            <article id={article.id} className="scroll-mt-24 overflow-hidden rounded-lg border border-stone-200 bg-white">
              <h2 className="text-base font-semibold text-stone-900">
                <CollapsibleTrigger className="group flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-stone-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent">
                  <span
                    aria-hidden
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent-strong"
                  >
                    {index + 1}
                  </span>
                  <span className="flex-1">{article.title}</span>
                  <ChevronDown aria-hidden className="size-4 text-stone-400 transition-transform group-data-[state=open]:rotate-180" />
                </CollapsibleTrigger>
              </h2>
              <CollapsibleContent>
                <ul className="space-y-2 border-t border-stone-100 px-5 py-4 pl-16 text-sm leading-relaxed text-stone-700">
                  {article.body.map((line) => (
                    <li key={line} className="list-disc marker:text-stone-300">
                      {line}
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </article>
          </Collapsible>
        ))}
      </div>
    </div>
  )
}
