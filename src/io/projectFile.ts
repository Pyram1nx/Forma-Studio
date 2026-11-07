// Save / open designs on the user's computer, plus local autosave + "Open Recent".
// Uses the File System Access API when the browser supports it (Chrome, Edge) so
// "Save" writes back to the same file; falls back to download / file input.
import type { Contour, CutType, FreeOrigin, Group, OriginPoint, Shape, ShapeKind, StudioDoc, Units } from '../model/types'
import { DEFAULT_CUT, SNAP_KINDS } from '../model/types'
import { uid } from '../model/ids'
import { parsePen, penGeometry, penOf } from '../geometry/pen'
import { bboxValid, localBBox, toWorld } from '../geometry/transform'
import { withParams } from '../editor/shapeFactory'
import { useStore } from '../state/store'
import { isDesktop } from '../desktop/runtime'
import { desktopPickOpen, desktopPickSave, desktopRead, desktopWrite, type DesktopFileHandle } from '../desktop/files'
import { deleteDesign, getDesignData, listDesigns, saveDesign, setDesignWriteErrorHandler, type DesignSummary } from '../storage/designStore'
import { scopedKey } from '../storage/space'

export const FILE_EXT = '.forma'
/** Extensions of designs saved under earlier names. Still opened, never written. */
export const LEGACY_FILE_EXTS = ['.formastudio', '.shaperstudio']
const LEGACY_APP = 'ShaperStudio'
const MIME = 'application/json'

/** A saved design's location: a browser file handle, or a path on the desktop app. */
export type DocHandle = FileSystemFileHandle | DesktopFileHandle
const isDesktopHandle = (h: DocHandle): h is DesktopFileHandle => (h as DesktopFileHandle).kind === 'desktop'

const pickerTypes = [{ description: 'Forma Studio design', accept: { [MIME]: [FILE_EXT, ...LEGACY_FILE_EXTS, '.json'] } }]

type FSWindow = Window & {
  showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>
  showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]>
}
const w = (typeof window !== 'undefined' ? window : {}) as FSWindow

export const supportsFileSystemAccess = () => typeof w.showSaveFilePicker === 'function'

/**
 * Design JSON. A shape with true curves is stored as its curves alone: the polyline contours are
 * flattened from them, so they are rebuilt on open instead of costing hundreds of points per circle.
 */
export function serialize(doc: StudioDoc): string {
  return JSON.stringify({ ...doc, shapes: doc.shapes.map((s) => (penOf(s) ? { ...s, contours: [] } : s)) })
}

const SHAPE_KINDS: ShapeKind[] = ['circle', 'ellipse', 'rect', 'polygon', 'triangle', 'template', 'path', 'text', 'import', 'slice', 'sketch']
const CUT_TYPES: CutType[] = ['online', 'outside', 'inside', 'pocket', 'guide']

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numOr = (v: unknown, d: number) => (finite(v) ? v : d)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const ORIGIN_POINTS: OriginPoint[] = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br']
const freeOrigin = (v: unknown): FreeOrigin | null => (isObj(v) && finite(v.fx) && finite(v.fy) ? { fx: v.fx, fy: v.fy } : null)

/** Rebuild one shape from untrusted JSON, dropping bad contours. Null = unusable. */
function repairShape(raw: unknown): Shape | null {
  if (!isObj(raw)) return null
  const pen = parsePen(raw.pen)
  let contours: Contour[] = []
  for (const c of Array.isArray(raw.contours) ? raw.contours : []) {
    if (!isObj(c) || !Array.isArray(c.pts)) continue
    const pts = c.pts.filter((p): p is { x: number; y: number } => isObj(p) && finite(p.x) && finite(p.y)).map((p) => ({ x: p.x, y: p.y }))
    if (pts.length < 2) continue
    contours.push({ pts, closed: c.closed === true && pts.length >= 3 })
  }
  // Curves saved without their contours (see serialize): flatten them again.
  if (!contours.length && pen) contours = penGeometry(pen).contours.filter((c) => c.pts.length >= 2)
  if (!contours.length) return null
  const cut = isObj(raw.cut) ? raw.cut : {}
  const sx = numOr(raw.sx, 1) || 1
  const sy = numOr(raw.sy, 1) || 1
  let params: Shape['params']
  if (isObj(raw.params)) {
    params = {}
    for (const [k, v] of Object.entries(raw.params)) {
      if (typeof v === 'number' ? finite(v) : typeof v === 'string' || typeof v === 'boolean') params[k] = v as number | string | boolean
    }
  }
  const shape: Shape = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
    name: typeof raw.name === 'string' ? raw.name : 'Shape',
    kind: SHAPE_KINDS.includes(raw.kind as ShapeKind) ? (raw.kind as ShapeKind) : 'path',
    contours,
    x: numOr(raw.x, 0),
    y: numOr(raw.y, 0),
    rotation: numOr(raw.rotation, 0),
    sx,
    sy,
    params,
    cut: {
      type: CUT_TYPES.includes(cut.type as CutType) ? (cut.type as CutType) : DEFAULT_CUT.type,
      depth: finite(cut.depth) ? cut.depth : null,
      offset: numOr(cut.offset, 0),
      bitDia: finite(cut.bitDia) && cut.bitDia > 0 ? cut.bitDia : DEFAULT_CUT.bitDia,
    },
  }
  if (raw.hidden === true) shape.hidden = true
  if (raw.locked === true) shape.locked = true
  if (typeof raw.groupId === 'string') shape.groupId = raw.groupId
  if (isObj(raw.meta)) shape.meta = raw.meta as Shape['meta']
  if (pen) shape.pen = pen
  return migrateKeyhole(shape)
}

/**
 * Keyholes used to be centred on their bounds with the head on top. They are now Studio's: the neck centre is
 * the origin and the head hangs below it. An old one is rebuilt flipped, placed by its neck, so it looks the same.
 */
function migrateKeyhole(s: Shape): Shape {
  if (s.kind !== 'template' || s.params?.template !== 'keyhole') return s
  const b = localBBox(s)
  if (!bboxValid(b) || Math.abs(b.minY + b.maxY) > 1e-6 || Math.abs(b.minX + b.maxX) > 1e-6) return s
  const p = s.params
  const len = Math.max(0, Number(p.slotLength ?? 0))
  const h = Number(p.headDiameter ?? 0) / 2
  const n = Number(p.slotWidth ?? 0) / 2
  // The old outline before centring: head circle on 0, neck end circle on +len.
  const c = (Math.min(-h, -n) + Math.max(h, len + n)) / 2
  const neck = toWorld(s, { x: 0, y: len - c })
  return withParams({ ...s, x: neck.x, y: neck.y, sy: -s.sy }, p)
}

/**
 * Parse and validate a design file. Invalid shapes are repaired or dropped, so a
 * damaged file still opens. Throws only for files that aren't Forma Studio designs
 * or that come from a newer format.
 */
export function parseDoc(text: string): StudioDoc {
  let d: unknown
  try {
    d = JSON.parse(text)
  } catch {
    throw new Error('Not a Forma Studio design file')
  }
  if (!isObj(d) || (d.app !== 'FormaStudio' && d.app !== LEGACY_APP) || !Array.isArray(d.shapes)) throw new Error('Not a Forma Studio design file')
  if (finite(d.version) && d.version > 1) throw new Error('This design was made by a newer version of Forma Studio')
  const seen = new Set<string>()
  const shapes: Shape[] = []
  for (const raw of d.shapes) {
    const s = repairShape(raw)
    if (!s) continue
    if (seen.has(s.id)) s.id = uid()
    seen.add(s.id)
    shapes.push(s)
  }
  const groups: Group[] = []
  if (Array.isArray(d.groups)) {
    for (const g of d.groups) {
      if (isObj(g) && typeof g.id === 'string' && typeof g.name === 'string') {
        const grp: Group = { id: g.id, name: g.name }
        if (g.source === '3d' || g.source === 'paper' || g.source === 'svg' || g.source === 'user') grp.source = g.source
        if (isObj(g.info)) grp.info = g.info as Group['info']
        const ga = freeOrigin(g.anchor)
        if (ga) grp.anchor = ga
        groups.push(grp)
      }
    }
  }
  const st = isObj(d.settings) ? d.settings : {}
  const now = new Date().toISOString()
  return {
    app: 'FormaStudio',
    version: 1,
    id: typeof d.id === 'string' && d.id ? d.id : uid('d'),
    name: typeof d.name === 'string' && d.name.trim() ? d.name : 'Untitled',
    units: (d.units === 'mm' ? 'mm' : 'in') as Units,
    shapes,
    groups,
    settings: {
      smartAlignment: st.smartAlignment !== false,
      ...(isObj(st.snap) && SNAP_KINDS.some((k) => (st.snap as Record<string, unknown>)[k] === false)
        ? { snap: Object.fromEntries(SNAP_KINDS.filter((k) => (st.snap as Record<string, unknown>)[k] === false).map((k) => [k, false])) }
        : {}),
      showPosition: st.showPosition === true,
      ...(st.showGrid === true ? { showGrid: true } : {}),
      ...(st.snapToGrid === true ? { snapToGrid: true } : {}),
      ...(st.positionLabels === true ? { positionLabels: true } : {}),
      ...(typeof st.gridSize === 'number' && st.gridSize > 0 && Number.isFinite(st.gridSize) ? { gridSize: st.gridSize } : {}),
      originAnchor: st.originAnchor === true,
      ...(ORIGIN_POINTS.includes(st.originPoint as OriginPoint)
        ? { originPoint: st.originPoint as OriginPoint }
        : freeOrigin(st.originPoint)
          ? { originPoint: freeOrigin(st.originPoint) as FreeOrigin }
          : {}),
      ...(isObj(st.customAnchor) && finite(st.customAnchor.x) && finite(st.customAnchor.y)
        ? {
            customAnchor: { x: st.customAnchor.x, y: st.customAnchor.y },
            ...(Array.isArray(st.customAnchorFor)
              ? { customAnchorFor: st.customAnchorFor.filter((i): i is string => typeof i === 'string') }
              : {}),
          }
        : {}),
      cutPathDisplay: st.cutPathDisplay === true,
    },
    createdAt: typeof d.createdAt === 'string' ? d.createdAt : now,
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : now,
  }
}

const safeName = (n: string) => n.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'design'

/**
 * Save the design. With an existing handle it overwrites in place; otherwise it
 * asks where to save. Returns the handle (or null when downloaded).
 */
export async function saveDoc(doc: StudioDoc, handle: DocHandle | null, saveAs = false): Promise<DocHandle | null> {
  const data = serialize(doc)
  if (isDesktop()) {
    const existing = !saveAs && handle && isDesktopHandle(handle) ? handle : null
    const h = existing ?? (await desktopPickSave(safeName(doc.name) + FILE_EXT, FILE_EXT))
    await desktopWrite(h, data)
    return h
  }
  const existing = !saveAs && handle && !isDesktopHandle(handle) ? handle : null
  if (supportsFileSystemAccess()) {
    const h = existing ?? (await w.showSaveFilePicker!({ suggestedName: safeName(doc.name) + FILE_EXT, types: pickerTypes }))
    const ws = await h.createWritable()
    await ws.write(new Blob([data], { type: MIME }))
    await ws.close()
    return h
  }
  downloadBlob(new Blob([data], { type: MIME }), safeName(doc.name) + FILE_EXT)
  return null
}

export async function openDocFromComputer(): Promise<{ doc: StudioDoc; handle: DocHandle | null }> {
  if (isDesktop()) {
    const h = await desktopPickOpen([FILE_EXT, ...LEGACY_FILE_EXTS].map((e) => e.slice(1)).concat('json'))
    return { doc: parseDoc(await desktopRead(h)), handle: h }
  }
  if (typeof w.showOpenFilePicker === 'function') {
    const [h] = await w.showOpenFilePicker({ types: pickerTypes, multiple: false })
    const f = await h.getFile()
    return { doc: parseDoc(await f.text()), handle: h }
  }
  const f = await pickFile([FILE_EXT, ...LEGACY_FILE_EXTS].join(',') + ',.json,' + MIME)
  return { doc: parseDoc(await f.text()), handle: null }
}

export function pickFile(accept: string): Promise<File> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => (input.files?.[0] ? resolve(input.files[0]) : reject(new Error('No file')))
    input.click()
  })
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---------- Local autosave (browser storage) ----------
// Designs are kept per storage space (no account, or each account) in IndexedDB; see
// src/storage/. These wrappers keep the editor's synchronous view of them.

/** The design the studio opens on start-up, per space and per device (not synced). */
const KEY_LAST = 'formastudio:last'

export type RecentEntry = DesignSummary

/** Saved designs in this space, newest first. */
export const listRecent = (): RecentEntry[] => listDesigns()

let warnedStorage = false
setDesignWriteErrorHandler((e) => {
  console.warn('Autosave failed', e)
  if (warnedStorage) return
  warnedStorage = true
  useStore.getState().showToast("Couldn't autosave — browser storage is full. Save to your computer.")
})

/**
 * Save the design in this browser. The returned promise settles once it is on disk
 * (await it before another page has to read the design).
 */
export function autosave(doc: StudioDoc): Promise<unknown> {
  return saveDesign({ id: doc.id, name: doc.name, updatedAt: doc.updatedAt, shapes: doc.shapes.length, data: serialize(doc) })
}

/**
 * Debounced autosave driver. Call onChange(next, prev) on every store change.
 * When the document is replaced (different id), the pending save for the old
 * document is flushed synchronously first, so edits made within the debounce
 * window are not lost when the user opens another design.
 */
export function createAutosaver(getDoc: () => StudioDoc, save: (doc: StudioDoc) => unknown, delay = 600) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    onChange(next: StudioDoc, prev: StudioDoc) {
      if (next === prev) return
      clearTimeout(timer)
      timer = undefined
      // prev is the latest state of the replaced document (subscribers run after every change).
      if (next.id !== prev.id) save(prev)
      timer = setTimeout(() => {
        timer = undefined
        save(getDoc())
      }, delay)
    },
    cancel() {
      clearTimeout(timer)
      timer = undefined
    },
    /** A change is waiting for the debounce. */
    isPending: () => timer !== undefined,
  }
}

export function loadRecent(id: string): StudioDoc | null {
  try {
    const t = getDesignData(id)
    return t ? { ...parseDoc(t), id } : null
  } catch {
    return null
  }
}

/** Make a saved design the one the studio opens on start-up. */
export function setLastDesign(id: string) {
  try {
    localStorage.setItem(scopedKey(KEY_LAST), id)
  } catch {
    /* storage unavailable: the studio starts on its last design */
  }
}

/** The design to open on start-up: the last one opened here, else the newest (e.g. on a new device). */
export function loadLast(): StudioDoc | null {
  let id: string | null = null
  try {
    id = localStorage.getItem(scopedKey(KEY_LAST))
  } catch {
    /* storage blocked */
  }
  const newest = listRecent()[0]?.id
  return (id ? loadRecent(id) : null) ?? (newest ? loadRecent(newest) : null)
}

export function removeRecent(id: string) {
  void deleteDesign(id)
}

export function nextUntitledName(): string {
  const names = new Set(listRecent().map((r) => r.name))
  let i = 1
  while (names.has('Untitled-' + i)) i++
  return 'Untitled-' + i
}
