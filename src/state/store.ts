import { create } from 'zustand'
import type { Contour, CutSettings, FreeOrigin, Group, ImportPayload, Mode, OriginRef, OriginPoint, Pt, Shape, SnapKind, StudioDoc, Units } from '../model/types'
import { uid } from '../model/ids'
import type { DocHandle } from '../io/projectFile'
import { mapCurves, penOf } from '../geometry/pen'
import { bake, bboxCenter, bboxH, bboxValid, bboxW, shapesBBox, type BBox } from '../geometry/transform'
import { getPrefs, newDocSettings } from './prefs'
import { readScoped, SYNCED_SETTINGS, writeScoped } from '../storage/space'

export type Tool = 'select' | 'pen' | 'draw'
export type Dialog = null | 'text' | 'carve3d' | 'trace' | 'offset' | 'radius' | 'shortcuts' | 'account' | 'reference' | 'bits' | 'dovetail' | 'systainer'
export type Popover = null | 'shapes' | 'settings'

export interface View {
  /** screen px per mm */
  zoom: number
  panX: number
  panY: number
}

const UNITS_KEY = SYNCED_SETTINGS.units

/** Units the user last picked; new designs start in them. */
export function lastUnits(): Units {
  const u = readScoped(UNITS_KEY)
  return u === 'mm' || u === 'in' ? u : 'in'
}

/** Units new designs start in: the account's preset, else the units last picked. */
export const defaultUnits = (): Units => getPrefs().units ?? lastUnits()

function rememberUnits(u: Units) {
  if (readScoped(UNITS_KEY) !== u) writeScoped(UNITS_KEY, u)
}

export function newDoc(name = 'Untitled-1'): StudioDoc {
  const now = new Date().toISOString()
  return {
    app: 'FormaStudio',
    version: 1,
    id: uid('d'),
    name,
    units: defaultUnits(),
    shapes: [],
    groups: [],
    settings: newDocSettings(),
    createdAt: now,
    updatedAt: now,
  }
}

/** Ids from `ids` that exist in the document and are not locked. Locked shapes are never edited. */
/** Drop groups that no shape refers to any more (e.g. after their last member was deleted). */
export function pruneGroups(doc: StudioDoc): StudioDoc {
  const used = new Set<string>()
  for (const s of doc.shapes) if (s.groupId) used.add(s.groupId)
  const groups = doc.groups.filter((g) => used.has(g.id))
  return groups.length === doc.groups.length ? doc : { ...doc, groups }
}

const CELL_FRACTION: Record<OriginPoint, FreeOrigin> = {
  tl: { fx: 0, fy: 0 },
  tc: { fx: 0.5, fy: 0 },
  tr: { fx: 1, fy: 0 },
  ml: { fx: 0, fy: 0.5 },
  mc: { fx: 0.5, fy: 0.5 },
  mr: { fx: 1, fy: 0.5 },
  bl: { fx: 0, fy: 1 },
  bc: { fx: 0.5, fy: 1 },
  br: { fx: 1, fy: 1 },
}

/** The group whose members are exactly the current selection, if any. */
export function groupForSelection(doc: StudioDoc, selection: readonly string[]): Group | undefined {
  if (!selection.length) return undefined
  const sel = new Set(selection)
  const gid = doc.shapes.find((s) => sel.has(s.id))?.groupId
  if (!gid) return undefined
  const members = doc.shapes.filter((s) => s.groupId === gid)
  if (members.length !== sel.size || !members.every((m) => sel.has(m.id))) return undefined
  return doc.groups.find((g) => g.id === gid)
}

/** The outline of a selected box-style group: the group's one editable object for the settings panel. */
export function groupOutlineFor(doc: StudioDoc, selection: readonly string[]): Shape | undefined {
  const g = groupForSelection(doc, selection)
  // A user's group is plain: an outline-role member in it (e.g. a paper trace) isn't the group's settings object.
  if (!g || g.source === 'user') return undefined
  return doc.shapes.find((s) => s.groupId === g.id && s.meta?.role === 'outline')
}

/**
 * A group a feature relies on (a box joint's outline and guides, a 3D carve's layers): it has an
 * outline-role member and wasn't made by the user. Such groups are never merged or ungrouped.
 */
export function isFeatureGroup(doc: StudioDoc, groupId: string): boolean {
  const g = doc.groups.find((x) => x.id === groupId)
  if (!g || g.source === 'user') return false
  return doc.shapes.some((s) => s.groupId === groupId && s.meta?.role === 'outline')
}

/**
 * The group the selection stands for as one object: every selected shape is in it and every
 * unlocked member is selected (locked members are never selected with their group).
 */
export function selectedGroup(doc: StudioDoc, selection: readonly string[]): Group | undefined {
  if (!selection.length) return undefined
  const sel = new Set(selection)
  const picked = doc.shapes.filter((s) => sel.has(s.id))
  const gid = picked[0]?.groupId
  if (!gid || picked.some((s) => s.groupId !== gid)) return undefined
  if (doc.shapes.some((s) => s.groupId === gid && !s.locked && !sel.has(s.id))) return undefined
  return doc.groups.find((g) => g.id === gid)
}

/**
 * What the Group / Ungroup action does for this selection: 'ungroup' for one whole plain group,
 * 'group' for two or more unlocked shapes outside feature groups, otherwise null.
 */
export function groupAction(doc: StudioDoc, selection: readonly string[]): 'group' | 'ungroup' | null {
  const whole = selectedGroup(doc, selection)
  if (whole) return isFeatureGroup(doc, whole.id) ? null : 'ungroup'
  const sel = new Set(selection)
  const free = doc.shapes.filter((s) => sel.has(s.id) && !s.locked)
  if (free.length < 2) return null
  if (free.some((s) => s.groupId && isFeatureGroup(doc, s.groupId))) return null
  return 'group'
}

/** "Group", then "Group 2", "Group 3"… (the first name not already taken). */
function nextGroupName(doc: StudioDoc): string {
  const taken = new Set(doc.groups.map((g) => g.name))
  if (!taken.has('Group')) return 'Group'
  let n = 2
  while (taken.has(`Group ${n}`)) n++
  return `Group ${n}`
}

/**
 * A group's anchor is kept as a fraction of the bounds of all its members, hidden ones included,
 * so it stays on the same point when guides are hidden or the side changes. The origin in effect
 * for a selection is that point, expressed against the selection's visible bounds.
 */
export function activeOrigin(doc: StudioDoc, selection: readonly string[]): OriginRef | undefined {
  const g = groupForSelection(doc, selection)
  if (!g?.anchor) return doc.settings.originPoint
  const all = shapesBBox(doc.shapes.filter((s) => s.groupId === g.id))
  const vis = shapesBBox(doc.shapes.filter((s) => selection.includes(s.id) && !s.hidden))
  if (!bboxValid(all) || !bboxValid(vis)) return doc.settings.originPoint
  const wx = all.minX + g.anchor.fx * (all.maxX - all.minX)
  const wy = all.minY + g.anchor.fy * (all.maxY - all.minY)
  return { fx: (wx - vis.minX) / Math.max(vis.maxX - vis.minX, 1e-9), fy: (wy - vis.minY) / Math.max(vis.maxY - vis.minY, 1e-9) }
}

/**
 * The selection after undo/redo swaps `from` for `to`: ids that still exist, or the whole group
 * again when a whole group was selected (its members can differ, e.g. a box joint's guides).
 */
function carrySelection(from: StudioDoc, to: StudioDoc, selection: string[]): string[] {
  const g = groupForSelection(from, selection)
  if (g && to.groups.some((x) => x.id === g.id)) return to.shapes.filter((s) => s.groupId === g.id && !s.locked).map((s) => s.id)
  const ids = new Set(to.shapes.map((s) => s.id))
  return selection.filter((i) => ids.has(i))
}

/**
 * Studio's Reference paths are our locked shapes: shown as an amber outline, picked only by
 * their edge, kept out of marquee selections, never edited, and left out of Plan, Review and export.
 */
export const REFERENCE_TOAST = 'Object set to Reference and locked'

/** Whether the selection includes a reference (locked) shape: the canvas then shows no handles or panels. */
export function selectionHasReference(doc: StudioDoc, selection: readonly string[]): boolean {
  if (!selection.length) return false
  const sel = new Set(selection)
  return doc.shapes.some((s) => s.locked && sel.has(s.id))
}

export function editableIds(ids: readonly string[], doc: StudioDoc = useStore.getState().doc): string[] {
  const want = new Set(ids)
  return doc.shapes.filter((s) => want.has(s.id) && !s.locked && !s.hidden).map((s) => s.id)
}

interface State {
  doc: StudioDoc
  mode: Mode
  tool: Tool
  /** Shape Anchor mode: the canvas shows the selection's nine anchor points until one is picked. */
  anchorPicking: boolean
  /** The pen path whose nodes are being edited on the canvas (double-click a pen path), if any. */
  penEditId: string | null
  /** Plan mode: a shape lit on the canvas while its Manage Selection tile is held down. */
  planHighlight: string | null
  selection: string[]
  view: View
  viewport: { w: number; h: number }
  past: StudioDoc[]
  future: StudioDoc[]
  /** Timestamp of the last arrow-key nudge; consecutive nudges share one undo step. */
  lastNudge: number
  dialog: Dialog
  popover: Popover
  /** Doc ids + ephemeral ghosts (rebuilt sources no longer in the doc) whose fragments ShapeShifter is combining; editId = an older result being re-edited (removed on finish). null = mode is off. */
  shifter: { ids: string[]; ghosts?: Shape[]; editId?: string } | null
  menuOpen: boolean
  /** Text shape being edited (null = new text). */
  editingTextId: string | null
  dirty: boolean
  fileHandle: DocHandle | null
  toast: string | null
  /** The toast's info button opens this dialog (Studio's reference toast). */
  toastInfo: Dialog

  // history
  checkpoint: () => void
  undo: () => void
  redo: () => void

  // document
  setDoc: (doc: StudioDoc, handle?: DocHandle | null) => void
  rename: (name: string) => void
  setUnits: (u: Units) => void
  setSetting: (k: keyof StudioDoc['settings'], v: boolean) => void
  setSnapKind: (k: SnapKind, v: boolean) => void
  /** Grid spacing in mm (Position > Show grid). */
  setGridSize: (mm: number) => void
  setOriginPoint: (p: OriginRef) => void
  setGroupAnchor: (groupId: string, anchor: FreeOrigin) => void
  setCustomAnchor: (p: Pt) => void
  /** Remove the custom anchor marker; a free origin that came from it falls back to the centre. */
  clearCustomAnchor: () => void
  addShapes: (shapes: Shape[], select?: boolean) => void
  /** Adds a group record and its shapes in one undo step, selecting them. */
  addGroupShapes: (group: Group, shapes: Shape[]) => void
  /** Swaps the shapes matching `remove` for `add` in one undo step (no selection change). */
  swapShapes: (remove: (s: Shape) => boolean, add: Shape[]) => void
  importPayload: (p: ImportPayload) => void
  /** Mutate shapes without a checkpoint (call checkpoint() first for undo). */
  patchShapes: (ids: string[], fn: (s: Shape) => Shape) => void
  /** checkpoint + patch */
  updateShapes: (ids: string[], fn: (s: Shape) => Shape) => void
  setCut: (ids: string[], cut: Partial<CutSettings>) => void
  deleteSelected: () => void
  duplicateSelected: (inPlace?: boolean) => void
  mirrorSelected: (axis: 'h' | 'v') => void
  replaceShapes: (removeIds: string[], add: Shape[]) => void
  bringToFront: () => void
  sendToBack: () => void
  /** Clear the locked flag on every shape (checkpointed). */
  unlockAll: () => void
  /** Set As Reference & Lock (on) or Make Editable (off) for the selection, keeping it selected. */
  setReferenceSelected: (on: boolean) => void
  /** Cmd/Ctrl+H: flip each selected shape between reference and editable. */
  toggleReferenceSelected: () => void
  /**
   * Group the unlocked selected shapes into a new group (one undo step), keeping them selected.
   * Members of other plain groups move into the new one (groups are flat); locked shapes stay out.
   */
  groupSelected: () => void
  /** Dissolve the selected whole group (one undo step); its members stay selected one by one. */
  ungroupSelected: () => void

  // selection / ui
  select: (ids: string[]) => void
  /** Select every unlocked shape of a group. Locked shapes are skipped. */
  selectGroup: (groupId: string) => void
  setMode: (m: Mode) => void
  setTool: (t: Tool) => void
  setAnchorPicking: (on: boolean) => void
  setPenEdit: (id: string | null) => void
  setPlanHighlight: (id: string | null) => void
  setView: (v: Partial<View>) => void
  setViewport: (w: number, h: number) => void
  zoomToFit: (bbox?: BBox) => void
  zoomBy: (factor: number, cx?: number, cy?: number) => void
  zoomIn: () => void
  zoomOut: () => void
  openDialog: (d: Dialog) => void
  setPopover: (p: Popover) => void
  /** Enter ShapeShifter with the unlocked selection. */
  enterShapeShifter: () => void
  exitShapeShifter: () => void
  setMenuOpen: (o: boolean) => void
  setEditingText: (id: string | null) => void
  setFileHandle: (h: DocHandle | null) => void
  /**
   * Mark the design as saved. Pass the document object that was written: if the
   * user has edited since, the design stays dirty.
   */
  markSaved: (savedDoc?: StudioDoc) => void
  showToast: (msg: string, opts?: { info?: Dialog; ms?: number }) => void
}

const HISTORY_LIMIT = 100
/** Share of the viewport that Zoom to Fit fills with the content, as in Shaper Studio. */
const FIT_FRACTION = 0.7
let toastTimer: ReturnType<typeof setTimeout> | undefined

let suppressCheckpoints = 0

/**
 * Run store mutations without adding undo entries, e.g. repeated arrow-key steps in
 * a field that belong to the same undo step as the first one.
 */
export function withoutCheckpoint(fn: () => void) {
  suppressCheckpoints++
  try {
    fn()
  } finally {
    suppressCheckpoints--
  }
}

export const useStore = create<State>((set, get) => {
  const touch = (doc: StudioDoc): StudioDoc => ({ ...doc, updatedAt: new Date().toISOString() })
  /** The custom anchor marker belongs to the shapes it was picked for: drop it once they are all gone. */
  const pruneAnchor = (doc: StudioDoc): StudioDoc => {
    const { customAnchor, customAnchorFor } = doc.settings
    if (!customAnchor || !customAnchorFor?.length || doc.shapes.some((s) => customAnchorFor.includes(s.id))) return doc
    return {
      ...doc,
      settings: {
        ...doc.settings,
        customAnchor: undefined,
        customAnchorFor: undefined,
        ...(typeof doc.settings.originPoint === 'object' ? { originPoint: 'mc' as const } : {}),
      },
    }
  }
  const commitDoc = (doc: StudioDoc) => set({ doc: touch(pruneAnchor(doc)), dirty: true })

  return {
    doc: newDoc(),
    mode: 'design',
    tool: 'select',
    anchorPicking: false,
    penEditId: null,
    planHighlight: null,
    selection: [],
    view: { zoom: 4, panX: 0, panY: 0 },
    viewport: { w: 1200, h: 800 },
    past: [],
    future: [],
    lastNudge: 0,
    dialog: null,
    popover: null,
    shifter: null,
    menuOpen: false,
    editingTextId: null,
    dirty: false,
    fileHandle: null,
    toast: null,
    toastInfo: null,

    checkpoint: () => {
      if (suppressCheckpoints > 0) return
      const { doc, past } = get()
      set({ past: [...past.slice(-HISTORY_LIMIT + 1), doc], future: [], lastNudge: 0 })
    },
    undo: () => {
      const { past, doc, future, selection } = get()
      if (!past.length) return
      // Keep the current view preferences (units, settings) — they aren't part of history.
      const prev = { ...past[past.length - 1], units: doc.units, settings: doc.settings }
      set({ doc: prev, past: past.slice(0, -1), future: [doc, ...future], selection: carrySelection(doc, prev, selection), dirty: true, lastNudge: 0 })
    },
    redo: () => {
      const { past, doc, future, selection } = get()
      if (!future.length) return
      const next = { ...future[0], units: doc.units, settings: doc.settings }
      set({ doc: next, past: [...past, doc], future: future.slice(1), selection: carrySelection(doc, next, selection), dirty: true, lastNudge: 0 })
    },

    setDoc: (doc, handle = null) => {
      set({ doc, past: [], future: [], selection: [], shifter: null, fileHandle: handle, dirty: false, mode: 'design', tool: 'select', popover: null, lastNudge: 0, penEditId: null })
      setTimeout(() => get().zoomToFit(), 0)
    },
    rename: (name) => {
      get().checkpoint()
      commitDoc({ ...get().doc, name: name.trim() || 'Untitled' })
    },
    // Units and settings are view preferences, not undo steps (undo/redo keep the current ones).
    setUnits: (units) => {
      if (get().doc.units === units) return
      rememberUnits(units)
      commitDoc({ ...get().doc, units })
    },
    setSetting: (k, v) => {
      commitDoc({ ...get().doc, settings: { ...get().doc.settings, [k]: v } })
    },
    setGridSize: (mm) => {
      if (!(mm > 0) || !Number.isFinite(mm)) return
      commitDoc({ ...get().doc, settings: { ...get().doc.settings, gridSize: mm } })
    },
    setSnapKind: (k, v) => {
      const { doc } = get()
      commitDoc({ ...doc, settings: { ...doc.settings, snap: { ...doc.settings.snap, [k]: v } } })
    },
    setOriginPoint: (p) => {
      // With a whole group selected, the anchor belongs to that group.
      let { doc, selection } = get()
      // Picking one of the nine stock points replaces any custom anchor marker.
      if (typeof p === 'string' && doc.settings.customAnchor) {
        doc = { ...doc, settings: { ...doc.settings, customAnchor: undefined, customAnchorFor: undefined } }
      }
      const g = groupForSelection(doc, selection)
      if (g) {
        // Convert the pick (against the visible selection) to a point on the group's full bounds.
        const f = typeof p === 'string' ? CELL_FRACTION[p] : p
        const vis = shapesBBox(doc.shapes.filter((s) => selection.includes(s.id) && !s.hidden))
        const all = shapesBBox(doc.shapes.filter((s) => s.groupId === g.id))
        const wx = vis.minX + f.fx * (vis.maxX - vis.minX)
        const wy = vis.minY + f.fy * (vis.maxY - vis.minY)
        if (doc !== get().doc) commitDoc(doc)
        get().setGroupAnchor(g.id, {
          fx: (wx - all.minX) / Math.max(all.maxX - all.minX, 1e-9),
          fy: (wy - all.minY) / Math.max(all.maxY - all.minY, 1e-9),
        })
        return
      }
      if (doc.settings.originPoint === p && doc === get().doc) return
      commitDoc({ ...doc, settings: { ...doc.settings, originPoint: p } })
    },
    setGroupAnchor: (groupId, anchor) => {
      const doc = get().doc
      commitDoc({ ...doc, groups: doc.groups.map((g) => (g.id === groupId ? { ...g, anchor } : g)) })
    },
    setCustomAnchor: (p) =>
      commitDoc({ ...get().doc, settings: { ...get().doc.settings, customAnchor: p, customAnchorFor: [...get().selection] } }),
    clearCustomAnchor: () => {
      const { doc } = get()
      const freeOrigin = typeof doc.settings.originPoint === 'object'
      commitDoc({
        ...doc,
        settings: { ...doc.settings, customAnchor: undefined, customAnchorFor: undefined, ...(freeOrigin ? { originPoint: 'mc' as const } : {}) },
      })
    },

    addShapes: (shapes, selectThem = true) => {
      get().checkpoint()
      const doc = get().doc
      commitDoc({ ...doc, shapes: [...doc.shapes, ...shapes] })
      if (selectThem) set({ selection: shapes.map((s) => s.id) })
    },
    swapShapes: (remove, add) => {
      get().checkpoint()
      const doc = get().doc
      commitDoc({ ...doc, shapes: [...doc.shapes.filter((s) => !remove(s)), ...add] })
    },
    addGroupShapes: (group, shapes) => {
      get().checkpoint()
      const doc = get().doc
      commitDoc({ ...doc, shapes: [...doc.shapes, ...shapes], groups: [...doc.groups, group] })
      set({ selection: shapes.map((s) => s.id) })
    },
    importPayload: (p) => {
      const groups: Group[] = []
      const shapes: Shape[] = []
      const take = (part: { group?: Omit<Group, 'id'>; shapes: Omit<Shape, 'id'>[] }) => {
        const g: Group | undefined = part.group && { ...part.group, id: uid('g') }
        if (g) groups.push(g)
        for (const s of part.shapes) shapes.push({ ...s, id: uid(), ...(g && { groupId: g.id }) } as Shape)
      }
      if ('parts' in p) p.parts.forEach(take)
      else take(p)
      const warnings = p.warnings ?? []
      if (!shapes.length) {
        get().showToast(warnings[0] ?? 'Nothing to import')
        return
      }
      // Place the import to the right of existing content so it doesn't overlap.
      const doc = get().doc
      const existing = shapesBBox(doc.shapes.filter((s) => !s.hidden))
      if (bboxValid(existing)) {
        const b = shapesBBox(shapes)
        const dx = existing.maxX + 25 - b.minX
        const dy = existing.minY - b.minY
        for (const s of shapes) {
          s.x += dx
          s.y += dy
        }
      }
      get().checkpoint()
      commitDoc({ ...doc, shapes: [...doc.shapes, ...shapes], groups: [...doc.groups, ...groups] })
      set({ selection: shapes.map((s) => s.id), popover: null })
      setTimeout(() => get().zoomToFit(shapesBBox(shapes)), 0)
      if (warnings.length) get().showToast(warnings.length > 1 ? `${warnings[0]} (+${warnings.length - 1} more)` : warnings[0])
    },
    patchShapes: (ids, fn) => {
      const set_ = new Set(ids)
      const doc = get().doc
      set({ doc: { ...doc, shapes: doc.shapes.map((s) => (set_.has(s.id) ? fn(s) : s)), updatedAt: new Date().toISOString() }, dirty: true })
    },
    updateShapes: (ids, fn) => {
      get().checkpoint()
      get().patchShapes(ids, fn)
    },
    setCut: (ids, cut) => get().updateShapes(ids, (s) => ({ ...s, cut: { ...s.cut, ...cut } })),
    deleteSelected: () => {
      const { selection, doc } = get()
      if (!selection.length) return
      // References are never deleted; with only references selected, Delete does nothing (as in Studio).
      const del = new Set(editableIds(selection, doc))
      if (!del.size) return
      get().checkpoint()
      commitDoc(pruneGroups({ ...doc, shapes: doc.shapes.filter((s) => !del.has(s.id)) }))
      set({ selection: [] })
    },
    duplicateSelected: (inPlace = false) => {
      const { selection, doc } = get()
      const sel = doc.shapes.filter((s) => selection.includes(s.id))
      if (!sel.length) return
      get().checkpoint()
      const off = inPlace ? 0 : doc.units === 'in' ? 6.35 : 5
      // Each source group gets its own fresh group, so copies never join the originals.
      const groupMap = new Map<string, string>()
      const newGroups: Group[] = []
      for (const s of sel) {
        if (!s.groupId || groupMap.has(s.groupId)) continue
        const src = doc.groups.find((g) => g.id === s.groupId)
        const gid = uid('g')
        groupMap.set(s.groupId, gid)
        const grp: Group = { id: gid, name: `${src?.name ?? 'Group'} copy` }
        if (src?.source) grp.source = src.source
        if (src?.info) grp.info = { ...src.info }
        newGroups.push(grp)
      }
      const copies = sel.map((s) => {
        const c = { ...structuredClone(s), id: uid(), x: s.x + off, y: s.y + off, locked: false }
        if (s.groupId) c.groupId = groupMap.get(s.groupId)
        return c
      })
      commitDoc({ ...doc, shapes: [...doc.shapes, ...copies], groups: [...doc.groups, ...newGroups] })
      set({ selection: copies.map((s) => s.id) })
    },
    mirrorSelected: (axis) => {
      const doc = get().doc
      const ids = editableIds(get().selection, doc)
      if (!ids.length) return
      const sel = doc.shapes.filter((s) => ids.includes(s.id))
      // Mirror about the active anchor (a stock point, a group anchor or the custom anchor), not the centre.
      const b = shapesBBox(sel)
      const o = activeOrigin(doc, get().selection) ?? 'mc'
      const c = typeof o === 'object'
        ? { x: b.minX + o.fx * (b.maxX - b.minX), y: b.minY + o.fy * (b.maxY - b.minY) }
        : {
            x: o[1] === 'l' ? b.minX : o[1] === 'r' ? b.maxX : (b.minX + b.maxX) / 2,
            y: o[0] === 't' ? b.minY : o[0] === 'b' ? b.maxY : (b.minY + b.maxY) / 2,
          }
      get().updateShapes(ids, (s0) => {
        const s = bake(s0)
        const flip = (cs: Contour[]) =>
          cs.map((ct) => ({ closed: ct.closed, pts: ct.pts.map((p) => (axis === 'h' ? { x: -p.x, y: p.y } : { x: p.x, y: -p.y })) }))
        const pen = penOf(s)
        return {
          ...s,
          ...(pen
            ? mapCurves(s, pen, (p) => (axis === 'h' ? { x: -p.x, y: p.y } : { x: p.x, y: -p.y }))
            : { contours: flip(s.contours), pen: undefined }),
          x: axis === 'h' ? 2 * c.x - s.x : s.x,
          y: axis === 'v' ? 2 * c.y - s.y : s.y,
          // Text keeps its params (it can be re-typeset); every other kind becomes a plain path.
          kind: s.kind === 'text' ? 'text' : 'path',
          params: s.kind === 'text' ? s.params : undefined,
        }
      })
      // The anchor is a fixed point in the world: it is the mirror axis, so it must not move. Anchors are
      // stored relative to the bounds, which just reflected, so re-express them against the new bounds.
      const after = get().doc
      const g = groupForSelection(after, get().selection)
      if (g?.anchor) {
        const all = shapesBBox(after.shapes.filter((s) => s.groupId === g.id))
        if (bboxValid(all)) {
          get().setGroupAnchor(g.id, {
            fx: (c.x - all.minX) / Math.max(all.maxX - all.minX, 1e-9),
            fy: (c.y - all.minY) / Math.max(all.maxY - all.minY, 1e-9),
          })
        }
      } else if (after.settings.originPoint) {
        const op = after.settings.originPoint
        const swap = (a: string, x: string, y: string) => (a === x ? y : a === y ? x : a)
        const next: OriginRef =
          typeof op === 'object'
            ? { fx: axis === 'h' ? 1 - op.fx : op.fx, fy: axis === 'v' ? 1 - op.fy : op.fy }
            : ((axis === 'h' ? op[0] + swap(op[1], 'l', 'r') : swap(op[0], 't', 'b') + op[1]) as OriginRef)
        commitDoc({ ...after, settings: { ...after.settings, originPoint: next } })
      }
    },
    replaceShapes: (removeIds, add) => {
      get().checkpoint()
      const del = new Set(removeIds)
      const doc = get().doc
      commitDoc(pruneGroups({ ...doc, shapes: [...doc.shapes.filter((s) => !del.has(s.id)), ...add] }))
      set({ selection: add.map((s) => s.id) })
    },
    bringToFront: () => {
      const { selection, doc } = get()
      if (!selection.length) return
      get().checkpoint()
      const sel = new Set(selection)
      commitDoc({ ...doc, shapes: [...doc.shapes.filter((s) => !sel.has(s.id)), ...doc.shapes.filter((s) => sel.has(s.id))] })
    },
    sendToBack: () => {
      const { selection, doc } = get()
      if (!selection.length) return
      get().checkpoint()
      const sel = new Set(selection)
      commitDoc({ ...doc, shapes: [...doc.shapes.filter((s) => sel.has(s.id)), ...doc.shapes.filter((s) => !sel.has(s.id))] })
    },
    unlockAll: () => {
      const doc = get().doc
      if (!doc.shapes.some((s) => s.locked)) {
        get().showToast('Nothing is locked')
        return
      }
      get().checkpoint()
      commitDoc({ ...doc, shapes: doc.shapes.map((s) => (s.locked ? { ...s, locked: false } : s)) })
    },
    setReferenceSelected: (on) => {
      const { doc, selection } = get()
      const sel = new Set(selection)
      const ids = doc.shapes.filter((s) => sel.has(s.id) && !!s.locked !== on).map((s) => s.id)
      if (!ids.length) return
      get().updateShapes(ids, (s) => ({ ...s, locked: on }))
      if (on) get().showToast(REFERENCE_TOAST, { info: 'reference', ms: 5000 })
    },
    toggleReferenceSelected: () => {
      const { selection } = get()
      if (!selection.length) return
      const sel = new Set(selection)
      get().updateShapes(selection, (s) => (sel.has(s.id) ? { ...s, locked: !s.locked } : s))
    },
    groupSelected: () => {
      const { doc, selection } = get()
      const sel = new Set(selection)
      // Locked shapes are never edited, so they never join (or leave) a group.
      const ids = doc.shapes.filter((s) => sel.has(s.id) && !s.locked).map((s) => s.id)
      if (ids.length < 2) {
        if (selection.length >= 2) get().showToast('Locked shapes can’t be grouped. Unlock them first.')
        return
      }
      if (selectedGroup(doc, ids)) return // already one group
      if (groupAction(doc, ids) !== 'group') {
        get().showToast('Box joints and 3D carves can’t be grouped with other objects')
        return
      }
      const group: Group = { id: uid('g'), name: nextGroupName(doc), source: 'user' }
      const members = new Set(ids)
      get().checkpoint()
      commitDoc(
        pruneGroups({
          ...doc,
          shapes: doc.shapes.map((s) => (members.has(s.id) ? { ...s, groupId: group.id } : s)),
          groups: [...doc.groups, group],
        }),
      )
      set({ selection: ids })
    },
    ungroupSelected: () => {
      const { doc, selection } = get()
      const g = selectedGroup(doc, selection)
      if (!g) return
      if (isFeatureGroup(doc, g.id)) {
        get().showToast('Box joints and 3D carves can’t be ungrouped')
        return
      }
      const ids = doc.shapes.filter((s) => s.groupId === g.id && !s.locked).map((s) => s.id)
      if (!ids.length) {
        get().showToast('Locked shapes can’t be ungrouped. Unlock them first.')
        return
      }
      const members = new Set(ids)
      get().checkpoint()
      commitDoc(
        pruneGroups({
          ...doc,
          shapes: doc.shapes.map((s) => {
            if (!members.has(s.id)) return s
            const { groupId: _drop, ...rest } = s
            return rest
          }),
        }),
      )
      set({ selection: ids })
    },

    select: (ids) => set({ selection: ids }),
    selectGroup: (groupId) => set({ selection: get().doc.shapes.filter((s) => s.groupId === groupId && !s.locked).map((s) => s.id) }),
    setMode: (mode) => {
      const { doc, selection } = get()
      let next = selection
      // Plan selects grouped elements one at a time; Design only ever selects whole groups.
      if (mode === 'design' && selection.length) {
        const sel = new Set(selection)
        const groups = new Set(doc.shapes.filter((s) => sel.has(s.id) && s.groupId).map((s) => s.groupId))
        if (groups.size) {
          const all = new Set(selection)
          for (const s of doc.shapes) if (s.groupId && groups.has(s.groupId) && !s.locked) all.add(s.id)
          if (all.size !== sel.size) next = [...all]
        }
      }
      // References exist only in Design: they are hidden in Plan and Review, so they leave the selection.
      if (mode !== 'design') next = next.filter((id) => !doc.shapes.find((s) => s.id === id)?.locked)
      set({ mode, selection: next, tool: 'select', popover: null, anchorPicking: false, penEditId: null })
    },
    setTool: (tool) => set({ tool, popover: null, penEditId: null }),
    setAnchorPicking: (anchorPicking) => set({ anchorPicking }),
    setPenEdit: (penEditId) => set({ penEditId }),
    setPlanHighlight: (planHighlight) => set({ planHighlight }),
    setView: (v) => set({ view: { ...get().view, ...v } }),
    setViewport: (w, h) => set({ viewport: { w, h } }),
    zoomToFit: (bbox) => {
      const { doc, viewport } = get()
      const b = bbox ?? shapesBBox(doc.shapes.filter((s) => !s.hidden))
      if (!bboxValid(b)) {
        // Empty design: show ~12 inches across, origin centred.
        const zoom = Math.max(0.05, viewport.w / 320)
        set({ view: { zoom, panX: viewport.w / 2, panY: viewport.h / 2 } })
        return
      }
      // Studio frames the content at 70% of the viewport on its tighter axis.
      const w = Math.max(bboxW(b), 1)
      const h = Math.max(bboxH(b), 1)
      const zoom = Math.max(0.05, Math.min((viewport.w * FIT_FRACTION) / w, (viewport.h * FIT_FRACTION) / h, 400))
      const c = bboxCenter(b)
      set({ view: { zoom, panX: viewport.w / 2 - c.x * zoom, panY: viewport.h / 2 - c.y * zoom } })
    },
    zoomBy: (factor, cx, cy) => {
      if (!Number.isFinite(factor) || factor <= 0) return
      const { view, viewport } = get()
      const x = cx ?? viewport.w / 2
      const y = cy ?? viewport.h / 2
      const zoom = Math.max(0.05, Math.min(2000, view.zoom * factor))
      const k = zoom / view.zoom
      set({ view: { zoom, panX: x - (x - view.panX) * k, panY: y - (y - view.panY) * k } })
    },
    zoomIn: () => get().zoomBy(1.25),
    zoomOut: () => get().zoomBy(0.8),
    openDialog: (dialog) => set({ dialog, popover: null, menuOpen: false }),
    setPopover: (popover) => set({ popover }),
    enterShapeShifter: () => {
      const sel = editableIds(get().selection)
      // A lone result of an earlier merge re-opens ShapeShifter on its surviving sources,
      // or rebuilds them from the snapshot in its meta once they are gone; finish replaces it.
      if (sel.length === 1) {
        const shape = get().doc.shapes.find((s) => s.id === sel[0])
        if (!shape?.meta?.shifterOf?.length) {
          get().showToast('Select two or more overlapping shapes')
          return
        }
        const alive = editableIds(shape.meta.shifterOf)
        if (alive.length) {
          set({ shifter: { ids: alive, editId: shape.id }, popover: null, menuOpen: false })
          return
        }
        // Ghosts share the result's placement, so the snapshot's local-frame contours land where the merge happened.
        const snap = shape.meta.shifterSources ?? []
        const ghosts = snap.map((contours, i) => ({ ...shape, id: `${shape.id}#s${i}`, contours, meta: { shifterOf: shape.meta!.shifterOf } }))
        set({ shifter: ghosts.length ? { ids: [], ghosts, editId: shape.id } : { ids: [shape.id], editId: shape.id }, popover: null, menuOpen: false })
        return
      }
      if (sel.length < 2) {
        get().showToast('Select two or more overlapping shapes')
        return
      }
      set({ shifter: { ids: sel }, popover: null, menuOpen: false })
    },
    exitShapeShifter: () => set({ shifter: null }),
    setMenuOpen: (menuOpen) => set({ menuOpen, popover: null }),
    setEditingText: (editingTextId) => set({ editingTextId }),
    setFileHandle: (fileHandle) => set({ fileHandle }),
    markSaved: (savedDoc) => {
      if (!savedDoc || get().doc === savedDoc) set({ dirty: false })
    },
    showToast: (toast, opts) => {
      clearTimeout(toastTimer)
      set({ toast, toastInfo: opts?.info ?? null })
      toastTimer = setTimeout(() => set({ toast: null, toastInfo: null }), opts?.ms ?? 2600)
    },
  }
})

export const selectedShapes = (s: { doc: StudioDoc; selection: string[] }) => {
  const sel = new Set(s.selection)
  return s.doc.shapes.filter((x) => sel.has(x.id))
}
