import { describe, expect, mock, test } from 'bun:test'
import { YAML } from 'bun'
import { catalogContainsRelease, renderEntry, submitEntry, type CatalogEntry, type CatalogVersion } from './publish-entry'

const template = await Bun.file(new URL('../catalog/entry.yaml', import.meta.url)).text()
const digest = `sha256:${'a'.repeat(64)}`
const nextDigest = `sha256:${'b'.repeat(64)}`

interface TestDefinition {
  publisherReleases?: unknown
  spec: {
    versions: CatalogVersion[]
    updatePolicy: CatalogEntry['updatePolicy']
    display: { category: string; iconRef?: { name: string } }
    [key: string]: unknown
  }
}

function withMinimum(version: string, minimum: unknown): string {
  return YAML.stringify({ ...YAML.parse(template) as TestDefinition, publisherReleases: { [version]: { minPlatformVersion: minimum } } })
}

describe('renderEntry', () => {
  test('keeps both catalog floors and every non-version field with the new app image as the only default', () => {
    const entry = renderEntry(template, '0.3.0', digest)
    expect(entry.slug).toBe('builder-console')
    expect(entry.display).toEqual({ category: 'build', icon: 'sparkles' })
    expect(entry.updatePolicy).toEqual({ default: 'pinned', allowed: ['pinned', 'follow'] })
    expect(entry.publishedAt).toBeNull()
    expect(entry.versions).toHaveLength(3)
    const floor = YAML.parse(template) as TestDefinition
    expect(floor.spec.versions.map((version: { name: string }) => version.name)).toEqual(['0.1.0', '0.2.0'])
    expect(entry.versions.slice(0, 2)).toEqual(floor.spec.versions.map(version => ({ ...version, default: false, served: true })))
    expect(entry.versions[2]).toEqual({ name: '0.3.0', images: { web: `ghcr.io/appthrust/builder-console@${digest}` }, stream: '0.3', default: true, served: true })
    const definition = YAML.parse(entry.definitionYAML) as TestDefinition
    expect({ ...definition.spec, versions: [] }).toEqual({ ...floor.spec, versions: [] })
    expect(definition.spec.versions).toEqual(entry.versions)
    expect(definition.spec.components).toHaveLength(2)
    expect(definition.spec.releaseIdentityEnvPrefix).toBe('BUILDER_CONSOLE')
    expect(definition.spec.dependencies).toEqual([{
      definition: 'directory',
      installPolicy: 'Automatic',
      publicURLEnv: 'BUILDER_CONSOLE_DIRECTORY_PUBLIC_URL',
      urlEnv: 'BUILDER_CONSOLE_DIRECTORY_URL',
    }])
  })

  test('merges persisted history on subsequent tags without mutating it', () => {
    const previous = renderEntry(template, '0.3.0', digest)
    previous.publishedAt = '2026-11-06T00:00:00Z'
    const entry = renderEntry(template, '0.3.1', nextDigest, previous)
    expect(entry.versions.map(version => version.name)).toEqual(['0.1.0', '0.2.0', '0.3.0', '0.3.1'])
    expect(entry.versions.filter(version => version.default).map(version => version.name)).toEqual(['0.3.1'])
    expect(entry.versions.every(version => version.served)).toBe(true)
    expect(entry.versions[2]!.images.web).toBe(`ghcr.io/appthrust/builder-console@${digest}`)
    expect(entry.publishedAt).toBe(previous.publishedAt)
    expect(previous.versions[2]!.default).toBe(true)
  })

  test('repeating an immutable release does not duplicate it', () => {
    const previous = renderEntry(template, '0.3.0', digest)
    expect(renderEntry(template, '0.3.0', digest, previous)).toEqual(previous)
  })

  test('refuses to replace the floor or an existing image digest', () => {
    expect(() => renderEntry(template, '0.1.0', digest)).toThrow('version 0.1.0 already has different immutable images')
    expect(() => renderEntry(template, '0.2.0', digest)).toThrow('version 0.2.0 already has different immutable images')
    const previous = renderEntry(template, '0.3.0', digest)
    expect(() => renderEntry(template, '0.3.0', nextDigest, previous)).toThrow('version 0.3.0 already has different immutable images')
  })

  test('rejects malformed release coordinates before publication', () => {
    for (const version of ['v0.3.0', '0.3', '01.2.3', '0.3.0+build', '0.3.0-01']) {
      expect(() => renderEntry(template, version, digest)).toThrow('version must be SemVer')
    }
    for (const invalid of ['latest', `sha256:${'0'.repeat(64)}`, `sha256:${'G'.repeat(64)}`]) {
      expect(() => renderEntry(template, '0.3.0', invalid)).toThrow('digest must be a non-placeholder')
    }
  })

  test('attaches the declared minimum only to the published version and strips publisher metadata', () => {
    const entry = renderEntry(withMinimum('0.3.0', 'v0.1.0-rc.30'), '0.3.0', digest)
    expect(entry.versions.map(version => version.minPlatformVersion)).toEqual([undefined, undefined, 'v0.1.0-rc.30'])
    const definition = YAML.parse(entry.definitionYAML) as TestDefinition
    expect(definition.publisherReleases).toBeUndefined()
    expect(definition.spec.versions).toEqual(entry.versions)
  })

  test('absent metadata produces byte-identical legacy entry output', () => {
    const definition = YAML.parse(template) as TestDefinition
    delete definition.publisherReleases
    const withoutMetadata = YAML.stringify(definition)
    definition.spec.versions = definition.spec.versions.map(version => ({ ...version, default: false, served: true }))
    definition.spec.versions.push({
      name: '0.3.0', images: { web: `ghcr.io/appthrust/builder-console@${digest}` },
      stream: '0.3', served: true, default: true,
    })
    const expected = {
      slug: 'builder-console', definitionYAML: YAML.stringify(definition),
      versions: definition.spec.versions, updatePolicy: definition.spec.updatePolicy,
      display: { category: definition.spec.display.category, icon: definition.spec.display.iconRef?.name },
      publishedAt: null,
    }
    expect(JSON.stringify(renderEntry(withoutMetadata, '0.3.0', digest))).toBe(JSON.stringify(expected))
    expect(JSON.stringify(renderEntry(template, '0.3.0', digest))).toBe(JSON.stringify(expected))
  })

  test('validates minimum format and length', () => {
    for (const minimum of ['', ' ', 'v0.1.0 rc.30', '0.1.0\n', '0.1', '01.1.0', 'v0.1.0-01', '0.1.0+build', `0.1.0-${'a'.repeat(58)}`, null, 123]) {
      expect(() => renderEntry(withMinimum('0.3.0', minimum), '0.3.0', digest)).toThrow('minPlatformVersion must be SemVer')
    }
    for (const minimum of ['0.1.0', 'v0.1.0-rc.30', `0.1.0-${'a'.repeat(57)}`]) {
      expect(renderEntry(withMinimum('0.3.0', minimum), '0.3.0', digest).versions[2]!.minPlatformVersion).toBe(minimum)
    }
  })

  test('rejects declarations for another unrecorded release', () => {
    expect(() => renderEntry(withMinimum('0.3.1', 'v0.1.0'), '0.3.0', digest))
      .toThrow('publisherReleases version 0.3.1 is neither the published version 0.3.0 nor recorded catalog history')
  })

  test('keeps recorded minimums immutable and preserves historical declarations', () => {
    const source = withMinimum('0.3.0', 'v0.1.0-rc.30')
    const previous = renderEntry(source, '0.3.0', digest)
    expect(renderEntry(source, '0.3.0', digest, previous)).toEqual(previous)
    expect(renderEntry(template, '0.3.0', digest, previous)).toEqual(previous)
    const next = renderEntry(source, '0.3.1', nextDigest, previous)
    expect(next.versions[2]!.minPlatformVersion).toBe('v0.1.0-rc.30')
    expect(next.versions[3]!.minPlatformVersion).toBeUndefined()
    expect(previous.versions[2]!.default).toBe(true)
    for (const version of ['0.3.0', '0.3.1']) {
      expect(() => renderEntry(withMinimum('0.3.0', 'v0.1.0'), version, digest, previous))
        .toThrow('version 0.3.0 already has different immutable minPlatformVersion')
    }
    const unannotated = renderEntry(template, '0.3.0', digest)
    expect(() => renderEntry(source, '0.3.0', digest, unannotated))
      .toThrow('version 0.3.0 already has different immutable minPlatformVersion')
  })
})

test('catalog readback requires the exact slug, version and image digest', () => {
  const entry = renderEntry(template, '0.3.0', digest)
  expect(catalogContainsRelease({ schemaVersion: 1, entries: [entry] }, '0.3.0', digest)).toBe(true)
  expect(catalogContainsRelease({ schemaVersion: 1, entries: [entry] }, '0.3.0', nextDigest)).toBe(false)
  expect(catalogContainsRelease({ schemaVersion: 1, entries: [entry] }, '0.3.1', digest)).toBe(false)
  expect(catalogContainsRelease({ schemaVersion: 1, entries: [{ ...entry, slug: 'contacts' }] }, '0.3.0', digest)).toBe(false)
  expect(catalogContainsRelease({ entries: [entry] }, '0.3.0', digest)).toBe(false)
})

describe('submitEntry', () => {
  for (const [status, state] of [[202, 'queued'], [200, 'snapshot']] as const) {
    test(`returns the ${state} snapshot without polling when publication returns ${status}`, async () => {
      const fetcher = mock(async (url: string, init: RequestInit) => {
        expect(init.headers).toEqual({ authorization: 'Bearer admin-token', 'content-type': 'application/json' })
        if (url.endsWith('/entries')) {
          expect(init.method).toBe('GET')
          return Response.json({ data: [] })
        }
        if (url.endsWith('/entries/builder-console')) {
          expect(init.method).toBe('PUT')
          expect(JSON.parse(init.body as string)).toEqual(renderEntry(template, '0.3.0', digest))
          return Response.json({})
        }
        expect(url).toBe('https://catalog.example/api/v1/catalog/publish')
        expect(init.method).toBe('POST')
        return Response.json({ id: 'immutable-snapshot', state }, { status })
      })
      expect(await submitEntry(template, '0.3.0', digest, 'https://catalog.example', 'admin-token', fetcher))
        .toEqual({ id: 'immutable-snapshot', state })
      expect(fetcher).toHaveBeenCalledTimes(3)
    })
  }

  for (const [status, publication] of [
    [200, { id: 'snapshot', state: 'queued' }],
    [202, { id: 'snapshot', state: 'snapshot' }],
    [200, { state: 'snapshot' }],
    [200, { id: 'snapshot\nstate=queued', state: 'snapshot' }],
    [202, { id: 'snapshot', state: 'complete' }],
    [500, { error: 'dispatch failed' }],
  ] as const) {
    test(`rejects invalid publication response ${status} ${JSON.stringify(publication)}`, async () => {
      const fetcher = mock(async (url: string) => {
        if (url.endsWith('/entries')) return Response.json({ data: [] })
        if (url.endsWith('/entries/builder-console')) return Response.json({})
        return Response.json(publication, { status })
      })
      await expect(submitEntry(template, '0.3.0', digest, 'https://catalog.example', 'admin-token', fetcher))
        .rejects.toThrow(status === 500 ? 'POST /catalog/publish failed (500)' : 'catalog publish response must contain')
      expect(fetcher).toHaveBeenCalledTimes(3)
    })
  }
})
