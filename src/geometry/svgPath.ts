// SVG path data <-> contours. Parses the full path grammar (M L H V C S Q T A Z,
// absolute and relative) and flattens curves to polylines.
import type { Contour, Pt } from '../model/types'

/** Max chord deviation when flattening curves, in the path's own units. */
const DEFAULT_TOL = 0.05

/**
 * Character scanner for path data. Numbers are read with a regex at the cursor;
 * arc flags are read as exactly one '0' or '1' character so compact forms such
 * as "a5 5 0 011 5" parse correctly.
 */
class Scanner {
  i = 0
  readonly s: string
  constructor(s: string) {
    this.s = s
  }
  private sep() {
    while (this.i < this.s.length && /[\s,]/.test(this.s[this.i])) this.i++
  }
  eof(): boolean {
    this.sep()
    return this.i >= this.s.length
  }
  /** Next command letter, or null if the next token is not a letter. */
  cmd(): string | null {
    this.sep()
    const ch = this.s[this.i]
    if (ch && /[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) {
      this.i++
      return ch
    }
    return null
  }
  num(): number | null {
    this.sep()
    const re = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/y
    re.lastIndex = this.i
    const m = re.exec(this.s)
    if (!m) return null
    this.i = re.lastIndex
    return parseFloat(m[0])
  }
  flag(): boolean | null {
    this.sep()
    const ch = this.s[this.i]
    if (ch !== '0' && ch !== '1') return null
    this.i++
    return ch === '1'
  }
}

export function segCount(len: number, tol: number) {
  return Math.max(2, Math.min(256, Math.ceil(Math.sqrt(len / Math.max(tol, 1e-6)) * 1.2)))
}

export function cubic(out: Pt[], p0: Pt, p1: Pt, p2: Pt, p3: Pt, tol: number) {
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y) + Math.hypot(p3.x - p2.x, p3.y - p2.y)
  const n = segCount(len, tol)
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    })
  }
}

function quad(out: Pt[], p0: Pt, p1: Pt, p2: Pt, tol: number) {
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y)
  const n = segCount(len, tol)
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    out.push({ x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y })
  }
}

/** An elliptical arc in centre form: angles in radians, `phi` the x-axis rotation. Null when it is a straight line. */
export interface ArcCentre {
  cx: number
  cy: number
  rx: number
  ry: number
  phi: number
  t1: number
  dt: number
}

/** SVG endpoint arc parameters to centre form (SVG 1.1 implementation notes F.6.5, with radius correction). */
export function arcCentre(p0: Pt, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, p: Pt): ArcCentre | null {
  if (rx === 0 || ry === 0 || (p0.x === p.x && p0.y === p.y)) return null
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  const phi = (phiDeg * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (p0.x - p.x) / 2
  const dy = (p0.y - p.y) / 2
  const x1 = cos * dx + sin * dy
  const y1 = -sin * dx + cos * dy
  let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (lambda > 1) {
    lambda = Math.sqrt(lambda)
    rx *= lambda
    ry *= lambda
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1
  let f = Math.sqrt(Math.max(0, num / den))
  if (large === sweep) f = -f
  const cx1 = (f * rx * y1) / ry
  const cy1 = (-f * ry * x1) / rx
  const cx = cos * cx1 - sin * cy1 + (p0.x + p.x) / 2
  const cy = sin * cx1 + cos * cy1 + (p0.y + p.y) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
  if (!sweep && dt > 0) dt -= 2 * Math.PI
  if (sweep && dt < 0) dt += 2 * Math.PI
  return { cx, cy, rx, ry, phi, t1, dt }
}

/** A point on a centre-form arc at angle t. */
export function arcPoint(a: ArcCentre, t: number): Pt {
  const ex = a.rx * Math.cos(t)
  const ey = a.ry * Math.sin(t)
  const cos = Math.cos(a.phi)
  const sin = Math.sin(a.phi)
  return { x: cos * ex - sin * ey + a.cx, y: sin * ex + cos * ey + a.cy }
}

function arc(out: Pt[], p0: Pt, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, p: Pt, tol: number) {
  const a = arcCentre(p0, rx, ry, phiDeg, large, sweep, p)
  if (!a) {
    out.push(p)
    return
  }
  const n = segCount(Math.abs(a.dt) * Math.max(a.rx, a.ry), tol)
  for (let i = 1; i <= n; i++) out.push(arcPoint(a, a.t1 + (a.dt * i) / n))
}

/**
 * One drawing command of SVG path data in absolute coordinates, with the shorthand forms (H V S T, relative
 * commands, implicit repeats) resolved. Quadratics stay quadratics and arcs stay arcs: nothing is approximated.
 */
export type PathOp =
  | { op: 'M'; p: Pt }
  | { op: 'L'; p: Pt }
  | { op: 'C'; p1: Pt; p2: Pt; p: Pt }
  | { op: 'Q'; p1: Pt; p: Pt }
  | { op: 'A'; rx: number; ry: number; phi: number; large: boolean; sweep: boolean; p: Pt }
  | { op: 'Z' }

/** Read SVG path data into absolute drawing commands. Stops at the first malformed token. */
export function pathOps(d: string): PathOp[] {
  const sc = new Scanner(d)
  const ops: PathOp[] = []
  let pos: Pt = { x: 0, y: 0 }
  let start: Pt = { x: 0, y: 0 }
  let lastCtrl: Pt | null = null
  let lastCmd = ''
  let cmd = ''
  outer: while (!sc.eof()) {
    const letter = sc.cmd()
    if (letter) cmd = letter
    else if (!cmd) break
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    const ox = rel ? pos.x : 0
    const oy = rel ? pos.y : 0
    // Reads n numbers; returns null when the data is malformed.
    const nums = (n: number): number[] | null => {
      const out: number[] = []
      for (let k = 0; k < n; k++) {
        const v = sc.num()
        if (v == null) return null
        out.push(v)
      }
      return out
    }
    switch (C) {
      case 'M': {
        const a = nums(2)
        if (!a) break outer
        pos = { x: ox + a[0], y: oy + a[1] }
        start = pos
        ops.push({ op: 'M', p: pos })
        cmd = rel ? 'l' : 'L'
        lastCtrl = null
        break
      }
      case 'L': {
        const a = nums(2)
        if (!a) break outer
        pos = { x: ox + a[0], y: oy + a[1] }
        ops.push({ op: 'L', p: pos })
        lastCtrl = null
        break
      }
      case 'H': {
        const a = nums(1)
        if (!a) break outer
        pos = { x: ox + a[0], y: pos.y }
        ops.push({ op: 'L', p: pos })
        lastCtrl = null
        break
      }
      case 'V': {
        const a = nums(1)
        if (!a) break outer
        pos = { x: pos.x, y: oy + a[0] }
        ops.push({ op: 'L', p: pos })
        lastCtrl = null
        break
      }
      case 'C': {
        const a = nums(6)
        if (!a) break outer
        const p1 = { x: ox + a[0], y: oy + a[1] }
        const p2 = { x: ox + a[2], y: oy + a[3] }
        const p3 = { x: ox + a[4], y: oy + a[5] }
        ops.push({ op: 'C', p1, p2, p: p3 })
        lastCtrl = p2
        pos = p3
        break
      }
      case 'S': {
        const a = nums(4)
        if (!a) break outer
        const p1: Pt = lastCtrl && /[CS]/.test(lastCmd) ? { x: 2 * pos.x - lastCtrl.x, y: 2 * pos.y - lastCtrl.y } : pos
        const p2 = { x: ox + a[0], y: oy + a[1] }
        const p3 = { x: ox + a[2], y: oy + a[3] }
        ops.push({ op: 'C', p1, p2, p: p3 })
        lastCtrl = p2
        pos = p3
        break
      }
      case 'Q': {
        const a = nums(4)
        if (!a) break outer
        const p1 = { x: ox + a[0], y: oy + a[1] }
        const p2 = { x: ox + a[2], y: oy + a[3] }
        ops.push({ op: 'Q', p1, p: p2 })
        lastCtrl = p1
        pos = p2
        break
      }
      case 'T': {
        const a = nums(2)
        if (!a) break outer
        const p1: Pt = lastCtrl && /[QT]/.test(lastCmd) ? { x: 2 * pos.x - lastCtrl.x, y: 2 * pos.y - lastCtrl.y } : pos
        const p2 = { x: ox + a[0], y: oy + a[1] }
        ops.push({ op: 'Q', p1, p: p2 })
        lastCtrl = p1
        pos = p2
        break
      }
      case 'A': {
        const a = nums(3)
        if (!a) break outer
        const large = sc.flag()
        if (large == null) break outer
        const sweep = sc.flag()
        if (sweep == null) break outer
        const e = nums(2)
        if (!e) break outer
        const p = { x: ox + e[0], y: oy + e[1] }
        ops.push({ op: 'A', rx: a[0], ry: a[1], phi: a[2], large, sweep, p })
        pos = p
        lastCtrl = null
        break
      }
      case 'Z':
        ops.push({ op: 'Z' })
        // After Z the current point is the subpath start; implicit segments
        // that follow start a new subpath from there.
        pos = start
        lastCtrl = null
        // Z takes no arguments: stray numbers after it are malformed.
        cmd = ''
        break
      default:
        break outer
    }
    lastCmd = C
  }
  return ops
}

/** Parse SVG path data into flattened contours. Stops at the first malformed token. */
export function parsePathD(d: string, tol = DEFAULT_TOL): Contour[] {
  const contours: Contour[] = []
  let cur: Pt[] = []
  let pos: Pt = { x: 0, y: 0 }
  let start: Pt = { x: 0, y: 0 }
  const ensure = () => {
    if (!cur.length) cur.push(pos)
  }
  const flush = (closed: boolean) => {
    if (cur.length > 1) contours.push({ pts: dedupe(cur, closed), closed })
    cur = []
  }
  for (const o of pathOps(d)) {
    switch (o.op) {
      case 'M':
        flush(false)
        pos = start = o.p
        cur = [pos]
        break
      case 'L':
        ensure()
        cur.push(o.p)
        pos = o.p
        break
      case 'C':
        ensure()
        cubic(cur, pos, o.p1, o.p2, o.p, tol)
        pos = o.p
        break
      case 'Q':
        ensure()
        quad(cur, pos, o.p1, o.p, tol)
        pos = o.p
        break
      case 'A':
        ensure()
        arc(cur, pos, o.rx, o.ry, o.phi, o.large, o.sweep, o.p, tol)
        pos = o.p
        break
      case 'Z':
        flush(true)
        pos = start
        cur = [start]
        break
    }
  }
  flush(false)
  return contours
}

function dedupe(pts: Pt[], closed: boolean): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    const q = out[out.length - 1]
    if (!q || Math.abs(q.x - p.x) > 1e-7 || Math.abs(q.y - p.y) > 1e-7) out.push(p)
  }
  if (closed && out.length > 2) {
    const a = out[0]
    const b = out[out.length - 1]
    if (Math.abs(a.x - b.x) < 1e-7 && Math.abs(a.y - b.y) < 1e-7) out.pop()
  }
  return out
}

const fmt = (n: number) => {
  const s = n.toFixed(3)
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

/** Contours to SVG path data. */
export function contoursToD(cs: Contour[]): string {
  return cs
    .filter((c) => c.pts.length > 1)
    .map((c) => 'M' + c.pts.map((p) => fmt(p.x) + ' ' + fmt(p.y)).join('L') + (c.closed ? 'Z' : ''))
    .join('')
}
