// ShaperTape-style domino marker tape: the domino code set and the page layout, all in millimetres.
//
// Written from scratch for Forma Studio. The domino geometry and the code rules were worked out by
// reading these open-source generators (no code was copied from them):
//   - augiev/Shaper-Dominos      https://github.com/augiev/Shaper-Dominos        (WTFPL)
//     43 x 12.7 mm domino, 2.5 mm corners, 2 x 8 dot grid at 5.08 mm, the "10 dots, both end
//     columns lit, not rotationally symmetric" rules.
//   - kirberich/shaper_printer   https://github.com/kirberich/shaper_printer     (MIT)
//     treats a code and its 180 degree rotation as the same domino (452 distinct dominoes).
//   - ap0/shaperpdf              https://github.com/ap0/shaperpdf                (no licence stated)
//     measured dimensions of real tape (1/2" x 1 11/16"), page layout ideas.
//   - heusserurs/ShapertapeGenerator https://github.com/heusserurs/ShapertapeGenerator (no licence stated)
//     cross-check of the dot diameter (2.54 mm) and pitch.
//   - wraybowling/shaper-taper   https://github.com/wraybowling/shaper-taper     (GPL-3.0)
//     the idea of a repeatable, seeded sequence so a sheet can be printed again.
//
// The domino: a black rounded rectangle with a 2 x 8 grid of dot positions. Both end columns are
// always lit (4 dots); the 12 inner positions carry the code, exactly 6 of them lit, so every domino
// shows 10 white dots. A pattern that reads the same after a half turn is not allowed (Origin could
// not tell which way round it is), and a pattern and its half turn are the same physical domino, so
// only one of each pair is kept. That leaves C(12,6) = 924, minus 20 symmetric, halved: 452.

/** Domino body, mm. */
export const DOMINO_W = 43
export const DOMINO_H = 12.7
export const DOMINO_CORNER = 2.5
/** White dot diameter and the dot grid pitch (both axes), mm. */
export const DOT_D = 2.54
export const DOT_PITCH = 5.08
export const DOT_COLS = 8
export const DOT_ROWS = 2

/** Number of inner (code) positions: 6 inner columns x 2 rows. */
const CODE_BITS = 12
const CODE_ONES = 6

/** Reverse the low 12 bits: the code of the same domino turned half a turn. */
export function rotateCode(code: number): number {
  let out = 0
  for (let i = 0; i < CODE_BITS; i++) if (code & (1 << i)) out |= 1 << (CODE_BITS - 1 - i)
  return out
}

function popcount(n: number): number {
  let c = 0
  while (n) {
    n &= n - 1
    c++
  }
  return c
}

/** A code Origin can use: 12 bits, 6 lit, and not the same after a half turn. */
export function isValidCode(code: number): boolean {
  return Number.isInteger(code) && code >= 0 && code < 1 << CODE_BITS && popcount(code) === CODE_ONES && rotateCode(code) !== code
}

/** Of a code and its half turn, the one that names the domino (the smaller). */
export function canonicalCode(code: number): number {
  return Math.min(code, rotateCode(code))
}

let ALL: number[] | null = null
/** Every distinct domino, as its canonical code, ascending. 452 of them. */
export function allCodes(): readonly number[] {
  if (!ALL) {
    ALL = []
    for (let c = 0; c < 1 << CODE_BITS; c++) if (isValidCode(c) && canonicalCode(c) === c) ALL.push(c)
  }
  return ALL
}
export const DOMINO_COUNT = 452

/**
 * The 16 dot positions of a code, column by column, left to right; in each column top then bottom.
 * Index 0..1 and 14..15 are the always-lit end columns; the code's bit i is position i + 2.
 * A half turn maps position p to 15 - p, so it reverses the code's bits (see rotateCode).
 */
export function codeDots(code: number): boolean[] {
  const dots: boolean[] = []
  for (let p = 0; p < DOT_COLS * DOT_ROWS; p++) {
    const col = p >> 1
    dots.push(col === 0 || col === DOT_COLS - 1 ? true : (code & (1 << (p - 2))) !== 0)
  }
  return dots
}

/** Dot centres of a code, relative to the domino's top-left corner, mm. */
export function dotCentres(code: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  codeDots(code).forEach((on, p) => {
    if (!on) return
    const col = p >> 1
    const row = p & 1
    out.push({ x: DOMINO_W / 2 + (col - (DOT_COLS - 1) / 2) * DOT_PITCH, y: DOMINO_H / 2 + (row - 0.5) * DOT_PITCH })
  })
  return out
}

// ---------- Seeded sequence ----------

/** 32-bit FNV-1a hash of a string, used to turn the seed text into a PRNG state. */
function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Small deterministic PRNG (mulberry32), returns floats in [0, 1). */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SEQ_CACHE = new Map<string, number[]>()
/** All 452 dominoes in the order the seed shuffles them. The same seed always gives the same order. */
export function sequenceFor(seed: string): readonly number[] {
  const hit = SEQ_CACHE.get(seed)
  if (hit) return hit
  const seq = allCodes().slice()
  const rnd = prng(hashString(seed))
  for (let i = seq.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const t = seq[i]
    seq[i] = seq[j]
    seq[j] = t
  }
  if (SEQ_CACHE.size > 32) SEQ_CACHE.clear()
  SEQ_CACHE.set(seed, seq)
  return seq
}

/**
 * `count` dominoes from the seed's sequence starting at position `start` (0-based). Never repeats a
 * domino: the count is capped at 452. Runs past the end wrap to the start of the sequence (`wrapped`),
 * which reuses dominoes an earlier sheet from the same seed may already have.
 */
export function pickCodes(seed: string, start: number, count: number): { codes: number[]; wrapped: boolean; capped: boolean } {
  const seq = sequenceFor(seed)
  const n = seq.length
  const want = Math.max(0, Math.floor(count))
  const take = Math.min(want, n)
  const s = ((Math.floor(start) % n) + n) % n
  const codes: number[] = []
  for (let i = 0; i < take; i++) codes.push(seq[(s + i) % n])
  return { codes, wrapped: s + take > n, capped: want > n }
}

// ---------- Page layout ----------

export type PagePreset = 'letter' | 'a4' | 'custom'
export type Orientation = 'portrait' | 'landscape'
/** Strips: separate tape strips with cut lines. Sheet: a full grid of dominoes for sticker paper. */
export type TapeMode = 'strips' | 'sheet'

export const PAGE_SIZES: Record<Exclude<PagePreset, 'custom'>, { w: number; h: number; label: string }> = {
  letter: { w: 215.9, h: 279.4, label: 'Letter' },
  a4: { w: 210, h: 297, label: 'A4' },
}

export interface TapeOptions {
  page: PagePreset
  /** Custom page size, mm (portrait sense; orientation still applies). */
  customW: number
  customH: number
  orientation: Orientation
  /** Margin on every side, mm. Most printers cannot print the outer 5 mm or so. */
  margin: number
  mode: TapeMode
  /** Strips mode: how many strips; 0 = as many as fit. */
  stripCount: number
  /** Strips mode: strip length, mm; 0 = the full printable width. */
  stripLength: number
  /** Gap between dominoes along a strip (and across a sheet row), mm. */
  dominoGap: number
  /** Strips mode: gap between strips, mm (0 = strips share a cut line). Sheet mode: gap between rows. */
  rowGap: number
  /** Seed of the shuffled sequence and where on it this sheet starts (0-based). */
  seed: string
  start: number
  /** Draw the scale-check ruler and the sheet label in the bottom margin band. */
  footer: boolean
}

export const DEFAULT_TAPE_OPTIONS: TapeOptions = {
  page: 'letter',
  customW: 210,
  customH: 297,
  orientation: 'portrait',
  margin: 10,
  mode: 'strips',
  stripCount: 0,
  stripLength: 0,
  dominoGap: 4,
  rowGap: 0,
  seed: 'forma',
  start: 0,
  footer: true,
}

/** White tape on each long side of a strip's dominoes, and before the first / after the last, mm. */
export const STRIP_PAD = 1.2
export const STRIP_END_PAD = 2
/** Height of the footer band (ruler + label) and the clear space above it, mm. */
export const FOOTER_H = 8
export const FOOTER_GAP = 4
/** The scale-check bars, mm. */
export const RULER_MM = 50
export const RULER_IN_MM = 2 * 25.4

export interface PlacedDomino {
  x: number
  y: number
  code: number
  /** 1-based position of this domino on the seed's sequence. */
  id: number
}
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
export interface TapeLayout {
  /** Page size, mm. */
  w: number
  h: number
  /** Strip outlines to cut along (strips mode only). */
  strips: Rect[]
  dominoes: PlacedDomino[]
  /** Footer band (ruler and label), or null when off or there is no room. */
  footer: Rect | null
  /** The label printed in the footer. */
  label: string
  /** 1-based sequence positions on this sheet, e.g. "1–24" or "440–452, 1–12". */
  range: string
  /** Dominoes per strip / row, rows. */
  perRow: number
  rows: number
  /** Next unused start position on the sequence (0-based, wraps at 452). */
  nextStart: number
  wrapped: boolean
  capped: boolean
  /** Something the user should change (too small a page, etc.), or null. */
  problem: string | null
}

export function pageSize(o: Pick<TapeOptions, 'page' | 'customW' | 'customH' | 'orientation'>): { w: number; h: number } {
  const base = o.page === 'custom' ? { w: Math.max(1, o.customW), h: Math.max(1, o.customH) } : PAGE_SIZES[o.page]
  const lo = Math.min(base.w, base.h)
  const hi = Math.max(base.w, base.h)
  return o.orientation === 'landscape' ? { w: hi, h: lo } : { w: lo, h: hi }
}

/** How many items of size `size` separated by `gap` fit in `avail`. */
function fitCount(avail: number, size: number, gap: number): number {
  if (avail < size) return 0
  return Math.floor((avail + gap + 1e-9) / (size + gap))
}

/** Lay a sheet out: strips (or a sheet grid) of dominoes inside the margins, footer at the bottom. */
export function layoutTape(opts: TapeOptions): TapeLayout {
  const { w, h } = pageSize(opts)
  const margin = Math.max(0, opts.margin)
  const gap = Math.max(0, opts.dominoGap)
  const rowGap = Math.max(0, opts.rowGap)
  const areaX = margin
  const areaY = margin
  const areaW = w - 2 * margin
  let areaH = h - 2 * margin

  let footer: Rect | null = null
  if (opts.footer && areaW >= RULER_MM && areaH >= FOOTER_H + FOOTER_GAP + DOMINO_H) {
    footer = { x: areaX, y: areaY + areaH - FOOTER_H, w: areaW, h: FOOTER_H }
    areaH -= FOOTER_H + FOOTER_GAP
  }

  const strips: Rect[] = []
  const slots: { x: number; y: number }[] = []
  let perRow = 0
  let rows = 0

  if (opts.mode === 'strips') {
    const stripH = DOMINO_H + 2 * STRIP_PAD
    const wantLen = opts.stripLength > 0 ? Math.min(opts.stripLength, areaW) : areaW
    perRow = fitCount(wantLen - 2 * STRIP_END_PAD, DOMINO_W, gap)
    const fitRows = fitCount(areaH, stripH, rowGap)
    rows = opts.stripCount > 0 ? Math.min(Math.floor(opts.stripCount), fitRows) : fitRows
    if (perRow > 0) {
      const stripW = perRow * DOMINO_W + (perRow - 1) * gap + 2 * STRIP_END_PAD
      for (let r = 0; r < rows; r++) {
        const sy = areaY + r * (stripH + rowGap)
        strips.push({ x: areaX, y: sy, w: stripW, h: stripH })
        for (let c = 0; c < perRow; c++) slots.push({ x: areaX + STRIP_END_PAD + c * (DOMINO_W + gap), y: sy + STRIP_PAD })
      }
    }
  } else {
    perRow = fitCount(areaW, DOMINO_W, gap)
    rows = fitCount(areaH, DOMINO_H, rowGap)
    // Centre the grid in the printable area, so sticker paper is evenly covered.
    const gridW = perRow * DOMINO_W + Math.max(0, perRow - 1) * gap
    const gridH = rows * DOMINO_H + Math.max(0, rows - 1) * rowGap
    const ox = areaX + Math.max(0, (areaW - gridW) / 2)
    const oy = areaY + Math.max(0, (areaH - gridH) / 2)
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < perRow; c++) slots.push({ x: ox + c * (DOMINO_W + gap), y: oy + r * (DOMINO_H + rowGap) })
  }

  const pick = pickCodes(opts.seed, opts.start, slots.length)
  const n = sequenceFor(opts.seed).length
  const s0 = ((Math.floor(opts.start) % n) + n) % n
  const dominoes: PlacedDomino[] = pick.codes.map((code, i) => ({ ...slots[i], code, id: ((s0 + i) % n) + 1 }))
  // Capped sheets leave their extra slots empty; drop the empty strips at the end.
  if (pick.capped && opts.mode === 'strips' && perRow > 0) strips.length = Math.ceil(dominoes.length / perRow)

  let problem: string | null = null
  if (areaW <= 0 || areaH <= 0) problem = 'The margins leave no room on the page.'
  else if (dominoes.length === 0)
    problem = opts.mode === 'strips' && opts.stripLength > 0 && opts.stripLength < DOMINO_W + 2 * STRIP_END_PAD
      ? 'The strip is shorter than one domino.'
      : 'No domino fits inside the margins.'

  const first = dominoes.length ? dominoes[0].id : 0
  const last = dominoes.length ? dominoes[dominoes.length - 1].id : 0
  const range = !dominoes.length ? '' : last >= first ? `${first}–${last}` : `${first}–${n}, 1–${last}`
  const label = dominoes.length ? `Seed "${opts.seed}" · dominoes ${range} of ${n} · print at 100% scale` : `Seed "${opts.seed}"`

  return {
    w,
    h,
    strips,
    dominoes,
    footer,
    label,
    range,
    perRow,
    rows: opts.mode === 'strips' ? strips.length : rows,
    nextStart: (s0 + dominoes.length) % n,
    wrapped: pick.wrapped,
    capped: pick.capped,
    problem,
  }
}

// ---------- Footer: scale-check ruler and label ----------

export interface FooterParts {
  /** Solid bars (ruler bodies and tick marks), mm. */
  bars: Rect[]
  /** Text runs: left x or right x (anchor), baseline y, size, mm. */
  texts: { x: number; y: number; size: number; text: string; anchor: 'start' | 'end' }[]
}

/**
 * The footer band: a 50 mm bar and a 2 in bar with ticks (measure them with a ruler to check the
 * print scale) and the sheet label on the right.
 */
export function footerParts(footer: Rect, label: string): FooterParts {
  const bars: Rect[] = []
  const texts: FooterParts['texts'] = []
  const bar = 1.2
  const tick = 1.6
  const t = 0.3
  const y = footer.y + footer.h - 3.2
  const size = 2.3
  /** Rough width of a run of sans-serif text, mm. */
  const textW = (s: string) => s.length * size * 0.52
  const ruler = (x0: number, len: number, step: number, name: string) => {
    bars.push({ x: x0, y, w: len, h: bar })
    for (let d = 0; d <= len + 1e-6; d += step) bars.push({ x: Math.max(x0, Math.min(x0 + d - t / 2, x0 + len - t)), y: y - tick, w: t, h: tick })
    texts.push({ x: x0, y: y - tick - 0.8, size, text: name, anchor: 'start' })
  }
  const right = footer.x + footer.w
  let x = footer.x
  ruler(x, RULER_MM, 10, `${RULER_MM} mm`)
  x += RULER_MM + 8
  // The label wants the space more than the inch bar; the short label is the last resort.
  const short = label.replace(/ · print at 100% scale$/, '')
  if (right - x >= RULER_IN_MM + 8 + textW(short)) {
    ruler(x, RULER_IN_MM, 25.4 / 2, '2 in')
    x += RULER_IN_MM + 8
  }
  const text = right - x >= textW(label) ? label : right - x >= textW(short) ? short : ''
  if (text) texts.push({ x: right, y: y + bar, size, text, anchor: 'end' })
  return { bars, texts }
}
