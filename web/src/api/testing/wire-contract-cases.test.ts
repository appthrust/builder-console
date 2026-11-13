import { expect, spyOn, test } from 'bun:test'
import { z } from 'zod'
import * as boundary from '../boundary'
import { defineResponseContract, ResponseContractError } from '../boundary'
import { assertWireContractCases } from './wire-contract-cases'

const SECRET = 'SENTINEL-redaction-seam-e38a'
const contract = defineResponseContract({
  operationId: 'readResource', source: 'console', method: 'GET', routeTemplate: '/resources', successStatuses: [200],
  reader: z.object({ person: z.object({ subject: z.string() }), about: z.string(), aboutUpdatedBy: z.string(), records: z.record(z.string(), z.object({ value: z.string() })) }),
})

test('payload/key coincidences with declared path segments are not leaks', () => {
  assertWireContractCases(contract, [
    { name: 'value equals declared person field', variant: 'absent', path: '/person/subject', wire: { person: { subjectId: 'person' }, about: '', aboutUpdatedBy: '', records: {} }, expect: { accept: false, issues: [{ path: '/person/subject', code: 'missing' }] } },
    { name: 'about is a substring of aboutUpdatedBy', variant: 'absent', path: '/aboutUpdatedBy', wire: { person: { subject: 'subject-001' }, about: '', records: {} }, expect: { accept: false, issues: [{ path: '/aboutUpdatedBy', code: 'missing' }] } },
  ])
})

for (const location of ['path', 'message', 'report', 'dynamic-record-key', 'undeclared-segment'] as const) {
  test(`redaction seam rejects payload leakage in ${location}`, () => {
    const value = location === 'dynamic-record-key' ? 'customer-column' : location === 'undeclared-segment' ? 'not-a-schema-field' : SECRET
    const error = new ResponseContractError({
      source: 'console', operationId: 'readResource', method: 'GET', routeTemplate: '/resources',
      issues: [{ path: location === 'dynamic-record-key' ? `/records/${value}/value` : location === 'path' || location === 'undeclared-segment' ? `/person/${value}` : '/person/subject', code: 'invalid_type' }],
    })
    if (location === 'message') error.message = value
    if (location === 'report') Object.defineProperty(error, 'operationId', { value: `read-${value}` })
    // Deliberately inject an unsafe decoder result to test the test seam's
    // rejection, not the production decoder (which sanitizes these paths).
    const decode = spyOn(boundary, 'decodeResponse').mockReturnValue({ ok: false, error })
    try {
      expect(() => assertWireContractCases(contract, [{
        name: 'unsafe result', variant: 'unknown', path: '/',
        wire: { person: { subject: value }, about: '', records: { [value]: { value: 42 } } }, expect: { accept: false },
      }])).toThrow('Wire contract cases failed')
    } finally { decode.mockRestore() }
  })
}
