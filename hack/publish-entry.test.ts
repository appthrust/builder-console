import { describe, expect, mock, test } from 'bun:test'
import { YAML } from 'bun'
import { catalogContainsRelease, renderEntry, submitEntry } from './publish-entry'

const template = await Bun.file(new URL('../catalog/entry.yaml', import.meta.url)).text()
const digest = `sha256:${'a'.repeat(64)}`
const nextDigest = `sha256:${'b'.repeat(64)}`

describe('renderEntry', () => {
  test('keeps both catalog floors and every non-version field with the new app image as the only default', () => {
    const entry = renderEntry(template, '0.3.0', digest)
    expect(entry.slug).toBe('builder-console')
    expect(entry.display).toEqual({ category: 'build', icon: 'sparkles' })
    expect(entry.updatePolicy).toEqual({ default: 'pinned', allowed: ['pinned', 'follow'] })
    expect(entry.publishedAt).toBeNull()
    expect(entry.versions).toHaveLength(3)
    const floor = YAML.parse(template)
    expect(floor.spec.versions.map((version: { name: string }) => version.name)).toEqual(['0.1.0', '0.2.0'])
    expect(entry.versions.slice(0, 2)).toEqual(floor.spec.versions.map((version: object) => ({ ...version, default: false, served: true })))
    expect(entry.versions[2]).toEqual({ name: '0.3.0', images: { web: `ghcr.io/appthrust/builder-console@${digest}` }, stream: '0.3', default: true, served: true })
    const definition = YAML.parse(entry.definitionYAML)
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
