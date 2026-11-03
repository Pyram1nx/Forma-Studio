// Parametric shape templates (Shaper Studio "Templates"). Lengths in mm, every build()
// returns closed contours centred on (0,0) (box joints: the board is centred, not the pocket).
// Holes are separate contours inside the outer one (even-odd fill).
import type { Contour, Pt, Units } from '../model/types'
import { MM_PER_IN } from '../model/types'
import { rect } from './primitives'
import { boolean, offsetContours } from './offset'
import { boxJointPocket, clampBoxJoint, type BoxJointKind } from './boxJoints'

export interface TemplateParam {
  key: string
  /** Lowercase label as shown in the settings panel. */
  label: string
  kind: 'length' | 'count' | 'angle' | 'ratio' | 'toggle' | 'slider'
  /** Default in mm (lengths) — the value for inch documents when `defaultMm` is also given. */
  default: number
  /** Default for millimetre documents, when it differs from the inch one (Studio has per-unit defaults). */
  defaultMm?: number
  min?: number
  max?: number
  /** Slider step. */
  step?: number
  /** Slider tick marks (values). */
  marks?: number[]
  /** Shown as the collapsed "radius +" row (RadiusField) instead of a plain field. */
  radiusRow?: boolean
  /** Letter shown in the field's left adornment (O, W, H, R…), as in Studio's panel. */
  adorn?: string
  /**
   * Choices for a 'toggle' parameter; `v` is the stored value. `icon` draws the choice as an icon
   * (a bold letter for 'letter', or the eye / eye-off icons) with `aria` as its accessible name.
   */
  options?: { v: number; label: string; aria?: string; icon?: 'letter' | 'eye' | 'eyeOff'; path?: string }[]
  /** Render the toggle options as a dropdown instead of a segmented control. */
  dropdown?: boolean
  /** Shown only while another parameter is at least `min` (Studio hides the second axis for one row). */
  showWhen?: { key: string; min: number }
  /** Label used instead of `label` while the spacing toggle is on "edges". */
  edgeLabel?: string
  /** Adornment while on "edges" spacing. */
  edgeAdorn?: string
  /** While on "edges", the panel shows (stored centre distance - this param) and commits value + this param. */
  edgeSub?: string
  /**
   * How the parameter follows a resize in the editor: 'x' / 'y' scale with the width / height of the
   * drag, 'xy' (round features such as diameters) with the smaller of the two so they stay round.
   * Leave unset for ratios, counts and fixed fillets.
   */
  axis?: 'x' | 'y' | 'xy'
}

export interface Template {
  id: string
  name: string
  params: TemplateParam[]
  build: (p: Record<string, number>) => Contour[]
  /**
   * Studio's own limits between parameters. Called with the full params and the one being edited; returns the
   * params to store (other params may follow, e.g. the tip radius shrinking with the inner diameter) or null
   * when Studio refuses the edit and leaves everything as it was.
   */
  constrain?: (params: Record<string, number>, key: string, value: number) => Record<string, number> | null
}

/** A template parameter's default for a document in `units`. */
export const paramDefault = (q: TemplateParam, units: Units = 'in') => (units === 'mm' && q.defaultMm !== undefined ? q.defaultMm : q.default)

type Getter = (key: string) => number

const TAU = Math.PI * 2

function prm(
  key: string,
  label: string,
  kind: TemplateParam['kind'],
  def: number,
  min?: number,
  max?: number,
  extra?: Pick<TemplateParam, 'adorn' | 'options' | 'showWhen' | 'edgeLabel' | 'edgeAdorn' | 'edgeSub' | 'defaultMm' | 'step' | 'marks' | 'radiusRow' | 'dropdown' | 'axis'>,
): TemplateParam {
  const q: TemplateParam = { key, label, kind, default: def, ...extra }
  if (min !== undefined) q.min = min
  if (max !== undefined) q.max = max
  return q
}

/** Star on its circumscribed circle: outer radius R, inner radius `inner` × R (no bbox fit). */
function starOnCircle(points: number, R: number, inner: number): Contour[] {
  const pts: Pt[] = []
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i / (points * 2)) * TAU
    const r = (i % 2 ? inner : 1) * R
    pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) })
  }
  return [{ pts, closed: true }]
}

/** Studio's compass limits (mm): the inner diameter keeps clear of the outer one and of zero. */
const COMPASS_GAP = 0.005 * MM_PER_IN
const COMPASS_INNER_MIN = 0.02 * MM_PER_IN

/** The largest tip radius that still fits: just under the half-width of the shape at its notches. */
export function compassTipMax(innerDiameter: number, points: number): number {
  return 0.99 * (innerDiameter / 2) * Math.sin(Math.PI / Math.max(2, points))
}

/** Studio's compass: edits that break a limit are refused (outer) or pull the neighbouring params along. */
function constrainCompass(p: Record<string, number>, key: string, v: number): Record<string, number> | null {
  const next = { ...p, [key]: v }
  const pts = Math.max(2, Math.round(next.points))
  if (key === 'points') next.points = pts
  if (key === 'size') {
    // Too small an outer diameter, or one that would squeeze the tip radius out, is not accepted.
    if (!(v > COMPASS_GAP)) return null
    next.innerDiameter = Math.min(next.innerDiameter, v - COMPASS_GAP)
    if (next.tipRadius > compassTipMax(next.innerDiameter, pts)) return null
  } else if (key === 'innerDiameter') {
    next.innerDiameter = Math.max(COMPASS_INNER_MIN, Math.min(v, next.size - COMPASS_GAP))
  }
  next.tipRadius = Math.max(0, Math.min(next.tipRadius, compassTipMax(next.innerDiameter, pts)))
  return next
}

/**
 * Studio's compass rose: one closed facet per half point (tip, notch, centre), so a 2-point-per-side star is
 * 2n triangles sharing edges. Each tip is rounded by a circle of radius `tip` whose far edge sits exactly on the
 * outer radius `R` (so the outer diameter is honoured, unlike offset rounding which shrinks the tips); the notch
 * stays a sharp vertex at the inner radius and the edge to it is tangent to that circle.
 */
function compassFacets(points: number, R: number, inner: number, tip: number): Contour[] {
  const ri = Math.min(R, Math.max(R * 0.01, inner))
  const step = TAU / points
  const cd = (t: number) => R - t
  const t = Math.max(0, Math.min(tip, compassTipMax(ri * 2, points), R * 0.99))
  const facets: Contour[] = []
  for (let k = 0; k < points; k++) {
    const a = -Math.PI / 2 + k * step
    const u = { x: Math.cos(a), y: Math.sin(a) }
    const v = { x: -u.y, y: u.x }
    const c = { x: u.x * cd(t), y: u.y * cd(t) }
    for (const side of [1, -1]) {
      // Notch in the (u, v) frame, mirrored for the other side.
      const N = { x: u.x * ri * Math.cos(step / 2) + v.x * side * ri * Math.sin(step / 2), y: u.y * ri * Math.cos(step / 2) + v.y * side * ri * Math.sin(step / 2) }
      const pts: Pt[] = []
      if (t > 0) {
        const dx = N.x - c.x
        const dy = N.y - c.y
        const L = Math.hypot(dx, dy)
        const base = Math.atan2(dy, dx)
        const off = Math.acos(t / L)
        // Of the two tangent points take the one facing the tip.
        let best = { x: 0, y: 0, score: -Infinity, ang: 0 }
        for (const phi of [base + off, base - off]) {
          const q = { x: c.x + t * Math.cos(phi), y: c.y + t * Math.sin(phi) }
          const score = (q.x - c.x) * u.x + (q.y - c.y) * u.y
          if (score > best.score) best = { ...q, score, ang: phi }
        }
        // Arc from the apex (angle a) to the tangent point, in <=10 degree steps.
        let da = best.ang - a
        da = Math.atan2(Math.sin(da), Math.cos(da))
        const n = Math.max(1, Math.ceil(Math.abs(da) / ((10 * Math.PI) / 180)))
        for (let i = 0; i <= n; i++) {
          const ang = a + (da * i) / n
          pts.push({ x: c.x + t * Math.cos(ang), y: c.y + t * Math.sin(ang) })
        }
      } else {
        pts.push({ x: u.x * R, y: u.y * R })
      }
      pts.push(N, { x: 0, y: 0 })
      // Keep every facet wound the same way.
      let area = 0
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i]
        const q = pts[(i + 1) % pts.length]
        area += p.x * q.y - q.x * p.y
      }
      facets.push({ pts: area < 0 ? pts.reverse() : pts, closed: true })
    }
  }
  return facets
}

/** Rounds convex corners with the given radius (open then close with round joins). */
function roundCorners(cs: Contour[], r: number): Contour[] {
  if (!(r > 0)) return cs
  return offsetContours(offsetContours(cs, -r, 'round'), r, 'round')
}

/** Wraps a builder so missing params fall back to their defaults. */
function tpl(id: string, name: string, params: TemplateParam[], fn: (g: Getter) => Contour[], constrain?: Template['constrain']): Template {
  const defaults: Record<string, number> = {}
  for (const q of params) defaults[q.key] = q.default
  return {
    id,
    name,
    params,
    build: (p) => fn((key) => p[key] ?? defaults[key] ?? 0),
    constrain,
  }
}

function circle(cx: number, cy: number, r: number): Contour {
  const n = Math.max(48, Math.min(720, Math.ceil(r * 8)))
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return { pts, closed: true }
}

function move(cs: Contour[], dx: number, dy: number): Contour[] {
  return cs.map((c) => ({ closed: c.closed, pts: c.pts.map((p) => ({ x: p.x + dx, y: p.y + dy })) }))
}

function spin(cs: Contour[], deg: number): Contour[] {
  const a = (deg * Math.PI) / 180
  const co = Math.cos(a)
  const si = Math.sin(a)
  return cs.map((c) => ({
    closed: c.closed,
    pts: c.pts.map((p) => ({ x: p.x * co - p.y * si, y: p.x * si + p.y * co })),
  }))
}

function unite(...sets: Contour[][]): Contour[] {
  return sets.reduce((acc, s) => boolean('union', acc, s))
}

/** Translate so the bounding box centre sits on (0,0). */
function centre(cs: Contour[]): Contour[] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of cs)
    for (const p of c.pts) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  if (!isFinite(minX)) return cs
  return move(cs, -(minX + maxX) / 2, -(minY + maxY) / 2)
}

/** Drop consecutive duplicate points (including a closing duplicate). */
function clean(pts: Pt[]): Pt[] {
  const eq = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9
  const out: Pt[] = []
  for (const p of pts) {
    const q = out[out.length - 1]
    if (!q || !eq(q, p)) out.push(p)
  }
  while (out.length > 1 && eq(out[0], out[out.length - 1])) out.pop()
  return out
}

/**
 * Heart, built the way Studio builds it (measured against the real tool, every number below matches).
 * Work is in y-up inches, centred on the box: each lobe is a circle tangent to the box's top and its own
 * side, whose radius is set so the circle passes through the centre notch (`pinch` moves that notch down).
 * The tail leaves each lobe at the tangent point toward the bottom tip, turned by up to 30 deg per unit of
 * `curl` along the circle, and runs to the tip as one cubic that starts along the circle's tangent (so the
 * join is smooth, never a corner). A deep pinch also puts a short cubic between lobe and notch.
 * Width and height feed the formulas directly (the lobes stay circles when the box is not square).
 */
const HEART_NOTCH_BUFFER = 0.09 // in
const HEART_PINCH_RATIO = 3
const HEART_MAX_RADIUS = 0.75
const HEART_DEEP_PINCH = 0.92

type V2 = [number, number]

/** Radius of the lobe circles for a notch `depth` below the top edge of a W x H box. */
function heartLobeRadius(W: number, H: number, depth: number): number {
  const base = W / 4
  const cap = (H / 2) * HEART_MAX_RADIUS
  let r = base
  // Circle tangent to the top and its own side that also passes through the notch (x = 0, y = -depth).
  const thru = W / 2 + depth - Math.sqrt(W * depth)
  if (Number.isFinite(thru) && thru > 0) r = thru
  if (base - depth < 0) {
    const deep = base * HEART_DEEP_PINCH
    if (Number.isFinite(deep) && deep > 0) r = deep
  }
  r = Math.min(r, cap)
  return !Number.isFinite(r) || r <= 0 ? Math.min(base, cap) : r
}

/** Angle (from the circle centre) of the tangent point on a circle as seen from point P. */
function heartTangentAngle(C: V2, r: number, P: V2, cw: boolean): number {
  const dx = C[0] - P[0]
  const dy = C[1] - P[1]
  const d = Math.hypot(dx, dy)
  const base = Math.atan2(dy, dx)
  if (d <= r) return Math.atan2(P[1] - C[1], P[0] - C[0])
  const w = Math.acos(r / d)
  return (cw ? base + w : base - w) + Math.PI
}

/**
 * Cubic from the lobe circle to P. It leaves the circle at the tangent point turned by `t` * 30 deg and
 * continues along the circle's tangent; at P it points along a direction swung from the chord toward
 * straight up (t > 0) or straight left (t < 0). Handle lengths are fractions of the distance to where the
 * two tangent lines meet.
 */
function heartCurve(C: V2, r: number, cw: boolean, t: number, P: V2, sCircle: number, sPoint: number): { bez: [V2, V2, V2, V2]; angle: number } {
  const angle = heartTangentAngle(C, r, P, cw) + t * (30 * Math.PI) / 180
  const T: V2 = [C[0] + r * Math.cos(angle), C[1] + r * Math.sin(angle)]
  const along = cw ? angle - Math.PI / 2 : angle + Math.PI / 2
  const O: V2 = [Math.cos(along), Math.sin(along)]
  const chord = Math.atan2(T[1] - P[1], T[0] - P[0])
  const target = t >= 0 ? Math.PI / 2 : Math.PI
  const swing = chord + Math.abs(t) * (target - chord)
  const I: V2 = [Math.cos(swing), Math.sin(swing)]
  const cross = O[0] * I[1] - O[1] * I[0]
  const ux = P[0] - T[0]
  const uy = P[1] - T[1]
  let lenO: number
  let lenI: number
  if (Math.abs(cross) < 1e-9) lenO = lenI = Math.hypot(ux, uy)
  else {
    lenO = Math.abs((ux * I[1] - uy * I[0]) / cross)
    lenI = Math.abs((ux * O[1] - uy * O[0]) / cross)
  }
  const h1: V2 = [T[0] + O[0] * lenO * sCircle, T[1] + O[1] * lenO * sCircle]
  const h2: V2 = [P[0] + I[0] * lenI * sPoint, P[1] + I[1] * lenI * sPoint]
  return { bez: [T, h1, h2, P], angle }
}

function sampleCubic(b: [V2, V2, V2, V2], n: number): V2[] {
  const out: V2[] = []
  for (let i = 0; i <= n; i++) {
    const u = i / n
    const w = 1 - u
    out.push([
      w * w * w * b[0][0] + 3 * w * w * u * b[1][0] + 3 * w * u * u * b[2][0] + u * u * u * b[3][0],
      w * w * w * b[0][1] + 3 * w * w * u * b[1][1] + 3 * w * u * u * b[2][1] + u * u * u * b[3][1],
    ])
  }
  return out
}

/** Heart outline for a W x H box in inches (y down), centred on (0,0). `pinch` 0..1, `curl` -1..1. */
function heartPts(W: number, H: number, pinch: number, curl: number): Pt[] {
  const p = Math.max(0, Math.min(1, pinch))
  const c = Math.max(-1, Math.min(1, curl))
  const notchY = (1 - HEART_NOTCH_BUFFER) * (H / 2) - (p * (H - HEART_NOTCH_BUFFER)) / HEART_PINCH_RATIO
  const depth = H / 2 - notchY
  const r = heartLobeRadius(W, H, depth)
  const C: V2 = [-(W / 2 - r), H / 2 - r]
  const tip: V2 = [0, -H / 2]
  const notch: V2 = [0, notchY]

  const bottom = heartCurve(C, r, false, c, tip, 0.8, 0.4)
  const deep = Math.hypot(C[0] - notch[0], C[1] - notch[1]) > r
  const top = deep ? heartCurve(C, r, true, 0.9, notch, 0.8, 0.2) : null

  const turn = (a: number) => ((a % TAU) + TAU) % TAU
  const aStart = turn(top ? top.angle : Math.atan2(notch[1] - C[1], notch[0] - C[0]))
  let aEnd = turn(bottom.angle)
  if (aEnd < aStart) aEnd += TAU
  const steps = Math.max(24, Math.ceil(((aEnd - aStart) / TAU) * 180))

  const half: V2[] = []
  if (top) half.push(...sampleCubic(top.bez, 40).reverse())
  else half.push(notch)
  for (let i = 1; i <= steps; i++) {
    const a = aStart + ((aEnd - aStart) * i) / steps
    half.push([C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)])
  }
  half.push(...sampleCubic(bottom.bez, 72).slice(1))

  const left = half.map(([x, y]): Pt => ({ x, y: -y }))
  const right = half
    .slice(1, -1)
    .reverse()
    .map(([x, y]): Pt => ({ x: -x, y: -y }))
  return clean([...left, ...right])
}

/**
 * Box joint basic / pro, as Studio builds them (geometry in ./boxJoints). Defaults differ per unit
 * system: inch documents get W 10 in, T 0.75 in, bit 0.25 in; mm documents W 200, T 20 (basic) or
 * 19.05 (pro), bit 6. Param keys: side, length (W), thickness, bitDiameter, fingers (pin count),
 * pinFactor (pro), glueGap, guides.
 */
function boxJointTemplate(kind: BoxJointKind, id: string, name: string, guidesLabel: string, thicknessMm: number): Template {
  const params: TemplateParam[] = [
    prm('side', 'side', 'toggle', 0, undefined, undefined, {
      options: [
        { v: 0, label: 'A', aria: 'side A', icon: 'letter' },
        { v: 1, label: 'B', aria: 'side B', icon: 'letter' },
      ],
    }),
    prm('length', 'width', 'length', 254, 0, undefined, { adorn: 'W', defaultMm: 200 }),
    prm('thickness', 'thickness', 'length', 19.05, 0, undefined, { adorn: 'T', defaultMm: thicknessMm }),
    prm('bitDiameter', 'bit diameter', 'length', 6.35, 0, undefined, { adorn: 'B', defaultMm: 6 }),
    prm('fingers', 'pin count', 'count', 5, 2, Infinity),
  ]
  if (kind === 'pro') params.push(prm('pinFactor', 'pin factor', 'slider', -0.75, -1, 1, { step: 0.05, marks: [0] }))
  params.push(
    prm('glueGap', 'glue gap', 'length', 0, 0, undefined, { adorn: 'G' }),
    prm('guides', guidesLabel, 'toggle', 1, undefined, undefined, {
      options: [
        { v: 1, label: 'show', aria: 'show', icon: 'eye' },
        { v: 0, label: 'hide', aria: 'hide', icon: 'eyeOff' },
      ],
    }),
  )
  // The pocket only; the guides are separate shapes kept in step by the editor (boxJointGuides).
  // Geometry stays in the stock frame (board centred on 0,0) so guides and anchors line up with it.
  return tpl(id, name, params, (g) => {
    const p: Record<string, number> = {}
    for (const q of params) p[q.key] = g(q.key)
    return boxJointPocket(kind, clampBoxJoint(kind, p, 'mm'))
  })
}

export const TEMPLATES: Template[] = [
  tpl(
    'barbell',
    'Barbell',
    [
      prm('length', 'overall width', 'length', 50.8, 0, undefined, { adorn: 'O', axis: 'x' }),
      prm('bellDiameter', 'bell diameter', 'length', 12.7, 0, undefined, { adorn: 'B', axis: 'y' }),
      prm('barWidth', 'center height', 'length', 6.604, 0, undefined, { adorn: 'C', axis: 'y' }),
      prm('radius', 'radius', 'length', 2.0066, 0, undefined, { adorn: 'R' }),
    ],
    (g) => {
      // Bells sit so their outer edges are at ±L/2; the bar runs between their centres.
      const L = g('length')
      const d = g('bellDiameter')
      const c = (L - d) / 2
      const u = unite([circle(-c, 0, d / 2)], [circle(c, 0, d / 2)], rect(L - d, g('barWidth')))
      // Radius fillets the four concave bar/bell junctions (close = grow then shrink).
      const r = g('radius')
      return r > 0 ? offsetContours(offsetContours(u, r, 'round'), -r, 'round') : u
    },
  ),

  tpl(
    'bowtie',
    'Bow tie',
    [
      prm('style', 'style', 'toggle', 0, undefined, undefined, { options: [{ v: 0, label: 'sharp', aria: 'sharp', path: 'M20.7256 4.86522C21.1126 4.68638 21.5646 4.71754 21.9238 4.94726C22.2828 5.17702 22.5 5.57377 22.5 5.99999V19C22.5 19.4262 22.2828 19.823 21.9238 20.0527C21.5646 20.2824 21.1126 20.3136 20.7256 20.1348L12.0645 16.1328C11.8649 16.0406 11.6351 16.0406 11.4355 16.1328L2.77441 20.1348C2.38736 20.3136 1.93538 20.2824 1.57617 20.0527C1.21721 19.823 1 19.4262 1 19V5.99999L1.00977 5.84179C1.05624 5.47715 1.26208 5.1483 1.57617 4.94726C1.93538 4.71754 2.38736 4.68638 2.77441 4.86522L11.4355 8.86718C11.6351 8.95937 11.8649 8.95937 12.0645 8.86718L20.7256 4.86522ZM13.1133 11.1367C12.2484 11.5364 11.2516 11.5364 10.3867 11.1367L3.5 7.95409V17.0449L10.3867 13.8633C11.2516 13.4636 12.2484 13.4636 13.1133 13.8633L20 17.0449V7.95409L13.1133 11.1367Z' }, { v: 1, label: 'smooth', aria: 'smooth', path: 'M20.3262 5.15723C20.674 4.776 21.221 4.64847 21.7021 4.83496C22.183 5.02158 22.5 5.48415 22.5 6V19C22.5 19.5125 22.1873 19.9732 21.7109 20.1621C21.2344 20.351 20.69 20.2299 20.3389 19.8564C15.6832 14.9049 7.81683 14.9049 3.16113 19.8564C2.81001 20.2299 2.2656 20.351 1.78906 20.1621C1.31272 19.9732 1 19.5125 1 19V6C1 5.48415 1.31698 5.02158 1.79785 4.83496C2.279 4.64847 2.82605 4.776 3.17383 5.15723C7.77788 10.204 15.7221 10.204 20.3262 5.15723ZM20 8.78223C15.0944 12.328 8.40564 12.328 3.5 8.78223V16.2617C8.42476 12.7705 15.0752 12.7705 20 16.2617V8.78223Z' }] }),
      prm('width', 'width', 'length', 101.6, 0, undefined, { adorn: 'W', axis: 'x' }),
      prm('height', 'height', 'length', 50.8, 0, undefined, { adorn: 'H', axis: 'y' }),
      prm('radius', 'radius', 'length', 3.175, 0, undefined, { adorn: 'R' }),
      prm('centerPinch', 'center pinch', 'slider', 0.5, 0, 1, { step: 0.01 }),
      prm('sidePinch', 'side pinch', 'slider', 0, -1, 1, { step: 0.01 }),
      prm('skew', 'skew', 'slider', 0, -1, 1, { step: 0.05 }),
    ],
    (g) => {
      const W = g('width')
      const H = g('height')
      const sp = g('sidePinch')
      const sk = g('skew')
      const waist = Math.max(H * (1 - g('centerPinch')), H * 0.01)
      const hw = W / 2
      const he = H / 2
      const hc = waist / 2
      // Skew (empirical, from Studio): + slides the left-top and right-bottom corners towards the
      // centre; - pulls both bottom corners inwards.
      const lt = sk > 0 ? sk * hw : 0
      const rb = sk > 0 ? sk * hw : 0
      const lb = sk < 0 ? -sk * 0.4 * W : 0
      const rbN = sk < 0 ? -sk * 0.4 * W : 0
      const wTop = sk > 0 ? sk * W / 16 : 0
      const wBot = sk > 0 ? sk * W / 16 : 0
      const side = sp > 0 ? sp * W / 8 : sp * 31.75 // indent (+) or bulge (-, 1.25 in at full)
      const P = (x: number, y: number): Pt => ({ x, y })
      const topL = P(-hw + lt, he)
      const botL = P(-hw + lb, -he)
      const topR = P(hw, he)
      const botR = P(hw - rb - rbN, -he)
      const cTop = P(wTop, hc)
      const cBot = P(-wBot, -hc)
      const smooth = g('style') >= 0.5
      // quadratic curve a -> b with the curve passing through m at t = 0.5
      const curve = (a: Pt, m: Pt, b: Pt): Pt[] => {
        const c = P(2 * m.x - (a.x + b.x) / 2, 2 * m.y - (a.y + b.y) / 2)
        const out: Pt[] = []
        const n = 32
        for (let i = 1; i < n; i++) {
          const t = i / n
          const u = 1 - t
          out.push(P(u * u * a.x + 2 * u * t * c.x + t * t * b.x, u * u * a.y + 2 * u * t * c.y + t * t * b.y))
        }
        return out
      }
      const pts: Pt[] = [botL]
      if (sp !== 0) pts.push(P(-hw + side, 0))
      pts.push(topL)
      if (smooth) pts.push(...curve(topL, cTop, topR))
      else pts.push(cTop)
      pts.push(topR)
      if (sp !== 0) pts.push(P(hw - side, 0))
      pts.push(botR)
      if (smooth) pts.push(...curve(botR, cBot, botL))
      else pts.push(cBot)
      const r = g('radius')
      const outline: Contour[] = [{ closed: true, pts }]
      return r > 0 ? offsetContours(offsetContours(roundCorners(outline, r), r, 'round'), -r, 'round') : outline
    },
  ),

  boxJointTemplate('basic', 'boxJointBasic', 'Box joint basic', 'guides', 20),
  boxJointTemplate('pro', 'boxJointPro', 'Box joint pro', 'show guides', 19.05),

  tpl(
    'compass',
    'Compass',
    [
      prm('points', '# points', 'count', 8, 2, 100),
      prm('size', 'outer diameter', 'length', 50.8, 0, undefined, { adorn: 'O', axis: 'xy' }),
      prm('innerDiameter', 'inner diameter', 'length', 25.4, 0, undefined, { adorn: 'I', axis: 'xy' }),
      prm('tipRadius', 'tip radius', 'length', 1.778, 0, undefined, { adorn: 'T', axis: 'xy' }),
    ],
    (g) => compassFacets(Math.max(2, Math.round(g('points'))), g('size') / 2, g('innerDiameter') / 2, g('tipRadius')),
    constrainCompass,
  ),

  tpl(
    'cornerRound',
    'Corner round',
    [
      prm('radius', 'radius', 'length', 25.4, 0, undefined, { adorn: 'R', axis: 'xy' }),
      prm('slotWidth', 'slot width', 'length', 7.62, 0, undefined, { adorn: 'S', axis: 'xy' }),
      prm('stockAngle', 'stock angle', 'count', 90, 5, 175, { adorn: '°' }),
    ],
    (g) => {
      // Studio's corner-round cutter: a band hugging a fillet arc of radius `radius` that is tangent to two
      // stock edges meeting at a corner (the two open guide lines); the band lies on the corner side.
      const r = Math.max(g('radius'), 0.01)
      const sw = Math.max(g('slotWidth'), 0.01)
      const th = (Math.min(175, Math.max(5, g('stockAngle'))) * Math.PI) / 180
      const u1 = { x: -1, y: 0 }
      const u2 = { x: -Math.cos(th), y: -Math.sin(th) }
      const d = r / Math.tan(th / 2)
      const bis = { x: u1.x + u2.x, y: u1.y + u2.y }
      const bl = Math.hypot(bis.x, bis.y)
      const k = r / Math.sin(th / 2) / bl
      const C = { x: bis.x * k, y: bis.y * k }
      const T1 = { x: u1.x * d, y: u1.y * d }
      const T2 = { x: u2.x * d, y: u2.y * d }
      const a1 = Math.atan2(T1.y - C.y, T1.x - C.x)
      let da = Math.atan2(T2.y - C.y, T2.x - C.x) - a1
      while (da > Math.PI) da -= TAU
      while (da < -Math.PI) da += TAU
      const nArc = Math.max(24, Math.ceil((Math.abs(da) * (r + sw)) * 0.4))
      const arcPts = (rad: number, reverse: boolean): Pt[] => {
        const out: Pt[] = []
        for (let i = 0; i <= nArc; i++) {
          const t = reverse ? 1 - i / nArc : i / nArc
          const a = a1 + da * t
          out.push({ x: C.x + rad * Math.cos(a), y: C.y + rad * Math.sin(a) })
        }
        return out
      }
      const armLen = 2.2 * sw - sw / 2
      const tilt = 0.09 * sw
      // End points of an arm: [inner edge end, outer edge end], tilted slightly away from the arc centre.
      const arm = (T: Pt, u: Pt) => {
        const n = { x: (T.x - C.x) / r, y: (T.y - C.y) / r }
        const e = (rad: number): Pt => ({
          x: C.x + n.x * rad + u.x * armLen + n.x * tilt,
          y: C.y + n.y * rad + u.y * armLen + n.y * tilt,
        })
        const inner = e(r)
        const outer = e(r + sw)
        const M = { x: (inner.x + outer.x) / 2, y: (inner.y + outer.y) / 2 }
        const v0 = { x: inner.x - M.x, y: inner.y - M.y }
        const sign = v0.x * u.y - v0.y * u.x >= 0 ? 1 : -1
        const cap: Pt[] = []
        const N = 12
        for (let i = 1; i < N; i++) {
          const a = sign * Math.PI * (i / N)
          cap.push({ x: M.x + v0.x * Math.cos(a) - v0.y * Math.sin(a), y: M.y + v0.x * Math.sin(a) + v0.y * Math.cos(a) })
        }
        return { inner, outer, cap }
      }
      const A1 = arm(T1, u1)
      const A2 = arm(T2, u2)
      const pts: Pt[] = [
        A1.inner,
        ...arcPts(r, false),
        A2.inner,
        ...A2.cap,
        A2.outer,
        ...arcPts(r + sw, true),
        A1.outer,
        ...[...A1.cap].reverse(),
      ]
      const gl = d + r
      const guide = (u: Pt): Contour => ({ pts: [{ x: 0, y: 0 }, { x: u.x * gl, y: u.y * gl }], closed: false })
      const contours: Contour[] = [{ pts, closed: true }, guide(u1), guide(u2)]
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      for (const c of contours) for (const q of c.pts) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y) }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
      return contours.map((c) => ({ ...c, pts: c.pts.map((q) => ({ x: q.x - cx, y: q.y - cy })) }))
    },
  ),

  tpl(
    'dogboneRectangle',
    'Dogbone rectangle',
    [
      prm('width', 'width', 'length', 38.1, 0, undefined, { adorn: 'W', axis: 'x' }),
      prm('height', 'height', 'length', 19.05, 0, undefined, { adorn: 'H', axis: 'y' }),
      prm('style', 'dogbone style', 'toggle', 0, undefined, undefined, { dropdown: true, options: [{ v: 0, label: 'corner' }] }),
      prm('bitDiameter', 'dogbone diameter', 'length', 6.35, 0, undefined, { adorn: 'D' }),
      prm('guides', 'guides', 'toggle', 1, undefined, undefined, { options: [{ v: 1, label: 'show' }, { v: 0, label: 'hide' }] }),
    ],
    (g) => {
      const w = g('width')
      const h = g('height')
      const r = g('bitDiameter') / 2
      const hw = w / 2
      const hh = h / 2
      // Circle centre sits r/√2 inside each corner on both axes, so its edge passes through the corner.
      const off = r / Math.SQRT2
      const corners = [
        [hw, hh],
        [-hw, hh],
        [-hw, -hh],
        [hw, -hh],
      ]
      const relief = corners.map(([x, y]) => circle(x - Math.sign(x) * off, y - Math.sign(y) * off, r))
      return boolean('union', rect(w, h), relief)
    },
  ),

  tpl(
    'heart',
    'Heart',
    [
      prm('width', 'width', 'length', 76.2, 0, undefined, { adorn: 'W', defaultMm: 75, axis: 'x' }),
      prm('height', 'height', 'length', 76.2, 0, undefined, { adorn: 'H', defaultMm: 75, axis: 'y' }),
      prm('centerPinch', 'center pinch', 'slider', 0.5, 0, 1, { step: 0.05, marks: [0.5] }),
      // Left end (-1) is the rounded tail, right end (+1) the flared point, as in Studio.
      prm('tailCurl', 'tail curl', 'slider', 0, -1, 1, { step: 0.05, marks: [0] }),
      // Collapsed "radius +" row; rounds the tip and the notch (stored under 'r' like a rectangle's corner radius).
      prm('r', 'radius', 'length', 0, 0, undefined, { adorn: 'R', radiusRow: true }),
    ],
    (g) => {
      const sx = g('width')
      const sy = g('height')
      // Studio's formulas carry an absolute inch constant, so the heart is built in inches and scaled back.
      const pts = heartPts(sx / MM_PER_IN, sy / MM_PER_IN, g('centerPinch'), g('tailCurl')).map((p) => ({ x: p.x * MM_PER_IN, y: p.y * MM_PER_IN }))
      let out: Contour[] = [{ pts, closed: true }]
      // Studio caps the fillet at about 13% of the smaller side (0.392 in on a 3 in heart).
      const r = Math.min(g('r'), 0.1307 * Math.min(sx, sy))
      if (r > 0) out = offsetContours(offsetContours(roundCorners(out, r), r, 'round'), -r, 'round')
      return out
    },
  ),

  tpl(
    'keyhole',
    'Keyhole',
    [
      prm('slotLength', 'slot length', 'length', 8.89, 0, undefined, { adorn: 'S', axis: 'y' }),
      prm('headDiameter', 'head diameter', 'length', 10.49, 0, undefined, { adorn: 'H', axis: 'xy' }),
      prm('slotWidth', 'neck diameter', 'length', 5, 0, undefined, { adorn: 'N', axis: 'xy' }),
    ],
    (g) => {
      const rr = g('headDiameter') / 2
      const rs = g('slotWidth') / 2
      // Neck runs from the head centre; its round end is centred slotLength away.
      const yEnd = Math.max(0, g('slotLength'))
      const slot = unite(move(rect(rs * 2, yEnd), 0, yEnd / 2), [circle(0, yEnd, rs)])
      return centre(unite([circle(0, 0, rr)], slot))
    },
  ),

  tpl(
    'linearHoles',
    'Linear holes',
    [
      prm('diameter', 'hole diameter', 'length', 20, 0, undefined, { adorn: 'H', axis: 'xy' }),
      prm('countX', 'hole count x', 'count', 4, 1, 99),
      prm('countY', 'hole count y', 'count', 2, 1, 99),
      prm('spacing', 'spacing type', 'toggle', 0, undefined, undefined, { options: [{ v: 0, label: 'centers' }, { v: 1, label: 'edges' }] }),
      prm('distanceX', 'center distance x', 'length', 96, 0, undefined, { adorn: 'C', axis: 'x', edgeLabel: 'edge distance x', edgeAdorn: 'E', edgeSub: 'diameter', showWhen: { key: 'countX', min: 2 } }),
      prm('distanceY', 'center distance y', 'length', 96, 0, undefined, { adorn: 'C', axis: 'y', edgeLabel: 'edge distance y', edgeAdorn: 'E', edgeSub: 'diameter', showWhen: { key: 'countY', min: 2 } }),
    ],
    (g) => {
      const nx = Math.max(1, Math.round(g('countX')))
      const ny = Math.max(1, Math.round(g('countY')))
      const d = g('diameter')
      // Stored distances are always centre to centre; "edges" only changes how the panel shows them.
      const px = g('distanceX')
      const py = g('distanceY')
      const out: Contour[] = []
      for (let i = 0; i < nx; i++)
        for (let j = 0; j < ny; j++) out.push(circle((i - (nx - 1) / 2) * px, (j - (ny - 1) / 2) * py, d / 2))
      return out
    },
  ),

  tpl(
    'linearRectangles',
    'Linear rectangles',
    [
      prm('width', 'rectangle width', 'length', 12.7, 0, undefined, { adorn: 'R', axis: 'x' }),
      prm('height', 'rectangle height', 'length', 19.05, 0, undefined, { adorn: 'R', axis: 'y' }),
      prm('countX', 'rectangle count x', 'count', 4, 1, 99),
      prm('countY', 'rectangle count y', 'count', 1, 1, 99),
      prm('spacing', 'spacing type', 'toggle', 0, undefined, undefined, { options: [{ v: 0, label: 'centers' }, { v: 1, label: 'edges' }] }),
      prm('distanceX', 'center distance x', 'length', 38.1, 0, undefined, { adorn: 'C', axis: 'x', edgeLabel: 'edge distance x' }),
      prm('distanceY', 'center distance y', 'length', 38.1, 0, undefined, { adorn: 'C', axis: 'y', edgeLabel: 'edge distance y', showWhen: { key: 'countY', min: 2 } }),
    ],
    (g) => {
      const nx = Math.max(1, Math.round(g('countX')))
      const ny = Math.max(1, Math.round(g('countY')))
      const w = g('width')
      const h = g('height')
      // "Edges" spacing is the gap between rectangles, so centres sit one rectangle size further apart.
      const edge = g('spacing') === 1
      const px = g('distanceX') + (edge ? w : 0)
      const py = g('distanceY') + (edge ? h : 0)
      const out: Contour[] = []
      for (let i = 0; i < nx; i++)
        for (let j = 0; j < ny; j++) out.push(...move(rect(w, h), (i - (nx - 1) / 2) * px, (j - (ny - 1) / 2) * py))
      return out
    },
  ),

  tpl(
    'radialHoles',
    'Radial holes',
    [
      prm('holeDiameter', 'hole diameter', 'length', 6.35, 0, undefined, { adorn: 'H', axis: 'xy' }),
      prm('boltDiameter', 'hole centers diameter', 'length', 127, 0, undefined, { adorn: 'H', axis: 'xy' }),
      prm('count', 'hole count', 'count', 8, 1, 99),
    ],
    (g) => {
      const n = Math.max(1, Math.round(g('count')))
      const R = g('boltDiameter') / 2
      const hr = g('holeDiameter') / 2
      const out: Contour[] = []
      for (let i = 0; i < n; i++) {
        const a = ((90 - 180 / n + (i * 360) / n) * Math.PI) / 180
        out.push(circle(R * Math.cos(a), R * Math.sin(a), hr))
      }
      return out
    },
  ),

  tpl(
    'snowflake',
    'Snowflake',
    [
      prm('size', 'diameter', 'length', 76.2, 0, undefined, { adorn: 'D', axis: 'xy' }),
      prm('armWidth', 'branch width', 'length', 2.54, 0, undefined, { adorn: 'B', axis: 'xy' }),
      prm('branches', 'branches', 'count', 6, 1, 24),
      prm('radius', 'radius', 'length', 0, 0, undefined, { adorn: 'R', axis: 'xy' }),
    ],
    (g) => {
      const R = g('size') / 2
      const hw = g('armWidth') / 2
      const n = Math.max(1, Math.round(g('branches')))
      // Round-capped stroke from (x0,y0) to (x1,y1).
      const stroke = (x0: number, y0: number, x1: number, y1: number): Contour[] => {
        const len = Math.hypot(x1 - x0, y1 - y0)
        const ang = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI
        const bar = move(rect(len, hw * 2), len / 2, 0)
        return move(spin(unite(bar, [circle(0, 0, hw)], [circle(len, 0, hw)]), ang), x0, y0)
      }
      // One arm pointing up (-y); two pairs of side branches angled 60 degrees off the axis toward the tip.
      let arm: Contour[] = stroke(0, 0, 0, -R)
      const t = (60 * Math.PI) / 180
      for (const [f, l] of [
        [0.43, 0.35],
        [0.73, 0.26],
      ]) {
        for (const sgn of [-1, 1]) {
          const jy = -f * R
          arm = unite(arm, stroke(0, jy, sgn * l * R * Math.sin(t), jy - l * R * Math.cos(t)))
        }
      }
      let out: Contour[] = arm
      for (let k = 1; k < n; k++) out = unite(out, spin(arm, (k * 360) / n))
      return roundCorners(out, g('radius'))
    },
  ),

  tpl(
    'star',
    'Star',
    [
      prm('size', 'outer diameter', 'length', 50.8, 0, undefined, { adorn: 'O', axis: 'xy' }),
      prm('innerDiameter', 'inner diameter', 'length', 25.4, 0, undefined, { adorn: 'I', axis: 'xy' }),
      prm('points', '# points', 'count', 5, 2, 16),
      prm('radius', 'radius', 'length', 0, 0, undefined, { adorn: 'R', axis: 'xy' }),
    ],
    (g) => {
      const s = g('size')
      const inner = Math.min(1, Math.max(0.01, g('innerDiameter') / (s || 1)))
      return roundCorners(starOnCircle(Math.max(2, Math.round(g('points'))), s / 2, inner), g('radius'))
    },
  ),
]
