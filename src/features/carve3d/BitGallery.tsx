// Bit gallery: grouped tiles with side-profile drawings generated from the real geometry
// (radiusAtHeight up to the flutes, shank up to the overall length), plus a details card.
// Thumbnails are fitted to each bit's own length; proportions are true to the catalogue.
import { fmtLen } from '../../model/factory'
import type { Units } from '../../model/types'
import { BITS, radiusAtHeight, type Bit, type BitField, type BitGroup } from './bits'
import { reachRadius } from './carvePlan'
import { useBitLibrary } from '../bitlibrary/library'

const GROUPS: { id: BitGroup; title: string }[] = [
  { id: 'origin', title: 'Ships with Origin' },
  { id: 'flat', title: 'Flat & spiral' },
  { id: 'ball', title: 'Ball & tapered' },
  { id: 'engraving', title: 'Engraving / V' },
  { id: 'specialty', title: 'Specialty' },
]

/** Overall length used for drawing: the stated value, or a guess when Shaper does not state one. */
const drawnLength = (bit: Bit) => bit.overallLength ?? bit.fluteLength + 20

/** Half width of the widest part (cutter or shank), mm. */
const halfWidth = (bit: Bit) => Math.max(bit.diameter / 2, (bit.shankDiameter ?? bit.diameter) / 2)

/**
 * Closed side profile in mm, SVG coordinates (x right, y down, tip at y = 0). The right side
 * follows radiusAtHeight to the flute end, then the shank to the overall length; the left side
 * mirrors it.
 */
function profilePath(bit: Bit): string {
  const L = bit.fluteLength
  const O = drawnLength(bit)
  const shankR = (bit.shankDiameter ?? bit.diameter) / 2
  const N = 48
  const right: [number, number][] = []
  for (let i = 0; i <= N; i++) {
    const h = (L * i) / N
    right.push([radiusAtHeight(bit, h), -h])
  }
  right.push([shankR, -L], [shankR, -O])
  const left = right.slice().reverse().map(([x, y]) => [-x, y] as [number, number])
  // The mirrored side runs from the shank top back down to the tip.
  const pts = [...right, ...left]
  return 'M ' + pts.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join(' L ') + ' Z'
}

/** Helix strokes suggesting the flutes of a spiral bit (none for straight-flute or non-spiral bits). */
function helixStrokes(bit: Bit): string[] {
  if (!bit.spiral) return []
  const L = bit.fluteLength
  const r = radiusAtHeight(bit, L) * 0.7
  const count = (bit.flutes ?? 2) >= 3 ? 3 : 2
  const out: string[] = []
  for (let k = 0; k < count; k++) {
    const y0 = -(L * (0.1 + (0.8 * k) / count))
    const y1 = y0 - L * 0.25
    out.push(`M ${(-r).toFixed(3)} ${y0.toFixed(3)} L ${r.toFixed(3)} ${y1.toFixed(3)}`)
  }
  return out
}

/** SVG drawing of one bit (no annotations). Also used by the bit gallery for bits with no photo. */
export function BitShape({ bit, className }: { bit: Bit; className?: string }) {
  const O = drawnLength(bit)
  const W = halfWidth(bit) * 2
  const pad = W * 0.15
  return (
    <svg
      className={className ?? 'c3d-bit-svg'}
      viewBox={`${-W / 2 - pad} ${-O - pad} ${W + 2 * pad} ${O + 2 * pad}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <path d={profilePath(bit)} className="c3d-bit-shape" vectorEffect="non-scaling-stroke" />
      {helixStrokes(bit).map((d, i) => (
        <path key={i} d={d} className="c3d-flute" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  )
}

/** Large annotated drawing: the layer step line and the side offset the bit reaches at that height. */
function AnnotatedBit({ bit, step, units }: { bit: Bit; step: number; units: Units }) {
  const O = drawnLength(bit)
  const W = halfWidth(bit) * 2
  const s = Math.min(Math.max(step, 0), O)
  const rs = Math.min(reachRadius(bit, step), halfWidth(bit))
  const fs = Math.max(O * 0.05, 0.8)
  const xLeft = -W / 2 - O * 0.15
  const xRight = W / 2 + O * 0.7
  const labelX = W / 2 + O * 0.08
  return (
    <svg
      className="c3d-bit-svg c3d-bit-svg--detail"
      viewBox={`${xLeft} ${-O * 1.06} ${xRight - xLeft} ${O * 1.12}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <path d={profilePath(bit)} className="c3d-bit-shape" vectorEffect="non-scaling-stroke" />
      {helixStrokes(bit).map((d, i) => (
        <path key={i} d={d} className="c3d-flute" vectorEffect="non-scaling-stroke" />
      ))}
      <line x1={0} x2={0} y1={0} y2={-O} className="c3d-ann c3d-ann--axis" vectorEffect="non-scaling-stroke" />
      <line x1={xLeft} x2={W / 2 + O * 0.05} y1={-s} y2={-s} className="c3d-ann c3d-ann--dash" vectorEffect="non-scaling-stroke" />
      <line x1={0} x2={rs} y1={-s} y2={-s} className="c3d-ann" vectorEffect="non-scaling-stroke" />
      <circle cx={rs} cy={-s} r={O * 0.012} className="c3d-ann-dot" />
      <text x={labelX} y={-s - fs * 0.3} fontSize={fs} className="c3d-ann-text">
        step {fmtLen(step, units)}
      </text>
      <text x={labelX} y={-s + fs * 1.2} fontSize={fs} className="c3d-ann-text">
        side offset {fmtLen(rs, units)}
      </text>
    </svg>
  )
}

export interface BitGalleryProps {
  selectedId: string
  onSelect: (id: string) => void
  /** Current layer step (mm), used to annotate the detail drawing. */
  stepDown: number
  units: Units
}

/** Mark values Shaper does not state with "≈". */
function value(bit: Bit, field: BitField, text: string): string {
  return bit.inferred.includes(field) ? `≈ ${text}` : text
}

export default function BitGallery({ selectedId, onSelect, stepDown, units }: BitGalleryProps) {
  const owned = useBitLibrary((s) => s.owned)
  const bit = BITS.find((b) => b.id === selectedId) ?? BITS[0]
  const L = (mm: number) => fmtLen(mm, units)
  const inferredAny = bit.inferred.length > 0
  const side = Math.min(reachRadius(bit, stepDown), halfWidth(bit))

  const specs: [string, string][] = []
  specs.push(['Ø', value(bit, 'diameter', L(bit.diameter))])
  specs.push(['shank', value(bit, 'shankDiameter', L(bit.shankDiameter))])
  specs.push(['flute length', value(bit, 'fluteLength', L(bit.fluteLength))])
  specs.push(['overall length', bit.overallLength === null ? 'not stated by Shaper' : value(bit, 'overallLength', L(bit.overallLength))])
  if (bit.angle !== null) specs.push(['angle', value(bit, 'angle', `${bit.angle}° included`)])
  if (bit.flutes !== null) specs.push(['flutes', value(bit, 'flutes', String(bit.flutes))])
  if (bit.type === 'vbit') specs.push(['tip Ø', value(bit, 'tipDiameter', L(bit.tipDiameter ?? 0))])
  if (bit.type === 'ball' || bit.type === 'taperedball') specs.push(['tip R', value(bit, 'tipRadius', L(bit.tipRadius ?? bit.diameter / 2))])
  specs.push(['SKU', bit.sku ?? 'none (in Origin box)'])

  return (
    <div className="c3d-gallery">
      {GROUPS.map((g) => {
        // Owned bits lead their group: they are the ones this user can actually pick.
        const items = BITS.filter((b) => b.group === g.id).sort(
          (a, b) => (owned[a.id] ? 0 : 1) - (owned[b.id] ? 0 : 1),
        )
        if (!items.length) return null
        return (
          <div key={g.id} className="c3d-group">
            <div className="ss-section-title">{g.title}</div>
            <div className="c3d-tiles">
              {items.map((b) => {
                const active = b.id === bit.id
                const disabled = !b.carvable
                return (
                  <button
                    key={b.id}
                    type="button"
                    className={`c3d-tile${active ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`}
                    aria-pressed={active}
                    aria-disabled={disabled || undefined}
                    title={disabled ? 'Not suitable for top-down carving' : b.name}
                    onClick={() => {
                      if (!disabled) onSelect(b.id)
                    }}
                  >
                    <BitShape bit={b} className="c3d-tile-svg" />
                    {owned[b.id] && (
                      <span className="c3d-tile-owned" title="In your bit gallery">
                        {owned[b.id].qty > 1 ? `owned ×${owned[b.id].qty}` : 'owned'}
                      </span>
                    )}
                    <span className="c3d-tile-name">{b.name}</span>
                    <span className="c3d-tile-meta">
                      Ø {b.inferred.includes('diameter') ? '≈ ' : ''}
                      {L(b.diameter)}
                      {' · '}
                      {b.sku ?? 'in box'}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}

      <div className="ss-card c3d-detail">
        <div className="c3d-detail-head">
          <span className="c3d-detail-title">{bit.name}</span>
          <span className="ss-badge">{bit.type === 'taperedball' ? 'tapered ball' : bit.type}</span>
        </div>
        <dl className="c3d-specs">
          {specs.map(([k, v]) => (
            <div key={k} className="c3d-spec">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {!bit.carvable && <div className="c3d-warn">{bit.carveReason}</div>}
        {inferredAny && <div className="c3d-muted-note">≈ marks values inferred from the catalogue, not stated by Shaper.</div>}
        {bit.notes && <div className="c3d-muted-note">{bit.notes}</div>}
        {bit.productUrl && (
          <a className="c3d-link" href={bit.productUrl} target="_blank" rel="noopener noreferrer">
            View on shapertools.com
          </a>
        )}
        <AnnotatedBit bit={bit} step={stepDown} units={units} />
        <div className="c3d-detail-foot">
          layer step {L(stepDown)} → side offset <strong>{L(side)}</strong>
        </div>
      </div>
    </div>
  )
}
