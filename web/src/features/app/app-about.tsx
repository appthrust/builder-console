import { Check } from 'lucide-react'
import { copy } from '../../copy'
import { HrefLink, Section } from '../../ui'
import { text } from './copy'

/** 「このアプリについて」: the one-liner, every capability and the tags; shared by the entry page and 概要. */
export function AppAbout({ description, capabilities, tags }: { description: string; capabilities: string[]; tags: string[] }) {
  return (
    <Section title={text.overview.about}>
      <div className="space-y-4">
        {description ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-stone-800">{description}</p>
        ) : (
          <p className="text-sm text-stone-500">{copy.app.overview.noDescription}</p>
        )}
        {capabilities.length > 0 ? (
          <div>
            <h3 className="text-sm font-medium text-stone-900">{text.app.capabilities}</h3>
            <ul className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {capabilities.map((capability, index) => (
                <li key={index} className="flex min-w-0 items-start gap-2 text-sm leading-relaxed text-stone-700">
                  <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
                  <span className="min-w-0 break-words">{capability}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {tags.length > 0 ? (
          <ul aria-label={copy.app.overview.tags} className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <li key={tag} className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs text-stone-700">{tag}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </Section>
  )
}

const EXCERPT_LENGTH = 140

/** The guide's opening words as plain text: headings, fences and tables skipped, list and link marks removed. */
export function guideExcerpt(markdown: string, max = EXCERPT_LENGTH): string {
  const plain = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^(#{1,6}\s|```|~~~|---|\*\*\*|\||>)/.test(line))
    .map((line) => line
      .replace(/^([-*+]|\d+[.)])\s+/, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .trim())
    .filter(Boolean)
    .join(' ')
  const characters = Array.from(plain)
  return characters.length > max ? `${characters.slice(0, max).join('')}…` : plain
}

/** 概要 only: a taste of つかいかた with the way to the full guide. */
export function GuideSummary({ guide, href, canEdit }: { guide: string; href: string; canEdit: boolean }) {
  const excerpt = guideExcerpt(guide)
  return (
    <Section
      title={copy.app.tabs.guide}
      actions={<HrefLink href={href} className="inline-flex min-h-10 items-center text-sm font-medium text-accent-strong hover:underline">{text.app.guideLink}</HrefLink>}
    >
      {excerpt ? (
        <p className="break-words text-sm leading-relaxed text-stone-700">{excerpt}</p>
      ) : (
        <p className="text-sm text-stone-500">{canEdit ? text.app.guideEmptyOwner : text.app.guideEmpty}</p>
      )}
    </Section>
  )
}
