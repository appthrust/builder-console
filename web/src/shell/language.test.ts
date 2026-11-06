import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { preserveLanguage } from '../../test/language'
import { isLanguage, locale, localized, resolveInitialLanguage, setLanguage } from './language'

let restoreLanguage: () => void
beforeEach(() => { restoreLanguage = preserveLanguage() })
afterEach(() => restoreLanguage())

describe('resolveInitialLanguage', () => {
  test('the saved cookie decides', () => {
    expect(resolveInitialLanguage('other=value; appthrust-language=en')).toBe('en')
    expect(resolveInitialLanguage('appthrust-language=ja; other=value')).toBe('ja')
  })

  test('no or invalid cookie is Japanese regardless of the browser', () => {
    expect(resolveInitialLanguage('')).toBe('ja')
    expect(resolveInitialLanguage('appthrust-language=fr')).toBe('ja')
    expect(resolveInitialLanguage('appthrust-language=')).toBe('ja')
  })
})

test('language validation and formatting locales share the supported languages', () => {
  expect(isLanguage('ja')).toBe(true)
  expect(isLanguage('en')).toBe(true)
  expect(isLanguage('ja-JP')).toBe(false)
  expect(isLanguage(undefined)).toBe(false)
  expect(locale('ja')).toBe('ja-JP')
  expect(locale('en')).toBe('en-US')
})

test('a localized catalog resolves the current language on each access', () => {
  const text = localized({
    ja: { title: '見出し', count: (n: number) => `${n} 件` },
    en: { title: 'Title', count: (n: number) => `${n} items` },
  })
  setLanguage('ja')
  expect(text.title).toBe('見出し')
  expect(text.count(2)).toBe('2 件')
  setLanguage('en')
  expect(text.title).toBe('Title')
  expect(text.count(2)).toBe('2 items')
  setLanguage('ja')
})
