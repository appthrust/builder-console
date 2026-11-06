import { describe, expect, test } from 'bun:test'
import { ConsoleApiError, type AppComment, type Group } from '../../api/console'
import { canDeleteComment, commentDepartment, commentErrorText, commentInput, commentPreview } from './comments'
import { text } from './copy'
import { capabilitiesError, parseCapabilities } from './guide-tab'

const author = { id: 'person-author', subject: 'author', pending: false, email: 'author@example.test', displayName: '山田', avatarVersion: null }
const comment: AppComment = { id: 'comment-1', appId: 'app-1', author, body: '使ってみました。', createdAt: '2026-10-13T00:00:00Z' }
const groupBase = { description: '', about: '', aboutUpdatedBy: null, aboutUpdatedAt: null, subgroupCount: 0, memberCount: 1, createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z' }
const root: Group = { ...groupBase, id: 'sales', parentId: null, slug: 'sales', path: 'sales', name: '営業本部' }
const child: Group = { ...groupBase, id: 'east', parentId: root.id, slug: 'east', path: 'sales/east', name: '営業1部' }
const other: Group = { ...groupBase, id: 'general', parentId: null, slug: 'general', path: 'general', name: '総務部' }

describe('comment input', () => {
  test('rejects empty and whitespace-only input and trims the posted body', () => {
    expect(commentInput('').canSend).toBe(false)
    expect(commentInput(' \n\t　').canSend).toBe(false)
    const input = commentInput('  質問です。\n回答をお願いします。 \n')
    expect(input.body).toBe('質問です。\n回答をお願いします。')
    expect(input.canSend).toBe(true)
  })

  test('allows 1000 Unicode characters and rejects 1001, counting supplementary characters once', () => {
    const character = String.fromCodePoint(0x20bb7)
    const boundary = commentInput(character.repeat(1000))
    expect(boundary.length).toBe(1000)
    expect(boundary.tooLong).toBe(false)
    expect(boundary.canSend).toBe(true)
    const overflow = commentInput(character.repeat(1001))
    expect(overflow.length).toBe(1001)
    expect(overflow.tooLong).toBe(true)
    expect(overflow.canSend).toBe(false)
  })

  test('counts entered whitespace toward the composer limit', () => {
    expect(commentInput(` ${'あ'.repeat(1000)}`).tooLong).toBe(true)
  })
})

describe('comment actions', () => {
  test('only the author or an app editor may delete a comment', () => {
    expect(canDeleteComment(comment, author.id, false)).toBe(true)
    expect(canDeleteComment(comment, 'another-person', false)).toBe(false)
    expect(canDeleteComment(comment, 'another-person', true)).toBe(true)
    expect(canDeleteComment(comment, author.id, true)).toBe(true)
  })

  test('confirmation uses the first 30 Unicode characters, without splitting a character', () => {
    const character = String.fromCodePoint(0x20bb7)
    expect(commentPreview('短いコメント')).toBe('短いコメント')
    expect(commentPreview(character.repeat(30))).toBe(character.repeat(30))
    expect(commentPreview(character.repeat(31))).toBe(`${character.repeat(30)}…`)
  })

  test('maps 429 and 400 to the requested copy and leaves other errors to ActionError', () => {
    expect(commentErrorText(new ConsoleApiError(429, { error: 'too_many_requests' }))).toBe(text.comments.tooMany)
    expect(commentErrorText(new ConsoleApiError(400, { error: 'invalid_request' }))).toBe(text.comments.tooLong)
    expect(commentErrorText(new ConsoleApiError(403, { error: 'forbidden' }))).toBeUndefined()
    expect(commentErrorText(new Error('network error'))).toBeUndefined()
    expect(commentErrorText(null)).toBeUndefined()
  })
})

describe('comment department', () => {
  test('shows the membership group, not a descendant reached through it', () => {
    expect(commentDepartment({ effectiveGroupIds: [child.id] }, [root, child, other])).toBe(child.name)
    expect(commentDepartment({ effectiveGroupIds: [root.id, child.id] }, [root, child, other])).toBe(root.name)
  })

  test('chooses the highest membership root without changing the groups array', () => {
    const groups = [child, other, root]
    expect(commentDepartment({ effectiveGroupIds: [child.id, root.id, other.id] }, groups)).toBe(root.name)
    expect(groups).toEqual([child, other, root])
  })

  test('omits departments when no membership can be derived', () => {
    expect(commentDepartment({ effectiveGroupIds: [] }, [root, child])).toBeUndefined()
    expect(commentDepartment({ effectiveGroupIds: [child.id] }, [])).toBeUndefined()
  })
})

describe('guide capabilities', () => {
  test('normalizes lines, dropping blank entries without truncating content', () => {
    expect(parseCapabilities('  見積を作る \r\n\n　\n過去の見積を探す\n')).toEqual(['見積を作る', '過去の見積を探す'])
    expect(parseCapabilities(' \n\r\n')).toEqual([])
  })

  test('allows 10 nonempty entries and rejects an eleventh', () => {
    expect(capabilitiesError(Array(10).fill('使えること').join('\n'))).toBeUndefined()
    expect(capabilitiesError(Array(11).fill('使えること').join('\n'))).toBe(text.app.capabilitiesTooMany)
    expect(capabilitiesError('\n\n')).toBeUndefined()
  })

  test('counts each capability in Unicode characters after trimming', () => {
    const character = String.fromCodePoint(0x20bb7)
    expect(capabilitiesError(` ${character.repeat(60)} `)).toBeUndefined()
    expect(capabilitiesError(character.repeat(61))).toBe(text.app.capabilityTooLong)
  })
})
