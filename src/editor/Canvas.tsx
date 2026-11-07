import { useEffect, useMemo, useReducer, useRef, useState, type JSX } from 'react'
import type { OriginPoint, OriginRef, Pt, Shape } from '../model/types'
import { activeOrigin, useStore } from '../state/store'
import { requestCut, subscribeCut, wbbox, world } from './geomCache'
import { bake, bboxValid, distToContours, emptyBBox, pointInContours, type BBox } from '../geometry/transform'
import { anchorBBox, anchorPoint, ownAnchorPoint } from './ops'
import { gridShown, gridSizeMm, gridSnaps, labelsShown } from './grid'
import { GRID_SNAP_PX, OBJECT_SNAP_PX, alignLines, guideFor, orthoDelta, snapAxis, snapKindsOn, snapPoint } from './snapTargets'
import { fmtLen } from '../model/factory'
import { uid } from '../model/ids'
import { getPrefs, newShapeCut } from '../state/prefs'
import { contoursToD } from '../geometry/svgPath'
import { disallowedHandles, normalizeParametric } from './shapeFactory'
import { IconArrowDown } from '../ui/icons'
import { boxJointForSelection, boxJointPartsOf, scaleBoxJoint, setBoxJointAnchor, stockAnchorOf, stockAnchorWorld, syncBoxJointGuides } from './boxJointGuides'
import { STOCK_ANCHORS, type StockAnchor } from '../geometry/boxJoints'
import { DesignShape, PlanShape, ReviewShape } from './canvas/ShapeViews'
import { isPenShape, openPenEdit, usePen } from './canvas/usePen'
import {
  cornerFactor,
  edgeFactor,
  handleUsable,
  clampRange,
  depthLevel,
  isMouseWheelDelta,
  textPillWidth,
  visibleWorldRect,
  wheelZoomFactor,
} from './canvas/canvasMath'

/** Review sheet grain: a 1200 mm tile of seeded, gently wandering streaks (Studio tiles its own at 300 units). */
const GRAIN_TILE = 1200
const GRAIN_LINES = (() => {
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const lines: { d: string; w: number }[] = []
  for (let y = 18; y < GRAIN_TILE - 18; y += 10 + rnd() * 26) {
    const pts = 12
    const ys = Array.from({ length: pts }, (_, i) => (i === 0 ? y : y + (rnd() - 0.5) * 34))
    ys.push(ys[0]) // the streak meets itself at the tile edge
    let d = `M0 ${ys[0]}`
    for (let i = 1; i <= pts; i++) {
      const x0 = ((i - 1) / pts) * GRAIN_TILE
      const x1 = (i / pts) * GRAIN_TILE
      d += ` C${x0 + (x1 - x0) / 2} ${ys[i - 1]} ${x0 + (x1 - x0) / 2} ${ys[i]} ${x1} ${ys[i]}`
    }
    lines.push({ d, w: 1.2 + rnd() * 2.4 })
  }
  return lines
})()

type Handle = 'tl' | 'tm' | 'tr' | 'rm' | 'br' | 'bm' | 'bl' | 'lm'

type Drag =
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number; moved: boolean; tap: boolean }
  | { kind: 'move'; start: Pt; orig: Map<string, Pt>; bbox: BBox; moved: boolean }
  | { kind: 'marquee'; start: Pt; cur: Pt; additive: boolean }
  | { kind: 'scale'; handle: Handle; anchor: Pt; ref: Pt; start: Pt; orig: Map<string, Shape>; bbox: BBox; moved: boolean }
  | { kind: 'pinch'; dist: number; zoom: number; anchor: Pt }
  /** Mouse Nav 'pan' preset: middle-button drag zooms about its anchor point, like a pinch. */
  | { kind: 'zoom'; sy: number; zoom: number; anchor: Pt }

interface Guide {
  axis: 'x' | 'y'
  at: number
  /** A grid line (dashed) rather than an object alignment guide. */
  grid?: boolean
  /** World extent along the line; an object guide spans the moved thing and its target, as in Studio. */
  from?: number
  to?: number
}

/** Screen size of one pocket tick tile (Studio shows sparse short diagonal ticks). */
const TICK_PX = 24
const HANDLE_MOUSE = 18
const HANDLE_TOUCH = 28
const DOUBLE_CLICK_MS = 350
/** Extra world-space margin (screen px) when deciding whether a shape needs its band. */
const CULL_PX = 40

/** How many separate objects a selection reads as. In Design a group counts once, as in Studio. */
function selectionUnitCount(shapes: Shape[], design: boolean): number {
  return new Set(shapes.map((s) => (design && s.groupId ? 'g:' + s.groupId : s.id))).size
}

function unionBBox(shapes: Shape[]): BBox {
  const b = emptyBBox()
  for (const s of shapes) {
    const sb = wbbox(s)
    b.minX = Math.min(b.minX, sb.minX)
    b.minY = Math.min(b.minY, sb.minY)
    b.maxX = Math.max(b.maxX, sb.maxX)
    b.maxY = Math.max(b.maxY, sb.maxY)
  }
  return b
}

const ANCHOR_POINTS: OriginPoint[] = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br']
/** A click this close (screen px) to a bounds point snaps the origin to that point; anywhere else it is a free point. */
const ANCHOR_SNAP_PX = 10
/** Studio's anchor squares: 8.5px with 1.25px corners; the picker's points sit 0.875px outside the bounds; hover rings are 15px. */
const ANCHOR_SIZE = 8.5
const ANCHOR_RX = 1.25
const ANCHOR_PICK_OUT = 0.875
const ANCHOR_RING_R = 15

/** The origin for a click at world point p: the nearest bounds point within the snap distance, else a free point. */
function originAt(p: Pt, b: BBox, zoom: number): OriginRef {
  const xs = { l: b.minX, c: (b.minX + b.maxX) / 2, r: b.maxX }
  const ys = { t: b.minY, m: (b.minY + b.maxY) / 2, b: b.maxY }
  let best: OriginPoint | null = null
  let bestD = ANCHOR_SNAP_PX / zoom
  for (const k of ANCHOR_POINTS) {
    const d = Math.hypot(p.x - xs[k[1] as 'l' | 'c' | 'r'], p.y - ys[k[0] as 't' | 'm' | 'b'])
    if (d <= bestD) {
      best = k
      bestD = d
    }
  }
  if (best) return best
  return { fx: (p.x - b.minX) / (b.maxX - b.minX || 1), fy: (p.y - b.minY) / (b.maxY - b.minY || 1) }
}

/** A box joint's stock anchor for a click at world point p: the nearest of its five, if close enough. */
function stockAnchorAt(outline: Shape, p: Pt, zoom: number): StockAnchor | null {
  let best: StockAnchor | null = null
  let bestD = (ANCHOR_SNAP_PX * 1.5) / zoom
  for (const a of STOCK_ANCHORS) {
    const q = stockAnchorWorld(outline, a)
    const d = Math.hypot(p.x - q.x, p.y - q.y)
    if (d <= bestD) {
      best = a
      bestD = d
    }
  }
  return best
}

/**
 * Shape Anchor mode (Studio's): the selection bounds show their nine points and the hint. A click on the
 * canvas picks the origin (snapping to a nearby point); Escape, the close button, or the pick leaves the mode.
 * Box joints offer their five stock anchors (`points`, screen space) instead of the bounds points.
 */
function AnchorPickOverlay({
  x0,
  y0,
  x1,
  y1,
  value,
  hasCustom,
  w,
  h,
  points,
}: {
  x0: number
  y0: number
  x1: number
  y1: number
  value: OriginRef
  hasCustom: boolean
  w: number
  h: number
  points?: { key: string; x: number; y: number; active: boolean }[]
}) {
  const xs = { l: x0 - ANCHOR_PICK_OUT, c: (x0 + x1) / 2, r: x1 + ANCHOR_PICK_OUT }
  const ys = { t: y0 - ANCHOR_PICK_OUT, m: (y0 + y1) / 2, b: y1 + ANCHOR_PICK_OUT }
  const pts =
    points ??
    ANCHOR_POINTS.map((p) => ({ key: p, x: xs[p[1] as 'l' | 'c' | 'r'], y: ys[p[0] as 't' | 'm' | 'b'], active: p === value }))
  return (
    <g className="cv-anchor-pick">
      <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} className="cv-bbox" />
      {pts.map(({ key, x, y, active }) => (
        <g key={key} className="cv-anchor-point" data-anchor={key}>
          <circle cx={x} cy={y} r={ANCHOR_SNAP_PX} className="cv-anchor-point__hit" />
          <circle cx={x} cy={y} r={ANCHOR_RING_R} className="cv-anchor-point__ring" />
          <rect
            x={x - ANCHOR_SIZE / 2}
            y={y - ANCHOR_SIZE / 2}
            width={ANCHOR_SIZE}
            height={ANCHOR_SIZE}
            rx={ANCHOR_RX}
            className={'cv-anchor-point__dot' + (active ? ' is-active' : '')}
          />
        </g>
      ))}
      <g className="cv-anchor-title" transform={`translate(${w / 2} 40)`}>
        <text textAnchor="middle" x={10}>
          Shape Anchor
        </text>
      </g>
      <g className="cv-anchor-hint">
        <text textAnchor="middle" x={w / 2} y={h - 62}>
          {hasCustom ? 'Tap to choose a reference anchor' : 'Add or tap to choose a reference anchor'}
        </text>
        {hasCustom && (
          <g
            className="cv-anchor-clear"
            transform={`translate(${w / 2 - 29} ${h - 28})`}
            onPointerDown={(e) => {
              e.stopPropagation()
              useStore.getState().clearCustomAnchor()
            }}
          >
            <rect x={-83} y={-17} width={166} height={34} rx={17} />
            <text textAnchor="middle" y={4}>
              Clear Custom Anchor
            </text>
          </g>
        )}
        <g
          className="cv-anchor-hint__close"
          transform={`translate(${hasCustom ? w / 2 + 92 : w / 2} ${h - 28})`}
          onPointerDown={(e) => {
            e.stopPropagation()
            useStore.getState().setAnchorPicking(false)
          }}
        >
          <circle r={14} />
          <path d="M-4 -4L4 4M4 -4L-4 4" />
        </g>
      </g>
    </g>
  )
}

export default function Canvas() {
  const svgRef = useRef<SVGSVGElement>(null)
  const doc = useStore((s) => s.doc)
  const mode = useStore((s) => s.mode)
  const tool = useStore((s) => s.tool)
  const view = useStore((s) => s.view)
  const selection = useStore((s) => s.selection)
  // Plan: the shape lit while its Manage Selection tile is held.
  const planHighlight = useStore((s) => s.planHighlight)
  const viewport = useStore((s) => s.viewport)
  const anchorPicking = useStore((s) => s.anchorPicking)

  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [guides, setGuides] = useState<Guide[]>([])
  /** Shape Anchor mode: where a free pick would land (snapped), or null over the nine stock points. */
  const [anchorHover, setAnchorHover] = useState<Pt | null>(null)
  const [draft, setDraft] = useState<Pt[]>([])
  const draftRef = useRef<Pt[]>([])
  draftRef.current = draft
  const [cursor, setCursor] = useState<Pt | null>(null)
  const [spaceDown, setSpaceDown] = useState(false)
  /** Re-renders when lazily computed cut geometry arrives. */
  const [, bumpCut] = useReducer((n: number) => n + 1, 0)

  const touches = useRef(new Map<number, { x: number; y: number }>())
  /** Selection before the first finger went down, so a pinch can undo what that finger picked. */
  const selectionAtTouch = useRef<string[] | null>(null)
  /** Plain click on a member of a multi-selection: released without a drag, it takes just that object out. */
  const toggleOnUp = useRef<string[] | null>(null)
  const lastPtrType = useRef(typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches ? 'touch' : 'mouse')
  const lastClick = useRef<{ t: number; x: number; y: number } | null>(null)
  const hoverRaf = useRef(0)
  const hoverPt = useRef<Pt | null>(null)

  useEffect(() => {
    if (anchorPicking) return
    setAnchorHover(null)
    setGuides((prev) => (prev.length ? [] : prev))
  }, [anchorPicking])
  // The draw tool's snap guides go with it.
  useEffect(() => {
    if (tool !== 'draw') setGuides((prev) => (prev.length ? [] : prev))
  }, [tool])

  const setDragBoth = (d: Drag | null) => {
    dragRef.current = d
    setDrag(d)
  }

  // References (locked shapes) exist only in Design: Plan and Review neither draw nor hit them.
  const visible = useMemo(() => doc.shapes.filter((s) => !s.hidden && (mode === 'design' || !s.locked)), [doc.shapes, mode])
  const selSet = useMemo(() => new Set(selection), [selection])
  const selShapes = useMemo(() => visible.filter((s) => selSet.has(s.id)), [visible, selSet])
  const selBBox = useMemo(() => (selShapes.length ? unionBBox(selShapes) : null), [selShapes])

  // ---------- viewport size ----------
  useEffect(() => {
    const el = svgRef.current!
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      useStore.getState().setViewport(r.width, r.height)
    })
    ro.observe(el)
    const r = el.getBoundingClientRect()
    useStore.getState().setViewport(r.width, r.height)
    useStore.getState().zoomToFit()
    return () => ro.disconnect()
  }, [])

  // ---------- lazy cut geometry ----------
  useEffect(() => subscribeCut(bumpCut), [])

  // Latest callbacks for window-level listeners that are registered once.
  const latest = useRef({ finishDraft: (_close: boolean) => {}, endDrag: () => {} })

  // ---------- keyboard: space-to-pan, draw tool keys, window blur ----------
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t?.closest?.('input, textarea, select, [contenteditable]')) return
      const st = useStore.getState()
      if (e.code === 'Space' && !t?.closest?.('button, a, [role="button"]')) {
        setSpaceDown(true)
        e.preventDefault()
      }
      if (st.tool === 'draw' && st.mode === 'design' && !st.dialog && !st.menuOpen && !st.popover) {
        if (e.key === 'Escape') {
          e.preventDefault()
          if (draftRef.current.length >= 2) latest.current.finishDraft(false)
          else {
            setDraft([])
            st.setTool('select')
          }
        } else if (e.key === 'Enter' && draftRef.current.length >= 2) {
          e.preventDefault()
          latest.current.finishDraft(false)
        } else if (e.key === 'Backspace' && draftRef.current.length) {
          e.preventDefault()
          setDraft((d) => d.slice(0, -1))
        }
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false)
    }
    const blur = () => {
      setSpaceDown(false)
      latest.current.endDrag()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      cancelAnimationFrame(hoverRaf.current)
    }
  }, [])

  useEffect(() => {
    if (tool !== 'draw') setDraft([])
  }, [tool])

  // ---------- coordinate helpers ----------
  const toWorld = (cx: number, cy: number): Pt => {
    const r = svgRef.current!.getBoundingClientRect()
    const v = useStore.getState().view
    return { x: (cx - r.left - v.panX) / v.zoom, y: (cy - r.top - v.panY) / v.zoom }
  }
  const sx = (x: number) => x * view.zoom + view.panX
  const sy = (y: number) => y * view.zoom + view.panY

  /** Pen anchors snap like the draw tool's points; the node editor leaves the edited path out of the targets. */
  const snapPen = (raw: Pt, e: { ctrlKey: boolean; altKey: boolean }, exclude?: string): Pt => {
    const st = useStore.getState()
    const snap = exclude ? snapSetup(st, e, (q) => q.id !== exclude) : null
    const hit = snap?.smart ? snapPoint(raw, snap.targets, snap.on, snap.tol, { grid: snap.grid }) : snapFreePoint(raw, st, e)
    setGuides((prev) => (hit.guides.length || prev.length ? hit.guides : prev))
    return hit.pt
  }
  const pen = usePen({ toWorld, snap: snapPen, clearGuides: () => setGuides((prev) => (prev.length ? [] : prev)) })
  // Double-click on a pen path opens its node editor (shared with the panel's Edit Points button).
  const enterPenEdit = openPenEdit

  const hitTest = (p: Pt): Shape | null => {
    if (mode === 'review') return null // review shapes are display-only
    const tol = 6 / useStore.getState().view.zoom
    for (let i = visible.length - 1; i >= 0; i--) {
      const s = visible[i]
      const b = wbbox(s)
      if (p.x < b.minX - tol || p.x > b.maxX + tol || p.y < b.minY - tol || p.y > b.maxY + tol) continue
      const w = world(s)
      const closed = w.some((c) => c.closed)
      // A reference has no fill: it is picked only by its edge.
      if (closed && mode === 'design' && !s.locked && pointInContours(p, w)) return s
      if (distToContours(p, w) <= tol) return s
      if (mode === 'plan' && closed && pointInContours(p, w)) return s
    }
    return null
  }
  // Pointer handlers and the rAF hover callback always see the latest hit test.
  const hitRef = useRef(hitTest)
  hitRef.current = hitTest

  /** One hover hit-test per animation frame; setHover bails out when unchanged. */
  const scheduleHover = (p: Pt) => {
    hoverPt.current = p
    if (hoverRaf.current) return
    hoverRaf.current = requestAnimationFrame(() => {
      hoverRaf.current = 0
      const q = hoverPt.current
      if (!q) return
      const h = hitRef.current(q)
      setHover(h ? h.id : null)
    })
  }

  // ---------- wheel: pan / zoom ----------
  useEffect(() => {
    const el = svgRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const st = useStore.getState()
      const ctrl = e.ctrlKey || e.metaKey
      // Mouse Nav preset: 'pan' has the wheel pan instead; ctrl/cmd stays zoom either way (trackpad pinch).
      if (ctrl || (isMouseWheelDelta(e) && getPrefs().mouseNav === 'zoom')) {
        st.zoomBy(wheelZoomFactor(e.deltaY, e.deltaMode, ctrl), e.clientX - r.left, e.clientY - r.top)
      } else {
        st.setView({ panX: st.view.panX - e.deltaX, panY: st.view.panY - e.deltaY })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ---------- draw tool ----------
  const finishDraft = (close: boolean) => {
    const pts = draftRef.current
    setDraft([])
    if (pts.length < 2) return
    const st = useStore.getState()
    const s: Shape = bake({
      id: uid(),
      name: close ? 'Closed Path' : 'Path',
      kind: 'path',
      contours: [{ pts, closed: close && pts.length >= 3 }],
      x: 0,
      y: 0,
      rotation: 0,
      sx: 1,
      sy: 1,
      cut: close ? newShapeCut() : newShapeCut('online'),
    })
    st.addShapes([s])
    st.setTool('select')
  }
  latest.current.finishDraft = finishDraft

  const snapAngle = (from: Pt, p: Pt): Pt => {
    const dx = p.x - from.x
    const dy = p.y - from.y
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
    const len = Math.hypot(dx, dy)
    return { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len }
  }

  /**
   * What a drag snaps to, as in Studio: the lines of the targets on screen while Smart Alignment is on, and the grid
   * while Snap to grid is on. Ctrl (as in Studio) or Alt holds snapping off. Null when nothing snaps.
   */
  const snapSetup = (st: ReturnType<typeof useStore.getState>, e: { ctrlKey: boolean; altKey: boolean }, keep: (s: Shape) => boolean = () => true) => {
    if (e.ctrlKey || e.altKey) return null
    const smart = st.doc.settings.smartAlignment
    const onGrid = gridSnaps(st.doc)
    if (!smart && !onGrid) return null
    const z = st.view.zoom
    const minX = -st.view.panX / z
    const minY = -st.view.panY / z
    const maxX = minX + st.viewport.w / z
    const maxY = minY + st.viewport.h / z
    const targets = smart
      ? visible.filter((s) => {
          if (!keep(s)) return false
          const b = wbbox(s)
          return b.maxX >= minX && b.minX <= maxX && b.maxY >= minY && b.minY <= maxY
        })
      : []
    const on = snapKindsOn(st.doc.settings)
    const { xs, ys } = smart ? alignLines(targets, on) : { xs: [], ys: [] }
    return { xs, ys, targets, on, smart, tol: OBJECT_SNAP_PX / z, grid: onGrid ? { size: gridSizeMm(st.doc), tol: GRID_SNAP_PX / z } : null }
  }

  /** A free point (draw tool, anchor pick) snapped to what `snapSetup` allows; `extra` points are aligned with too. */
  const snapFreePoint = (p: Pt, st: ReturnType<typeof useStore.getState>, e: { ctrlKey: boolean; altKey: boolean }, extra: Pt[] = []): { pt: Pt; guides: Guide[] } => {
    const snap = snapSetup(st, e)
    if (!snap) return { pt: p, guides: [] }
    if (snap.smart) return snapPoint(p, snap.targets, snap.on, snap.tol, { grid: snap.grid, extra })
    const hx = snapAxis([p.x], 0, [], snap.tol, snap.grid)
    const hy = snapAxis([p.y], 0, [], snap.tol, snap.grid)
    const pt = { x: p.x + (hx?.shift ?? 0), y: p.y + (hy?.shift ?? 0) }
    return { pt, guides: [...(hx ? [guideFor('x', hx, pt.y, pt.y)] : []), ...(hy ? [guideFor('y', hy, pt.x, pt.x)] : [])] }
  }

  /** The draw tool's point, snapped as Studio's line tool does: each axis to target lines, the path's own points and the grid. */
  const snapDrawPoint = (p: Pt, e: { ctrlKey: boolean; altKey: boolean }) => snapFreePoint(p, useStore.getState(), e, draftRef.current)

  /**
   * Whether a click on empty canvas at this screen point clears the selection. With several objects selected,
   * the gray box around them is the selection's edge: only a click outside it clears.
   */
  const clearsSelectionAt = (clientX: number, clientY: number) => {
    const st = useStore.getState()
    const sel = st.doc.shapes.filter((s) => st.selection.includes(s.id))
    if (st.mode !== 'design' || selectionUnitCount(sel, true) < 2) return true
    const b = unionBBox(sel)
    const p = toWorld(clientX, clientY)
    return p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY
  }

  // ---------- drag lifecycle ----------
  /** Commit whatever the current drag has done and clear it. Idempotent. */
  const endDrag = () => {
    const d = dragRef.current
    if (!d) return
    const st = useStore.getState()
    if (d.kind === 'marquee') {
      const b: BBox = {
        minX: Math.min(d.start.x, d.cur.x),
        minY: Math.min(d.start.y, d.cur.y),
        maxX: Math.max(d.start.x, d.cur.x),
        maxY: Math.max(d.start.y, d.cur.y),
      }
      if ((b.maxX - b.minX) * st.view.zoom > 3 || (b.maxY - b.minY) * st.view.zoom > 3) {
        let inside = visible
          .filter((s) => {
            if (s.locked) return false
            const sb = wbbox(s)
            return sb.minX >= b.minX && sb.maxX <= b.maxX && sb.minY >= b.minY && sb.maxY <= b.maxY
          })
          .map((s) => s.id)
        if (st.mode === 'design') {
          // A group is one object: the marquee takes it only when all of it is inside, and then whole.
          const ins = new Set(inside)
          const partial = new Set<string>()
          for (const s of visible) if (s.groupId && !s.locked && !ins.has(s.id)) partial.add(s.groupId)
          const whole = new Set(st.doc.shapes.filter((s) => ins.has(s.id) && s.groupId && !partial.has(s.groupId)).map((s) => s.groupId))
          inside = st.doc.shapes
            .filter((s) => (ins.has(s.id) && !s.groupId) || (s.groupId && whole.has(s.groupId) && !s.locked))
            .map((s) => s.id)
        }
        st.select(d.additive ? [...new Set([...st.selection, ...inside])] : inside)
      }
    }
    // A one-finger tap on empty canvas clears the selection; a pan does not.
    if (d.kind === 'pan' && d.tap && !d.moved && clearsSelectionAt(d.sx, d.sy)) st.select([])
    if (d.kind === 'scale' && d.moved) st.patchShapes([...d.orig.keys()], normalizeParametric)
    setGuides((g) => (g.length ? [] : g))
    setDragBoth(null)
  }
  latest.current.endDrag = endDrag

  const startPinch = () => {
    const pts = [...touches.current.values()]
    const svg = svgRef.current
    if (pts.length < 2 || !svg) return
    // The first finger may already have selected or moved something. Undo that, so a pinch changes nothing but the view.
    const first = dragRef.current
    if (first?.kind === 'move' && first.moved) {
      const orig = first.orig
      useStore.getState().patchShapes([...orig.keys()], (s) => ({ ...s, x: orig.get(s.id)!.x, y: orig.get(s.id)!.y }))
    }
    if (first?.kind === 'scale' && first.moved) {
      const orig = first.orig
      useStore.getState().patchShapes([...orig.keys()], (s) => orig.get(s.id)!)
    }
    if (first?.kind === 'move' || first?.kind === 'scale') {
      setDragBoth(null)
      setGuides((g) => (g.length ? [] : g))
    } else {
      if (first?.kind === 'pan') setDragBoth({ ...first, tap: false })
      endDrag()
    }
    if (selectionAtTouch.current) useStore.getState().select(selectionAtTouch.current)
    selectionAtTouch.current = null
    const r = svg.getBoundingClientRect()
    const [a, b] = pts
    const mx = (a.x + b.x) / 2 - r.left
    const my = (a.y + b.y) / 2 - r.top
    const v = useStore.getState().view
    setDragBoth({
      kind: 'pinch',
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      zoom: v.zoom,
      anchor: { x: (mx - v.panX) / v.zoom, y: (my - v.panY) / v.zoom },
    })
  }

  const updatePinch = (d: Extract<Drag, { kind: 'pinch' }>) => {
    const pts = [...touches.current.values()]
    const svg = svgRef.current
    if (pts.length < 2 || !svg) return
    const r = svg.getBoundingClientRect()
    const [a, b] = pts
    const mx = (a.x + b.x) / 2 - r.left
    const my = (a.y + b.y) / 2 - r.top
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
    const zoom = clampRange((d.zoom * dist) / d.dist, 0.05, 2000)
    useStore.getState().setView({ zoom, panX: mx - d.anchor.x * zoom, panY: my - d.anchor.y * zoom })
  }

  // ---------- pointer handlers ----------
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const st = useStore.getState()
    if (st.popover) st.setPopover(null)
    if (st.anchorPicking) {
      // Shape Anchor mode: any click picks the origin for the selection (no pan, no selection change).
      const joint = boxJointForSelection(st.doc, st.selection)
      if (joint) {
        // Box joints anchor only on their stock: its corners and centre.
        const a = stockAnchorAt(joint, toWorld(e.clientX, e.clientY), view.zoom)
        if (a) setBoxJointAnchor(joint.id, a)
      } else if (selBBox && bboxValid(selBBox)) {
        const raw = toWorld(e.clientX, e.clientY)
        const stock = originAt(raw, selBBox, view.zoom)
        // Over a stock point it wins; elsewhere the pick lands where the red dot was snapped.
        const w = typeof stock === 'string' ? raw : snapAnchorPick(raw, st, e).pt
        const ref = typeof stock === 'string' ? stock : originAt(w, selBBox, view.zoom)
        st.setOriginPoint(ref)
        // A free pick also leaves a custom anchor marker on the canvas until it is cleared.
        if (typeof ref !== 'string') st.setCustomAnchor(w)
      }
      st.setAnchorPicking(false)
      setAnchorHover(null)
      setGuides([])
      return
    }
    lastPtrType.current = e.pointerType
    toggleOnUp.current = null
    if (e.button === 1) e.preventDefault() // stop browser autoscroll on middle click
    svgRef.current?.setPointerCapture?.(e.pointerId)
    if (e.pointerType === 'touch') {
      if (touches.current.size === 0) selectionAtTouch.current = st.selection
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touches.current.size >= 2) {
        startPinch()
        return
      }
    }
    const p = toWorld(e.clientX, e.clientY)
    const pan = (tap: boolean) =>
      setDragBoth({ kind: 'pan', sx: e.clientX, sy: e.clientY, px: st.view.panX, py: st.view.panY, moved: false, tap })

    if (e.button === 1 && getPrefs().mouseNav === 'pan') {
      // Mouse Nav 'pan' preset: middle-button drag zooms about where it started (the wheel pans instead).
      const r = svgRef.current!.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      setDragBoth({
        kind: 'zoom',
        sy: e.clientY,
        zoom: st.view.zoom,
        anchor: { x: (mx - st.view.panX) / st.view.zoom, y: (my - st.view.panY) / st.view.zoom },
      })
      return
    }
    if (e.button === 1 || e.button === 2 || spaceDown || mode === 'review') {
      pan(false)
      return
    }

    if (tool === 'pen' && mode === 'design') {
      pen.draftDown(e)
      return
    }
    if (pen.editing) {
      if (pen.editDown(e)) return
      // A click away from the path leaves the node editor and then acts as usual.
      st.setPenEdit(null)
    }

    if (tool === 'draw' && mode === 'design') {
      const dr = draftRef.current
      const last = dr[dr.length - 1]
      const q = last && e.shiftKey ? snapAngle(last, p) : snapDrawPoint(p, e).pt
      if (dr.length >= 3 && Math.hypot(dr[0].x - q.x, dr[0].y - q.y) * st.view.zoom < 10) {
        finishDraft(true)
        return
      }
      // Double click finishes the path (time and distance, not PointerEvent.detail).
      const now = performance.now()
      const prev = lastClick.current
      lastClick.current = { t: now, x: e.clientX, y: e.clientY }
      if (prev && now - prev.t < DOUBLE_CLICK_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 8 && dr.length >= 2) {
        lastClick.current = null
        finishDraft(false)
        return
      }
      setDraft([...dr, q])
      return
    }

    const hit = hitTest(p)
    // Double-click on a pen path opens its node editor.
    if (hit && mode === 'design' && isPenShape(hit) && !e.shiftKey && !e.metaKey && !e.altKey) {
      const now = performance.now()
      const prev = lastClick.current
      lastClick.current = { t: now, x: e.clientX, y: e.clientY }
      if (prev && now - prev.t < DOUBLE_CLICK_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 8) {
        lastClick.current = null
        enterPenEdit(hit.id)
        return
      }
    }
    if (hit) {
      let sel = st.selection
      if (e.shiftKey || e.metaKey) {
        // In Design a group is one object: shift-click adds or removes all of its unlocked members.
        const unit =
          hit.groupId && mode === 'design' && !e.altKey && !hit.locked
            ? st.doc.shapes.filter((s) => s.groupId === hit.groupId && !s.locked).map((s) => s.id)
            : [hit.id]
        sel = sel.includes(hit.id) ? sel.filter((i) => !unit.includes(i)) : [...new Set([...sel, ...unit])]
        st.select(sel)
      } else if (hit.groupId && e.altKey) {
        // Alt+click picks this one element out of its group (to edit its cut type, depth or bit).
        sel = [hit.id]
        st.select(sel)
      } else {
        // A plain click is enough to build up a selection (as in Studio). Once two or more objects are selected,
        // a click adds an unselected one, and a click on a selected one takes just that one out (on release, if
        // it did not drag). With a single object, a click on another replaces the selection.
        const design = mode === 'design'
        const unit =
          hit.groupId && design && !hit.locked
            ? st.doc.shapes.filter((s) => s.groupId === hit.groupId && !s.locked).map((s) => s.id)
            : [hit.id]
        // Touch has no shift key: taps always accumulate into the selection, and tapping a selected one removes it.
        const multi =
          e.pointerType === 'touch'
            ? sel.length > 0
            : selectionUnitCount(st.doc.shapes.filter((s) => sel.includes(s.id)), design) > 1
        if (sel.includes(hit.id) && multi) {
          toggleOnUp.current = unit
        } else if (multi) {
          sel = [...new Set([...sel, ...unit])]
          st.select(sel)
        } else if (!sel.includes(hit.id)) {
          if (hit.groupId && design && !hit.locked) {
            // A plain click on a grouped element selects the whole group, so it drags as one.
            st.selectGroup(hit.groupId)
            sel = useStore.getState().selection
          } else {
            sel = [hit.id]
            st.select(sel)
          }
        }
      }
      if (mode === 'design' && sel.includes(hit.id)) {
        // References can be selected but never moved, and a selection with one in it stays put (as in Studio).
        const moving = st.doc.shapes.filter((s) => sel.includes(s.id))
        if (moving.length && !moving.some((s) => s.locked)) {
          const orig = new Map<string, Pt>()
          for (const s of moving) orig.set(s.id, { x: s.x, y: s.y })
          setDragBoth({ kind: 'move', start: p, orig, bbox: unionBBox(moving), moved: false })
        }
      }
      return
    }

    if (e.pointerType === 'touch') {
      // Touch on empty canvas pans; a tap without movement clears the selection.
      pan(true)
      return
    }
    if (!e.shiftKey && clearsSelectionAt(e.clientX, e.clientY)) st.select([])
    setDragBoth({ kind: 'marquee', start: p, cur: p, additive: e.shiftKey })
  }

  const startScale = (e: React.PointerEvent, h: Handle) => {
    e.stopPropagation() // the svg handlers do not also run for the handle
    lastPtrType.current = e.pointerType
    svgRef.current?.setPointerCapture?.(e.pointerId)
    if (e.pointerType === 'touch') {
      if (touches.current.size === 0) selectionAtTouch.current = useStore.getState().selection
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touches.current.size >= 2) {
        startPinch()
        return
      }
    }
    if (!selBBox) return
    const st = useStore.getState()
    const b = selBBox
    const pos = (hh: Handle): Pt => ({
      x: hh.includes('l') ? b.minX : hh.includes('r') ? b.maxX : (b.minX + b.maxX) / 2,
      y: hh.startsWith('t') ? b.minY : hh.startsWith('b') ? b.maxY : (b.minY + b.maxY) / 2,
    })
    // Scaling is always about the anchor (the centre unless another point was picked, or a template's own
    // anchor such as the keyhole's neck centre), as in Studio.
    const origin = activeOrigin(st.doc, st.selection) ?? 'mc'
    const anchor = ownAnchorPoint(selShapes, origin) ?? anchorPoint(b, origin)
    // No checkpoint here: the undo step is taken on the first real movement.
    const orig = new Map<string, Shape>()
    // Rotated shapes or multi-selections are baked so scaling is axis-aligned in world space.
    // Box joints are never baked: the scale goes into their params.
    const joints = boxJointPartsOf(st.doc, selShapes.map((s) => s.id))
    for (const s of selShapes) {
      if (s.locked) continue
      const keep = joints.outlines.has(s.id) || joints.guides.has(s.id)
      orig.set(s.id, s.rotation % 360 !== 0 && !keep ? bake(s) : s)
    }
    if (!orig.size) return
    setDragBoth({ kind: 'scale', handle: h, anchor, ref: pos(h), start: toWorld(e.clientX, e.clientY), orig, bbox: b, moved: false })
  }

  /** A free anchor pick snaps like Studio's custom anchor: to every visible shape (the selection too) and the grid. */
  const snapAnchorPick = (raw: Pt, st: ReturnType<typeof useStore.getState>, e: { ctrlKey: boolean; altKey: boolean }) => snapFreePoint(raw, st, e)

  /** Snap the free-anchor preview to the enabled targets; hidden over the nine stock points and for box joints. */
  const updateAnchorHover = (raw: Pt, st: ReturnType<typeof useStore.getState>, e: { ctrlKey: boolean; altKey: boolean }) => {
    const joint = boxJointForSelection(st.doc, st.selection)
    if (joint || !selBBox || !bboxValid(selBBox) || typeof originAt(raw, selBBox, st.view.zoom) === 'string') {
      setAnchorHover(null)
      setGuides((prev) => (prev.length ? [] : prev))
      return
    }
    const hit = snapAnchorPick(raw, st, e)
    setAnchorHover(hit.pt)
    setGuides(hit.guides)
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const d = dragRef.current
    if (d?.kind === 'pinch') {
      updatePinch(d)
      return
    }
    const p = toWorld(e.clientX, e.clientY)
    const st = useStore.getState()
    if (st.anchorPicking) {
      updateAnchorHover(p, st, e)
      return
    }
    if (tool === 'pen' && mode === 'design') {
      pen.draftMove(e)
      return
    }
    if (pen.editing && pen.editMove(e)) return
    if (tool === 'draw' && !d) {
      const dr = draftRef.current
      const last = dr[dr.length - 1]
      if (last && e.shiftKey) {
        setCursor(snapAngle(last, p))
        setGuides((prev) => (prev.length ? [] : prev))
      } else {
        const hit = snapDrawPoint(p, e)
        setCursor(hit.pt)
        setGuides((prev) => (hit.guides.length || prev.length ? hit.guides : prev))
      }
    }
    if (!d) {
      if (tool === 'select' && mode !== 'review' && e.pointerType !== 'touch') scheduleHover(p)
      return
    }
    switch (d.kind) {
      case 'pan': {
        const dx = e.clientX - d.sx
        const dy = e.clientY - d.sy
        st.setView({ panX: d.px + dx, panY: d.py + dy })
        if (!d.moved && Math.hypot(dx, dy) > 4) setDragBoth({ ...d, moved: true })
        break
      }
      case 'zoom': {
        // Drag up to zoom in, down to zoom out, about the drag's anchor point (as with a pinch).
        const zoom = clampRange(d.zoom * Math.exp(-(e.clientY - d.sy) * 0.01), 0.05, 2000)
        const r = svgRef.current!.getBoundingClientRect()
        const mx = e.clientX - r.left
        const my = e.clientY - r.top
        st.setView({ zoom, panX: mx - d.anchor.x * zoom, panY: my - d.anchor.y * zoom })
        break
      }
      case 'marquee':
        setDragBoth({ ...d, cur: p })
        break
      case 'move': {
        let dx = p.x - d.start.x
        let dy = p.y - d.start.y
        if (!d.moved && Math.hypot(dx, dy) * st.view.zoom < 3) return
        if (!d.moved) st.checkpoint()
        // Shift locks the move to an axis or a diagonal, as in Studio; snapping still runs on both axes afterwards.
        if (e.shiftKey) ({ x: dx, y: dy } = orthoDelta(dx, dy))
        const g: Guide[] = []
        const snap = snapSetup(st, e, (s) => !d.orig.has(s.id))
        if (snap) {
          // Studio lines up the selection's left, right and centre (and the anchor) with every target line.
          const b = d.bbox
          const moving = st.doc.shapes.filter((q) => d.orig.has(q.id)).map((q) => ({ ...q, ...d.orig.get(q.id)! }))
          const origin = activeOrigin(st.doc, st.selection) ?? 'mc'
          const ap = ownAnchorPoint(moving, origin) ?? anchorPoint(anchorBBox(moving, b), origin)
          const hx = snapAxis([b.minX, b.maxX, (b.minX + b.maxX) / 2, ap.x], dx, snap.xs, snap.tol, snap.grid)
          const hy = snapAxis([b.minY, b.maxY, (b.minY + b.maxY) / 2, ap.y], dy, snap.ys, snap.tol, snap.grid)
          if (hx) dx += hx.shift
          if (hy) dy += hy.shift
          if (hx) g.push(guideFor('x', hx, b.minY + dy, b.maxY + dy))
          if (hy) g.push(guideFor('y', hy, b.minX + dx, b.maxX + dx))
        }
        setGuides((prev) => (g.length || prev.length ? g : prev))
        st.patchShapes([...d.orig.keys()], (s) => {
          const o = d.orig.get(s.id)!
          return { ...s, x: o.x + dx, y: o.y + dy }
        })
        if (!d.moved) setDragBoth({ ...d, moved: true })
        break
      }
      case 'scale': {
        const { anchor, ref, handle, start } = d
        const delta = { x: p.x - start.x, y: p.y - start.y }
        // Studio snaps only the edge being dragged by a side handle; corners and a rotated shape never snap.
        const g: Guide[] = []
        const side = handle === 'tm' || handle === 'bm' || handle === 'lm' || handle === 'rm'
        const one = d.orig.size === 1 ? [...d.orig.values()][0] : null
        const snap = side && !(one && one.rotation % 360 !== 0) ? snapSetup(st, e, (s) => !d.orig.has(s.id)) : null
        if (snap) {
          const b = d.bbox
          if (handle === 'lm' || handle === 'rm') {
            const hx = snapAxis([ref.x], delta.x, snap.xs, snap.tol, snap.grid)
            if (hx) {
              delta.x += hx.shift
              g.push(guideFor('x', hx, b.minY, b.maxY))
            }
          } else {
            const hy = snapAxis([ref.y], delta.y, snap.ys, snap.tol, snap.grid)
            if (hy) {
              delta.y += hy.shift
              g.push(guideFor('y', hy, b.minX, b.maxX))
            }
          }
        }
        setGuides((prev) => (g.length || prev.length ? g : prev))
        // Edge handles scale one axis about the anchor; an axis through the anchor keeps factor 1.
        let fx = handle === 'tm' || handle === 'bm' ? 1 : edgeFactor(delta.x, anchor.x, ref.x)
        let fy = handle === 'lm' || handle === 'rm' ? 1 : edgeFactor(delta.y, anchor.y, ref.y)
        const corner = handle.length === 2 && !handle.includes('m')
        if (corner && !e.shiftKey) {
          // Corners scale proportionally (Shift for free scaling).
          fx = fy = cornerFactor(delta, anchor, ref)
        }
        // The first real movement creates the undo step.
        if (!d.moved) st.checkpoint()
        // Box joints are rebuilt from scaled params (never stretched) and their guides re-laid out.
        const joints = boxJointPartsOf(st.doc, d.orig.keys())
        st.patchShapes([...d.orig.keys()], (s) => {
          const o = d.orig.get(s.id)!
          if (joints.outlines.has(s.id)) return scaleBoxJoint(o, fx, fy, anchor, st.doc.units)
          if (joints.guides.has(s.id)) return s
          // Parametric shapes are rebuilt each move (as on release) so corner radii stay round while resizing.
          return normalizeParametric({
            ...o,
            x: anchor.x + (o.x - anchor.x) * fx,
            y: anchor.y + (o.y - anchor.y) * fy,
            sx: o.sx * fx,
            sy: o.sy * fy,
          })
        })
        for (const id of joints.outlines) syncBoxJointGuides(id)
        if (!d.moved) setDragBoth({ ...d, moved: true })
        break
      }
    }
  }

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    touches.current.delete(e.pointerId)
    pen.draftUp()
    pen.editUp()
    const tog = toggleOnUp.current
    toggleOnUp.current = null
    const d = dragRef.current
    const dragged = !!d && (d.kind === 'move' || d.kind === 'scale') && d.moved
    endDrag()
    if (tog && !dragged) {
      const st = useStore.getState()
      st.select(st.selection.filter((id) => !tog.includes(id)))
    }
  }

  const onLostCapture = (e: React.PointerEvent<SVGSVGElement>) => {
    touches.current.delete(e.pointerId)
    pen.editUp()
    endDrag()
  }

  // ---------- rendering ----------
  const z = view.zoom
  // Position > Show grid: dashed lines every grid step, with the x / y axes through the origin.
  let gridEl: JSX.Element | null = null
  if (doc.settings.showPosition) {
    const step = gridSizeMm(doc)
    const px = step * z
    const ax = sx(0)
    const ay = sy(0)
    const lines: JSX.Element[] = []
    if (gridShown(doc) && px >= 8) {
      const i0 = Math.ceil(-view.panX / px)
      const i1 = Math.floor((viewport.w - view.panX) / px)
      const j0 = Math.ceil(-view.panY / px)
      const j1 = Math.floor((viewport.h - view.panY) / px)
      if (i1 - i0 + j1 - j0 < 600) {
        for (let i = i0; i <= i1; i++) if (i) lines.push(<line key={'v' + i} x1={sx(i * step)} x2={sx(i * step)} y1={0} y2={viewport.h} />)
        for (let j = j0; j <= j1; j++) if (j) lines.push(<line key={'h' + j} x1={0} x2={viewport.w} y1={sy(j * step)} y2={sy(j * step)} />)
      }
    }
    gridEl = (
      <g className="cv-grid" pointerEvents="none">
        {lines}
        <line className="cv-grid__axis" x1={ax} x2={ax} y1={0} y2={viewport.h} />
        <line className="cv-grid__axis" x1={0} x2={viewport.w} y1={ay} y2={ay} />
      </g>
    )
  }
  const worldTransform = `matrix(${z} 0 0 ${z} ${view.panX} ${view.panY})`
  const onScreen = visibleWorldRect(view, viewport.w, viewport.h)
  const handleSize = lastPtrType.current === 'touch' ? HANDLE_TOUCH : HANDLE_MOUSE
  const cutAll = doc.settings.cutPathDisplay

  /** Whether a shape is close enough to the viewport to need its band computed. */
  const inView = (s: Shape) => {
    const b = wbbox(s)
    const pad = CULL_PX / z + s.cut.bitDia + Math.abs(s.cut.offset)
    return b.maxX >= onScreen.minX - pad && b.minX <= onScreen.maxX + pad && b.maxY >= onScreen.minY - pad && b.minY <= onScreen.maxY + pad
  }

  let shapeEls: React.ReactNode[]
  // Hovering one member of a group highlights the whole group.
  const hoverSet = useMemo(() => {
    const h = hover ? visible.find((s) => s.id === hover) : undefined
    if (!h) return new Set<string>()
    // Plan elements carry their own cut type and depth, so only the hovered one lights up there.
    if (!h.groupId || mode === 'plan' || h.locked) return new Set([h.id])
    return new Set(visible.filter((s) => s.groupId === h.groupId && !s.locked).map((s) => s.id))
  }, [hover, visible, mode])
  if (mode === 'design') {
    shapeEls = visible.map((s) => (
      <DesignShape key={s.id} s={s} selected={selSet.has(s.id)} hovered={hoverSet.has(s.id) && !selSet.has(s.id)} />
    ))
  } else if (mode === 'plan') {
    shapeEls = visible.map((s) => {
      const selected = selSet.has(s.id)
      const hovered = (hoverSet.has(s.id) && !selected) || planHighlight === s.id
      const isGuide = s.cut.type === 'guide'
      const showCut = !isGuide && (selected || hovered || cutAll)
      const geom = showCut && inView(s) ? requestCut(s) : undefined
      return <PlanShape key={s.id} s={s} selected={selected} hovered={hovered} showCut={showCut} geom={geom} />
    })
  } else {
    // Review: deeper cuts are drawn last so they sit on top of shallower ones.
    const items = visible
      .filter((s) => s.cut.type !== 'guide')
      .map((s) => ({ s, level: depthLevel(s.cut.depth), geom: inView(s) ? requestCut(s) : undefined }))
      .filter((x) => x.geom)
      .sort((a, b) => a.level - b.level)
    shapeEls = items.map(({ s, geom }) => <ReviewShape key={s.id} s={s} geom={geom} zoom={z} />)
  }

  // selection overlay (screen space)
  // Custom anchor: a free marker that stays on the canvas until cleared (design mode only).
  const activeOrig = activeOrigin(doc, selection) ?? 'mc'
  const customActive = typeof activeOrig !== 'string'
  // The free anchor is a fraction of the selection's bounds: the regular overlay draws it, and only while
  // something is selected. The picker draws it itself so it can show it as chosen.
  const hasSelBox = !!selBBox && bboxValid(selBBox)
  const customPt = anchorPicking && customActive && hasSelBox ? anchorPoint(anchorBBox(selShapes, selBBox!), activeOrig) : null
  const customEl =
    mode === 'design' && customPt ? (
      <rect
        className={'cv-anchor-point__dot is-custom' + (customActive ? ' is-active' : '')}
        x={sx(customPt.x) - ANCHOR_SIZE / 2}
        y={sy(customPt.y) - ANCHOR_SIZE / 2}
        width={ANCHOR_SIZE}
        height={ANCHOR_SIZE}
        rx={ANCHOR_RX}
      />
    ) : null
  let overlay: React.ReactNode = null
  if (anchorPicking && mode === 'design' && selBBox && bboxValid(selBBox)) {
    const joint = boxJointForSelection(doc, selection)
    const jointPts = joint
      ? STOCK_ANCHORS.map((a) => {
          const q = stockAnchorWorld(joint, a)
          return { key: a, x: sx(q.x), y: sy(q.y), active: stockAnchorOf(joint) === a }
        })
      : undefined
    overlay = (
      <AnchorPickOverlay
        x0={sx(selBBox.minX)}
        y0={sy(selBBox.minY)}
        x1={sx(selBBox.maxX)}
        y1={sy(selBBox.maxY)}
        value={activeOrigin(doc, selection) ?? 'mc'}
        hasCustom={!!doc.settings.customAnchor}
        w={viewport.w}
        h={viewport.h}
        points={jointPts}
      />
    )
  } else if (selBBox && bboxValid(selBBox) && tool === 'select' && !pen.editing) {
    const x0 = sx(selBBox.minX)
    const y0 = sy(selBBox.minY)
    const x1 = sx(selBBox.maxX)
    const y1 = sy(selBBox.maxY)
    // Studio's brackets sit 8px outside the bounds, with 10px arms.
    const pad = 8
    const L = 10
    const units = doc.units
    if (mode === 'design' && selShapes.some((s) => s.locked)) {
      // A selection with a reference in it: Studio's thin orange box, no handles, labels or anchor.
      overlay = (
        <g className="cv-overlay">
          <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} className="cv-bbox is-reference" />
        </g>
      )
    } else if (mode === 'design') {
      const hb = selBBox
      const hpos = (hh: Handle): Pt => ({
        x: hh.includes('l') ? hb.minX : hh.includes('r') ? hb.maxX : (hb.minX + hb.maxX) / 2,
        y: hh.startsWith('t') ? hb.minY : hh.startsWith('b') ? hb.maxY : (hb.minY + hb.maxY) / 2,
      })
      const handleOrigin = activeOrigin(doc, selection) ?? 'mc'
      const handleAnchor = ownAnchorPoint(selShapes, handleOrigin) ?? anchorPoint(hb, handleOrigin)
      // Studio hides the handles a selected template cannot be dragged by (the keyhole keeps only the bottom one).
      const noHandles = disallowedHandles(selShapes)
      const H = (h: Handle, x: number, y: number, dx: number, dy: number) => {
        if (noHandles.has(h) || !handleUsable(h, hpos(h), handleAnchor)) return null
        const corner = !h.includes('m')
        const half = handleSize / 2
        return (
          <g key={h} className={'cv-handle cv-handle--' + h} onPointerDown={(e) => startScale(e, h)}>
            <rect x={x - half} y={y - half} width={handleSize} height={handleSize} fill="transparent" />
            {corner ? (
              <path d={`M${x + dx * L} ${y}H${x}V${y + dy * L}`} />
            ) : h === 'tm' || h === 'bm' ? (
              <line x1={x - 6} x2={x + 6} y1={y} y2={y} />
            ) : (
              <line x1={x} x2={x} y1={y - 6} y2={y + 6} />
            )}
          </g>
        )
      }
      const cx = (x0 + x1) / 2
      const cy = (y0 + y1) / 2
      const wLabel = fmtLen(selBBox.maxX - selBBox.minX, units)
      const hLabel = fmtLen(selBBox.maxY - selBBox.minY, units)
      // Position labels: the anchor's coordinates, on the axis lines through it (Studio's X / Y pills).
      const posOn = labelsShown(doc)
      const xLabel = `X: ${fmtLen(handleAnchor.x, units)}`
      const yLabel = `Y: ${fmtLen(handleAnchor.y, units)}`
      const xW = textPillWidth(xLabel)
      const yW = textPillWidth(yLabel)
      const wW = textPillWidth(wLabel)
      const hW = textPillWidth(hLabel)
      const ax = sx(handleAnchor.x)
      const ay = sy(handleAnchor.y)
      const hOnLeft = (x0 + x1) / 2 < viewport.w / 2
      // Keyed on the selection, so the handles play their entrance again on every selection change (as in Studio).
      // Several objects: the box around them is gray (Studio's group box); the measurements stay blue.
      const multi = selectionUnitCount(selShapes, true) > 1
      overlay = (
        <g key={selection.join(',')} className={'cv-overlay' + (multi ? ' is-multi' : '')}>
          <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} className="cv-bbox" />
          {H('tl', x0 - pad, y0 - pad, 1, 1)}
          {H('tr', x1 + pad, y0 - pad, -1, 1)}
          {H('br', x1 + pad, y1 + pad, -1, -1)}
          {H('bl', x0 - pad, y1 + pad, 1, -1)}
          {H('tm', cx, y0 - pad, 0, 0)}
          {H('bm', cx, y1 + pad, 0, 0)}
          {H('lm', x0 - pad, cy, 0, 0)}
          {H('rm', x1 + pad, cy, 0, 0)}
          {/* The origin marker: the usual centre dot, or the picked point (blue when snapped, red when free). */}
          {(() => {
            const o = activeOrigin(doc, selection) ?? 'mc'
            const ap = ownAnchorPoint(selShapes, o) ?? anchorPoint(anchorBBox(selShapes, selBBox), o)
            const free = typeof o !== 'string'
            const cls = o === 'mc' ? 'cv-center' : 'cv-anchor-mark' + (free ? ' is-free' : '')
            return <rect x={sx(ap.x) - ANCHOR_SIZE / 2} y={sy(ap.y) - ANCHOR_SIZE / 2} width={ANCHOR_SIZE} height={ANCHOR_SIZE} rx={ANCHOR_RX} className={cls} />
          })()}
          {/* Width sits above the box; height goes on the side away from the middle of the viewport (as in Studio). */}
          <g className="cv-label" transform={`translate(${cx} ${y0 - 24})`}>
            <rect x={-wW / 2} y={-10} width={wW} height={18} rx={3} />
            <text textAnchor="middle" y={4}>
              {wLabel}
            </text>
          </g>
          <g className="cv-label" transform={`translate(${hOnLeft ? x0 - 24 : x1 + 24} ${cy}) rotate(90)`}>
            <rect x={-hW / 2} y={-10} width={hW} height={18} rx={3} />
            <text textAnchor="middle" y={4}>
              {hLabel}
            </text>
          </g>
          {posOn && (
            <>
              {/* Y above the box (clear of the width label); X on the side away from the height label. */}
              <line className="cv-pos-tick" x1={ax} x2={ax} y1={y0 - 6} y2={y0 + 6} />
              <g className="cv-label" transform={`translate(${ax} ${y0 - 50})`}>
                <rect x={-yW / 2} y={-10} width={yW} height={18} rx={3} />
                <text textAnchor="middle" y={4}>
                  {yLabel}
                </text>
              </g>
              <line className="cv-pos-tick" x1={hOnLeft ? x1 - 6 : x0 - 6} x2={hOnLeft ? x1 + 6 : x0 + 6} y1={ay} y2={ay} />
              <g className="cv-label" transform={`translate(${hOnLeft ? x1 + 24 + xW / 2 : x0 - 24 - xW / 2} ${ay})`}>
                <rect x={-xW / 2} y={-10} width={xW} height={18} rx={3} />
                <text textAnchor="middle" y={4}>
                  {xLabel}
                </text>
              </g>
            </>
          )}
        </g>
      )
    } else if (mode === 'plan' && selShapes.length && !selShapes.every((s) => s.cut.type === 'guide')) {
      // Depth 0 (or NaN) means unset, the same as null.
      const depths = [...new Set(selShapes.map((s) => s.cut.depth || null))]
      const unset = depths.length === 1 && depths[0] == null
      const label = depths.length > 1 ? 'mixed' : depths[0] == null ? 'unset' : fmtLen(depths[0], units)
      // Left of the selection, clamped so it never leaves the viewport.
      const tipW = 96
      const tipH = 26
      const tx = clampRange(x0 - tipW - 8, 4, viewport.w - tipW - 4)
      const ty = clampRange((y0 + y1) / 2 - tipH / 2, 4, viewport.h - tipH - 4)
      overlay = (
        <foreignObject x={tx} y={ty} width={tipW} height={tipH} style={{ overflow: 'visible' }}>
          <div className={'cut-depth-tooltip' + (unset ? ' is-unset' : '')}>
            <IconArrowDown size={14} />
            <span>{label}</span>
          </div>
        </foreignObject>
      )
    }
  }

  let marquee: React.ReactNode = null
  if (drag?.kind === 'marquee') {
    const x = Math.min(sx(drag.start.x), sx(drag.cur.x))
    const y = Math.min(sy(drag.start.y), sy(drag.cur.y))
    marquee = <rect className="cv-marquee" x={x} y={y} width={Math.abs(sx(drag.cur.x) - sx(drag.start.x))} height={Math.abs(sy(drag.cur.y) - sy(drag.start.y))} />
  }

  const guideEls = mode === 'review'
    ? null
    : guides.map((g, i) => {
        // As in Studio, an object guide runs between the moved thing and its target; a grid guide crosses the view.
        const span = g.from !== undefined && g.to !== undefined
        return g.axis === 'x' ? (
          <line key={i} className={g.grid ? 'cv-guide cv-guide--grid' : 'cv-guide'} x1={sx(g.at)} x2={sx(g.at)} y1={span ? sy(g.from!) : 0} y2={span ? sy(g.to!) : viewport.h} />
        ) : (
          <line key={i} className={g.grid ? 'cv-guide cv-guide--grid' : 'cv-guide'} y1={sy(g.at)} y2={sy(g.at)} x1={span ? sx(g.from!) : 0} x2={span ? sx(g.to!) : viewport.w} />
        )
      })

  let draftEl: React.ReactNode = null
  if (tool === 'draw' && (draft.length || cursor)) {
    const pts = cursor ? [...draft, cursor] : draft
    const d = contoursToD([{ pts, closed: false }])
    const nearStart = draft.length >= 3 && cursor && Math.hypot(draft[0].x - cursor.x, draft[0].y - cursor.y) * z < 10
    draftEl = (
      <g className="cv-draft">
        <path d={d} transform={worldTransform} vectorEffect="non-scaling-stroke" />
        {draft.map((p, i) => (
          <rect key={i} x={sx(p.x) - 4} y={sy(p.y) - 4} width={8} height={8} rx={1.5} className={i === 0 && nearStart ? 'is-close' : ''} />
        ))}
        {cursor && <circle cx={sx(cursor.x)} cy={sy(cursor.y)} r={10} className="cv-draft-cursor" />}
      </g>
    )
  }

  const cursorStyle = anchorPicking
    ? 'default'
    : drag?.kind === 'pan' || spaceDown
      ? drag
        ? 'grabbing'
        : 'grab'
      : drag?.kind === 'pinch'
        ? 'grabbing'
        : drag?.kind === 'zoom'
          ? 'ns-resize'
          : tool === 'draw' || tool === 'pen'
          ? 'crosshair'
          : pen.cursorStyle
            ? pen.cursorStyle
          : hover && mode === 'design' && !doc.shapes.find((x) => x.id === hover)?.locked
            ? 'move'
            : 'default'

  return (
    <svg
      ref={svgRef}
      className={'ui-viewport mode-' + mode + (anchorPicking ? ' is-anchor-picking' : '')}
      style={{ cursor: cursorStyle }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onLostCapture}
      onPointerLeave={() => {
        setAnchorHover(null)
        setHover(null)
        setCursor(null)
        pen.clearCursor()
        if (!dragRef.current) setGuides((prev) => (prev.length ? [] : prev))
      }}
      onContextMenu={(e) => e.preventDefault()}
      onAuxClick={(e) => e.preventDefault()}
    >
      <defs>
        {/* Pocket tick pattern, in world units so ticks stay a constant screen size. */}
        <pattern id="ss-pocket-ticks" patternUnits="userSpaceOnUse" width={TICK_PX / z} height={TICK_PX / z}>
          {/* Four short ticks pointing into the tile corners: reads as a sparse dotted grid. */}
          <path
            d={(() => {
              const t = TICK_PX / z
              const a = t * 0.12
              const b = t * 0.26
              return `M${a} ${a}L${b} ${b}M${t - a} ${a}L${t - b} ${b}M${a} ${t - a}L${b} ${t - b}M${t - a} ${t - a}L${t - b} ${t - b}`
            })()}
            stroke="#fdfdfe"
            strokeWidth={1 / z}
            strokeLinecap="round"
            fill="none"
          />
        </pattern>
        {/* Procedural wood grain, anchored to the workspace like Studio's tile (it pans and zooms with the sheet). */}
        <pattern id="rv-grain" patternUnits="userSpaceOnUse" width={GRAIN_TILE * z} height={GRAIN_TILE * z} patternTransform={`translate(${view.panX} ${view.panY})`}>
          <g transform={`scale(${z})`}>
            {GRAIN_LINES.map((l, i) => (
              <g key={i} fill="none" strokeLinecap="round">
                <path d={l.d} stroke="rgba(118,120,128,.10)" strokeWidth={l.w * 2} />
                <path d={l.d} stroke="rgba(118,120,128,.2)" strokeWidth={l.w} />
              </g>
            ))}
          </g>
        </pattern>
      </defs>
      {mode === 'review' && (
        <>
          <rect width="100%" height="100%" className="rv-bg" />
          <rect width="100%" height="100%" fill="url(#rv-grain)" />
        </>
      )}
      {mode !== 'review' && gridEl}
      {mode !== 'review' && doc.settings.originAnchor && (
        // Origin Anchor: Studio's red corner marker at the workspace origin (fixed screen size, corner on 0,0).
        <path className="cv-origin" d={`M ${sx(0)} ${sy(0) - 24} V ${sy(0)} H ${sx(0) + 14} Z`} pointerEvents="none" />
      )}
      <g transform={worldTransform}>{shapeEls}</g>
      {guideEls}
      {overlay}
      {customEl}
      {anchorPicking && mode === 'design' && anchorHover && (
        <g className="cv-anchor-hover">
          <circle cx={sx(anchorHover.x)} cy={sy(anchorHover.y)} r={ANCHOR_RING_R} className="cv-anchor-hover__halo" />
          <rect
            x={sx(anchorHover.x) - ANCHOR_SIZE / 2}
            y={sy(anchorHover.y) - ANCHOR_SIZE / 2}
            width={ANCHOR_SIZE}
            height={ANCHOR_SIZE}
            rx={ANCHOR_RX}
          />
        </g>
      )}
      {marquee}
      {draftEl}
      {pen.render(sx, sy)}
    </svg>
  )
}
