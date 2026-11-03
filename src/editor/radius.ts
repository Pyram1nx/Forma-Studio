// Corner radius helpers shared by the radius field and the Custom Radius view.
import type { Shape, ShapeKind, Units } from '../model/types'
import { MM_PER_IN } from '../model/types'
import { cornerRadii } from './shapeFactory'

/** Shapes with corners the Custom Radius view can round one at a time. */
export const VERTEX_KINDS: ShapeKind[] = ['rect', 'polygon', 'triangle']

/** Fractions of an inch, as the radius field offers them (Studio's order). */
export const RADIUS_PRESETS: { label: string; inches: number }[] = [
  { label: '1⁄16', inches: 1 / 16 },
  { label: '1⁄8', inches: 1 / 8 },
  { label: '3⁄16', inches: 3 / 16 },
  { label: '1⁄4', inches: 1 / 4 },
  { label: '3⁄8', inches: 3 / 8 },
  { label: '1⁄2', inches: 1 / 2 },
]

/** The Custom Radius view offers a shorter row of the same fractions. */
export const VIEW_RADIUS_PRESETS = RADIUS_PRESETS.filter((p) => [1 / 16, 1 / 8, 1 / 4, 1 / 2].includes(p.inches))

/** Preset label in the design's units (mm designs show the same radius in millimetres). */
export function presetLabel(p: { label: string; inches: number }, units: Units): string {
  return units === 'in' ? p.label : String(+(p.inches * MM_PER_IN).toFixed(1))
}

/** Number of corners a vertex shape has. */
export function vertexCount(s: Shape): number {
  if (s.kind === 'rect') return 4
  if (s.kind === 'triangle') return 3
  return Math.max(3, Number(s.params?.n ?? 5))
}

/** Radius of every corner in mm; for other shapes the single uniform radius. */
export function radiusValues(s: Shape): number[] {
  if (!VERTEX_KINDS.includes(s.kind)) return [Number(s.params?.r ?? 0)]
  return cornerRadii(s.params ?? {}, vertexCount(s))
}

/** True when the corners do not all share one radius. */
export function isMixed(vals: number[]): boolean {
  return vals.some((v) => Math.abs(v - vals[0]) > 1e-6)
}
