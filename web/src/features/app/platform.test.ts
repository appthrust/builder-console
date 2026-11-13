import { describe, expect, test } from 'bun:test'
import type { ApplicationSourceRepository } from '@appthrust/api-schema/platform-api'
import { stackOf } from '../../api/testing/app-domain'
import type { AppView } from '../../model/app'
import { isSourceBuildFailed, sourceRepositoryFor } from './platform'

const repository: ApplicationSourceRepository = {
  id: 'right-source', projectId: 'pj', destination: { repositoryName: 'other-name' },
  image: { imagePath: 'ghcr.io/acme/shared' }, status: 'ready', conditions: [],
}
const stackWire = {
  id: 'app', projectId: 'pj', templateId: 'nextjs-postgres', applicationName: 'app',
  sourceKind: 'application-source-repository', sourceRepositoryRefName: 'right-source',
  imageRef: 'ghcr.io/acme/shared:latest', pendingSync: false,
}
const stack = stackOf(stackWire)
const view: AppView = { status: 'live', label: '公開中', text: '', second: '', draft: false, stack }

describe('sourceRepositoryFor', () => {
  test('joins the exact authoritative stack reference, even when names and images differ', () => {
    expect(sourceRepositoryFor(view, [{ ...repository, image: { imagePath: 'another/image' } }])?.id).toBe('right-source')
  })
  test('never joins an image-entry app to the owner of the reused image', () => {
    expect(sourceRepositoryFor({ ...view, stack: stackOf({ ...stackWire, sourceKind: 'sample-image' }) }, [repository])).toBeUndefined()
  })
  test('never falls back to image prefix or application name when the explicit reference is absent', () => {
    const sameName = { ...repository, destination: { repositoryName: 'app' } }
    expect(sourceRepositoryFor({ ...view, stack: stackOf({ ...stackWire, sourceRepositoryRefName: undefined }) }, [sameName])).toBeUndefined()
    expect(sourceRepositoryFor({ ...view, stack: stackOf({ ...stackWire, sourceRepositoryRefName: 'not-visible' }) }, [sameName])).toBeUndefined()
    expect(sourceRepositoryFor(view, undefined)).toBeUndefined()
  })
})

describe('isSourceBuildFailed', () => {
  test('only a known failed build is a failure; an unknown state is not', () => {
    expect(isSourceBuildFailed({ build: { state: 'failed' } })).toBe(true)
    for (const state of ['healthy', 'running', 'unknown', 'future-state']) expect(isSourceBuildFailed({ build: { state } })).toBe(false)
    expect(isSourceBuildFailed({})).toBe(false)
  })
})
