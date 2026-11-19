// Test seam: create / catalog domain values made from wire fixtures by the
// production readers, never by casting a literal to a domain type. A fixture
// the reader rejects fails the test that uses it.
import type { z } from 'zod'
import type {
  PublishDomain,
  RegistryConnection,
  RepositoryDestination,
  ResolvedRepositoryDestination,
  SourceConnection,
  SourceRepository,
  StackDefinition,
  TemplateSummary,
} from '../../model/contracts/catalog'
import type { BusinessApp } from '../../model/contracts/console'
import { decodeResponse } from '../boundary'
import { publishDomainReader, registryConnectionReader, repositoryDestinationReader, sourceConnectionReader, sourceRepositoryReader, stackDefinitionReader, templateReader } from '../contracts/platform/catalog'
import { appContract } from '../contracts/console/operations'

function read<D>(reader: z.ZodType<D>, wire: unknown, what: string): D {
  const result = reader.safeParse(wire)
  if (!result.success) throw new Error(`${what} fixture does not match its reader: ${result.error.issues.map((issue) => `${issue.code} /${issue.path.join('/')}`).join(', ')}`)
  return result.data
}

export const templateOf = (wire: unknown): TemplateSummary => read(templateReader, wire, 'template')
export const definitionOf = (wire: unknown): StackDefinition => read(stackDefinitionReader, wire, 'stack definition')
export const sourceConnectionOf = (wire: unknown): SourceConnection => read(sourceConnectionReader, wire, 'source connection')
export const registryOf = (wire: unknown): RegistryConnection => read(registryConnectionReader, wire, 'registry connection')
export const domainOf = (wire: unknown): PublishDomain => read(publishDomainReader, wire, 'domain')
export const sourceRepositoryOf = (wire: unknown): SourceRepository => read(sourceRepositoryReader, wire, 'source repository')
export const destinationOf = (wire: unknown): RepositoryDestination => read(repositoryDestinationReader, wire, 'repository destination')

/** A resolved destination as `GET repository-destination` answers it (GHCR under `acme` unless patched). */
export function resolvedDestinationOf(patch: { revision?: string; registryNamespace?: string; imageAccessId?: string } = {}): ResolvedRepositoryDestination {
  const { revision = 'rd-ghcr-1', ...destination } = patch
  const read = destinationOf({
    state: 'Resolved', source: 'Project', revision,
    destination: { connectionId: 'github-source-207cb7ce', provider: 'github', displayName: 'Acme GitHub', repositoryNamespace: 'acme', registryNamespace: 'ghcr.io/acme', ...destination },
  })
  if (read.kind !== 'resolved') throw new Error('resolved destination fixture did not read as resolved')
  return read
}

/**
 * The app wire fields most fixtures do not care about, for spreading into an
 * app wire: the default contribution scope and the caller's capabilities as the
 * app's owner (the creator of a draft maintains it).
 */
export const appWireDefaults = {
  contribution: { scope: 'group' },
  permissions: { use: true, comment: true, propose: true, maintain: true, data: true },
} as const

/** A Console app as `GET /api/console/apps/{id}` answers it. */
export function appOf(wire: unknown): BusinessApp {
  const result = decodeResponse(appContract, wire)
  if (!result.ok) throw new Error(`app fixture does not match its contract: ${result.error.issues.map((issue) => `${issue.code} ${issue.path}`).join(', ')}`)
  return result.value
}
