import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { consoleRoutes } from './mock-console'
import { imageInfo, mockScreenPng } from './mock-images'
import { platformRoutes } from './mock-platform'

async function call(method: string, path: string, body?: unknown) {
  const url = new URL(path, 'http://mock.test')
  const routes = url.pathname.startsWith('/api/v1/') ? platformRoutes : consoleRoutes
  const response = await routes(
    new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    url,
  )
  if (!response) throw new Error(`unhandled ${method} ${path}`)
  return { status: response.status, body: response.status === 204 ? undefined : await response.json() }
}

test('resolve follows the seeded redirect for a moved group, including app paths below it', async () => {
  expect((await call('GET', '/api/console/resolve?path=/sales/tokyo')).body).toMatchObject({ kind: 'group', currentPath: 'sales/east' })
  expect((await call('GET', '/api/console/resolve?path=/sales/tokyo/team-a/mitsumori')).body).toMatchObject({
    kind: 'app',
    currentPath: 'sales/east/team-a/mitsumori',
  })
  expect((await call('GET', '/api/console/resolve?path=/nope')).status).toBe(404)
})

test('console reset restores seeded apps, groups, people, memberships, redirects and write toggles', async () => {
  expect(await call('POST', '/api/console/__mock/reset')).toEqual({ status: 200, body: { reset: true } })
  const paths = ['/apps', '/directory/groups', '/directory/people', '/directory/directory-users', '/directory/groups/g-team-a/members', '/me']
  const baseline = await Promise.all(paths.map((path) => call('GET', `/api/console${path}`)))
  const originalRole = process.env.MOCK_ROLE
  try {
    const created = await call('POST', '/api/console/apps', { displayName: 'Reset app', slug: 'reset-app', groupId: 'g-team-a' })
    expect(created).toMatchObject({ status: 201, body: { appName: 'reset-app' } })
    expect((await call('GET', `/api/console/apps/${created.body.id}`)).status).toBe(200)
    expect((await call('POST', '/api/console/directory/people', { email: 'takahashi@example.com', displayName: '高橋 健' })).status).toBe(201)
    expect((await call('POST', '/api/console/__mock/migration', {})).body).toMatchObject({ pending: true })
    expect((await call('PATCH', '/api/console/apps/a-mitsumori', { slug: 'temporary-app' })).status).toBe(200)
    expect((await call('PATCH', '/api/console/apps/a-mitsumori', { slug: 'mitsumori', share: { scope: 'private', groupIds: [], extraPersonIds: [] } })).status).toBe(200)
    expect((await call('DELETE', '/api/console/apps/a-nippo')).status).toBe(204)
    expect((await call('POST', '/api/console/__mock/app-draft', {})).status).toBe(200)
    expect((await call('POST', '/api/console/__mock/bare-500', { times: 3 })).status).toBe(200)

    expect(await call('POST', '/api/console/__mock/reset')).toEqual({ status: 200, body: { reset: true } })
    expect(await Promise.all(paths.map((path) => call('GET', `/api/console${path}`)))).toEqual(baseline)
    expect((await call('GET', '/api/console/resolve?path=sales/east/team-a/temporary-app')).status).toBe(404)
    expect((await call('GET', '/api/console/resolve?path=sales/tokyo')).body).toMatchObject({ currentPath: 'sales/east' })
    expect((await call('GET', `/api/console/apps/${created.body.id}`)).status).toBe(404)
    expect((await call('POST', '/api/console/apps', { displayName: 'Reset app', slug: 'reset-app', groupId: 'g-team-a' })).body.appName).toBe('reset-app')

    process.env.MOCK_ROLE = 'Viewer'
    expect((await call('POST', '/api/console/__mock/reset')).status).toBe(200)
    expect((await call('GET', '/api/console/me')).body).toMatchObject({ isConsoleAdmin: false, canCreateApps: false })
  } finally {
    if (originalRole === undefined) delete process.env.MOCK_ROLE
    else process.env.MOCK_ROLE = originalRole
    await call('POST', '/api/console/__mock/reset')
  }
})

test('platform reset restores seeded stacks, lifecycle state, toggles and the ID sequence', async () => {
  const project = '/api/v1/projects/commerce'
  const mock = '/api/v1/__mock'
  expect(await call('POST', `${mock}/reset`)).toEqual({ status: 200, body: { reset: true } })
  const paths = [
    `${project}/application-stacks`,
    `${project}/applications`,
    `${project}/publishes`,
    `${project}/applications/nippo/branches/production/components/nippo-web/env-vars`,
    `${project}/application-templates`,
    `${project}/source-connections/github-source-207cb7ce/repositories`,
    '/api/v1/teams',
    '/api/v1/registry-connections',
    `${project}/application-drafts/creation-tools`,
  ]
  const baseline = await Promise.all(paths.map((path) => call('GET', path)))
  const seededRepositories = (await call('GET', `${project}/application-source-repositories`)).body.data.map((repository: { id: string }) => repository.id)
  const originalEnv = { MOCK_ROLE: process.env.MOCK_ROLE, MOCK_REGISTRY: process.env.MOCK_REGISTRY, MOCK_CODEX: process.env.MOCK_CODEX }
  const stack = { templateId: 'nextjs-postgres', application: { name: 'reset-stack' }, source: { kind: 'sample-image', imageRef: 'ghcr.io/acme/test:edge-v1' } }
  try {
    expect((await call('POST', `${project}/application-stacks`, stack)).status).toBe(202)
    expect((await call('POST', `${project}/application-source-repositories`, { destination: { repositoryName: 'reset-repository' } })).status).toBe(202)
    const draft = await call('POST', `${project}/application-drafts`, { intent: 'Reset test' })
    expect(draft).toMatchObject({ status: 201, body: { id: 'draft-0001' } })
    expect((await call('POST', `${mock}/plan-generation`, { outcome: 'failed', error: 'reset failure', autoAdvance: true, publish: false })).status).toBe(200)
    expect((await call('POST', `${project}/application-drafts/${draft.body.id}/creation-plan-generations`)).status).toBe(202)
    expect((await call('POST', `${mock}/advance`)).body.moved).toBeGreaterThan(0)
    expect((await call('GET', `${project}/application-stacks/reset-stack`)).body.state).toBe('ACTIVE')
    expect((await call('PUT', `${project}/applications/nippo/branches/production/components/nippo-web/env-vars`, { variables: [{ key: 'APP_TITLE', value: 'Changed', sensitive: false }] })).status).toBe(202)
    expect((await call('POST', `${mock}/plan-generation`, { priorGenerations: 2 })).status).toBe(200)
    expect((await call('DELETE', `${project}/application-stacks/mitsumori`)).status).toBe(202)
    expect((await call('POST', `${mock}/logs`, { componentId: 'nippo-web', status: 500 })).status).toBe(200)
    expect((await call('GET', `${project}/components/nippo-web/logs`)).status).toBe(500)
    expect((await call('POST', `${mock}/role`, { role: 'Viewer' })).status).toBe(200)
    expect((await call('POST', `${mock}/registry`, { connected: false })).status).toBe(200)
    expect((await call('POST', `${mock}/codex`, { available: false })).status).toBe(200)
    expect((await call('POST', `${mock}/reject-next-validation`)).status).toBe(200)
    expect((await call('POST', `${mock}/stack-conflict`, { reason: 'delivery_pending' })).status).toBe(200)
    expect((await call('POST', `${mock}/github-repository`, { name: 'reset-conflict' })).status).toBe(200)

    expect(await call('POST', `${mock}/reset`)).toEqual({ status: 200, body: { reset: true } })
    expect(await Promise.all(paths.map((path) => call('GET', path)))).toEqual(baseline)
    expect((await call('GET', `${project}/application-source-repositories`)).body.data.map((repository: { id: string }) => repository.id)).toEqual(seededRepositories)
    expect((await call('GET', `${project}/application-drafts`)).body.data).toEqual([])
    expect((await call('GET', `${mock}/logs?componentId=nippo-web`)).body).toEqual({ status: 200, requests: 0 })
    expect((await call('POST', `${mock}/plan-generation`, {})).body).toEqual({ outcome: 'succeeded', error: '', autoAdvance: false, priorGenerations: 0, publish: true })
    expect((await call('POST', `${project}/application-stacks/validate`, stack)).body.valid).toBe(true)
    expect((await call('POST', `${project}/application-stacks`, stack)).status).toBe(202)
    for (const repositoryName of ['reset-repository', 'reset-conflict']) {
      expect((await call('POST', `${project}/application-source-repositories/validate`, { destination: { repositoryName } })).body.valid).toBe(true)
    }
    const nextDraft = await call('POST', `${project}/application-drafts`, { intent: 'Reset test' })
    expect(nextDraft.body.id).toBe('draft-0001')
    const generation = await call('POST', `${project}/application-drafts/${nextDraft.body.id}/creation-plan-generations`)
    expect(generation).toMatchObject({ status: 202, body: { id: 'gen-0003', status: 'pending' } })
    const generationPath = `${project}/application-drafts/${nextDraft.body.id}/creation-plan-generations/${generation.body.id}`
    expect((await call('GET', generationPath)).body.status).toBe('pending')
    for (let step = 0; step < 3; step++) {
      await call('POST', `${mock}/advance`)
      expect((await call('GET', generationPath)).body.status).toBe('running')
    }
    await call('POST', `${mock}/advance`)
    expect((await call('GET', generationPath)).body.status).toBe('succeeded')

    process.env.MOCK_ROLE = 'Viewer'
    process.env.MOCK_REGISTRY = 'off'
    process.env.MOCK_CODEX = 'off'
    expect((await call('POST', `${mock}/reset`)).status).toBe(200)
    expect((await call('GET', '/api/v1/teams')).body.items[0].role).toBe('Viewer')
    expect((await call('GET', '/api/v1/registry-connections')).body.data).toEqual([])
    expect((await call('GET', `${project}/application-drafts/creation-tools`)).body.codexAvailable).toBe(false)
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await call('POST', `${mock}/reset`)
  }
})

describe('access request routes', () => {
  const requests = '/api/console/access-requests'
  const keihi = '/api/console/apps/a-keihi'
  const seededRequest = `${keihi}/access-requests/aar-keihi-suzuki`
  const caller = (personId: string, role = 'Viewer') => call('POST', '/api/console/__mock/caller', { personId, role })
  beforeEach(async () => { await call('POST', '/api/console/__mock/reset') })
  afterEach(async () => { await call('POST', '/api/console/__mock/reset') })

  test('approval updates the app and request together, granting only viewer access', async () => {
    expect((await call('GET', `${requests}?status=pending`)).body).toMatchObject([
      { id: 'aar-keihi-suzuki', appId: 'a-keihi', requester: { id: 'p-suzuki' }, status: 'pending' },
    ])
    const approved = await call('POST', `${seededRequest}/approve`)
    expect(approved).toMatchObject({
      status: 200,
      body: {
        request: { status: 'approved', decidedBy: { id: 'p-yamada' } },
        app: { share: { scope: 'private', extraPersonIds: ['p-suzuki'] }, owners: [{ id: 'p-yamada' }] },
      },
    })
    expect(approved.body.request.decidedAt).toBeString()
    expect((await call('GET', keihi)).body).toEqual(approved.body.app)
    expect((await call('GET', `${requests}?status=pending`)).body).toEqual([])
    expect((await call('GET', `${keihi}/access-requests`)).body).toEqual([approved.body.request])
    expect(await call('POST', `${seededRequest}/approve`)).toMatchObject({ status: 409, body: { error: 'conflict' } })
    await caller('p-suzuki')
    expect((await call('GET', `${requests}/mine?appName=keihi`)).body.state).toBe('granted')
    expect((await call('GET', keihi)).status).toBe(200)
    expect((await call('PATCH', keihi, { displayName: 'Not an editor' })).status).toBe(403)
  })

  test('decline leaves sharing untouched, allows a new request, and pending creation is idempotent', async () => {
    const before = (await call('GET', keihi)).body
    expect(await call('POST', `${seededRequest}/decline`)).toMatchObject({
      status: 200, body: { request: { status: 'declined', decidedBy: { id: 'p-yamada' } } },
    })
    expect((await call('GET', keihi)).body).toEqual(before)
    await caller('p-suzuki')
    expect((await call('GET', `${requests}/mine?appName=keihi`)).body.state).toBe('declined')
    const created = await call('POST', requests, { appName: 'keihi', message: 'もう一度お願いします' })
    expect(created).toMatchObject({ status: 201, body: { state: 'pending' } })
    expect(await call('POST', requests, { appName: 'keihi', message: 'duplicate' })).toEqual({ ...created, status: 200 })
    await caller('p-yamada')
    const rows = (await call('GET', `${keihi}/access-requests`)).body
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ status: 'pending', message: 'もう一度お願いします' })
    expect(rows[0].id).not.toBe('aar-keihi-suzuki')
    expect(rows[1].status).toBe('declined')
  })

  test('mine derives granted from current visibility, not a past approval', async () => {
    await call('POST', `${seededRequest}/approve`)
    await call('PATCH', keihi, { share: { scope: 'private', groupIds: [], extraPersonIds: [] } })
    await caller('p-suzuki')
    expect((await call('GET', `${requests}/mine?appName=keihi`)).body).toEqual({ appName: 'keihi', exists: true, state: 'none' })
    expect((await call('POST', requests, { appName: 'keihi', message: '' })).status).toBe(201)
    expect((await call('GET', `${requests}/mine?appName=mitsumori`)).body.state).toBe('granted')
    expect(await call('POST', requests, { appName: 'mitsumori', message: '' })).toEqual({ status: 200, body: { state: 'granted' } })
  })

  test('non-members may inspect and create their own requests but not list or decide requests', async () => {
    await caller('p-tanaka')
    await call('POST', '/api/console/__mock/not-member', {})
    expect((await call('GET', `${requests}/mine?appName=keihi`)).body).toEqual({ appName: 'keihi', exists: true, state: 'none' })
    expect((await call('POST', requests, { appName: 'keihi', message: '確認します' })).status).toBe(201)
    expect((await call('GET', `${requests}/mine?appName=keihi`)).body.state).toBe('pending')
    for (const [method, path] of [
      ['GET', `${requests}?status=pending`],
      ['GET', `${keihi}/access-requests`],
      ['POST', `${seededRequest}/approve`],
      ['POST', `${seededRequest}/decline`],
    ]) {
      expect(await call(method, path)).toMatchObject({ status: 403, body: { error: 'not_project_member' } })
    }
  })

  test('only editors see requests, and a request cannot be decided through another app', async () => {
    expect((await call('POST', '/api/console/apps/a-mitsumori/access-requests/aar-keihi-suzuki/approve')).status).toBe(404)
    await caller('p-suzuki')
    expect((await call('GET', `${requests}?status=pending`)).body).toEqual([])
    expect((await call('GET', `${keihi}/access-requests`)).status).toBe(403)
    expect((await call('POST', `${seededRequest}/approve`)).status).toBe(403)
    expect((await call('POST', `${seededRequest}/decline`)).status).toBe(403)
    await caller('p-sato')
    expect((await call('GET', `${requests}?status=pending`)).body).toHaveLength(1)
    expect((await call('POST', `${seededRequest}/approve`)).status).toBe(200)
  })

  test('approval does not duplicate a requester who is already visible or an owner', async () => {
    for (const patch of [
      { share: { scope: 'company', groupIds: [], extraPersonIds: [] } },
      { share: { scope: 'public', groupIds: [], extraPersonIds: [] } },
      { share: { scope: 'group', groupIds: ['g-team-a'], extraPersonIds: [] } },
      { share: { scope: 'private', groupIds: [], extraPersonIds: ['p-suzuki'] } },
      { ownerIds: ['p-yamada', 'p-suzuki'] },
    ]) {
      await call('POST', '/api/console/__mock/reset')
      await call('PATCH', keihi, patch)
      const before = (await call('GET', keihi)).body
      const approved = await call('POST', `${seededRequest}/approve`)
      expect(approved.body.request.status).toBe('approved')
      expect(approved.body.app.share).toEqual(before.share)
      expect(approved.body.app.owners).toEqual(before.owners)
    }
  })

  test('unknown apps reveal only existence and invalid slugs and overlong messages are rejected', async () => {
    await caller('p-tanaka')
    expect(await call('GET', `${requests}/mine?appName=missing`)).toEqual({ status: 200, body: { appName: 'missing', exists: false } })
    expect((await call('POST', requests, { appName: 'missing', message: '' })).status).toBe(404)
    for (const appName of ['', 'api', 'not/a/slug']) {
      expect(await call('GET', `${requests}/mine?appName=${encodeURIComponent(appName)}`)).toMatchObject({ status: 400, body: { error: 'invalid_request' } })
      expect((await call('POST', requests, { appName, message: '' })).status).toBe(400)
    }
    expect(await call('POST', requests, { appName: 'keihi', message: '字'.repeat(501) })).toMatchObject({ status: 400, body: { error: 'invalid_request' } })
    expect((await call('POST', requests, { appName: 'keihi', message: '𠮷'.repeat(500) })).status).toBe(201)
  })

  test('a person may have at most twenty pending requests, with duplicate requests still idempotent', async () => {
    const appNames: string[] = []
    for (let index = 0; index < 21; index++) {
      const created = await call('POST', '/api/console/apps', {
        displayName: `Limit ${index}`, slug: `limit-${index}`, groupId: 'g-team-a',
        share: { scope: 'private', groupIds: [], extraPersonIds: [] },
      })
      appNames.push(created.body.appName)
    }
    await caller('p-tanaka')
    for (const appName of appNames.slice(0, 20)) {
      expect((await call('POST', requests, { appName, message: '' })).status).toBe(201)
    }
    expect((await call('POST', requests, { appName: appNames[0], message: '' })).status).toBe(200)
    expect(await call('POST', requests, { appName: appNames[20], message: '' })).toMatchObject({ status: 429, body: { error: 'too_many_requests' } })
  })

  test('app history retains all pending requests and at most twenty recent decisions', async () => {
    for (let index = 0; index < 21; index++) {
      await caller('p-tanaka')
      expect((await call('POST', requests, { appName: 'keihi', message: `Request ${index}` })).status).toBe(201)
      await caller('p-yamada')
      const entries = (await call('GET', `${keihi}/access-requests`)).body as Array<{ id: string; requester: { id: string }; status: string }>
      const pending = entries.find((entry) => entry.requester.id === 'p-tanaka' && entry.status === 'pending')
      expect(pending).toBeDefined()
      expect((await call('POST', `${keihi}/access-requests/${pending?.id}/decline`)).status).toBe(200)
    }
    const entries = (await call('GET', `${keihi}/access-requests`)).body as Array<{ status: string; message: string }>
    expect(entries).toHaveLength(21)
    expect(entries[0].status).toBe('pending')
    expect(entries[1]).toMatchObject({ status: 'declined', message: 'Request 20' })
    expect(entries[20].message).toBe('Request 1')
  })

  test('deleting an app cascades requests and reset restores the seeded request and caller', async () => {
    await call('DELETE', keihi)
    expect((await call('GET', `${requests}?status=pending`)).body).toEqual([])
    await caller('p-tanaka')
    expect((await call('GET', `${requests}/mine?appName=keihi`)).body.exists).toBe(false)
    await call('POST', '/api/console/__mock/reset')
    expect((await call('GET', '/api/console/me')).body.person.id).toBe('p-yamada')
    expect((await call('GET', `${requests}?status=pending`)).body).toMatchObject([{ id: 'aar-keihi-suzuki', status: 'pending' }])
  })
})

describe('directory and comment routes', () => {
  const root = '/api/console'
  const keihi = `${root}/apps/a-keihi`
  const comments = `${keihi}/comments`
  const caller = (personId: string, role = 'Viewer') => call('POST', `${root}/__mock/caller`, { personId, role })
  beforeEach(async () => { await call('POST', `${root}/__mock/reset`) })
  afterEach(async () => { await call('POST', `${root}/__mock/reset`) })

  test('directory lists bound apps regardless of visibility and never exposes private app fields', async () => {
    const draft = await call('POST', `${root}/__mock/app-draft`, {})
    await caller('p-tanaka')
    const entries = (await call('GET', `${root}/apps?scope=directory`)).body.items as Array<Record<string, unknown>>
    expect(entries).toHaveLength(6)
    expect(entries.some((entry) => entry.id === draft.body.app.id)).toBe(false)
    expect(entries.find((entry) => entry.id === 'a-keihi')).toMatchObject({
      path: 'sales/east/team-a/keihi', canOpen: false, capabilities: [], stackId: 'keihi',
    })
    expect(entries.find((entry) => entry.id === 'a-kintai')?.canOpen).toBe(true)
    for (const entry of entries) {
      for (const field of ['share', 'guide', 'createdBy', 'createdById', 'ownerIds', 'groupId']) {
        expect(entry).not.toHaveProperty(field)
      }
    }
    expect((await call('GET', keihi)).status).toBe(404)
    const entry = await call('GET', `${keihi}/directory-entry`)
    expect(entry).toEqual({ status: 200, body: entries.find((row) => row.id === 'a-keihi') })
    expect((await call('GET', `${root}/apps/${draft.body.app.id}/directory-entry`)).status).toBe(404)
    expect((await call('GET', `${root}/apps/missing/directory-entry`)).status).toBe(404)
    expect((await call('GET', `${root}/apps?scope=all`)).body.items.some((row: { id: string }) => row.id === 'a-keihi')).toBe(false)
  })

  test('directory filtering uses group subtrees and capabilities, but never guide text', async () => {
    await call('PATCH', keihi, { guide: 'guide-only-search', capabilities: ['交通費を集計できる'] })
    await caller('p-tanaka')
    const subtree = (await call('GET', `${root}/apps?scope=directory&group=g-sales`)).body.items as Array<{ id: string }>
    expect(subtree.map((entry) => entry.id).sort()).toEqual(['a-hikkoshi', 'a-keihi', 'a-mitsumori', 'a-nippo'])
    expect((await call('GET', `${root}/apps?scope=directory&group=g-sales&q=${encodeURIComponent('交通費を集計')}`)).body.items).toMatchObject([{ id: 'a-keihi' }])
    expect((await call('GET', `${root}/apps?scope=directory&q=guide-only-search`)).body.items).toEqual([])
    expect((await call('GET', `${root}/apps?scope=directory&group=g-soumu&q=${encodeURIComponent('交通費を集計')}`)).body.items).toEqual([])
    const entries = (await call('GET', `${root}/apps?scope=directory`)).body.items as Array<{ updatedAt: string }>
    expect(entries.map((entry) => entry.updatedAt)).toEqual(entries.map((entry) => entry.updatedAt).sort().reverse())
  })

  test('resolve returns entry for invisible bound apps through direct, app and group redirects', async () => {
    await call('POST', `${root}/__mock/app-draft`, {})
    expect((await call('GET', `${root}/resolve?path=sales/east/team-a/keihi`)).body.kind).toBe('app')
    await call('PATCH', keihi, { slug: 'expenses' })
    await caller('p-tanaka')
    for (const path of ['sales/east/team-a/expenses', 'sales/east/team-a/keihi', 'sales/tokyo/team-a/expenses']) {
      expect(await call('GET', `${root}/resolve?path=${path}`)).toMatchObject({
        status: 200, body: { kind: 'entry', id: 'a-keihi', currentPath: 'sales/east/team-a/expenses' },
      })
    }
    expect((await call('GET', `${root}/resolve?path=sales/east/team-a/draft-stopped`)).status).toBe(404)
    await caller('p-yamada')
    expect((await call('GET', `${root}/resolve?path=sales/east/team-a/expenses`)).body.kind).toBe('app')
    expect((await call('GET', `${root}/resolve?path=sales/east/team-a/draft-stopped`)).body.kind).toBe('app')
  })

  test('the console role toggle exposes a private bound entry without changing the caller toggle', async () => {
    expect((await call('POST', `${root}/__mock/role`, { role: 'Viewer' })).body).toMatchObject({
      person: { id: 'p-kobayashi' }, isConsoleAdmin: false, canCreateApps: false, view: 'user',
    })
    expect((await call('GET', `${root}/resolve?path=sales/east/team-a/keihi`)).body.kind).toBe('entry')
    await caller('p-yamada', 'Viewer')
    expect((await call('GET', `${root}/resolve?path=sales/east/team-a/keihi`)).body.kind).toBe('app')
    expect((await call('POST', `${root}/__mock/role`, { role: 'invalid' })).status).toBe(400)
  })

  test('the Directory proxy serves groups, members, people and realm users, and pre-registers by email', async () => {
    const groups = (await call('GET', `${root}/directory/groups`)).body.items as Array<{ id: string }>
    expect(groups.find((group) => group.id === 'g-sales-east')).toMatchObject({ path: 'sales/east', subgroupCount: 2, memberCount: 1 })
    const members = (await call('GET', `${root}/directory/groups/g-team-a/members`)).body.items as Array<{ person: { id: string }; inheritedFrom: string | null }>
    expect(members.map((member) => [member.person.id, member.inheritedFrom]).sort()).toEqual([['p-sato', 'g-sales'], ['p-suzuki', null], ['p-yamada', null]])
    // A direct membership stays a direct row even when an ancestor grants a stronger role; the role is the strongest.
    expect((await call('GET', `${root}/directory/groups/g-planning/members`)).body.items).toMatchObject([
      { person: { id: 'p-sato' }, role: 'manager', inheritedFrom: null }, { person: { id: 'p-kobayashi' }, role: 'member', inheritedFrom: null },
    ])
    expect((await call('GET', `${root}/directory/groups/missing/members`)).status).toBe(404)
    expect((await call('GET', `${root}/directory/people?ids=p-sato,p-missing`)).body.items).toMatchObject([{ id: 'p-sato' }])
    expect((await call('GET', `${root}/directory/people?q=yamada`)).body.items).toMatchObject([{ id: 'p-yamada' }])
    const tooMany = Array.from({ length: 101 }, (_, index) => `p${index}`).join(',')
    expect((await call('GET', `${root}/directory/people?ids=${tooMany}`)).status).toBe(400)
    expect((await call('GET', `${root}/directory/directory-users?q=takahashi`)).body.items).toEqual([{ id: 'd-takahashi', email: 'takahashi@example.com', displayName: '高橋 健' }])
    expect((await call('POST', `${root}/directory/people`, { email: 'Yamada@example.com', displayName: '山田' })).status).toBe(409)
    const created = await call('POST', `${root}/directory/people`, { email: 'Takahashi@example.com', displayName: ' 高橋 健 ' })
    expect(created).toMatchObject({ status: 201, body: { email: 'takahashi@example.com', displayName: '高橋 健', pending: true, subject: null } })
    expect((await call('GET', `${root}/directory/people/${created.body.id}`)).body).toEqual({ person: created.body, memberships: [] })
  })

  test('me carries Directory membership, management and the public origin; the one-time migration replays its result', async () => {
    expect((await call('GET', `${root}/me`)).body).toMatchObject({
      effectiveGroupIds: ['g-team-a'],
      managedGroupIds: [],
      directoryPublicURL: 'http://mock.test',
      migration: { pending: false },
    })
    await caller('p-sato')
    const sato = (await call('GET', `${root}/me`)).body
    expect([...sato.effectiveGroupIds].sort()).toEqual(['g-planning', 'g-sales', 'g-sales-east', 'g-team-a', 'g-team-b'])
    expect([...sato.managedGroupIds].sort()).toEqual(['g-planning', 'g-sales', 'g-sales-east', 'g-team-a', 'g-team-b'])
    expect((await call('POST', `${root}/admin/directory-migrate`)).status).toBe(403)
    await call('POST', `${root}/__mock/caller`, { personId: 'p-yamada', role: 'Admin' })
    const pending = (await call('POST', `${root}/__mock/migration`, {})).body
    expect(pending).toEqual({ pending: true, people: 5, groups: 6, memberships: 6 })
    expect((await call('GET', `${root}/me`)).body.migration).toEqual(pending)
    const result = await call('POST', `${root}/admin/directory-migrate`)
    expect(result).toEqual({ status: 200, body: { imported: { people: 5, groups: 6, memberships: 6 }, conflicts: [], merged: [] } })
    expect((await call('GET', `${root}/me`)).body.migration.pending).toBe(false)
    expect(await call('POST', `${root}/admin/directory-migrate`)).toEqual(result)
  })

  test('app guide and capabilities validate Unicode limits and appear on detail and by-path reads', async () => {
    const guide = '𠮷'.repeat(4000)
    const capabilities = Array.from({ length: 10 }, () => '𠮷'.repeat(60))
    const saved = await call('PATCH', keihi, { guide, capabilities })
    expect(saved).toMatchObject({ status: 200, body: { guide, capabilities } })
    expect((await call('GET', `${root}/apps/by-path/sales/east/team-a/keihi`)).body).toEqual(saved.body)
    for (const patch of [
      { guide: '字'.repeat(4001) }, { guide: null },
      { capabilities: Array(11).fill('項目') }, { capabilities: ['字'.repeat(61)] },
      { capabilities: [''] }, { capabilities: [' \n\t '] }, { capabilities: [1] }, { capabilities: null },
    ]) {
      expect(await call('PATCH', keihi, patch)).toMatchObject({ status: 400, body: { error: 'invalid_request' } })
      expect((await call('GET', keihi)).body).toEqual(saved.body)
    }
    expect((await call('PATCH', keihi, { capabilities: [' 項目 ', ` ${'𠮷'.repeat(60)} `] })).body.capabilities).toEqual(['項目', '𠮷'.repeat(60)])
    expect((await call('PATCH', keihi, { guide: '', capabilities: [] })).body).toMatchObject({ guide: '', capabilities: [] })
    const created = await call('POST', `${root}/apps`, { displayName: '新しいアプリ', slug: 'new-app', groupId: 'g-team-a' })
    expect(created.body).toMatchObject({ guide: '', capabilities: [] })
    await caller('p-suzuki')
    expect((await call('PATCH', `${root}/apps/a-mitsumori`, { guide: '担当者以外' })).status).toBe(403)
  })

  test('comments allow invisible members, return a bare newest-first list and logically delete only the matching app comment', async () => {
    await call('POST', `${root}/__mock/comments`, { state: 'empty' })
    await caller('p-tanaka')
    expect((await call('GET', keihi)).status).toBe(404)
    expect((await call('GET', comments)).body).toEqual([])
    const first = await call('POST', comments, { body: '  使いたいです。\n相談できますか？  ' })
    expect(first).toMatchObject({
      status: 201, body: { appId: 'a-keihi', author: { id: 'p-tanaka' }, body: '使いたいです。\n相談できますか？' },
    })
    expect(first.body.id).toBeString()
    expect(first.body.createdAt).toBeString()
    expect(first.body).not.toHaveProperty('deletedAt')
    expect(first.body).not.toHaveProperty('deletedBy')
    const second = await call('POST', comments, { body: 'もうひとつ質問です。' })
    expect((await call('GET', comments)).body).toEqual([second.body, first.body])
    expect((await call('DELETE', `${root}/apps/a-mitsumori/comments/${first.body.id}`)).status).toBe(404)
    await caller('p-suzuki')
    expect(await call('DELETE', `${comments}/${first.body.id}`)).toMatchObject({ status: 403, body: { error: 'forbidden' } })
    await caller('p-tanaka')
    expect((await call('DELETE', `${comments}/${first.body.id}`)).status).toBe(204)
    expect((await call('DELETE', `${comments}/${first.body.id}`)).status).toBe(404)
    expect((await call('GET', comments)).body).toEqual([second.body])
    await caller('p-yamada', 'Viewer')
    expect((await call('DELETE', `${comments}/${second.body.id}`)).status).toBe(204)
    expect((await call('GET', comments)).body).toEqual([])
  })

  test('group managers and console administrators may delete another author comment', async () => {
    for (const [personId, role] of [['p-sato', 'Viewer'], ['p-suzuki', 'Admin']]) {
      await caller('p-tanaka')
      const created = await call('POST', comments, { body: '削除をお願いします。' })
      await caller(personId, role)
      expect((await call('DELETE', `${comments}/${created.body.id}`)).status).toBe(204)
    }
  })

  test('comment validation counts Unicode characters, rejects empty bodies, and hides drafts', async () => {
    for (const value of ['', ' \n\t ', '字'.repeat(1001), null, 1]) {
      expect(await call('POST', comments, { body: value })).toMatchObject({ status: 400, body: { error: 'invalid_request' } })
    }
    expect((await call('POST', comments, { body: '𠮷'.repeat(1000) })).status).toBe(201)
    await call('POST', `${root}/__mock/app-draft`, {})
    for (const id of ['a-draft-stopped', 'missing']) {
      expect((await call('GET', `${root}/apps/${id}/comments`)).status).toBe(404)
      expect((await call('POST', `${root}/apps/${id}/comments`, { body: '質問です。' })).status).toBe(404)
      expect((await call('DELETE', `${root}/apps/${id}/comments/missing`)).status).toBe(404)
    }
  })

  test('comment toggles expose the 100-row cut and the per-author 200-open-comment quota', async () => {
    const seededComments = `${root}/apps/a-mitsumori/comments`
    expect((await call('POST', `${root}/__mock/comments`, { state: 'many' })).body).toEqual({ state: 'many', count: 120 })
    const rows = (await call('GET', seededComments)).body as Array<{ id: string; body: string; createdAt: string }>
    expect(rows).toHaveLength(100)
    expect(rows[0].body).toBe('コメント 120')
    expect(rows[99].body).toBe('コメント 21')
    expect(rows.map((row) => row.createdAt)).toEqual(rows.map((row) => row.createdAt).sort().reverse())
    await caller('p-tanaka')
    expect((await call('POST', `${root}/__mock/comments`, { state: 'quota' })).body).toEqual({ state: 'quota', count: 200 })
    expect(await call('POST', comments, { body: '別のアプリでも上限です。' })).toEqual({
      status: 429, body: { error: 'too_many_requests', message: 'Too many comments' },
    })
    const ownComments = (await call('GET', seededComments)).body as Array<{ id: string }>
    expect((await call('DELETE', `${seededComments}/${ownComments[0].id}`)).status).toBe(204)
    expect((await call('POST', comments, { body: '削除すると投稿できます。' })).status).toBe(201)
    expect((await call('POST', comments, { body: '再び上限です。' })).status).toBe(429)
    await caller('p-suzuki')
    expect((await call('POST', comments, { body: '別の人は投稿できます。' })).status).toBe(201)
    expect((await call('POST', `${root}/__mock/comments`, { state: 'empty' })).body).toEqual({ state: 'empty', count: 0 })
    expect((await call('GET', seededComments)).body).toEqual([])
    expect((await call('GET', comments)).body).toEqual([])
    expect((await call('POST', `${root}/__mock/comments`, { state: 'invalid' })).status).toBe(400)
  })

  test('non-members cannot discover apps or read, post or delete comments', async () => {
    const comment = await call('POST', comments, { body: '質問です。' })
    await call('POST', `${root}/__mock/not-member`, {})
    for (const [method, path, input] of [
      ['GET', `${root}/apps?scope=directory`, undefined],
      ['GET', `${keihi}/directory-entry`, undefined],
      ['GET', comments, undefined],
      ['POST', comments, { body: '質問です。' }],
      ['DELETE', `${comments}/${comment.body.id}`, undefined],
      ['GET', `${root}/resolve?path=sales/east/team-a/keihi`, undefined],
    ] as const) {
      expect(await call(method, path, input)).toMatchObject({ status: 403, body: { error: 'not_project_member' } })
    }
  })

  test('reset restores seeded directory fields and comments after edits, toggles and app deletion', async () => {
    const paths = ['/directory/groups', '/apps', '/apps?scope=directory', '/apps/a-mitsumori/comments', '/apps/a-keihi/comments']
    const before = await Promise.all(paths.map((path) => call('GET', `${root}${path}`)))
    await call('PATCH', keihi, { guide: '変更', capabilities: ['変更'] })
    await call('POST', `${root}/__mock/comments`, { state: 'quota' })
    expect((await call('DELETE', `${root}/apps/a-mitsumori`)).status).toBe(204)
    expect((await call('GET', `${root}/apps/a-mitsumori/comments`)).status).toBe(404)
    expect((await call('POST', comments, { body: '削除したアプリのコメントは上限に数えません。' })).status).toBe(201)
    await call('POST', `${root}/__mock/role`, { role: 'Viewer' })
    await call('POST', `${root}/__mock/reset`)
    expect(await Promise.all(paths.map((path) => call('GET', `${root}${path}`)))).toEqual(before)
    expect((await call('GET', `${root}/me`)).body.person.id).toBe('p-yamada')
  })
})

describe('store routes: screenshots, people and owner filter', () => {
  const root = '/api/console'
  const mitsumori = `${root}/apps/a-mitsumori`
  const keihi = `${root}/apps/a-keihi`
  const caller = (personId: string, role = 'Viewer') => call('POST', `${root}/__mock/caller`, { personId, role })
  beforeEach(async () => { await call('POST', `${root}/__mock/reset`) })
  afterEach(async () => { await call('POST', `${root}/__mock/reset`) })

  async function raw(method: string, path: string, body?: FormData) {
    const url = new URL(path, 'http://mock.test')
    const response = await consoleRoutes(new Request(url, { method, body }), url)
    if (!response) throw new Error(`unhandled ${method} ${path}`)
    return response
  }
  async function upload(appPath: string, bytes: Uint8Array<ArrayBuffer>, caption?: string, type = 'image/png') {
    const form = new FormData()
    form.set('file', new File([bytes], 'screen.png', { type }))
    if (caption !== undefined) form.set('caption', caption)
    const response = await raw('POST', `${appPath}/screenshots`, form)
    return { status: response.status, body: await response.json() }
  }

  test('seeded screenshots ride on apps and directory entries and serve real PNG bytes to any member of a bound app', async () => {
    const app = (await call('GET', mitsumori)).body
    expect(app.screenshots).toEqual([
      { id: 'shot-mitsumori-1', caption: '見積の一覧', width: 640, height: 400 },
      { id: 'shot-mitsumori-2', caption: '品目の入力', width: 640, height: 400 },
      { id: 'shot-mitsumori-3', caption: 'PDF の確認', width: 640, height: 400 },
    ])
    const entries = (await call('GET', `${root}/apps?scope=directory`)).body.items as Array<{ id: string; screenshots: unknown[] }>
    expect(entries.find((entry) => entry.id === 'a-mitsumori')?.screenshots).toEqual(app.screenshots)
    expect(entries.find((entry) => entry.id === 'a-keihi')?.screenshots).toEqual([])
    await caller('p-tanaka')
    expect((await call('GET', mitsumori)).status).toBe(404)
    const image = await raw('GET', `${mitsumori}/screenshots/shot-mitsumori-1`)
    expect(image.status).toBe(200)
    expect(image.headers.get('Content-Type')).toBe('image/png')
    expect(image.headers.get('Cache-Control')).toBe('private, max-age=86400')
    const bytes = new Uint8Array(await image.arrayBuffer())
    expect(image.headers.get('Content-Length')).toBe(String(bytes.length))
    expect(imageInfo(bytes)).toEqual({ contentType: 'image/png', width: 640, height: 400 })
    expect((await raw('GET', `${mitsumori}/screenshots/shot-kintai-1`)).status).toBe(404)
    expect((await raw('GET', `${mitsumori}/screenshots/missing`)).status).toBe(404)
  })

  test('owners upload, reorder and delete; type comes from the bytes and limits answer 400 / 409', async () => {
    const png = mockScreenPng([13, 148, 136], 1, 320, 200)
    const created = await upload(keihi, png, '  申請の画面  ', 'image/jpeg')
    expect(created).toMatchObject({ status: 201, body: { caption: '申請の画面', width: 320, height: 200 } })
    expect((await raw('GET', `${keihi}/screenshots/${created.body.id}`)).headers.get('Content-Type')).toBe('image/png')
    expect(await upload(keihi, new Uint8Array(new TextEncoder().encode('not an image')))).toMatchObject({ status: 400, body: { error: 'invalid_request' } })
    expect(await upload(keihi, png, '字'.repeat(101))).toMatchObject({ status: 400, body: { error: 'invalid_request' } })
    expect((await upload(keihi, png, '𠮷'.repeat(100))).status).toBe(201)
    const big = new Uint8Array(2 * 1024 * 1024 + 1)
    big.set(png)
    expect(await upload(keihi, big)).toMatchObject({ status: 400, body: { error: 'invalid_request' } })
    expect((await raw('POST', `${keihi}/screenshots`, new FormData())).status).toBe(400)
    for (let index = 0; index < 3; index++) expect((await upload(keihi, png)).status).toBe(201)
    expect(await upload(keihi, png)).toMatchObject({ status: 409, body: { error: 'conflict', message: 'At most 5 screenshots' } })

    const ids = ((await call('GET', keihi)).body.screenshots as Array<{ id: string }>).map((shot) => shot.id)
    expect(ids).toHaveLength(5)
    const reversed = [...ids].reverse()
    const reordered = await call('PATCH', `${keihi}/screenshots`, { order: reversed })
    expect(reordered.status).toBe(200)
    expect(reordered.body.map((shot: { id: string }) => shot.id)).toEqual(reversed)
    for (const order of [ids.slice(1), [...ids.slice(1), ids[1]], [...ids.slice(1), 'missing'], 'nope']) {
      expect(await call('PATCH', `${keihi}/screenshots`, { order })).toMatchObject({ status: 400, body: { error: 'invalid_request' } })
    }
    expect((await call('DELETE', `${keihi}/screenshots/${reversed[0]}`)).status).toBe(204)
    expect((await call('DELETE', `${keihi}/screenshots/${reversed[0]}`)).status).toBe(404)
    expect((await raw('GET', `${keihi}/screenshots/${reversed[0]}`)).status).toBe(404)
    expect(((await call('GET', keihi)).body.screenshots as Array<{ id: string }>).map((shot) => shot.id)).toEqual(reversed.slice(1))
  })

  test('only people who can edit the app change its screenshots', async () => {
    const png = mockScreenPng([13, 148, 136], 0, 160, 100)
    await caller('p-suzuki')
    expect((await upload(mitsumori, png)).status).toBe(403)
    expect((await call('DELETE', `${mitsumori}/screenshots/shot-mitsumori-1`)).status).toBe(403)
    expect((await call('PATCH', `${mitsumori}/screenshots`, { order: ['shot-mitsumori-3', 'shot-mitsumori-2', 'shot-mitsumori-1'] })).status).toBe(403)
    await caller('p-tanaka')
    expect((await upload(keihi, png)).status).toBe(404)
    expect((await upload(`${root}/apps/missing`, png)).status).toBe(404)
  })

  test('deleting an app drops its screenshot bytes', async () => {
    expect((await call('DELETE', mitsumori)).status).toBe(204)
    expect((await raw('GET', `${mitsumori}/screenshots/shot-mitsumori-1`)).status).toBe(404)
  })

  test('a Directory profile lists direct memberships only, answers non-members, and never answers for unknown people', async () => {
    expect(await call('GET', `${root}/directory/people/p-sato`)).toEqual({
      status: 200,
      body: {
        person: { id: 'p-sato', subject: 'sub-sato', pending: false, email: 'sato@example.com', displayName: '佐藤 花子', avatarVersion: '2026-09-03T09:00:00.000Z' },
        memberships: [
          { group: { id: 'g-sales', path: 'sales', name: '営業本部' }, role: 'manager', inheritedFrom: null },
          { group: { id: 'g-planning', path: 'sales/planning', name: '営業企画部' }, role: 'member', inheritedFrom: null },
        ],
      },
    })
    expect((await call('GET', `${root}/directory/people/p-yamada`)).body.memberships).toEqual([
      { group: { id: 'g-team-a', path: 'sales/east/team-a', name: '営業1課' }, role: 'member', inheritedFrom: null },
    ])
    expect((await call('GET', `${root}/directory/people/missing`)).status).toBe(404)
    await call('POST', `${root}/__mock/not-member`, {})
    expect((await call('GET', `${root}/directory/people/p-sato`)).status).toBe(200)
  })

  test('seeded profile pictures ride on every person and serve real PNG bytes from the Directory origin', async () => {
    const seeded = '2026-09-03T09:00:00.000Z'
    expect((await call('GET', `${root}/me`)).body.person.avatarVersion).toBe(seeded)
    const people = (await call('GET', `${root}/directory/people`)).body.items as Array<{ id: string; avatarVersion: string | null }>
    expect(Object.fromEntries(people.map((entry) => [entry.id, entry.avatarVersion]))).toEqual({
      'p-yamada': seeded, 'p-sato': seeded, 'p-suzuki': null, 'p-tanaka': seeded, 'p-kobayashi': null,
    })
    expect((await call('GET', mitsumori)).body.owners[0].avatarVersion).toBe(seeded)
    const comments = (await call('GET', `${mitsumori}/comments`)).body as Array<{ author: { id: string; avatarVersion: string | null } }>
    expect(comments.map((comment) => [comment.author.id, comment.author.avatarVersion])).toEqual(expect.arrayContaining([['p-suzuki', null], ['p-yamada', seeded]]))

    const avatars = '/api/directory/v1/people'
    const image = await raw('GET', `${avatars}/p-sato/avatar`)
    expect(image.status).toBe(200)
    expect(image.headers.get('Content-Type')).toBe('image/png')
    expect(image.headers.get('Cache-Control')).toBe('private, max-age=86400')
    expect(imageInfo(new Uint8Array(await image.arrayBuffer()))).toEqual({ contentType: 'image/png', width: 96, height: 96 })
    const colors = await Promise.all(['p-yamada', 'p-sato', 'p-tanaka'].map(async (id) => Buffer.from(await (await raw('GET', `${avatars}/${id}/avatar`)).arrayBuffer()).toString('base64')))
    expect(new Set(colors).size).toBe(3)
    expect((await raw('GET', `${avatars}/p-suzuki/avatar`)).status).toBe(404)
    expect((await raw('GET', `${avatars}/missing/avatar`)).status).toBe(404)
  })

  test('the directory owner filter returns every bound app the person owns, open or not', async () => {
    await caller('p-tanaka')
    const yamada = (await call('GET', `${root}/apps?scope=directory&ownerId=p-yamada`)).body.items as Array<{ id: string; canOpen: boolean }>
    expect(yamada.map((entry) => entry.id).sort()).toEqual(['a-keihi', 'a-mitsumori'])
    expect(yamada.find((entry) => entry.id === 'a-keihi')?.canOpen).toBe(false)
    expect((await call('GET', `${root}/apps?scope=directory&ownerId=p-tanaka&group=g-sales`)).body.items).toEqual([])
    expect((await call('GET', `${root}/apps?scope=directory&ownerId=nobody`)).body.items).toEqual([])
  })
})

describe('app tools (Built-in app Connect)', () => {
  const root = '/api/console'
  const tools = (appId: string) => call('GET', `${root}/apps/${appId}/tools`)
  beforeEach(async () => { await call('POST', `${root}/__mock/reset`) })
  afterEach(async () => { await call('POST', `${root}/__mock/reset`) })

  test('seeded apps cover the list, empty, installing, unreachable and absent answers', async () => {
    const list = (await tools('a-mitsumori')).body
    expect(list).toMatchObject({ available: true, editUrl: 'https://tools.commerce.appthrust.test/edit' })
    expect(list.tools.map((tool: { url: string }) => tool.url)).toEqual([
      'https://tools.commerce.appthrust.test/t/mitsumori-approvals',
      'https://tools.commerce.appthrust.test/t/mitsumori-search',
    ])
    expect((await tools('a-nippo')).body).toEqual({ available: true, tools: [], editUrl: 'https://tools.commerce.appthrust.test/edit' })
    expect((await tools('a-kintai')).body).toEqual({ available: false, pending: true })
    expect((await tools('a-kaigishitsu')).body).toEqual({ available: true, error: 'tools_unavailable', tools: [] })
    expect((await tools('a-hikkoshi')).body).toEqual({ available: false })
    expect((await tools('missing')).status).toBe(404)
  })

  test('editUrl is for people who may create tools; invisible apps are not found; one app can be switched', async () => {
    await call('POST', `${root}/__mock/role`, { role: 'Viewer' })
    expect((await tools('a-kaigishitsu')).body).toEqual({ available: true, error: 'tools_unavailable', tools: [] })
    expect((await tools('a-kintai')).body).not.toHaveProperty('editUrl')
    expect((await tools('a-nippo')).status).toBe(404)
    expect((await call('POST', `${root}/__mock/tools`, { appId: 'a-kintai', state: 'list' })).status).toBe(200)
    const switched = (await tools('a-kintai')).body
    expect(switched.available).toBe(true)
    expect(switched.tools).toHaveLength(2)
    expect(switched).not.toHaveProperty('editUrl')
    expect((await call('POST', `${root}/__mock/tools`, { appId: 'a-kintai', state: 'bogus' })).status).toBe(400)
  })

  test('an unbound app answers available with no tools and no editUrl, whatever the link state', async () => {
    const draft = (await call('POST', `${root}/__mock/app-draft`, {})).body.app as { id: string; stackId: string | null }
    expect(draft.stackId).toBeNull()
    for (const linkState of ['absent', 'pending', 'unavailable', 'list'] as const) {
      await call('POST', `${root}/__mock/tools`, { appId: draft.id, state: linkState })
      expect((await tools(draft.id)).body).toEqual({ available: true, tools: [] })
    }
  })
})

describe('creation needs a membership of the target group (like the server)', () => {
  beforeEach(async () => { await call('POST', '/api/console/__mock/reset') })
  afterEach(async () => { await call('POST', '/api/console/__mock/reset') })

  test('a named target that is unknown, empty or not the caller\'s answers the server\'s 400; missing fields stay required', async () => {
    const refused = { status: 400, body: { error: 'invalid_request', message: 'groupId must be one of your directory groups' } }
    // 山田 (a Console administrator) belongs to 営業1課 only.
    for (const groupId of ['g-missing', '', 'g-soumu', 'g-sales']) {
      expect(await call('POST', '/api/console/apps', { displayName: 'Target', slug: 'target', groupId })).toMatchObject(refused)
    }
    // The target is judged before the other required field, as on the server.
    expect(await call('POST', '/api/console/apps', { displayName: '', slug: 'target', groupId: 'g-missing' })).toMatchObject(refused)
    const required = { status: 400, body: { error: 'invalid_request', message: 'displayName and groupId are required' } }
    expect(await call('POST', '/api/console/apps', { displayName: 'Target', slug: 'target' })).toMatchObject(required)
    expect(await call('POST', '/api/console/apps', { displayName: 'Target', slug: 'target', groupId: null })).toMatchObject(required)
    expect(await call('POST', '/api/console/apps', { displayName: ' ', slug: 'target', groupId: 'g-team-a' })).toMatchObject(required)
    expect((await call('POST', '/api/console/apps', { displayName: 'Target', slug: 'target', groupId: 'g-team-a' })).status).toBe(201)
  })

  test('a session create replayed with its key after the caller left the group is not found, like the server', async () => {
    const create = async () => {
      const url = new URL('/api/console/v1/build-sessions', 'http://mock.test')
      const response = await consoleRoutes(new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'replay-after-leaving' },
        body: JSON.stringify({ kind: 'new-app', groupId: 'g-team-a', intent: '備品の貸し出しを記録したい', locale: 'ja' }),
      }), url)
      if (!response) throw new Error('unhandled build-session create')
      return { status: response.status, body: await response.json() }
    }
    const first = await create()
    expect(first.status).toBe(202)
    // The same key replays the stored success while the caller still belongs to the group.
    expect(await create()).toEqual(first)
    await call('POST', '/api/console/__mock/leave-groups', {})
    expect(await create()).toEqual({ status: 404, body: { error: 'not_found', message: 'Build group is not accessible' } })
    expect((await call('GET', `/api/console/v1/build-sessions/${first.body.id}`)).status).toBe(404)
  })

  describe('the first bind of an unbound app needs the caller to belong to its current group now', () => {
    const refused = { status: 400, body: { error: 'invalid_request', message: 'groupId must be one of your directory groups' } }
    const alreadyBound = { status: 409, body: { error: 'already_bound', message: 'The app is already bound to a platform stack' } }
    const as = (personId: string, role: 'Admin' | 'Editor') => call('POST', '/api/console/__mock/caller', { personId, role })
    const unbound = async (slug: string) => {
      const created = await call('POST', '/api/console/apps', { displayName: 'Bind check', slug, groupId: 'g-team-a' })
      expect(created.status).toBe(201)
      return created.body as { id: string; appName: string }
    }
    const bind = (app: { id: string; appName: string }) => call('POST', `/api/console/apps/${app.id}/bind`, { stackId: app.appName, appName: app.appName })

    test('an owner whose membership was revoked after creating cannot complete it', async () => {
      await as('p-suzuki', 'Editor')
      const app = await unbound('revoked-owner')
      await call('POST', '/api/console/__mock/leave-groups', {})
      expect(await bind(app)).toEqual(refused)
      expect((await call('GET', `/api/console/apps/${app.id}`)).body.stackId).toBeNull()
    })

    test('a Console administrator who belongs to no group cannot complete another person\'s creation', async () => {
      await as('p-suzuki', 'Editor')
      const app = await unbound('admin-no-group')
      await as('p-yamada', 'Admin')
      await call('POST', '/api/console/__mock/leave-groups', {})
      expect(await bind(app)).toEqual(refused)
    })

    test('an owner who moved the unbound record into a group they do not belong to cannot complete it there', async () => {
      await as('p-yamada', 'Editor')
      const app = await unbound('moved-away')
      // Moving is the separate PATCH policy (unchanged): the owner may move it anywhere.
      expect((await call('PATCH', `/api/console/apps/${app.id}`, { groupId: 'g-soumu' })).status).toBe(200)
      expect(await bind(app)).toEqual(refused)
    })

    test('a member completes the first bind; a bound record stays a conflict whatever the caller\'s memberships', async () => {
      await as('p-yamada', 'Editor')
      const app = await unbound('member-binds')
      const bound = await bind(app)
      expect(bound.status).toBe(200)
      expect(bound.body).toMatchObject({ id: app.id, stackId: app.appName, appName: app.appName })
      expect(await bind(app)).toEqual(alreadyBound)
      await as('p-yamada', 'Admin')
      await call('POST', '/api/console/__mock/leave-groups', {})
      expect(await bind(app)).toEqual(alreadyBound)
      expect(await call('POST', '/api/console/apps/a-mitsumori/bind', { stackId: 'other', appName: 'other' })).toEqual(alreadyBound)
    })
  })
})

describe('role-based views: personas, permissions, contribution and the inbox (like the server)', () => {
  const root = '/api/console'
  const role = (name: string) => call('POST', `${root}/__mock/role`, { role: name })
  const permissionsOf = async () => Object.fromEntries(((await call('GET', `${root}/apps`)).body.items as Array<{ id: string; permissions: Record<string, boolean> }>).map((app) => [app.id, app.permissions]))
  const none = { use: false, comment: false, propose: false, maintain: false, data: false }
  const user = { use: true, comment: true, propose: false, maintain: false, data: false }
  const maintainer = { use: true, comment: true, propose: true, maintain: true, data: true }
  beforeEach(async () => { await call('POST', `${root}/__mock/reset`) })
  afterEach(async () => { await call('POST', `${root}/__mock/reset`) })

  test('the default persona is a maker who maintains every app; group scope is seeded except one company and one off', async () => {
    expect((await call('GET', `${root}/me`)).body).toMatchObject({ person: { id: 'p-yamada' }, isConsoleAdmin: true, view: 'maker' })
    const apps = (await call('GET', `${root}/apps`)).body.items as Array<{ id: string; contribution: { scope: string }; permissions: unknown }>
    expect(Object.fromEntries(apps.map((app) => [app.id, app.contribution.scope]))).toEqual({
      'a-mitsumori': 'group', 'a-nippo': 'group', 'a-keihi': 'group', 'a-hikkoshi': 'group', 'a-kintai': 'company', 'a-kaigishitsu': 'off',
    })
    for (const app of apps) expect(app.permissions).toEqual(maintainer)
    const entry = (await call('GET', `${root}/apps/a-kaigishitsu/directory-entry`)).body
    expect(entry).toMatchObject({ contribution: { scope: 'off' }, permissions: maintainer })
  })

  test('Viewer is a user who can neither maintain nor propose; Editor proposes only where the scope admits them', async () => {
    expect((await role('Viewer')).body).toMatchObject({ person: { id: 'p-kobayashi' }, canCreateApps: false, view: 'user', managedGroupIds: [] })
    expect(await permissionsOf()).toEqual({ 'a-hikkoshi': user, 'a-kintai': user, 'a-kaigishitsu': user })
    expect((await call('GET', `${root}/apps/a-keihi/directory-entry`)).body.permissions).toEqual(none)

    expect((await role('Editor')).body).toMatchObject({ person: { id: 'p-kobayashi' }, canCreateApps: true, view: 'user' })
    // 引っ越し見積: own group with scope group; 勤怠申請: scope company; 会議室予約: scope off.
    expect(await permissionsOf()).toEqual({ 'a-hikkoshi': { ...user, propose: true }, 'a-kintai': { ...user, propose: true }, 'a-kaigishitsu': user })
    expect((await call('PATCH', `${root}/apps/a-hikkoshi`, { contribution: { scope: 'off' } })).status).toBe(403)
    expect((await call('POST', `${root}/apps/a-hikkoshi/comments/seen`)).status).toBe(403)
    expect((await call('POST', `${root}/apps/a-keihi/comments/seen`)).status).toBe(404)
    expect((await call('GET', `${root}/inbox`)).body).toEqual({ items: [] })
  })

  test('owners and group managers start from the maker view', async () => {
    await call('POST', `${root}/__mock/caller`, { personId: 'p-suzuki', role: 'Viewer' })
    expect((await call('GET', `${root}/me`)).body).toMatchObject({ view: 'maker', managedGroupIds: [] })
    expect((await permissionsOf())['a-nippo']).toEqual(maintainer)
    await call('POST', `${root}/__mock/caller`, { personId: 'p-kobayashi', role: 'Viewer' })
    expect((await call('GET', `${root}/me`)).body.view).toBe('user')
  })

  test('maintainers change the contribution scope through the app PATCH; anything else is refused', async () => {
    const saved = await call('PATCH', `${root}/apps/a-hikkoshi`, { contribution: { scope: 'company', extra: true } })
    expect(saved).toMatchObject({ status: 200, body: { contribution: { scope: 'company' } } })
    expect(saved.body.contribution).toEqual({ scope: 'company' })
    for (const contribution of [{ scope: 'public' }, {}, null, 'off']) {
      expect((await call('PATCH', `${root}/apps/a-hikkoshi`, { contribution }))).toEqual({
        status: 400, body: { error: 'invalid_request', message: 'contribution.scope must be off, group or company' },
      })
    }
    await role('Editor')
    expect((await permissionsOf())['a-hikkoshi'].propose).toBe(true)
    await role('Admin')
    await call('PATCH', `${root}/apps/a-hikkoshi`, { contribution: { scope: 'off' } })
    await role('Editor')
    expect((await permissionsOf())['a-hikkoshi'].propose).toBe(false)
  })

  test('an improvement draft passes the console gate only with propose: scope off is contribution_not_accepted, else forbidden', async () => {
    const propose = (stackId: string) => call('POST', '/api/v1/projects/commerce/application-drafts', { kind: 'improvement', applicationStackId: stackId, intent: '直したい' })
    try {
      await role('Editor')
      expect(await propose('kaigishitsu')).toEqual({ status: 403, body: { error: { code: 'contribution_not_accepted', message: 'このアプリは、いま提案を受け付けていません。' } } })
      expect((await propose('hikkoshi')).status).not.toBe(403)
      await role('Viewer')
      expect(await propose('hikkoshi')).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } })
      // A creation draft is not the console's to gate.
      expect((await call('POST', '/api/v1/projects/commerce/application-drafts', { intent: '作りたい' })).status).not.toBe(403)
    } finally {
      await call('POST', '/api/v1/__mock/reset')
    }
  })

  test('the inbox lists pending requests and unread feedback by others; reading the thread and deciding clear them', async () => {
    const inbox = async () => (await call('GET', `${root}/inbox`)).body.items as Array<{ kind: string; app: { id: string; path: string; displayName: string; icon: string }; count: number; since: string }>
    expect(await inbox()).toEqual([
      { kind: 'accessRequest', app: { id: 'a-keihi', path: 'sales/east/team-a/keihi', displayName: '経費精算', icon: '💴' }, count: 1, since: '2026-10-10T09:00:00.000Z' },
      { kind: 'feedback', app: { id: 'a-keihi', path: 'sales/east/team-a/keihi', displayName: '経費精算', icon: '💴' }, count: 1, since: '2026-10-10T09:00:00.000Z' },
    ])
    // A newer comment by someone else on a thread already read counts again; the caller's own never does.
    await call('POST', `${root}/__mock/caller`, { personId: 'p-suzuki', role: 'Viewer' })
    expect((await call('POST', `${root}/apps/a-mitsumori/comments`, { body: '検索が速くなりました。' })).status).toBe(201)
    await call('POST', `${root}/__mock/caller`, { personId: 'p-yamada', role: 'Admin' })
    expect((await call('POST', `${root}/apps/a-mitsumori/comments`, { body: 'ありがとうございます。' })).status).toBe(201)
    const feedback = (await inbox()).filter((item) => item.kind === 'feedback')
    expect(feedback.map((item) => [item.app.id, item.count])).toEqual([['a-mitsumori', 1], ['a-keihi', 1]])

    expect(await call('POST', `${root}/apps/a-mitsumori/comments/seen`)).toEqual({ status: 204, body: undefined })
    expect(await call('POST', `${root}/apps/a-keihi/comments/seen`)).toEqual({ status: 204, body: undefined })
    expect((await call('POST', `${root}/apps/a-keihi/access-requests/aar-keihi-suzuki/decline`)).status).toBe(200)
    expect(await inbox()).toEqual([])
    expect((await call('POST', `${root}/apps/missing/comments/seen`)).status).toBe(404)
  })
})
