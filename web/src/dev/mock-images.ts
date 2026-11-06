// Dev-only image helpers for the console mock's screenshots and profile
// pictures: real (small) PNGs that look like an app screen or a portrait, and
// the magic-byte sniffing the console server does on upload (PNG / JPEG /
// WebP, dimensions from the header only).
import { deflateSync } from 'node:zlib'

export type ScreenshotType = 'image/png' | 'image/jpeg' | 'image/webp'
export interface ImageInfo { contentType: ScreenshotType; width: number; height: number }
export type Rgb = readonly [number, number, number]

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.length)
  for (let index = 0; index < 4; index++) chunk[4 + index] = type.charCodeAt(index)
  chunk.set(data, 8)
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)))
  return chunk
}

type Rect = readonly [x: number, y: number, w: number, h: number, color: Rgb]

const PAGE: Rgb = [245, 245, 244]
const SIDEBAR: Rgb = [231, 229, 228]
const WHITE: Rgb = [255, 255, 255]
const LINE: Rgb = [214, 211, 209]
const INK: Rgb = [120, 113, 108]
const tint = ([r, g, b]: Rgb, amount: number): Rgb =>
  [Math.round(r + (255 - r) * amount), Math.round(g + (255 - g) * amount), Math.round(b + (255 - b) * amount)]

/** Shapes of three kinds of screen: cards, a list, a form. Later rects paint over earlier ones. */
function layout(width: number, height: number, accent: Rgb, variant: number): Rect[] {
  const soft = tint(accent, 0.8)
  const chrome: Rect[] = [
    [0, 0, width, 40, accent],
    [16, 14, 90, 12, WHITE],
    [0, 40, 120, height - 40, SIDEBAR],
    ...[0, 1, 2, 3, 4].map((index): Rect => [16, 64 + index * 28, 88, 10, index === variant % 5 ? accent : INK]),
  ]
  const content: Rect[] = []
  const left = 144
  const right = width - 24
  content.push([left, 60, 180, 14, INK])
  if (variant % 3 === 0) {
    const cardWidth = Math.floor((right - left - 32) / 3)
    for (let column = 0; column < 3; column++) {
      const x = left + column * (cardWidth + 16)
      content.push([x - 1, 91, cardWidth + 2, 122, LINE], [x, 92, cardWidth, 120, WHITE], [x + 12, 104, 36, 36, soft], [x + 12, 152, cardWidth - 40, 10, INK], [x + 12, 172, cardWidth - 70, 8, LINE])
    }
    content.push([left - 1, 235, right - left + 2, 132, LINE], [left, 236, right - left, 130, WHITE])
    for (let bar = 0; bar < 8; bar++) content.push([left + 24 + bar * 52, 346 - (bar * 37) % 90 - 10, 28, (bar * 37) % 90 + 10, bar % 2 ? soft : accent])
  } else if (variant % 3 === 1) {
    content.push([right - 96, 56, 96, 24, accent])
    for (let row = 0; row < 8; row++) {
      const y = 96 + row * 36
      content.push([left, y, right - left, 34, row === 0 ? soft : row % 2 ? WHITE : PAGE], [left + 12, y + 12, 140, 10, row === 0 ? accent : INK], [left + 200, y + 12, 120, 10, LINE], [right - 90, y + 12, 70, 10, row === 0 ? accent : LINE])
    }
  } else {
    content.push([left - 1, 91, right - left + 2, height - 116, LINE], [left, 92, right - left, height - 118, WHITE])
    for (let field = 0; field < 4; field++) {
      const y = 112 + field * 62
      content.push([left + 20, y, 120, 10, INK], [left + 19, y + 17, 321, 30, LINE], [left + 20, y + 18, 319, 28, WHITE])
    }
    content.push([left + 20, height - 60, 110, 30, accent], [left + 360, 112, right - left - 380, 200, soft])
  }
  return [...chrome, ...content]
}

/** A real, decodable PNG (default 640×400, 16:10) drawn like an app screen in `accent`. */
export function mockScreenPng(accent: Rgb, variant: number, width = 640, height = 400): Uint8Array<ArrayBuffer> {
  const stride = width * 3 + 1
  const raw = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(PAGE, y * stride + 1 + x * 3)
  }
  for (const [rx, ry, rw, rh, color] of layout(width, height, accent, variant)) {
    for (let y = Math.max(0, ry); y < Math.min(height, ry + rh); y++) {
      for (let x = Math.max(0, rx); x < Math.min(width, rx + rw); x++) raw.set(color, y * stride + 1 + x * 3)
    }
  }
  return encodePng(width, height, raw)
}

/** A real, decodable square PNG portrait: a head-and-shoulders silhouette in `color` on its pale tint. */
export function mockAvatarPng(color: Rgb, size = 96): Uint8Array<ArrayBuffer> {
  const stride = size * 3 + 1
  const raw = new Uint8Array(stride * size)
  const background = tint(color, 0.75)
  const head = { x: size / 2, y: size * 0.4, r: size * 0.2 }
  const body = { x: size / 2, y: size * 1.02, r: size * 0.38 }
  const inside = (x: number, y: number, circle: { x: number; y: number; r: number }) => (x - circle.x) ** 2 + (y - circle.y) ** 2 <= circle.r ** 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      raw.set(inside(px, py, head) || inside(px, py, body) ? color : background, y * stride + 1 + x * 3)
    }
  }
  return encodePng(size, size, raw)
}

/** 8-bit RGB scanlines (each prefixed with filter byte 0) → PNG file bytes. */
function encodePng(width: number, height: number, raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([8, 2, 0, 0, 0], 8) // 8-bit RGB, deflate, no filter, no interlace
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array()),
  ]
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    png.set(part, offset)
    offset += part.length
  }
  return png
}

const ascii = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length))

/** Type and size from the file's own header, never from what the browser claims. */
export function imageInfo(bytes: Uint8Array): ImageInfo | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sized = (contentType: ScreenshotType, width: number, height: number) => (width > 0 && height > 0 ? { contentType, width, height } : undefined)
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && ascii(bytes, 12, 4) === 'IHDR') {
    return sized('image/png', view.getUint32(16), view.getUint32(20))
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Walk the segments to the first frame header (SOF0–SOF15 except DHT/JPG/DAC).
    for (let at = 2; at + 9 <= bytes.length;) {
      if (bytes[at] !== 0xff) return undefined
      const marker = bytes[at + 1]!
      if (marker === 0xff) {
        at += 1
        continue
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        at += 2
        continue
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return sized('image/jpeg', view.getUint16(at + 7), view.getUint16(at + 5))
      }
      at += 2 + view.getUint16(at + 2)
    }
    return undefined
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const chunk = ascii(bytes, 12, 4)
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return sized('image/webp', view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff)
    }
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true)
      return sized('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    }
    if (chunk === 'VP8X') {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16))
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
      return sized('image/webp', width, height)
    }
  }
  return undefined
}
