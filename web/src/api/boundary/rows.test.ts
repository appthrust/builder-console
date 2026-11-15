import { expect, test } from 'bun:test'
import { DnsLabelName } from '@appthrust/api-schema/platform-api'
import { z } from 'zod'
import { decodeResponse, defineResponseContract, independentRows, MAX_ISSUES, unreadableRowIssues } from '.'
import { isDeclaredResponsePath } from './contract'
import { assertWireContractCases } from '../testing/wire-contract-cases'

const SECRET = 'SENTINEL-row-content'
const row = z.object({ id: DnsLabelName, name: z.string(), details: z.record(z.string(), z.object({ count: z.number() })).optional() })
const identity = { source: 'platform' as const, operationId: 'testIndependentRows', method: 'GET' as const, routeTemplate: '/rows', successStatuses: [200] }
const contract = defineResponseContract({ ...identity, reader: independentRows(row, DnsLabelName), recoveries: unreadableRowIssues })

test('independent rows retain only valid DNS identities, including when every row is rejected', () => {
  const invalid = [null, 'not an object', [], { id: 7 }, { id: '' }, { id: 'Bad Id!' }]
  assertWireContractCases(contract, [
    { name: 'non-object and invalid-id rows', path: '/data', variant: 'unknown', wire: { data: invalid }, expect: { accept: true, value: { data: [], unreadable: invalid.map(() => ({})) } } },
    { name: 'only a valid identity survives a rejected row', path: '/data', variant: 'unknown', wire: { data: [{ id: 'bad-row', name: { secret: SECRET } }, { id: 'good-row', name: 'Known' }] }, expect: { accept: true, value: { data: [{ id: 'good-row', name: 'Known' }], unreadable: [{ id: 'bad-row' }] } } },
    ...[null, [], 'not an envelope', {}, { data: null }, { data: {} }].map((wire) => ({ name: 'broken envelope', path: '/', variant: 'unknown' as const, wire, expect: { accept: false as const } })),
  ])
})

test('row recoveries retain schema paths, mask dynamic keys, and deduplicate', () => {
  const result = decodeResponse(contract, { data: Array.from({ length: 30 }, () => ({ id: 'bad-row', name: 5, details: { [SECRET]: { count: SECRET } } })) })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value.data).toEqual([])
  expect(result.value.unreadable).toHaveLength(30)
  expect(result.recovered).toEqual([
    { path: '/data/*/name', code: 'invalid_type' },
    { path: '/data/*/details/*/count', code: 'invalid_type' },
  ])
  for (const issue of result.recovered!) expect(isDeclaredResponsePath(contract, issue.path)).toBe(true)
  expect(JSON.stringify(result)).not.toContain(SECRET)
})

test('recovery diagnostics are capped at MAX_ISSUES without dropping unreadable entries', () => {
  const fields = Object.fromEntries(Array.from({ length: MAX_ISSUES + 5 }, (_, index) => [`field${index}`, z.number()]))
  const reader = z.object({ id: DnsLabelName, ...fields })
  const many = defineResponseContract({ ...identity, reader: independentRows(reader, DnsLabelName), recoveries: unreadableRowIssues })
  const bad = { id: 'bad-row', ...Object.fromEntries(Object.keys(fields).map((key) => [key, SECRET])) }
  const result = decodeResponse(many, { data: Array.from({ length: 30 }, () => bad) })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value.unreadable).toHaveLength(30)
  expect(result.recovered).toHaveLength(MAX_ISSUES)
  expect(new Set(result.recovered!.map((issue) => `${issue.path}:${issue.code}`)).size).toBe(MAX_ISSUES)
  expect(JSON.stringify(result.recovered)).not.toContain(SECRET)
})
