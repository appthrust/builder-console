// The creating view (ux-design §8.1): 置き場 → 最初の版 → URL → 公開範囲.
// The source step completes when the repository exists; the first image build
// belongs to the release step, which completes only when the app runs.
// URL readiness and access-policy readiness are independent. An adopted
// repository leads with a repository check; AI creation binds before this view.
import type { ApplicationSourceRepository } from '@appthrust/api-schema/platform-api'
import { copy } from '../copy'
import type { AppView } from './app'
import type { AccessDisplay } from './access'
import { sharingCopy } from '../copy/sharing'

export type StepState = 'done' | 'active' | 'pending' | 'failed'

export interface ProgressStep {
  key: 'check' | 'source' | 'release' | 'url' | 'share'
  state: StepState
  title: string
  detail?: string
  /** External link for the step (the repository, its GitHub Actions build, or the issued URL). */
  href?: string
  /** The user can act on the step: read the repository again after fixing it. */
  action?: 'recheck'
  /** What the user can do about a failed step, when the reason has a specific next action. */
  help?: string
}

export interface ProgressInput {
  view: AppView
  /** Source repository bound to the stack, when the app was created from a ひな形 or an existing repository. */
  sourceRepository?: ApplicationSourceRepository
  /** shareSentence() of the app, e.g. "営業1課 に公開". */
  shareSentence: string
  access?: AccessDisplay
}

/**
 * The creating view replaces the status sentence until the app has been up
 * once: a release succeeded and the URL was issued. Later redeploys or
 * failures of an app that was already up use the plain status sentence.
 */
export function showsCreateProgress(view: AppView): boolean {
  if (view.draft) return view.status === 'deploying'
  if (view.status === 'live' || view.status === 'unknown') return false
  const facts = view.platform?.facts
  return !(facts?.everReleased && facts.publishPhase === 'succeeded')
}

/** `github.com/acme/mitsumori` from `https://github.com/acme/mitsumori(.git)`. */
export function repositoryLabel(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\.git$/, '').replace(/\/$/, '')
}

const REPOSITORY_FAILED: Partial<Record<ApplicationSourceRepository['status'], true>> = {
  failed: true,
  conflict: true,
  'permission-denied': true,
}

function repositoryConditionStatus(repository: ApplicationSourceRepository | undefined, type: string): string | undefined {
  if (!repository) return undefined
  for (const condition of repository.conditions) {
    if (condition.type === type) return condition.status
  }
  return undefined
}

/**
 * 作ったコードから: the adopted repository's readiness. A missing Dockerfile
 * stops the line until the user adds one; a proposed build setup waits for
 * the user to merge the pull request the platform opened.
 */
function checkStep(repository: ApplicationSourceRepository, fullName: string): ProgressStep {
  const href = repository.repositoryUrl ?? `https://github.com/${fullName}`
  const where = { detail: fullName, href }
  const readiness = repository.readiness
  if (readiness?.dockerfile === 'missing') {
    return { key: 'check', state: 'failed', title: copy.progress.check.dockerfileMissing, detail: copy.progress.check.dockerfileHint, href, action: 'recheck' }
  }
  if (readiness?.workflow === 'proposed') {
    const pr = readiness.proposedPullRequestUrl
    return { key: 'check', state: 'active', title: copy.progress.check.workflowProposed, ...(pr ? { detail: repositoryLabel(pr), href: pr } : where) }
  }
  if (readiness?.dockerfile === 'present' && readiness.workflow === 'present') {
    return { key: 'check', state: 'done', title: copy.progress.check.done, ...where }
  }
  if (REPOSITORY_FAILED[repository.status]) {
    return { key: 'check', state: 'failed', title: copy.progress.check.failed, ...where }
  }
  return { key: 'check', state: 'active', title: copy.progress.check.active, ...where }
}

export function deriveCreateProgress({ view, sourceRepository, shareSentence, access }: ProgressInput): ProgressStep[] {
  const facts = view.platform?.facts
  const fromRepository = sourceRepository !== undefined || view.stack?.sourceKind === 'application-source-repository'
  const adopted = sourceRepository?.existing
  const check = sourceRepository && adopted ? checkStep(sourceRepository, adopted.repository) : undefined
  const imageStatus = repositoryConditionStatus(sourceRepository, 'ImageReady')
  const actionsUrl = sourceRepository?.repositoryUrl ? `${sourceRepository.repositoryUrl}/actions` : undefined

  // 1. 置き場 (template / existing repository) or 準備 (image path).
  let source: ProgressStep
  if (check && check.state !== 'done') {
    source = { key: 'source', state: 'pending', title: copy.progress.connect.active }
  } else if (fromRepository) {
    // Ownership problems (conflict, permission) belong to the repository even
    // after it exists; a plain `failed` once it exists is the image build's.
    const state: StepState = !sourceRepository
      ? 'active'
      : sourceRepository.status !== 'failed' && REPOSITORY_FAILED[sourceRepository.status]
        ? 'failed'
        : sourceRepository.status === 'ready' || repositoryConditionStatus(sourceRepository, 'RepositoryCreated') === 'True'
          ? 'done'
          : REPOSITORY_FAILED[sourceRepository.status]
            ? 'failed'
            : 'active'
    const url = sourceRepository?.repositoryUrl
    const titles = check ? copy.progress.connect : copy.progress.source
    source = {
      key: 'source',
      state,
      title: state === 'done' ? titles.done : state === 'failed' ? titles.failed : titles.active,
      ...(url ? { detail: repositoryLabel(url), href: url } : {}),
    }
  } else {
    const state: StepState = view.stack ? 'done' : 'active'
    source = { key: 'source', state, title: state === 'done' ? copy.progress.setup.done : copy.progress.setup.active }
  }

  // 2. 最初の版: build the image, then wait for a succeeded web release or Ready web component.
  let release: ProgressStep
  if (source.state !== 'done') {
    release = { key: 'release', state: 'pending', title: copy.progress.release.active }
  } else if (facts?.webReleasePhase === 'Succeeded' || facts?.everReleased || facts?.webReady) {
    release = { key: 'release', state: 'done', title: copy.progress.release.done }
  } else if (imageStatus === 'False') {
    release = {
      key: 'release',
      state: 'failed',
      title: copy.progress.release.failed,
      detail: copy.progress.release.imageFailed,
      ...(actionsUrl ? { href: actionsUrl } : {}),
    }
  } else if (facts?.webReleasePhase === 'Failed' || view.status === 'failed') {
    release = {
      key: 'release',
      state: 'failed',
      title: copy.progress.release.failed,
      detail: view.text,
      ...(view.help ? { help: view.help } : {}),
    }
  } else if (sourceRepository && sourceRepository.status !== 'ready' && imageStatus !== 'True') {
    release = {
      key: 'release',
      state: 'active',
      title: copy.progress.release.active,
      detail: copy.progress.release.imageBuilding,
      ...(actionsUrl ? { href: actionsUrl } : {}),
    }
  } else {
    release = { key: 'release', state: 'active', title: copy.progress.release.active, detail: copy.progress.release.hint }
  }

  // 3. URL: publish succeeded with a URL.
  let url: ProgressStep
  if (release.state !== 'done') {
    url = { key: 'url', state: 'pending', title: copy.progress.url.active }
  } else if (facts?.publishPhase === 'failed') {
    url = { key: 'url', state: 'failed', title: copy.progress.url.failed, detail: copy.publishPhase.failed }
  } else if (facts?.publishPhase === 'succeeded' && view.url) {
    url = { key: 'url', state: 'done', title: copy.progress.url.done, detail: view.url, href: view.url }
  } else {
    url = {
      key: 'url',
      state: 'active',
      title: copy.progress.url.active,
      detail: facts?.publishPhase ? copy.publishPhase[facts.publishPhase] : copy.statusText.publishUrlMissing,
    }
  }

  // A URL alone is not proof that the requested audience is enforced.
  const share: ProgressStep = {
    key: 'share',
    state: url.state !== 'done' ? 'pending' : access?.applied ? 'done' : access?.state === 'unapplied' || access?.state === 'failed' ? 'failed' : 'active',
    title: sharingCopy.progress,
    detail: access?.label ?? copy.progress.share.active(shareSentence),
  }

  return check ? [check, source, release, url, share] : [source, release, url, share]
}
