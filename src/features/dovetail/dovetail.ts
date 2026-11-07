// Through dovetails cut on the end grain with Origin (board clamped upright, e.g. in the Workstation).
//
//  - Tail board: the dovetail bit, set to the pin board's thickness, cuts one full-depth pass across
//    the board's thickness per socket. Its flanks give the tails their angle. A dovetail bit cannot
//    plunge, so every pass starts and ends off the board.
//  - Pin board: a straight bit clears a tail-shaped pocket per tail, as deep as the tail board is thick.
//    The pockets run out past both faces, so the bit's radius never rounds a corner of the joint.
//
// Joint frame (mm): `a` across the board width (0..width), `c` along the tails from their end
// (c = 0, flush with the pin board's outer face) to the baseline (c = pinThick).
import type { Contour, FreeOrigin, Pt, Shape } from '../../model/types'
import { shapeFromWorld } from '../../model/factory'
import { bboxFraction, shapesBBox } from '../../geometry/transform'
import { BITS } from '../carve3d/bits'

export interface DovetailBit {
  /** Flank angle from the bit axis, degrees (a "15°" dovetail bit). */
  angle: number
  /** Cutting diameter at the tip (its widest point), mm. */
  diameter: number
  /** Cutting length, mm: the deepest the bit can cut. */
  fluteLength: number
}

export interface DovetailPreset {
  id: string
  name: string
  bit: DovetailBit
  /** Catalogue bit, when the preset is a real Shaper bit. */
  bitId?: string
}

const shaperBit = BITS.find((b) => b.subtype === 'dovetail')

/** The Shaper / Festool 15° dovetail bit (SF1-8-DC15, 8 mm shank) is the default. */
export const DOVETAIL_PRESETS: DovetailPreset[] = [
  {
    id: 'shaper-15',
    name: 'Shaper · Festool 15°',
    bit: { angle: shaperBit?.angle ?? 15, diameter: shaperBit?.diameter ?? 13.8, fluteLength: shaperBit?.fluteLength ?? 13.5 },
    bitId: shaperBit?.id,
  },
]
export const DEFAULT_PRESET = DOVETAIL_PRESETS[0]

export interface DovetailParams {
  bit: DovetailBit
  /** Board width, the same for both boards. */
  width: number
  /** Tail board thickness = depth of the pin board pockets. */
  tailThick: number
  /** Pin board thickness = tail length = dovetail bit depth. */
  pinThick: number
  /** Number of whole tails; the edges get half pins. */
  tails: number
  /** Pin width at its widest (the pin board's inside face). At least the bit diameter (one pass). */
  pinWidth: number
  /** Straight bit for the pin board, mm. */
  straightBit: number
  /** Glue gap: extra clearance on the pin board pockets, mm per side. */
  glueGap: number
}

/** A glue gap that slides together by hand with glue in it: 0.1 mm (about 0.004 in) per side. */
export const DEFAULT_GLUE_GAP = { mm: 0.1, in: 0.004 * 25.4 } as const

/** A pleasant tail count for a width: tails about twice as wide as the pins. */
export function autoTails(width: number, pinWidth: number): number {
  return Math.max(1, Math.round(width / (3 * pinWidth)))
}

/** Most tails that still leave room at their base for the straight bit. */
export function maxTails(p: Pick<DovetailParams, 'width' | 'pinWidth' | 'straightBit' | 'glueGap'>): number {
  return Math.max(1, Math.floor(p.width / (p.pinWidth + p.straightBit + 2 * p.glueGap + 0.5)))
}

const tanA = (p: DovetailParams) => Math.tan((p.bit.angle * Math.PI) / 180)

export interface DovetailLayout {
  /** Socket (pin) centres along a; the first and last sit on the board edges (half pins). */
  centres: number[]
  pitch: number
  /** Pin width at the tail ends (outer face of the pin board). */
  pinNarrow: number
  /** Tail widths at the baseline (narrow) and at the end (wide). */
  tailNarrow: number
  tailWide: number
  /** Each pin's cross-section in (a, c), clipped to the board. */
  pins: Pt[][]
  /** Each tail's cross-section in (a, c). */
  tails: Pt[][]
  /** Tail board face profile in (a, c) for c in [0, length]: tails at c = 0. */
  tailProfile: (length: number) => Pt[]
  warnings: string[]
}

export function dovetailLayout(p: DovetailParams): DovetailLayout {
  const n = Math.max(1, Math.round(p.tails))
  const W = p.width
  const pitch = W / n
  const t = tanA(p)
  const pw = p.pinWidth
  const pinNarrow = pw - 2 * p.pinThick * t
  const centres = Array.from({ length: n + 1 }, (_, k) => k * pitch)
  const tailNarrow = pitch - pw
  const tailWide = pitch - pinNarrow
  const clampA = (a: number) => Math.min(W, Math.max(0, a))

  const pins = centres.map((cx) => [
    { x: clampA(cx - pinNarrow / 2), y: 0 },
    { x: clampA(cx + pinNarrow / 2), y: 0 },
    { x: clampA(cx + pw / 2), y: p.pinThick },
    { x: clampA(cx - pw / 2), y: p.pinThick },
  ])
  const tails = centres.slice(0, -1).map((cx, k) => {
    const nx = centres[k + 1]
    return [
      { x: cx + pinNarrow / 2, y: 0 },
      { x: nx - pinNarrow / 2, y: 0 },
      { x: nx - pw / 2, y: p.pinThick },
      { x: cx + pw / 2, y: p.pinThick },
    ]
  })

  const tailProfile = (length: number): Pt[] => {
    const pts: Pt[] = [{ x: 0, y: length }, { x: 0, y: p.pinThick }]
    for (const tl of tails) pts.push(tl[3], tl[0], tl[1], tl[2])
    pts.push({ x: W, y: p.pinThick }, { x: W, y: length })
    return pts
  }

  const warnings: string[] = []
  if (p.pinThick > p.bit.fluteLength + 1e-9)
    warnings.push(`The pin board is thicker than the bit can cut (${+p.bit.fluteLength.toFixed(2)} mm). Use thinner stock or a longer bit.`)
  if (pinNarrow <= 0.5) warnings.push('The pins vanish at the outer face: the pin board is too thick for this bit angle.')
  if (tailNarrow <= 0) warnings.push('The pins overlap. Use fewer tails or narrower pins.')
  else if (tailNarrow < p.straightBit + 2 * p.glueGap - 1e-9)
    warnings.push('The tails are narrower at their base than the straight bit. Use fewer tails or a smaller bit.')
  return { centres, pitch, pinNarrow, tailNarrow, tailWide, pins, tails, tailProfile, warnings }
}

const rect = (x0: number, y0: number, x1: number, y1: number): Contour => ({
  closed: true,
  pts: [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ],
})

/** Gap between the two end-grain layouts on the canvas, mm. */
const LAYOUT_GAP = 20
/** How far cuts run past the board faces, beyond the bit radius, mm. */
const RUN_OUT = 3

export interface DovetailCut {
  /** World contours (mm, y down) for the tail board's end, then the pin board's end. */
  tail: { board: Contour; sockets: Contour[]; online: boolean }
  pin: { board: Contour; pockets: Contour[] }
  /** Top of the pin board layout on the canvas. */
  pinTop: number
}

/**
 * The two end-grain layouts, tail board above pin board. Canvas x runs across the board width,
 * canvas y across the thickness (outer face at the top).
 */
export function dovetailCuts(p: DovetailParams): DovetailCut {
  const L = dovetailLayout(p)
  const W = p.width
  const D = p.bit.diameter

  // Tail board: one pass per pin, entering and leaving off the board.
  const runT = D / 2 + RUN_OUT
  const online = p.pinWidth - D < 0.01
  const sockets: Contour[] = L.centres.map((cx) =>
    online
      ? { closed: false, pts: [{ x: cx, y: -runT }, { x: cx, y: p.tailThick + runT }] }
      : rect(cx - p.pinWidth / 2, -runT, cx + p.pinWidth / 2, p.tailThick + runT),
  )

  // Pin board: the tail shapes, run straight out past both faces.
  const top = p.tailThick + 2 * runT + LAYOUT_GAP
  const runP = p.straightBit / 2 + RUN_OUT
  const pockets: Contour[] = L.tails.map(([o0, o1, i1, i0]) => ({
    closed: true,
    pts: [
      { x: o0.x, y: top - runP },
      { x: o1.x, y: top - runP },
      { x: o1.x, y: top },
      { x: i1.x, y: top + p.pinThick },
      { x: i1.x, y: top + p.pinThick + runP },
      { x: i0.x, y: top + p.pinThick + runP },
      { x: i0.x, y: top + p.pinThick },
      { x: o0.x, y: top },
    ],
  }))

  return {
    tail: { board: rect(0, 0, W, p.tailThick), sockets, online },
    pin: { board: rect(0, top, W, top + p.pinThick), pockets },
    pinTop: top,
  }
}

/** One board's layout as it imports: its shapes and the group that holds them. */
export interface DovetailPart {
  /** The board's guide rectangle plus its cuts. */
  shapes: Omit<Shape, 'id'>[]
  /** The group's anchor (fractions of the group's bounds) on the guide rectangle's bottom-left corner. */
  anchor: FreeOrigin
}

/**
 * The two end-grain layouts as they import: one group per board (its guide rectangle with the cuts
 * that go with it), each group's anchor — its default custom anchor point — on the bottom-left
 * corner of the guide rectangle, so the board positions by its corner.
 */
export function dovetailParts(p: DovetailParams, bitId?: string): { tail: DovetailPart; pin: DovetailPart } {
  const c = dovetailCuts(p)
  const tail: Shape[] = [
    shapeFromWorld('rect', 'Tail board · end', [c.tail.board], {
      cut: { type: 'guide', depth: null, offset: 0, bitDia: p.bit.diameter },
      meta: { role: 'guide', note: 'Tail board end grain' },
    }),
    ...c.tail.sockets.map((s, i) =>
      shapeFromWorld('path', `Tail board · socket ${i + 1}`, [s], {
        cut: { type: c.tail.online ? 'online' : 'pocket', depth: p.pinThick, offset: 0, bitDia: p.bit.diameter },
        meta: { bitId, note: `Dovetail bit, one full-depth pass (${+p.pinThick.toFixed(2)} mm). Start off the board: a dovetail bit cannot plunge.` },
      }),
    ),
  ]
  const pin: Shape[] = [
    shapeFromWorld('rect', 'Pin board · end', [c.pin.board], {
      cut: { type: 'guide', depth: null, offset: 0, bitDia: p.straightBit },
      meta: { role: 'guide', note: 'Pin board end grain' },
    }),
    ...c.pin.pockets.map((s, i) =>
      shapeFromWorld('path', `Pin board · tail socket ${i + 1}`, [s], {
        cut: { type: 'pocket', depth: p.tailThick, offset: p.glueGap, bitDia: p.straightBit },
        meta: { note: `Straight bit, ${+p.tailThick.toFixed(2)} mm deep.` },
      }),
    ),
  ]
  // Bottom-left of a guide rectangle (y points down, so its largest y at its smallest x).
  const corner = (r: Contour): Pt => ({ x: Math.min(...r.pts.map((q) => q.x)), y: Math.max(...r.pts.map((q) => q.y)) })
  return {
    tail: { shapes: tail.map(({ id: _id, ...s }) => s), anchor: bboxFraction(shapesBBox(tail), corner(c.tail.board)) },
    pin: { shapes: pin.map(({ id: _id, ...s }) => s), anchor: bboxFraction(shapesBBox(pin), corner(c.pin.board)) },
  }
}
