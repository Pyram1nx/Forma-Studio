// The account's Systainers page: what the Systainer Insert tool offers (the T-Loc sizes and the
// catalogue of gear it cuts pockets for), and the way into the tool.
//
// The home window must stay light, so nothing here imports Three.js: the catalogue and Systainer
// modules (catalog.ts, systainerModel.ts, layout.ts) all build meshes. The pictures are flat SVG
// drawn from the outlines traced from ShaperHub inserts (hubProfiles.ts, plain data) and from the
// sizes in catalog.ts. Keep the list below in step with ITEMS there; CategoryId is checked by type.
import { useMemo, useState } from 'react'
import { MM_PER_IN, type Pt, type Units } from '../model/types'
import type { CategoryId } from '../features/systainer/catalog'
import {
  ANGLE_FENCE,
  CLAMP_BOLT,
  CLAMP_KNOB,
  CLAMP_LEVER,
  INSERT_OUTLINE,
  LONG_HEX_HANDLE,
  LONG_HEX_SHAFT,
  OPEN_WRENCH,
  SHORT_HEX_HANDLE,
  SHORT_HEX_SHAFT,
  SUPPORT_ARM,
} from '../features/systainer/hubProfiles'
import { BITS, type Bit } from '../features/carve3d/bits'
import { openToolFromAccount } from '../features/toolRoutes'
import { readScoped, SYNCED_SETTINGS } from '../storage/space'
import { defaultUnits } from '../state/store'
import * as Ic from '../ui/icons'
import './systainersPage.css'

// ---------- Flat drawing kit (mm, y up as in hubProfiles; flipped for SVG on output) ----------

type Prim =
  | { k: 'poly'; pts: Pt[] }
  | { k: 'rect'; cx: number; cy: number; w: number; h: number; r: number }
  | { k: 'circle'; cx: number; cy: number; r: number }

/** How a layer is painted: a pocket, a deeper step of one, a cutout, a foam island, the foam itself, or a detail line. */
type Tone = 'pocket' | 'deep' | 'ghost' | 'island' | 'foam' | 'line'

interface Layer {
  tone: Tone
  prims: Prim[]
}

const poly = (pts: Pt[]): Prim => ({ k: 'poly', pts })
const rect = (cx: number, cy: number, w: number, h: number, r = 0): Prim => ({ k: 'rect', cx, cy, w, h, r })
const circle = (cx: number, cy: number, r: number): Prim => ({ k: 'circle', cx, cy, r })
const slot = (cx: number, cy: number, len: number, w: number): Prim => rect(cx, cy, len, w, w / 2)
const L = (tone: Tone, ...prims: Prim[]): Layer => ({ tone, prims })

/** Moved by (dx, dy), first turned a quarter turn counter-clockwise when `turn`. */
function movePrim(p: Prim, dx: number, dy: number, turn = false): Prim {
  const t = (x: number, y: number) => (turn ? { x: -y + dx, y: x + dy } : { x: x + dx, y: y + dy })
  if (p.k === 'poly') return poly(p.pts.map((q) => t(q.x, q.y)))
  const c = t(p.cx, p.cy)
  if (p.k === 'circle') return circle(c.x, c.y, p.r)
  return rect(c.x, c.y, turn ? p.h : p.w, turn ? p.w : p.h, p.r)
}
const place = (layers: Layer[], dx: number, dy: number, turn = false): Layer[] =>
  layers.map((l) => ({ tone: l.tone, prims: l.prims.map((p) => movePrim(p, dx, dy, turn)) }))

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

function boundsOf(layers: Layer[]): Box {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    b.x0 = Math.min(b.x0, x0)
    b.y0 = Math.min(b.y0, y0)
    b.x1 = Math.max(b.x1, x1)
    b.y1 = Math.max(b.y1, y1)
  }
  for (const l of layers)
    for (const p of l.prims) {
      if (p.k === 'poly') for (const q of p.pts) add(q.x, q.y, q.x, q.y)
      else if (p.k === 'circle') add(p.cx - p.r, p.cy - p.r, p.cx + p.r, p.cy + p.r)
      else add(p.cx - p.w / 2, p.cy - p.h / 2, p.cx + p.w / 2, p.cy + p.h / 2)
    }
  return b
}

const n = (v: number) => +v.toFixed(2)

/** SVG path data, y flipped (SVG's y runs down). */
function pathOf(p: Prim): string {
  if (p.k === 'poly') return 'M' + p.pts.map((q) => `${n(q.x)} ${n(-q.y)}`).join('L') + 'Z'
  if (p.k === 'circle') {
    const [x, y, r] = [p.cx, -p.cy, p.r]
    return `M${n(x - r)} ${n(y)}A${n(r)} ${n(r)} 0 1 0 ${n(x + r)} ${n(y)}A${n(r)} ${n(r)} 0 1 0 ${n(x - r)} ${n(y)}Z`
  }
  const x0 = p.cx - p.w / 2
  const x1 = p.cx + p.w / 2
  const y0 = -p.cy - p.h / 2
  const y1 = -p.cy + p.h / 2
  const r = Math.min(p.r, p.w / 2, p.h / 2)
  if (r <= 0) return `M${n(x0)} ${n(y0)}H${n(x1)}V${n(y1)}H${n(x0)}Z`
  const a = `A${n(r)} ${n(r)} 0 0 1`
  return (
    `M${n(x0 + r)} ${n(y0)}H${n(x1 - r)}${a} ${n(x1)} ${n(y0 + r)}V${n(y1 - r)}${a} ${n(x1 - r)} ${n(y1)}` +
    `H${n(x0 + r)}${a} ${n(x0)} ${n(y1 - r)}V${n(y0 + r)}${a} ${n(x0 + r)} ${n(y0)}Z`
  )
}

/**
 * Layers drawn as unions: a wide outline pass under a fill pass, so where shapes of a layer
 * overlap (a handle over its shaft) only the outer edge shows.
 */
function Drawing({ layers, pad = 6, autoTurn = false, className }: { layers: Layer[]; pad?: number; autoTurn?: boolean; className?: string }) {
  let ls = layers
  let b = boundsOf(ls)
  // Long, upright things lie down so they fill a landscape tile.
  if (autoTurn && b.y1 - b.y0 > (b.x1 - b.x0) * 1.25) {
    ls = place(ls, 0, 0, true)
    b = boundsOf(ls)
  }
  const w = b.x1 - b.x0 + 2 * pad
  const h = b.y1 - b.y0 + 2 * pad
  return (
    <svg className={className} viewBox={`${n(b.x0 - pad)} ${n(-b.y1 - pad)} ${n(w)} ${n(h)}`} aria-hidden="true" focusable="false">
      {ls.map((l, i) =>
        l.tone === 'line' ? (
          <g key={i} className="home-sys-l home-sys-l--line">
            {l.prims.map((p, j) => (
              <path key={j} d={pathOf(p)} />
            ))}
          </g>
        ) : (
          <g key={i} className={`home-sys-l home-sys-l--${l.tone}`}>
            {l.prims.map((p, j) => (
              <path key={'e' + j} className="home-sys-l__edge" d={pathOf(p)} />
            ))}
            {l.prims.map((p, j) => (
              <path key={'f' + j} className="home-sys-l__fill" d={pathOf(p)} />
            ))}
          </g>
        ),
      )}
    </svg>
  )
}

// ---------- The gear, as it lies in its first pose (sizes from catalog.ts) ----------

const shaft = (x: number, a: number, b: number, w = 4) => rect(x, (a + b) / 2, w, Math.abs(b - a))
const TAPE_R = 39.3
const TAPE_W = 19.05

const longKey = (): Layer[] => [L('deep', shaft(LONG_HEX_SHAFT.x, LONG_HEX_SHAFT.tip, LONG_HEX_SHAFT.top)), L('pocket', poly(LONG_HEX_HANDLE))]
const shortKey = (): Layer[] => [L('deep', shaft(SHORT_HEX_SHAFT.x, SHORT_HEX_SHAFT.base, SHORT_HEX_SHAFT.tip)), L('pocket', poly(SHORT_HEX_HANDLE))]
const clamp = (): Layer[] => [L('pocket', poly(CLAMP_LEVER), poly(CLAMP_BOLT)), L('deep', poly(CLAMP_KNOB))]
const tapeRoll = (): Layer[] => [L('pocket', circle(0, 0, TAPE_R)), L('line', circle(0, 0, 12.7), circle(0, 0, 16))]

function bitSlots(count: number, tones: [Tone, Tone] = ['ghost', 'ghost']): Layer[] {
  const pitch = 12
  const span = (count - 1) * pitch
  const grooves: Prim[] = []
  for (let i = 0; i < count; i++) grooves.push(rect(-span / 2 + i * pitch, 0, 7, 63))
  return [L(tones[0], slot(0, 0, span + 3.8 + 22.7, 22.7)), L(tones[1], ...grooves)]
}

interface GearItem {
  id: string
  name: string
  cats: CategoryId[]
  /** Size as the catalogue models it, in mm; formatted in the page's units. */
  size: (u: Fmt) => string
  /** Traced from ShaperHub inserts. */
  hub?: boolean
  /** Estimated rather than measured. */
  approx?: boolean
  /** A cutout or custom shape whose size is set in the tool. */
  sized?: boolean
  draw: () => Layer[]
}

/** Lengths in the page's units: with the unit, bare, and as "a × b × c unit". */
interface Fmt {
  len: (mm: number) => string
  num: (mm: number) => string
  dims: (...mm: number[]) => string
}

function fmtFor(units: Units): Fmt {
  const num = (mm: number) => String(units === 'in' ? +(mm / MM_PER_IN).toFixed(2) : +mm.toFixed(1))
  const unit = units === 'in' ? ' in' : ' mm'
  return { num, len: (mm) => num(mm) + unit, dims: (...mm) => mm.map(num).join(' × ') + unit }
}

const GEAR: GearItem[] = [
  {
    id: 'collet',
    name: 'Collet',
    cats: ['origin'],
    hub: true,
    size: (u) => `Ø${u.num(20)} × ${u.len(25.2)}`,
    draw: () => [L('pocket', circle(0, 0, 10)), L('line', circle(0, 0, 5.5), circle(0, 0, 4.2))],
  },
  {
    id: 'collet-wrench',
    name: 'Collet wrench',
    cats: ['origin', 'workstation'],
    hub: true,
    size: (u) => u.dims(169, 43, 6.5),
    draw: () => [L('pocket', poly(OPEN_WRENCH))],
  },
  {
    id: 'shapertape',
    name: 'ShaperTape roll',
    cats: ['origin', 'trace'],
    hub: true,
    size: (u) => `Ø${u.num(79)} × ${u.len(19)}`,
    draw: tapeRoll,
  },
  {
    id: 'shapertape-pair',
    name: 'ShaperTape, two rolls',
    cats: ['origin', 'trace'],
    hub: true,
    size: (u) => `Two, Ø${u.num(79)} × ${u.len(19)}`,
    draw: () => [L('pocket', rect(-TAPE_W / 2, 0, TAPE_W, 2 * TAPE_R, 1.5), rect(TAPE_W / 2, 0, TAPE_W, 2 * TAPE_R, 1.5)), L('line', poly([{ x: 0, y: -TAPE_R }, { x: 0, y: TAPE_R }]))],
  },
  {
    id: 'usb-gen1',
    name: 'Shaper USB stick (Gen 1)',
    cats: ['origin'],
    hub: true,
    size: (u) => u.dims(42, 12, 4.5),
    draw: () => [L('pocket', rect(-6, 0, 30, 12, 6), rect(15, 0, 12, 12))],
  },
  {
    id: 'usb-gen2',
    name: 'Shaper USB stick (Gen 2)',
    cats: ['origin'],
    approx: true,
    size: (u) => u.dims(37.5, 13, 6),
    draw: () => [L('pocket', rect(-3.25, 0, 31, 13, 4.3), rect(15.5, 0, 6.5, 8.4))],
  },
  {
    id: 'dust-adapter',
    name: 'Dust collection adapter',
    cats: ['origin'],
    approx: true,
    size: (u) => `Ø${u.num(36)} × ${u.len(78)}`,
    draw: () => [
      L(
        'pocket',
        poly([
          { x: -18, y: -39 },
          { x: 18, y: -39 },
          { x: 18, y: -5 },
          { x: 14, y: 9 },
          { x: 14, y: 39 },
          { x: -14, y: 39 },
          { x: -14, y: 9 },
          { x: -18, y: -5 },
        ]),
      ),
    ],
  },
  {
    id: 'ws-support-arm',
    name: 'Workstation Support Arm',
    cats: ['workstation'],
    hub: true,
    size: (u) => u.dims(187, 76, 20.8),
    draw: () => [L('pocket', poly(SUPPORT_ARM))],
  },
  {
    id: 'ws-angle-fence',
    name: 'Workstation Angle Fence',
    cats: ['workstation'],
    hub: true,
    size: (u) => u.dims(160, 48, 9.5),
    draw: () => [L('pocket', poly(ANGLE_FENCE))],
  },
  {
    id: 'ws-lock-screw',
    name: 'Angle Fence Lock Screw',
    cats: ['workstation'],
    hub: true,
    size: (u) => `Ø${u.num(18)} × ${u.len(28)}`,
    draw: () => [L('pocket', circle(0, 0, 9)), L('line', circle(0, 0, 3.5))],
  },
  {
    id: 'ws-clamp',
    name: 'Workstation Hold Down Clamp',
    cats: ['workstation'],
    hub: true,
    size: (u) => `${u.dims(147, 34)} lever, Ø${u.len(47)} knob`,
    draw: clamp,
  },
  {
    id: 'ws-t-wrench',
    name: '4 mm T-handle hex key',
    cats: ['workstation', 'origin'],
    hub: true,
    size: (u) => `${u.len(217)} long, ${u.len(80)} handle`,
    draw: longKey,
  },
  {
    id: 'ws-t-wrench-short',
    name: 'Short 4 mm T-handle hex key',
    cats: ['workstation', 'origin'],
    hub: true,
    size: (u) => `${u.len(85)} long, ${u.len(65)} handle`,
    draw: shortKey,
  },
  {
    id: 'trace-frame',
    name: 'Shaper Trace frame',
    cats: ['trace'],
    hub: true,
    size: (u) => u.dims(338, 248),
    draw: () => [L('pocket', rect(0, 0, 338, 248, 11.4)), L('island', rect(0, 0, 273, 183, 10))],
  },
  {
    id: 'phone',
    name: 'Smartphone',
    cats: ['trace', 'shop'],
    approx: true,
    size: (u) => u.dims(77, 160, 8.5),
    draw: () => [L('pocket', rect(0, 0, 77, 160, 11)), L('line', rect(0, 0, 67, 146, 6))],
  },
  {
    id: 'pencil',
    name: 'Pencil',
    cats: ['shop', 'trace'],
    size: (u) => `${u.num(178)} × Ø${u.len(8.5)}`,
    draw: () => [
      L(
        'pocket',
        rect(-1, 0, 160, 8.5),
        poly([
          { x: 79, y: 4.1 },
          { x: 97.6, y: 0 },
          { x: 79, y: -4.1 },
        ]),
        rect(-85.5, 0, 9, 7.8),
        rect(-93.75, 0, 7.5, 7.2, 1.5),
      ),
    ],
  },
  {
    id: 'tape-measure',
    name: 'Tape measure, 5 m',
    cats: ['shop'],
    approx: true,
    size: (u) => u.dims(70, 66, 32),
    draw: () => [L('pocket', rect(0, 0, 70, 66, 16), rect(36, -20, 6, 22, 1)), L('line', circle(-2, 2, 14))],
  },
  {
    id: 'thumb-notch',
    name: 'Thumb notch',
    cats: ['basics'],
    sized: true,
    size: (u) => `Ø${u.len(32)}, as deep as its pocket`,
    draw: () => [L('ghost', circle(0, 0, 16))],
  },
  {
    id: 'finger-slot',
    name: 'Finger slot',
    cats: ['basics'],
    sized: true,
    size: (u) => `${u.dims(66, 26)}, as deep as its pocket`,
    draw: () => [L('ghost', slot(0, 0, 66, 26))],
  },
  {
    id: 'bit-slots',
    name: 'Bit slots',
    cats: ['basics', 'bits'],
    sized: true,
    size: (u) => `2–20 grooves, ${u.len(12)} apart`,
    draw: () => bitSlots(10, ['pocket', 'deep']),
  },
  {
    id: 'custom-box',
    name: 'Custom box',
    cats: ['basics'],
    sized: true,
    size: (u) => `Any size up to ${u.dims(380, 270)}`,
    draw: () => [L('pocket', rect(0, 0, 100, 60, 2)), L('line', rect(0, 0, 88, 48, 1))],
  },
  {
    id: 'custom-cylinder',
    name: 'Custom cylinder',
    cats: ['basics'],
    sized: true,
    size: (u) => `Any diameter up to ${u.len(260)}`,
    draw: () => [L('pocket', circle(0, 0, 20)), L('line', circle(0, 0, 14))],
  },
]

const CATEGORY_LABELS: Record<CategoryId, string> = {
  origin: 'Origin',
  bits: 'Bits',
  workstation: 'Workstation',
  trace: 'Trace',
  shop: 'Shop',
  basics: 'Cutouts',
}
const CATEGORY_ORDER: CategoryId[] = ['origin', 'bits', 'workstation', 'trace', 'shop', 'basics']

/** A few Shaper bits side by side, upright, from the bit catalogue's sizes. */
function bitRow(): Layer[] {
  const picks: Bit[] = []
  for (const type of ['flat', 'ball', 'vbit', 'taperedball', 'undercut'] as const) {
    const b = BITS.filter((v) => v.type === type).sort((p, q) => q.diameter - p.diameter)[0]
    if (b) picks.push(b)
  }
  const shanks: Prim[] = []
  const cutters: Prim[] = []
  let cx = 0
  for (const b of picks) {
    const R = b.diameter / 2
    const rs = b.shankDiameter / 2
    const fl = Math.min(b.fluteLength, 40)
    const zs = Math.min(Math.max(15, (b.overallLength ?? fl + 38) - fl), 40)
    const w = Math.max(R, rs) * 2
    const x0 = cx + w / 2
    shanks.push(rect(x0, zs / 2, rs * 2, zs, 0.6))
    if (b.type === 'vbit')
      cutters.push(
        poly([
          { x: x0 - R, y: zs },
          { x: x0 + R, y: zs },
          { x: x0 + R, y: zs + fl * 0.35 },
          { x: x0, y: zs + fl },
          { x: x0 - R, y: zs + fl * 0.35 },
        ]),
      )
    else if (b.type === 'taperedball') {
      const rt = b.tipRadius ?? 0.8
      cutters.push(
        poly([
          { x: x0 - R, y: zs },
          { x: x0 + R, y: zs },
          { x: x0 + rt, y: zs + fl },
          { x: x0 - rt, y: zs + fl },
        ]),
      )
    } else if (b.type === 'undercut') cutters.push(rect(x0, zs + fl / 2, 5, fl), rect(x0, zs + fl - 2.5, R * 2, 5, 0.6))
    else cutters.push(rect(x0, zs + fl / 2, R * 2, fl, b.type === 'flat' ? 0.6 : R))
    cx += w + 7
  }
  return place([L('pocket', ...shanks), L('deep', ...cutters)], -cx / 2, 0)
}

// ---------- A sample insert, laid out with the traced pockets ----------

function sampleInsert(): Layer[] {
  return [
    L('foam', poly(INSERT_OUTLINE)),
    ...place([L('pocket', poly(ANGLE_FENCE))], -90, 98),
    L('ghost', circle(-90, 122, 12)),
    ...place([L('pocket', poly(SUPPORT_ARM))], -90, 25),
    ...place([L('pocket', poly(OPEN_WRENCH))], -88, -42),
    L('ghost', circle(-40, -42, 11)),
    ...place(bitSlots(6, ['pocket', 'deep']), -100, -98),
    ...place(clamp(), 98, 100),
    ...place(shortKey(), 40, -60),
    ...place(tapeRoll(), 136, -46),
    L('ghost', circle(136, -86, 11)),
  ]
}

// ---------- The T-Loc sizes (systainerModel.ts SYS_SIZES; rim and floor heights from there too) ----------

const SYS_SIZES = [
  { size: 1, name: 'Type 105', height: 105, stretch: 0 },
  { size: 2, name: 'Type 157.5', height: 157.5, stretch: 52.5 },
  { size: 3, name: 'Type 210', height: 210, stretch: 105 },
  { size: 4, name: 'Type 315', height: 315, stretch: 210 },
  { size: 5, name: 'Type 420', height: 420, stretch: 315 },
] as const
const SYS_W = 396
const RIM_1 = 80.5
const SYS_FLOOR = 13.8
const rimZ = (stretch: number) => RIM_1 + stretch
const baseDepth = (stretch: number) => Math.floor(rimZ(stretch) - SYS_FLOOR)

/** Front view of one size, every size on the same scale. */
function SizeElevation({ height, stretch }: { height: number; stretch: number }) {
  const rim = rimZ(stretch)
  const top = SYS_SIZES[SYS_SIZES.length - 1].height
  const y = (z: number) => -z
  return (
    <svg className="home-sys-size__art" viewBox={`${-SYS_W / 2 - 8} ${-top - 8} ${SYS_W + 16} ${top + 16}`} aria-hidden="true" focusable="false">
      <rect className="home-sys-size__ghost" x={-SYS_W / 2} y={y(top)} width={SYS_W} height={top} rx={10} />
      <rect className="home-sys-size__base" x={-SYS_W / 2} y={y(rim)} width={SYS_W} height={rim - 4} rx={8} />
      <rect className="home-sys-size__foam" x={-SYS_W / 2 + 14} y={y(rim - 2)} width={SYS_W - 28} height={rim - 2 - SYS_FLOOR} rx={4} />
      <rect className="home-sys-size__lid" x={-SYS_W / 2 - 2} y={y(height)} width={SYS_W + 4} height={height - rim} rx={10} />
      <rect className="home-sys-size__latch" x={-34} y={y(rim + 12)} width={68} height={26} rx={6} />
      <rect className="home-sys-size__feet" x={-SYS_W / 2 + 22} y={y(4)} width={SYS_W - 44} height={4} rx={2} />
    </svg>
  )
}

// ---------- The insert in progress ----------

function savedInsert(): { size: string; items: number } | null {
  try {
    const raw = readScoped(SYNCED_SETTINGS.systainer)
    if (!raw) return null
    const l = JSON.parse(raw) as { size?: unknown; items?: unknown }
    const spec = SYS_SIZES.find((s) => s.size === l.size)
    if (!spec || !Array.isArray(l.items) || l.items.length === 0) return null
    return { size: spec.name, items: l.items.length }
  } catch {
    return null
  }
}

// ---------- Page ----------

const open = () => openToolFromAccount('systainer', 'systainers')

/** The Systainers page of the account home: the tool's sizes and catalogue, and a way in. */
export default function SystainersPage({ units: unitsProp }: { units?: Units } = {}) {
  const units = unitsProp ?? defaultUnits()
  const [cat, setCat] = useState<CategoryId | 'all'>('all')
  const [saved] = useState(savedInsert)
  const u = fmtFor(units)
  const sample = useMemo(() => sampleInsert(), [])
  const bits = useMemo(() => bitRow(), [])
  const gearCount = GEAR.length + BITS.length
  const shown = cat === 'all' ? GEAR : GEAR.filter((g) => g.cats.includes(cat))
  const showBits = cat === 'all' || cat === 'bits'
  const count = shown.length + (showBits ? 1 : 0)

  return (
    <div className="home-sys">
      <header className="home__head">
        <div>
          <h1>Systainers</h1>
          <p className="ss-muted">
            Lay out Shaper gear in a Festool T-Loc Systainer and get a foam insert with a pocket cut to each item’s shape, ready to add to a design and cut.
          </p>
        </div>
        <button className="ss-btn ss-btn--primary" onClick={open}>
          <Ic.IconSystainer size={16} /> New systainer insert
        </button>
      </header>

      {saved && (
        <div className="home__notice home-sys-resume">
          <span>
            Your insert for a {saved.size} has {saved.items} {saved.items === 1 ? 'item' : 'items'}. It opens where you left off.
          </span>
          <button className="ss-btn ss-btn--sm" onClick={open}>
            Continue
          </button>
        </div>
      )}

      <section className="home-sys-hero" aria-label="Systainer Insert">
        <button className="home-sys-hero__art" onClick={open} aria-label="Open Systainer Insert">
          <Drawing layers={sample} pad={8} className="home-sys-hero__svg" />
          <span className="home-sys-hero__tag">Sample insert, {SYS_SIZES[1].name}</span>
        </button>
        <div className="home-sys-hero__text">
          <h2>Pockets that fit your gear</h2>
          <ul className="home-sys-points">
            <li>
              <Ic.IconLayers size={18} />
              <span>
                <strong>Shaped to the item.</strong> Each pocket follows the item’s outline and steps down where it rests lower.
              </span>
            </li>
            <li>
              <Ic.IconCube size={18} />
              <span>
                <strong>Flip it, stand it up.</strong> Turn gear, lay it flat or on edge, and set how deep it sits.
              </span>
            </li>
            <li>
              <Ic.IconSystainer size={18} />
              <span>
                <strong>Traced from ShaperHub.</strong> Workstation parts, wrenches, tape and Trace match community inserts.
              </span>
            </li>
          </ul>
          <dl className="home-sys-stats">
            <div>
              <dt>Sizes</dt>
              <dd>{SYS_SIZES.length}</dd>
            </div>
            <div>
              <dt>Items</dt>
              <dd>{gearCount}</dd>
            </div>
            <div>
              <dt>Shaper bits</dt>
              <dd>{BITS.length}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="home-sys-section" aria-labelledby="home-sys-sizes">
        <div className="home-sys-section__head">
          <h2 id="home-sys-sizes">T-Loc sizes</h2>
          <p className="ss-muted">
            Every size shares the {u.dims(396, 296)} footprint. The insert fills the base, shown on the same scale.
          </p>
        </div>
        <ul className="home-sys-sizes">
          {SYS_SIZES.map((s) => (
            <li key={s.size} className="home-sys-size">
              <SizeElevation height={s.height} stretch={s.stretch} />
              <span className="home-card__name">{s.name}</span>
              <span className="home-card__meta">{u.len(s.height)} tall</span>
              <span className="home-card__meta">Base {u.len(baseDepth(s.stretch))} deep</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="home-sys-section" aria-labelledby="home-sys-catalogue">
        <div className="home-sys-section__head home-sys-section__head--row">
          <div>
            <h2 id="home-sys-catalogue">Catalogue</h2>
            <p className="ss-muted">
              {count} {count === 1 ? 'entry' : 'entries'}. Sizes marked ≈ are estimates: check them against your own gear before cutting.
            </p>
          </div>
          <div className="ss-seg home-sys-filter" role="group" aria-label="Category">
            <button type="button" aria-pressed={cat === 'all'} onClick={() => setCat('all')}>
              All
            </button>
            {CATEGORY_ORDER.map((c) => (
              <button key={c} type="button" aria-pressed={cat === c} onClick={() => setCat(c)}>
                {CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
        </div>
        <ul className="home-grid home-sys-grid">
          {showBits && (
            <li>
              <div className="home-card home-sys-item">
                <div className="home-card__thumb home-sys-item__thumb">
                  <Drawing layers={bits} pad={6} className="home-sys-item__svg" />
                </div>
                <span className="home-card__name">Shaper bits</span>
                <span className="home-card__meta">All {BITS.length}, upright or lying</span>
                <span className="home-sys-item__tags">
                  <span className="ss-badge home-sys-badge">Bit catalogue</span>
                </span>
              </div>
            </li>
          )}
          {shown.map((g) => (
            <li key={g.id}>
              <div className="home-card home-sys-item">
                <div className="home-card__thumb home-sys-item__thumb">
                  <Drawing layers={g.draw()} pad={g.id === 'trace-frame' ? 10 : 6} autoTurn className="home-sys-item__svg" />
                </div>
                <span className="home-card__name" title={g.name}>
                  {g.name}
                </span>
                <span className="home-card__meta" title={g.size(u)}>
                  {g.approx && <span className="home-sys-approx" aria-label="estimated">≈ </span>}
                  {g.size(u)}
                </span>
                <span className="home-sys-item__tags">
                  {g.hub && <span className="ss-badge home-sys-badge">ShaperHub</span>}
                  {g.sized && <span className="ss-badge home-sys-badge home-sys-badge--plain">Set its size</span>}
                  {g.approx && <span className="ss-badge home-sys-badge home-sys-badge--plain">Estimated</span>}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
