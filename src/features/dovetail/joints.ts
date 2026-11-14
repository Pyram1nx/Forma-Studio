// The Joinery tool's joints, in one shape: each joint becomes two board solids for the 3D view,
// two cut layouts for the design, a cut card and its warnings.
//
//  - Dovetail:  through dovetails cut on the end grain with a dovetail bit (./dovetail).
//  - Fine pin:  through dovetails with straight bits only. The tail board lies flat and its sockets
//               are cut through it from the face, so the pins can be as fine as the smallest bit;
//               the pin board stands upright and a straight bit clears around the pins.
//  - Knapp:     the pin-and-cove drawer joint. Dowels are milled on the drawer front's end grain;
//               the drawer side gets half-round coves with a hole through each, cut from its face.
//
// Every joint lives in one plane, the joint plane (mm): `a` across the boards' width (0..width),
// `c` across the pin board's thickness from its outer face (c = 0) to its inside face. The tail
// board's face and the pin board's end grain both lie in it, so a joint is a pair of regions
// there, each extruded along `b`: across the tail board's thickness from its outer face (b = 0),
// then on along the pin board's length.
import type { Contour, CutType, FreeOrigin, ImportPart, Shape } from '../../model/types'
import { shapeFromWorld } from '../../model/factory'
import { bboxFraction, shapesBBox } from '../../geometry/transform'
import { BITS } from '../carve3d/bits'
import * as R from './region'
import { dovetailCuts, dovetailLayout, type DovetailParams } from './dovetail'

export type JointKind = 'dovetail' | 'finepin' | 'knapp'

// ---------------------------------------------------------------------------------------------
// Bits

export interface StraightBit {
  id: string
  name: string
  diameter: number
  /** Deepest it cuts in one go, mm. */
  cutLength: number
}

/** Shaper's straight bits, smallest first. */
export const STRAIGHT_BITS: StraightBit[] = BITS.filter((b) => b.type === 'flat')
  .map((b) => ({ id: b.id, name: b.name, diameter: b.diameter, cutLength: b.maxDepth ?? b.fluteLength }))
  .sort((p, q) => p.diameter - q.diameter || p.cutLength - q.cutLength)

/** A bit choice: a catalogue bit, or `custom` with its own size (2 mm and 1/16″ bits are not in Shaper's catalogue). */
export interface BitChoice {
  id: string
  custom: { diameter: number; cutLength: number }
}

export const CUSTOM_BIT = 'custom'

export function resolveBit(c: BitChoice): StraightBit {
  if (c.id === CUSTOM_BIT) return { id: CUSTOM_BIT, name: `Ø${+c.custom.diameter.toFixed(3)} mm straight bit`, ...c.custom }
  return STRAIGHT_BITS.find((b) => b.id === c.id) ?? STRAIGHT_BITS[0]
}

/** The catalogue bit closest to `dia` that is no larger (or the smallest), with a cut length of at least `depth` if one exists. */
export function pickBit(dia: number, depth = 0): BitChoice {
  const fits = STRAIGHT_BITS.filter((b) => b.diameter <= dia + 1e-9)
  const deep = fits.filter((b) => b.cutLength >= depth - 1e-9)
  const pool = deep.length ? deep : fits.length ? fits : STRAIGHT_BITS.slice(0, 1)
  // Largest diameter; among equals the shortest that is deep enough (stiffer), else the longest.
  const better = (q: StraightBit, p: StraightBit) =>
    q.diameter > p.diameter + 1e-9 || (Math.abs(q.diameter - p.diameter) < 1e-9 && (deep.length ? q.cutLength < p.cutLength : q.cutLength > p.cutLength))
  const best = pool.reduce((p, q) => (better(q, p) ? q : p))
  return { id: best.id, custom: { diameter: 2, cutLength: 12 } }
}

// ---------------------------------------------------------------------------------------------
// Fit

export interface Fit {
  /** Clearance on every wall of the pin board's pockets, mm per side. */
  gap: number
  /** Pins and tails stand this far proud of the faces they come through, for planing flush, mm. */
  proud: number
  /** 'round': the mating part copies the round corners the bit leaves; 'chisel': square them by hand. */
  corners: 'round' | 'chisel'
}

export const DEFAULT_FIT = { mm: { gap: 0.1, proud: 0.5, corners: 'round' }, in: { gap: 0.004 * 25.4, proud: 0.02 * 25.4, corners: 'round' } } as const satisfies Record<string, Fit>

/** Narrowest socket the finishing bit is asked to cut: its diameter plus this, mm. */
const SLOT_CLEARANCE = 0.15
/** How far cuts run past the board faces beyond the bit radius, mm. */
const RUN_OUT = 3
/** Gap between the two layouts on the canvas, mm. */
const LAYOUT_GAP = 20

// ---------------------------------------------------------------------------------------------
// Result

/** One slab of a board: `region` (joint plane) extruded from b0 to b1. */
export interface Layer {
  b0: number
  b1: number
  region: R.Region
}

export interface BoardSolid {
  layers: Layer[]
  /** The board's long grain runs along this axis. */
  grain: 'b' | 'c'
}

export interface LayoutCut {
  name: string
  contours: Contour[]
  type: CutType
  depth: number
  offset: number
  bitDia: number
  bitId?: string
  note: string
}

/** One board's cut layout, in its own frame (mm, x across the width, y down). */
export interface BoardLayout {
  title: string
  /** Where the layout goes on the board, short. */
  sub: string
  guide: Contour
  cuts: LayoutCut[]
}

export interface CutStep {
  board: 'tail' | 'pin' | 'both'
  title: string
  bit?: string
  text: string
}

export interface JointModel {
  kind: JointKind
  /** What the two boards are called for this joint. */
  names: { tail: string; pin: string }
  width: number
  /** Board length shown past the joint in 3D, mm. */
  length: number
  tail: BoardSolid
  pin: BoardSolid
  /** How far the tail board slides off for the "Apart" view. */
  slide: number
  layouts: { tail: BoardLayout; pin: BoardLayout }
  steps: CutStep[]
  warnings: string[]
  /** False when the layout cannot be cut (the warnings say why). */
  ok: boolean
  /** One-line summary under the 3D view. */
  summary: string
  /** Name for the imported groups. */
  label: string
  info: { tail: Record<string, string>; pin: Record<string, string> }
}

/** Formats a length for messages (the dialog's units). */
export type Fmt = (mm: number) => string

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const bodyLength = (W: number) => Math.min(320, Math.max(70, W * 0.75))
const roundUp = (v: number, step = 0.1) => Math.ceil(v / step - 1e-6) * step

/**
 * Overlap between two parts that should only touch, mm², ignoring slivers thinner than 0.05 mm
 * (lost in the glue line). Anything above this is a collision.
 */
const COLLISION = 0.02
const overlap = (a: R.Region, b: R.Region) => R.area(R.offset(R.inter(a, b), -0.025))

// ---------------------------------------------------------------------------------------------
// Fine-pin dovetails

export interface FinePinDraft {
  width: number
  tailThick: number
  pinThick: number
  /** Full pins between the two edge pins. null = auto. */
  pins: number | null
  /** Pin width at the pin board's outer face (its narrowest). null = the finest the tail bit allows. */
  pinWidth: number | null
  /** Dovetail slope, 1 : slope. */
  slope: number
  /** Edge (half) pin width at the outer face. null = auto. */
  edgePin: number | null
  tailBit: BitChoice
  pinBit: BitChoice
  fit: Fit
}

export interface FinePinResolved {
  pins: number
  maxPins: number
  pinWidth: number
  minPinWidth: number
  edgePin: number
  angle: number
  tailBit: StraightBit
  pinBit: StraightBit
  /** Tail width at the outer face (widest) and at the baseline (narrowest). */
  tailWide: number
  tailNarrow: number
  /** Pin width at the inside face. */
  pinWide: number
}

export const slopeToAngle = (slope: number) => (Math.atan(1 / Math.max(slope, 0.5)) * 180) / Math.PI
export const angleToSlope = (deg: number) => 1 / Math.tan((Math.min(Math.max(deg, 1), 40) * Math.PI) / 180)

export function resolveFinePin(d: FinePinDraft): FinePinResolved {
  const tailBit = resolveBit(d.tailBit)
  const pinBit = resolveBit(d.pinBit)
  const t = 1 / Math.max(d.slope, 0.5)
  const p = d.fit.proud
  // The socket is narrowest at the tail end (c = −proud); the tail bit has to fit there.
  const minPinWidth = roundUp(tailBit.diameter + SLOT_CLEARANCE + 2 * p * t)
  const pinWidth = Math.max(minPinWidth, d.pinWidth ?? minPinWidth)
  const edgePin = Math.max(0.5, d.edgePin ?? roundUp(pinWidth * 1.5))
  const W = d.width
  const flare = 2 * d.pinThick * t
  const tailAt = (n: number) => (W - 2 * edgePin - n * pinWidth) / (n + 1)
  // Tails must leave room at their base for the pin board's bit.
  const minTailBase = pinBit.diameter + 2 * d.fit.gap + 0.3
  let maxPins = 0
  while (maxPins < 200 && tailAt(maxPins + 1) - flare >= minTailBase) maxPins++
  const autoPins = Math.max(0, Math.round(W / 25) - 1)
  const pins = Math.max(0, Math.min(maxPins, d.pins ?? autoPins))
  const tailWide = tailAt(pins)
  return {
    pins,
    maxPins,
    pinWidth,
    minPinWidth,
    edgePin,
    angle: slopeToAngle(d.slope),
    tailBit,
    pinBit,
    tailWide,
    tailNarrow: tailWide - flare,
    pinWide: pinWidth + flare,
  }
}

export function finePinJoint(d: FinePinDraft, fmt: Fmt): JointModel {
  const r = resolveFinePin(d)
  const W = d.width
  const tT = d.tailThick
  const tP = d.pinThick
  const p = d.fit.proud
  const g = d.fit.gap
  const t = 1 / Math.max(d.slope, 0.5)
  const L = bodyLength(W)
  const r1 = r.tailBit.diameter / 2
  const r2 = r.pinBit.diameter / 2
  const run1 = r1 + RUN_OUT
  const chisel = d.fit.corners === 'chisel'

  // Pins at the outer face (c = 0): [left, right], edge pins first and last.
  const spans: [number, number][] = [[0, r.edgePin]]
  let x = r.edgePin
  for (let k = 0; k < r.pins; k++) {
    x += r.tailWide
    spans.push([x, x + r.pinWidth])
    x += r.pinWidth
  }
  spans.push([W - r.edgePin, W])

  // Tail board sockets (its waste), run straight out past the tail end so the bit enters there.
  const sockets: R.Region[] = spans.map(([l, rr], k) => {
    const first = k === 0
    const last = k === spans.length - 1
    const lEnd = first ? -run1 : l + p * t
    const rEnd = last ? W + run1 : rr - p * t
    const lBase = first ? -run1 : l - tP * t
    const rBase = last ? W + run1 : rr + tP * t
    return R.poly([
      { x: lEnd, y: -p - run1 },
      { x: rEnd, y: -p - run1 },
      { x: rEnd, y: -p },
      { x: rBase, y: tP },
      { x: lBase, y: tP },
      { x: lEnd, y: -p },
    ])
  })
  const tailStock = R.rect(0, -p, W, tP + L)
  const tailIdeal = R.diff(tailStock, R.union(...sockets))
  const cutSockets = R.union(...sockets.map((s) => R.opening(s, r1)))
  const tailCut = R.diff(tailStock, cutSockets)
  const tailFinal = chisel ? tailIdeal : tailCut

  // Pin board: clear around the pins, to the tails as they will be, plus the glue gap.
  const pinStock = R.rect(0, 0, W, tP)
  const pocketLine = R.runOut(R.inter(tailFinal, pinStock), R.bounds(pinStock), r2 + RUN_OUT)
  const pocketCut = R.opening(R.offset(pocketLine, g), r2)
  const pinFinal = R.diff(pinStock, pocketCut)

  const warnings: string[] = []
  if (r.tailWide <= 0) warnings.push('The pins fill the board. Use fewer pins, narrower pins or wider boards.')
  else if (r.tailNarrow < r.pinBit.diameter + 2 * g)
    warnings.push(`The tails are narrower at their base than the pin-board bit (${fmt(r.pinBit.diameter)}). Use fewer pins or a smaller bit.`)
  if (d.pinWidth != null && d.pinWidth < r.minPinWidth - 1e-9)
    warnings.push(`Pins can be no finer than ${fmt(r.minPinWidth)} with the ${fmt(r.tailBit.diameter)} tail bit.`)
  const collide = overlap(tailFinal, pinFinal)
  if (r.tailWide > 0 && collide > COLLISION) warnings.push('The pin-board bit cannot clear between the pins. Use a smaller bit or fewer pins.')
  if (tT > 2 * r.tailBit.cutLength + 1e-9)
    warnings.push(`The tail board is too thick for the tail bit even from both faces (${fmt(r.tailBit.cutLength)} each).`)
  if (tT + p > r.pinBit.cutLength + 1e-9)
    warnings.push(`The pin pockets (${fmt(tT + p)}) are deeper than the pin-board bit cuts (${fmt(r.pinBit.cutLength)}).`)
  const ok = r.tailWide > 0 && r.tailNarrow > 0 && !(collide > COLLISION)
  const flip = tT > r.tailBit.cutLength + 1e-9

  // Layouts: the tail board's face (tail end at the top), the pin board's end grain (outer face at the top).
  const tailLayout: BoardLayout = {
    title: 'Tail board',
    sub: `face · ${fmt(tT)} through`,
    guide: R.toContours(R.rect(0, -p, W, tP + Math.max(12, tP)))[0],
    cuts: sockets.map((s, i) => ({
      name: i === 0 || i === sockets.length - 1 ? `Tail board · edge socket ${i === 0 ? 'L' : 'R'}` : `Tail board · socket ${i}`,
      contours: R.toContours(s),
      type: 'pocket' as CutType,
      depth: flip ? tT / 2 + 0.5 : tT,
      offset: 0,
      bitDia: r.tailBit.diameter,
      bitId: r.tailBit.id === CUSTOM_BIT ? undefined : r.tailBit.id,
      note: flip ? 'Through the board from both faces: half depth from each.' : 'Through the board: back it with a spoilboard.',
    })),
  }
  const pinPockets = R.pieces(pocketLine)
  const pinLayout: BoardLayout = {
    title: 'Pin board',
    sub: `end grain · ${fmt(tT + p)} deep`,
    guide: R.toContours(pinStock)[0],
    cuts: pinPockets.map((pc, i) => ({
      name: `Pin board · tail socket ${i + 1}`,
      contours: R.toContours(R.pieceRegion(pc)),
      type: 'pocket' as CutType,
      depth: tT + p,
      offset: g,
      bitDia: r.pinBit.diameter,
      bitId: r.pinBit.id === CUSTOM_BIT ? undefined : r.pinBit.id,
      note: `Straight bit, ${fmt(tT + p)} deep.`,
    })),
  }

  const steps: CutStep[] = [
    {
      board: 'tail',
      title: 'Tail board, flat',
      bit: r.tailBit.name,
      text: flip
        ? `Face up on a spoilboard. Pocket the sockets ${fmt(tT / 2 + 0.5)} deep, then turn the board over (long edge stays put) and cut the mirror image from the other face.`
        : `Face up on a spoilboard. Pocket the sockets right through (${fmt(tT)}). Each socket runs off the end, so the bit enters from outside the board.`,
    },
    ...(chisel ? [{ board: 'tail' as const, title: 'Square the corners', text: `Pare the socket corners square with a chisel: the bit leaves them ${fmt(r1)} round.` }] : []),
    {
      board: 'pin',
      title: 'Pin board, upright',
      bit: r.pinBit.name,
      text: `Clamp it end grain up. Pocket between the pins ${fmt(tT + p)} deep with a ${fmt(g)} offset (the glue gap).${chisel ? '' : ' The pin corners come out round to match the sockets.'}`,
    },
    { board: 'both', title: 'Glue up', text: p > 0 ? `Pins and tails stand ${fmt(p)} proud: plane them flush once the glue is dry.` : 'Glue and clamp; the faces finish flush.' },
  ]

  return {
    kind: 'finepin',
    names: { tail: 'Tail board', pin: 'Pin board' },
    width: W,
    length: L,
    tail: { grain: 'c', layers: [{ b0: 0, b1: tT, region: tailFinal }] },
    pin: {
      grain: 'b',
      layers: [
        { b0: -p, b1: tT, region: pinFinal },
        { b0: tT, b1: tT + L, region: pinStock },
      ],
    },
    slide: tT + p + Math.max(18, W * 0.12),
    layouts: { tail: tailLayout, pin: pinLayout },
    steps,
    warnings,
    ok,
    summary: `${plural(r.pins, 'pin')} + 2 half pins · 1:${+d.slope.toFixed(2)} · pins ${fmt(r.pinWidth)} → ${fmt(r.pinWide)}`,
    label: `Fine-pin dovetail – ${plural(r.pins, 'pin')}, 1:${+d.slope.toFixed(2)}`,
    info: {
      tail: { bit: r.tailBit.name, 'sockets': flip ? `${fmt(tT / 2 + 0.5)} from each face` : `${fmt(tT)} through` },
      pin: { bit: r.pinBit.name, 'pockets depth': fmt(tT + p), 'glue gap': fmt(g) },
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Knapp (pin and cove)

export interface KnappDraft {
  /** Board width: the drawer side's height. */
  width: number
  /** Drawer side (tail board) thickness: the dowels' length. */
  sideThick: number
  /** Drawer front (pin board) thickness. */
  frontThick: number
  /** Dowel count. null = auto. */
  pins: number | null
  /** Dowel diameter. null = auto. */
  dowel: number | null
  /** Extra length of each dowel along the width, for slot-shaped dowels. 0 = round. */
  dowelLength: number
  /** Cove radius (or, straight, the side's set-back from the dowel centres). null = auto. */
  cove: number | null
  style: 'cove' | 'straight'
  /** Board edge to the first dowel's centre. null = auto (half the spacing). */
  margin: number | null
  /** Dowel centres from the front's inside face. null = auto. */
  dowelPos: number | null
  /** Hide the joint behind a skin on the side's outer face (full-blind). */
  hidden: boolean
  skin: number
  sideBit: BitChoice
  frontBit: BitChoice
  fit: Fit
}

export interface KnappResolved {
  pins: number
  maxPins: number
  pitch: number
  margin: number
  dowel: number
  cove: number
  minCove: number
  /** Dowel centres from the front's outer face. */
  cp: number
  dowelPos: number
  /** The front's lap at its outer face (c of the cove tips). */
  lap: number
  sideBit: StraightBit
  frontBit: StraightBit
}

export function resolveKnapp(d: KnappDraft): KnappResolved {
  const sideBit = resolveBit(d.sideBit)
  const frontBit = resolveBit(d.frontBit)
  const W = d.width
  const tF = d.frontThick
  const g = d.fit.gap
  const lapMin = Math.max(1.5, 0.2 * tF)
  const auto = Math.max(1, Math.round(W / 20))
  // Neighbouring dowels need room for the front bit to pass around both.
  const minPitch = (dw: number) => dw + d.dowelLength + 2 * (frontBit.diameter + 2 * g + 0.3)
  const pitchFor = (n: number, m: number | null) => (n <= 1 ? W : m == null ? W / n : (W - 2 * m) / (n - 1))
  const dowelFor = (pitch: number) => d.dowel ?? Math.max(sideBit.diameter + 0.5, Math.min(roundUp(0.4 * pitch, 0.5), Math.floor(0.9 * tF) / 2))
  let maxPins = 1
  while (maxPins < 100) {
    const pitch = pitchFor(maxPins + 1, d.margin)
    if (pitch < minPitch(dowelFor(pitch))) break
    maxPins++
  }
  const pins = Math.max(1, Math.min(maxPins, d.pins ?? auto))
  const pitch = pitchFor(pins, d.margin)
  const margin = pins <= 1 ? W / 2 : d.margin ?? pitch / 2
  const dowel = dowelFor(pitch)
  const rp = dowel / 2
  const minCove = roundUp(rp + frontBit.diameter + 2 * g + 0.3)
  const autoCove = Math.max(minCove, Math.min(roundUp(0.58 * pitch, 0.5), tF - rp - lapMin))
  const cove = Math.max(rp + 0.5, d.cove ?? autoCove)
  const cpMin = cove + lapMin
  const cpMax = tF - rp
  const cp = d.dowelPos != null ? tF - d.dowelPos : cpMin <= cpMax ? (cpMin + cpMax) / 2 : cpMax
  return { pins, maxPins, pitch, margin, dowel, cove, minCove, cp, dowelPos: tF - cp, lap: cp - cove, sideBit, frontBit }
}

export function knappJoint(d: KnappDraft, fmt: Fmt): JointModel {
  const r = resolveKnapp(d)
  const W = d.width
  const tS = d.sideThick
  const tF = d.frontThick
  const g = d.fit.gap
  const p = d.hidden ? 0 : d.fit.proud
  const skin = d.hidden ? Math.min(Math.max(0.5, d.skin), tS - 1) : 0
  const L = bodyLength(W)
  const r1 = r.sideBit.diameter / 2
  const r2 = r.frontBit.diameter / 2
  const run1 = r1 + RUN_OUT
  const rp = r.dowel / 2
  const chisel = d.fit.corners === 'chisel'
  const straight = d.style === 'straight'
  const len = Math.max(0, d.dowelLength)

  const centres = Array.from({ length: r.pins }, (_, k) => (r.pins === 1 ? W / 2 : r.margin + k * r.pitch))
  const dowels = R.union(...centres.map((a) => R.stadium(a, r.cp, len, rp)))
  // Coves: the half of each slot (radius `cove`) toward the front's outer face.
  const coves = straight
    ? R.rect(-1, r.lap, W + 1, r.cp)
    : R.inter(R.union(...centres.map((a) => R.stadium(a, r.cp, len, r.cove))), R.rect(-1, r.lap - 1, W + 1, r.cp))
  const sideStart = d.hidden ? 0 : r.lap
  const sideStock = R.rect(0, sideStart, W, tF + L)
  const sideIdeal = R.diff(R.inter(sideStock, R.union(coves, R.rect(-1, r.cp, W + 1, tF + L + 1))), dowels)

  // The side's waste: the front's share of the joint (lap side of the coves) and the dowel holes.
  const strip = straight ? [] : R.diff(R.rect(-run1, Math.min(sideStart, r.lap) - run1, W + run1, r.cp), coves)
  const holes = R.pieces(dowels).map(R.pieceRegion)
  const sideWaste = [...R.pieces(strip).map(R.pieceRegion), ...holes]
  const sideCutWaste = R.union(...sideWaste.map((w) => R.opening(w, r1)))
  const sideCut = R.diff(sideStock, sideCutWaste)
  // Straight style: the side is just cut to length at the set-back, so only the holes are cut.
  const sideFinal = chisel ? sideIdeal : sideCut

  // Front: clear the side's share around the dowels, plus the glue gap.
  const frontStock = R.rect(0, 0, W, tF)
  const pocketLine = R.runOut(R.inter(sideFinal, frontStock), R.bounds(frontStock), r2 + RUN_OUT)
  const pocketCut = R.opening(R.offset(pocketLine, g), r2)
  const frontFinal = R.diff(frontStock, pocketCut)

  const warnings: string[] = []
  if (r.dowel < r.sideBit.diameter + 0.2) warnings.push(`The dowel holes are smaller than the side bit (${fmt(r.sideBit.diameter)}).`)
  if (r.cove < r.minCove - 1e-9)
    warnings.push(`The front bit (${fmt(r.frontBit.diameter)}) cannot pass between the dowels and the ${straight ? 'side' : 'coves'}: make the ${straight ? 'set-back' : 'coves'} at least ${fmt(r.minCove)}.`)
  if (r.cp + rp > tF + 1e-9) warnings.push('The dowels stick out of the front’s inside face. Move them out, or use smaller dowels or coves.')
  if (r.lap < -1e-9) warnings.push(d.hidden ? 'The coves run past the front’s outer face.' : 'The coves break through the front’s outer face. Use smaller coves or move the dowels in.')
  else if (!d.hidden && r.lap < 1) warnings.push(`Only ${fmt(Math.max(0, r.lap))} of the front covers the coves: it may break out.`)
  if (r.pins > 1 && r.pitch < 2 * rp + len + 2 * r.frontBit.diameter) warnings.push('The dowels are too close for the front bit to pass between them. Use fewer dowels.')
  if (r.margin < rp + len / 2 + 1) warnings.push('The first dowel runs off the board edge. Increase the edge margin.')
  const collide = overlap(sideFinal, frontFinal)
  if (collide > COLLISION) warnings.push('The front bit cannot clear everything around the dowels. Use a smaller front bit, bigger coves or smaller dowels.')
  const depth = tS - skin + p
  if (depth > r.frontBit.cutLength + 1e-9) warnings.push(`The front pockets (${fmt(depth)}) are deeper than the front bit cuts (${fmt(r.frontBit.cutLength)}).`)
  const sideDepth = tS - skin
  if (sideDepth > r.sideBit.cutLength + 1e-9) warnings.push(`The side cuts (${fmt(sideDepth)}) are deeper than the side bit cuts (${fmt(r.sideBit.cutLength)}).`)
  const ok = r.lap >= -1e-9 && r.cp + rp <= tF + 1e-9 && r.dowel >= r.sideBit.diameter + 0.2 && !(collide > COLLISION) && R.area(frontFinal) > 0

  const through = !d.hidden
  const tailLayout: BoardLayout = {
    title: 'Drawer side',
    sub: through ? `face · ${fmt(tS)} through` : `inside face · ${fmt(sideDepth)} deep`,
    guide: R.toContours(R.rect(0, sideStart, W, tF + Math.max(12, tF * 0.6)))[0],
    cuts: [
      ...(straight
        ? []
        : R.pieces(strip).map((pc) => ({
            name: 'Drawer side · coves',
            contours: R.toContours(R.pieceRegion(pc)),
            type: 'pocket' as CutType,
            depth: sideDepth,
            offset: 0,
            bitDia: r.sideBit.diameter,
            bitId: r.sideBit.id === CUSTOM_BIT ? undefined : r.sideBit.id,
            note: through ? 'Through the board: back it with a spoilboard.' : `From the inside face, ${fmt(sideDepth)} deep.`,
          }))),
      ...holes.map((h, i) => ({
        name: `Drawer side · dowel hole ${i + 1}`,
        contours: R.toContours(h),
        type: 'pocket' as CutType,
        depth: sideDepth,
        offset: 0,
        bitDia: r.sideBit.diameter,
        bitId: r.sideBit.id === CUSTOM_BIT ? undefined : r.sideBit.id,
        note: through ? 'Through the board.' : `From the inside face, ${fmt(sideDepth)} deep.`,
      })),
    ],
  }
  const frontLayout: BoardLayout = {
    title: 'Drawer front',
    sub: `end grain · ${fmt(depth)} deep`,
    guide: R.toContours(frontStock)[0],
    cuts: R.pieces(pocketLine).map((pc, i) => ({
      name: `Drawer front · pocket around the dowels${i ? ` ${i + 1}` : ''}`,
      contours: R.toContours(R.pieceRegion(pc)),
      type: 'pocket' as CutType,
      depth,
      offset: g,
      bitDia: r.frontBit.diameter,
      bitId: r.frontBit.id === CUSTOM_BIT ? undefined : r.frontBit.id,
      note: `Straight bit, ${fmt(depth)} deep; the dowels stay standing.`,
    })),
  }

  const steps: CutStep[] = [
    {
      board: 'tail',
      title: 'Drawer side, flat',
      bit: r.sideBit.name,
      text: through
        ? `${straight ? 'Cut it to length at the set-back, then pocket' : 'Face up on a spoilboard. Pocket the coves and'} the dowel holes right through (${fmt(tS)}).`
        : `Inside face up. Pocket ${straight ? 'the dowel holes' : 'the coves and dowel holes'} ${fmt(sideDepth)} deep, leaving a ${fmt(skin)} skin on the outside.`,
    },
    ...(chisel && !straight ? [{ board: 'tail' as const, title: 'Sharpen the valleys', text: `Pare the valleys between the coves to a point: the bit leaves them ${fmt(r1)} round.` }] : []),
    {
      board: 'pin',
      title: 'Drawer front, upright',
      bit: r.frontBit.name,
      text: `Clamp it end grain up, inside face toward you. Pocket around the dowels ${fmt(depth)} deep with a ${fmt(g)} offset; the dowels stay standing.`,
    },
    { board: 'both', title: 'Assemble', text: `Slide the side over the dowels.${p > 0 ? ` The dowels and front stand ${fmt(p)} proud: plane them flush.` : ''}` },
  ]

  return {
    kind: 'knapp',
    names: { tail: 'Drawer side', pin: 'Drawer front' },
    width: W,
    length: L,
    tail: {
      grain: 'c',
      layers: d.hidden
        ? [
            { b0: 0, b1: skin, region: R.rect(0, 0, W, tF + L) },
            { b0: skin, b1: tS, region: sideFinal },
          ]
        : [{ b0: 0, b1: tS, region: sideFinal }],
    },
    pin: {
      grain: 'b',
      layers: [
        { b0: d.hidden ? skin : -p, b1: tS, region: frontFinal },
        { b0: tS, b1: tS + L, region: frontStock },
      ],
    },
    slide: tS + p + Math.max(18, W * 0.12),
    layouts: { tail: tailLayout, pin: frontLayout },
    steps,
    warnings,
    ok,
    summary: `${plural(r.pins, 'dowel')} · Ø${fmt(r.dowel)}${len > 0 ? ` × ${fmt(r.dowel + len)}` : ''} · ${straight ? 'straight' : `coves R${fmt(r.cove)}`}${d.hidden ? ' · hidden' : ''}`,
    label: `Knapp joint – ${plural(r.pins, 'dowel')}`,
    info: {
      tail: { bit: r.sideBit.name, cuts: through ? `${fmt(tS)} through` : `${fmt(sideDepth)} deep` },
      pin: { bit: r.frontBit.name, 'pocket depth': fmt(depth), 'glue gap': fmt(g) },
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Dovetail bit (the original joint), in the same shape

export function dovetailJoint(params: DovetailParams, bitName: string, bitId: string | undefined, fmt: Fmt): JointModel {
  const Ly = dovetailLayout(params)
  const c = dovetailCuts(params)
  const W = params.width
  const L = bodyLength(W)
  const ok = Ly.tailNarrow > 0 && Ly.pinNarrow > 0
  const pinStock = R.rect(0, 0, W, params.pinThick)
  const shift = (k: Contour, dy: number): Contour => ({ closed: k.closed, pts: k.pts.map((q) => ({ x: q.x, y: q.y - dy })) })
  return {
    kind: 'dovetail',
    names: { tail: 'Tail board', pin: 'Pin board' },
    width: W,
    length: L,
    tail: { grain: 'c', layers: ok ? [{ b0: 0, b1: params.tailThick, region: R.poly(Ly.tailProfile(params.pinThick + L)) }] : [] },
    pin: {
      grain: 'b',
      layers: ok
        ? [
            { b0: 0, b1: params.tailThick, region: R.union(...Ly.pins.map(R.poly)) },
            { b0: params.tailThick, b1: params.tailThick + L, region: pinStock },
          ]
        : [{ b0: 0, b1: params.tailThick + L, region: pinStock }],
    },
    slide: params.tailThick + Math.max(18, W * 0.12),
    layouts: {
      tail: {
        title: 'Tail board',
        sub: `end grain · ${fmt(params.pinThick)} deep`,
        guide: c.tail.board,
        cuts: c.tail.sockets.map((s, i) => ({
          name: `Tail board · socket ${i + 1}`,
          contours: [s],
          type: c.tail.online ? 'online' : 'pocket',
          depth: params.pinThick,
          offset: 0,
          bitDia: params.bit.diameter,
          bitId,
          note: `Dovetail bit, one full-depth pass (${fmt(params.pinThick)}). Start off the board: a dovetail bit cannot plunge.`,
        })),
      },
      pin: {
        title: 'Pin board',
        sub: `end grain · ${fmt(params.tailThick)} deep`,
        guide: shift(c.pin.board, c.pinTop),
        cuts: c.pin.pockets.map((s, i) => ({
          name: `Pin board · tail socket ${i + 1}`,
          contours: [shift(s, c.pinTop)],
          type: 'pocket',
          depth: params.tailThick,
          offset: params.glueGap,
          bitDia: params.straightBit,
          note: `Straight bit, ${fmt(params.tailThick)} deep.`,
        })),
      },
    },
    steps: [
      {
        board: 'tail',
        title: 'Tail board, upright',
        bit: bitName,
        text: `Clamp it end grain up. Set the dovetail bit to ${fmt(params.pinThick)} and cut each socket in one pass, starting off the board: a dovetail bit cannot plunge.`,
      },
      { board: 'pin', title: 'Pin board, upright', text: `Clamp it end grain up. Pocket each tail socket ${fmt(params.tailThick)} deep with a ${fmt(params.glueGap)} offset.` },
      { board: 'both', title: 'Glue up', text: 'The joint slides together by hand with glue in it.' },
    ],
    warnings: Ly.warnings,
    ok,
    summary: `${plural(params.tails, 'tail')} · ${+params.bit.angle.toFixed(2)}° · ${fmt(W)} wide`,
    label: `Dovetail – ${plural(params.tails, 'tail')}, ${+params.bit.angle.toFixed(2)}°`,
    info: {
      tail: { bit: bitName, 'tail sockets depth': fmt(params.pinThick) },
      pin: { 'pin pockets depth': fmt(params.tailThick), 'glue gap': fmt(params.glueGap) },
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Import

/**
 * The two layouts as they import: one group per board (its guide rectangle and its cuts), tail
 * board above pin board, each group anchored on its guide rectangle's bottom-left corner.
 */
export function jointParts(m: JointModel): ImportPart[] {
  const parts: ImportPart[] = []
  let top = 0
  for (const which of ['tail', 'pin'] as const) {
    const lay = m.layouts[which]
    const all = [lay.guide, ...lay.cuts.flatMap((k) => k.contours)]
    const minY = Math.min(...all.flatMap((k) => k.pts.map((q) => q.y)))
    const maxY = Math.max(...all.flatMap((k) => k.pts.map((q) => q.y)))
    const move = (k: Contour): Contour => ({ closed: k.closed, pts: k.pts.map((q) => ({ x: q.x, y: q.y - minY + top })) })
    const guide = move(lay.guide)
    const shapes: Shape[] = [
      shapeFromWorld('rect', `${lay.title} · ${which === 'tail' && m.kind !== 'dovetail' ? 'face' : 'end'}`, [guide], {
        cut: { type: 'guide', depth: null, offset: 0, bitDia: lay.cuts[0]?.bitDia ?? 3 },
        meta: { role: 'guide', note: `${lay.title}: ${lay.sub}` },
      }),
      ...lay.cuts.map((k) =>
        shapeFromWorld('path', k.name, k.contours.map(move), {
          cut: { type: k.type, depth: k.depth, offset: k.offset, bitDia: k.bitDia },
          meta: { bitId: k.bitId, note: k.note },
        }),
      ),
    ]
    const corner = { x: Math.min(...guide.pts.map((q) => q.x)), y: Math.max(...guide.pts.map((q) => q.y)) }
    const anchor: FreeOrigin = bboxFraction(shapesBBox(shapes), corner)
    parts.push({
      group: { name: `${m.label} · ${m.names[which].toLowerCase()}`, info: m.info[which], anchor },
      shapes: shapes.map(({ id: _id, ...s }) => s),
    })
    top += maxY - minY + LAYOUT_GAP
  }
  return parts
}
