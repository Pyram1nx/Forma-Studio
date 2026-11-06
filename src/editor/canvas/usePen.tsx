// The Pen tool and the pen-path node editor of the Design canvas.
//
// Drawing: click places a corner, click-drag pulls out smooth Bézier handles (Alt breaks them,
// Shift snaps angles to 45°). Clicking the first node closes the path; clicking the last node
// drops its outgoing handle; a double click, Enter or Escape finishes an open path.
//
// Editing (a just-finished path opens in it; later visits: double-click a pen path or Edit Points
// in the panel): drag anchors and handles, click a segment to add a node, Alt-click or double-click
// a node to toggle smooth / corner, Delete removes the selected node, arrows nudge it, Escape /
// Enter or a click away leaves the editor.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PenContour, PenNode, Pt, Shape } from '../../model/types'
import { MM_PER_IN } from '../../model/types'
import { useStore } from '../../state/store'
import { newShapeCut } from '../../state/prefs'
import { uid } from '../../model/ids'
import { bake, recenter, toWorld as shapeToWorld } from '../../geometry/transform'
import { deleteNode, flattenPen, mapPen, moveHandle, moveNode, nearestOnPen, penOf, penToD, splitSegment, toggleSmooth, withPen } from '../../geometry/pen'

/** Screen px within which a click lands on a node or handle (mouse / touch). */
const HIT_MOUSE = 8
const HIT_TOUCH = 16
/** Screen px of drag before a placed node starts growing handles. */
const DRAG_PX = 3
const DOUBLE_CLICK_MS = 350

type PtrEvent = { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; pointerType?: string }

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const mirror = (anchor: Pt, h: Pt): Pt => ({ x: 2 * anchor.x - h.x, y: 2 * anchor.y - h.y })

/** p constrained to the nearest 45° direction from `from`. */
export function snapAngle(from: Pt, p: Pt): Pt {
  const dx = p.x - from.x
  const dy = p.y - from.y
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
  const len = Math.hypot(dx, dy)
  return { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len }
}

/** World -> a shape's local frame (inverse of transform.toWorld). */
function toLocal(s: Pick<Shape, 'x' | 'y' | 'rotation' | 'sx' | 'sy'>, p: Pt): Pt {
  const a = (-s.rotation * Math.PI) / 180
  const dx = p.x - s.x
  const dy = p.y - s.y
  return { x: (dx * Math.cos(a) - dy * Math.sin(a)) / (s.sx || 1), y: (dx * Math.sin(a) + dy * Math.cos(a)) / (s.sy || 1) }
}

/** A new pen shape from drawn nodes (world mm), or null if there is not enough to make one. */
export function penShapeFrom(nodes: PenNode[], close: boolean): Shape | null {
  if (nodes.length < 2) return null
  const pc: PenContour = { nodes, closed: close }
  const flat = flattenPen(pc)
  // Two straight nodes cannot enclose anything: such a path stays open.
  pc.closed = flat.closed
  return recenter({
    id: uid(),
    name: pc.closed ? 'Closed Pen Path' : 'Pen Path',
    kind: 'path',
    pen: [pc],
    contours: [flat],
    x: 0,
    y: 0,
    rotation: 0,
    sx: 1,
    sy: 1,
    cut: pc.closed ? newShapeCut() : newShapeCut('online'),
  })
}

/** Whether this shape is an editable pen path. */
export const isPenShape = (s: Shape | undefined): s is Shape => !!s && !s.locked && !!penOf(s)

/** Open the node editor on a pen path: select it and bake its transform (no visible change, no undo step). */
export function openPenEdit(id: string) {
  const st = useStore.getState()
  st.select([id])
  st.patchShapes([id], bake)
  st.setPenEdit(id)
}

interface Opts {
  /** Client -> world mm. */
  toWorld: (cx: number, cy: number) => Pt
  /** Smart Alignment / grid snapping for an anchor (world mm); `exclude` is the shape being edited. */
  snap: (p: Pt, e: PtrEvent, exclude?: string) => Pt
  /** Remove any snap guides. */
  clearGuides: () => void
}

type DraftDrag =
  | { kind: 'place'; start: Pt; moved: boolean }
  | { kind: 'close'; start: Pt; moved: boolean }
  | { kind: 'lastOut'; start: Pt; moved: boolean }

type EditDrag =
  | { kind: 'node'; c: number; i: number; start: Pt; origin: Pt; moved: boolean }
  | { kind: 'handle'; c: number; i: number; side: 'in' | 'out'; moved: boolean }

type NodeRef = { c: number; i: number }

export function usePen({ toWorld, snap, clearGuides }: Opts) {
  const tool = useStore((s) => s.tool)
  const mode = useStore((s) => s.mode)
  const selection = useStore((s) => s.selection)
  const penEditId = useStore((s) => s.penEditId)
  // The edited shape: only while it is the one selected pen path in Design with the select tool.
  const editShape = useStore((s) => {
    if (!s.penEditId || s.tool !== 'select' || s.mode !== 'design' || s.selection.length !== 1 || s.selection[0] !== s.penEditId) return undefined
    const sh = s.doc.shapes.find((x) => x.id === s.penEditId)
    return isPenShape(sh) ? sh : undefined
  })

  // ---------- drawing ----------
  const [draft, setDraftState] = useState<PenNode[]>([])
  const draftRef = useRef<PenNode[]>([])
  const setDraft = (n: PenNode[]) => {
    draftRef.current = n
    setDraftState(n)
  }
  const [cursor, setCursor] = useState<Pt | null>(null)
  const draftDrag = useRef<DraftDrag | null>(null)
  const lastClick = useRef<{ t: number; x: number; y: number } | null>(null)

  // ---------- editing ----------
  const [picked, setPicked] = useState<NodeRef | null>(null)
  const pickedRef = useRef<NodeRef | null>(null)
  pickedRef.current = picked
  const editDrag = useRef<EditDrag | null>(null)
  const [editHover, setEditHover] = useState<'node' | 'handle' | 'segment' | null>(null)
  const editShapeRef = useRef(editShape)
  editShapeRef.current = editShape
  /** The edited shape as it is in the store now (pointer events can arrive before the next render). */
  const liveEdit = (): Shape | undefined => {
    const id = editShapeRef.current?.id
    const sh = id ? useStore.getState().doc.shapes.find((x) => x.id === id) : undefined
    return isPenShape(sh) ? sh : undefined
  }

  const hitPx = (e?: PtrEvent) => (e?.pointerType === 'touch' ? HIT_TOUCH : HIT_MOUSE)
  const zoom = () => useStore.getState().view.zoom

  useEffect(() => {
    if (tool !== 'pen') {
      setDraft([])
      setCursor(null)
      draftDrag.current = null
    }
  }, [tool])

  // The editor closes itself once its shape is no longer the selected pen path.
  useEffect(() => {
    if (penEditId && !editShape) useStore.getState().setPenEdit(null)
  }, [penEditId, editShape, selection, tool, mode])
  useEffect(() => {
    setPicked(null)
    editDrag.current = null
  }, [penEditId])

  const finish = (close: boolean) => {
    const nodes = draftRef.current
    setDraft([])
    setCursor(null)
    draftDrag.current = null
    clearGuides()
    const s = penShapeFrom(nodes, close)
    const st = useStore.getState()
    if (s) {
      st.addShapes([s])
      st.setTool('select')
      // Straight into node editing, so the shape can be tuned while it is fresh.
      openPenEdit(s.id)
    } else {
      st.setTool('select')
    }
  }

  const draftDown = (e: PtrEvent) => {
    const raw = toWorld(e.clientX, e.clientY)
    const nodes = draftRef.current
    const z = zoom()
    const tol = hitPx(e)
    const last = nodes[nodes.length - 1]
    const now = performance.now()
    const prev = lastClick.current
    lastClick.current = { t: now, x: e.clientX, y: e.clientY }
    const dbl = !!prev && now - prev.t < DOUBLE_CLICK_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 8
    if (nodes.length >= 2 && dist(nodes[0], raw) * z < tol) {
      draftDrag.current = { kind: 'close', start: { x: nodes[0].x, y: nodes[0].y }, moved: false }
      return
    }
    if (last && dist(last, raw) * z < tol) {
      if (dbl && nodes.length >= 2) {
        lastClick.current = null
        finish(false)
        return
      }
      draftDrag.current = { kind: 'lastOut', start: { x: last.x, y: last.y }, moved: false }
      return
    }
    const q = last && e.shiftKey ? snapAngle(last, raw) : snap(raw, e)
    setDraft([...nodes, { x: q.x, y: q.y }])
    draftDrag.current = { kind: 'place', start: q, moved: false }
  }

  const draftMove = (e: PtrEvent) => {
    const raw = toWorld(e.clientX, e.clientY)
    const d = draftDrag.current
    const nodes = draftRef.current
    if (!d) {
      const last = nodes[nodes.length - 1]
      setCursor(last && e.shiftKey ? snapAngle(last, raw) : snap(raw, e))
      return
    }
    if (!d.moved && dist(d.start, raw) * zoom() < DRAG_PX) return
    d.moved = true
    const h = e.shiftKey ? snapAngle(d.start, raw) : raw
    const next = nodes.slice()
    if (d.kind === 'place') {
      const n = next[next.length - 1]
      // Alt drags only the outgoing handle (a cusp); otherwise both handles mirror.
      next[next.length - 1] = e.altKey ? { ...n, out: h, smooth: false } : { x: n.x, y: n.y, out: h, in: mirror(n, h), smooth: true }
    } else if (d.kind === 'close') {
      const n = next[0]
      // The handle pulled is the direction of travel through the first node; its incoming side mirrors it.
      next[0] = e.altKey ? { ...n, in: mirror(n, h), smooth: false } : { ...n, out: h, in: mirror(n, h), smooth: true }
    } else {
      const n = next[next.length - 1]
      next[next.length - 1] = { ...n, out: h, smooth: false }
    }
    setDraft(next)
    setCursor(null)
  }

  const draftUp = () => {
    const d = draftDrag.current
    draftDrag.current = null
    if (!d) return
    if (d.kind === 'close') finish(true)
    else if (d.kind === 'lastOut' && !d.moved) {
      // A click on the last node turns it into a corner going forward.
      const next = draftRef.current.slice()
      const n = { ...next[next.length - 1] }
      delete n.out
      n.smooth = false
      next[next.length - 1] = n
      setDraft(next)
    }
  }

  // ---------- editor helpers ----------
  const worldPen = (s: Shape) => mapPen(penOf(s)!, (p) => shapeToWorld(s, p))
  const commit = (s: Shape, pen: PenContour[] | null) => {
    const st = useStore.getState()
    if (!pen || !pen.length) {
      st.setPenEdit(null)
      st.deleteSelected()
      return
    }
    st.patchShapes([s.id], (x) => withPen(x, pen))
  }

  /** The handles the editor shows: the picked node's and the facing ones of its neighbours. */
  const visibleHandles = (pens: PenContour[], pk: NodeRef | null): { c: number; i: number; side: 'in' | 'out' }[] => {
    if (!pk || !pens[pk.c] || !pens[pk.c].nodes[pk.i]) return []
    const pc = pens[pk.c]
    const len = pc.nodes.length
    const out: { c: number; i: number; side: 'in' | 'out' }[] = [
      { c: pk.c, i: pk.i, side: 'in' },
      { c: pk.c, i: pk.i, side: 'out' },
    ]
    const prev = pk.i > 0 ? pk.i - 1 : pc.closed ? len - 1 : -1
    const next = pk.i < len - 1 ? pk.i + 1 : pc.closed ? 0 : -1
    if (prev >= 0) out.push({ c: pk.c, i: prev, side: 'out' })
    if (next >= 0) out.push({ c: pk.c, i: next, side: 'in' })
    return out.filter((h) => pc.nodes[h.i][h.side])
  }

  /** What is under a client point in the editor. */
  const editHit = (s: Shape, e: PtrEvent) => {
    const p = toWorld(e.clientX, e.clientY)
    const z = zoom()
    const tol = hitPx(e) / z
    const pens = worldPen(s)
    for (const h of visibleHandles(pens, pickedRef.current)) {
      if (dist(pens[h.c].nodes[h.i][h.side]!, p) <= tol) return { kind: 'handle' as const, ...h }
    }
    let bestNode: (NodeRef & { d: number }) | null = null
    pens.forEach((pc, c) =>
      pc.nodes.forEach((n, i) => {
        const d = dist(n, p)
        if (d <= tol && (!bestNode || d < bestNode.d)) bestNode = { c, i, d }
      }),
    )
    if (bestNode) return { kind: 'node' as const, c: (bestNode as NodeRef).c, i: (bestNode as NodeRef).i }
    const seg = nearestOnPen(pens, p)
    if (seg && seg.d <= tol) return { kind: 'segment' as const, ...seg }
    return null
  }

  /** Pointer down in the editor. False when it missed the path, so the caller treats it as a normal click. */
  const editDown = (e: PtrEvent): boolean => {
    const s = liveEdit()
    if (!s) return false
    const hit = editHit(s, e)
    if (!hit) return false
    const st = useStore.getState()
    const now = performance.now()
    const prev = lastClick.current
    lastClick.current = { t: now, x: e.clientX, y: e.clientY }
    const dbl = !!prev && now - prev.t < DOUBLE_CLICK_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 8
    if (hit.kind === 'handle') {
      editDrag.current = { kind: 'handle', c: hit.c, i: hit.i, side: hit.side, moved: false }
      return true
    }
    if (hit.kind === 'node') {
      setPicked({ c: hit.c, i: hit.i })
      if (e.altKey || dbl) {
        lastClick.current = null
        const pens = penOf(s)!.slice()
        pens[hit.c] = toggleSmooth(pens[hit.c], hit.i)
        st.checkpoint()
        commit(s, pens)
        return true
      }
      const n = penOf(s)![hit.c].nodes[hit.i]
      const w = shapeToWorld(s, n)
      editDrag.current = { kind: 'node', c: hit.c, i: hit.i, start: toWorld(e.clientX, e.clientY), origin: w, moved: false }
      return true
    }
    // On a segment: a new node there, which can be dragged right away.
    const pens = penOf(s)!.slice()
    pens[hit.contour] = splitSegment(pens[hit.contour], hit.seg, hit.t)
    st.checkpoint()
    commit(s, pens)
    const i = hit.seg + 1
    setPicked({ c: hit.contour, i })
    editDrag.current = { kind: 'node', c: hit.contour, i, start: toWorld(e.clientX, e.clientY), origin: hit.pt, moved: true }
    return true
  }

  /** Pointer move in the editor; true when the editor used it. */
  const editMove = (e: PtrEvent): boolean => {
    const s = liveEdit()
    if (!s) return false
    const d = editDrag.current
    if (!d) {
      const h = editHit(s, e)
      setEditHover(h ? h.kind : null)
      return false
    }
    const raw = toWorld(e.clientX, e.clientY)
    const st = useStore.getState()
    const pens = penOf(s)!.slice()
    const pc = pens[d.c]
    if (!pc || !pc.nodes[d.i]) return true
    const nodes = pc.nodes.slice()
    if (d.kind === 'node') {
      if (!d.moved && dist(d.start, raw) * zoom() < DRAG_PX) return true
      if (!d.moved) st.checkpoint()
      d.moved = true
      const target = { x: d.origin.x + raw.x - d.start.x, y: d.origin.y + raw.y - d.start.y }
      const w = e.shiftKey ? snapAngle(d.origin, target) : snap(target, e, s.id)
      nodes[d.i] = moveNode(nodes[d.i], toLocal(s, w))
    } else {
      if (!d.moved) st.checkpoint()
      d.moved = true
      const anchor = shapeToWorld(s, nodes[d.i])
      const w = e.shiftKey ? snapAngle(anchor, raw) : raw
      nodes[d.i] = moveHandle(nodes[d.i], d.side, toLocal(s, w), e.altKey)
    }
    pens[d.c] = { closed: pc.closed, nodes }
    commit(s, pens)
    return true
  }

  const editUp = () => {
    if (editDrag.current) clearGuides()
    editDrag.current = null
  }

  // ---------- keyboard ----------
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return
    const t = e.target as HTMLElement | null
    if (t?.closest?.('input, textarea, select, [contenteditable]')) return
    const st = useStore.getState()
    if (st.mode !== 'design' || st.dialog || st.menuOpen || st.popover || e.metaKey || e.ctrlKey) return
    if (st.tool === 'pen') {
      const nodes = draftRef.current
      if (e.key === 'Escape') {
        e.preventDefault()
        if (nodes.length >= 2) finish(false)
        else {
          setDraft([])
          st.setTool('select')
        }
      } else if (e.key === 'Enter' && nodes.length >= 2) {
        e.preventDefault()
        finish(false)
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && nodes.length) {
        e.preventDefault()
        setDraft(nodes.slice(0, -1))
      }
      return
    }
    const s = liveEdit()
    if (!s) return
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault()
      st.setPenEdit(null)
      return
    }
    const pk = pickedRef.current
    const pens = penOf(s)!
    if (!pk || !pens[pk.c]?.nodes[pk.i]) return
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      const next = pens.slice()
      const pc = deleteNode(next[pk.c], pk.i)
      if (pc) next[pk.c] = pc
      else next.splice(pk.c, 1)
      st.checkpoint()
      commit(s, next)
      setPicked(null)
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault()
      const step = (st.doc.units === 'in' ? MM_PER_IN / 16 : 1) * (e.shiftKey ? 10 : 1)
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
      const n = pens[pk.c].nodes[pk.i]
      const w = shapeToWorld(s, n)
      const next = pens.slice()
      const nodes = next[pk.c].nodes.slice()
      nodes[pk.i] = moveNode(n, toLocal(s, { x: w.x + dx, y: w.y + dy }))
      next[pk.c] = { closed: next[pk.c].closed, nodes }
      st.checkpoint()
      commit(s, next)
    }
  }
  useEffect(() => {
    const down = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [])

  // ---------- rendering (screen space) ----------
  const render = (sx: (x: number) => number, sy: (y: number) => number): ReactNode => {
    const scr = (p: Pt) => ({ x: sx(p.x), y: sy(p.y) })
    const square = (p: Pt, key: string | number, cls = '') => {
      const q = scr(p)
      return <rect key={key} x={q.x - 4} y={q.y - 4} width={8} height={8} rx={1.5} className={cls} />
    }
    const handleEls = (n: PenNode, key: string, sides: ('in' | 'out')[] = ['in', 'out']) => {
      const a = scr(n)
      return sides.map((side) => {
        const h = n[side]
        if (!h) return null
        const q = scr(h)
        return (
          <g key={key + side} className="cv-pen-handle">
            <line x1={a.x} y1={a.y} x2={q.x} y2={q.y} />
            <circle cx={q.x} cy={q.y} r={3.5} />
          </g>
        )
      })
    }

    const vp = useStore.getState().viewport
    const hint = (text: string) => (
      <text className="cv-pen-hint" x={vp.w / 2} y={vp.h - 62}>
        {text}
      </text>
    )

    if (tool === 'pen' && mode === 'design' && (draft.length || cursor)) {
      const last = draft[draft.length - 1]
      const z = zoom()
      const nearStart = draft.length >= 2 && cursor && dist(draft[0], cursor) * z < HIT_MOUSE
      let rubber = ''
      if (last && cursor && !nearStart) {
        const a = scr(last)
        const c1 = scr(last.out ?? last)
        const b = scr(cursor)
        rubber = `M${a.x} ${a.y}C${c1.x} ${c1.y} ${b.x} ${b.y} ${b.x} ${b.y}`
      } else if (last && nearStart) {
        // Preview of the closing segment.
        const a = scr(last)
        const c1 = scr(last.out ?? last)
        const c2 = scr(draft[0].in ?? draft[0])
        const b = scr(draft[0])
        rubber = `M${a.x} ${a.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`
      }
      return (
        <g className="cv-draft cv-pen">
          {hint('Click for a corner, drag for a curve (⌥ breaks handles) · click the first point to close · Enter to finish')}
          {draft.length > 1 && <path d={penToD([{ nodes: draft, closed: false }], scr)} />}
          {rubber && <path d={rubber} className="cv-pen-rubber" />}
          {last && handleEls(last, 'last')}
          {draft.length > 1 && draft[0] && handleEls(draft[0], 'first', ['out'])}
          {draft.map((n, i) => square(n, i, i === 0 && nearStart ? 'is-close' : ''))}
          {cursor && <circle cx={sx(cursor.x)} cy={sy(cursor.y)} r={10} className="cv-draft-cursor" />}
        </g>
      )
    }

    if (editShape) {
      const pens = worldPen(editShape)
      const pk = picked && pens[picked.c]?.nodes[picked.i] ? picked : null
      return (
        <g className="cv-draft cv-pen cv-pen-edit">
          {hint('Drag points and handles · click the path to add a point · ⌥ click a point for smooth / corner · Delete removes · Esc to finish')}
          {visibleHandles(pens, pk).map((h) => handleEls(pens[h.c].nodes[h.i], `${h.c}-${h.i}`, [h.side]))}
          {pens.map((pc, c) =>
            pc.nodes.map((n, i) => square(n, `${c}-${i}`, pk && pk.c === c && pk.i === i ? 'is-picked' : n.in || n.out ? 'is-smooth' : '')),
          )}
        </g>
      )
    }
    return null
  }

  const cursorStyle = editShape ? (editHover === 'segment' ? 'copy' : editHover ? 'pointer' : null) : null

  return {
    draftDown,
    draftMove,
    draftUp,
    editDown,
    editMove,
    editUp,
    editing: !!editShape,
    clearCursor: () => setCursor(null),
    cursorStyle,
    render,
  }
}
