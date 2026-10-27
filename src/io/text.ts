// Text → outline contours using opentype.js, with Studio's font library
// (src/io/fontCatalog.ts). Users can also load their own TTF/OTF/WOFF font.
import type opentype from 'opentype.js'
import type { Contour } from '../model/types'
import { parsePathD } from '../geometry/svgPath'
import { unionNonZero } from '../geometry/offset'
import { DEFAULT_FONT, DEFAULT_STYLE, FONTS, findFont, findStyle, fontUrl, isHeavyFont, type FontDef, type FontStyleDef } from './fontCatalog'

export { DEFAULT_FONT, DEFAULT_STYLE }
// opentype.js is only needed for text, so it's loaded on demand.
const ot = () => import('opentype.js').then((m) => m.default)

/** Parsed fonts by file (library) or name (uploaded). */
const cache = new Map<string, Promise<opentype.Font>>()
const custom = new Map<string, ArrayBuffer>()

export function fontNames(): string[] {
  return [...FONTS.map((f) => f.fontDisplayName), ...custom.keys()]
}

export async function addCustomFont(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const font = (await ot()).parse(buf)
  const name = font.names.fullName?.en || file.name.replace(/\.[^.]+$/, '')
  custom.set(name, buf)
  cache.set('custom:' + name, Promise.resolve(font))
  return name
}

export const missingFontMessage = (name: string) => `Font "${name}" isn't loaded — re-upload it`

/** Whether `name` can be rendered: a library font, or a custom font loaded this session. */
export function hasFont(name: string): boolean {
  return !!findFont(name) || cache.has('custom:' + name)
}

export function loadStyle(style: FontStyleDef): Promise<opentype.Font> {
  let p = cache.get(style.file)
  if (!p) {
    p = fetch(fontUrl(style))
      .then((r) => {
        if (!r.ok) throw new Error(`Font file ${style.file} could not be loaded`)
        return r.arrayBuffer()
      })
      .then(async (b) => (await ot()).parse(b))
    // A failed fetch must not poison the cache.
    p.catch(() => cache.delete(style.file))
    cache.set(style.file, p)
  }
  return p
}

export function loadFont(name: string = DEFAULT_FONT, styleName: string = DEFAULT_STYLE): Promise<opentype.Font> {
  const def = findFont(name)
  if (def) return loadStyle(findStyle(def, styleName))
  // A custom font that isn't cached (e.g. after a reload) must never fall back silently.
  return cache.get('custom:' + name) ?? Promise.reject(new Error(missingFontMessage(name)))
}

/** Whether every visible character of `text` has a glyph in `font`. */
export function fontSupportsText(font: opentype.Font, text: string): boolean {
  for (const ch of text) {
    if (/\s/.test(ch)) continue
    if (font.charToGlyphIndex(ch) === 0) return false
  }
  return true
}

/** Anything outside Latin script and punctuation: needs the font to actually cover it. */
const isLatinOnly = (text: string) => !/[^\u0000-ɏ -⁯₠-⃏]/.test(text)

/**
 * Whether the font can typeset `text`. The multi-megabyte CJK families are assumed to cover
 * Latin text rather than loaded just to ask.
 */
export async function fontSupports(def: FontDef, styleName: string, text: string): Promise<boolean> {
  if (isHeavyFont(def) && isLatinOnly(text)) return true
  try {
    return fontSupportsText(await loadStyle(findStyle(def, styleName)), text)
  } catch {
    return false
  }
}

export interface ResolvedFont {
  font: string
  style: string
  /** True when the requested font lacked glyphs and another was substituted. */
  changed: boolean
}

/**
 * Studio keeps the chosen font when it covers the text; otherwise it switches to the first
 * font (alphabetically) that does, and tells the user.
 */
export async function resolveFont(text: string, fontName: string, styleName: string = DEFAULT_STYLE): Promise<ResolvedFont> {
  const def = findFont(fontName)
  if (!def) return { font: fontName, style: styleName, changed: false } // uploaded font: used as given
  if (await fontSupports(def, styleName, text)) return { font: fontName, style: styleName, changed: false }
  for (const f of FONTS) {
    if (await fontSupports(f, f.fontStyles[0].displayStyle, text)) return { font: f.fontDisplayName, style: f.fontStyles[0].displayStyle, changed: true }
  }
  return { font: fontName, style: styleName, changed: false } // nothing covers it: missing glyphs are left blank
}

/** Outline of one line as SVG path data, at `size` em-pixels with the baseline at y. */
export function linePathData(font: opentype.Font, line: string, size: number, x = 0, y = 0): string {
  return font.getPath(line, x, y, size).toPathData(3)
}

/**
 * Convert text to contours. `height` is the cap height in mm. Lines are split
 * on newlines. Returns contours with the text block centred on (0,0).
 */
export async function textToContours(text: string, fontName: string, height: number, styleName: string = DEFAULT_STYLE): Promise<Contour[]> {
  if (!hasFont(fontName)) throw new Error(missingFontMessage(fontName))
  const font = await loadFont(fontName, styleName)
  const singleLine = !!findFont(fontName) && !!findStyle(findFont(fontName)!, styleName).singleLine
  const capH = (font.tables.os2?.sCapHeight || font.unitsPerEm * 0.7) / font.unitsPerEm
  const size = height / capH
  const lineH = size * 1.2
  let out: Contour[] = []
  text.split('\n').forEach((line, i) => {
    if (!line) return
    for (const c of parsePathD(linePathData(font, line, size, 0, i * lineH), 0.02)) out.push({ ...c, closed: !singleLine })
  })
  // Glyph outlines are always closed, even when the font's path data lacks the closing command;
  // fonts also overlap their parts freely, and cutting needs each glyph as one clean outline.
  if (!singleLine) out = unionNonZero(out)
  if (!out.length) return out
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of out)
    for (const p of c.pts) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return out.map((c) => ({ closed: c.closed, pts: c.pts.map((p) => ({ x: p.x - cx, y: p.y - cy })) }))
}
