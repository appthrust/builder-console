import { expect, test } from 'bun:test'
import { z } from 'zod'
import { defineResponseContract, isDeclaredResponsePath } from './contract'

const contract = defineResponseContract({
  operationId: 'readResource', source: 'console', method: 'GET', routeTemplate: '/resource', successStatuses: [200],
  reader: z.object({ person: z.object({ subject: z.string() }), records: z.record(z.string(), z.object({ value: z.string() })) }),
})

test('test-support paths trust declared fields, never dynamic record keys or unknown contracts', () => {
  expect(isDeclaredResponsePath(contract, '/person/subject')).toBe(true)
  expect(isDeclaredResponsePath(contract, '/records/*/value')).toBe(true)
  expect(isDeclaredResponsePath(contract, '/records/SECRET/value')).toBe(false)
  expect(isDeclaredResponsePath(contract, '/person/SECRET')).toBe(false)
  expect(isDeclaredResponsePath({ ...contract, parse: () => ({ ok: false, issues: [] }) }, '/person/subject')).toBe(false)
  // Operation factories add transport metadata with a shallow copy.
  expect(isDeclaredResponsePath({ ...contract }, '/person/subject')).toBe(true)
})
