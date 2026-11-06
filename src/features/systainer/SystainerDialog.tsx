// Full-screen "Systainer Insert" dialog: drag Shaper gear from the catalogue into a Festool T-Loc
// Systainer, flip and turn it, and add the foam insert (outline + pockets) to the design.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react'
import type { ImportPayload, StudioDoc, Units } from '../../model/types'
import { fmtLen } from '../../model/factory'
import { uid } from '../../model/ids'
import { exportSVG } from '../../io/svgExport'
import { offsetContours } from '../../geometry/offset'
import { pointInContours } from '../../geometry/transform'
import { IconClose, IconDelete, IconDownload, IconDuplicate, IconRedo, IconUndo } from '../../ui/icons'
import { NumField } from '../../editor/Panels'
import { Field } from '../carve3d/fields'
import { CATEGORIES, getItem, ITEMS, itemParams, type CategoryId, type ItemDef } from './catalog'
import { CUTTING_BITS, defaultLayout, depthRange, fillThickness, SHAPER_FOAM, evaluate, insertShapes, placedDepth, posed, type Fit, type Layout, type Placed } from './layout'
import { baseDepth, insertOutline, SYS_SIZES, sysSpec, type SysSize } from './systainerModel'
import SystainerViewer, { type ViewerHandle, type ViewMode } from './SystainerViewer'
import { itemThumb } from './thumbs'
import '../carve3d/carve3d.css'
import './systainer.css'

export interface SystainerDialogProps {
  units: Units
  onClose: () => void
  onImport: (p: ImportPayload) => void
}

const STORE_KEY = 'formastudio:systainer-layout'

/** A fresh random spin for each roll of a newly placed tape item (see ItemDef.randomSpin). */
const newSpinSeed = () => Math.floor(Math.random() * 0x7fffffff)

function loadSaved(): Layout | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const l = JSON.parse(raw) as Layout
    if (!Array.isArray(l.items) || !SYS_SIZES.some((s) => s.size === l.size)) return null
    return { ...defaultLayout(), ...l, items: l.items.filter((i) => getItem(i.item)) }
  } catch {
    return null
  }
}

/** Keep a dragged item's centre over the insert. */
const clampX = (x: number) => Math.min(192, Math.max(-192, x))
const clampY = (y: number) => Math.min(142, Math.max(-140, y))

const norm = (deg: number) => ((Math.round(deg * 100) / 100) % 360 + 360) % 360

/** A free spot for a new item: the first place (back-left first) where its footprint clears the walls and the rest. */
function freeSpot(layout: Layout, def: ItemDef): { x: number; y: number } {
  const ev = evaluate(layout)
  const p = posed(def, 0, itemParams(def))
  const w = p.w / 2 + ev.clearance + 2
  const d = p.d / 2 + ev.clearance + 2
  const room = offsetContours([insertOutline()], -3)
  const pts = room.flatMap((c) => c.pts)
  const [x0, x1, y0, y1] = [Math.min(...pts.map((q) => q.x)), Math.max(...pts.map((q) => q.x)), Math.min(...pts.map((q) => q.y)), Math.max(...pts.map((q) => q.y))]
  const boxes = ev.pockets.map((pk) => {
    const q = pk.contours.flatMap((c) => c.pts)
    return { x0: Math.min(...q.map((v) => v.x)), x1: Math.max(...q.map((v) => v.x)), y0: Math.min(...q.map((v) => v.y)), y1: Math.max(...q.map((v) => v.y)) }
  })
  const inside = (x: number, y: number) => pointInContours({ x, y }, room)
  for (let y = y1 - d; y >= y0 + d; y -= 5)
    for (let x = x0 + w; x <= x1 - w; x += 5) {
      if (!(inside(x - w, y - d) && inside(x + w, y - d) && inside(x - w, y + d) && inside(x + w, y + d))) continue
      if (boxes.every((b) => x + w < b.x0 || x - w > b.x1 || y + d < b.y0 || y - d > b.y1)) return { x, y }
    }
  return { x: 0, y: 0 }
}

/** The insert as Studio would export it, for the SVG preview and download. */
function previewSvg(layout: Layout, units: Units): string {
  const ev = evaluate(layout)
  const gid = 'systainer'
  const shapes = insertShapes(ev, layout, units).map((s, i) => ({ ...s, id: `s${i}`, groupId: gid }))
  const doc: StudioDoc = {
    app: 'FormaStudio',
    version: 1,
    id: 'preview',
    name: `Systainer insert ${sysSpec(layout.size).name}`,
    units,
    shapes,
    groups: [{ id: gid, name: `Systainer insert – ${sysSpec(layout.size).name}` }],
    settings: { smartAlignment: true, showPosition: false, originAnchor: false, cutPathDisplay: false },
    createdAt: '',
    updatedAt: '',
  }
  return exportSVG(doc)
}

function SvgPreview({ layout, units }: { layout: Layout; units: Units }) {
  const svg = useMemo(() => previewSvg(layout, units), [layout, units])
  // A data URL: nothing to revoke (a blob URL would die in StrictMode's effect replay).
  const url = useMemo(() => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), [svg])
  const ev = useMemo(() => evaluate(layout), [layout])
  const depths = [...new Set(ev.pockets.map((p) => +p.depth.toFixed(2)))].sort((a, b) => a - b)
  const L = (mm: number) => fmtLen(mm, units)
  return (
    <div className="sys-svg">
      <div className="sys-svg__paper">
        <img src={url} alt="Insert SVG preview" className="sys-svg__img" draggable={false} />
      </div>
      <div className="sys-svg__legend">
        <span className="sys-key sys-key--outside" /> Outside cut, {L(ev.thickness)} deep
        <span className="sys-key sys-key--pocket" /> Pockets{depths.length ? `: ${depths.map(L).join(', ')}` : ''}
        <a className="ss-btn sys-svg__dl" href={url} download={`systainer-insert-${sysSpec(layout.size).name.replace(' ', '')}.svg`}>
          <IconDownload size={18} /> Download SVG
        </a>
      </div>
    </div>
  )
}

function Tile({ def, onPointerDown, onAdd }: { def: ItemDef; onPointerDown: (e: RPointerEvent, def: ItemDef) => void; onAdd: (def: ItemDef) => void }) {
  const [src, setSrc] = useState<string>('')
  useEffect(() => {
    // Render after paint so opening the dialog stays snappy.
    const t = setTimeout(() => setSrc(itemThumb(def)), 0)
    return () => clearTimeout(t)
  }, [def])
  return (
    <button
      type="button"
      className="sys-tile"
      title={`${def.name} — drag into the Systainer, or click to add`}
      onPointerDown={(e) => onPointerDown(e, def)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onAdd(def))}
    >
      <span className="sys-tile__img">{src && <img src={src} alt="" draggable={false} />}</span>
      <span className="sys-tile__label">{def.short}</span>
    </button>
  )
}

export default function SystainerDialog({ units, onClose, onImport }: SystainerDialogProps) {
  const [layout, setLayout] = useState<Layout>(() => loadSaved() ?? defaultLayout())
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode | 'svg'>('3d')
  const [lidOpen, setLidOpen] = useState(true)
  const [cat, setCat] = useState<CategoryId>('origin')
  const past = useRef<Layout[]>([])
  const future = useRef<Layout[]>([])
  const dragBase = useRef<Layout | null>(null)
  /** Undo/redo depths, for the buttons. */
  const [hist, setHist] = useState({ past: 0, future: 0 })
  const syncHist = () => setHist({ past: past.current.length, future: future.current.length })
  const viewer = useRef<ViewerHandle>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const layoutRef = useRef(layout)
  useLayoutEffect(() => {
    layoutRef.current = layout
  }, [layout])
  /** Set the layout; the ref follows at once so back-to-back events build on each other. */
  const put = (next: Layout) => {
    layoutRef.current = next
    setLayout(next)
  }

  const ev = useMemo(() => evaluate(layout), [layout])
  const L = (mm: number) => fmtLen(mm, units)

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(layout))
    } catch {
      // Storage full or blocked: the layout just isn't remembered.
    }
  }, [layout])

  /** Apply a change as one undo step. */
  const commit = useCallback((next: Layout) => {
    past.current.push(layoutRef.current)
    if (past.current.length > 200) past.current.shift()
    future.current = []
    put(next)
    syncHist()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  /** A change during a drag: one undo step when it ends. */
  const live = useCallback((next: Layout, done: boolean) => {
    dragBase.current ??= layoutRef.current
    put(next)
    if (done) {
      past.current.push(dragBase.current)
      future.current = []
      dragBase.current = null
      syncHist()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const undo = useCallback(() => {
    const prev = past.current.pop()
    if (!prev) return
    future.current.push(layoutRef.current)
    put(prev)
    syncHist()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const redo = useCallback(() => {
    const next = future.current.pop()
    if (!next) return
    past.current.push(layoutRef.current)
    put(next)
    syncHist()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const patchItem = useCallback(
    (id: string, patch: Partial<Placed>, mode: 'commit' | 'live' | 'end' = 'commit') => {
      const cur = layoutRef.current
      const next = { ...cur, items: cur.items.map((i) => (i.uid === id ? { ...i, ...patch } : i)) }
      if (mode === 'commit') commit(next)
      else live(next, mode === 'end')
    },
    [commit, live],
  )
  const setLayoutField = (patch: Partial<Layout>) => commit({ ...layoutRef.current, ...patch })

  const addItem = useCallback(
    (def: ItemDef, at?: { x: number; y: number }) => {
      const cur = layoutRef.current
      const pos = at ?? freeSpot(cur, def)
      const item: Placed = {
        uid: uid('it'),
        item: def.id,
        x: pos.x,
        y: pos.y,
        rot: 0,
        pose: 0,
        depth: null,
        ...(def.params && { params: itemParams(def) }),
        ...(def.randomSpin && { spinSeed: newSpinSeed() }),
      }
      commit({ ...cur, items: [...cur.items, item] })
      setSelected(item.uid)
    },
    [commit],
  )
  const removeItem = useCallback(
    (id: string) => {
      const cur = layoutRef.current
      commit({ ...cur, items: cur.items.filter((i) => i.uid !== id) })
      setSelected((s) => (s === id ? null : s))
    },
    [commit],
  )
  const duplicate = useCallback(
    (id: string) => {
      const cur = layoutRef.current
      const src = cur.items.find((i) => i.uid === id)
      const def = src && getItem(src.item)
      if (!src || !def) return
      const p = posed(def, src.pose, itemParams(def, src.params))
      const copy = {
        ...src,
        uid: uid('it'),
        x: src.x + Math.min(40, p.w * 0.5 + 8),
        y: src.y - Math.min(40, p.d * 0.5 + 8),
        ...(def.randomSpin && { spinSeed: newSpinSeed() }),
      }
      commit({ ...cur, items: [...cur.items, copy] })
      setSelected(copy.uid)
    },
    [commit],
  )
  const flip = useCallback(
    (id: string, to?: number) => {
      const it = layoutRef.current.items.find((i) => i.uid === id)
      const def = it && getItem(it.item)
      if (!it || !def || def.poses.length < 2) return
      patchItem(id, { pose: to ?? (it.pose + 1) % def.poses.length, depth: null })
    },
    [patchItem],
  )
  const rotateBy = useCallback(
    (id: string, deg: number) => {
      const it = layoutRef.current.items.find((i) => i.uid === id)
      if (it) patchItem(id, { rot: norm(it.rot + deg) })
    },
    [patchItem],
  )
  /** New sizes for an item. Notches and cutouts keep a custom depth; an object keeps it unless its height changed. */
  const setParams = useCallback(
    (id: string, params: Record<string, number>, mode: 'commit' | 'live' | 'end' = 'commit') => {
      const it = layoutRef.current.items.find((i) => i.uid === id)
      const def = it && getItem(it.item)
      if (!it || !def) return
      const keep = def.notch || def.cutout || Math.abs(posed(def, it.pose, itemParams(def, it.params)).height - posed(def, it.pose, itemParams(def, params)).height) < 1e-6
      patchItem(id, keep ? { params } : { params, depth: null }, mode)
    },
    [patchItem],
  )
  /** The toolbar's depth slider while a pointer holds it (one undo step per drag). */
  const depthSlide = useRef<{ uid: string; changed: boolean } | null>(null)
  const endDepthSlide = useCallback(() => {
    const s = depthSlide.current
    depthSlide.current = null
    const it = s?.changed && layoutRef.current.items.find((i) => i.uid === s.uid)
    if (it) patchItem(it.uid, { depth: it.depth }, 'end')
  }, [patchItem])

  // Keyboard: captured ahead of the editor so Escape clears the selection before closing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const mod = e.metaKey || e.ctrlKey
      const k = e.key.toLowerCase()
      const sel = selected
      let handled = true
      if (mod && k === 'z') {
        if (e.shiftKey) redo()
        else undo()
      } else if (mod && k === 'y') redo()
      else if (mod && k === 'd' && sel) duplicate(sel)
      else if (mod) handled = false
      else if (k === 'escape') {
        if (sel) setSelected(null)
        else onClose()
      } else if ((k === 'delete' || k === 'backspace') && sel) removeItem(sel)
      else if (k === 'r' && sel) rotateBy(sel, e.shiftKey ? 90 : -90)
      else if (k === 'f' && sel) flip(sel)
      else if (k.startsWith('arrow') && sel) {
        const it = layoutRef.current.items.find((i) => i.uid === sel)
        const s = e.shiftKey ? 10 : 1
        if (it) patchItem(sel, { x: it.x + (k === 'arrowleft' ? -s : k === 'arrowright' ? s : 0), y: it.y + (k === 'arrowdown' ? -s : k === 'arrowup' ? s : 0) })
      } else handled = false
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selected, undo, redo, duplicate, removeItem, rotateBy, flip, patchItem, onClose])

  // Dragging a tile from the catalogue into the view (a plain click adds it in a free spot).
  const [dragging, setDragging] = useState<{ def: ItemDef; x: number; y: number } | null>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const onTileDown = (e: RPointerEvent, def: ItemDef) => {
    if (e.button !== 0) return
    const sx = e.clientX
    const sy = e.clientY
    // The dock is a tall column beside the view on desktop, a strip under it on phones.
    const dr = dockRef.current?.getBoundingClientRect()
    const column = !!dr && dr.height > dr.width
    let started = false
    const move = (m: PointerEvent) => {
      // Touch: a swipe along the dock scrolls it; only a pull across it, toward the view, drags.
      const along = Math.abs(column ? m.clientY - sy : m.clientX - sx)
      const across = Math.abs(column ? m.clientX - sx : m.clientY - sy)
      if (!started && (m.pointerType === 'mouse' ? Math.hypot(along, across) > 5 : across > 10 && across > along)) started = true
      if (!started) return
      m.preventDefault()
      setDragging({ def, x: m.clientX, y: m.clientY })
      const at = viewer.current?.pick(m.clientX, m.clientY)
      viewer.current?.ghost(at ? { item: def.id, ...at } : null)
    }
    const up = (u: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      viewer.current?.ghost(null)
      setDragging(null)
      if (u.type === 'pointercancel') return
      if (!started) return addItem(def)
      const at = viewer.current?.pick(u.clientX, u.clientY)
      if (at) addItem(def, at)
    }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  function add() {
    const shapes = insertShapes(ev, layout, units)
    const spec = sysSpec(layout.size)
    onImport({
      group: {
        name: `Systainer insert – ${spec.name}`,
        info: {
          systainer: `Festool ${spec.name} T-Loc`,
          thickness: L(ev.thickness),
          items: layout.items.length,
          fit: `${layout.fit} (${L(ev.clearance)} per side)`,
          cutter: ev.bit.name,
        },
      },
      shapes,
    })
    onClose()
  }

  const sel = layout.items.find((i) => i.uid === selected)
  const selDef = sel && getItem(sel.item)
  const selEv = sel && ev.items.find((e) => e.uid === sel.uid)
  const selPose = selDef && sel ? selDef.poses[sel.pose] ?? selDef.poses[0] : undefined
  const selRange = selEv ? depthRange(selEv, ev) : null
  const problems = ev.items.filter((e) => e.problems.length).length
  const tiles = ITEMS.filter((d) => d.cats.includes(cat))
  const spec = sysSpec(layout.size)

  return (
    <div className="ss-dialog c3d-dialog sys-dialog" role="dialog" aria-label="Systainer Insert">
      <div className="ss-dialog__header">
        <h1 className="ss-dialog__title">Systainer Insert</h1>
      </div>

      <div className="ss-dialog__body">
        <div className="ss-dialog__main sys-main">
          {/* The viewport: the 3D/2D stage (or the SVG preview) and its overlay. The catalogue dock
              sits beside it (below it on phones), never over it. */}
          <div className="sys-view">
          <div className={'sys-stage' + (view === 'svg' ? ' is-hidden' : '')}>
            <SystainerViewer
              ref={viewer}
              layout={layout}
              ev={ev}
              selected={selected}
              view={view === '2d' ? '2d' : '3d'}
              lidOpen={lidOpen}
              toolbarRef={toolbarRef}
              onSelect={setSelected}
              onMove={(id, x, y, done) => patchItem(id, { x: clampX(x), y: clampY(y) }, done ? 'end' : 'live')}
              onRotate={(id, rot, done) => patchItem(id, { rot: norm(rot) }, done ? 'end' : 'live')}
              onResize={(id, params, done) => setParams(id, params, done ? 'end' : 'live')}
            />
            {sel && selDef && view !== 'svg' && (
              <div ref={toolbarRef} className="sys-toolbar" style={{ visibility: 'hidden' }} onPointerDown={(e) => e.stopPropagation()}>
                <div className="sys-toolbar__inner">
                  <div className="sys-toolbar__row">
                    {selDef.poses.length > 1 && (
                      <button type="button" className="sys-tb-btn sys-tb-btn--flip" title="Flip to the next orientation (F)" onClick={() => flip(sel.uid)}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3" />
                          <path d="M18 3v4h-4M6 21v-4h4" />
                        </svg>
                        <span>{selPose?.label}</span>
                      </button>
                    )}
                    <button type="button" className="sys-tb-btn" title="Turn 90° left (⇧R)" aria-label="Turn 90° left" onClick={() => rotateBy(sel.uid, 90)}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4 12a8 8 0 1 0 2.3-5.7" />
                        <path d="M4 4v4h4" />
                      </svg>
                    </button>
                    <button type="button" className="sys-tb-btn" title="Turn 90° right (R)" aria-label="Turn 90° right" onClick={() => rotateBy(sel.uid, -90)}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M20 12a8 8 0 1 1-2.3-5.7" />
                        <path d="M20 4v4h-4" />
                      </svg>
                    </button>
                    <span className="sys-toolbar__angle">{Math.round(sel.rot)}°</span>
                    <button type="button" className="sys-tb-btn" title="Duplicate (⌘D)" aria-label="Duplicate" onClick={() => duplicate(sel.uid)}>
                      <IconDuplicate size={16} />
                    </button>
                    <button type="button" className="sys-tb-btn" title="Remove (Delete)" aria-label="Remove" onClick={() => removeItem(sel.uid)}>
                      <IconDelete size={18} />
                    </button>
                  </div>
                  {selEv && selRange && (
                    <label className="sys-toolbar__depth" title={selDef.notch ? 'How deep it cuts' : 'How deep it sits in the foam'}>
                      <span className="sys-toolbar__label">Depth</span>
                      <input
                        type="range"
                        className="sys-depth"
                        min={selRange.min}
                        max={selRange.max}
                        step={0.5}
                        value={Math.min(selRange.max, Math.max(selRange.min, selEv.sink))}
                        disabled={selRange.max - selRange.min < 0.5}
                        aria-valuetext={L(selEv.sink)}
                        style={{ '--p': `${(selRange.max > selRange.min ? (Math.min(selRange.max, Math.max(selRange.min, selEv.sink)) - selRange.min) / (selRange.max - selRange.min) : 1) * 100}%` } as CSSProperties}
                        onPointerDown={() => {
                          depthSlide.current = { uid: sel.uid, changed: false }
                          // The release can land off the slider.
                          window.addEventListener('pointerup', endDepthSlide, { once: true })
                        }}
                        onChange={(e) => {
                          // Stored depths belong to the reference thickness (placedDepth converts).
                          const v = Math.round(placedDepth(selEv, ev, +e.target.value) * 100) / 100
                          const s = depthSlide.current
                          if (s && s.uid === sel.uid) {
                            s.changed = true
                            patchItem(sel.uid, { depth: v }, 'live')
                          } else patchItem(sel.uid, { depth: v })
                        }}
                        onBlur={endDepthSlide}
                      />
                      <span className="sys-toolbar__value">{L(selEv.sink)}</span>
                    </label>
                  )}
                </div>
              </div>
            )}
          </div>
          {view === 'svg' && <SvgPreview layout={layout} units={units} />}

          <div className="c3d-overlay sys-overlay">
            <div className="ss-seg c3d-viewtoggle" role="group" aria-label="View">
              {(['3d', '2d', 'svg'] as const).map((v) => (
                <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>
                  {v === 'svg' ? 'SVG' : v.toUpperCase()}
                </button>
              ))}
            </div>
            {view === '3d' && (
              <button type="button" className="ss-btn sys-lid" aria-pressed={!lidOpen} onClick={() => setLidOpen((o) => !o)} title="Shut the lid to check what stands proud">
                {lidOpen ? 'Close lid' : 'Open lid'}
              </button>
            )}
            <div className="sys-undo">
              <button type="button" className="sys-tb-btn" aria-label="Undo" title="Undo (⌘Z)" disabled={!hist.past} onClick={undo}>
                <IconUndo size={18} />
              </button>
              <button type="button" className="sys-tb-btn" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!hist.future} onClick={redo}>
                <IconRedo size={18} />
              </button>
            </div>
            <span className="ss-muted sys-overlay__info">
              {spec.name} · {layout.items.length} item{layout.items.length === 1 ? '' : 's'}
              {problems > 0 && <span className="sys-badge-warn"> · {problems} to fix</span>}
            </span>
          </div>

          {layout.items.length === 0 && view !== 'svg' && (
            <div className="sys-empty">
              <strong>Drag gear from the catalogue into the Systainer</strong>
              <span>Flip it with the toolbar, turn it with the blue ring. The pockets follow.</span>
            </div>
          )}
          </div>

          {view !== 'svg' && (
            <div ref={dockRef} className="sys-dock" aria-label="Catalogue">
              <div className="sys-dock__tabs" role="tablist">
                {CATEGORIES.map((c) => (
                  <button key={c.id} type="button" role="tab" aria-selected={cat === c.id} className={'sys-dock__tab' + (cat === c.id ? ' is-active' : '')} onClick={() => setCat(c.id)}>
                    {c.label}
                  </button>
                ))}
              </div>
              <span className="sys-dock__hint ss-muted">Drag into the Systainer, or click to add</span>
              <div className="sys-dock__strip">
                {tiles.map((d) => (
                  <Tile key={d.id} def={d} onPointerDown={onTileDown} onAdd={addItem} />
                ))}
              </div>
            </div>
          )}
        </div>

        <aside className="ss-dialog__side c3d-side sys-side">
          <div className="c3d-section">
            <div className="ss-section-title">systainer</div>
            <div className="ss-seg sys-sizes" role="group" aria-label="Systainer size">
              {SYS_SIZES.map((s) => (
                <button key={s.size} type="button" aria-pressed={layout.size === s.size} onClick={() => setLayoutField({ size: s.size as SysSize, thickness: null })}>
                  {s.name}
                </button>
              ))}
            </div>
            <span className="c3d-muted-note">
              Festool T-Loc · {L(396)} × {L(296)} × {L(spec.height)} outside · {L(387.5)} × {L(284)} insert
            </span>
          </div>

          <div className="c3d-section">
            <div className="ss-section-title">insert</div>
            <Field label={`thickness${layout.thickness == null ? ' (Shaper stock foam)' : ''}`}>
              <div className="c3d-row">
                <NumField label="Insert thickness" adorn="T" units={units} value={ev.thickness} onCommit={(v) => v > 0 && setLayoutField({ thickness: Math.round(v * 10) / 10 })} />
                {layout.thickness != null && (
                  <button type="button" className="dt-link sys-link" title={`Shaper's stock insert, ${L(SHAPER_FOAM)}`} onClick={() => setLayoutField({ thickness: null })}>
                    stock
                  </button>
                )}
                {layout.thickness !== fillThickness(layout.size) && (
                  <button type="button" className="dt-link sys-link" title="Fill the base to the rim" onClick={() => setLayoutField({ thickness: fillThickness(layout.size) })}>
                    fill
                  </button>
                )}
              </div>
            </Field>
            <span className="c3d-muted-note">
              Base is {L(baseDepth(layout.size))} deep. {ev.lidRoom >= 0 ? `${L(ev.lidRoom)} of room above the foam with the lid shut.` : 'Too thick for the lid to close.'} Default depths are the ShaperHub ones, cut in Shaper’s {L(SHAPER_FOAM)} stock foam; a thicker or thinner insert moves them all by the difference.
            </span>
            <Field label="fit">
              <div className="ss-seg" role="group" aria-label="Fit">
                {(['snug', 'standard', 'loose'] as Fit[]).map((f) => (
                  <button key={f} type="button" aria-pressed={layout.fit === f} onClick={() => setLayoutField({ fit: f })}>
                    {f[0].toUpperCase() + f.slice(1)}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="cutter">
              <select className="ss-select" aria-label="Cutter" value={ev.bit.id} onChange={(e) => setLayoutField({ bitId: e.target.value })}>
                {CUTTING_BITS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {sel && selDef && selEv && (
            <div className="c3d-section sys-selected">
              <div className="ss-section-title">selected</div>
              <div className="sys-selected__name">
                {selDef.name}
                {selDef.approx && (
                  <span className="sys-approx" title="Size estimated, not from the maker. Check it against yours.">
                    ≈ size
                  </span>
                )}
              </div>
              {selDef.note && <span className="c3d-muted-note">{selDef.note}</span>}
              {selDef.poses.length > 1 && (
                <Field label="orientation">
                  <div className="sys-poses" role="group" aria-label="Orientation">
                    {selDef.poses.map((p, i) => (
                      <button key={p.id} type="button" aria-pressed={sel.pose === i} className="sys-pose" onClick={() => flip(sel.uid, i)}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                </Field>
              )}
              <div className="c3d-two">
                <Field label="turn">
                  <NumField label="Turn" adorn="∠" kind="angle" units={units} value={sel.rot} onCommit={(v) => patchItem(sel.uid, { rot: norm(v) })} />
                </Field>
                <Field label={selDef.notch ? 'depth' : 'sits'}>
                  <NumField label="Depth" adorn="D" units={units} value={selEv.sink} onCommit={(v) => v > 0 && patchItem(sel.uid, { depth: placedDepth(selEv, ev, v) })} />
                </Field>
              </div>
              <span className="c3d-muted-note">
                {selDef.notch
                  ? sel.depth == null
                    ? 'Depth follows the pocket it overlaps.'
                    : 'Custom depth.'
                  : selEv.above > 0.05
                    ? `Stands ${L(selEv.above)} above the foam.`
                    : 'Flush with the foam.'}
                {selEv.pockets.length > 1 && ` Stepped pocket: ${selEv.pockets.map((p) => L(p.depth)).join(' / ')}.`}
                {sel.depth != null && (
                  <>
                    {' '}
                    <button type="button" className="dt-link sys-link" onClick={() => patchItem(sel.uid, { depth: null })}>
                      auto
                    </button>
                  </>
                )}
              </span>
              {selDef.params && (
                <div className="c3d-three">
                  {selDef.params.map((pd) => (
                    <Field key={pd.key} label={pd.label.toLowerCase()}>
                      <NumField
                        label={pd.label}
                        units={units}
                        value={itemParams(selDef, sel.params)[pd.key]}
                        onCommit={(v) => v > 0 && setParams(sel.uid, { ...itemParams(selDef, sel.params), [pd.key]: Math.min(pd.max, Math.max(pd.min, v)) })}
                      />
                    </Field>
                  ))}
                </div>
              )}
              {selEv.problems.map((p) => (
                <div key={p} className="c3d-warn">
                  {p}
                </div>
              ))}
            </div>
          )}

          <div className="c3d-section">
            <div className="c3d-row c3d-row--between">
              <div className="ss-section-title">in the insert</div>
              {layout.items.length > 0 && (
                <button
                  type="button"
                  className="dt-link sys-link"
                  onClick={() => {
                    commit({ ...layout, items: [] })
                    setSelected(null)
                  }}
                >
                  clear all
                </button>
              )}
            </div>
            {layout.items.length === 0 ? (
              <span className="c3d-muted-note">Nothing yet. The insert outline alone still fits your Systainer.</span>
            ) : (
              <ul className="sys-list">
                {ev.items.map((e) => (
                  <li key={e.uid} className={'sys-list__row' + (e.uid === selected ? ' is-selected' : '') + (e.problems.length ? ' has-problem' : '')}>
                    <button type="button" className="sys-list__name" onClick={() => setSelected(e.uid)} title={e.problems.join(' ') || e.def.name}>
                      {e.problems.length > 0 && <span className="sys-dot" aria-label="Needs attention" />}
                      {e.def.short}
                      <span className="ss-muted">{L(e.pockets[0]?.depth ?? 0)}</span>
                    </button>
                    <button type="button" className="sys-list__del" aria-label={`Remove ${e.def.short}`} onClick={() => removeItem(e.uid)}>
                      <IconClose size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="c3d-muted-note">
            Pockets follow each item’s shape below the foam and step down where it rests lower. Sizes marked ≈ are estimates: check them against your own gear before cutting. Systainer model: Festool T-Loc reference
            models (Printables, CC BY-NC-SA).
          </div>
        </aside>
      </div>

      <div className="ss-dialog__footer">
        <button type="button" className="ss-btn ss-btn--primary" onClick={add} title={problems ? `${problems} item${problems === 1 ? '' : 's'} need attention` : undefined}>
          Add to Design
        </button>
        <button type="button" className="ss-btn-round" onClick={onClose} aria-label="Cancel">
          <IconClose />
        </button>
      </div>

      {dragging && (
        <div className="sys-dragchip" style={{ transform: `translate(${dragging.x}px, ${dragging.y}px)` }} aria-hidden="true">
          {dragging.def.short}
        </div>
      )}
    </div>
  )
}

