// Test seam: create / catalog domain values made from wire fixtures by the
// production readers, never by casting a literal to a domain type. A fixture
// the reader rejects fails the test that uses it.
import type { z } from 'zod'
import type {
  PublishDomain,
  RegistryConnection,
  SourceConnection,
  StackDefinition,
  TemplateSummary,
} from '../../model/contracts/catalog'
import type { BusinessApp } from '../../model/contracts/console'
import { decodeResponse } from '../boundary'
import { publishDomainReader, registryConnectionReader, sourceConnectionReader, stackDefinitionReader, templateReader } from '../contracts/platform/catalog'
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

/** A Console app as `GET /api/console/apps/{id}` answers it. */
export function appOf(wire: unknown): BusinessApp {
  const result = decodeResponse(appContract, wire)
  if (!result.ok) throw new Error(`app fixture does not match its contract: ${result.error.issues.map((issue) => `${issue.code} ${issue.path}`).join(', ')}`)
  return result.value
}
