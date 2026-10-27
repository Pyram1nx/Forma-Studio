import type { JSX } from 'react'
import { TEMPLATE_ICON_ART } from './templateIconData'

/** A template or basic-shape icon from Shaper Studio's shape grid, drawn in currentColor. */
export function TemplateIcon({ id, size = 36 }: { id: string; size?: number }): JSX.Element | null {
  const art = TEMPLATE_ICON_ART[id]
  if (!art) return null
  // Keep the icon's own aspect ratio inside a size×size box, as the Studio grid does.
  const scale = size / Math.max(art.w, art.h)
  return (
    <svg width={art.w * scale} height={art.h * scale} viewBox={art.vb} fill="none" aria-hidden="true" focusable="false">
      {art.paths.map((p, i) => (
        <path key={i} d={p.d} fill="currentColor" fillRule={p.eo ? 'evenodd' : undefined} clipRule={p.eo ? 'evenodd' : undefined} />
      ))}
    </svg>
  )
}
