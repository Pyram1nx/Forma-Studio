// Shaper Trace frame detection from its dots. The frame is a black band whose
// white dots (two sizes) sit on one centre line running parallel to every
// edge: a rounded-rectangle "track" around the capture window. The dots stay
// visible when the drawing, a hand or an object covers the window's edge, at
// steep angles and on dark or busy desks, so they — not the black band — are
// what the frame is found by:
//
//   1. Dots: bright, small, round blobs on dark (white top-hat, then shape and
//      surround tests on each blob).
//   2. Track: the four straight rows of dots, found by RANSAC on the dot
//      centres (the rounded corners and stray bright bits are outliers).
//   3. Perspective: the four rows meet at the track's virtual corners, which
//      give a first homography frame -> photo.
//   4. Scale from the dots: the dots sit on slots of a 9 mm grid along each
//      row. Every dot found is snapped to its slot and the homography is
//      solved again by least squares over all of them (~70 points), so the
//      size of the scan comes from the dot spacing itself — not from the
//      white window, whose edge the eye (and a camera) easily misjudges.
//   5. Parallax: the dots are on top of the frame, the drawing under it. The
//      camera pose comes from that homography, and the drawing's plane is
//      taken FRAME_HEIGHT_MM below the dots.
//   6. The scan is Shaper's 263 x 173 mm capture area, centred in the track:
//      only the inside of the frame shows, sized by the dots.
import { morph } from './morph'
import { estimateAspect, longShort } from './paperSize'

/**
 * The dot layout, measured from photos of the frame. Dots sit on slots of a
 * DOT_PITCH grid: a long row has slots 0..LONG_SLOTS starting LONG_MARGIN
 * from the track's (virtual, sharp) corner, a short row 0..SHORT_SLOTS
 * starting SHORT_MARGIN in. Which slots hold a big dot, a small one or none
 * is the frame's code. Self-calibrated on seven photos (rows straight, dots
 * one pitch apart, row spacing and slot offsets solved with the
 * perspective): the track is 33.57 x 23.70 pitches.
 */
export const DOT_PITCH = 9
const LONG_SLOTS = 30
const SHORT_SLOTS = 21
const LONG_MARGIN = 1.785 * DOT_PITCH
const SHORT_MARGIN = 1.35 * DOT_PITCH
export const TRACK_LONG = LONG_SLOTS * DOT_PITCH + 2 * LONG_MARGIN
export const TRACK_SHORT = SHORT_SLOTS * DOT_PITCH + 2 * SHORT_MARGIN

/** Shaper's capture area (mm), centred in the track. */
export const CAPTURE_LONG = 263
export const CAPTURE_SHORT = 173

/**
 * Height of the dots above the drawing (mm), corrected for as parallax. The
 * frame is thin (about 1 mm), and Shaper's own measurement of a reference
 * drawing (a glove, 88.17 x 146.16 mm) is matched best with no offset at
 * all — 88.49 x 146.22 here — so the correction is off, kept for tuning.
 */
export const FRAME_HEIGHT_MM = 0

/** Dots along a long / short row of the frame (the code repeats exactly). */
const DOTS_LONG = 21
const DOTS_SHORT = 14.5

export interface Dot {
  x: number
  y: number
  /** Equivalent radius (px). */
  r: number
  /** Contrast of the dot against its dark surround (gray levels). */
  contrast: number
  /** Mean brightness of the dot. */
  v: number
}

/** Bright-on-dark round blobs in a grayscale image (w x h). `maxR` bounds the dot radius in px. */
export function findDots(gray: Uint8Array, w: number, h: number, maxR: number): Dot[] {
  // White top-hat: what an opening of radius maxR removes = bright features
  // smaller than the dots' upper size. Paper, walls and the window are wider
  // and vanish.
  const open = morph(morph(gray, w, h, maxR, false), w, h, maxR, true)
  const th = new Uint8Array(w * h)
  const hist = new Uint32Array(256)
  for (let i = 0; i < th.length; i++) {
    th[i] = gray[i] - open[i]
    hist[th[i]]++
  }
  let acc = 0
  let p999 = 255
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= th.length * 0.999) {
      p999 = v
      break
    }
  }
  const T = Math.max(18, Math.round(0.3 * p999))

  // Connected components of th > T (8-connected), with moments.
  const lab = new Int32Array(w * h)
  const stack = new Int32Array(w * h)
  const dots: Dot[] = []
  let next = 0
  for (let s = 0; s < th.length; s++) {
    if (th[s] <= T || lab[s]) continue
    next++
    let sp = 0
    stack[sp++] = s
    lab[s] = next
    let n = 0
    let sw = 0
    let sx = 0
    let sy = 0
    let ux = 0
    let uy = 0
    let sxx = 0
    let syy = 0
    let sxy = 0
    let x0 = w
    let x1 = 0
    let y0 = h
    let y1 = 0
    let bright = 0
    let tooBig = false
    while (sp > 0) {
      const p = stack[--sp]
      const x = p % w
      const y = (p - x) / w
      const wt = th[p]
      n++
      sw += wt
      sx += wt * x
      sy += wt * y
      ux += x
      uy += y
      sxx += x * x
      syy += y * y
      sxy += x * y
      bright += gray[p]
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (n > 4 * maxR * maxR * 4) tooBig = true
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          const q = yy * w + xx
          if (th[q] > T && !lab[q]) {
            lab[q] = next
            stack[sp++] = q
          }
        }
      }
    }
    if (tooBig || n < 3) continue
    const bw = x1 - x0 + 1
    const bh = y1 - y0 + 1
    if (bw > 2.4 * maxR || bh > 2.4 * maxR) continue
    // Shape: a dot seen in perspective is an ellipse — fills ~pi/4 of its box
    // and is not much longer than wide.
    const fill = n / (bw * bh)
    if (n >= 8 && fill < 0.5) continue
    // Elongation from the second moments about the (unweighted) centroid.
    const meanX = ux / n
    const meanY = uy / n
    const cxx = sxx / n - meanX * meanX
    const cyy = syy / n - meanY * meanY
    const cxy = sxy / n - meanX * meanY
    const tr = cxx + cyy
    const det = cxx * cyy - cxy * cxy
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det))
    const l1 = tr / 2 + disc
    const l2 = Math.max(1e-6, tr / 2 - disc)
    if (n >= 8 && l1 / l2 > 12) continue
    const r = Math.sqrt(n / Math.PI)
    const cx = sx / sw
    const cy = sy / sw
    // Surround: an annulus well outside the dot must be dark, and darker than
    // the dot by a clear margin (the frame is black; the dots are white).
    let ring = 0
    let rn = 0
    const r1 = Math.max(2, 1.7 * r + 1)
    const r2 = r1 + Math.max(1.5, 0.8 * r)
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2
      for (const rr of [r1, r2]) {
        const X = Math.round(cx + Math.cos(a) * rr)
        const Y = Math.round(cy + Math.sin(a) * rr)
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue
        ring += gray[Y * w + X]
        rn++
      }
    }
    if (rn < 16) continue
    ring /= rn
    const mean = bright / n
    if (mean - ring < 28 || ring > 0.72 * mean) continue
    dots.push({ x: cx, y: cy, r, contrast: mean - ring, v: mean })
  }
  return dots
}


/* ------------------------------------------------------------------ */
/* Dot rows -> the track quad                                          */
/* ------------------------------------------------------------------ */

/** A straight row of frame dots: a line (point + unit direction) and its dots. */
export interface DotRow {
  px: number
  py: number
  dx: number
  dy: number
  dots: Dot[]
}

/** Total-least-squares line through points. */
function fitLine(pts: { x: number; y: number }[]): { px: number; py: number; dx: number; dy: number } {
  let mx = 0
  let my = 0
  for (const p of pts) {
    mx += p.x
    my += p.y
  }
  mx /= pts.length
  my /= pts.length
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const p of pts) {
    sxx += (p.x - mx) ** 2
    sxy += (p.x - mx) * (p.y - my)
    syy += (p.y - my) ** 2
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  return { px: mx, py: my, dx: Math.cos(th), dy: Math.sin(th) }
}

const median = (v: number[]) => {
  const s = v.slice().sort((a, b) => a - b)
  return s.length ? s[s.length >> 1] : 0
}

/**
 * The dots of `dots` within `tol` of the line, as the longest run along it
 * with no gap wider than `gapMax` (rows on the frame are dense; a line that
 * merely grazes scattered blobs is not).
 */
function runOnLine(
  dots: Dot[],
  l: { px: number; py: number; dx: number; dy: number },
  tol: number,
  gapMax: number,
  img?: { gray: Uint8Array; w: number; h: number },
): Dot[] {
  const on: { d: Dot; t: number }[] = []
  for (const d of dots) {
    const e = Math.abs((d.x - l.px) * l.dy - (d.y - l.py) * l.dx)
    if (e <= tol) on.push({ d, t: (d.x - l.px) * l.dx + (d.y - l.py) * l.dy })
  }
  on.sort((a, b) => a.t - b.t)
  let best: Dot[] = []
  let cur: Dot[] = []
  for (let i = 0; i < on.length; i++) {
    if (i > 0 && (on[i].t - on[i - 1].t > gapMax || (img && !darkGap(on[i - 1].d, on[i].d, img)))) cur = []
    cur.push(on[i].d)
    if (cur.length > best.length) best = cur.slice()
  }
  return best
}

/**
 * Between two dots of one row lies the frame's black band: the darkest of a
 * few samples along the gap must be well below both dots. A row that runs off
 * the frame onto paper, a mat or a desk is cut there.
 */
function darkGap(a: Dot, b: Dot, img: { gray: Uint8Array; w: number; h: number }): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  const free = len - a.r - b.r
  if (free < 2) return true
  const ux = (b.x - a.x) / len
  const uy = (b.y - a.y) / len
  let worst = 0
  const n = Math.max(2, Math.min(12, Math.round(free / 3)))
  for (let k = 1; k < n; k++) {
    const s = a.r + 1 + ((free - 2) * k) / n
    const X = Math.round(a.x + ux * s)
    const Y = Math.round(a.y + uy * s)
    if (X < 0 || Y < 0 || X >= img.w || Y >= img.h) return false
    worst = Math.max(worst, img.gray[Y * img.w + X])
  }
  return worst < 0.6 * Math.min(a.v, b.v)
}

/**
 * Is the band between neighbouring dots of a row dark? On the frame it is
 * black plastic; a row of look-alikes (a cutting mat's printed grid, a
 * pattern on cloth) usually is not.
 */
function darkBetween(row: Dot[], l: { dx: number; dy: number }, gray: Uint8Array, w: number, h: number): boolean {
  const ts = row.map((d) => ({ d, t: d.x * l.dx + d.y * l.dy })).sort((a, b) => a.t - b.t)
  const mids: number[] = []
  for (let i = 1; i < ts.length; i++) {
    const a = ts[i - 1].d
    const b = ts[i].d
    const gap = Math.hypot(b.x - a.x, b.y - a.y) - a.r - b.r
    if (gap < 3) continue
    const X = Math.round((a.x + a.r * (b.x - a.x) / (gap + a.r + b.r) + b.x - b.r * (b.x - a.x) / (gap + a.r + b.r)) / 2)
    const Y = Math.round((a.y + a.r * (b.y - a.y) / (gap + a.r + b.r) + b.y - b.r * (b.y - a.y) / (gap + a.r + b.r)) / 2)
    if (X >= 0 && Y >= 0 && X < w && Y < h) mids.push(gray[Y * w + X])
  }
  if (mids.length < 2) return true
  const bright = median(row.map((d) => d.contrast))
  // Between-dot level vs. the dots' own contrast above their surround.
  return median(mids) < 0.5 * (bright + median(mids))
}

/**
 * Every row of the Trace frame mixes big and small dots (the pattern is a
 * code). A grid of identical printed dots — a cutting mat, a perforated
 * sheet — does not.
 */
function twoSizes(row: Dot[]): boolean {
  const r = row.map((d) => d.r).sort((a, b) => a - b)
  const small = r[Math.floor(r.length * 0.25)]
  // At least two dots clearly bigger than the small ones (however few there are).
  return r.filter((v) => v >= 1.3 * small).length >= Math.max(2, Math.round(0.08 * r.length))
}

/** How dark a row's surround is next to its dots: ~0.85 on the black frame, ~0.6 on a grey mat. */
function contrastRatio(row: Dot[]): number {
  return median(row.map((d) => d.contrast / Math.max(1, d.v)))
}

/**
 * Straight rows of dots, strongest first. Each round, every dot and its
 * nearest neighbours vote for the line through them (angle, offset); only the
 * most-voted lines are measured properly — the longest dense, dark-gapped run
 * of dots along them, weighted by how black the dots' surround is (a printed
 * grid on a grey mat runs long but sits on grey). The winner is refitted and
 * its dots removed.
 */
export function findRows(dots: Dot[], gray: Uint8Array, w: number, h: number, maxRows = 16): DotRow[] {
  let pool = dots.slice()
  const rows: DotRow[] = []
  // Tolerances scale with the dots being tested, not the whole image: a
  // cutting mat's tiny printed dots must not set the frame's spacing.
  const img = { gray, w, h }
  const tolOf = (r: number) => Math.max(1.5, 1.3 * r)
  const gapOf = (r: number) => Math.max(12, 18 * r)
  const runScore = (run: Dot[]) => Math.min(run.length, Math.round(DOTS_LONG * 1.25)) * contrastRatio(run) ** 3
  for (let round = 0; round < 40 && rows.length < maxRows && pool.length >= 5; round++) {
    // Grid index for neighbour search.
    const cell = Math.max(8, 4 * median(pool.map((d) => d.r)))
    const grid = new Map<number, Dot[]>()
    const key = (cx: number, cy: number) => cx * 73856093 + cy * 19349663
    for (const d of pool) {
      const k = key(Math.floor(d.x / cell), Math.floor(d.y / cell))
      const list = grid.get(k)
      if (list) list.push(d)
      else grid.set(k, [d])
    }
    // Votes: (angle 1 deg, offset ~ dot radius) -> count and a line.
    const votes = new Map<string, { n: number; a: Dot; b: Dot; rr: number }>()
    const K = 6
    for (const a of pool) {
      const reach = gapOf(a.r)
      const cr = Math.ceil(reach / cell)
      const cx0 = Math.floor(a.x / cell)
      const cy0 = Math.floor(a.y / cell)
      const near: { b: Dot; d: number }[] = []
      for (let gy = -cr; gy <= cr; gy++)
        for (let gx = -cr; gx <= cr; gx++) {
          const list = grid.get(key(cx0 + gx, cy0 + gy))
          if (!list) continue
          for (const b of list) {
            if (b === a) continue
            const d = Math.hypot(b.x - a.x, b.y - a.y)
            if (d <= reach) near.push({ b, d })
          }
        }
      near.sort((p, q) => p.d - q.d)
      for (const { b, d } of near.slice(0, K)) {
        const rr = Math.max(a.r, b.r)
        if (d < 1.5 * rr) continue
        let th = Math.atan2(b.y - a.y, b.x - a.x)
        if (th < 0) th += Math.PI
        if (th >= Math.PI) th -= Math.PI
        const nx = -Math.sin(th)
        const ny = Math.cos(th)
        const rho = a.x * nx + a.y * ny
        const kk = `${Math.round((th * 180) / Math.PI) % 180}|${Math.round(rho / Math.max(2, rr))}`
        const v = votes.get(kk)
        if (v) v.n++
        else votes.set(kk, { n: 1, a, b, rr })
      }
    }
    const top = [...votes.values()].sort((p, q) => q.n - p.n).slice(0, 48)
    let best: Dot[] = []
    let bestScore = 0
    let bestR = 0
    for (const { a, b, rr } of top) {
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      const run = runOnLine(pool, { px: a.x, py: a.y, dx: (b.x - a.x) / len, dy: (b.y - a.y) / len }, tolOf(rr), gapOf(rr), img)
      if (run.length < 5) continue
      const sc = runScore(run)
      if (sc > bestScore) {
        bestScore = sc
        best = run
        bestR = rr
      }
    }
    if (best.length < 5) break
    const rMed = Math.max(bestR, median(best.map((d) => d.r)))
    const tol = tolOf(rMed)
    const gapMax = gapOf(rMed)
    // Refit on the run, then take the run again on the refined line.
    let l = fitLine(best)
    const run = runOnLine(pool, l, tol, gapMax, img)
    if (run.length >= best.length) {
      l = fitLine(run)
      best = run
    }
    const used = new Set(best)
    pool = pool.filter((d) => !used.has(d))
    if (darkBetween(best, l, gray, w, h) && twoSizes(best)) rows.push({ ...l, dots: best })
  }
  return rows
}

export interface TrackFit {
  /** Virtual sharp corners of the dot track, TL TR BR BL, in image px. */
  quad: { x: number; y: number }[]
  /** The four rows, in quad side order (top, right, bottom, left). */
  sides: DotRow[]
  /** Dots that support the fit. */
  support: number
}

/** Corners in TL TR BR BL order (min x+y first, clockwise on screen). */
function order4(q: { x: number; y: number }[]): { x: number; y: number }[] {
  const cx = q.reduce((s, p) => s + p.x, 0) / 4
  const cy = q.reduce((s, p) => s + p.y, 0) / 4
  const o = q.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
  let st = 0
  for (let i = 1; i < 4; i++) if (o[i].x + o[i].y < o[st].x + o[st].y) st = i
  return [0, 1, 2, 3].map((k) => o[(st + k) % 4])
}

const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

function meet(a: DotRow, b: DotRow): { x: number; y: number } | null {
  const det = a.dx * b.dy - a.dy * b.dx
  if (Math.abs(det) < 1e-6) return null
  const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / det
  return { x: a.px + a.dx * t, y: a.py + a.dy * t }
}

/**
 * The four rows that close into the frame's track: a convex quad whose every
 * side carries its row's dots (they lie within the side, spread along it).
 * Best by dots supported, times how evenly the four sides are covered.
 */
export function fitTrack(rows: DotRow[], w: number, h: number): TrackFit | null {
  let best: TrackFit | null = null
  let bestScore = 0
  const n = rows.length
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++) {
          const L = [rows[a], rows[b], rows[c], rows[d]]
          for (const order of [[0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3]]) {
            const S = order.map((i) => L[i])
            const q: { x: number; y: number }[] = []
            for (let e = 0; e < 4; e++) {
              const p = meet(S[e], S[(e + 1) % 4])
              if (!p) break
              q.push(p)
            }
            if (q.length < 4) continue
            // q[e] is the corner between side e and side e+1, so side e runs q[e-1] -> q[e].
            let pos = 0
            let neg = 0
            for (let e = 0; e < 4; e++) {
              const z = cross(q[e], q[(e + 1) % 4], q[(e + 2) % 4])
              if (z > 0) pos++
              else if (z < 0) neg++
            }
            if (pos !== 4 && neg !== 4) continue
            let ok = true
            let cover = 1
            let support = 0
            for (let e = 0; e < 4 && ok; e++) {
              const A = q[(e + 3) % 4]
              const B = q[e]
              const len = Math.hypot(B.x - A.x, B.y - A.y)
              if (len < 10) {
                ok = false
                break
              }
              const ux = (B.x - A.x) / len
              const uy = (B.y - A.y) / len
              const ts = S[e].dots.map((dd) => ((dd.x - A.x) * ux + (dd.y - A.y) * uy) / len)
              // Dots must lie on the side itself (a little past the corner is
              // fine: the track's corners are rounded inside the virtual ones).
              if (ts.some((t) => t < -0.08 || t > 1.08)) {
                ok = false
                break
              }
              const span = Math.max(...ts) - Math.min(...ts)
              cover = Math.min(cover, span)
              support += S[e].dots.length
            }
            if (!ok || cover < 0.15) continue
            // Interior angles of a photographed rectangle stay well clear of 0 / 180.
            for (let e = 0; e < 4 && ok; e++) {
              const p = q[e]
              const u = q[(e + 3) % 4]
              const v = q[(e + 1) % 4]
              const cos = ((u.x - p.x) * (v.x - p.x) + (u.y - p.y) * (v.y - p.y)) / (Math.hypot(u.x - p.x, u.y - p.y) * Math.hypot(v.x - p.x, v.y - p.y))
              if (Math.abs(cos) > 0.85) ok = false
            }
            if (!ok) continue
            // How frame-like: true proportions (perspective removed) close to
            // the track's 1.42, and no side with far more dots than a frame
            // row has (a mat's printed grid runs on and on).
            const a = longShort(estimateAspect(order4(q), w, h).ratio)
            const prior = 0.1 + 0.9 * Math.exp(-(((a / (TRACK_LONG / TRACK_SHORT) - 1) / 0.08) ** 2))
            const most = Math.max(...S.map((r) => r.dots.length))
            const countOk = most <= DOTS_LONG * 1.25 ? 1 : 0.25
            // Black plastic around the dots, on all four sides.
            const dark = Math.min(...S.map((r) => contrastRatio(r.dots))) ** 3
            const score = Math.min(support, 2 * (DOTS_LONG + DOTS_SHORT)) * Math.sqrt(cover) * prior * countOk * dark
            if (score > bestScore) {
              bestScore = score
              // Corner between sides e and e+1 -> order sides so quad is TL TR BR BL later.
              best = { quad: q, sides: S, support }
            }
          }
        }
  if (!best) return null
  // Order corners TL TR BR BL (min x+y first, clockwise on screen) and the
  // sides to match: side k runs corner k -> corner k+1.
  const cx = best.quad.reduce((s, p) => s + p.x, 0) / 4
  const cy = best.quad.reduce((s, p) => s + p.y, 0) / 4
  const idx = [0, 1, 2, 3].sort((i, j) => Math.atan2(best!.quad[i].y - cy, best!.quad[i].x - cx) - Math.atan2(best!.quad[j].y - cy, best!.quad[j].x - cx))
  let start = 0
  for (let i = 1; i < 4; i++) if (best.quad[idx[i]].x + best.quad[idx[i]].y < best.quad[idx[start]].x + best.quad[idx[start]].y) start = i
  const corners = [0, 1, 2, 3].map((k) => idx[(start + k) % 4])
  const quad = corners.map((i) => best!.quad[i])
  // Side between corners i and j of the original: corner e joins sides e and e+1,
  // so the side shared by corners e and e+1 (cyclic) is side e+1.
  const sides = [0, 1, 2, 3].map((k) => {
    const i = corners[k]
    const j = corners[(k + 1) % 4]
    const shared = (i + 1) % 4 === j ? (i + 1) % 4 : i
    return best!.sides[shared]
  })
  return { quad, sides, support: best.support }
}

/* ------------------------------------------------------------------ */
/* Whole pipeline                                                       */
/* ------------------------------------------------------------------ */

export interface TraceFrameResult {
  /** Capture window corners TL TR BR BL in photo px, on the drawing's plane. */
  window: { x: number; y: number }[]
  /** Dot track corners TL TR BR BL in photo px (the dots' plane). */
  track: { x: number; y: number }[]
  /** True when the window's long side runs TL -> TR. */
  landscape: boolean
  /** Dots supporting the first fit. */
  support: number
  /** Dots snapped to slots for the final fit, and their RMS reprojection error (photo px). */
  slotted: number
  rms: number
  /**
   * Snapped dots that look like the frame's own (white on its black band).
   * Candidates are compared on this: a cutting mat's printed grid is close
   * to the frame's 9 mm pitch, and its dots would snap too.
   */
  good: number
  /**
   * Every dot of the final fit and its slot: `u, v` in track mm (this
   * orientation), `x, y` in photo px. Many frames' worth of these calibrate
   * the camera's lens (lens.ts).
   */
  pairs: SlotPair[]
}

export interface SlotPair {
  u: number
  v: number
  x: number
  y: number
}

/**
 * Find a Shaper Trace frame by its dots and return its capture window. Tries
 * a working copy with long side `maxSide`, then smaller ones (dots near the
 * detection threshold — glare, blur — often show at another scale), down to
 * 560 px, below which the dots get too small to tell apart.
 */
/** Frame geometry overrides (calibration experiments). */
export interface FrameGeometry {
  pitch?: number
  heightMm?: number
}

export function detectTraceFrame(
  rgba: Uint8ClampedArray | Uint8Array,
  W: number,
  H: number,
  maxSide = 1600,
  geo: FrameGeometry = {},
): TraceFrameResult | null {
  const long = Math.max(W, H)
  const sizes: number[] = []
  for (let side = Math.min(maxSide, long); side >= 560 || sizes.length === 0; side = Math.round(side * 0.7)) {
    sizes.push(side)
    if (side < 800) break
  }
  for (const side of sizes) {
    const r = detectAt(rgba, W, H, side, geo)
    if (r) return r
  }
  return null
}

/** Gray working copy (box-downsampled, long side <= maxSide) and its scale. */
function workGray(rgba: Uint8ClampedArray | Uint8Array, W: number, H: number, maxSide: number) {
  const k = Math.min(1, maxSide / Math.max(W, H))
  const w = Math.max(2, Math.round(W * k))
  const h = Math.max(2, Math.round(H * k))
  const gray = new Uint8Array(w * h)
  const step = 1 / k
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * step)
    const sy1 = Math.min(H, Math.max(sy0 + 1, Math.floor((y + 1) * step)))
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * step)
      const sx1 = Math.min(W, Math.max(sx0 + 1, Math.floor((x + 1) * step)))
      let s = 0
      let n = 0
      for (let sy = sy0; sy < sy1; sy++)
        for (let sx = sx0; sx < sx1; sx++) {
          const j = (sy * W + sx) * 4
          s += rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29
          n++
        }
      gray[y * w + x] = n ? s / n / 256 : 0
    }
  }
  // Back to photo pixels (box-downsample: pixel centres shift by half a pixel).
  const toPhoto = (p: { x: number; y: number }) => ({ x: (p.x + 0.5) / k - 0.5, y: (p.y + 0.5) / k - 0.5 })
  return { gray, w, h, k, toPhoto }
}

/** The track rectangle (mm) for an orientation and pitch scale. */
function trackRect(landscape: boolean, sc: number) {
  const tw = (landscape ? TRACK_LONG : TRACK_SHORT) * sc
  const th = (landscape ? TRACK_SHORT : TRACK_LONG) * sc
  return {
    tw,
    th,
    rect: [
      { x: 0, y: 0 },
      { x: tw, y: 0 },
      { x: tw, y: th },
      { x: 0, y: th },
    ],
  }
}

/**
 * From a first homography (track mm -> photo px): snap every dot to its slot
 * and solve again from all of them, drop to the drawing's plane, and map the
 * capture window. The size comes from the dots on their 9 mm grid.
 */
function finishFrame(
  first: number[],
  dots: { x: number; y: number; r: number; c?: number }[],
  landscape: boolean,
  W: number,
  H: number,
  geo: FrameGeometry,
  support: number,
): TraceFrameResult {
  const sc = (geo.pitch ?? DOT_PITCH) / DOT_PITCH
  const { tw, th, rect } = trackRect(landscape, sc)
  const refined = refineBySlots(first, dots, landscape, sc)
  const Hm = refined?.H ?? first
  // The drawing's plane, FRAME_HEIGHT_MM below the dots.
  const Hp = dropPlane(Hm, W, H, geo.heightMm ?? FRAME_HEIGHT_MM) ?? Hm
  const ex = (tw - (landscape ? CAPTURE_LONG : CAPTURE_SHORT) * sc) / 2
  const ey = (th - (landscape ? CAPTURE_SHORT : CAPTURE_LONG) * sc) / 2
  const window = [
    { x: ex, y: ey },
    { x: tw - ex, y: ey },
    { x: tw - ex, y: th - ey },
    { x: ex, y: th - ey },
  ].map((p) => project(Hp, p))
  return {
    window,
    track: rect.map((p) => project(Hm, p)),
    landscape,
    support,
    slotted: refined?.n ?? 0,
    good: refined?.good ?? 0,
    rms: refined?.rms ?? NaN,
    pairs: refined?.pairs ?? [],
  }
}

function detectAt(rgba: Uint8ClampedArray | Uint8Array, W: number, H: number, maxSide: number, geo: FrameGeometry): TraceFrameResult | null {
  const { gray, w, h, k, toPhoto } = workGray(rgba, W, H, maxSide)
  const maxR = Math.max(4, Math.round(0.012 * Math.max(w, h)))
  const dots = findDots(gray, w, h, maxR)
  // First the dots on a properly black surround (the frame's band): a busy
  // desk can hold thousands of look-alikes on grey that would drown them.
  // Stepped down: far-side dots of a steeply tilted frame are small and
  // softer, and glare can grey the band, so a little less contrast is
  // allowed before everything is.
  let fit: TrackFit | null = null
  let tried = -1
  for (const cut of [0.7, 0.6, 0.5, 0]) {
    const set = cut ? dots.filter((d) => d.contrast / Math.max(1, d.v) >= cut) : dots
    if (set.length < 20 || set.length === tried) continue
    tried = set.length
    fit = fitTrack(findRows(set, gray, w, h), w, h)
    if (fit) break
  }
  if (!fit) return null
  const sc = (geo.pitch ?? DOT_PITCH) / DOT_PITCH
  // Orientation hint: the long rows carry ~21 dots, the short ~14.5 (the
  // dots' snapping decides; this only breaks a tie).
  const tb = fit.sides[0].dots.length + fit.sides[2].dots.length
  const lr = fit.sides[1].dots.length + fit.sides[3].dots.length
  const share = tb / (tb + lr)
  const byCount = share > 0.56 ? true : share < 0.44 ? false : null
  const track = fit.quad.map(toPhoto)
  const all = dots.map((d) => ({ ...toPhoto(d), r: d.r / k, c: d.contrast / Math.max(1, d.v) }))
  const prefer = byCount ?? estimateAspect(track, W, H).ratio >= 1
  // Two ways to the final frame, the dots on their grid judging:
  //   - straight from the four rows found;
  //   - with every side first re-placed from the dots near it — this rescues
  //     a partial row (a sheen greys part of a row out of the first pass and
  //     a corner dot tilts what is left), but can be pulled by a dotted desk.
  // Whichever lets more dots snap to their slots wins.
  const [land, port] = [true, false].map((l) => finishFrame(homography(trackRect(l, sc).rect, track), all, l, W, H, geo, fit.support))
  const direct = pickOrientation(land, port, prefer)
  const replaced = frameFromGuess(track, all, W, H, geo, prefer)
  return replaced.good > direct.good * 1.1 ? { ...replaced, support: fit.support } : direct
}

/** The better-snapped of two finishes (a clear margin), else the preferred orientation. */
function pickOrientation(land: TraceFrameResult, port: TraceFrameResult, preferLandscape: boolean): TraceFrameResult {
  if (Math.max(land.good, port.good) >= 12) {
    if (land.good > port.good * 1.15) return land
    if (port.good > land.good * 1.15) return port
  }
  return preferLandscape ? land : port
}

/**
 * The frame from a rough idea of where its dot track is (corners dragged by
 * hand, or the live camera's last lock), TL TR BR BL in photo px. The dots
 * near each guessed side re-place that side, then every dot snaps to its
 * slot: the result has the frame's true proportions and the dots' scale
 * however roughly the corners were put down. Without dots nearby, the track
 * is taken as given — still with the frame's proportions, never the white
 * window's.
 */
export function traceFrameFromTrack(
  rgba: Uint8ClampedArray | Uint8Array,
  W: number,
  H: number,
  guess: { x: number; y: number }[],
  maxSide = 1600,
  geo: FrameGeometry = {},
): TraceFrameResult {
  const { gray, w, h, k, toPhoto } = workGray(rgba, W, H, maxSide)
  const maxR = Math.max(4, Math.round(0.012 * Math.max(w, h)))
  const dots = findDots(gray, w, h, maxR).map((d) => ({ ...toPhoto(d), r: d.r / k, c: d.contrast / Math.max(1, d.v) }))
  return frameFromGuess(guess, dots, W, H, geo, estimateAspect(guess, W, H).ratio >= 1)
}

/**
 * The frame from a rough track (photo px) and the dots. The corners may lie
 * on the dot rows, on the white opening (~15.5 mm inside them), on the
 * capture window, or on the frame's outer edge (~17.5 mm outside) — and
 * either way round. For each reading every side is re-placed from the dots
 * near it (twice, so it settles), then the dots snap to their slots; the
 * reading whose dots snap best wins, which also settles the orientation.
 */
function frameFromGuess(
  guess: { x: number; y: number }[],
  dots: { x: number; y: number; r: number; c: number }[],
  W: number,
  H: number,
  geo: FrameGeometry,
  preferLandscape: boolean,
): TraceFrameResult {
  const sc = (geo.pitch ?? DOT_PITCH) / DOT_PITCH
  const bestOf = (landscape: boolean) => {
    const { tw, th, rect } = trackRect(landscape, sc)
    const ex = (tw - (landscape ? CAPTURE_LONG : CAPTURE_SHORT) * sc) / 2
    const ey = (th - (landscape ? CAPTURE_SHORT : CAPTURE_LONG) * sc) / 2
    const inset = (dx: number, dy: number) => [
      { x: dx, y: dy },
      { x: tw - dx, y: dy },
      { x: tw - dx, y: th - dy },
      { x: dx, y: th - dy },
    ]
    const readings = [rect, inset(15.5 * sc, 15.5 * sc), inset(ex, ey), inset(-17.5 * sc, -17.5 * sc)]
    let best: TraceFrameResult | null = null
    for (const r of readings) {
      const H0 = resnapSides(homography(r, guess), dots, tw, th, rect, sc, 22)
      const res = finishFrame(H0, dots, landscape, W, H, geo, 0)
      if (!best || res.good > best.good || (res.good === best.good && res.rms < best.rms)) best = res
    }
    return best!
  }
  return pickOrientation(bestOf(true), bestOf(false), preferLandscape)
}

/**
 * Re-place each side of the track from the dots within `band` mm of it
 * (robust line fit, dots on black preferred) and return the
 * homography through the new corners; the guess as is where a side has too
 * few dots.
 */
function resnapSides(
  H0: number[],
  dots: { x: number; y: number; c: number }[],
  tw: number,
  th: number,
  rect: { x: number; y: number }[],
  sc: number,
  band: number,
): number[] {
  const inv = invert3(H0)
  if (!inv) return H0
  const P = dots.map((d) => ({ d, p: project(inv, d) }))
  const reach = band * sc
  const sides = [
    P.filter((q) => Math.abs(q.p.y) < reach && q.p.x > -reach && q.p.x < tw + reach),
    P.filter((q) => Math.abs(q.p.x - tw) < reach && q.p.y > -reach && q.p.y < th + reach),
    P.filter((q) => Math.abs(q.p.y - th) < reach && q.p.x > -reach && q.p.x < tw + reach),
    P.filter((q) => Math.abs(q.p.x) < reach && q.p.y > -reach && q.p.y < th + reach),
  ].map((set) => {
    // Prefer dots on black; drop ones off the line, refit.
    let pts: { x: number; y: number }[] = set.filter((q) => q.d.c >= 0.5).map((q) => q.d)
    if (pts.length < 4) pts = set.map((q) => q.d)
    if (pts.length < 4) return null
    let l = fitLine(pts)
    for (let it = 0; it < 2; it++) {
      const res = pts.map((q) => Math.abs((q.x - l.px) * l.dy - (q.y - l.py) * l.dx))
      const cut = Math.max(2, 2.5 * median(res))
      const kept = pts.filter((_, i) => res[i] <= cut)
      if (kept.length < 4) break
      pts = kept
      l = fitLine(pts)
    }
    return { ...l, dots: [] as Dot[] }
  })
  if (!sides.every((x) => x)) return H0
  const q = [0, 1, 2, 3].map((e) => meet(sides[(e + 3) % 4]!, sides[e]!))
  return q.every((x) => x) ? homography(rect, q as { x: number; y: number }[]) : H0
}

/**
 * The capture window inside a dot track (TL TR BR BL, photo px) by the
 * frame's geometry alone — no dots looked at. For drawing the window while
 * the track is being dragged.
 */
export function captureFromTrack(
  track: { x: number; y: number }[],
  W: number,
  H: number,
  orientation?: boolean,
): { x: number; y: number }[] {
  // Pass the orientation the dots decided; the proportions are only a guess.
  const landscape = orientation ?? estimateAspect(track, W, H).ratio >= 1
  const { tw, th, rect } = trackRect(landscape, 1)
  const Hm = homography(rect, track)
  const ex = (tw - (landscape ? CAPTURE_LONG : CAPTURE_SHORT)) / 2
  const ey = (th - (landscape ? CAPTURE_SHORT : CAPTURE_LONG)) / 2
  return [
    { x: ex, y: ey },
    { x: tw - ex, y: ey },
    { x: tw - ex, y: th - ey },
    { x: ex, y: th - ey },
  ].map((p) => project(Hm, p))
}

/** A starting dot track for manual placement: the frame's proportions, centred, ~80% of the photo. */
export function defaultTrack(W: number, H: number): { x: number; y: number }[] {
  const landscape = W >= H
  const a = TRACK_LONG / TRACK_SHORT
  let tw = W * 0.8
  let th = landscape ? tw / a : tw * a
  if (th > H * 0.8) {
    th = H * 0.8
    tw = landscape ? th * a : th / a
  }
  const x0 = (W - tw) / 2
  const y0 = (H - th) / 2
  return [
    { x: x0, y: y0 },
    { x: x0 + tw, y: y0 },
    { x: x0 + tw, y: y0 + th },
    { x: x0, y: y0 + th },
  ]
}

/** Slot centres of the track (mm, origin at the track's corner), for an orientation. */
export function slotPoints(landscape: boolean, sc = 1): { x: number; y: number }[] {
  const tw = (landscape ? TRACK_LONG : TRACK_SHORT) * sc
  const th = (landscape ? TRACK_SHORT : TRACK_LONG) * sc
  const out: { x: number; y: number }[] = []
  const row = (long: boolean, at: (t: number) => { x: number; y: number }) => {
    const m = (long ? LONG_MARGIN : SHORT_MARGIN) * sc
    const n = long ? LONG_SLOTS : SHORT_SLOTS
    for (let k = 0; k <= n; k++) out.push(at(m + k * DOT_PITCH * sc))
  }
  row(landscape, (t) => ({ x: t, y: 0 }))
  row(landscape, (t) => ({ x: t, y: th }))
  row(!landscape, (t) => ({ x: 0, y: t }))
  row(!landscape, (t) => ({ x: tw, y: t }))
  return out
}

/**
 * Snap every dot to the nearest slot of the track (through the current
 * homography) and solve the homography again by least squares over all the
 * pairs; three rounds, dropping pairs that do not fit. The scale then comes
 * from ~70 dots on a 9 mm grid instead of four virtual corners.
 */
function refineBySlots(
  H0: number[],
  dots: { x: number; y: number; r: number; c?: number }[],
  landscape: boolean,
  sc = 1,
): { H: number[]; n: number; rms: number; good: number; pairs: SlotPair[] } | null {
  const slots = slotPoints(landscape, sc)
  let Hm = H0
  let best: { H: number[]; n: number; rms: number; good: number; pairs: SlotPair[] } | null = null
  for (let round = 0; round < 3; round++) {
    const inv = invert3(Hm)
    if (!inv) return best
    const src: { x: number; y: number }[] = []
    const dst: { x: number; y: number; c?: number }[] = []
    const used = new Set<number>()
    for (const d of dots) {
      const p = project(inv, d)
      let bi = -1
      let bd = Infinity
      for (let i = 0; i < slots.length; i++) {
        const dd = (slots[i].x - p.x) ** 2 + (slots[i].y - p.y) ** 2
        if (dd < bd) {
          bd = dd
          bi = i
        }
      }
      // Within a third of a pitch of its slot, one dot per slot.
      if (bi < 0 || bd > (0.33 * DOT_PITCH) ** 2 || used.has(bi)) continue
      used.add(bi)
      src.push(slots[bi])
      dst.push(d)
    }
    if (src.length < 12) return best
    let H1 = homographyLS(src, dst)
    if (!H1) return best
    // Drop pairs far off the fit, and refit.
    const err = src.map((s, i) => {
      const q = project(H1!, s)
      return Math.hypot(q.x - dst[i].x, q.y - dst[i].y)
    })
    const med = err.slice().sort((a, b) => a - b)[err.length >> 1]
    const keep = err.map((e) => e <= Math.max(1.5, 3 * med))
    const s2 = src.filter((_, i) => keep[i])
    const d2 = dst.filter((_, i) => keep[i])
    if (s2.length >= 12) H1 = homographyLS(s2, d2) ?? H1
    const e2 = s2.map((s, i) => {
      const q = project(H1!, s)
      return Math.hypot(q.x - d2[i].x, q.y - d2[i].y)
    })
    const rms = Math.sqrt(e2.reduce((a, b) => a + b * b, 0) / e2.length)
    Hm = H1
    best = {
      H: H1,
      n: s2.length,
      rms,
      good: d2.filter((d) => (d.c ?? 1) >= 0.6).length,
      pairs: s2.map((s, i) => ({ u: s.x, v: s.y, x: d2[i].x, y: d2[i].y })),
    }
  }
  return best
}

/** Least-squares homography src -> dst over N >= 4 pairs (normalised DLT, h33 = 1). */
export function homographyLS(src: { x: number; y: number }[], dst: { x: number; y: number }[]): number[] | null {
  // Normalise both point sets (centroid at 0, mean distance sqrt(2)).
  const norm = (pts: { x: number; y: number }[]) => {
    const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length
    const my = pts.reduce((a, p) => a + p.y, 0) / pts.length
    const md = pts.reduce((a, p) => a + Math.hypot(p.x - mx, p.y - my), 0) / pts.length || 1
    const s = Math.SQRT2 / md
    return { T: [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1], f: (p: { x: number; y: number }) => ({ x: s * (p.x - mx), y: s * (p.y - my) }) }
  }
  const ns = norm(src)
  const nd = norm(dst)
  // Normal equations for the 8 unknowns.
  const M = Array.from({ length: 8 }, () => new Array<number>(9).fill(0))
  for (let i = 0; i < src.length; i++) {
    const a = ns.f(src[i])
    const b = nd.f(dst[i])
    const rows = [
      [a.x, a.y, 1, 0, 0, 0, -b.x * a.x, -b.x * a.y, b.x],
      [0, 0, 0, a.x, a.y, 1, -b.y * a.x, -b.y * a.y, b.y],
    ]
    for (const r of rows)
      for (let p = 0; p < 8; p++) {
        if (!r[p]) continue
        for (let q = 0; q < 9; q++) M[p][q] += r[p] * r[q]
      }
  }
  for (let c = 0; c < 8; c++) {
    let piv = c
    for (let r = c + 1; r < 8; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r
    if (Math.abs(M[piv][c]) < 1e-12) return null
    ;[M[c], M[piv]] = [M[piv], M[c]]
    for (let r = c + 1; r < 8; r++) {
      const f = M[r][c] / M[c][c]
      for (let q = c; q < 9; q++) M[r][q] -= f * M[c][q]
    }
  }
  const h = new Array<number>(8).fill(0)
  for (let r = 7; r >= 0; r--) {
    let v = M[r][8]
    for (let q = r + 1; q < 8; q++) v -= M[r][q] * h[q]
    h[r] = v / M[r][r]
  }
  // Undo the normalisation: H = Td^-1 * Hn * Ts.
  const Hn = [...h, 1]
  const Tdi = invert3(nd.T)
  if (!Tdi) return null
  const out = mul3(mul3(Tdi, Hn), ns.T)
  return out.map((v) => v / out[8])
}

function mul3(a: number[], b: number[]): number[] {
  const o = new Array<number>(9).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]
  return o
}

export function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-15) return null
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det)
}

/**
 * The homography for a plane `drop` mm below the one `Hm` maps (frame mm ->
 * photo px). The camera pose comes from Hm with the principal point at the
 * photo centre and the focal length that makes the plane's axes orthogonal
 * (a typical phone lens when that is not measurable). Null if degenerate.
 */
function dropPlane(Hm: number[], W: number, H: number, drop: number): number[] | null {
  if (!drop) return Hm
  const cx = W / 2
  const cy = H / 2
  // Columns of Hm with the principal point removed: m_j = (h0j - cx h2j, h1j - cy h2j, h2j).
  const col = (j: number) => [Hm[j] - cx * Hm[6 + j], Hm[3 + j] - cy * Hm[6 + j], Hm[6 + j]]
  const c1 = col(0)
  const c2 = col(1)
  const c3 = col(2)
  // Orthogonality of r1, r2: (c1x c2x + c1y c2y) / f^2 + c1z c2z = 0.
  let f = 0.75 * Math.max(W, H)
  const den = c1[2] * c2[2]
  if (Math.abs(den) > 1e-18) {
    const f2 = -(c1[0] * c2[0] + c1[1] * c2[1]) / den
    if (f2 > 0) {
      const ff = Math.sqrt(f2)
      if (ff > 0.35 * Math.max(W, H) && ff < 4 * Math.max(W, H)) f = ff
    }
  }
  const unK = (c: number[]) => [c[0] / f, c[1] / f, c[2]]
  const r1 = unK(c1)
  const r2 = unK(c2)
  const t = unK(c3)
  const l = 2 / (Math.hypot(...r1) + Math.hypot(...r2))
  for (const v of [r1, r2, t]) for (let i = 0; i < 3; i++) v[i] *= l
  let r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]]
  const n3 = Math.hypot(...r3)
  if (!n3) return null
  r3 = r3.map((v) => v / n3)
  // "Below" the dots is away from the camera: along the viewing direction.
  if (r3[0] * t[0] + r3[1] * t[1] + r3[2] * t[2] < 0) r3 = r3.map((v) => -v)
  const t2 = [t[0] + drop * r3[0], t[1] + drop * r3[1], t[2] + drop * r3[2]]
  // Back to pixels: K [r1 r2 t2].
  const K = (v: number[]) => [f * v[0] + cx * v[2], f * v[1] + cy * v[2], v[2]]
  const k1 = K(r1)
  const k2 = K(r2)
  const k3 = K(t2)
  const out = [k1[0], k2[0], k3[0], k1[1], k2[1], k3[1], k1[2], k2[2], k3[2]]
  return out.map((v) => v / out[8])
}

/** 3x3 homography src -> dst from four point pairs (row-major, h33 = 1). */
function homography(src: { x: number; y: number }[], dst: { x: number; y: number }[]): number[] {
  const A: number[][] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: u, y: v } = dst[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < 8; c++) {
    let p = c
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    ;[A[c], A[p]] = [A[p], A[c]]
    for (let r = c + 1; r < 8; r++) {
      const f = A[r][c] / A[c][c]
      for (let j = c; j <= 8; j++) A[r][j] -= f * A[c][j]
    }
  }
  const x = new Array<number>(8).fill(0)
  for (let r = 7; r >= 0; r--) {
    let s = A[r][8]
    for (let j = r + 1; j < 8; j++) s -= A[r][j] * x[j]
    x[r] = s / A[r][r]
  }
  return [...x, 1]
}

export function project(Hm: number[], p: { x: number; y: number }): { x: number; y: number } {
  const d = Hm[6] * p.x + Hm[7] * p.y + Hm[8]
  return { x: (Hm[0] * p.x + Hm[1] * p.y + Hm[2]) / d, y: (Hm[3] * p.x + Hm[4] * p.y + Hm[5]) / d }
}
