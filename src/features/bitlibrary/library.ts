// The user's bit gallery: which catalogue bits they own, plus their own custom bits, persisted
// in this browser. Everything that picks a bit (Plan panel, 3D Carve) reads through here so the
// suggestions reflect the bits the user actually has. All lengths in mm, like the catalogue.
//
// The store is created by a factory so the persistence can be left off in tests (node has no
// localStorage); the app-wide singleton is `bitLibrary` below.
import { createStore, type StoreApi } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { BITS, finish, reachDepth, type Bit, type BitType } from '../carve3d/bits'

/** One owned bit: how many the user has, and their own note ("dull", "in the shop"...). */
export interface OwnedEntry {
  qty: number
  notes: string
  /** ISO date the bit was marked owned. */
  addedAt: string
}

export interface BitLibraryState {
  /** bit id -> ownership. Catalogue ids and `custom-*` ids share this namespace. */
  owned: Record<string, OwnedEntry>
  /** User-added bits, newest last. */
  custom: Bit[]
  setOwned: (id: string, owned: boolean) => void
  setQty: (id: string, qty: number) => void
  setNotes: (id: string, notes: string) => void
  addCustomBit: (input: CustomBitInput) => Bit
  updateCustomBit: (id: string, input: CustomBitInput) => Bit | null
  removeCustomBit: (id: string) => void
}

export type BitLibraryStore = StoreApi<BitLibraryState>

export interface CustomBitInput {
  name: string
  type: BitType
  subtype?: string
  /** Cutting diameter, mm. */
  diameter: number
  /** Defaults to the cutting diameter. */
  shankDiameter?: number
  /** Usable flute length from the tip, mm. */
  fluteLength: number
  overallLength?: number | null
  /** Stated maximum depth, mm; null (the default) lets the flute length be the limit. */
  maxDepth?: number | null
  /** Included angle, degrees (V-bits, tapered ball). */
  angle?: number | null
  flutes?: number | null
  /** V-bit flat tip diameter, mm; 0 = sharp. */
  tipDiameter?: number | null
  /** Tip radius, mm (ball nose, tapered ball); defaults to diameter / 2 for those types. */
  tipRadius?: number | null
  imageUrl?: string | null
  notes?: string
}

const DEFAULT_SUBTYPE: Record<BitType, string> = {
  flat: 'custom flat',
  ball: 'custom ball nose',
  taperedball: 'custom tapered ball',
  vbit: 'custom v-bit',
  undercut: 'custom undercut',
}

/** A well-formed Bit from form input: derived fields filled, nothing left for callers to guess. */
export function customBitFromInput(input: CustomBitInput, id: string): Bit {
  const ballLike = input.type === 'ball' || input.type === 'taperedball'
  return {
    ...finish({
      name: input.name.trim() || 'Untitled bit',
      sku: null,
      type: input.type,
      subtype: input.subtype?.trim() || DEFAULT_SUBTYPE[input.type],
      diameter: input.diameter,
      shankDiameter: input.shankDiameter ?? input.diameter,
      fluteLength: input.fluteLength,
      overallLength: input.overallLength ?? null,
      maxDepth: input.maxDepth ?? null,
      angle: input.angle ?? null,
      flutes: input.flutes ?? null,
      tipDiameter: input.type === 'vbit' ? (input.tipDiameter ?? 0) : null,
      tipRadius: ballLike ? (input.tipRadius ?? input.diameter / 2) : null,
      inBox: false,
      productUrl: null,
      imageUrl: input.imageUrl?.trim() || null,
      // An empty map: the user states everything, so nothing is marked "inferred" (≈) in the UI.
      stated: {},
      notes: input.notes?.trim() ?? '',
    }),
    // finish() derives the id from the SKU; a custom bit carries the caller's id.
    id,
  }
}

const STORAGE_KEY = 'forma.bitLibrary.v1'

function loadSaved(storage: Pick<Storage, 'getItem'> | undefined): { owned: Record<string, OwnedEntry>; custom: Bit[] } {
  const empty = { owned: {}, custom: [] as Bit[] }
  if (!storage) return empty
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return empty
    const parsed = JSON.parse(raw) as Partial<BitLibraryState>
    const owned: Record<string, OwnedEntry> = {}
    for (const [id, e] of Object.entries(parsed.owned ?? {})) {
      if (e && typeof e === 'object' && typeof e.qty === 'number') {
        owned[id] = { qty: Math.min(99, Math.max(1, Math.round(e.qty))), notes: typeof e.notes === 'string' ? e.notes : '', addedAt: typeof e.addedAt === 'string' ? e.addedAt : '' }
      }
    }
    const custom = (Array.isArray(parsed.custom) ? parsed.custom : []).filter(
      (b): b is Bit => !!b && typeof b === 'object' && typeof b.id === 'string' && typeof b.name === 'string' && typeof b.diameter === 'number' && typeof b.fluteLength === 'number',
    )
    return { owned, custom }
  } catch {
    return empty
  }
}

export function createBitLibrary(storage?: Pick<Storage, 'getItem' | 'setItem'>): BitLibraryStore {
  const saved = loadSaved(storage)
  const store = createStore<BitLibraryState>()((set, get) => ({
    owned: saved.owned,
    custom: saved.custom,

    setOwned: (id, owned) =>
      set((s) => {
        if (owned) {
          if (s.owned[id]) return s
          return { owned: { ...s.owned, [id]: { qty: 1, notes: '', addedAt: new Date().toISOString() } } }
        }
        if (!s.owned[id]) return s
        const next = { ...s.owned }
        delete next[id]
        return { owned: next }
      }),

    setQty: (id, qty) =>
      set((s) => {
        const e = s.owned[id]
        if (!e) return s
        return { owned: { ...s.owned, [id]: { ...e, qty: Math.min(99, Math.max(1, Math.round(qty) || 1)) } } }
      }),

    setNotes: (id, notes) =>
      set((s) => {
        const e = s.owned[id]
        if (!e) return s
        return { owned: { ...s.owned, [id]: { ...e, notes } } }
      }),

    addCustomBit: (input) => {
      const bit = customBitFromInput(input, uniqueCustomId(input.name, get().custom))
      set((s) => ({ custom: [...s.custom, bit] }))
      return bit
    },

    updateCustomBit: (id, input) => {
      const existing = get().custom.find((b) => b.id === id)
      if (!existing) return null
      const bit = { ...customBitFromInput(input, id) }
      set((s) => ({ custom: s.custom.map((b) => (b.id === id ? bit : b)) }))
      return bit
    },

    removeCustomBit: (id) =>
      set((s) => {
        const owned = { ...s.owned }
        delete owned[id]
        return { custom: s.custom.filter((b) => b.id !== id), owned }
      }),
  }))

  if (storage) {
    let last = JSON.stringify({ owned: saved.owned, custom: saved.custom })
    store.subscribe((s) => {
      const next = JSON.stringify({ owned: s.owned, custom: s.custom })
      if (next === last) return
      last = next
      try {
        storage.setItem(STORAGE_KEY, next)
      } catch {
        // Private browsing / full quota: the gallery keeps working in memory.
      }
    })
  }
  return store
}

/** custom-<slug> (custom-<slug>-2, -3... when the name repeats). */
function uniqueCustomId(name: string, custom: Bit[]): string {
  const base = 'custom-' + (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bit')
  const taken = new Set(custom.map((b) => b.id))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

/** The whole catalogue the user sees: Shaper's bits first, then their own. */
export function allBits(state: Pick<BitLibraryState, 'custom'>): Bit[] {
  return [...BITS, ...state.custom]
}

export function bitById(state: Pick<BitLibraryState, 'custom'>, id: string): Bit | undefined {
  return allBits(state).find((b) => b.id === id)
}

/** The bits the user owns (catalogue entries and custom bits), catalogue order. */
export function ownedBits(state: Pick<BitLibraryState, 'custom' | 'owned'>): Bit[] {
  return allBits(state).filter((b) => state.owned[b.id])
}

// ---- suggestions ---------------------------------------------------------

/** What the cut needs. Everything optional; the more that is known, the better the ranking. */
export interface SuggestRequest {
  /** Tip depth below the surface, mm. */
  depthMm?: number
  /** Narrowest slot or gap the bit must enter, mm (inside/pocket minimum feature). */
  slotWidthMm?: number
  /** Finest detail width the bit must trace, mm (engraved lines, small inside corners). */
  detailMm?: number
  /** The job the bit is for; shapes the ranking. */
  use?: 'online' | 'guide' | 'inside' | 'outside' | 'pocket' | 'carve' | 'engrave'
}

export interface Suggestion {
  bit: Bit
  /** false = the bit cannot do the job (too deep, too wide); it is still listed, flagged. */
  fits: boolean
  /** Why this bit ranks here, in plain language, strongest reason first. */
  reasons: string[]
  score: number
}

const fmt = (mm: number) => (Number.isInteger(mm) ? String(mm) : mm.toFixed(mm < 10 ? 2 : 1))

/**
 * Rank the catalogue for a cut. Owned bits always sort first — the point of the gallery — and
 * each suggestion carries the reasons it was ranked so the UI can show its work. Bits that do
 * not fit are kept (flagged with fits: false) so the UI can say why a bit was rejected rather
 * than silently hiding it.
 */
export function suggestBits(state: Pick<BitLibraryState, 'custom' | 'owned'>, req: SuggestRequest = {}): Suggestion[] {
  const { depthMm, slotWidthMm, detailMm, use } = req

  const scored = allBits(state).map((bit) => {
    const reasons: string[] = []
    let score = 0
    let fits = true

    // Depth: the planner clamps the pass depth, but a bit that cannot reach at all is out.
    const reach = reachDepth(bit)
    if (depthMm != null && depthMm > 0) {
      if (reach >= depthMm - 1e-6) {
        score += 40
        reasons.push(`reaches ${fmt(reach)} mm`)
      } else {
        fits = false
        reasons.push(`only reaches ${fmt(reach)} mm of ${fmt(depthMm)} mm`)
      }
    }

    // Slot: the bit has to physically enter the feature.
    if (slotWidthMm != null && slotWidthMm > 0) {
      if (bit.diameter <= slotWidthMm + 1e-6) {
        score += 25
        reasons.push(`fits a ${fmt(slotWidthMm)} mm slot`)
      } else {
        fits = false
        reasons.push(`Ø ${fmt(bit.diameter)} mm will not fit ${fmt(slotWidthMm)} mm`)
      }
    }

    // Detail: a flat bit sweeps its whole diameter; a sharp V-bit traces far finer lines.
    if (detailMm != null && detailMm > 0) {
      if (bit.type === 'vbit' && (bit.tipDiameter ?? 0) === 0) {
        score += 30
        reasons.push(`V-point traces finer than ${fmt(detailMm)} mm`)
      } else if (bit.diameter <= detailMm + 1e-6) {
        score += 20
        reasons.push(`narrow enough for ${fmt(detailMm)} mm detail`)
      } else {
        score -= 15
        reasons.push(`too wide for ${fmt(detailMm)} mm detail`)
      }
    }

    // The job itself.
    switch (use) {
      case 'pocket':
        // Clearing area: bigger flat = fewer passes. V-bits and undercutters are the wrong tool.
        if (bit.type === 'flat') score += bit.diameter * 3
        else if (bit.type === 'undercut') {
          score -= 100
          reasons.push('undercutter, wrong shape for clearing')
        } else score -= 10
        break
      case 'carve':
        // 3D carving: ball noses finish curved surfaces; big flats hog roughing passes.
        if (bit.type === 'ball' || bit.type === 'taperedball') score += 25
        else if (bit.type === 'flat') score += bit.diameter
        else score -= 20
        break
      case 'engrave':
        if (bit.type === 'vbit') score += 40
        else score -= 20
        break
      case 'inside':
      case 'outside':
      case 'online':
        // Following lines: narrower bits leave tighter inside corners.
        score += Math.max(0, 20 - bit.diameter * 2)
        break
    }

    // Ownership is the whole point of the gallery.
    if (state.owned[bit.id]) {
      score += 100
      reasons.unshift('in your kit')
    } else if (bit.inBox) {
      // Cold start: the user has not marked anything yet; the box bits are the ones they have.
      score += 10
      reasons.push('ships with every Origin')
    }

    return { bit, fits, reasons, score }
  })

  return scored.sort((a, b) => b.score - a.score)
}

/** Top owned bits for a request; falls back to the full catalogue when nothing owned fits. */
export function suggestOwned(state: Pick<BitLibraryState, 'custom' | 'owned'>, req: SuggestRequest = {}): Suggestion[] {
  const all = suggestBits(state, req)
  const owned = all.filter((s) => state.owned[s.bit.id])
  return owned.length ? owned : all
}

// ---- app-wide singleton --------------------------------------------------

/** The gallery store for the running app, persisted to this browser's storage. */
export const bitLibrary = createBitLibrary(typeof localStorage !== 'undefined' ? localStorage : undefined)

/** React hook: `useBitLibrary((s) => s.owned)`. */
export function useBitLibrary<T>(selector: (s: BitLibraryState) => T): T {
  return useStore(bitLibrary, selector)
}
