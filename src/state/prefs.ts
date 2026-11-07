// Account-wide presets: what a new design and a new shape start with, so the user does not
// set units, grid, snapping and cut settings again on every design. Set on the account
// page's Settings tab. Local-first like the bit gallery: saved on this device, per storage
// space, and synced to the account when signed in (src/storage/).
import { create } from 'zustand'
import { onRemoteSetting, readScoped, scopedKey, SYNCED_SETTINGS, writeScoped } from '../storage/space'
import { DEFAULT_CUT, SNAP_KINDS, type CutSettings, type CutType, type DocSettings, type SnapKind, type Units } from '../model/types'

export interface Prefs {
  /** Units for new designs; unset means the units last picked in the studio. */
  units?: Units
  /** Grid spacing in mm for new designs; unset means 1 in or 10 mm by the units. */
  gridSize?: number
  smartAlignment: boolean
  snap: Record<SnapKind, boolean>
  showPosition: boolean
  showGrid: boolean
  snapToGrid: boolean
  positionLabels: boolean
  originAnchor: boolean
  cutPathDisplay: boolean
  /** Cut for new closed shapes. Open paths (pen, freehand) still start as On Line. */
  cutType: CutType
  /** Bit diameter in mm for new shapes. */
  bitDia: number
  /** Cut depth in mm for new shapes; null leaves it unset, as Studio does. */
  depth: number | null
  /**
   * Mouse controls in the studio: 'zoom' scrolls to zoom and middle-button drag pans, as Studio
   * does; 'pan' swaps the two. Ctrl/cmd + scroll stays zoom either way (it is pinch on a trackpad).
   */
  mouseNav: 'zoom' | 'pan'
}

export const DEFAULT_PREFS: Prefs = {
  smartAlignment: true,
  snap: Object.fromEntries(SNAP_KINDS.map((k) => [k, true])) as Record<SnapKind, boolean>,
  showPosition: false,
  showGrid: false,
  snapToGrid: false,
  positionLabels: false,
  originAnchor: false,
  cutPathDisplay: false,
  cutType: DEFAULT_CUT.type,
  bitDia: DEFAULT_CUT.bitDia,
  depth: DEFAULT_CUT.depth,
  mouseNav: 'zoom',
}

const KEY = SYNCED_SETTINGS.prefs
const CUT_TYPES: CutType[] = ['online', 'guide', 'inside', 'pocket', 'outside']

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
const positive = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)

/** Saved prefs, with anything missing or malformed replaced by the default. */
export function parsePrefs(raw: string | null): Prefs {
  // units and gridSize are listed so merging this into the store also clears them.
  if (!raw) return { ...DEFAULT_PREFS, units: undefined, gridSize: undefined }
  try {
    const p = JSON.parse(raw) as Partial<Prefs>
    const d = DEFAULT_PREFS
    return {
      units: p.units === 'in' || p.units === 'mm' ? p.units : undefined,
      gridSize: positive(p.gridSize),
      smartAlignment: bool(p.smartAlignment, d.smartAlignment),
      snap: Object.fromEntries(SNAP_KINDS.map((k) => [k, bool(p.snap?.[k], true)])) as Record<SnapKind, boolean>,
      showPosition: bool(p.showPosition, d.showPosition),
      showGrid: bool(p.showGrid, d.showGrid),
      snapToGrid: bool(p.snapToGrid, d.snapToGrid),
      positionLabels: bool(p.positionLabels, d.positionLabels),
      originAnchor: bool(p.originAnchor, d.originAnchor),
      cutPathDisplay: bool(p.cutPathDisplay, d.cutPathDisplay),
      cutType: CUT_TYPES.includes(p.cutType as CutType) ? (p.cutType as CutType) : d.cutType,
      bitDia: positive(p.bitDia) ?? d.bitDia,
      depth: positive(p.depth) ?? null,
      mouseNav: p.mouseNav === 'pan' ? 'pan' : 'zoom',
    }
  } catch {
    return DEFAULT_PREFS
  }
}

function load(): Prefs {
  try {
    return parsePrefs(readScoped(KEY))
  } catch {
    return DEFAULT_PREFS
  }
}

interface PrefsState extends Prefs {
  set: (patch: Partial<Prefs>) => void
  reset: () => void
}

export const usePrefs = create<PrefsState>()((set) => ({
  ...load(),
  set: (patch) => set(patch),
  reset: () => set({ ...DEFAULT_PREFS, units: undefined, gridSize: undefined }),
}))

let lastSaved: string | null = null
usePrefs.subscribe((s) => {
  const { set: _set, reset: _reset, ...prefs } = s
  const next = JSON.stringify(prefs)
  if (next === lastSaved) return
  lastSaved = next
  writeScoped(KEY, next)
})

// Presets that arrived from another device (account sync).
onRemoteSetting(KEY, (raw) => {
  lastSaved = raw
  usePrefs.setState(parsePrefs(raw))
})

// Another window (home vs studio in the desktop app, or another tab) changed the presets.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === scopedKey(KEY)) {
      lastSaved = e.newValue
      usePrefs.setState(parsePrefs(e.newValue))
    }
  })
}

export const getPrefs = (): Prefs => usePrefs.getState()

/** Settings a new design starts with. */
export function newDocSettings(p: Prefs = getPrefs()): DocSettings {
  const snapOff = SNAP_KINDS.some((k) => !p.snap[k])
  return {
    smartAlignment: p.smartAlignment,
    ...(snapOff ? { snap: { ...p.snap } } : {}),
    showPosition: p.showPosition,
    showGrid: p.showGrid,
    snapToGrid: p.snapToGrid,
    positionLabels: p.positionLabels,
    ...(p.gridSize ? { gridSize: p.gridSize } : {}),
    originAnchor: p.originAnchor,
    cutPathDisplay: p.cutPathDisplay,
  }
}

/**
 * Cut settings for a new shape. Pass the type when the shape needs a specific one (an open
 * path is On Line, a box joint is Inside); otherwise the preset cut type is used.
 */
export function newShapeCut(type?: CutType, p: Prefs = getPrefs()): CutSettings {
  return { ...DEFAULT_CUT, type: type ?? p.cutType, bitDia: p.bitDia, depth: p.depth }
}
