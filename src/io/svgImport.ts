// Import SVG files: resolves real-world units, nested transforms, basic shapes,
// local <use> references, and reads back shaper:cutType / shaper:cutDepth when present.
// Untrusted input: the document is sanitised before it touches the live DOM.
import type { CutType, Pt, ShapesImport, SvgSource } from '../model/types'
import { DEFAULT_CUT } from '../model/types'
import { mapPen, penGeometry, type Affine } from '../geometry/pen'
import { shapeFromWorld } from '../model/factory'
import { SHAPER_NS } from './svgExport'
import { elementPen, GEOMETRY_ATTRS, lenMM, UNIT_MM, userLength } from './svgSource'

export { lenMM, userLength } from './svgSource'

/**
 * Millimetres per user unit of an SVG root, from width/height against the viewBox.
 * Without a usable viewBox a user unit is one CSS px.
 */
export function mmPerUserUnit(width: string | null, height: string | null, vb: { width: number; height: number } | null): number {
  if (!vb) return UNIT_MM.px
  const wmm = lenMM(width)
  const hmm = lenMM(height)
  if (vb.width > 0 && wmm) return wmm / vb.width
  if (vb.height > 0 && hmm) return hmm / vb.height
  return UNIT_MM.px
}

/** Only fragment references and inline raster data are allowed in imported SVG. */
export function hrefIsSafe(v: string): boolean {
  const t = v.trim()
  return t.startsWith('#') || /^data:image\//i.test(t)
}

const UNSAFE_URL_SCHEME = /^\s*(javascript|vbscript):/i

/** Remove @import and any url() that is not a local #fragment. */
export function sanitizeCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (m, _q, target: string) => (target.trim().startsWith('#') ? m : 'none'))
    .replace(/expression\s*\(/gi, 'none(')
}

const BANNED_TAGS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'animate', 'set', 'animatemotion', 'animatetransform', 'handler', 'listener'])

export function isBannedTag(name: string): boolean {
  return BANNED_TAGS.has(name.toLowerCase().replace(/^.*:/, ''))
}

/**
 * Strip script-capable content from a parsed SVG document, in place. Removes
 * active elements, every on* attribute, javascript: links, external references
 * in <use>/<image>, and external url() in styles.
 */
export function sanitizeSvgTree(root: Element): void {
  const els = [root, ...Array.from(root.querySelectorAll('*'))]
  for (const el of els) {
    if (!el.parentNode) continue
    const tag = el.localName.toLowerCase()
    if (isBannedTag(tag)) {
      el.remove()
      continue
    }
    if (tag === 'style') {
      el.textContent = sanitizeCss(el.textContent ?? '')
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) el.removeAttribute(attr.name)
      else if (name === 'style') el.setAttribute(attr.name, sanitizeCss(attr.value))
      else if ((name === 'href' || name.endsWith(':href')) && UNSAFE_URL_SCHEME.test(attr.value)) el.removeAttribute(attr.name)
    }
    if ((tag === 'use' || tag === 'image')) {
      const href = el.getAttribute('href') ?? el.getAttribute('xlink:href')
      if (href !== null && !hrefIsSafe(href)) el.remove()
    }
  }
}

/**
 * A Shaper length attribute (shaper:cutDepth="0.250 in", shaper:toolDia="0.125in") in mm.
 * Shaper always writes a unit; a bare number is taken as mm. Null when missing or unreadable.
 */
export function parseShaperLength(v: string | null | undefined): number | null {
  if (!v) return null
  const t = v.trim()
  return lenMM(/[a-z]$/i.test(t) ? t : t + 'mm')
}

const CUT_TYPES: readonly CutType[] = ['online', 'outside', 'inside', 'pocket', 'guide']

/** shaper:cutType value to a CutType. Case-insensitive; 'on-line' and 'on line' count as online. */
export function parseCutType(v: string | null | undefined): CutType | null {
  const t = (v ?? '').trim().toLowerCase().replace(/[-_\s]/g, '')
  return CUT_TYPES.find((c) => c === t) ?? null
}

/**
 * Cut type from the colours Shaper uses when there is no shaper:cutType: black fill is
 * outside, white fill (black stroke) inside, 50% grey fill pocket, grey stroke with no
 * fill on-line, blue (#0068FF) guide. Inputs are computed-style colours (rgb()/none).
 */
export function cutTypeFromPaint(fill: string, stroke: string): CutType {
  const isNone = (c: string) => !c || c === 'none' || c.startsWith('rgba(0, 0, 0, 0)')
  const rgb = (c: string) => (c.match(/\d+(\.\d+)?/g) || []).map(Number)
  const isBlue = ([r, g, b]: number[]) => b > 150 && r < 100 && g < 160
  if (isNone(fill)) return !isNone(stroke) && isBlue(rgb(stroke)) ? 'guide' : 'online'
  const c = rgb(fill)
  if (isBlue(c)) return 'guide'
  const [r, g, b] = c
  if (r > 230 && g > 230 && b > 230) return 'inside'
  if (Math.abs(r - g) < 20 && Math.abs(g - b) < 20 && r > 60 && r < 200) return 'pocket'
  return 'outside'
}

/** A shaper:* attribute on the element or the nearest ancestor that sets it (groups can carry it). */
function shaperAttr(el: Element, name: string): string | null {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const v = n.getAttributeNS(SHAPER_NS, name) ?? n.getAttribute('shaper:' + name)
    if (v) return v
  }
  return null
}

function cutTypeFor(el: Element): CutType {
  const attr = parseCutType(shaperAttr(el, 'cutType'))
  if (attr) return attr
  const cs = getComputedStyle(el)
  return cutTypeFromPaint(cs.fill, cs.stroke)
}

export async function importSVGFile(file: File): Promise<ShapesImport> {
  const text = await file.text()
  return importSVGText(text, file.name.replace(/\.svg$/i, ''))
}

/** True when the element or an ancestor is display:none (hidden layers, hidden groups). */
function isHidden(el: Element): boolean {
  if (getComputedStyle(el).visibility === 'hidden') return true
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (getComputedStyle(n).display === 'none') return true
  }
  return false
}

export function importSVGText(text: string, name: string): ShapesImport {
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml')
  if (parsed.getElementsByTagName('parsererror').length) throw new Error('Could not read this SVG file')
  const src = parsed.documentElement
  if (src.nodeName.toLowerCase().replace(/^.*:/, '') !== 'svg') throw new Error('Not an SVG file')

  // Sanitise on the parsed document, before anything is attached to the page.
  sanitizeSvgTree(src)
  const warnings: string[] = []
  if (src.querySelector('text')) warnings.push('Text is not imported. Convert text to outlines in your design tool first.')
  if (src.querySelector('image')) warnings.push('Embedded images are not imported.')
  if (src.querySelector('clipPath')) warnings.push('Clip paths are ignored, so clipped shapes may be larger than they look.')

  // Attach to the live DOM so getCTM / computed styles work.
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:10px;height:10px;overflow:hidden;pointer-events:none'
  const svg = document.importNode(src, true) as unknown as SVGSVGElement
  host.appendChild(svg)
  document.body.appendChild(host)

  try {
    const vb = svg.viewBox.baseVal
    const vbBox = vb && vb.width > 0 ? { width: vb.width, height: vb.height } : null
    const mmPerUnit = mmPerUserUnit(svg.getAttribute('width'), svg.getAttribute('height'), vbBox)

    // Make the root render 1:1 in user units so getCTM is just the nested transforms.
    svg.removeAttribute('width')
    svg.removeAttribute('height')
    svg.removeAttribute('viewBox')
    svg.setAttribute('width', '100000')
    svg.setAttribute('height', '100000')
    svg.setAttribute('viewBox', '0 0 100000 100000')
    const rootInv = svg.getCTM()?.inverse()

    // Resolve local <use href="#id"> by cloning the target under the <use>.
    const byId = new Map<string, Element>()
    svg.querySelectorAll('[id]').forEach((e) => byId.set(e.id, e))
    let unresolved = 0
    svg.querySelectorAll('use').forEach((u) => {
      const href = u.getAttribute('href') ?? u.getAttribute('xlink:href') ?? ''
      const target = href.trim().startsWith('#') ? byId.get(href.trim().slice(1)) : undefined
      if (!target || target.localName === 'symbol' || u.contains(target) || target.contains(u)) {
        unresolved++
        return
      }
      const clone = target.cloneNode(true) as Element
      const x = userLength(u.getAttribute('x'), mmPerUnit)
      const y = userLength(u.getAttribute('y'), mmPerUnit)
      if (x || y) {
        const wrap = document.createElementNS('http://www.w3.org/2000/svg', 'g')
        wrap.setAttribute('transform', `translate(${x} ${y})`)
        wrap.appendChild(clone)
        u.appendChild(wrap)
      } else u.appendChild(clone)
    })
    if (unresolved) warnings.push(`${unresolved} <use> reference(s) could not be resolved and were skipped.`)

    const shapes: ShapesImport['shapes'] = []
    const els = svg.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon')
    let idx = 0
    els.forEach((el) => {
      if (el.closest('defs, clipPath, mask, symbol, marker, pattern')) return
      if (isHidden(el)) return
      const g = el as SVGGraphicsElement
      const tag = el.localName.toLowerCase() as SvgSource['tag']
      // The element's outline as true curves in its own units: nothing is flattened or rewritten.
      const local = elementPen(tag, (k) => el.getAttribute(k), mmPerUnit)
      if (!local.length) return
      let m = g.getCTM()
      if (m && rootInv) m = rootInv.multiply(m)
      const toMM: Affine = m
        ? [m.a * mmPerUnit, m.b * mmPerUnit, m.c * mmPerUnit, m.d * mmPerUnit, m.e * mmPerUnit, m.f * mmPerUnit]
        : [mmPerUnit, 0, 0, mmPerUnit, 0, 0]
      const tx = (p: Pt): Pt => ({ x: toMM[0] * p.x + toMM[2] * p.y + toMM[4], y: toMM[1] * p.x + toMM[3] * p.y + toMM[5] })
      const curves = penGeometry(mapPen(local, tx))
      const world = curves.contours
      const declared = cutTypeFor(el)
      // Open paths can only be cut on-line (or used as guides).
      const type: CutType = world.every((c) => !c.closed) && declared !== 'guide' ? 'online' : declared
      // Guides are not cut, so any depth on them is ignored.
      const depth = type === 'guide' ? null : parseShaperLength(shaperAttr(el, 'cutDepth'))
      const offset = parseShaperLength(shaperAttr(el, 'cutOffset')) ?? DEFAULT_CUT.offset
      const bitDia = parseShaperLength(shaperAttr(el, 'toolDia')) || DEFAULT_CUT.bitDia
      // Shaper Studio ids look like "basePath-sg-<uuid>-pg-<uuid>"; they make poor names.
      const id = el.getAttribute('id')
      const title = el.querySelector('title')?.textContent || (id && !/^(basePath|sg|pg)-/.test(id) ? id : '') || `${name} ${++idx}`
      const attrs: Record<string, string> = {}
      for (const k of GEOMETRY_ATTRS[tag]) {
        const v = el.getAttribute(k)
        if (v != null) attrs[k] = v
      }
      const style = getComputedStyle(el)
      const svgSource: SvgSource = { tag, attrs, m: toMM, unit: mmPerUnit, fill: style.fill, stroke: style.stroke, fillRule: style.fillRule || undefined, cutType: type }
      const s = shapeFromWorld('import', title, world, {
        pen: curves.pen,
        cut: { ...DEFAULT_CUT, type, depth, offset, bitDia },
        meta: { source: 'svg', svgSource },
      })
      shapes.push(s)
    })
    if (!shapes.length) warnings.push('No shapes were found in this file.')
    return { group: { name, source: 'svg' }, shapes, warnings }
  } finally {
    host.remove()
  }
}
