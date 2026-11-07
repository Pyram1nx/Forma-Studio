// Memoised derived geometry per shape object (shapes are immutable, so the
// object identity is a perfect cache key).
import type { Contour, Shape } from '../model/types'
import { worldContours, bboxOfContours, toWorld, type BBox } from '../geometry/transform'
import { contoursToD } from '../geometry/svgPath'
import { penOf, penToD } from '../geometry/pen'
import { computeCutGeometry, type CutGeometry } from './canvas/canvasMath'

const worldCache = new WeakMap<Shape, Contour[]>()
const bboxCache = new WeakMap<Shape, BBox>()
const dCache = new WeakMap<Shape, string>()
const cutCache = new WeakMap<Shape, CutGeometry>()

export function world(s: Shape): Contour[] {
  let w = worldCache.get(s)
  if (!w) {
    w = worldContours(s)
    worldCache.set(s, w)
  }
  return w
}

export function wbbox(s: Shape): BBox {
  let b = bboxCache.get(s)
  if (!b) {
    b = bboxOfContours(world(s))
    bboxCache.set(s, b)
  }
  return b
}

export function worldD(s: Shape): string {
  let d = dCache.get(s)
  if (d === undefined) {
    // Shapes with true curves draw them (an affine map keeps a Bézier exact), so they stay smooth at any zoom.
    const pen = penOf(s)
    d = pen ? penToD(pen, (p) => toWorld(s, p)) : contoursToD(world(s))
    dCache.set(s, d)
  }
  return d
}

/** Synchronous, cached tool-centre path and swept region for a shape. */
export function cutGeometry(s: Shape): CutGeometry {
  let g = cutCache.get(s)
  if (!g) {
    g = computeCutGeometry(world(s), s.cut)
    cutCache.set(s, g)
  }
  return g
}

// ---- lazy, frame-budgeted computation -------------------------------------
// Offsetting hundreds of shapes in one go froze the UI on entering Plan mode.
// Render paths call requestCut(): it returns the cached geometry, or queues the
// shape and returns undefined. The queue drains a few ms per animation frame and
// notifies subscribers once per batch so the canvas can re-render the bands.

const FRAME_BUDGET_MS = 8
const queue: Shape[] = []
let head = 0
const queued = new WeakSet<Shape>()
let frame = 0
const listeners = new Set<() => void>()

export function subscribeCut(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function requestCut(s: Shape): CutGeometry | undefined {
  const g = cutCache.get(s)
  if (g) return g
  if (!queued.has(s)) {
    queued.add(s)
    queue.push(s)
    schedule()
  }
  return undefined
}

function schedule() {
  if (frame || typeof requestAnimationFrame === 'undefined') {
    if (!frame && typeof requestAnimationFrame === 'undefined') {
      // No rAF (tests / SSR): drain synchronously.
      while (head < queue.length) {
        const s = queue[head++]
        cutGeometry(s)
        queued.delete(s)
      }
      queue.length = 0
      head = 0
    }
    return
  }
  frame = requestAnimationFrame(pump)
}

function pump() {
  frame = 0
  const t0 = performance.now()
  let did = 0
  while (head < queue.length && (did === 0 || performance.now() - t0 < FRAME_BUDGET_MS)) {
    const s = queue[head++]
    queued.delete(s)
    cutGeometry(s)
    did++
  }
  if (head >= queue.length) {
    queue.length = 0
    head = 0
  }
  if (did) for (const fn of listeners) fn()
  if (head < queue.length) schedule()
}
