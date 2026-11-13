import { isUnknownPerson, type BusinessApp, type DirectoryEntry } from '../../model/contracts/console'

type SearchableApp = Pick<BusinessApp, 'displayName' | 'description' | 'group' | 'tags' | 'capabilities' | 'owners'>

/** Match only authorized apps already returned by scope=all; owner names are not an API filter. */
export function matchesAppSearch(app: BusinessApp, query: string): boolean {
  return matchesSearch(app, app.slug, query)
}

/** Directory entries deliberately contain neither the guide nor the sharing policy. */
export function matchesDirectoryEntrySearch(entry: DirectoryEntry, query: string): boolean {
  return matchesSearch(entry, entry.path, query)
}

function matchesSearch(app: SearchableApp, path: string, query: string): boolean {
  const words = query.normalize('NFKC').toLocaleLowerCase('ja').trim().split(/\s+/).filter(Boolean)
  const searchable = [app.displayName, app.description, path, app.group.name, app.group.path, ...app.tags,
    ...app.capabilities, ...app.owners.flatMap((owner) => (isUnknownPerson(owner) ? [] : [owner.displayName, owner.email]))]
    .join('\n').normalize('NFKC').toLocaleLowerCase('ja')
  return words.every((word) => searchable.includes(word))
}
