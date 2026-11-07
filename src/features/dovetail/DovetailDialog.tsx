// Full-screen "Dovetails" dialog: pick a bit and two boards, see the joint in 3D, add the two
// end-grain layouts (tail board, pin board) to the design. Geometry lives in ./dovetail.
import { useMemo, useState } from 'react'
import type { ImportPayload, Units } from '../../model/types'
import { fmtLen } from '../../model/factory'
import { IconClose } from '../../ui/icons'
import { NumField, StepperParam } from '../../editor/Panels'
import { BITS, DEFAULT_BIT_ID } from '../carve3d/bits'
import { Field } from '../carve3d/fields'
import BitPhoto from '../bitlibrary/BitPhoto'
import DovetailViewer from './DovetailViewer'
import { autoTails, DEFAULT_PRESET, DOVETAIL_PRESETS, dovetailCuts, dovetailLayout, dovetailParts, DEFAULT_GLUE_GAP, maxTails, type DovetailBit, type DovetailParams } from './dovetail'
import '../carve3d/carve3d.css'
import './dovetail.css'

export interface DovetailDialogProps {
  units: Units
  onClose: () => void
  onImport: (p: ImportPayload) => void
}

const STRAIGHT_BITS = BITS.filter((b) => b.type === 'flat')

/** Side view of the dovetail bit: shank, flanks at the bit's angle, the tip at its widest. */
function BitGlyph({ bit }: { bit: DovetailBit }) {
  const t = Math.tan((Math.min(Math.max(bit.angle, 0), 40) * Math.PI) / 180)
  const h = 26
  const half = 13
  const top = Math.max(4, half - h * t)
  const cx = 30
  return (
    <svg className="dt-bit" viewBox="0 0 60 64" aria-hidden="true">
      <rect x={cx - 4} y={2} width={8} height={24} rx={1.5} className="dt-bit__shank" />
      <path d={`M${cx - top} 28 L${cx + top} 28 L${cx + half} ${28 + h} L${cx - half} ${28 + h} Z`} className="dt-bit__cutter" />
    </svg>
  )
}

/** End-grain layout thumbnail: the board, its cuts and the run-outs past the faces. */
function LayoutCard({ title, sub, which, params }: { title: string; sub: string; which: 'tail' | 'pin'; params: DovetailParams }) {
  const c = useMemo(() => dovetailCuts(params), [params])
  const board = which === 'tail' ? c.tail.board : c.pin.board
  const cuts = which === 'tail' ? c.tail.sockets : c.pin.pockets
  const pts = [...board.pts, ...cuts.flatMap((k) => k.pts)]
  const pad = 4
  const minX = Math.min(...pts.map((p) => p.x)) - pad
  const maxX = Math.max(...pts.map((p) => p.x)) + pad
  const minY = Math.min(...pts.map((p) => p.y)) - pad
  const maxY = Math.max(...pts.map((p) => p.y)) + pad
  const d = (k: { pts: { x: number; y: number }[]; closed: boolean }) => 'M' + k.pts.map((p) => `${p.x} ${p.y}`).join('L') + (k.closed ? 'Z' : '')
  const band = which === 'tail' && c.tail.online ? params.bit.diameter : 0
  return (
    <div className="dt-card">
      <div className="dt-card__head">
        <span className="dt-card__title">{title}</span>
        <span className="ss-muted">{sub}</span>
      </div>
      <svg viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} preserveAspectRatio="xMidYMid meet" className="dt-card__svg">
        <path d={d(board)} className="dt-svg__board" vectorEffect="non-scaling-stroke" />
        {cuts.map((k, i) =>
          band ? (
            <g key={i}>
              <path d={d(k)} className="dt-svg__band" strokeWidth={band} />
              <path d={d(k)} className="dt-svg__line" vectorEffect="non-scaling-stroke" />
            </g>
          ) : (
            <path key={i} d={d(k)} className="dt-svg__pocket" vectorEffect="non-scaling-stroke" />
          ),
        )}
      </svg>
    </div>
  )
}

export default function DovetailDialog({ units, onClose, onImport }: DovetailDialogProps) {
  const inch = units === 'in'
  const [presetId, setPresetId] = useState<string>(DEFAULT_PRESET.id)
  const [bit, setBit] = useState<DovetailBit>(DEFAULT_PRESET.bit)
  const [width, setWidth] = useState(inch ? 152.4 : 150)
  const [tailThick, setTailThick] = useState(inch ? 12.7 : 12)
  const [pinThick, setPinThick] = useState(inch ? 12.7 : 12)
  /** null = follow the board width. */
  const [tailsSet, setTailsSet] = useState<number | null>(null)
  /** null = the bit diameter (one pass per pin). */
  const [pinSet, setPinSet] = useState<number | null>(null)
  const [straightId, setStraightId] = useState(DEFAULT_BIT_ID)
  const [glueGap, setGlueGap] = useState<number>(DEFAULT_GLUE_GAP[units])
  const [apart, setApart] = useState(false)

  const preset = DOVETAIL_PRESETS.find((p) => p.id === presetId)
  /** The catalogue bit behind the preset: its gallery photo stands in for the drawn bit. */
  const catalogBit = preset?.bitId ? BITS.find((b) => b.id === preset.bitId) : undefined
  const straight = STRAIGHT_BITS.find((b) => b.id === straightId) ?? STRAIGHT_BITS[0]
  const pinWidth = Math.max(bit.diameter, pinSet ?? bit.diameter)
  const limit = maxTails({ width, pinWidth, straightBit: straight.diameter, glueGap })
  const tails = Math.min(limit, tailsSet ?? autoTails(width, pinWidth))

  const params: DovetailParams = useMemo(
    () => ({ bit, width, tailThick, pinThick, tails, pinWidth, straightBit: straight.diameter, glueGap }),
    [bit, width, tailThick, pinThick, tails, pinWidth, straight.diameter, glueGap],
  )
  const layout = useMemo(() => dovetailLayout(params), [params])
  const L = (mm: number) => fmtLen(mm, units)

  const setBitField = (patch: Partial<DovetailBit>) => {
    setBit((b) => ({ ...b, ...patch }))
    setPresetId('custom')
  }
  const pos = (set: (v: number) => void, min = 0.5) => (v: number) => v > 0 && set(Math.max(min, v))

  function add() {
    const parts = dovetailParts(params, preset?.bitId)
    const name = `Dovetails – ${tails} tail${tails === 1 ? '' : 's'}, ${+bit.angle.toFixed(2)}°`
    onImport({
      parts: [
        {
          group: {
            name: `${name} · tail board`,
            info: {
              bit: preset?.name ?? `Custom ${+bit.angle.toFixed(2)}° · Ø${+bit.diameter.toFixed(2)} mm`,
              'tail sockets depth': L(pinThick),
            },
            anchor: parts.tail.anchor,
          },
          shapes: parts.tail.shapes,
        },
        {
          group: {
            name: `${name} · pin board`,
            info: {
              'pin pockets depth': L(tailThick),
              'straight bit': straight.name,
              'glue gap': L(glueGap),
            },
            anchor: parts.pin.anchor,
          },
          shapes: parts.pin.shapes,
        },
      ],
    })
    onClose()
  }

  return (
    <div className="ss-dialog c3d-dialog dt-dialog" role="dialog" aria-label="Dovetails">
      <div className="ss-dialog__header">
        <h1 className="ss-dialog__title">Dovetails</h1>
      </div>

      <div className="ss-dialog__body">
        <div className="ss-dialog__main">
          <DovetailViewer params={params} apart={apart} />
          <div className="c3d-overlay">
            <div className="ss-seg c3d-viewtoggle" role="group" aria-label="3D view">
              <button type="button" aria-pressed={!apart} onClick={() => setApart(false)}>
                Joined
              </button>
              <button type="button" aria-pressed={apart} onClick={() => setApart(true)}>
                Apart
              </button>
            </div>
            <span className="ss-muted">
              {tails} tail{tails === 1 ? '' : 's'} · {+bit.angle.toFixed(2)}° · {L(width)} wide
            </span>
          </div>
          <div className="dt-cards">
            <LayoutCard title="Tail board" sub={`dovetail bit · ${L(pinThick)} deep`} which="tail" params={params} />
            <LayoutCard title="Pin board" sub={`straight bit · ${L(tailThick)} deep`} which="pin" params={params} />
          </div>
        </div>

        <aside className="ss-dialog__side c3d-side">
          <div className="c3d-section">
            <div className="ss-section-title">dovetail bit</div>
            <div className="dt-bitrow">
              {catalogBit ? (
                <span className="dt-photo" title={catalogBit.name}>
                  <BitPhoto bit={catalogBit} className="dt-photo__img" />
                </span>
              ) : (
                <BitGlyph bit={bit} />
              )}
              <div className="dt-bitrow__fields">
                <select
                  className="ss-select"
                  aria-label="Bit preset"
                  value={presetId}
                  onChange={(e) => {
                    const p = DOVETAIL_PRESETS.find((x) => x.id === e.target.value)
                    setPresetId(e.target.value)
                    if (p) setBit(p.bit)
                  }}
                >
                  {DOVETAIL_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  <option value="custom">Custom bit</option>
                </select>
                <div className="c3d-two">
                  <NumField label="Bit angle" adorn="∠" kind="angle" units={units} value={bit.angle} onCommit={(v) => v > 0 && v < 45 && setBitField({ angle: v })} />
                  <NumField label="Bit diameter" adorn="Ø" units={units} value={bit.diameter} onCommit={pos((v) => setBitField({ diameter: v }), 2)} />
                </div>
              </div>
            </div>
            <Field label="cutting length">
              <NumField label="Cutting length" units={units} value={bit.fluteLength} onCommit={pos((v) => setBitField({ fluteLength: v }), 1)} />
            </Field>
          </div>

          <div className="c3d-section">
            <div className="ss-section-title">boards</div>
            <Field label="width">
              <NumField label="Board width" adorn="W" units={units} value={width} onCommit={pos(setWidth, 10)} />
            </Field>
            <div className="c3d-two">
              <Field label="tail board">
                <NumField label="Tail board thickness" adorn="T" units={units} value={tailThick} onCommit={pos(setTailThick, 1)} />
              </Field>
              <Field label="pin board">
                <NumField label="Pin board thickness" adorn="T" units={units} value={pinThick} onCommit={pos(setPinThick, 1)} />
              </Field>
            </div>
          </div>

          <div className="c3d-section">
            <div className="ss-section-title">layout</div>
            <Field label="tails">
              <StepperParam label="Tails" value={tails} min={1} max={limit} onCommit={(v) => setTailsSet(v)} />
            </Field>
            <Field label="pin width (at least the bit diameter)">
              <NumField label="Pin width" units={units} value={pinWidth} onCommit={(v) => v > 0 && setPinSet(Math.max(bit.diameter, v))} />
            </Field>
            <span className="c3d-muted-note">
              Tails {L(layout.tailNarrow)} → {L(layout.tailWide)} · pins {L(Math.max(0, layout.pinNarrow))} → {L(pinWidth)}
              {(tailsSet != null || pinSet != null) && (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="dt-link"
                    onClick={() => {
                      setTailsSet(null)
                      setPinSet(null)
                    }}
                  >
                    auto
                  </button>
                </>
              )}
            </span>
          </div>

          <div className="c3d-section">
            <div className="ss-section-title">pin board</div>
            <Field label="straight bit">
              <select className="ss-select" aria-label="Straight bit" value={straight.id} onChange={(e) => setStraightId(e.target.value)}>
                {STRAIGHT_BITS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="glue gap (per side)">
              <NumField label="Glue gap" adorn="G" units={units} value={glueGap} onCommit={(v) => v >= 0 && setGlueGap(Math.min(v, 2))} />
            </Field>
          </div>

          {layout.warnings.length > 0 && (
            <div className="c3d-section">
              {layout.warnings.map((w) => (
                <div key={w} className="c3d-warn">
                  {w}
                </div>
              ))}
            </div>
          )}

          <div className="c3d-muted-note">
            Cut both layouts on the end grain with the board clamped upright. The dovetail bit cuts each socket in one full-depth pass and cannot plunge, so start every pass off the board.
          </div>
        </aside>
      </div>

      <div className="ss-dialog__footer">
        <button type="button" className="ss-btn ss-btn--primary" disabled={layout.tailNarrow <= 0 || layout.pinNarrow <= 0} onClick={add}>
          Add to Design
        </button>
        <button type="button" className="ss-btn-round" onClick={onClose} aria-label="Cancel">
          <IconClose />
        </button>
      </div>
    </div>
  )
}
