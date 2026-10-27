import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { OriginPoint, OriginRef, Pt, Shape } from '../model/types'
import { activeOrigin, useStore } from '../state/store'
import { requestCut, subscribeCut, wbbox, world } from './geomCache'
import { bake, bboxValid, distToContours, emptyBBox, pointInContours, type BBox } from '../geometry/transform'
import { anchorPoint } from './ops'
import { alignCoords, snapKindsOn, snapPoint } from './snapTargets'
import { fmtLen } from '../model/factory'
import { uid } from '../model/ids'
import { DEFAULT_CUT } from '../model/types'
import { contoursToD } from '../geometry/svgPath'
import { buildFromParams, isParametric } from './shapeFactory'
import { IconArrowDown } from '../ui/icons'
import { boxJointForSelection, boxJointPartsOf, scaleBoxJoint, setBoxJointAnchor, stockAnchorOf, stockAnchorWorld, syncBoxJointGuides } from './boxJointGuides'
import { STOCK_ANCHORS, type StockAnchor } from '../geometry/boxJoints'
import { DesignShape, PlanShape, ReviewShape } from './canvas/ShapeViews'
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

type Handle = 'tl' | 'tm' | 'tr' | 'rm' | 'br' | 'bm' | 'bl' | 'lm'

type Drag =
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number; moved: boolean; tap: boolean }
  | { kind: 'move'; start: Pt; orig: Map<string, Pt>; bbox: BBox; moved: boolean }
  | { kind: 'marquee'; start: Pt; cur: Pt; additive: boolean }
  | { kind: 'scale'; handle: Handle; anchor: Pt; ref: Pt; start: Pt; orig: Map<string, Shape>; moved: boolean }
  | { kind: 'pinch'; dist: number; zoom: number; anchor: Pt }

interface Guide {
  axis: 'x' | 'y'
  at: number
}

const SNAP_PX = 6
/** Screen size of one pocket tick tile (Studio shows sparse short diagonal ticks). */
const TICK_PX = 24
const HANDLE_MOUSE = 18
const HANDLE_TOUCH = 28
const DOUBLE_CLICK_MS = 350
/** Extra world-space margin (screen px) when deciding whether a shape needs its band. */
const CULL_PX = 40

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

/** Turn accumulated scale on parametric shapes back into clean params. */
function normalizeParametric(s: Shape): Shape {
  if (!isParametric(s) || (s.sx === 1 && s.sy === 1)) return s
  const params = { ...s.params!, w: Number(s.params!.w) * Math.abs(s.sx), h: Number(s.params!.h) * Math.abs(s.sy) }
  const contours = buildFromParams(s.kind, params)
  if (!contours) return s
  return { ...s, params, contours, sx: Math.sign(s.sx) || 1, sy: Math.sign(s.sy) || 1 }
}

const ANCHOR_POINTS: OriginPoint[] = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br']
/** A click this close (screen px) to a bounds point snaps the origin to that point; anywhere else it is a free point. */
const ANCHOR_SNAP_PX = 10

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
  const xs = { l: x0, c: (x0 + x1) / 2, r: x1 }
  const ys = { t: y0, m: (y0 + y1) / 2, b: y1 }
  const pts =
    points ??
    ANCHOR_POINTS.map((p) => ({ key: p, x: xs[p[1] as 'l' | 'c' | 'r'], y: ys[p[0] as 't' | 'm' | 'b'], active: p === value }))
  return (
    <g className="cv-anchor-pick">
      <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} className="cv-bbox" />
      {pts.map(({ key, x, y, active }) => (
        <g key={key} className="cv-anchor-point" data-anchor={key}>
          <circle cx={x} cy={y} r={ANCHOR_SNAP_PX} className="cv-anchor-point__hit" />
          <circle cx={x} cy={y} r={ANCHOR_SNAP_PX - 1} className="cv-anchor-point__ring" />
          <rect x={x - 4} y={y - 4} width={8} height={8} className={'cv-anchor-point__dot' + (active ? ' is-active' : '')} />
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
  const lastPtrType = useRef(typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches ? 'touch' : 'mouse')
  const lastClick = useRef<{ t: number; x: number; y: number } | null>(null)
  const hoverRaf = useRef(0)
  const hoverPt = useRef<Pt | null>(null)

  useEffect(() => {
    if (anchorPicking) return
    setAnchorHover(null)
    setGuides((prev) => (prev.length ? [] : prev))
  }, [anchorPicking])

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
      if (ctrl || isMouseWheelDelta(e)) {
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
      cut: { ...DEFAULT_CUT, type: close ? 'outside' : 'online' },
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
    if (d.kind === 'pan' && d.tap && !d.moved) st.select([])
    if (d.kind === 'scale' && d.moved) st.patchShapes([...d.orig.keys()], normalizeParametric)
    setGuides((g) => (g.length ? [] : g))
    setDragBoth(null)
  }
  latest.current.endDrag = endDrag

  const startPinch = () => {
    const pts = [...touches.current.values()]
    const svg = svgRef.current
    if (pts.length < 2 || !svg) return
    if (dragRef.current?.kind === 'pan') setDragBoth({ ...dragRef.current, tap: false })
    endDrag()
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
        const w = typeof stock === 'string' || !st.doc.settings.smartAlignment
          ? raw
          : snapPoint(raw, visible, snapKindsOn(st.doc.settings), SNAP_PX / view.zoom).pt
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
    if (e.button === 1) e.preventDefault() // stop browser autoscroll on middle click
    svgRef.current?.setPointerCapture?.(e.pointerId)
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touches.current.size >= 2) {
        startPinch()
        return
      }
    }
    const p = toWorld(e.clientX, e.clientY)
    const pan = (tap: boolean) =>
      setDragBoth({ kind: 'pan', sx: e.clientX, sy: e.clientY, px: st.view.panX, py: st.view.panY, moved: false, tap })

    if (e.button === 1 || e.button === 2 || spaceDown || mode === 'review') {
      pan(false)
      return
    }

    if (tool === 'draw' && mode === 'design') {
      const dr = draftRef.current
      let q = p
      const last = dr[dr.length - 1]
      if (last && e.shiftKey) q = snapAngle(last, q)
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
      } else if (hit.groupId && mode === 'design' && !hit.locked) {
        // A plain click on a grouped element selects the whole group, so it drags as one.
        st.selectGroup(hit.groupId)
        sel = useStore.getState().selection
      } else if (!sel.includes(hit.id)) {
        sel = [hit.id]
        st.select(sel)
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
    if (!e.shiftKey) st.select([])
    setDragBoth({ kind: 'marquee', start: p, cur: p, additive: e.shiftKey })
  }

  const startScale = (e: React.PointerEvent, h: Handle) => {
    e.stopPropagation() // the svg handlers do not also run for the handle
    lastPtrType.current = e.pointerType
    svgRef.current?.setPointerCapture?.(e.pointerId)
    if (e.pointerType === 'touch') touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (!selBBox) return
    const st = useStore.getState()
    const b = selBBox
    const pos = (hh: Handle): Pt => ({
      x: hh.includes('l') ? b.minX : hh.includes('r') ? b.maxX : (b.minX + b.maxX) / 2,
      y: hh.startsWith('t') ? b.minY : hh.startsWith('b') ? b.maxY : (b.minY + b.maxY) / 2,
    })
    // Scaling is always about the anchor (the centre unless another point was picked), as in Studio.
    const anchor = anchorPoint(b, activeOrigin(st.doc, st.selection) ?? 'mc')
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
    setDragBoth({ kind: 'scale', handle: h, anchor, ref: pos(h), start: toWorld(e.clientX, e.clientY), orig, moved: false })
  }

  /** Snap the free-anchor preview to the enabled targets; hidden over the nine stock points and for box joints. */
  const updateAnchorHover = (raw: Pt, st: ReturnType<typeof useStore.getState>) => {
    const joint = boxJointForSelection(st.doc, st.selection)
    if (joint || !selBBox || !bboxValid(selBBox) || typeof originAt(raw, selBBox, st.view.zoom) === 'string') {
      setAnchorHover(null)
      setGuides((prev) => (prev.length ? [] : prev))
      return
    }
    const hit = st.doc.settings.smartAlignment
      ? snapPoint(raw, visible, snapKindsOn(st.doc.settings), SNAP_PX / st.view.zoom)
      : { pt: raw, guides: [] as Guide[] }
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
      updateAnchorHover(p, st)
      return
    }
    if (tool === 'draw') {
      const dr = draftRef.current
      const last = dr[dr.length - 1]
      setCursor(last && e.shiftKey ? snapAngle(last, p) : p)
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
      case 'marquee':
        setDragBoth({ ...d, cur: p })
        break
      case 'move': {
        let dx = p.x - d.start.x
        let dy = p.y - d.start.y
        if (!d.moved && Math.hypot(dx, dy) * st.view.zoom < 3) return
        if (!d.moved) st.checkpoint()
        // Shift constrains to the dominant axis; smart snapping then only runs on the free axis.
        const axis = e.shiftKey ? (Math.abs(dx) > Math.abs(dy) ? 'x' : 'y') : null
        if (axis === 'x') dy = 0
        if (axis === 'y') dx = 0
        const g: Guide[] = []
        if (st.doc.settings.smartAlignment && !e.altKey) {
          const tol = SNAP_PX / st.view.zoom
          const others = visible.filter((s) => !d.orig.has(s.id))
          const { xs, ys } = alignCoords(others, snapKindsOn(st.doc.settings))
          const mb = d.bbox
          if (axis !== 'y') {
            const mx = [mb.minX + dx, (mb.minX + mb.maxX) / 2 + dx, mb.maxX + dx]
            let best = { d: tol, v: 0, at: NaN }
            for (const a of mx) for (const b of xs) if (Math.abs(a - b) < best.d) best = { d: Math.abs(a - b), v: b - a, at: b }
            if (!Number.isNaN(best.at)) {
              dx += best.v
              g.push({ axis: 'x', at: best.at })
            }
          }
          if (axis !== 'x') {
            const my = [mb.minY + dy, (mb.minY + mb.maxY) / 2 + dy, mb.maxY + dy]
            let best = { d: tol, v: 0, at: NaN }
            for (const a of my) for (const b of ys) if (Math.abs(a - b) < best.d) best = { d: Math.abs(a - b), v: b - a, at: b }
            if (!Number.isNaN(best.at)) {
              dy += best.v
              g.push({ axis: 'y', at: best.at })
            }
          }
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
          return {
            ...o,
            x: anchor.x + (o.x - anchor.x) * fx,
            y: anchor.y + (o.y - anchor.y) * fy,
            sx: o.sx * fx,
            sy: o.sy * fy,
          }
        })
        for (const id of joints.outlines) syncBoxJointGuides(id)
        if (!d.moved) setDragBoth({ ...d, moved: true })
        break
      }
    }
  }

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    touches.current.delete(e.pointerId)
    endDrag()
  }

  const onLostCapture = (e: React.PointerEvent<SVGSVGElement>) => {
    touches.current.delete(e.pointerId)
    endDrag()
  }

  // ---------- rendering ----------
  const z = view.zoom
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
      const hovered = hoverSet.has(s.id) && !selected
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
  const customAnchor = doc.settings.customAnchor
  const customEl =
    mode === 'design' && customAnchor ? (
      <rect className="cv-anchor-mark is-free" x={sx(customAnchor.x) - 3} y={sy(customAnchor.y) - 3} width={6} height={6} />
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
  } else if (selBBox && bboxValid(selBBox) && tool === 'select') {
    const x0 = sx(selBBox.minX)
    const y0 = sy(selBBox.minY)
    const x1 = sx(selBBox.maxX)
    const y1 = sy(selBBox.maxY)
    const pad = 4
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
      const handleAnchor = anchorPoint(hb, activeOrigin(doc, selection) ?? 'mc')
      const H = (h: Handle, x: number, y: number, dx: number, dy: number) => {
        if (!handleUsable(h, hpos(h), handleAnchor)) return null
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
      const pLabel = doc.settings.showPosition ? `x ${fmtLen(selBBox.minX, units)} · y ${fmtLen(selBBox.minY, units)}` : ''
      const wW = textPillWidth(wLabel)
      const hW = textPillWidth(hLabel)
      const pW = textPillWidth(pLabel, 6)
      overlay = (
        <g className="cv-overlay">
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
            const ap = anchorPoint(selBBox, o)
            const free = typeof o !== 'string'
            const cls = o === 'mc' ? 'cv-center' : 'cv-anchor-mark' + (free ? ' is-free' : '')
            return <rect x={sx(ap.x) - 2.5} y={sy(ap.y) - 2.5} width={5} height={5} className={cls} />
          })()}
          <g className="cv-label" transform={`translate(${cx} ${y1 + 24})`}>
            <rect x={-wW / 2} y={-10} width={wW} height={18} rx={3} />
            <text textAnchor="middle" y={4}>
              {wLabel}
            </text>
          </g>
          <g className="cv-label" transform={`translate(${x1 + 24} ${cy}) rotate(90)`}>
            <rect x={-hW / 2} y={-10} width={hW} height={18} rx={3} />
            <text textAnchor="middle" y={4}>
              {hLabel}
            </text>
          </g>
          {doc.settings.showPosition && (
            <g className="cv-label" transform={`translate(${x0} ${y0 - 22})`}>
              <rect x={0} y={-10} width={pW} height={18} rx={3} />
              <text x={6} y={4}>
                {pLabel}
              </text>
            </g>
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
    : guides.map((g, i) =>
        g.axis === 'x' ? (
          <line key={i} className="cv-guide" x1={sx(g.at)} x2={sx(g.at)} y1={0} y2={viewport.h} />
        ) : (
          <line key={i} className="cv-guide" y1={sy(g.at)} y2={sy(g.at)} x1={0} x2={viewport.w} />
        ),
      )

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
        : tool === 'draw'
          ? 'crosshair'
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
        {/* Procedural wood grain, screen-space and built from soft low-alpha strokes (no filter). */}
        <pattern id="rv-grain" patternUnits="userSpaceOnUse" width={520} height={300}>
          <path d="M0 40 C150 20 300 70 450 45 S750 20 900 40" transform="scale(.58 1)" stroke="rgba(120,124,138,.07)" strokeWidth="12" fill="none" />
          <path d="M0 40 C150 20 300 70 450 45 S750 20 900 40" transform="scale(.58 1)" stroke="rgba(120,124,138,.12)" strokeWidth="5" fill="none" />
          <path d="M0 115 C200 95 330 140 520 120 S780 100 900 115" transform="scale(.58 1)" stroke="rgba(120,124,138,.06)" strokeWidth="9" fill="none" />
          <path d="M0 115 C200 95 330 140 520 120 S780 100 900 115" transform="scale(.58 1)" stroke="rgba(120,124,138,.10)" strokeWidth="3" fill="none" />
          <path d="M0 220 C180 200 340 245 520 225 S760 205 900 220" transform="scale(.58 1)" stroke="rgba(120,124,138,.08)" strokeWidth="6" fill="none" />
        </pattern>
      </defs>
      {mode === 'review' && (
        <>
          <rect width="100%" height="100%" className="rv-bg" />
          <rect width="100%" height="100%" fill="url(#rv-grain)" />
        </>
      )}
      {mode !== 'review' && doc.settings.originAnchor && (
        // Origin Anchor: Studio's red corner marker at the workspace origin (fixed screen size, corner on 0,0).
        <path className="cv-origin" d={`M ${sx(0)} ${sy(0) - 24} V ${sy(0)} H ${sx(0) + 14} Z`} pointerEvents="none" />
      )}
      <g transform={worldTransform}>{shapeEls}</g>
      {guideEls}
      {overlay}
      {customEl}
      {anchorPicking && mode === 'design' && anchorHover && (
        <circle className="cv-anchor-hover" cx={sx(anchorHover.x)} cy={sy(anchorHover.y)} r={4} />
      )}
      {marquee}
      {draftEl}
    </svg>
  )
}
