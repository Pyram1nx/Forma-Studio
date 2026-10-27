// Parametric shape templates (Shaper Studio "Templates"). Lengths in mm, every build()
// returns closed contours centred on (0,0) (box joints: the board is centred, not the pocket).
// Holes are separate contours inside the outer one (even-odd fill).
import type { Contour, Pt, Units } from '../model/types'
import { fitTo, rect } from './primitives'
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
  /** Slider runs right-to-left (its max is at the left end), as Studio's heart tail curl does. */
  reverse?: boolean
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
}

export interface Template {
  id: string
  name: string
  params: TemplateParam[]
  build: (p: Record<string, number>) => Contour[]
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
  extra?: Pick<TemplateParam, 'adorn' | 'options' | 'showWhen' | 'edgeLabel' | 'edgeAdorn' | 'edgeSub' | 'defaultMm' | 'step' | 'marks' | 'reverse' | 'radiusRow' | 'dropdown'>,
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

/** Rounds convex corners with the given radius (open then close with round joins). */
function roundCorners(cs: Contour[], r: number): Contour[] {
  if (!(r > 0)) return cs
  return offsetContours(offsetContours(cs, -r, 'round'), r, 'round')
}

/** Wraps a builder so missing params fall back to their defaults. */
function tpl(id: string, name: string, params: TemplateParam[], fn: (g: Getter) => Contour[]): Template {
  const defaults: Record<string, number> = {}
  for (const q of params) defaults[q.key] = q.default
  return {
    id,
    name,
    params,
    build: (p) => fn((key) => p[key] ?? defaults[key] ?? 0),
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
 * Heart, as Studio draws it: two elliptical lobes (centres +-a, radii Rx x Ry) meeting in a top notch,
 * with the sides running from a tangent point on each lobe down to the bottom tip. `pinch` (0..1) deepens
 * the notch (measured on the real tool: pinch 0 / 0.5 / 1 give lobes of Ry 0.336 / 0.252 / 0.365 of the
 * height and a/Rx of 0.49 / 0.98 / 1). `curl` (-1..1) bows the sides: positive rounds the tail out like an
 * egg, negative flares it into a concave point.
 */
function heartPts(pinch: number, curl: number): Pt[] {
  const p = Math.max(0, Math.min(1, pinch))
  const c = Math.max(-1, Math.min(1, curl))
  const lerp = (u: number, v: number, t: number) => u + (v - u) * t
  const k = p <= 0.5 ? lerp(0.49, 0.98, p / 0.5) : lerp(0.98, 1, (p - 0.5) / 0.5)
  const ry = p <= 0.5 ? lerp(0.336, 0.252, p / 0.5) : lerp(0.252, 0.365, (p - 0.5) / 0.5)
  const rx = 1 / (1 + k) // half-width 1
  const a = rx * k
  const cy = ry
  const hh = 2 // box height in half-width units (a square box: width 2, height 2)
  const pt = (t: number): Pt => ({ x: a + rx * Math.cos(t), y: cy * hh + ry * hh * Math.sin(t) })
  // Tangent point from the bottom tip (0, hh): cross((P - B), P') = 0, searched on the lower right quarter.
  const B = { x: 0, y: hh }
  const f = (t: number) => {
    const P = pt(t)
    const dx = -rx * Math.sin(t)
    const dy = ry * hh * Math.cos(t)
    return (P.x - B.x) * dy - (P.y - B.y) * dx
  }
  let lo = 0
  let hi = Math.PI / 2
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (f(lo) * f(mid) <= 0) hi = mid
    else lo = mid
  }
  const tT = (lo + hi) / 2
  const tN = -(Math.PI - Math.acos(Math.min(1, a / rx)))
  const n = 64
  const T = pt(tT)
  const right: Pt[] = []
  for (let i = 0; i <= n; i++) right.push(pt(tT + ((tN - tT) * i) / n))
  // Side from the tip to the tangent point, bowed by `curl` with a quadratic control point.
  const mid = { x: (T.x + B.x) / 2, y: (T.y + B.y) / 2 }
  const side: Pt[] = []
  const m = 24
  if (c >= 0) {
    // Cubic from the tip with a horizontal tangent (round tail) to the tangent point, along the lobe tangent.
    const len = Math.hypot(T.x - B.x, T.y - B.y)
    const ux = (T.x - B.x) / len
    const uy = (T.y - B.y) / len
    const p1 = { x: B.x + c * T.x * 0.8, y: B.y }
    const p2 = { x: T.x - ux * c * len * 0.45, y: T.y - uy * c * len * 0.45 }
    for (let i = 0; i < m; i++) {
      const u = i / m
      const w = 1 - u
      side.push({
        x: w * w * w * B.x + 3 * w * w * u * p1.x + 3 * w * u * u * p2.x + u * u * u * T.x,
        y: w * w * w * B.y + 3 * w * w * u * p1.y + 3 * w * u * u * p2.y + u * u * u * T.y,
      })
    }
  } else {
    // Concave flare: quadratic with the control point pulled toward the axis.
    const q = { x: mid.x * (1 + c), y: mid.y }
    for (let i = 0; i < m; i++) {
      const u = i / m
      side.push({
        x: (1 - u) * (1 - u) * B.x + 2 * (1 - u) * u * q.x + u * u * T.x,
        y: (1 - u) * (1 - u) * B.y + 2 * (1 - u) * u * q.y + u * u * T.y,
      })
    }
  }
  const rightHalf = [...side, ...right] // tip -> tangent -> lobe -> notch
  const leftHalf = rightHalf
    .slice(1, -1)
    .reverse()
    .map((v) => ({ x: -v.x, y: v.y }))
  return fitTo(clean([...rightHalf, ...leftHalf]), 1, 1)
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
      prm('length', 'overall width', 'length', 50.8, 0, undefined, { adorn: 'O' }),
      prm('bellDiameter', 'bell diameter', 'length', 12.7, 0, undefined, { adorn: 'B' }),
      prm('barWidth', 'center height', 'length', 6.604, 0, undefined, { adorn: 'C' }),
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
      prm('width', 'width', 'length', 101.6, 0, undefined, { adorn: 'W' }),
      prm('height', 'height', 'length', 50.8, 0, undefined, { adorn: 'H' }),
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
      prm('size', 'outer diameter', 'length', 50.8, 0, undefined, { adorn: 'O' }),
      prm('innerDiameter', 'inner diameter', 'length', 25.4, 0, undefined, { adorn: 'I' }),
      prm('tipRadius', 'tip radius', 'length', 1.778, 0, undefined, { adorn: 'T' }),
    ],
    (g) => {
      const s = g('size')
      const inner = Math.min(1, Math.max(0.01, g('innerDiameter') / (s || 1)))
      return roundCorners(starOnCircle(Math.max(2, Math.round(g('points'))), s / 2, inner), g('tipRadius'))
    },
  ),

  tpl(
    'cornerRound',
    'Corner round',
    [
      prm('radius', 'radius', 'length', 25.4, 0, undefined, { adorn: 'R' }),
      prm('slotWidth', 'slot width', 'length', 7.62, 0, undefined, { adorn: 'S' }),
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
      prm('width', 'width', 'length', 38.1, 0, undefined, { adorn: 'W' }),
      prm('height', 'height', 'length', 19.05, 0, undefined, { adorn: 'H' }),
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
      prm('width', 'width', 'length', 76.2, 0, undefined, { adorn: 'W' }),
      prm('height', 'height', 'length', 76.2, 0, undefined, { adorn: 'H' }),
      prm('centerPinch', 'center pinch', 'slider', 0.5, 0, 1, { step: 0.05, marks: [0.5] }),
      // Studio draws this slider reversed: its left end is +1 (rounded tail), its right end -1 (flared point).
      prm('tailCurl', 'tail curl', 'slider', 0, -1, 1, { step: 0.05, marks: [0], reverse: true }),
      // Collapsed "radius +" row; rounds the tip and the notch (stored under 'r' like a rectangle's corner radius).
      prm('r', 'radius', 'length', 0, 0, undefined, { adorn: 'R', radiusRow: true }),
    ],
    (g) => {
      const sx = g('width')
      const sy = g('height')
      const pts = heartPts(g('centerPinch'), g('tailCurl')).map((p) => ({ x: p.x * sx, y: p.y * sy }))
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
      prm('slotLength', 'slot length', 'length', 8.89, 0, undefined, { adorn: 'S' }),
      prm('headDiameter', 'head diameter', 'length', 10.49, 0, undefined, { adorn: 'H' }),
      prm('slotWidth', 'neck diameter', 'length', 5, 0, undefined, { adorn: 'N' }),
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
      prm('diameter', 'hole diameter', 'length', 20, 0, undefined, { adorn: 'H' }),
      prm('countX', 'hole count x', 'count', 4, 1, 99),
      prm('countY', 'hole count y', 'count', 2, 1, 99),
      prm('spacing', 'spacing type', 'toggle', 0, undefined, undefined, { options: [{ v: 0, label: 'centers' }, { v: 1, label: 'edges' }] }),
      prm('distanceX', 'center distance x', 'length', 96, 0, undefined, { adorn: 'C', edgeLabel: 'edge distance x', edgeAdorn: 'E', edgeSub: 'diameter', showWhen: { key: 'countX', min: 2 } }),
      prm('distanceY', 'center distance y', 'length', 96, 0, undefined, { adorn: 'C', edgeLabel: 'edge distance y', edgeAdorn: 'E', edgeSub: 'diameter', showWhen: { key: 'countY', min: 2 } }),
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
      prm('width', 'rectangle width', 'length', 12.7, 0, undefined, { adorn: 'R' }),
      prm('height', 'rectangle height', 'length', 19.05, 0, undefined, { adorn: 'R' }),
      prm('countX', 'rectangle count x', 'count', 4, 1, 99),
      prm('countY', 'rectangle count y', 'count', 1, 1, 99),
      prm('spacing', 'spacing type', 'toggle', 0, undefined, undefined, { options: [{ v: 0, label: 'centers' }, { v: 1, label: 'edges' }] }),
      prm('distanceX', 'center distance x', 'length', 38.1, 0, undefined, { adorn: 'C', edgeLabel: 'edge distance x' }),
      prm('distanceY', 'center distance y', 'length', 38.1, 0, undefined, { adorn: 'C', edgeLabel: 'edge distance y', showWhen: { key: 'countY', min: 2 } }),
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
      prm('holeDiameter', 'hole diameter', 'length', 6.35, 0, undefined, { adorn: 'H' }),
      prm('boltDiameter', 'hole centers diameter', 'length', 127, 0, undefined, { adorn: 'H' }),
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
      prm('size', 'diameter', 'length', 76.2, 0, undefined, { adorn: 'D' }),
      prm('armWidth', 'branch width', 'length', 2.54, 0, undefined, { adorn: 'B' }),
      prm('branches', 'branches', 'count', 6, 1, 24),
      prm('radius', 'radius', 'length', 0, 0, undefined, { adorn: 'R' }),
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
      prm('size', 'outer diameter', 'length', 50.8, 0, undefined, { adorn: 'O' }),
      prm('innerDiameter', 'inner diameter', 'length', 25.4, 0, undefined, { adorn: 'I' }),
      prm('points', '# points', 'count', 5, 2, 16),
      prm('radius', 'radius', 'length', 0, 0, undefined, { adorn: 'R' }),
    ],
    (g) => {
      const s = g('size')
      const inner = Math.min(1, Math.max(0.01, g('innerDiameter') / (s || 1)))
      return roundCorners(starOnCircle(Math.max(2, Math.round(g('points'))), s / 2, inner), g('radius'))
    },
  ),
]
