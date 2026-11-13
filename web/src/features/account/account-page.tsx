import { ExternalLink } from 'lucide-react'
import { directoryLinks } from '../../api/console'
import { useMe } from '../../api/queries/console'
import { copy } from '../../copy'
import { LANGUAGES, setLanguage, useLanguage } from '../../shell/language'
import { LinkButton, PageHeader, RadioCards, Section, useDocumentTitle } from '../../ui'

export function AccountPage() {
  const { data: me } = useMe()
  const language = useLanguage()
  useDocumentTitle(copy.account.title)

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader title={copy.account.title} />
      <Section title={copy.account.profile}>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-stone-500">{copy.account.name}</dt>
          <dd className="mb-2 break-words text-stone-900 sm:mb-0">{me.person.displayName}</dd>
          <dt className="text-stone-500">{copy.account.email}</dt>
          <dd className="break-all text-stone-900">{me.person.email}</dd>
        </dl>
        {me.directoryPublicURL ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-stone-100 pt-4">
            <p className="text-sm text-stone-600">{copy.account.directoryProfile}</p>
            <LinkButton href={directoryLinks.you(me.directoryPublicURL)} external size="sm" icon={<ExternalLink />}>
              {copy.account.openDirectoryProfile}
            </LinkButton>
          </div>
        ) : null}
      </Section>
      <section aria-labelledby="account-language-legend" className="mt-8">
        <RadioCards
          name="account-language"
          legend={copy.language.label}
          options={LANGUAGES.map((option) => ({
            value: option,
            title: <span lang={option}>{copy.language.names[option]}</span>,
          }))}
          value={language}
          onChange={setLanguage}
          columns={2}
        />
        <p className="mt-3 text-sm text-stone-500">{copy.account.languageSaved}</p>
      </section>
    </div>
  )
}
