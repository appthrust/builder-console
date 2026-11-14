// Pure construction of the platform create requests behind the wizard. The
// console hides template, image and the definition pairing, so they are
// resolved here from the catalog read models. The web port is never sent: the
// platform reads it from the built image (`EXPOSE`).
//
// The catalog values are evidence for whether creation is allowed: a source
// kind, capability, connection status or domain source this console does not
// know is never available, never a capability and never ready.
//
// Where a new repository and its image go is Platform's resolved repository
// destination, never a connection this console picks or an owner/registry it
// joins: a new-repository request names only the template, the repository
// name and the destination revision the user saw.
import { isOneOf, type CreationPlan } from './contracts/build'
import type {
  PublishDomain,
  RegistryConnection,
  ResolvedRepositoryDestination,
  SourceConnection,
  SourceRepositoryRequest,
  StackDefinition,
  StackDefinitionRef,
  StackRequest,
  TemplateSourceKind,
  TemplateSummary,
} from './contracts/catalog'

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
  template: TemplateSummary
  definitionRef: StackDefinitionRef
  connectionName: string
}

/** A source is usable only when that exact catalog path is available; an unknown kind is none of them. */
export function templateUsableFor(
  template: Pick<TemplateSummary, 'sourceKinds' | 'availability'>,
  kind: TemplateSourceKind
): boolean {
  return template.sourceKinds.some((item) => isOneOf(item, kind)) && template.availability.sources.some((source) => isOneOf(source.kind, kind) && source.available)
}

/** Templates offered for a source kind, available ones only, the default first. */
export function templatesFor(
  templates: readonly TemplateSummary[],
  sourceKind: CreateSourceKind
): TemplateSummary[] {
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
  templates: readonly TemplateSummary[],
  definitions: readonly StackDefinition[],
  sourceKind: CreateSourceKind,
  templateId?: string
): CreateCatalog | undefined {
  const candidates = templatesFor(templates, sourceKind)
  const template = templateId ? candidates.find((item) => item.id === templateId) : candidates[0]
  if (!template) return undefined
  const definition = definitions.find((item) => !item.catalogSource && item.components.length === template.components.length)
  if (!definition) return undefined
  // Platform omits `served: false` (internal/api/dto_application_stack_definition.go:7, omitempty): only an explicit true is served.
  const version =
    definition.versions?.find((item) => item.default && item.served === true) ??
    definition.versions?.find((item) => item.served === true)
  return {
    template,
    definitionRef: version ? { name: definition.id, version: version.name } : { name: definition.id },
    connectionName: definition.connections?.[0]?.name ?? 'db',
  }
}

/** What the create paths need from the platform besides the catalog and the repository destination. */
export interface CreateEnvironment {
  /** 作ったコードから only: the connection an existing repository is listed and adopted with. It never decides where a new repository goes. */
  adoption?: SourceConnection
  /** イメージ only: the first ready registry connection (Platform rejects a sample-image source without one). */
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
export function pickPublishDomain(domains: readonly PublishDomain[]): string | undefined {
  const ready = domains.filter((domain) => domain.usableForPublish)
  return (ready.find((domain) => isOneOf(domain.source, 'seed')) ?? ready[0])?.name
}

/** A configured publish base is waiting on runtime readiness; another usable base wins. */
export function publishDomainPending(domains: readonly PublishDomain[]): boolean {
  return !domains.some((domain) => domain.usableForPublish) && domains.some((domain) =>
    !isOneOf(domain.source, 'projectHostname') && domain.publishDnsManaged &&
    (domain.publishUnavailableReason === 'ProjectGatewayPending' || domain.publishUnavailableReason === 'PublishRuntimeCapabilityPending'))
}

function templateRepository(template: TemplateSummary): string {
  return template.githubTemplate?.repository ?? `appthrust/template-${template.id.replace(/-postgres$/, '')}`
}

export function pickCreateEnvironment(
  sources: readonly SourceConnection[],
  registries: readonly RegistryConnection[],
  domains: readonly PublishDomain[]
): CreateEnvironment {
  return {
    // Adoption keeps naming its connection explicitly (Platform does not resolve a destination for it).
    adoption: sources.find((source) => isOneOf(source.status, 'ready') && source.capabilities.some((item) => isOneOf(item, 'createRepositories'))),
    registry: registries.find((item) => isOneOf(item.status, 'ready')),
    domain: pickPublishDomain(domains),
  }
}

/** The wizard's Step 0 entries (ux-design §8.1). */
export type CreateEntry = 'existing' | 'template' | 'ai' | 'image'

/**
 * What is missing for an entry, in display order. Every entry publishes. The
 * existing-work entry lists and adopts through a GitHub connection; the image
 * entry names its registry. A new repository's connection and image access
 * come from the repository destination instead (`newRepositoryEntry`).
 */
export function missingPrerequisites(environment: CreateEnvironment, entry: CreateEntry): CreatePrerequisite[] {
  const missing: CreatePrerequisite[] = []
  if (entry === 'existing' && !environment.adoption) missing.push('github')
  if (entry === 'image' && !environment.registry) missing.push('registry')
  if (!environment.domain) missing.push('domain')
  return missing
}

/** The entries that create a new repository, and so need a resolved repository destination. */
export function newRepositoryEntry(entry: CreateEntry | undefined): entry is 'template' | 'ai' {
  return entry === 'template' || entry === 'ai'
}

/** `owner/name` of the repository Platform creates for `appName` at `destination`. */
export function destinationRepository(destination: ResolvedRepositoryDestination, appName: string): string {
  return `${destination.repositoryNamespace}/${appName}`
}

/**
 * Where its images go: Platform derives the image path as the destination's
 * registry namespace plus the repository name (platform-api
 * internal/repositorydestination/request.go:60), and asserts it at create.
 */
export function destinationImage(destination: ResolvedRepositoryDestination, appName: string): string {
  return `${destination.registryNamespace}/${appName}`
}

export function appUrl(appName: string, domain: string): string {
  return `https://${appName}.${domain}`
}

/**
 * The ひな形 path's first platform call: a new private repository from the
 * template, whose pushed images (`edge-*`) are observed. Connection, owner,
 * image path and image access are Platform's resolved destination; the request
 * binds the revision the user saw, so a destination that moved meanwhile
 * answers 409 DestinationChanged instead of creating elsewhere.
 */
export function buildSourceRepositoryRequest(
  appName: string,
  catalog: CreateCatalog,
  destination: ResolvedRepositoryDestination
): SourceRepositoryRequest {
  const github = catalog.template.githubTemplate
  const ref = github?.branch ?? DEFAULT_TEMPLATE_REF
  return {
    template: {
      repository: templateRepository(catalog.template),
      ref,
    },
    destination: { repositoryName: appName, visibility: 'private' },
    destinationRevision: destination.revision,
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
 * on its default branch with the connection that listed it. Platform resolves
 * no destination for adoption: it derives the image path itself (GHCR,
 * `ghcr.io/<owner>/<name>`) and picks the registry access for that host, so
 * neither is sent. The build (`workflow-dispatch` of `deploy.yml`) is the
 * platform default for existing repositories.
 */
export function buildExistingSourceRepositoryRequest(
  repository: PickedRepository,
  adoption: SourceConnection
): SourceRepositoryRequest {
  return {
    sourceConnectionId: adoption.id,
    existing: { repository: repository.fullName, ...(repository.defaultBranch ? { ref: repository.defaultBranch } : {}) },
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

export function summarizeCreationPlan(plan: CreationPlan): PlanSummary {
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
): StackRequest {
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
