import { describe, expect, test } from 'bun:test'
import { copy } from '../../copy'
import { detailsSchema, firstError, initialValues, startSchema, stepFields, suggestedUrlName } from './form'

describe('create validation', () => {
  test.each([
    ['', copy.create.details.urlNameEmpty],
    ['a'.repeat(64), copy.create.details.urlNameTooLong],
    ['a b', copy.create.details.urlNameInvalid],
    ['Upper', copy.create.details.urlNameInvalid],
    ['new', copy.create.details.urlNameReserved],
  ])('URL name %s has a distinct actionable message', (value, message) => {
    const result = detailsSchema.shape.urlName.safeParse(value)
    expect(result.success).toBe(false)
    if (!result.success) expect(firstError(result.error.issues)).toBe(message)
  })

  test('63 characters is valid and every wizard entry validates the URL field', () => {
    expect(detailsSchema.shape.urlName.safeParse('a'.repeat(63)).success).toBe(true)
    expect(stepFields(1, 'template')).toContain('urlName')
  })

  test.each(['ghcr.io/acme/app:1.0', 'localhost:5000/acme/app', `registry.example/app@sha256:${'a'.repeat(64)}`])('accepts image %s', (imageRef) => {
    expect(startSchema.safeParse({ imageRef }).success).toBe(true)
  })
  test.each(['not a valid image!!', 'https://ghcr.io/acme/app', 'ghcr.io/', 'ghcr.io/UPPER', 'ghcr.io/a@sha256:bad', 'localhost:65536/app', 'ghcr.io/a:'])('rejects malformed image %s before advancing', (imageRef) => {
    const result = startSchema.safeParse({ imageRef })
    expect(result.success).toBe(false)
    if (!result.success) expect(firstError(result.error.issues)).toBe(copy.create.advanced.imageInvalid)
  })
  test('empty image asks for an image rather than a format correction', () => {
    const result = startSchema.safeParse({ imageRef: ' ' })
    expect(result.success).toBe(false)
    if (!result.success) expect(firstError(result.error.issues)).toBe(copy.create.advanced.imageRequired)
  })

  test('a kanji-only name on a business template suggests the template word; other entries keep app-<hex>', () => {
    const base = initialValues('sales')
    expect(suggestedUrlName({ ...base, entry: 'template', templateId: 'biz-inventory-postgres', displayName: '在庫管理' })).toBe('inventory')
    expect(suggestedUrlName({ ...base, entry: 'template', templateId: 'biz-approval-postgres', displayName: '経費精算' })).toBe('approval')
    expect(suggestedUrlName({ ...base, entry: 'template', templateId: 'biz-inventory-postgres', displayName: 'Stock 2' })).toBe('stock-2')
    expect(suggestedUrlName({ ...base, entry: 'template', templateId: 'nextjs-postgres', displayName: '在庫管理' })).toMatch(/^app-[0-9a-f]{6}$/)
    expect(suggestedUrlName({ ...base, entry: 'image', displayName: '在庫管理' })).toMatch(/^app-[0-9a-f]{6}$/)
  })
})
