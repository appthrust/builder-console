import { describe, expect, test } from 'bun:test'
import type { ApplicationSourceRepository } from '@appthrust/api-schema/platform-api'
import { stackOf } from '../api/testing/app-domain'
import { copy } from '../copy'
import type { AppView, ConsoleApp, ConsoleAppFacts } from './app'
import { deriveCreateProgress, repositoryLabel, showsCreateProgress, type ProgressStep } from './progress'
import { shareSentence, widensShare } from './share'

const stackWire = {
  id: 'mitsumori',
  projectId: 'pj',
  templateId: 'nextjs-postgres',
  applicationName: 'mitsumori',
  sourceKind: 'application-source-repository',
  applicationId: 'mitsumori',
  branchId: 'production',
  webComponentId: 'mitsumori-web',
  pendingSync: false,
}
const stack = stackOf(stackWire)

const repository = (status: ApplicationSourceRepository['status'], conditions: ApplicationSourceRepository['conditions'] = []): ApplicationSourceRepository => ({
  id: 'mitsumori-src',
  projectId: 'pj',
  template: { repository: 'appthrust/template-nextjs' },
  destination: { repositoryName: 'mitsumori' },
  image: { imagePath: 'ghcr.io/acme/mitsumori' },
  status,
  conditions,
  ...(status === 'ready' || conditions.some((condition) => condition.type === 'RepositoryCreated' && condition.status === 'True')
    ? { repositoryUrl: 'https://github.com/acme/mitsumori' }
    : {}),
})

const noFacts: ConsoleAppFacts = { webReady: false, everReleased: false, hasPublish: true }

function view(facts: Partial<ConsoleAppFacts>, extra: Partial<AppView> = {}): AppView {
  const platform: ConsoleApp = {
    id: 'mitsumori',
    name: 'mitsumori',
    status: 'deploying',
    statusText: '',
    branchId: 'production',
    facts: { ...noFacts, ...facts },
  }
  return { status: 'deploying', label: '準備中', text: '', second: '', draft: false, stack, platform, ...extra }
}

const states = (steps: ProgressStep[]) => steps.map((step) => step.state)

describe('deriveCreateProgress', () => {
  test('repository pending without RepositoryCreated: step 1 active, the rest waiting', () => {
    const steps = deriveCreateProgress({ view: view({}), sourceRepository: repository('pending'), shareSentence: '営業1課 に公開' })
    expect(states(steps)).toEqual(['active', 'pending', 'pending', 'pending'])
    expect(steps[0]?.title).toBe(copy.progress.source.active)
    expect(steps[3]?.title).toBe('公開範囲')
  })

  test('repository created: source is done while GitHub builds the first version', () => {
    const steps = deriveCreateProgress({
      view: view({}),
      sourceRepository: repository('pending', [{ type: 'RepositoryCreated', status: 'True', reason: 'RepositoryReady' }]),
      shareSentence: '営業1課 に公開',
    })
    expect(states(steps)).toEqual(['done', 'active', 'pending', 'pending'])
    expect(steps[0]).toMatchObject({
      title: copy.progress.source.done,
      detail: 'github.com/acme/mitsumori',
      href: 'https://github.com/acme/mitsumori',
    })
    expect(steps[1]).toMatchObject({
      title: copy.progress.release.active,
      detail: copy.progress.release.imageBuilding,
      href: 'https://github.com/acme/mitsumori/actions',
    })
  })

  test('image build failed: the existing repository stays done and the release links GitHub Actions', () => {
    const sourceRepository = repository('failed', [
      { type: 'RepositoryCreated', status: 'True', reason: 'RepositoryReady' },
      { type: 'ImageReady', status: 'False', reason: 'BuildFailed' },
    ])
    for (const status of ['deploying', 'failed'] as const) {
      const steps = deriveCreateProgress({ view: view({}, { status, text: '理由' }), sourceRepository, shareSentence: 'x' })
      expect(states(steps)).toEqual(['done', 'failed', 'pending', 'pending'])
      expect(steps[0]?.title).toBe(copy.progress.source.done)
      expect(steps[1]).toMatchObject({
        title: copy.progress.release.failed,
        detail: copy.progress.release.imageFailed,
        href: 'https://github.com/acme/mitsumori/actions',
      })
    }
  })

  test('repository creation failed: the source fails and the release waits', () => {
    const steps = deriveCreateProgress({
      view: view({}),
      sourceRepository: repository('failed', [{ type: 'RepositoryCreated', status: 'False' }]),
      shareSentence: 'x',
    })
    expect(states(steps)).toEqual(['failed', 'pending', 'pending', 'pending'])
    expect(steps[0]?.title).toBe(copy.progress.source.failed)
  })

  test('image ready with the release running: keep the release hint, not the build detail or completion', () => {
    const steps = deriveCreateProgress({
      view: view({ webReleasePhase: 'InProgress' }),
      sourceRepository: repository('pending', [
        { type: 'RepositoryCreated', status: 'True', reason: 'RepositoryReady' },
        { type: 'ImageReady', status: 'True' },
      ]),
      shareSentence: 'x',
    })
    expect(states(steps)).toEqual(['done', 'active', 'pending', 'pending'])
    expect(steps[1]?.detail).toBe(copy.progress.release.hint)
    expect(steps[1]?.href).toBeUndefined()
  })

  test('repository ready, first release running: link to the repository and the 2〜5 分 hint', () => {
    const steps = deriveCreateProgress({
      view: view({ webReleasePhase: 'InProgress' }),
      sourceRepository: repository('ready'),
      shareSentence: '営業1課 に公開',
    })
    expect(states(steps)).toEqual(['done', 'active', 'pending', 'pending'])
    expect(steps[0]).toMatchObject({ detail: 'github.com/acme/mitsumori', href: 'https://github.com/acme/mitsumori' })
    expect(steps[1]?.detail).toBe(copy.progress.release.hint)
  })

  test('release done, publish propagating: URL step explains the publish phase', () => {
    const steps = deriveCreateProgress({
      view: view({ webReleasePhase: 'Succeeded', everReleased: true, publishPhase: 'dns_propagating' }),
      sourceRepository: repository('ready'),
      shareSentence: '全社に公開',
    })
    expect(states(steps)).toEqual(['done', 'done', 'active', 'pending'])
    expect(steps[2]?.detail).toBe(copy.publishPhase.dns_propagating)
  })

  test('all done only after the URL and matching access are applied', () => {
    const steps = deriveCreateProgress({
      view: view({ webReady: true, publishPhase: 'succeeded' }, { url: 'https://mitsumori.pj.example/' }),
      sourceRepository: repository('ready'),
      shareSentence: '全社に公開',
      access: { applied: true, state: 'applied', label: '社員のみ' },
    })
    expect(states(steps)).toEqual(['done', 'done', 'done', 'done'])
    expect(steps[2]?.href).toBe('https://mitsumori.pj.example/')
    expect(steps[3]).toMatchObject({ title: '公開範囲', detail: '社員のみ' })
  })

  test('URL readiness never completes a missing, mismatched or pending access policy', () => {
    for (const access of [undefined, { applied: false, state: 'pending' as const, label: '反映中' }, { applied: false, state: 'unapplied' as const, label: '公開中（誰でも）' }]) {
      const steps = deriveCreateProgress({ view: view({ webReady: true, publishPhase: 'succeeded' }, { url: 'https://app.example/' }), sourceRepository: repository('ready'), shareSentence: '自分だけに公開', access })
      expect(steps[2]?.state).toBe('done')
      expect(steps[3]?.state).not.toBe('done')
    }
  })

  test('a rejected access write fails the share step even when the URL is ready', () => {
    const access = { applied: false, state: 'failed' as const, label: '公開範囲の反映に失敗' }
    const steps = deriveCreateProgress({ view: view({ webReady: true, publishPhase: 'succeeded' }, { url: 'https://app.example/' }), sourceRepository: repository('ready'), shareSentence: '自分だけに公開', access })
    expect(steps[3]).toMatchObject({ state: 'failed', detail: access.label })
  })

  test('conflict or permission loss fails the source even after the repository was created', () => {
    const created = [{ type: 'RepositoryCreated', status: 'True', reason: 'RepositoryReady' }]
    for (const status of ['conflict', 'permission-denied'] as const) {
      const steps = deriveCreateProgress({ view: view({}), sourceRepository: repository(status, created), shareSentence: 'x' })
      expect(states(steps)).toEqual(['failed', 'pending', 'pending', 'pending'])
      expect(steps[0]?.title).toBe(copy.progress.source.failed)
    }
  })

  test('failures stop the line at the failing step', () => {
    expect(
      states(deriveCreateProgress({ view: view({}), sourceRepository: repository('permission-denied'), shareSentence: 'x' }))
    ).toEqual(['failed', 'pending', 'pending', 'pending'])
    expect(
      states(
        deriveCreateProgress({ view: view({ webReleasePhase: 'Failed' }), sourceRepository: repository('ready'), shareSentence: 'x' })
      )
    ).toEqual(['done', 'failed', 'pending', 'pending'])
    expect(
      states(
        deriveCreateProgress({
          view: view({ webReady: true, publishPhase: 'failed' }),
          sourceRepository: repository('ready'),
          shareSentence: 'x',
        })
      )
    ).toEqual(['done', 'done', 'failed', 'pending'])
  })

  test('a failure with a specific next action puts it on the failed release step', () => {
    const failed = view({}, { status: 'failed', label: '問題あり', text: '理由', help: '次にすること' })
    const release = deriveCreateProgress({ view: failed, sourceRepository: repository('ready'), shareSentence: 'x' })[1]
    expect(release).toMatchObject({ key: 'release', state: 'failed', detail: '理由', help: '次にすること' })
    const { help: _help, ...withoutHelp } = failed
    const plain = deriveCreateProgress({ view: withoutHelp, sourceRepository: repository('ready'), shareSentence: 'x' })[1]
    expect(plain?.help).toBeUndefined()
  })

  test('image path: step 1 is the setup step, done once the stack exists', () => {
    const imageStack = stackOf({ ...stackWire, sourceKind: 'sample-image' })
    const steps = deriveCreateProgress({ view: view({}, { stack: imageStack }), shareSentence: 'x' })
    expect(steps[0]).toMatchObject({ state: 'done', title: copy.progress.setup.done })
    expect(steps[1]?.state).toBe('active')
  })

  test('draft without a stack yet: everything is still ahead', () => {
    const steps = deriveCreateProgress({
      view: { status: 'deploying', label: '準備中', text: '', second: '', draft: true },
      shareSentence: 'x',
    })
    expect(states(steps)).toEqual(['active', 'pending', 'pending', 'pending'])
  })
})

describe('作ったコードから: repository check leads', () => {
  const adopted = (
    readiness: ApplicationSourceRepository['readiness'],
    status: ApplicationSourceRepository['status'] = 'pending',
    conditions: ApplicationSourceRepository['conditions'] = [],
  ): ApplicationSourceRepository => ({
    id: 'claude-mitsumori-src',
    projectId: 'pj',
    existing: { repository: 'acme/claude-mitsumori', ref: 'main' },
    image: { imagePath: 'ghcr.io/acme/claude-mitsumori' },
    status,
    conditions,
    ...(readiness ? { readiness } : {}),
    ...(status === 'ready' || conditions.some((condition) => condition.type === 'RepositoryCreated' && condition.status === 'True')
      ? { repositoryUrl: 'https://github.com/acme/claude-mitsumori' }
      : {}),
  })

  test('not checked yet: the check is active and links the repository', () => {
    const steps = deriveCreateProgress({ view: view({}), sourceRepository: adopted(undefined), shareSentence: 'x' })
    expect(steps.map((step) => step.key)).toEqual(['check', 'source', 'release', 'url', 'share'])
    expect(states(steps)).toEqual(['active', 'pending', 'pending', 'pending', 'pending'])
    expect(steps[0]).toMatchObject({ title: copy.progress.check.active, detail: 'acme/claude-mitsumori', href: 'https://github.com/acme/claude-mitsumori' })
  })

  test('Dockerfile missing: a problem naming the expected path, with 「もう一度確認」', () => {
    const steps = deriveCreateProgress({ view: view({}), sourceRepository: adopted({ dockerfile: 'missing', workflow: 'missing' }), shareSentence: 'x' })
    expect(steps[0]).toMatchObject({
      state: 'failed',
      title: copy.progress.check.dockerfileMissing,
      detail: copy.progress.check.dockerfileHint,
      action: 'recheck',
    })
    expect(steps[0]?.detail).toContain('Dockerfile')
    expect(states(steps).slice(1)).toEqual(['pending', 'pending', 'pending', 'pending'])
  })

  test('build setup proposed: waits for the merge, linking the pull request', () => {
    const pr = 'https://github.com/acme/claude-mitsumori/pull/7'
    const steps = deriveCreateProgress({
      view: view({}),
      sourceRepository: adopted({ dockerfile: 'present', workflow: 'proposed', proposedPullRequestUrl: pr }),
      shareSentence: 'x',
    })
    expect(steps[0]).toMatchObject({ state: 'active', title: copy.progress.check.workflowProposed, href: pr, detail: 'github.com/acme/claude-mitsumori/pull/7' })
    expect(steps[1]?.state).toBe('pending')
  })

  test('ready: the check and connect steps are done; without adoption the connect step still waits', () => {
    const steps = deriveCreateProgress({
      view: view({ webReleasePhase: 'InProgress' }),
      sourceRepository: adopted({ dockerfile: 'present', workflow: 'present' }, 'ready'),
      shareSentence: 'x',
    })
    expect(states(steps)).toEqual(['done', 'done', 'active', 'pending', 'pending'])
    expect(steps[1]?.title).toBe(copy.progress.connect.done)
    const connecting = deriveCreateProgress({ view: view({}), sourceRepository: adopted({ dockerfile: 'present', workflow: 'present' }), shareSentence: 'x' })
    expect(connecting[1]).toMatchObject({ state: 'active', title: copy.progress.connect.active })
  })

  test('repository adopted after the check: connect is done while GitHub builds the first version', () => {
    const steps = deriveCreateProgress({
      view: view({}),
      sourceRepository: adopted({ dockerfile: 'present', workflow: 'present' }, 'pending', [
        { type: 'RepositoryCreated', status: 'True', reason: 'RepositoryAdopted' },
      ]),
      shareSentence: 'x',
    })
    expect(states(steps)).toEqual(['done', 'done', 'active', 'pending', 'pending'])
    expect(steps[0]?.title).toBe(copy.progress.check.done)
    expect(steps[1]).toMatchObject({ title: copy.progress.connect.done, href: 'https://github.com/acme/claude-mitsumori' })
    expect(steps[2]).toMatchObject({
      title: copy.progress.release.active,
      detail: copy.progress.release.imageBuilding,
      href: 'https://github.com/acme/claude-mitsumori/actions',
    })
  })

  test('adopted repository image failure belongs to the release after the check and connection complete', () => {
    const steps = deriveCreateProgress({
      view: view({}),
      sourceRepository: adopted({ dockerfile: 'present', workflow: 'present' }, 'failed', [
        { type: 'RepositoryCreated', status: 'True', reason: 'RepositoryAdopted' },
        { type: 'ImageReady', status: 'False' },
      ]),
      shareSentence: 'x',
    })
    expect(states(steps)).toEqual(['done', 'done', 'failed', 'pending', 'pending'])
    expect(steps[1]?.title).toBe(copy.progress.connect.done)
    expect(steps[2]).toMatchObject({
      title: copy.progress.release.failed,
      detail: copy.progress.release.imageFailed,
      href: 'https://github.com/acme/claude-mitsumori/actions',
    })
  })

  test('an unavailable repository fails the check', () => {
    const steps = deriveCreateProgress({ view: view({}), sourceRepository: adopted(undefined, 'permission-denied'), shareSentence: 'x' })
    expect(steps[0]).toMatchObject({ state: 'failed', title: copy.progress.check.failed })
    expect(steps[0]?.action).toBeUndefined()
  })
})

describe('showsCreateProgress', () => {
  test('only until the app has been up once (a succeeded release and an issued URL)', () => {
    expect(showsCreateProgress(view({}))).toBe(true)
    expect(showsCreateProgress(view({ everReleased: true, publishPhase: 'dns_propagating' }))).toBe(true)
    expect(showsCreateProgress(view({ everReleased: true, publishPhase: 'succeeded' }))).toBe(false)
    expect(showsCreateProgress(view({}, { status: 'live' }))).toBe(false)
    expect(showsCreateProgress(view({}, { status: 'unknown' }))).toBe(false)
    expect(showsCreateProgress({ status: 'deploying', label: '', text: '', second: '', draft: true })).toBe(true)
    expect(showsCreateProgress({ status: 'failed', label: '', text: '', second: '', draft: true })).toBe(false)
  })
})

test('repositoryLabel strips the scheme and .git', () => {
  expect(repositoryLabel('https://github.com/acme/mitsumori.git')).toBe('github.com/acme/mitsumori')
})

describe('share', () => {
  const groups = [
    { id: 'g1', name: '営業1課' },
    { id: 'g2', name: '営業2課' },
  ]
  test('names the groups the company uses', () => {
    expect(shareSentence({ scope: 'group', groupIds: ['g1', 'g2'], extraPersonIds: [] }, groups)).toBe('営業1課・営業2課 に公開')
    expect(shareSentence({ scope: 'private', groupIds: [], extraPersonIds: [] }, groups)).toBe('自分だけに公開')
    expect(shareSentence({ scope: 'company', groupIds: [], extraPersonIds: [] }, groups)).toBe('全社に公開')
    expect(shareSentence({ scope: 'public', groupIds: [], extraPersonIds: [] }, groups)).toBe('社外にも公開')
    expect(
      shareSentence({ scope: 'group', groupIds: ['g9'], extraPersonIds: [] }, [], { id: 'g9', path: 'a', name: '総務' })
    ).toBe('総務 に公開')
  })

  test('widening: broader scope or an added group', () => {
    const group = { scope: 'group' as const, groupIds: ['g1'], extraPersonIds: [] }
    expect(widensShare(group, { ...group, scope: 'company' })).toBe(true)
    expect(widensShare(group, { ...group, groupIds: ['g1', 'g2'] })).toBe(true)
    expect(widensShare(group, { ...group, scope: 'private' })).toBe(false)
    expect(widensShare({ ...group, groupIds: ['g1', 'g2'] }, group)).toBe(false)
  })
})
