import { describe, expect, test } from 'bun:test'
import { inflateSync } from 'node:zlib'
import { imageInfo, mockAvatarPng, mockScreenPng } from './mock-images'

function chunks(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const found: Array<{ type: string; data: Uint8Array }> = []
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at)
    found.push({ type: String.fromCharCode(...png.subarray(at + 4, at + 8)), data: png.subarray(at + 8, at + 8 + length) })
    at += 12 + length
  }
  return found
}

describe('mockScreenPng', () => {
  test('is a complete PNG whose pixel data inflates to the declared size', () => {
    const png = mockScreenPng([13, 148, 136], 2, 64, 40)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const found = chunks(png)
    expect(found.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(new Uint8Array(inflateSync(found[1]!.data)).length).toBe((64 * 3 + 1) * 40)
    expect(imageInfo(png)).toEqual({ contentType: 'image/png', width: 64, height: 40 })
  })

  test('draws different screens per variant', () => {
    const a = mockScreenPng([13, 148, 136], 0)
    const b = mockScreenPng([13, 148, 136], 1)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
  })
})

describe('mockAvatarPng', () => {
  test('is a square PNG whose pixels inflate to the declared size and differ per colour', () => {
    const png = mockAvatarPng([219, 39, 119], 40)
    const found = chunks(png)
    expect(found.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(new Uint8Array(inflateSync(found[1]!.data)).length).toBe((40 * 3 + 1) * 40)
    expect(imageInfo(png)).toEqual({ contentType: 'image/png', width: 40, height: 40 })
    expect(imageInfo(mockAvatarPng([79, 70, 229]))).toEqual({ contentType: 'image/png', width: 96, height: 96 })
    expect(Buffer.from(png).equals(Buffer.from(mockAvatarPng([79, 70, 229], 40)))).toBe(false)
  })
})

describe('imageInfo', () => {
  test('reads JPEG dimensions from the first frame header, skipping other segments', () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, 2 payload bytes
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x05, 0x00, 0x03, // SOF0: 800 high, 1280 wide
      0, 0, 0, 0, 0, 0, 0, 0, 0,
    ])
    expect(imageInfo(jpeg)).toEqual({ contentType: 'image/jpeg', width: 1280, height: 800 })
  })

  test('reads WebP dimensions from VP8, VP8L and VP8X headers', () => {
    const riff = (chunk: string, payload: number[]) => new Uint8Array([
      ...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBP'),
      ...new TextEncoder().encode(chunk), 0, 0, 0, 0, ...payload, ...new Array<number>(10).fill(0),
    ])
    // VP8: frame tag, start code, 14-bit little-endian width / height.
    expect(imageInfo(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x00, 0x05, 0x20, 0x03]))).toEqual({ contentType: 'image/webp', width: 1280, height: 800 })
    // VP8L: signature, then (width-1) | (height-1) << 14.
    const bits = (1280 - 1) | ((800 - 1) << 14)
    expect(imageInfo(riff('VP8L', [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff]))).toEqual({ contentType: 'image/webp', width: 1280, height: 800 })
    // VP8X: flags + reserved, then 24-bit (width-1) and (height-1).
    expect(imageInfo(riff('VP8X', [0, 0, 0, 0, 0xff, 0x04, 0x00, 0x1f, 0x03, 0x00]))).toEqual({ contentType: 'image/webp', width: 1280, height: 800 })
  })

  test('rejects anything else, including a GIF and truncated headers', () => {
    expect(imageInfo(new TextEncoder().encode('GIF89a......................'))).toBeUndefined()
    expect(imageInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined()
    expect(imageInfo(new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBeUndefined()
    expect(imageInfo(new Uint8Array())).toBeUndefined()
  })
})
