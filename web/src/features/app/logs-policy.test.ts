import { expect, test } from 'bun:test'
import { ORPCError } from '@orpc/client'
import { isLogsForbidden, logsPollInterval } from '../../api/queries'

test('log permission denial stops after the first request, without transport retries', () => {
  const error = new ORPCError('FORBIDDEN', { status: 403 })
  expect(isLogsForbidden(error)).toBe(true)
  expect(logsPollInterval({ error, errorUpdateCount: 1 })).toBe(false)
})

test('other log errors stop after three failed reads and successful manual reads can resume polling', () => {
  const error = new ORPCError('INTERNAL_SERVER_ERROR', { status: 500 })
  expect(isLogsForbidden(error)).toBe(false)
  expect(logsPollInterval({ error, errorUpdateCount: 1 })).toBe(5000)
  expect(logsPollInterval({ error, errorUpdateCount: 2 })).toBe(5000)
  expect(logsPollInterval({ error, errorUpdateCount: 3 })).toBe(false)
  expect(logsPollInterval({ error: null, errorUpdateCount: 3 })).toBe(5000)
})
