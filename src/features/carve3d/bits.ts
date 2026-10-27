// Shaper cutter catalogue, transcribed from docs/research/shaper-bits.json (retrieved 2026-10-18)
// plus the profile maths used for top-down carving. All lengths in mm.
// Anything Shaper does not state is listed in `inferred` and shown with "≈" in the UI.

export type BitType = 'flat' | 'ball' | 'taperedball' | 'vbit' | 'undercut'
export type BitGroup = 'origin' | 'flat' | 'ball' | 'engraving' | 'specialty'
export type BitField = 'diameter' | 'shankDiameter' | 'fluteLength' | 'overallLength' | 'angle' | 'flutes' | 'tipDiameter' | 'tipRadius'

export interface Bit {
  /** SKU, or a slug of the name when Shaper gives no SKU. */
  id: string
  /** Exactly as Shaper lists it. */
  name: string
  sku: string | null
  type: BitType
  subtype: string
  group: BitGroup
  /** Cutting diameter, mm. */
  diameter: number
  shankDiameter: number
  /** Usable flute length measured from the tip, mm. */
  fluteLength: number
  /** Overall length, mm. null when Shaper does not state it. */
  overallLength: number | null
  /**
   * Deepest the tip may go below the surface, as Shaper states it (product page "max depth" /
   * "usable length"), mm. null = not stated: the flute length is the limit ("never attempt to cut
   * deeper than the cutting flute length", Shaper's stock-bit guide). See reachDepth.
   */
  maxDepth: number | null
  /** Included angle, degrees (V-bits, tapered ball). */
  angle: number | null
  flutes: number | null
  /** V-bit flat tip diameter, mm. 0 = sharp point. */
  tipDiameter: number | null
  /** Tip radius, mm (ball nose and tapered ball). */
  tipRadius: number | null
  spiral: boolean
  inBox: boolean
  productUrl: string | null
  notes: string
  /** true = Shaper states the value, false = derived by us, absent = not applicable. */
  stated: Partial<Record<BitField, boolean>>
  /** Fields whose numbers are inferred rather than stated. */
  inferred: BitField[]
  /** Top-down 2.5D carving only works for bits that do not undercut. */
  carvable: boolean
  carveReason: string | null
}

type Raw = Omit<Bit, 'id' | 'group' | 'spiral' | 'inferred' | 'carvable' | 'carveReason'>

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

function finish(r: Raw): Bit {
  const inferred = (Object.keys(r.stated) as BitField[]).filter((k) => r.stated[k] === false && r[k] !== null && r[k] !== undefined)
  let group: BitGroup
  if (r.inBox) group = 'origin'
  else if (r.type === 'undercut' || /roughing|clearing/.test(r.subtype)) group = 'specialty'
  else if (r.type === 'flat') group = 'flat'
  else if (r.type === 'ball' || r.type === 'taperedball') group = 'ball'
  else group = 'engraving'
  const undercut = r.type === 'undercut'
  return {
    ...r,
    id: r.sku ?? slug(r.name),
    group,
    spiral: /spiral/.test(r.subtype),
    inferred,
    carvable: !undercut,
    carveReason: undercut ? 'T-slot and dovetail cutters undercut the material, so a top-down pass cannot reach the groove sides.' : null,
  }
}

const SHAPER = 'https://www.shapertools.com/en-us/store/product/'

/** The catalogue, in the order of docs/research/shaper-bits.json. */
export const BITS: Bit[] = [
  finish({
    name: '1/4" X 1" Up-Spiral Flat Router Bit', sku: 'SE1-2500-1000C', type: 'flat', subtype: 'upcut spiral',
    diameter: 6.35, shankDiameter: 6.35, fluteLength: 25.4, overallLength: 63.5, maxDepth: 25.4, angle: null, flutes: 2, tipDiameter: null, tipRadius: null,
    inBox: false, productUrl: SHAPER + '1-4-in-x-1-in-up-spiral-flat-router-bit',
    notes: 'Max depth 1 in. Two flutes inferred from "dual flute geometry". Origin ships a 1/4 in collet.',
    stated: { diameter: true, shankDiameter: true, fluteLength: true, overallLength: true, flutes: false },
  }),
  finish({
    name: '1/4" X 3/4" Up-Spiral Ball Nose Router Bit', sku: 'SE1-2500-BNUS', type: 'ball', subtype: 'ball nose up-spiral',
    diameter: 6.35, shankDiameter: 6.35, fluteLength: 19.05, overallLength: 63.5, maxDepth: 19.05, angle: null, flutes: null, tipDiameter: null, tipRadius: 3.175,
    inBox: false, productUrl: SHAPER + '1-4-in-x-3-4-in-up-spiral-ball-nose-router-bit',
    notes: 'Max depth 0.75 in. Full hemispherical tip (radius D/2) inferred, not stated.',
    stated: { diameter: true, shankDiameter: true, fluteLength: true, overallLength: true, tipRadius: false },
  }),
  finish({
    name: '11° Tapered Ball Nose Router Bit', sku: 'SE1-2500-TB10M', type: 'taperedball', subtype: 'tapered ball nose',
    diameter: 6.35, shankDiameter: 6.35, fluteLength: 25.4, overallLength: 63.5, maxDepth: null, angle: 11, flutes: null, tipDiameter: null, tipRadius: 0.79375,
    inBox: false, productUrl: 'https://dealer.shapertools.com/products/11-deg-tapered-ball-nose-router-bit',
    notes: 'Cutting diameter range 1/16 to 1/4 in from the support guide; the 1/4 in maximum is used. Tip ball diameter 1/32 in inferred. Flute count conflicts between Shaper pages, so not shown.',
    stated: { diameter: false, shankDiameter: true, fluteLength: true, overallLength: true, angle: true, tipRadius: false },
  }),
  finish({
    name: '5mm T-Slot Router Bit', sku: 'SF1-8-TSC', type: 'undercut', subtype: 't-slot',
    diameter: 10.5, shankDiameter: 8, fluteLength: 13, overallLength: 50, maxDepth: null, angle: null, flutes: null, tipDiameter: null, tipRadius: null,
    inBox: false, productUrl: 'https://www.shapertools.com/en-de/store/product/5-mm-t-slot-router-bit',
    notes: 'Neck diameter 5 mm, second flute length 5 mm. Fits the 8 mm collet kit.',
    stated: { diameter: true, shankDiameter: true, fluteLength: true, overallLength: true },
  }),
  finish({
    name: '15° Dovetail Router Bit', sku: 'SF1-8-DC15', type: 'undercut', subtype: 'dovetail',
    diameter: 13.8, shankDiameter: 8, fluteLength: 13.5, overallLength: 46, maxDepth: null, angle: 15, flutes: null, tipDiameter: null, tipRadius: null,
    inBox: false, productUrl: null,
    notes: 'Specs from the Shaper support guide table. No Shaper product page found.',
    stated: { diameter: true, shankDiameter: true, fluteLength: true, overallLength: true, angle: true },
  }),
  finish({
    name: '1/8" X 1/4" Up-Spiral O-flute Router Bit', sku: 'SE1-2500-2500C', type: 'flat', subtype: 'O-flute upcut spiral',
    diameter: 3.175, shankDiameter: 6.35, fluteLength: 6.35, overallLength: 50.8, maxDepth: 6.35, angle: null, flutes: null, tipDiameter: null, tipRadius: null,
    inBox: false, productUrl: SHAPER + '1-8-in-x-1-4-in-up-spiral-o-flute-router-bit',
    notes: 'Product page OAL 2 in (support guide says 2.5 in). Max depth 1/4 in. For acrylics and non-ferrous metals.',
    stated: { diameter: true, shankDiameter: true, fluteLength: true, overallLength: true },
  }),
  finish({
    name: '1/8" X 1/2" Up-Spiral Flat Router Bit', sku: 'SE1-2500-1250U', type: 'flat', subtype: 'upcut spiral',
    diameter: 3.175, shankDiameter: 6.35, fluteLength: 12.7, overallLength: 50.8, maxDepth: null, angle: null, flutes: null, tipDiameter: null, tipRadius: null,
    inBox: false, productUrl: SHAPER + '1-8-in-x-1-2-in-up-spiral-flat-router-bit',
    notes: 'Support guide lists this geometry under SE1-2500-5000C with a 2.5 in OAL. Verify with Shaper before use.',
    stated: { diameter: true, shankDiameter: true, fluteLength: true, overallLength: true },
  }),
  finish({
    name: '1/4" X 1-1/2" Up-Spiral O-flute Router Bit', sku: 'SE1-2500-1500C', type: 'flat', subtype: 'O-flute upcut spiral',
    diameter: 6.35, shankDiameter: 6.35, fluteLength: 38.1, overallLength: 76.2, maxDepth: null, angle: null, flutes: null, tipDiameter: null, tipRadius: null,
    inBox: false, productUrl: null,
    notes: 'From the Shaper support guide table only. Non-ferrous metals per Shaper.',
    stated: { diameter: true, shankDiameter: true, fluteLength: true, overallLength: true },
  }),
  finish({
    name: '90° Engraving Router Bit', sku: 'SE1-2500-V90E', type: 'vbit', subtype: 'engraving 90 deg',
    diameter: 6.35, shankDiameter: 6.35, fluteLength: 3.175, overallLength: 38.1, maxDepth: null, angle: 90, flutes: 2, tipDiameter: 0, tipRadius: null,
    inBox: false, productUrl: SHAPER + '90-deg-engraving-router-bit',
    notes: 'Cutting diameter not stated; 1/4 in inferred from the 1/8 in cutter length at 90 degrees. Sharp tip inferred. Recommended engraving depth about 0.5 mm.',
    stated: { diameter: false, shankDiameter: true, fluteLength: true, overallLength: true, angle: true, flutes: true, tipDiameter: false },
  }),
  finish({
    name: '3 mm Up-spiral Router Bit', sku: 'SF1-8-3U', type: 'flat', subtype: 'upcut spiral',
    diameter: 3, shankDiameter: 8, fluteLength: 10, overallLength: 45, maxDepth: 10, angle: null, flutes: null, tipDiameter: null, tipRadius: null,
    inBox: false, productUrl: 'https://www.shapertools.com/en-gb/store/product/3-mm-up-spiral-router-bit',
    notes: 'Max depth 10 mm.',
    stated: { diameter: true, shankDiameter: true, fluteLength: true, overallLength: true },
  }),
  finish({
    name: '4mm X 15mm Up-Spiral Flat', sku: 'SF1-8-4F2', type: 'flat', subtype: 'upcut spiral',
    diameter: 4, shankDiameter: 8, fluteLength: 15, overallLength: 80, maxDepth: null, angle: null, flutes: null, tipDiameter: null, tipRadius: null,
    inBox: false, productUrl: null,
    notes: 'From the Shaper support guide table only.',
    stated: { diameter: true, shankDiameter: true, fluteLength: true, overallLength: true },
  }),
  finish({
    name: '6mm X 30mm Up-Spiral Flat Router Bit', sku: 'SF1-8-6F3', type: 'flat', subtype: 'upcut spiral',
    diameter: 6, shankDiameter: 8, fluteLength: 30, overallLength: 80, maxDepth: 45, angle: null, flutes: 3, tipDiameter: null, tipRadius: null,
    inBox: false, productUrl: SHAPER + '6-mm-x-30-mm-up-spiral-flat-router-bit',
    notes: 'Usable length 45 mm. Fits the 8 mm collet.',
    stated: { diameter: true, shankDiameter: true, fluteLength: true, overallLength: true, flutes: true },
  }),
  finish({
    name: '5mm X 20mm Up-Spiral O-flute Router Bit', sku: 'SF1-8-5D', type: 'flat', subtype: 'O-flute upcut spiral',
    diameter: 5, shankDiameter: 8, fluteLength: 20, overallLength: 78, maxDepth: 30, angle: null, flutes: null, tipDiameter: null, tipRadius: null,
    inBox: false, productUrl: SHAPER + '5-mm-x-20-mm-up-spiral-o-flute-router-bit',
    notes: 'Usable length 30 mm. Flute count not stated.',
    stated: { diameter: true, shankDiameter: true, fluteLength: true, overallLength: true },
  }),
  finish({
    name: '8mm X 35mm Up-Spiral Flat Router Bit', sku: 'SF1-8-8DP', type: 'flat', subtype: 'upcut spiral',
    diameter: 8, shankDiameter: 8, fluteLength: 35, overallLength: 80, maxDepth: 45, angle: null, flutes: 3, tipDiameter: null, tipRadius: null,
    inBox: false, productUrl: SHAPER + '8-mm-x-35-mm-up-spiral-flat-router-bit',
    notes: 'Product page OAL 80 mm (support guide says 85 mm). Max depth 45 mm.',
    stated: { diameter: true, shankDiameter: true, fluteLength: true, overallLength: true, flutes: true },
  }),
  finish({
    name: '8mm X 35mm Roughing Bit', sku: 'SF1-8-8R', type: 'flat', subtype: 'roughing',
    diameter: 8, shankDiameter: 8, fluteLength: 35, overallLength: 80, maxDepth: 45, angle: null, flutes: 3, tipDiameter: null, tipRadius: null,
    inBox: false, productUrl: SHAPER + '8-mm-x-35-mm-roughing-bit',
    notes: 'For rough passes at high feed. Max depth 45 mm.',
    stated: { diameter: true, shankDiameter: true, fluteLength: true, overallLength: true, flutes: true },
  }),
  finish({
    name: '16mm X 16mm Clearing Router Bit', sku: 'SF1-8-16D', type: 'flat', subtype: 'clearing (3-flute)',
    diameter: 16, shankDiameter: 8, fluteLength: 16, overallLength: 73, maxDepth: null, angle: null, flutes: 3, tipDiameter: null, tipRadius: null,
    inBox: false, productUrl: SHAPER + '16-mm-x-16-mm-clearing-router-bit',
    notes: 'Product page OAL 73 mm (support guide says 65 mm). Takes 12 mm roughing passes.',
    stated: { diameter: true, shankDiameter: true, fluteLength: true, overallLength: true, flutes: true },
  }),
  finish({
    name: '1/4" 60° Engraving Router Bit', sku: 'SE1-2500-V60E', type: 'vbit', subtype: 'engraving 60 deg',
    diameter: 6.35, shankDiameter: 6.35, fluteLength: 6.35, overallLength: 38.1, maxDepth: null, angle: 60, flutes: null, tipDiameter: 0, tipRadius: null,
    inBox: true, productUrl: SHAPER + '1-4-in-60-deg-engraving-router-bit',
    notes: 'Stated cut diameter 1/4 in, which may be the shank-side value. Recommended depth about 0.5 mm. Ships with Origin.',
    stated: { diameter: true, shankDiameter: true, fluteLength: true, overallLength: true, angle: true, tipDiameter: false },
  }),
  finish({
    name: '8mm 60° Engraving Router Bit', sku: 'SF1-8-V60E', type: 'vbit', subtype: 'engraving 60 deg',
    diameter: 8.198, shankDiameter: 8, fluteLength: 7.1, overallLength: 54.5, maxDepth: null, angle: 60, flutes: null, tipDiameter: 0, tipRadius: null,
    inBox: false, productUrl: 'https://www.shapertools.com/en-no/store/product/8-mm-60-deg-engraving-router-bit',
    notes: 'Cutting diameter inferred from the 60 degree angle and 7.1 mm cutter length. Sharp tip inferred.',
    stated: { diameter: false, shankDiameter: true, fluteLength: true, overallLength: true, angle: true, tipDiameter: false },
  }),
  finish({
    name: '1/4" / 6mm Upcut Spiral Cutter (in Origin box)', sku: null, type: 'flat', subtype: 'upcut spiral',
    diameter: 6.35, shankDiameter: 6.35, fluteLength: 19.05, overallLength: null, maxDepth: 19.05, angle: null, flutes: null, tipDiameter: null, tipRadius: null,
    inBox: true, productUrl: 'https://support.shapertools.com/hc/en-us/articles/115002985634-guide-to-stock-bits',
    notes: 'Included with Origin (UC . 1/4 . 3/4). Stock-bit guide: cuts 1/4 in per pass up to a maximum depth of 3/4 in. The 1/4 in shank is implied by the collet.',
    stated: { diameter: true, shankDiameter: false, fluteLength: true },
  }),
  finish({
    name: '1/8" / 3mm Upcut Spiral Cutter (in Origin box)', sku: null, type: 'flat', subtype: 'upcut spiral',
    diameter: 3.175, shankDiameter: 6.35, fluteLength: 12.7, overallLength: null, maxDepth: 12.7, angle: null, flutes: null, tipDiameter: null, tipRadius: null,
    inBox: true, productUrl: 'https://support.shapertools.com/hc/en-us/articles/115002985634-guide-to-stock-bits',
    notes: 'Included with Origin (UC . 1/8 . 1/2). Stock-bit guide: the flute length limits the total cut depth to 1/2 in. The 1/4 in shank is inferred. The 1/8 in collet is sold separately.',
    stated: { diameter: true, shankDiameter: false, fluteLength: true },
  }),
]

/**
 * Origin's Z travel: the deepest any cut can go, whatever the bit (43 mm, Shaper's spec).
 * https://www.shapertools.com/en-de/origin
 */
export const ORIGIN_MAX_DEPTH = 43

/**
 * Bit length lost to the collet and spindle, mm: what is left of the bit below the stock face
 * at full plunge is its overall length minus this. 35 mm matches Shaper's own clamp-marked bits
 * (80 mm long, 45 mm usable). A user setting — it depends on how deep the bit is seated.
 */
export const HOLDER_ALLOWANCE = 35

/**
 * How deep this bit can cut on Origin, mm. Shaper's stated max depth wins where there is one.
 * Otherwise the bit reaches as far as it sticks out (overall length − holder allowance), at least
 * its flutes: the planner keeps the shank clear of every wall, so a bit may follow its own cut
 * past the flutes. Never past Origin's Z travel.
 */
export function reachDepth(bit: Bit, holder = HOLDER_ALLOWANCE): number {
  const stickOut = bit.overallLength != null ? bit.overallLength - holder : 0
  return Math.min(ORIGIN_MAX_DEPTH, bit.maxDepth ?? Math.max(bit.fluteLength, stickOut))
}

/** The in-box 1/4" upcut is the default selection (fallback: SE1-2500-1000C). */
export const DEFAULT_BIT_ID: string =
  BITS.find((b) => b.inBox && b.type === 'flat' && b.sku === null && Math.abs(b.diameter - 6.35) < 1e-9)?.id ?? 'SE1-2500-1000C'

export function defaultBit(): Bit {
  return BITS.find((b) => b.id === DEFAULT_BIT_ID) ?? BITS[0]
}

const rad = (deg: number) => (deg * Math.PI) / 180

/** Cone half-angle of a tapered ball, from its included angle (11 degrees gives 5.5). */
export const taperHalfAngle = (bit: Bit) => rad((bit.angle ?? 11) / 2)

/**
 * Radius of the cutting profile at height h (mm) above the tip. Monotonic non-decreasing,
 * capped at diameter / 2. This is the pure profile; see carvePlan.reachRadius for the
 * radius that also accounts for the shank above the flutes.
 *
 * Profiles:
 *  - flat / upcut / O-flute / roughing / clearing: r = D/2 at all heights.
 *  - ball nose: sphere of radius D/2 centred at height D/2.
 *  - tapered ball: sphere of tip radius rt, then a cone of half-angle a tangent to it.
 *    The tangent point is at height rt(1 − sin a) with radius rt·cos a.
 *  - V-bit / engraver: cone from the tip flat, radius grows by tan(θ/2) per mm.
 *  - undercut (T-slot, dovetail): drawn and treated as a flat cylinder, never carved.
 *
 * Sanity values:
 *  - 1/4" ball (R 3.175) at h 0.5 -> sqrt(R² − (R−0.5)²) ≈ 1.2
 *  - 60° V-bit (sharp) at h 1    -> tan 30° ≈ 0.577
 *  - 11° tapered ball (tip R 0.79375) at h 1 -> on the cone, past the tangent point
 */
export function radiusAtHeight(bit: Bit, h: number): number {
  const R = bit.diameter / 2
  const y = Math.max(0, h)
  switch (bit.type) {
    case 'flat':
    case 'undercut':
      return R
    case 'ball':
      return y < R ? Math.sqrt(Math.max(0, R * R - (R - y) * (R - y))) : R
    case 'vbit': {
      const t = (bit.tipDiameter ?? 0) / 2
      const k = Math.tan(rad((bit.angle ?? 90) / 2))
      return Math.min(R, t + y * k)
    }
    case 'taperedball': {
      const rt = bit.tipRadius ?? 0.79375
      const a = taperHalfAngle(bit)
      const hT = rt * (1 - Math.sin(a))
      if (y <= hT) return Math.min(R, Math.sqrt(Math.max(0, rt * rt - (rt - y) * (rt - y))))
      return Math.min(R, rt * Math.cos(a) + (y - hT) * Math.tan(a))
    }
  }
  return R
}

/** Height above the tip where a V-bit's cone reaches full diameter (Infinity for other bits). */
export function coneHeight(bit: Bit): number {
  if (bit.type !== 'vbit') return Infinity
  const t = (bit.tipDiameter ?? 0) / 2
  const k = Math.tan(rad((bit.angle ?? 90) / 2))
  return k > 0 ? (bit.diameter / 2 - t) / k : Infinity
}
