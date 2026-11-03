// Custom Radius: the selected rectangle or polygon is shown large, its corners are picked one at a
// time and each picked corner takes its own fillet radius. Apply writes the radii; Close discards them.
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../state/store'
import type { Pt, Shape } from '../model/types'
import { MM_PER_IN } from '../model/types'
import * as Ic from '../ui/icons'
import { NumField } from './Panels'
import ModeCanvas from './ModeCanvas'
import { world } from './geomCache'
import { contoursToD } from '../geometry/svgPath'
import { bboxOfContours } from '../geometry/transform'
import { filletPolygon, formatRadii, maxFillet } from '../geometry/fillet'
import { buildFromParams } from './shapeFactory'
import { isMixed, radiusValues, VERTEX_KINDS, vertexCount, VIEW_RADIUS_PRESETS, presetLabel } from './radius'

/** Shape-to-world transform, applied to the sharp and the rounded outline alike. */
function toWorld(shape: Shape, pts: Pt[]): Pt[] {
  return world({ ...shape, contours: [{ closed: true, pts }] })[0].pts
}

export default function RadiusMode() {
  const open = useStore((s) => s.dialog === 'radius')
  const shape = useStore((s) => (s.selection.length === 1 ? s.doc.shapes.find((x) => x.id === s.selection[0]) : undefined))
  if (!open || !shape || !VERTEX_KINDS.includes(shape.kind)) return null
  return <RadiusView key={shape.id} shape={shape} />
}

function RadiusView({ shape }: { shape: Shape }) {
  const units = useStore((s) => s.doc.units)
  const n = vertexCount(shape)
  // The corners before any fillet, in the shape's own coordinates.
  const sharp = useMemo<Pt[]>(() => {
    const flat: Record<string, number | string | boolean> = { ...shape.params!, r: 0 }
    delete flat.cr
    return buildFromParams(shape.kind, flat)?.[0].pts ?? []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape.id, shape.kind, shape.params])
  const [draft, setDraft] = useState<number[]>(() => radiusValues(shape))
  const [picked, setPicked] = useState<boolean[]>(() => new Array<boolean>(n).fill(false))

  const sharpW = useMemo(() => toWorld(shape, sharp), [shape, sharp])
  const roundedW = useMemo(() => toWorld(shape, filletPolygon(sharp, draft)), [shape, sharp, draft])
  const bounds = useMemo(() => {
    const b = bboxOfContours([{ closed: true, pts: sharpW }])
    const pad = MM_PER_IN / 2
    return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad }
  }, [sharpW])
  const handleR = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.012

  const close = () => useStore.getState().openDialog(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape belongs to a focused field first (it cancels that edit).
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const selected = picked.flatMap((p, i) => (p ? [i] : []))
  const selVals = selected.map((i) => draft[i])
  const mixed = isMixed(selVals)
  const fieldValue = selected.length && !mixed ? selVals[0] : null
  const placeholder = !selected.length ? 'select point' : mixed ? 'mixed' : undefined

  const toggle = (i: number) => setPicked((p) => p.map((v, k) => (k === i ? !v : v)))
  const setAll = (on: boolean) => setPicked(new Array<boolean>(n).fill(on))
  // Typed or preset radii go to the picked corners only, each capped at what that corner can take.
  const setRadiusOnPicked = (mm: number) =>
    setDraft((d) => d.map((v, i) => (picked[i] ? Math.min(Math.max(0, mm), maxFillet(sharp, i)) : v)))

  const apply = () => {
    useStore.getState().updateShapes([shape.id], (s) => {
      const params = { ...s.params!, cr: formatRadii(draft) }
      const contours = buildFromParams(s.kind, params)
      return contours ? { ...s, params, contours } : s
    })
    close()
  }

  return (
    <div className="modeview" role="dialog" aria-label="Custom Radius">
      <ModeCanvas bounds={bounds}>
        {(tapOk) => (
          <>
            <path d={contoursToD([{ closed: true, pts: sharpW }])} fillRule="evenodd" vectorEffect="non-scaling-stroke" className="modeview__shape" />
            <path d={contoursToD([{ closed: true, pts: roundedW }])} fillRule="evenodd" vectorEffect="non-scaling-stroke" className="modeview__result" />
            {sharpW.map((p, i) => (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r={handleR}
                vectorEffect="non-scaling-stroke"
                className={'modeview__handle' + (picked[i] ? ' is-picked' : '')}
                onClick={() => tapOk() && toggle(i)}
              />
            ))}
          </>
        )}
      </ModeCanvas>

      <aside className="modeview__panel">
        <button type="button" className="modeview__close" aria-label="Close Custom Radius" onClick={close}>
          <Ic.IconClose size={18} />
        </button>
        <div className="modeview__title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
            <path d="M5 20v-6a9 9 0 0 1 9-9h6" />
          </svg>
          Custom Radius
        </div>
        <p className="modeview__hint">Select any corner(s) and enter the desired fillet radius</p>
        <div className="modeview__label">Select</div>
        <div className="modeview__presets">
          <button type="button" className={'modeview__pill' + (selected.length === n ? ' is-active' : '')} style={{ flex: 1 }} onClick={() => setAll(true)}>
            All
          </button>
          <button type="button" className={'modeview__pill' + (selected.length === 0 ? ' is-active' : '')} style={{ flex: 1 }} onClick={() => setAll(false)}>
            None
          </button>
        </div>
        <div className="modeview__label" style={{ marginTop: 12 }}>
          Radius
        </div>
        <div className="modeview__dist">
          <NumField
            label="Custom radius"
            adorn="R"
            value={fieldValue}
            placeholder={placeholder}
            units={units}
            onCommit={(v) => {
              if (selected.length) setRadiusOnPicked(v)
            }}
          />
        </div>
        <div className="modeview__presets">
          {VIEW_RADIUS_PRESETS.map((p) => (
            <button key={p.label} type="button" className="modeview__preset" disabled={!selected.length} onClick={() => setRadiusOnPicked(p.inches * MM_PER_IN)}>
              {presetLabel(p, units)}
            </button>
          ))}
        </div>
        <div className="modeview__spacer" />
        <button type="button" className="modeview__finish" onClick={apply}>
          Apply Changes
        </button>
      </aside>
    </div>
  )
}
