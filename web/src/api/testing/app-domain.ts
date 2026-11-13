// Test seam: app / discover / admin domain values made from wire fixtures by
// the production readers, never by casting a literal to a domain type. A
// fixture the reader rejects fails the test that uses it.
import type { z } from 'zod'
import type { ConsoleAppSources, ConsoleAppsInput, SourceRepositoryFacts } from '../../model/app'
import type { AppPublish, AppRelease, AppStack, ComponentConfig, ComponentLogs, ComponentSummary, PlatformApplication, PublishAccess, ReleaseOverview, ReleaseState } from '../../model/contracts/app'
import type { AccessRequest, AppTools, BusinessApp, DirectoryEntry, Membership, PersonProfile, PersonRef } from '../../model/contracts/console'
import { accessRequestReader, appReader, entryReader, membershipReader, profileReader, toolsReader } from '../contracts/console/readers'
import { personRefReader } from '../contracts/console/person'
import {
  applicationReader, configReader, logsReader, overviewReader, publishAccessReader, publishReader, releaseReader, releaseStateReader, stackReader, summaryReader,
} from '../contracts/platform/app'

function read<D>(reader: z.ZodType<D>, wire: unknown, what: string): D {
  const result = reader.safeParse(wire)
  if (!result.success) throw new Error(`${what} fixture does not match its reader: ${result.error.issues.map((issue) => `${issue.code} /${issue.path.join('/')}`).join(', ')}`)
  return result.data
}

export const applicationOf = (wire: unknown): PlatformApplication => read(applicationReader, wire, 'application')
export const stackOf = (wire: unknown): AppStack => read(stackReader, wire, 'stack')
export const publishOf = (wire: unknown): AppPublish => read(publishReader, wire, 'publish')
export const publishAccessOf = (wire: unknown): PublishAccess => read(publishAccessReader, wire, 'publish access')
export const summaryOf = (wire: unknown): ComponentSummary => read(summaryReader, wire, 'component summary')
export const releaseOf = (wire: unknown): AppRelease => read(releaseReader, wire, 'release')
export const overviewOf = (wire: unknown): ReleaseOverview => read(overviewReader, wire, 'release overview')
export const releaseStateOf = (wire: unknown): ReleaseState => read(releaseStateReader, wire, 'release state')
export const configOf = (wire: unknown): ComponentConfig => read(configReader, wire, 'component config')
export const logsOf = (wire: unknown): ComponentLogs => read(logsReader, wire, 'component logs')

export const businessAppOf = (wire: unknown): BusinessApp => read(appReader, wire, 'app')
export const entryOf = (wire: unknown): DirectoryEntry => read(entryReader, wire, 'directory entry')
export const membershipOf = (wire: unknown): Membership => read(membershipReader, wire, 'membership')
export const profileOf = (wire: unknown): PersonProfile => read(profileReader, wire, 'person profile')
export const accessRequestOf = (wire: unknown): AccessRequest => read(accessRequestReader, wire, 'access request')
export const toolsOf = (wire: unknown): AppTools => read(toolsReader, wire, 'tools')
export const personRefOf = (wire: unknown): PersonRef => read(personRefReader, wire, 'person')

const optional = <D>(of: (wire: unknown) => D) => (wire: unknown): D | undefined => (wire === undefined ? undefined : of(wire))

/** The sources of one app, each read from its wire fixture. */
export interface WireAppSources {
  application: unknown
  stack?: unknown
  publishes: readonly unknown[]
  componentSummaries: readonly unknown[]
  releases?: unknown
}

export function sourcesOf(wire: WireAppSources): ConsoleAppSources {
  const stack = optional(stackOf)(wire.stack)
  const releases = optional(overviewOf)(wire.releases)
  return {
    application: applicationOf(wire.application),
    ...(stack ? { stack } : {}),
    publishes: wire.publishes.map(publishOf),
    componentSummaries: wire.componentSummaries.map(summaryOf),
    ...(releases ? { releases } : {}),
  }
}

/** Project read models from wire fixtures; source repositories are already reduced to their facts. */
export interface WireAppsInput {
  applications: readonly unknown[]
  stacks: readonly unknown[]
  publishes: readonly unknown[]
  componentSummaries: readonly unknown[]
  releasesByApplication: Readonly<Record<string, unknown>>
  sourceRepositories?: readonly SourceRepositoryFacts[]
}

export function appsInputOf(wire: WireAppsInput): ConsoleAppsInput {
  return {
    applications: wire.applications.map(applicationOf),
    stacks: wire.stacks.map(stackOf),
    publishes: wire.publishes.map(publishOf),
    componentSummaries: wire.componentSummaries.map(summaryOf),
    releasesByApplication: Object.fromEntries(Object.entries(wire.releasesByApplication).map(([id, overview]) => [id, optional(overviewOf)(overview)])),
    ...(wire.sourceRepositories ? { sourceRepositories: wire.sourceRepositories } : {}),
  }
}
