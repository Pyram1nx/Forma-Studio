// An imported SVG element kept exactly as it was in its file (Shape.meta.svgSource), so the editor can draw
// it as true curves and export can write the very same element back, placed with a transform instead of
// rewritten coordinates. Also the SVG length helpers shared by import and export.
import type { PenContour, Pt, Shape, SvgSource } from '../model/types'
import { arcSegs, parsePathPen, segsToPen } from '../geometry/curves'
import { applyAffine, mapPen, penOf, type Affine } from '../geometry/pen'

/** Millimetres per absolute CSS unit. Unitless and unknown units are CSS px. */
export const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 }
const LEN_RE = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([a-z%]*)\s*$/i

/** Length in mm for a value with an absolute unit (unitless = px). Null for %/garbage. */
export function lenMM(v: string | null | undefined): number | null {
  if (!v) return null
  const m = LEN_RE.exec(v)
  if (!m || m[2] === '%') return null
  return parseFloat(m[1]) * (UNIT_MM[m[2].toLowerCase()] ?? UNIT_MM.px)
}

/**
 * Convert an element attribute to user units. Unitless values already are user
 * units; absolute units (mm, in, pt, px, ...) are converted with mmPerUnit.
 * Percentages and garbage give 0.
 */
export function userLength(v: string | null | undefined, mmPerUnit: number): number {
  if (!v) return 0
  const m = LEN_RE.exec(v)
  if (!m || m[2] === '%') return 0
  const n = parseFloat(m[1])
  if (!m[2]) return n
  return (n * (UNIT_MM[m[2].toLowerCase()] ?? UNIT_MM.px)) / mmPerUnit
}

/** The geometry attributes of each element kind, the ones kept verbatim. */
export const GEOMETRY_ATTRS: Record<SvgSource['tag'], string[]> = {
  path: ['d'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  polyline: ['points'],
  polygon: ['points'],
}

/** Relative accuracy of circles and ellipses drawn as cubics (as for path arcs). */
const ARC_REL = 1e-5

/** An element's outline as true curves in its own user units (arcs within 1e-5 of their radius, all else exact). */
export function elementPen(tag: string, attr: (k: string) => string | null, mmPerUnit: number): PenContour[] {
  const a = (k: string) => userLength(attr(k), mmPerUnit)
  switch (tag) {
    case 'path':
      return parsePathPen(attr('d') || '')
    case 'rect': {
      const x = a('x')
      const y = a('y')
      const w = a('width')
      const h = a('height')
      if (w <= 0 || h <= 0) return []
      let rx = a('rx')
      let ry = a('ry')
      if (!rx && ry) rx = ry
      if (!ry && rx) ry = rx
      rx = Math.min(rx, w / 2)
      ry = Math.min(ry, h / 2)
      if (rx > 0 && ry > 0) {
        return parsePathPen(`M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`)
      }
      const pts = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
      return [segsToPen(pts.map((p, i) => ({ p0: p, p3: pts[(i + 1) % 4] })), true)]
    }
    case 'circle':
    case 'ellipse': {
      const rx = tag === 'circle' ? a('r') : a('rx')
      const ry = tag === 'circle' ? a('r') : a('ry')
      if (rx <= 0 || ry <= 0) return []
      return [segsToPen(arcSegs({ x: a('cx'), y: a('cy') }, rx, ry, 0, Math.PI * 2, ARC_REL * Math.max(rx, ry)), true)]
    }
    case 'line':
      return [segsToPen([{ p0: { x: a('x1'), y: a('y1') }, p3: { x: a('x2'), y: a('y2') } }], false)].filter((pc) => pc.nodes.length >= 2)
    case 'polyline':
    case 'polygon': {
      const nums = (attr('points') || '').match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi)?.map(Number) || []
      const pts: Pt[] = []
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] })
      if (pts.length < 2) return []
      const closed = tag === 'polygon'
      const segs = pts.slice(1).map((p, i) => ({ p0: pts[i], p3: p }))
      if (closed) segs.push({ p0: pts[pts.length - 1], p3: pts[0] })
      return [segsToPen(segs, closed)]
    }
  }
  return []
}

/** The source element's curves in its own units, per source record. */
const sourceCurves = new WeakMap<SvgSource, PenContour[]>()
const liveCache = new WeakMap<PenContour[], { src: SvgSource; ok: boolean }>()

/**
 * The shape's source element, if the shape is still exactly that element (only moved, turned, scaled or
 * mirrored). Any edit to the outline itself (nodes, offsets, booleans) makes it a shape of its own again.
 */
export function liveSource(s: Shape): SvgSource | null {
  const src = s.meta?.svgSource
  const pen = src && penOf(s)
  if (!src || !pen) return null
  const hit = liveCache.get(pen)
  if (hit && hit.src === src) return hit.ok ? src : null
  let own = sourceCurves.get(src)
  if (!own) {
    own = elementPen(src.tag, (k) => src.attrs[k] ?? null, src.unit)
    sourceCurves.set(src, own)
  }
  const expect = mapPen(own, (p) => applyAffine(src.m, p))
  const ok = samePen(expect, pen)
  liveCache.set(pen, { src, ok })
  return ok ? src : null
}

function samePen(a: PenContour[], b: PenContour[]): boolean {
  const eps = 1e-5
  const eq = (p?: Pt, q?: Pt) => (!p && !q) || (!!p && !!q && Math.abs(p.x - q.x) < eps && Math.abs(p.y - q.y) < eps)
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].closed !== b[i].closed || a[i].nodes.length !== b[i].nodes.length) return false
    for (let k = 0; k < a[i].nodes.length; k++) {
      const n = a[i].nodes[k]
      const m = b[i].nodes[k]
      if (!eq(n, m) || !eq(n.in, m.in) || !eq(n.out, m.out)) return false
    }
  }
  return true
}

const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const num = (v: number) => String(+v.toPrecision(12))

/** The source element's opening tag content: its own geometry attributes verbatim, placed by `m`. */
export function sourceAttrs(src: SvgSource, m: Affine): string[] {
  const out: string[] = []
  for (const k of GEOMETRY_ATTRS[src.tag]) if (src.attrs[k] != null) out.push(`${k}="${esc(src.attrs[k])}"`)
  const identity = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0
  if (!identity) out.push(`transform="matrix(${m.map(num).join(' ')})"`)
  return out
}
