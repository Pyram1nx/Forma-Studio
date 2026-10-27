// Save / open designs on the user's computer, plus local autosave + "Open Recent".
// Uses the File System Access API when the browser supports it (Chrome, Edge) so
// "Save" writes back to the same file; falls back to download / file input.
import type { Contour, CutType, Group, Shape, ShapeKind, StudioDoc, Units } from '../model/types'
import { DEFAULT_CUT, SNAP_KINDS } from '../model/types'
import { uid } from '../model/ids'
import { useStore } from '../state/store'
import { isDesktop } from '../desktop/runtime'
import { desktopPickOpen, desktopPickSave, desktopRead, desktopWrite, type DesktopFileHandle } from '../desktop/files'

export const FILE_EXT = '.formastudio'
/** Extension and app marker of designs saved before the rename to Forma Studio. Still opened. */
export const LEGACY_FILE_EXT = '.shaperstudio'
const LEGACY_APP = 'ShaperStudio'
const MIME = 'application/json'

/** A saved design's location: a browser file handle, or a path on the desktop app. */
export type DocHandle = FileSystemFileHandle | DesktopFileHandle
const isDesktopHandle = (h: DocHandle): h is DesktopFileHandle => (h as DesktopFileHandle).kind === 'desktop'

const pickerTypes = [{ description: 'Forma Studio design', accept: { [MIME]: [FILE_EXT, LEGACY_FILE_EXT, '.json'] } }]

type FSWindow = Window & {
  showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>
  showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]>
}
const w = (typeof window !== 'undefined' ? window : {}) as FSWindow

export const supportsFileSystemAccess = () => typeof w.showSaveFilePicker === 'function'

export function serialize(doc: StudioDoc): string {
  return JSON.stringify(doc)
}

const SHAPE_KINDS: ShapeKind[] = ['circle', 'ellipse', 'rect', 'polygon', 'triangle', 'template', 'path', 'text', 'import', 'slice', 'sketch']
const CUT_TYPES: CutType[] = ['online', 'outside', 'inside', 'pocket', 'guide']

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numOr = (v: unknown, d: number) => (finite(v) ? v : d)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Rebuild one shape from untrusted JSON, dropping bad contours. Null = unusable. */
function repairShape(raw: unknown): Shape | null {
  if (!isObj(raw) || !Array.isArray(raw.contours)) return null
  const contours: Contour[] = []
  for (const c of raw.contours) {
    if (!isObj(c) || !Array.isArray(c.pts)) continue
    const pts = c.pts.filter((p): p is { x: number; y: number } => isObj(p) && finite(p.x) && finite(p.y)).map((p) => ({ x: p.x, y: p.y }))
    if (pts.length < 2) continue
    contours.push({ pts, closed: c.closed === true && pts.length >= 3 })
  }
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
  return shape
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
      originAnchor: st.originAnchor === true,
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
    const h = await desktopPickOpen([FILE_EXT.slice(1), LEGACY_FILE_EXT.slice(1), 'json'])
    return { doc: parseDoc(await desktopRead(h)), handle: h }
  }
  if (typeof w.showOpenFilePicker === 'function') {
    const [h] = await w.showOpenFilePicker({ types: pickerTypes, multiple: false })
    const f = await h.getFile()
    return { doc: parseDoc(await f.text()), handle: h }
  }
  const f = await pickFile(FILE_EXT + ',' + LEGACY_FILE_EXT + ',.json,' + MIME)
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

const KEY_RECENT = 'formastudio:recent'
const KEY_DOC = (id: string) => 'formastudio:doc:' + id
const KEY_LAST = 'formastudio:last'

export interface RecentEntry {
  id: string
  name: string
  updatedAt: string
  shapes: number
}

export function listRecent(): RecentEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY_RECENT) || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

const MAX_RECENT = 20
let warnedStorage = false

/**
 * Save the design to browser storage. Returns false when storage refused the
 * write (quota). The user is told at most once per session.
 */
export function autosave(doc: StudioDoc): boolean {
  try {
    localStorage.setItem(KEY_DOC(doc.id), serialize(doc))
    localStorage.setItem(KEY_LAST, doc.id)
    const entry: RecentEntry = { id: doc.id, name: doc.name, updatedAt: doc.updatedAt, shapes: doc.shapes.length }
    const all = [entry, ...listRecent().filter((r) => r.id !== doc.id)]
    // Evicted entries must not leave their payloads behind.
    for (const r of all.slice(MAX_RECENT)) localStorage.removeItem(KEY_DOC(r.id))
    localStorage.setItem(KEY_RECENT, JSON.stringify(all.slice(0, MAX_RECENT)))
    return true
  } catch (e) {
    console.warn('Autosave failed', e)
    if (!warnedStorage) {
      warnedStorage = true
      useStore.getState().showToast("Couldn't autosave — storage is full. Save to your computer.")
    }
    return false
  }
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
  }
}

export function loadRecent(id: string): StudioDoc | null {
  try {
    const t = localStorage.getItem(KEY_DOC(id))
    return t ? parseDoc(t) : null
  } catch {
    return null
  }
}

/** Make a saved design the one the studio opens on start-up. */
export function setLastDesign(id: string) {
  try {
    localStorage.setItem(KEY_LAST, id)
  } catch {
    /* storage unavailable: the studio starts on its last design */
  }
}

export function loadLast(): StudioDoc | null {
  try {
    const id = localStorage.getItem(KEY_LAST)
    return id ? loadRecent(id) : null
  } catch {
    return null
  }
}

export function removeRecent(id: string) {
  try {
    localStorage.removeItem(KEY_DOC(id))
    localStorage.setItem(KEY_RECENT, JSON.stringify(listRecent().filter((r) => r.id !== id)))
  } catch {
    /* storage unavailable: nothing to remove */
  }
}

export function nextUntitledName(): string {
  const names = new Set(listRecent().map((r) => r.name))
  let i = 1
  while (names.has('Untitled-' + i)) i++
  return 'Untitled-' + i
}
