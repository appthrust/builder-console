// 作ったコードから: pick one of the repositories the GitHub 連携 can see.
import { Lock, Search } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useGitHubRepositories } from '../../../api/queries'
import { copy } from '../../../copy'
import type { PickedRepository } from '../../../model/create'
import { Button, Field, LoadFailed, Skeleton, TextInput } from '../../../ui'

const SEARCH_DEBOUNCE_MS = 300
const PICKER_ROWS = 8

export function RepositoryPicker({
  projectId,
  connectionId,
  selected,
  onSelect,
  error,
}: {
  projectId: string
  connectionId: string | undefined
  selected: PickedRepository | undefined
  onSelect: (repository: PickedRepository | undefined) => void
  error?: string
}) {
  const [term, setTerm] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setQuery(term), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [term])
  const repositories = useGitHubRepositories(projectId, selected ? undefined : connectionId, query)
  const allRows = repositories.data?.data ?? []
  const rows = allRows.slice(0, PICKER_ROWS)
  const listId = useId()

  return (
    <Field id="create-repository" label={copy.create.existing.repository} hint={copy.create.existing.repositoryHint} error={error}>
      {selected ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-md border border-accent bg-accent-soft px-3 py-2"
          data-testid="picked-repository"
        >
          <span className="sr-only">{copy.create.existing.selected}: </span>
          <span className="min-w-0 font-mono text-sm break-all text-stone-900">{selected.fullName}</span>
          <Button tone="ghost" size="sm" className="ml-auto" onClick={() => onSelect(undefined)}>
            {copy.create.existing.change}
          </Button>
        </div>
      ) : (
        <div className="max-w-xl">
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
            <TextInput
              id="create-repository"
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              onKeyDown={(event) => {
                // Enter picks the only match instead of moving on without a repository.
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                if (rows.length === 1) onSelect({ fullName: rows[0]!.fullName, defaultBranch: rows[0]!.defaultBranch })
              }}
              placeholder={copy.create.existing.search}
              aria-controls={listId}
              invalid={Boolean(error)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              className="pl-9"
            />
          </div>
          <div className="mt-2" aria-live="polite">
            {repositories.isError ? (
              <LoadFailed onRetry={() => void repositories.refetch()} error={repositories.error} />
            ) : repositories.isPending || (repositories.isFetching && rows.length === 0) ? (
              <div className="space-y-1.5" aria-label={copy.create.existing.loading}>
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
              </div>
            ) : rows.length === 0 ? (
              <p className="text-sm text-stone-500">{copy.create.existing.empty}</p>
            ) : null}
          </div>
          {rows.length > 0 ? (
            <ul
              id={listId}
              className="divide-y divide-stone-100 overflow-hidden rounded-md border border-stone-200 bg-white"
              data-testid="repository-options"
            >
              {rows.map((repository) => (
                <li key={repository.fullName}>
                  <button
                    type="button"
                    onClick={() => onSelect({ fullName: repository.fullName, defaultBranch: repository.defaultBranch })}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-stone-50 focus-visible:bg-stone-50 focus-visible:outline-offset-[-2px]"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-sm text-stone-900">{repository.fullName}</span>
                    {repository.private ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600">
                        <Lock aria-hidden className="size-3" />
                        {copy.create.existing.private}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {allRows.length > PICKER_ROWS ? (
            <p className="mt-2 text-xs text-stone-500" role="status">{copy.create.existing.more(allRows.length - PICKER_ROWS)}</p>
          ) : null}
        </div>
      )}
    </Field>
  )
}
