// Text → outline contours using opentype.js, with Studio's font library
// (src/io/fontCatalog.ts). Users can also load their own TTF/OTF/WOFF font.
import type opentype from 'opentype.js'
import type { Contour, PenContour } from '../model/types'
import { parsePathPen, penBounds, unionCurves } from '../geometry/curves'
import { mapPen, penGeometry } from '../geometry/pen'
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
  const font = await parseFont(buf)
  const name = font.names.fullName?.en || file.name.replace(/\.[^.]+$/, '')
  custom.set(name, buf)
  cache.set('custom:' + name, Promise.resolve(font))
  return name
}

/** GSUB subtable kinds (lookup type + format) opentype.js can apply; it throws on any other it reaches. */
const SUPPORTED_GSUB = new Set(['11', '12', '21', '41', '51', '53', '63'])

/** Renames a table in the font's directory so opentype.js skips it. Handles sfnt (TTF/OTF) and WOFF. */
function hideTable(buf: ArrayBuffer, tag: string): ArrayBuffer {
  const out = buf.slice(0)
  const v = new DataView(out)
  const woff = v.getUint32(0) === 0x774f4646 // 'wOFF'
  const n = v.getUint16(woff ? 12 : 4)
  const [dir, entry] = woff ? [44, 20] : [12, 16]
  for (let i = 0; i < n; i++) {
    const at = dir + i * entry
    if (String.fromCharCode(...new Uint8Array(out, at, 4)) === tag) new Uint8Array(out, at, 4).set([0x7a, 0x7a, 0x7a, 0x7a]) // 'zzzz'
  }
  return out
}

/**
 * Parses a font, tolerating what opentype.js can't handle: a malformed GDEF table (Caveat Bold ships one
 * with version 0) is dropped, and GSUB subtables of unsupported kinds (chained contexts in formats 1–2, used
 * by Inter, Dongle, Frank Ruhl Libre Black…) are removed so shaping skips them instead of throwing.
 */
async function parseFont(buf: ArrayBuffer): Promise<opentype.Font> {
  const lib = await ot()
  let font: opentype.Font
  try {
    font = lib.parse(buf)
  } catch (e) {
    if (!/GDEF/.test(String(e))) throw e
    font = lib.parse(hideTable(buf, 'GDEF'))
  }
  type Subtable = { substFormat?: number; lookupType?: number; extension?: { substFormat?: number } }
  const gsub = font.tables.gsub as { lookups?: { lookupType: number; subtables: Subtable[] }[] } | undefined
  for (const l of gsub?.lookups ?? [])
    l.subtables = l.subtables.filter((st) =>
      SUPPORTED_GSUB.has(l.lookupType === 7 ? `${st.lookupType}${st.extension?.substFormat}` : `${l.lookupType}${st.substFormat}`),
    )
  return font
}

const num = (v: number, decimals: number) => {
  const s = v.toFixed(decimals)
  const t = s.includes('.') ? s.replace(/\.?0+$/, '') : s
  return t === '-0' ? '0' : t
}

/**
 * SVG path data for opentype.js path commands. opentype.js's own toPathData can't be used: its rounding
 * writes NaN for any coordinate a hair off a whole number (54.00000000000001 → "7.1e-15e+2"), and the
 * path parser stops at the first NaN, dropping the rest of the line. Commands with a non-finite
 * coordinate are skipped so one bad glyph point can't truncate the others.
 */
export function commandsToPathData(cmds: opentype.PathCommand[], decimals: number): string {
  let d = ''
  for (const c of cmds) {
    if (c.type === 'Z') {
      d += 'Z'
      continue
    }
    const v = c.type === 'C' ? [c.x1, c.y1, c.x2, c.y2, c.x, c.y] : c.type === 'Q' ? [c.x1, c.y1, c.x, c.y] : [c.x, c.y]
    if (!v.every(Number.isFinite)) continue
    d += c.type + v.map((n) => num(n, decimals)).join(' ')
  }
  return d
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
        // A missing file can come back as the app's HTML page rather than a 404.
        if (!r.ok || r.headers.get('content-type')?.startsWith('text/html')) throw new Error(`Font file ${style.file} could not be loaded`)
        return r.arrayBuffer()
      })
      .then(parseFont)
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
export function linePathData(font: opentype.Font, line: string, size: number, x = 0, y = 0, decimals = 3): string {
  return commandsToPathData(font.getPath(line, x, y, size).commands, decimals)
}

/** Text outlines: the font's own curves (`pen`) and the contours flattened from them. */
export interface TextGeometry {
  contours: Contour[]
  pen: PenContour[]
}

/**
 * Convert text to outlines. `height` is the cap height in mm. Lines are split on newlines. The outlines are
 * the font's own Bézier curves (quadratics become the identical cubics), with the text block centred on (0,0).
 */
export async function textGeometry(text: string, fontName: string, height: number, styleName: string = DEFAULT_STYLE): Promise<TextGeometry> {
  if (!hasFont(fontName)) throw new Error(missingFontMessage(fontName))
  const font = await loadFont(fontName, styleName)
  const singleLine = !!findFont(fontName) && !!findStyle(findFont(fontName)!, styleName).singleLine
  const capH = (font.tables.os2?.sCapHeight || font.unitsPerEm * 0.7) / font.unitsPerEm
  const size = height / capH
  const lineH = size * 1.2
  let pens: PenContour[] = []
  text.split('\n').forEach((line, i) => {
    if (!line) return
    // Full precision: the glyph points are written out exactly as the font scales them.
    const d = linePathData(font, line, size, 0, i * lineH, 9)
    for (const pc of parsePathPen(d)) pens.push({ ...pc, closed: !singleLine && pc.nodes.length >= 2 })
  })
  // Glyph outlines are always closed, even when the font's path data lacks the closing command;
  // fonts also overlap their parts freely, and cutting needs each glyph as one clean outline. The
  // merge keeps the curves: only where parts cross are new points made.
  if (!singleLine) pens = unionCurves(pens)
  if (!pens.length) return { contours: [], pen: [] }
  const b = penBounds(pens)
  const cx = (b.minX + b.maxX) / 2
  const cy = (b.minY + b.maxY) / 2
  return penGeometry(mapPen(pens, (p) => ({ x: p.x - cx, y: p.y - cy }))) as TextGeometry
}

/** Text outlines as contours only (see textGeometry). */
export async function textToContours(text: string, fontName: string, height: number, styleName: string = DEFAULT_STYLE): Promise<Contour[]> {
  return (await textGeometry(text, fontName, height, styleName)).contours
}
