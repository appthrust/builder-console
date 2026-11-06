import { describe, expect, test } from 'bun:test'
import { ConsoleApiError } from '../../api/console'
import { text } from './copy'
import { MAX_SCREENSHOT_BYTES, moveScreenshot, screenshotErrorText, screenshotFileProblem, thumbWidth } from './screenshots'

describe('screenshotFileProblem', () => {
  test('accepts PNG, JPEG and WebP up to 2 MB while there is room', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(screenshotFileProblem({ type, size: MAX_SCREENSHOT_BYTES }, 4)).toBeUndefined()
    }
  })

  test('names the first problem in Japanese: count, then type, then size', () => {
    expect(screenshotFileProblem({ type: 'image/gif', size: 10 }, 5)).toBe(text.screenshots.tooMany)
    expect(screenshotFileProblem({ type: 'image/gif', size: MAX_SCREENSHOT_BYTES + 1 }, 0)).toBe(text.screenshots.wrongType)
    expect(screenshotFileProblem({ type: '', size: 10 }, 0)).toBe(text.screenshots.wrongType)
    expect(screenshotFileProblem({ type: 'image/png', size: MAX_SCREENSHOT_BYTES + 1 }, 0)).toBe(text.screenshots.tooLarge)
  })
})

describe('screenshotErrorText', () => {
  test('maps the upload refusals and leaves everything else to ActionError', () => {
    expect(screenshotErrorText(new ConsoleApiError(409, { error: 'conflict', message: 'At most 5 screenshots' }))).toBe(text.screenshots.tooMany)
    expect(screenshotErrorText(new ConsoleApiError(400, { error: 'invalid_request', message: 'bad image' }))).toBe(text.screenshots.rejected)
    expect(screenshotErrorText(new ConsoleApiError(413, undefined))).toBe(text.screenshots.rejected)
    expect(screenshotErrorText(new ConsoleApiError(403, { error: 'forbidden', message: 'forbidden' }))).toBeUndefined()
    expect(screenshotErrorText(new Error('boom'))).toBeUndefined()
  })
})

describe('moveScreenshot', () => {
  test('swaps with the neighbour and leaves the ends alone', () => {
    expect(moveScreenshot(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
    expect(moveScreenshot(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
    expect(moveScreenshot(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c'])
    expect(moveScreenshot(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c'])
    const ids = Object.freeze(['a', 'b'])
    expect(moveScreenshot(ids, 0, 1)).toEqual(['b', 'a'])
    expect(ids).toEqual(['a', 'b'])
  })
})

describe('thumbWidth', () => {
  test('keeps the shape at a fixed height, within bounds', () => {
    expect(thumbWidth({ width: 1280, height: 800 })).toBe(352)
    expect(thumbWidth({ width: 390, height: 844 })).toBe(120)
    expect(thumbWidth({ width: 3000, height: 400 })).toBe(560)
  })
})
