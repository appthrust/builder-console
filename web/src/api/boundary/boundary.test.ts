import { describe, expect, mock, test } from 'bun:test'
import { z } from 'zod'
import { assertWireContractCases, type WireContractCase } from '../testing/wire-contract-cases'
import {
  absentMeansEmpty,
  contractFailureReport,
  createConsoleWarnReporter,
  decodeResponse,
  defineResponseContract,
  isResponseContractError,
  MAX_ISSUES,
  openEnum,
  openUnion,
  RESPONSE_CONTRACT_MESSAGE,
  ResponseContractError,
  safePath,
} from '.'

const SECRET = 'SENTINEL-7f3a-do-not-leak'

const items = absentMeansEmpty(z.array(z.object({ name: z.string() })).max(5), { path: '/items', evidence: 'test fixture' })
const source = openUnion({
  discriminator: 'kind',
  identity: z.object({ id: z.string().min(1) }),
  variants: {
    GitCommit: z.object({ id: z.string(), kind: z.literal('GitCommit'), gitCommit: z.object({ sha: z.string().min(7) }) }),
    Image: z.object({ id: z.string(), kind: z.literal('Image'), image: z.object({ ref: z.string() }) }),
  },
})
const reader = z.object({
  id: z.string().min(1),
  role: openEnum(['web', 'worker']),
  sources: z.array(source),
  items: items.schema,
  labels: z.record(z.string(), z.object({ value: z.number() })).optional(),
  note: z.string().nullable(),
})
const contract = defineResponseContract({
  operationId: 'testGetThing',
  source: 'platform',
  method: 'GET',
  routeTemplate: '/things/{id}',
  successStatuses: [200],
  reader,
  fieldPolicies: [items.policy],
})

const base = { id: 'thing-1', role: 'web', sources: [{ id: 's1', kind: 'GitCommit', gitCommit: { sha: 'abcdef12' } }], items: [{ name: 'a' }], note: null }
const without = (key: keyof typeof base) => Object.fromEntries(Object.entries(base).filter(([name]) => name !== key))

const cases: WireContractCase<z.output<typeof reader>>[] = [
  { name: 'valid base', variant: 'present', path: '/', wire: base, expect: { accept: true } },
  { name: 'registered collection absent reads as empty', variant: 'absent', path: '/items', wire: without('items'), expect: { accept: true, check: (value) => expect(value.items).toEqual([]) } },
  { name: 'registered collection null is a failure', variant: 'null', path: '/items', wire: { ...base, items: null }, expect: { accept: false, issues: [{ path: '/items', code: 'invalid_type' }] } },
  { name: 'registered collection empty', variant: 'empty', path: '/items', wire: { ...base, items: [] }, expect: { accept: true, check: (value) => expect(value.items).toEqual([]) } },
  { name: 'registered collection present', variant: 'present', path: '/items', wire: { ...base, items: [{ name: 'a' }, { name: 'b' }] }, expect: { accept: true, check: (value) => expect(value.items).toHaveLength(2) } },
  { name: 'registered collection with a broken element', variant: 'unknown', path: '/items', wire: { ...base, items: [{ name: SECRET.length }] }, expect: { accept: false, issues: [{ path: '/items/*/name', code: 'invalid_type' }] } },
  { name: 'required field absent', variant: 'absent', path: '/id', wire: without('id'), expect: { accept: false, issues: [{ path: '/id', code: 'missing' }] } },
  { name: 'required collection absent (not registered)', variant: 'absent', path: '/sources', wire: without('sources'), expect: { accept: false, issues: [{ path: '/sources', code: 'missing' }] } },
  { name: 'required collection null', variant: 'null', path: '/sources', wire: { ...base, sources: null }, expect: { accept: false, issues: [{ path: '/sources', code: 'invalid_type' }] } },
  { name: 'broken required field (wrong type)', variant: 'unknown', path: '/id', wire: { ...base, id: 42 }, expect: { accept: false, issues: [{ path: '/id', code: 'invalid_type' }] } },
  { name: 'broken required field (empty string)', variant: 'empty', path: '/id', wire: { ...base, id: '' }, expect: { accept: false, issues: [{ path: '/id', code: 'invalid_value' }] } },
  { name: 'nullable field null', variant: 'null', path: '/note', wire: base, expect: { accept: true, check: (value) => expect(value.note).toBeNull() } },
  {
    name: 'unknown field is dropped',
    variant: 'unknown',
    path: '/',
    wire: { ...base, addedLater: { secret: SECRET } },
    expect: { accept: true, check: (value) => expect(value).not.toHaveProperty('addedLater') },
  },
  { name: 'unknown enum value', variant: 'unknown', path: '/role', wire: { ...base, role: SECRET }, expect: { accept: true, check: (value) => expect(value.role).toEqual({ kind: 'unknown' }) } },
  { name: 'known enum value', variant: 'present', path: '/role', wire: { ...base, role: 'worker' }, expect: { accept: true, check: (value) => expect(value.role).toEqual({ kind: 'known', value: 'worker' }) } },
  { name: 'enum null is not unknown', variant: 'null', path: '/role', wire: { ...base, role: null }, expect: { accept: false, issues: [{ path: '/role', code: 'invalid_type' }] } },
  {
    name: 'unknown variant keeps its identity',
    variant: 'unknown',
    path: '/sources',
    wire: { ...base, sources: [{ id: 's2', kind: 'Helm', helm: { chart: SECRET } }] },
    expect: { accept: true, check: (value) => expect(value.sources).toEqual([{ kind: 'unsupported', identity: { id: 's2' } }]) },
  },
  {
    name: 'broken known variant is a failure, not unsupported',
    variant: 'unknown',
    path: '/sources',
    wire: { ...base, sources: [{ id: 's3', kind: 'GitCommit', gitCommit: {} }] },
    expect: { accept: false, issues: [{ path: '/sources/*/gitCommit/sha', code: 'missing' }] },
  },
  {
    name: 'variant without identity is a failure',
    variant: 'absent',
    path: '/sources',
    wire: { ...base, sources: [{ kind: 'Helm' }] },
    expect: { accept: false, issues: [{ path: '/sources/*/id', code: 'missing' }] },
  },
  {
    name: 'dynamic record keys never appear in paths',
    variant: 'unknown',
    path: '/labels',
    wire: { ...base, labels: { [SECRET]: { value: 'x' } } },
    expect: { accept: false, issues: [{ path: '/labels/*/value', code: 'invalid_type' }] },
  },
  { name: 'body that is not an object', variant: 'unknown', path: '/', wire: [SECRET], expect: { accept: false, issues: [{ path: '/', code: 'invalid_type' }] } },
]

describe('decodeResponse', () => {
  test('wire variants: absent / null / empty / present / unknown field, enum and variant / broken required', () => {
    assertWireContractCases(contract, cases)
  })

  test('a failure carries only safe metadata: fixed message, no cause, no payload', () => {
    const result = decodeResponse(contract, { ...base, id: SECRET.length, labels: { [SECRET]: { value: SECRET } } })
    if (result.ok) throw new Error('expected a failure')
    const error = result.error
    expect(error).toBeInstanceOf(ResponseContractError)
    expect(isResponseContractError(error)).toBe(true)
    expect(error.message).toBe(RESPONSE_CONTRACT_MESSAGE)
    expect(error.cause).toBeUndefined()
    expect(error).toMatchObject({ code: 'response_contract_invalid', retryable: false, source: 'platform', operationId: 'testGetThing', method: 'GET', routeTemplate: '/things/{id}', outcome: 'read_failed' })
    const everything = `${error.message}${error.stack}${JSON.stringify(error)}${JSON.stringify(contractFailureReport(error))}`
    expect(everything).not.toContain(SECRET)
  })

  test('a reader transform that throws is contained without its message', () => {
    const throwing = defineResponseContract({
      operationId: 'testThrow',
      source: 'console',
      method: 'POST',
      routeTemplate: '/x',
      successStatuses: [201],
      reader: z.string().transform((): string => { throw new Error(SECRET) }),
    })
    const result = decodeResponse(throwing, 'x')
    if (result.ok) throw new Error('expected a failure')
    expect(result.error.issues).toEqual([{ path: '/', code: 'invalid_value' }])
    expect(result.error.outcome).toBe('write_unconfirmed')
    expect(JSON.stringify(contractFailureReport(result.error))).not.toContain(SECRET)
  })

  test('issues are bounded and deduplicated', () => {
    const wide = defineResponseContract({ operationId: 'w', source: 'platform', method: 'GET', routeTemplate: '/w', successStatuses: [200], reader: z.array(z.object({ a: z.string(), b: z.string() })) })
    const result = decodeResponse(wide, Array.from({ length: 50 }, () => ({})))
    if (result.ok) throw new Error('expected a failure')
    expect(result.error.issues).toEqual([{ path: '/*/a', code: 'missing' }, { path: '/*/b', code: 'missing' }])
    const many = defineResponseContract({ operationId: 'm', source: 'platform', method: 'GET', routeTemplate: '/m', successStatuses: [200], reader: z.object(Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`f${index}`, z.string()]))) })
    const manyResult = decodeResponse(many, {})
    if (manyResult.ok) throw new Error('expected a failure')
    expect(manyResult.error.issues).toHaveLength(MAX_ISSUES)
  })

  test('safe paths keep only declared field names', () => {
    expect(safePath(reader, [])).toBe('/')
    expect(safePath(reader, ['sources', 3, 'gitCommit', 'sha'])).toBe('/sources/*/gitCommit/sha')
    expect(safePath(reader, ['labels', SECRET, 'value'])).toBe('/labels/*/value')
    expect(safePath(reader, [SECRET])).toBe('/*')
  })

  test('assertWireContractCases requires absent and null cases for every registered field', () => {
    expect(() => assertWireContractCases(contract, cases.filter((item) => item.path !== '/items'))).toThrow("/items: registered absent-means-empty field has no accepted 'absent' case")
    expect(() => assertWireContractCases(contract, [{ name: 'wrong expectation', variant: 'present', path: '/', wire: { ...base, id: 1 }, expect: { accept: true } }])).toThrow('rejected (invalid_type /id), expected accept')
  })

  test('assertWireContractCases catches a contract that leaks wire values into its report', () => {
    const leakedId = (wire: unknown) => (typeof wire === 'object' && wire !== null && 'id' in wire ? String(wire.id) : '')
    const leaky = { ...contract, parse: (wire: unknown) => ({ ok: false as const, issues: [{ path: `/${leakedId(wire)}`, code: 'invalid_value' as const }] }) }
    expect(() => assertWireContractCases(leaky, [{ name: 'leak', variant: 'unknown', path: '/id', wire: { id: SECRET }, expect: { accept: false } }])).toThrow('leaked into the error report')
  })
})

describe('createConsoleWarnReporter', () => {
  test('warns once per operation and schema path', () => {
    const warn = mock((_message: string, _report: unknown) => {})
    const report = createConsoleWarnReporter(warn)
    const failure = (path: string, operationId = 'testGetThing') => contractFailureReport(new ResponseContractError({ source: 'platform', operationId, method: 'GET', routeTemplate: '/things/{id}', issues: [{ path, code: 'missing' }] }))
    report(failure('/a'))
    report(failure('/a'))
    report(failure('/b'))
    report(failure('/a', 'other'))
    expect(warn).toHaveBeenCalledTimes(3)
    expect(warn.mock.calls.map((call) => call[1])).toMatchObject([
      { operationId: 'testGetThing', issues: [{ path: '/a' }] },
      { operationId: 'testGetThing', issues: [{ path: '/b' }] },
      { operationId: 'other', issues: [{ path: '/a' }] },
    ])
  })
})
