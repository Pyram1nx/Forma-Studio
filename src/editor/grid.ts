import type { StudioDoc } from '../model/types'
import { MM_PER_IN } from '../model/types'

/** Grid spacing in mm: the saved one, else 1 in or 10 mm by the document units. */
export function gridSizeMm(doc: StudioDoc): number {
  const g = doc.settings.gridSize
  return g && g > 0 ? g : doc.units === 'in' ? MM_PER_IN : 10
}

/** The grid is drawn while Position is on and Show grid is switched on. */
export const gridShown = (doc: StudioDoc) => doc.settings.showPosition && doc.settings.showGrid === true
export const gridSnaps = (doc: StudioDoc) => doc.settings.showPosition && doc.settings.snapToGrid === true
export const labelsShown = (doc: StudioDoc) => doc.settings.showPosition && doc.settings.positionLabels === true

/**
 * Shaper's grid magnet: any of the given edges/anchor coordinates, once moved by `delta`, that lands within `tol`
 * of a grid line is pulled onto it; the closest one wins. Returns the extra shift and the line it landed on.
 */
export function snapToGridLines(coords: number[], delta: number, gs: number, tol: number): { shift: number; at: number } | null {
  let best: { shift: number; at: number; d: number } | null = null
  for (const c of coords) {
    const m = c + delta
    for (const k of [0, -1, 1]) {
      const at = (Math.floor(m / gs) + k) * gs
      const d = Math.abs(at - m)
      if (d < tol && (!best || d <= best.d)) best = { shift: at - m, at, d }
    }
  }
  return best && { shift: best.shift, at: best.at }
}
