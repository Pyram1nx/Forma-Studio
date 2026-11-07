import { useMemo } from 'react'
import { designThumb } from '../io/designThumb'
import * as Ic from './icons'
import '../styles/design-preview.css'

/**
 * A saved design's preview tile in Shaper Studio's style: the design in blue on a pale tile,
 * with a round file badge in the corner. Size and corner radius come from the parent's CSS.
 * The parent should key it on the design's save time, so the picture is rebuilt after each change.
 */
export default function DesignPreview({ id, className = '' }: { id: string; className?: string }) {
  const src = useMemo(() => designThumb(id), [id])
  return (
    <span className={'design-preview ' + className}>
      {src ? <img className="design-preview__img" src={src} alt="" /> : <Ic.IconDraw className="design-preview__empty" />}
      <span className="design-preview__badge" aria-hidden="true">
        <Ic.IconLogo />
      </span>
    </span>
  )
}
