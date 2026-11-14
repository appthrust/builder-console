import { expect, test } from 'bun:test'
import type { ApplicationDraftCreationPlan } from '@appthrust/api-schema/platform-api'
import { newRepositoryRequest, renameCreationPlan, withDefaultPublish, withDestinationRevision } from './plan'

const plan: ApplicationDraftCreationPlan = {
  summary: '見積', markdown: '# foo の計画を保持', representation: ['SourceRepository', 'ApplicationStack', 'Publish'],
  applicationSourceRepositoryRequest: { template: { repository: 'appthrust/template' }, destination: { repositoryName: 'foo' }, destinationRevision: 'rd-1', image: { imagePath: 'ghcr.io/acme/foo', tagFilter: '^v' } },
  applicationStackRequest: {
    templateId: 'biz-master-postgres', definitionRef: { name: 'web-postgres' }, application: { name: 'foo' },
    source: { kind: 'application-source-repository', sourceRepositoryId: 'created-source-repository' },
    web: { componentName: 'web' }, database: { componentName: 'db' }, connection: { connectionName: 'db' },
    publish: { enabled: true, customDomain: 'project.test', subdomain: 'foo', hostnamePattern: 'wildcard' },
  },
  toolPlan: [{ tool: 'appthrust.applicationSourceRepository.create', payloadRef: 'applicationSourceRepositoryRequest', approvalRequired: true }],
  implementationHandoff: { summary: '一覧を作る', workspaceMode: 'application-develop', targetApplicationRef: 'createdApplicationId', sourceRepositoryStrategy: 'created-source-repository', tasks: [{ title: '一覧', description: '表示する', acceptanceCriteria: ['表示できる'] }] },
}

test('renames new destinations without regenerating or changing schema-path tool references', () => {
  const renamed = renameCreationPlan(plan, 'foo-2')
  expect(renamed.applicationSourceRepositoryRequest).toMatchObject({ destination: { repositoryName: 'foo-2' }, destinationRevision: 'rd-1', image: { tagFilter: '^v' } })
  expect(renamed.applicationStackRequest).toMatchObject({ application: { name: 'foo-2' }, publish: { subdomain: 'foo-2', customDomain: 'project.test' }, source: { sourceRepositoryId: 'created-source-repository' } })
  expect(renamed.toolPlan).toBe(plan.toolPlan)
  expect(renamed.markdown).toBe(plan.markdown)
  expect(renamed.implementationHandoff).toBe(plan.implementationHandoff)
  expect(plan.applicationSourceRepositoryRequest?.destination?.repositoryName).toBe('foo')
})

test('a rename never rewrites the image path: an asserted one names the old repository and is dropped, the server derives it', () => {
  const renamed = renameCreationPlan(plan, 'foo-2')
  expect(renamed.applicationSourceRepositoryRequest?.image).toEqual({ tagFilter: '^v' })
  expect(plan.applicationSourceRepositoryRequest?.image?.imagePath).toBe('ghcr.io/acme/foo')
  const withoutImage = { ...plan, applicationSourceRepositoryRequest: { template: { repository: 'appthrust/template' }, destination: { repositoryName: 'foo' }, destinationRevision: 'rd-1' } }
  expect(renameCreationPlan(withoutImage, 'foo-2').applicationSourceRepositoryRequest).toEqual({ template: { repository: 'appthrust/template' }, destination: { repositoryName: 'foo-2' }, destinationRevision: 'rd-1' })
})

test('the approved plan’s new repository carries the revision of the destination shown; adoptions are not bound', () => {
  const rebound = withDestinationRevision(plan, 'rd-2')
  expect(rebound.applicationSourceRepositoryRequest?.destinationRevision).toBe('rd-2')
  expect(plan.applicationSourceRepositoryRequest?.destinationRevision).toBe('rd-1')
  expect(withDestinationRevision(plan, 'rd-1')).toBe(plan)
  const adopted = { ...plan, applicationSourceRepositoryRequest: { existing: { repository: 'acme/shared' } } }
  expect(newRepositoryRequest(adopted)).toBeUndefined()
  expect(withDestinationRevision(adopted, 'rd-2')).toBe(adopted)
  expect(newRepositoryRequest({ ...plan, applicationSourceRepositoryRequest: undefined })).toBeUndefined()
})

test.each([undefined, 'foo', 'explicit-id'])('moves only the application ID derived from the old name: %s', (id) => {
  const normalized = { ...plan, applicationStackRequest: { ...plan.applicationStackRequest!, application: { name: 'foo', ...(id ? { id } : {}) } } }
  const renamed = renameCreationPlan(normalized, 'foo-2')
  expect(renamed.applicationStackRequest?.application).toEqual({ name: 'foo-2', ...(id ? { id: id === 'foo' ? 'foo-2' : id } : {}) })
  expect(normalized.applicationStackRequest.application.id).toBe(id)
})

test('does not rename existing source repositories or shared sample images', () => {
  const adopted = { ...plan, applicationSourceRepositoryRequest: { existing: { repository: 'acme/shared' }, image: { imagePath: 'ghcr.io/acme/shared' } }, applicationStackRequest: { ...plan.applicationStackRequest!, source: { kind: 'sample-image' as const, imageRef: 'ghcr.io/acme/shared:v1' } } }
  const renamed = renameCreationPlan(adopted, 'foo-2')
  expect(renamed.applicationSourceRepositoryRequest).toBe(adopted.applicationSourceRepositoryRequest)
  expect(renamed.applicationStackRequest?.source).toBe(adopted.applicationStackRequest.source)
})

test('renames inline template outputs and preserves registry authority and image tag', () => {
  const inline = { ...plan, applicationSourceRepositoryRequest: undefined, applicationStackRequest: { ...plan.applicationStackRequest!, source: { kind: 'github-template' as const, githubTemplate: { repositoryUrl: 'https://github.com/appthrust/template', newRepositoryName: 'foo' }, imageRef: 'registry.test:5000/acme/foo:v1' } } }
  expect(renameCreationPlan(inline, 'foo-2').applicationStackRequest?.source).toMatchObject({ githubTemplate: { newRepositoryName: 'foo-2' }, imageRef: 'registry.test:5000/acme/foo-2:v1' })
})

test('defaults absent and disabled publish without mutating the plan', () => {
  for (const publish of [undefined, null, { enabled: false }]) {
    const original = { ...plan, applicationStackRequest: { ...plan.applicationStackRequest!, publish } }
    // Real model output is not parsed; disabled/null publish may violate the enabled-only schema.
    const updated = withDefaultPublish(original as unknown as ApplicationDraftCreationPlan, { domain: 'project.test' })
    expect(updated.applicationStackRequest?.publish).toEqual({ enabled: true, customDomain: 'project.test', hostnamePattern: 'wildcard', subdomain: 'foo' })
    expect(original.applicationStackRequest.publish).toBe(publish)
    expect(updated.toolPlan).toBe(plan.toolPlan)
  }
})

test('keeps enabled publish and does nothing without a domain or stack', () => {
  expect(withDefaultPublish(plan, { domain: 'other.test' })).toBe(plan)
  const absent = { ...plan, applicationStackRequest: { ...plan.applicationStackRequest!, publish: undefined } }
  expect(withDefaultPublish(absent, {})).toBe(absent)
  const noStack = { ...plan, applicationStackRequest: undefined }
  expect(withDefaultPublish(noStack, { domain: 'project.test' })).toBe(noStack)
})

test('uses the application name fallback and defaults a renamed unpublished plan', () => {
  const absent = { ...plan, applicationStackRequest: { ...plan.applicationStackRequest!, application: { name: '' }, applicationName: 'fallback', publish: undefined } }
  expect(withDefaultPublish(absent, { domain: 'project.test' }).applicationStackRequest?.publish?.subdomain).toBe('fallback')
  expect(renameCreationPlan(absent, 'foo-2', { domain: 'project.test' }).applicationStackRequest?.publish).toEqual({ enabled: true, customDomain: 'project.test', hostnamePattern: 'wildcard', subdomain: 'foo-2' })
})
