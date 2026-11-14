// Pan/zoom canvas shared by the full-screen modes (ShapeShifter, Offset). Children draw in
// world mm inside the transformed group; `tapOk()` tells click handlers the pointer did not drag.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as Ic from '../ui/icons'
import type { BBox } from '../geometry/transform'

interface View {
  zoom: number
  panX: number
  panY: number
}

function fitView(b: BBox, w: number, h: number): View {
  const pad = Math.min(120, w * 0.2, h * 0.2)
  const bw = Math.max(b.maxX - b.minX, 1)
  const bh = Math.max(b.maxY - b.minY, 1)
  const zoom = Math.max(0.05, Math.min((w - pad * 2) / bw, (h - pad * 2) / bh, 400))
  return { zoom, panX: w / 2 - ((b.minX + b.maxX) / 2) * zoom, panY: h / 2 - ((b.minY + b.maxY) / 2) * zoom }
}

export default function ModeCanvas({
  bounds,
  zoomTarget,
  children,
}: {
  /** Framed once, on entry. */
  bounds: BBox
  /** What the zoom button frames (defaults to `bounds`). */
  zoomTarget?: () => BBox
  children: (tapOk: () => boolean) => ReactNode
}) {
  const [view, setView] = useState<View>({ zoom: 1, panX: 0, panY: 0 })
  const areaRef = useRef<HTMLDivElement>(null)
  // `slop` is the drift a press may have and still count as a tap: fingers wobble far more than a
  // mouse, so touch gets the platform-standard ~10px while pointer and pen stay precise at 4px.
  const drag = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean; slop: number } | null>(null)

  const fit = (b: BBox) => {
    const r = areaRef.current?.getBoundingClientRect()
    if (r && Number.isFinite(b.minX)) setView(fitView(b, r.width, r.height))
  }
  useEffect(() => {
    fit(bounds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Wheel zooms about the pointer (non-passive so the page does not scroll).
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const x = e.clientX - r.left
      const y = e.clientY - r.top
      setView((v) => {
        const zoom = Math.max(0.05, Math.min(2000, v.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))))
        const k = zoom / v.zoom
        return { zoom, panX: x - (x - v.panX) * k, panY: y - (y - v.panY) * k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div
      ref={areaRef}
      className="modeview__canvas"
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY, moved: false, slop: e.pointerType === 'touch' ? 10 : 4 }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || !(e.buttons & 1)) return
        const dx = e.clientX - d.x
        const dy = e.clientY - d.y
        if (!d.moved && Math.hypot(dx, dy) < d.slop) return
        d.moved = true
        setView((v) => ({ ...v, panX: d.panX + dx, panY: d.panY + dy }))
      }}
      onPointerUp={() => setTimeout(() => (drag.current = null), 0)}
    >
      <svg className="modeview__svg">
        <g transform={`translate(${view.panX} ${view.panY}) scale(${view.zoom})`}>{children(() => !drag.current?.moved)}</g>
      </svg>
      <button type="button" className="modeview__zoom" aria-label="Zoom to Selection" title="Zoom to Selection" onClick={() => fit(zoomTarget ? zoomTarget() : bounds)}>
        <Ic.IconZoomSel size={20} />
      </button>
    </div>
  )
}
