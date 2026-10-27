// Memoised per-shape SVG for Design, Plan and Review. Shapes are immutable, so
// props are primitives plus cached geometry; hover changes only re-render the
// shapes whose flags actually changed.
import { memo } from 'react'
import type { Shape } from '../../model/types'
import { worldD } from '../geomCache'
import { depthLevel, REVIEW_SHADOW_DY, type CutGeometry } from './canvasMath'

export const DesignShape = memo(function DesignShape({ s, selected, hovered }: { s: Shape; selected: boolean; hovered: boolean }) {
  if (s.locked) {
    // Studio's Reference path: an amber outline with no fill, plus a soft halo when hovered or selected.
    const d = worldD(s)
    const cls = 'cv-ref' + (selected ? ' is-selected' : '') + (hovered ? ' is-hover' : '')
    return (
      <g className={cls}>
        <path d={d} className="cv-ref__halo" fill="none" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        <path d={d} className="cv-ref__path" fill="none" vectorEffect="non-scaling-stroke" />
      </g>
    )
  }
  const closed = s.contours.some((c) => c.closed)
  // Stacked 3D slice layers would fill to an opaque block, so draw them as outlines.
  const outlineOnly = !closed || s.meta?.source === '3d'
  const cls = 'cv-shape' + (selected ? ' is-selected' : '') + (hovered ? ' is-hover' : '')
  return <path d={worldD(s)} fillRule="evenodd" className={cls} fill={outlineOnly ? 'none' : undefined} vectorEffect="non-scaling-stroke" />
})

const CUT_CLASS: Record<string, string> = {
  outside: '',
  inside: ' pl-cut--cw',
  online: ' pl-cut--black',
  pocket: '',
}

/**
 * Plan: base path, then (when the band is wanted and ready) the tool band, the
 * pocket pattern, and the marching cut path. `showCut` is selected || hovered ||
 * Cut Path Display.
 */
export const PlanShape = memo(function PlanShape({
  s,
  selected,
  hovered,
  showCut,
  geom,
}: {
  s: Shape
  selected: boolean
  hovered: boolean
  showCut: boolean
  geom: CutGeometry | undefined
}) {
  // Style from the effective type (what the geometry was built for), so a stored
  // type that the shape can't use (e.g. an inside cut on an open path) renders consistently.
  const t = geom?.type ?? s.cut.type
  const pocket = t === 'pocket'
  const cls = 'pl-shape' + (selected ? ' is-selected' : '') + (hovered ? ' is-hover' : '') + (pocket ? ' is-pocket' : '') + (t === 'guide' ? ' is-guide' : '')
  // A guide has no cut path, so it gets no tool band; everything else draws like any other shape.
  const band = t !== 'guide' && showCut && geom
  return (
    <g className={cls}>
      {band && pocket && geom.sweptD && (
        <>
          <path d={geom.sweptD} className="pl-pocket" fillRule="evenodd" vectorEffect="non-scaling-stroke" />
          <path d={geom.sweptD} className="pl-pocket-ticks" fillRule="evenodd" />
        </>
      )}
      {band && !pocket && geom.centreD && (
        <path d={geom.centreD} className="pl-band" fill="none" strokeWidth={s.cut.bitDia} strokeLinecap="round" strokeLinejoin="round" />
      )}
      <path d={worldD(s)} className="pl-base" fillRule="evenodd" vectorEffect="non-scaling-stroke" />
      {band && !pocket && geom.centreD && (
        <path d={geom.centreD} className={'pl-cut' + (CUT_CLASS[t] ?? '')} fill="none" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      )}
    </g>
  )
})

/**
 * Review: the swept material filled with the depth-level class, then an inner
 * shadow layer shifted down and clipped to the swept area. Callers draw shallow
 * cuts first so deeper ones sit on top.
 */
export const ReviewShape = memo(function ReviewShape({ s, geom, zoom }: { s: Shape; geom: CutGeometry | undefined; zoom: number }) {
  if (!geom || !geom.sweptD || geom.type === 'guide') return null
  const level = depthLevel(s.cut.depth)
  const clipId = 'rv-clip-' + s.id
  const dy = REVIEW_SHADOW_DY[level] / zoom
  return (
    <g>
      <clipPath id={clipId}>
        <path d={geom.sweptD} clipRule="evenodd" />
      </clipPath>
      <path d={geom.sweptD} className={'rv-depth-' + level} fillRule="evenodd" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      <g clipPath={`url(#${clipId})`}>
        <path
          d={geom.sweptD}
          className={'rv-shadow-' + level}
          fillRule="evenodd"
          transform={`translate(${0.1 / zoom} ${dy})`}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </g>
    </g>
  )
})
