// Pure construction of the platform create requests behind the wizard. The
// console hides template, image and the definition pairing, so they are
// resolved here from the catalog read models. The web port is never sent: the
// platform reads it from the built image (`EXPOSE`).
import type {
  ApplicationDraftCreationPlan,
  ApplicationStackDefinition,
  ApplicationTemplateSourceKind,
  ApplicationTemplateSummary,
  CreateApplicationStackRequest,
  Domain,
  GitHubSourceConnection,
  RegistryConnection,
} from '@appthrust/api-schema/platform-api'
import type { CreateApplicationSourceRepositoryRequest, RepositoryDestinationResolution } from '../api/repository-destination'

/** Same rule as the contract's DnsLabelName. */
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

/** Console reserved first path segments (contract: slug rules). */
const RESERVED_NAMES: Record<string, true> = {
  mine: true,
  company: true,
  new: true,
  help: true,
  logout: true,
  api: true,
  oauth2: true,
}

export function appNameProblem(name: string): 'empty' | 'tooLong' | 'invalid' | 'reserved' | undefined {
  if (!name) return 'empty'
  if (name.length > 63) return 'tooLong'
  if (Object.hasOwn(RESERVED_NAMES, name)) return 'reserved'
  if (!DNS_LABEL.test(name)) return 'invalid'
  return undefined
}

export function isValidAppName(name: string): boolean {
  return appNameProblem(name) === undefined
}

/** An explicit registry and repository, with an optional tag or content digest. */
export function isValidImageReference(value: string): boolean {
  const reference = value.trim()
  const match = /^([^/]+)\/(.+?)(?::([\w][\w.-]{0,127})|@(sha256:[a-fA-F0-9]{64}|sha512:[a-fA-F0-9]{128}))?$/.exec(reference)
  if (!match) return false
  const [, registry = '', repository = ''] = match
  const host = /^(?:localhost|[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::([0-9]{1,5}))?$/.exec(registry)
  if (!host || (host[1] && (Number(host[1]) < 1 || Number(host[1]) > 65535))) return false
  return repository.split('/').every((part) => /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(part))
}

export const DEFAULT_TEMPLATE_ID = 'nextjs-postgres'
const DEFAULT_TEMPLATE_REF = 'main'

// Hepburn romaji for hiragana (katakana is folded onto hiragana first).
const KANA: Record<string, string> = Object.fromEntries(
  (
    'あa いi うu えe おo かka きki くku けke こko さsa しshi すsu せse そso たta ちchi つtsu てte とto ' +
    'なna にni ぬnu ねne のno はha ひhi ふfu へhe ほho まma みmi むmu めme もmo やya ゆyu よyo ' +
    'らra りri るru れre ろro わwa をo んn がga ぎgi ぐgu げge ごgo ざza じji ずzu ぜze ぞzo ' +
    'だda ぢji づzu でde どdo ばba びbi ぶbu べbe ぼbo ぱpa ぴpi ぷpu ぺpe ぽpo ぁa ぃi ぅu ぇe ぉo ゃya ゅyu ょyo ゔvu'
  )
    .split(' ')
    .map((pair) => [pair.slice(0, 1), pair.slice(1)])
)
const SMALL_Y: Record<string, string> = { ゃ: 'a', ゅ: 'u', ょ: 'o' }

function romanize(text: string): string {
  const hiragana = text.replace(/[\u30a1-\u30f6]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60))
  let out = ''
  let doubleNext = false
  for (let index = 0; index < hiragana.length; index++) {
    const char = hiragana[index]!
    if (char === 'っ') {
      doubleNext = true
      continue
    }
    let roman = KANA[char]
    const vowel = SMALL_Y[hiragana[index + 1] ?? '']
    if (roman && vowel && roman.endsWith('i') && roman.length > 1) {
      // きゃ → kya, しゃ → sha, ちゃ → cha, じゃ → ja
      const stem = roman.slice(0, -1)
      roman = /^(sh|ch|j)$/.test(stem) ? stem + vowel : `${stem}y${vowel}`
      index++
    }
    if (roman === undefined) roman = char === 'ー' ? '' : /[a-z0-9]/i.test(char) ? char : '-'
    if (doubleNext && roman) {
      roman = roman.startsWith('ch') ? `t${roman}` : roman[0] + roman
      doubleNext = false
    }
    out += roman
  }
  return out
}

/**
 * "URL になる名前" suggestion from the display name: romanize kana → lowercase
 * → hyphens. Kanji have no client-side reading, so a name without any usable
 * letters takes `fallback`: the caller's word (a business template's English
 * word, a group prefix) or, by default, `app-<6 hex>` (the contract's rule;
 * the server's draft response stays authoritative).
 */
export function suggestUrlName(displayName: string, fallback: () => string = randomAppName): string {
  const label = romanize(displayName.normalize('NFKC').toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '')
  if (!label) return fallback()
  return Object.hasOwn(RESERVED_NAMES, label) ? `${label}-app` : label
}

/**
 * The `n`th numbered variant of a taken URL name: `mitsumori` → `mitsumori-2`.
 * An existing number is replaced (`mitsumori-2` → `mitsumori-3`) and the base
 * is shortened so the result stays within 63 characters.
 */
export function numberedUrlName(name: string, n: number): string {
  const suffix = `-${n}`
  const base = name.replace(/-\d+$/, '').slice(0, 63 - suffix.length).replace(/-+$/, '')
  return `${base || 'app'}${suffix}`
}

function randomAppName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3))
  return `app-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export type CreateSourceKind = 'github-template' | 'sample-image'

export interface CreateCatalog {
  template: ApplicationTemplateSummary
  definitionRef: CreateApplicationStackRequest['definitionRef']
  connectionName: string
}

/** A source is usable only when that exact catalog path is available. */
export function templateUsableFor(
  template: Pick<ApplicationTemplateSummary, 'sourceKinds' | 'availability'>,
  kind: ApplicationTemplateSourceKind
): boolean {
  return template.sourceKinds.includes(kind) && template.availability.sources.some((source) => source.kind === kind && source.available)
}

/** Templates offered for a source kind, available ones only, the default first. */
export function templatesFor(
  templates: readonly ApplicationTemplateSummary[],
  sourceKind: CreateSourceKind
): ApplicationTemplateSummary[] {
  return templates
    .filter((item) => templateUsableFor(item, sourceKind))
    .sort((a, b) => Number(b.id === DEFAULT_TEMPLATE_ID) - Number(a.id === DEFAULT_TEMPLATE_ID))
}

/**
 * Picks the requested (or default, or first) template for the source kind, and
 * the platform-shipped stack definition whose component count matches it.
 * Templates do not reference a definition, so the pairing is structural;
 * marketplace apps (`catalogSource` set, owned by an AppCatalogSource) are
 * ApplicationStackDefinitions too and must never be candidates, or the template
 * deploys that app's image under the user's name.
 */
export function resolveCreateCatalog(
  templates: readonly ApplicationTemplateSummary[],
  definitions: readonly ApplicationStackDefinition[],
  sourceKind: CreateSourceKind,
  templateId?: string
): CreateCatalog | undefined {
  const candidates = templatesFor(templates, sourceKind)
  const template = templateId ? candidates.find((item) => item.id === templateId) : candidates[0]
  if (!template) return undefined
  const definition = definitions.find((item) => !item.catalogSource && item.components.length === template.components.length)
  if (!definition) return undefined
  const version =
    definition.versions?.find((item) => item.default && item.served !== false) ??
    definition.versions?.find((item) => item.served !== false)
  return {
    template,
    definitionRef: version ? { name: definition.id, version: version.name } : { name: definition.id },
    connectionName: definition.connections?.[0]?.name ?? 'db',
  }
}

/** The connection and registry an existing repository is adopted with (作ったコードから). */
export interface AdoptionConnections {
  source: GitHubSourceConnection
  registry: RegistryConnection
}

export type ResolvedDestination = Extract<RepositoryDestinationResolution, { state: 'Resolved' }>

/** What the create paths need from the platform besides the catalog. */
export interface CreateEnvironment {
  /**
   * 作ったコードから only: the first ready GitHub connection able to create
   * repositories, used to list and adopt an existing repository. It never
   * decides where a new repository goes.
   */
  adoption?: GitHubSourceConnection
  /** First ready registry connection (作ったコードから and image). */
  registry?: RegistryConnection
  /** Where the platform creates new repositories (ひな形, AI); undefined when the platform did not answer. */
  destination?: RepositoryDestinationResolution
  /** Publish-ready domain base; the app URL is `https://<appName>.<domain>` (ux-design §7.1.1). */
  domain?: string
}

/** A platform setup the console cannot create apps without; only an admin can fix it. */
export type CreatePrerequisite = 'github' | 'registry' | 'domain'

/**
 * Publish-ready = `usableForPublish`, the same predicate as the Dashboard's
 * create publish form. The project's seeded base domain (`<project>.<base>`)
 * is preferred so the URL follows §7.1.1; otherwise the first ready domain.
 */
export function pickPublishDomain(domains: readonly Domain[]): string | undefined {
  const ready = domains.filter((domain) => domain.usableForPublish)
  return (ready.find((domain) => domain.source === 'seed') ?? ready[0])?.name
}

/** A configured publish base is waiting on runtime readiness; another usable base wins. */
export function publishDomainPending(domains: readonly Domain[]): boolean {
  return !domains.some((domain) => domain.usableForPublish) && domains.some((domain) =>
    domain.source !== 'projectHostname' && domain.publishDnsManaged &&
    (domain.publishUnavailableReason === 'ProjectGatewayPending' || domain.publishUnavailableReason === 'PublishRuntimeCapabilityPending'))
}

function templateRepository(template: ApplicationTemplateSummary): string {
  return template.githubTemplate?.repository ?? `appthrust/template-${template.id.replace(/-postgres$/, '')}`
}

export function pickCreateEnvironment(
  sources: readonly GitHubSourceConnection[],
  registries: readonly RegistryConnection[],
  domains: readonly Domain[],
  destination?: RepositoryDestinationResolution
): CreateEnvironment {
  return {
    adoption: sources.find((source) => source.status === 'ready' && source.capabilities.includes('createRepositories')),
    registry: registries.find((item) => item.status === 'ready'),
    destination,
    domain: pickPublishDomain(domains),
  }
}

/** The wizard's Step 0 entries (ux-design §8.1). */
export type CreateEntry = 'existing' | 'template' | 'ai' | 'image'

/**
 * What is missing for an entry, in display order. Every entry publishes. The
 * existing-work and image entries name their registry connection (the
 * platform rejects a sample-image source without one); a new repository's
 * GitHub and image access come from the platform's destination instead
 * (`destinationProblem`).
 */
export function missingPrerequisites(environment: CreateEnvironment, entry: CreateEntry): CreatePrerequisite[] {
  const missing: CreatePrerequisite[] = []
  if (entry === 'existing' && !environment.adoption) missing.push('github')
  if ((entry === 'existing' || entry === 'image') && !environment.registry) missing.push('registry')
  if (!environment.domain) missing.push('domain')
  return missing
}

export function adoptionConnectionsOf(environment: CreateEnvironment): AdoptionConnections | undefined {
  const { adoption, registry } = environment
  return adoption && registry ? { source: adoption, registry } : undefined
}

/** The reasons the Platform API documents for a blocked destination; the list is open, so others still arrive. */
export const REPOSITORY_DESTINATION_REASONS = [
  'NotConfigured',
  'Ambiguous',
  'NotFound',
  'Deleting',
  'NotReady',
  'MissingCapability',
  'NotVisible',
  'UnsupportedProvider',
  'ImageAccessNotConfigured',
  'ImageAccessAmbiguous',
  'ImageAccessNotReady',
  'DestinationMismatch',
  'DestinationChanged',
] as const
export type RepositoryDestinationReason = (typeof REPOSITORY_DESTINATION_REASONS)[number]

export function isRepositoryDestinationReason(value: unknown): value is RepositoryDestinationReason {
  return typeof value === 'string' && (REPOSITORY_DESTINATION_REASONS as readonly string[]).includes(value)
}

/** Console-side reason when the platform did not report a destination at all. */
export const DESTINATION_UNAVAILABLE = 'Unavailable'

/** Why no new repository can be created; `message` is the server's (not localized) text. */
export interface DestinationProblem {
  reason: string
  message: string
}

/** Undefined when new repositories have a destination; otherwise the platform's reason (or `Unavailable`). */
export function destinationProblem(resolution: RepositoryDestinationResolution | undefined): DestinationProblem | undefined {
  if (resolution?.state === 'Resolved') return undefined
  return resolution ? { reason: resolution.reason, message: resolution.message } : { reason: DESTINATION_UNAVAILABLE, message: '' }
}

export function resolvedDestination(resolution: RepositoryDestinationResolution | undefined): ResolvedDestination | undefined {
  return resolution?.state === 'Resolved' ? resolution : undefined
}

/** `owner/name` of the repository the platform will create for `appName`. */
export function destinationRepository(destination: ResolvedDestination, appName: string): string {
  return `${destination.destination.repositoryNamespace}/${appName}`
}

/** Where the new repository's images will be pushed. */
export function destinationImage(destination: ResolvedDestination, appName: string): string {
  return `${destination.destination.registryNamespace}/${appName}`
}

/** Did the place new repositories go to move (not merely a new revision of the same place)? */
export function destinationMoved(before: ResolvedDestination | undefined, after: ResolvedDestination | undefined): boolean {
  if (!before || !after) return before !== after
  const a = before.destination
  const b = after.destination
  return a.connectionId !== b.connectionId || a.repositoryNamespace !== b.repositoryNamespace || a.registryNamespace !== b.registryNamespace
}

export function appUrl(appName: string, domain: string): string {
  return `https://${appName}.${domain}`
}

/**
 * The ひな形 path's first platform call: a new private repository from the
 * template, whose pushed images (`edge-*`) are observed. Where it is created
 * (connection, owner, image path) is the platform's resolved destination; the
 * request only binds the revision the user saw, so a destination that moved
 * meanwhile answers 409 DestinationChanged instead of creating elsewhere.
 */
export function buildSourceRepositoryRequest(
  appName: string,
  catalog: CreateCatalog,
  destination: ResolvedDestination
): CreateApplicationSourceRepositoryRequest {
  const github = catalog.template.githubTemplate
  const ref = github?.branch ?? DEFAULT_TEMPLATE_REF
  return {
    template: {
      repository: templateRepository(catalog.template),
      ref,
    },
    destination: { repositoryName: appName, visibility: 'private' },
    destinationRevision: destination.revision,
    image: { tagFilter: 'edge-', versioningScheme: 'Alphabetical' },
    build: { mode: 'observed-image', ref },
  }
}

/** A repository the source connection can see (picker row). */
export interface PickedRepository {
  /** `owner/name`. */
  fullName: string
  defaultBranch: string
}

/** "URL になる名前" from a repository name (`acme/Mitsumori_App` → `mitsumori-app`). */
export function urlNameFromRepository(fullName: string): string {
  return suggestUrlName(fullName.slice(fullName.indexOf('/') + 1))
}

/**
 * The 作ったコードから path's first platform call: adopt the picked repository
 * on its default branch. The build (`workflow-dispatch` of `deploy.yml`) is
 * the platform default for existing repositories, so it is not sent; that
 * workflow pushes `edge-<timestamp>` tags to `<registry>/<owner>/<name>`,
 * observed like the ひな形 path.
 */
export function buildExistingSourceRepositoryRequest(
  repository: PickedRepository,
  connections: AdoptionConnections
): CreateApplicationSourceRepositoryRequest {
  const host = connections.registry.registryHost.trim().toLowerCase() || 'ghcr.io'
  return {
    sourceConnectionId: connections.source.id,
    registryConnectionRef: connections.registry.id,
    existing: { repository: repository.fullName, ...(repository.defaultBranch ? { ref: repository.defaultBranch } : {}) },
    image: { imagePath: `${host}/${repository.fullName.toLowerCase()}`, tagFilter: 'edge-', versioningScheme: 'Alphabetical' },
  }
}

export type PlanPart = 'source' | 'web' | 'database'

/** What the plan summary step shows (ux-design §8.1 ✨): parts, ひな形, URL. */
export interface PlanSummary {
  summary: string
  parts: PlanPart[]
  templateId?: string
  /** Platform application name the plan creates; the console binds to it. */
  appName?: string
  url?: string
}

export function summarizeCreationPlan(plan: ApplicationDraftCreationPlan): PlanSummary {
  const stack = plan.applicationStackRequest
  const parts: PlanPart[] = []
  // A plan restored by creation cleanup is persisted with `representation: null`; the Go DTO has no omitempty.
  if (plan.applicationSourceRepositoryRequest || plan.representation?.includes('SourceRepository')) parts.push('source')
  if (stack?.web) parts.push('web')
  if (stack?.database) parts.push('database')
  const appName = stack?.application?.name ?? stack?.applicationName
  const publish = stack?.publish
  const url = publish?.customDomain
    ? publish.hostnamePattern === 'wildcard' && publish.subdomain
      ? appUrl(publish.subdomain, publish.customDomain)
      : `https://${publish.customDomain}`
    : undefined
  return {
    summary: plan.summary,
    parts,
    ...(stack?.templateId ? { templateId: stack.templateId } : {}),
    ...(appName ? { appName } : {}),
    ...(url ? { url } : {}),
  }
}

export type StackSource =
  | { kind: 'sample-image'; imageRef: string }
  | { kind: 'application-source-repository'; sourceRepositoryId: string }

/**
 * Gateway publish on the project's domain: `wildcard` + `subdomain` = the
 * application name gives `https://<appName>.<domain>` (platform rule: gateway
 * publish needs customDomain + hostnamePattern; wildcard needs subdomain).
 * `web` carries no port; the platform resolves it from the image.
 */
export function buildCreateStackRequest(
  appName: string,
  source: StackSource,
  catalog: CreateCatalog,
  domain: string
): CreateApplicationStackRequest {
  return {
    templateId: catalog.template.id,
    definitionRef: catalog.definitionRef,
    application: { name: appName },
    branch: { id: 'production', role: 'production', createIfMissing: true },
    source:
      source.kind === 'sample-image'
        ? { kind: 'sample-image', imageRef: source.imageRef.trim() }
        : { kind: 'application-source-repository', sourceRepositoryId: source.sourceRepositoryId },
    web: { componentName: 'web' },
    database: { componentName: 'db' },
    connection: { connectionName: catalog.connectionName },
    publish: { enabled: true, customDomain: domain, hostnamePattern: 'wildcard', subdomain: appName },
  }
}
