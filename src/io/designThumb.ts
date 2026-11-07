// Design previews in Shaper Studio's style: every shape as a blue outline over a
// translucent blue fill (so overlaps read darker), fitted with a small margin.
// This is a picture of the design as drawn, not the cut file: no offsets, no cut colours.
import { contoursToD } from '../geometry/svgPath'
import { mapPen, penOf, penToD } from '../geometry/pen'
import { penBounds } from '../geometry/curves'
import { bboxOfContours, bboxValid, emptyBBox, toWorld, worldContours } from '../geometry/transform'
import { loadRecent } from './projectFile'

const STROKE = '#2c65ff'
const FILL = 'rgba(44, 101, 255, 0.1)'
/** Outline width in screen pixels, whatever size the preview is drawn at. */
const STROKE_PX = 1.25
/** Space around the design, as a share of its larger side. */
const MARGIN = 0.05

const n = (v: number) => +v.toFixed(3)

/** A saved design as a Studio-style preview, as an SVG data URL. Null when it is empty or unreadable. */
export function designThumb(id: string): string | null {
  try {
    const doc = loadRecent(id)
    const shapes = doc?.shapes.filter((s) => !s.hidden) ?? []
    if (!shapes.length) return null

    const b = emptyBBox()
    const paths: string[] = []
    for (const s of shapes) {
      const cs = worldContours(s)
      bboxOfContours(cs, b)
      const pen = penOf(s)
      let d: string
      if (pen) {
        const world = mapPen(pen, (p) => toWorld(s, p))
        const pb = penBounds(world)
        b.minX = Math.min(b.minX, pb.minX)
        b.minY = Math.min(b.minY, pb.minY)
        b.maxX = Math.max(b.maxX, pb.maxX)
        b.maxY = Math.max(b.maxY, pb.maxY)
        d = penToD(world)
      } else d = contoursToD(cs)
      if (!d) continue
      // Open paths have no inside to tint.
      const fill = cs.some((c) => c.closed) ? FILL : 'none'
      paths.push(`<path d="${d}" fill="${fill}" fill-rule="evenodd"/>`)
    }
    if (!paths.length || !bboxValid(b)) return null

    const w = Math.max(b.maxX - b.minX, 1e-3)
    const h = Math.max(b.maxY - b.minY, 1e-3)
    const m = Math.max(w, h) * MARGIN
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(b.minX - m)} ${n(b.minY - m)} ${n(w + 2 * m)} ${n(h + 2 * m)}">` +
      `<g stroke="${STROKE}" stroke-width="${STROKE_PX}" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke">` +
      paths.map((p) => p.replace('<path ', '<path vector-effect="non-scaling-stroke" ')).join('') +
      `</g></svg>`
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  } catch {
    return null
  }
}
