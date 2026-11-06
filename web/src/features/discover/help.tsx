import { useLocation } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { copy } from '../../copy'
import { Collapsible, CollapsibleContent, CollapsibleTrigger, PageHeader, useDocumentTitle } from '../../ui'
import { text } from './copy'

type ArticleId = (typeof copy.help.articles)[number]['id']

/** Three short articles (ux-design §7.1 ヘルプ). `/help#share` opens 公開範囲とは. */
export function HelpPage() {
  useDocumentTitle(copy.help.title)
  const hash = useLocation({ select: (location) => location.hash })
  const [open, setOpen] = useState<Partial<Record<ArticleId, boolean>>>(() => ({
    [copy.help.articles.some((article) => article.id === hash) ? (hash as ArticleId) : copy.help.articles[0].id]: true,
  }))

  // `#share` arriving while mounted (in-page link) opens that article; scrolling is a DOM effect.
  const [followedHash, setFollowedHash] = useState(hash)
  const target = copy.help.articles.find((article) => article.id === hash)
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
        {copy.help.articles.map((article, index) => (
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
