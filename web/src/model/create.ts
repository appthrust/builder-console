// Pure construction of the platform create requests behind the wizard. The
// console hides template, image and the definition pairing, so they are
// resolved here from the catalog read models. The web port is never sent: the
// platform reads it from the built image (`EXPOSE`).
import type {
  ApplicationDraftCreationPlan,
  ApplicationStackDefinition,
  ApplicationTemplateSourceKind,
  ApplicationTemplateSummary,
  CreateApplicationSourceRepositoryRequest,
  CreateApplicationStackRequest,
  Domain,
  GitHubSourceConnection,
  RegistryConnection,
} from '@appthrust/api-schema/platform-api'

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
 * the stack definition whose component count matches it. Templates do not
 * reference a definition, so the pairing is structural.
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
  const definition = definitions.find((item) => item.components.length === template.components.length)
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

export interface SourceConnections {
  source: GitHubSourceConnection
  registry: RegistryConnection
}

/** What the create paths need from the platform besides the catalog. */
export interface CreateEnvironment {
  /** First ready GitHub connection able to create repositories and, if selected, read the template. */
  source?: GitHubSourceConnection
  /** First ready registry connection. */
  registry?: RegistryConnection
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

function canCreateFromSource(source: GitHubSourceConnection, template?: ApplicationTemplateSummary): boolean {
  return source.status === 'ready' && source.capabilities.includes('createRepositories') &&
    (!template || source.capabilities.includes('readTemplateRepositories'))
}

/** Trimmed, case-insensitive matching mirrors the Platform API's validateSourceRepositoryAllowlist. */
export function pickSourceConnection(
  sources: readonly GitHubSourceConnection[],
  template?: ApplicationTemplateSummary
): GitHubSourceConnection | undefined {
  const repository = template ? templateRepository(template).trim().toLowerCase() : undefined
  return sources.find((source) => canCreateFromSource(source, template) &&
    (!repository || !source.allowedRepositories?.length || source.allowedRepositories.some((allowed) => allowed.trim().toLowerCase() === repository)))
}

export function templateSourceProblem(
  template: ApplicationTemplateSummary,
  sources: readonly GitHubSourceConnection[]
): 'not-admitted' | 'no-connection' | undefined {
  if (pickSourceConnection(sources, template)) return undefined
  return sources.some((source) => canCreateFromSource(source, template)) ? 'not-admitted' : 'no-connection'
}

export function pickCreateEnvironment(
  sources: readonly GitHubSourceConnection[],
  registries: readonly RegistryConnection[],
  domains: readonly Domain[],
  template?: ApplicationTemplateSummary
): CreateEnvironment {
  return {
    source: pickSourceConnection(sources, template),
    registry: registries.find((item) => item.status === 'ready'),
    domain: pickPublishDomain(domains),
  }
}

/** The wizard's Step 0 entries (ux-design §8.1). */
export type CreateEntry = 'existing' | 'template' | 'ai' | 'image'

/**
 * What is missing for an entry, in display order. Every entry publishes and
 * needs a ready registry (the platform rejects a sample-image source without
 * one); all but the image entry work on a GitHub repository.
 */
export function missingPrerequisites(environment: CreateEnvironment, entry: CreateEntry): CreatePrerequisite[] {
  const missing: CreatePrerequisite[] = []
  if (entry !== 'image' && !environment.source) missing.push('github')
  if (!environment.registry) missing.push('registry')
  if (!environment.domain) missing.push('domain')
  return missing
}

export function sourceConnectionsOf(environment: CreateEnvironment): SourceConnections | undefined {
  const { source, registry } = environment
  return source && registry ? { source, registry } : undefined
}

export function appUrl(appName: string, domain: string): string {
  return `https://${appName}.${domain}`
}

/**
 * The ひな形 path's first platform call, mirroring the Dashboard github-template
 * submission: a new private repository from the template, owned by the source
 * connection's account, whose pushed images (`edge-*`) are observed.
 */
export function buildSourceRepositoryRequest(
  appName: string,
  catalog: CreateCatalog,
  connections: SourceConnections
): CreateApplicationSourceRepositoryRequest {
  const owner = connections.source.account.login.toLowerCase()
  const host = connections.registry.registryHost.trim().toLowerCase() || 'ghcr.io'
  const github = catalog.template.githubTemplate
  const ref = github?.branch ?? DEFAULT_TEMPLATE_REF
  return {
    sourceConnectionId: connections.source.id,
    registryConnectionRef: connections.registry.id,
    template: {
      repository: templateRepository(catalog.template),
      ref,
    },
    destination: { repositoryName: appName, visibility: 'private' },
    image: { imagePath: `${host}/${owner}/${appName}`, tagFilter: 'edge-', versioningScheme: 'Alphabetical' },
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
  connections: SourceConnections
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
