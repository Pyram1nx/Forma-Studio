// Full-screen "Joinery" dialog: pick a joint (dovetail, fine-pin dovetail, Knapp), set the boards,
// see the corner in 3D and add both boards' layouts to the design. Every number has a sensible
// automatic value; overriding one shows a reset. Geometry lives in ./joints (and ./dovetail).
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ImportPayload, Units } from '../../model/types'
import { fmtLen } from '../../model/factory'
import { IconClose } from '../../ui/icons'
import { NumField, StepperParam } from '../../editor/Panels'
import { BITS, DEFAULT_BIT_ID } from '../carve3d/bits'
import BitPhoto from '../bitlibrary/BitPhoto'
import JointViewer from './JointViewer'
import { autoTails, DEFAULT_PRESET, DOVETAIL_PRESETS, dovetailLayout, DEFAULT_GLUE_GAP, maxTails, type DovetailBit, type DovetailParams } from './dovetail'
import {
  angleToSlope,
  CUSTOM_BIT,
  DEFAULT_FIT,
  dovetailJoint,
  finePinJoint,
  jointParts,
  knappJoint,
  pickBit,
  resolveFinePin,
  resolveKnapp,
  STRAIGHT_BITS,
  type BitChoice,
  type BoardLayout,
  type FinePinDraft,
  type Fit,
  type JointKind,
  type JointModel,
  type KnappDraft,
} from './joints'
import { clearJoineryStart, readJoineryStart, type JointLayout } from './joineryStart'
import '../carve3d/carve3d.css'
import './dovetail.css'

export interface DovetailDialogProps {
  units: Units
  onClose: () => void
  onImport: (p: ImportPayload) => void
}

const STORE = 'formastudio:joinery-v2'

const KINDS: { id: JointKind; name: string; blurb: string }[] = [
  { id: 'dovetail', name: 'Dovetail', blurb: 'Classic through dovetails, cut with a dovetail bit on the end grain.' },
  { id: 'finepin', name: 'Fine pin', blurb: 'Through dovetails with pins as fine as your smallest straight bit. No dovetail bit needed.' },
  { id: 'knapp', name: 'Knapp', blurb: 'The pin-and-cove drawer joint: dowels on the front, half-round coves on the side.' },
]

// ---------------------------------------------------------------------------------------------
// Defaults and saved state

function defaultFinePin(units: Units): FinePinDraft {
  const inch = units === 'in'
  return {
    width: inch ? 152.4 : 150,
    tailThick: inch ? 12.7 : 12,
    pinThick: inch ? 12.7 : 12,
    pins: null,
    pinWidth: null,
    slope: 6,
    edgePin: null,
    tailBit: { id: CUSTOM_BIT, custom: inch ? { diameter: 1.5875, cutLength: 12.7 } : { diameter: 2, cutLength: 15 } },
    pinBit: pickBit(6.35, 14),
    fit: { ...DEFAULT_FIT[units] },
  }
}

function defaultKnapp(units: Units): KnappDraft {
  const inch = units === 'in'
  return {
    width: inch ? 101.6 : 100,
    sideThick: inch ? 12.7 : 12,
    frontThick: inch ? 19.05 : 19,
    pins: null,
    dowel: null,
    dowelLength: 0,
    cove: null,
    style: 'cove',
    margin: null,
    dowelPos: null,
    hidden: false,
    skin: inch ? 3.175 : 3,
    sideBit: pickBit(3.175, 12.7),
    frontBit: pickBit(4, 14),
    fit: { ...DEFAULT_FIT[units] },
  }
}

interface Saved {
  kind?: JointKind
  finepin?: FinePinDraft
  knapp?: KnappDraft
  units?: Units
}

function loadSaved(units: Units): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Saved
    // A design in other units starts from that unit's round numbers.
    return s.units === units ? s : { kind: s.kind }
  } catch {
    return {}
  }
}

/** Joints-page layouts that pick a joint kind. */
const START_KIND: Partial<Record<JointLayout, JointKind>> = { 'fine-pin': 'finepin', knapp: 'knapp' }

// ---------------------------------------------------------------------------------------------
// Small pieces

function KindGlyph({ kind }: { kind: JointKind }) {
  if (kind === 'knapp')
    return (
      <svg viewBox="0 0 48 32" className="jt-kind__glyph" aria-hidden="true">
        <path d="M2 4H46V14H40A6 6 0 0 0 28 14H20A6 6 0 0 0 8 14H2Z" className="jt-g-pin" />
        <path d="M2 14H8A6 6 0 0 1 20 14H28A6 6 0 0 1 40 14H46V30H2Z" className="jt-g-tail" />
        <circle cx="14" cy="14" r="2.6" className="jt-g-pin" />
        <circle cx="34" cy="14" r="2.6" className="jt-g-pin" />
      </svg>
    )
  const fine = kind === 'finepin'
  const pins = fine ? [4, 15, 26, 37] : [4, 24]
  const wN = fine ? 1.6 : 4
  const wW = fine ? 4 : 8
  return (
    <svg viewBox="0 0 48 32" className="jt-kind__glyph" aria-hidden="true">
      <rect x="2" y="4" width="44" height="26" className="jt-g-tail" />
      {[0, ...pins.map((x) => x + (fine ? 5.5 : 10)), 46].map((cx, i) => (
        <path key={i} d={`M${cx - wN} 4H${cx + wN}L${cx + wW} 18H${cx - wW}Z`} className="jt-g-pin" />
      ))}
      <rect x="2" y="2" width="44" height="2" className="jt-g-pin" />
    </svg>
  )
}

function Step({ n, title, children, aside }: { n: number; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="c3d-section jt-step">
      <div className="jt-step__head">
        <span className="jt-step__num">{n}</span>
        <span className="jt-step__title">{title}</span>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** A labelled field whose value is automatic until set; set values show a reset. */
function Auto({ label, auto, onReset, children }: { label: string; auto: boolean; onReset: () => void; children: ReactNode }) {
  return (
    <div className="ss-field">
      <span className="ss-label jt-label">
        {label}
        {auto ? (
          <span className="jt-auto" title="Worked out for you. Type a value to set your own.">
            auto
          </span>
        ) : (
          <button type="button" className="jt-reset" onClick={onReset} title="Back to the automatic value">
            ↺ auto
          </button>
        )}
      </span>
      {children}
    </div>
  )
}

function Plain({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ss-field">
      <span className="ss-label">{label}</span>
      {children}
    </div>
  )
}

function Seg<T extends string | number>({ label, value, options, onChange }: { label: string; value: T | null; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="ss-seg jt-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.v)} type="button" aria-pressed={value === o.v} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function BitSelect({ label, choice, units, onChange }: { label: string; choice: BitChoice; units: Units; onChange: (c: BitChoice) => void }) {
  const custom = choice.id === CUSTOM_BIT
  return (
    <Plain label={label}>
      <select className="ss-select" aria-label={label} value={choice.id} onChange={(e) => onChange({ ...choice, id: e.target.value })}>
        {STRAIGHT_BITS.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
        <option value={CUSTOM_BIT}>Other bit (2 mm, 1/16″…)</option>
      </select>
      {custom && (
        <div className="c3d-two">
          <NumField label={`${label} diameter`} adorn="Ø" units={units} value={choice.custom.diameter} onCommit={(v) => v > 0.2 && onChange({ ...choice, custom: { ...choice.custom, diameter: v } })} />
          <NumField label={`${label} cutting length`} adorn="↧" units={units} value={choice.custom.cutLength} onCommit={(v) => v > 0.5 && onChange({ ...choice, custom: { ...choice.custom, cutLength: v } })} />
        </div>
      )}
    </Plain>
  )
}

function FitFields({ fit, units, onChange, cornerLabels }: { fit: Fit; units: Units; onChange: (f: Fit) => void; cornerLabels: [string, string] }) {
  return (
    <details className="jt-more">
      <summary>Fine-tune the fit</summary>
      <div className="jt-more__body">
        <div className="c3d-two">
          <Plain label="glue gap (per side)">
            <NumField label="Glue gap" adorn="G" units={units} value={fit.gap} onCommit={(v) => v >= 0 && onChange({ ...fit, gap: Math.min(v, 1) })} />
          </Plain>
          <Plain label="leave proud">
            <NumField label="Leave proud" adorn="+" units={units} value={fit.proud} onCommit={(v) => v >= 0 && onChange({ ...fit, proud: Math.min(v, 3) })} />
          </Plain>
        </div>
        <Plain label="inside corners">
          <Seg
            label="Inside corners"
            value={fit.corners}
            options={[
              { v: 'round', label: cornerLabels[0] },
              { v: 'chisel', label: cornerLabels[1] },
            ]}
            onChange={(v) => onChange({ ...fit, corners: v })}
          />
        </Plain>
        <span className="c3d-muted-note">
          {fit.corners === 'round'
            ? 'No hand work: the mating board is cut round to match the corners the bit leaves.'
            : 'Crisp traditional look: square the corners with a chisel after cutting.'}
        </span>
      </div>
    </details>
  )
}

/** One board's layout as a thumbnail; click to enlarge. */
function LayoutCard({ layout, big, onToggle }: { layout: BoardLayout; big: boolean; onToggle: () => void }) {
  const pts = [...layout.guide.pts, ...layout.cuts.flatMap((k) => k.contours.flatMap((c) => c.pts))]
  const pad = 3
  const minX = Math.min(...pts.map((p) => p.x)) - pad
  const maxX = Math.max(...pts.map((p) => p.x)) + pad
  const minY = Math.min(...pts.map((p) => p.y)) - pad
  const maxY = Math.max(...pts.map((p) => p.y)) + pad
  const d = (cs: { pts: { x: number; y: number }[]; closed: boolean }[]) => cs.map((k) => 'M' + k.pts.map((p) => `${+p.x.toFixed(3)} ${+p.y.toFixed(3)}`).join('L') + (k.closed ? 'Z' : '')).join('')
  return (
    <button type="button" className={`dt-card${big ? ' dt-card--big' : ''}`} onClick={onToggle} aria-label={`${layout.title} layout${big ? ', click to shrink' : ', click to enlarge'}`}>
      <span className="dt-card__head">
        <span className="dt-card__title">{layout.title}</span>
        <span className="ss-muted">{layout.sub}</span>
      </span>
      <svg viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} preserveAspectRatio="xMidYMid meet" className="dt-card__svg">
        <path d={d([layout.guide])} className="dt-svg__board" vectorEffect="non-scaling-stroke" />
        {layout.cuts.map((k, i) =>
          k.type === 'online' ? (
            <g key={i}>
              <path d={d(k.contours)} className="dt-svg__band" strokeWidth={k.bitDia} />
              <path d={d(k.contours)} className="dt-svg__line" vectorEffect="non-scaling-stroke" />
            </g>
          ) : (
            <path key={i} d={d(k.contours)} className="dt-svg__pocket" fillRule="evenodd" vectorEffect="non-scaling-stroke" />
          ),
        )}
      </svg>
    </button>
  )
}

// ---------------------------------------------------------------------------------------------
// The original dovetail-bit joint's controls

const STRAIGHT_FOR_DOVETAIL = BITS.filter((b) => b.type === 'flat')

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

function useDovetailBit(units: Units, start: JointLayout | null, L: (mm: number) => string) {
  const inch = units === 'in'
  const [presetId, setPresetId] = useState<string>(DEFAULT_PRESET.id)
  const [bit, setBit] = useState<DovetailBit>(DEFAULT_PRESET.bit)
  const [width, setWidth] = useState(inch ? 152.4 : 150)
  const [tailThick, setTailThick] = useState(inch ? 12.7 : 12)
  const [pinThick, setPinThick] = useState(inch ? 12.7 : 12)
  /** null = follow the board width. Infinity = as many as fit. */
  const [tailsSet, setTailsSet] = useState<number | null>(() => (start === 'single' ? 1 : start === 'fine' ? Infinity : null))
  /** null = the bit diameter (one pass per pin). */
  const [pinSet, setPinSet] = useState<number | null>(() => (start === 'wide-pins' ? 2 * DEFAULT_PRESET.bit.diameter : null))
  const [straightId, setStraightId] = useState(DEFAULT_BIT_ID)
  const [glueGap, setGlueGap] = useState<number>(DEFAULT_GLUE_GAP[units])

  const preset = DOVETAIL_PRESETS.find((p) => p.id === presetId)
  const catalogBit = preset?.bitId ? BITS.find((b) => b.id === preset.bitId) : undefined
  const straight = STRAIGHT_FOR_DOVETAIL.find((b) => b.id === straightId) ?? STRAIGHT_FOR_DOVETAIL[0]
  const pinWidth = Math.max(bit.diameter, pinSet ?? bit.diameter)
  const limit = maxTails({ width, pinWidth, straightBit: straight.diameter, glueGap })
  const tails = Math.min(limit, tailsSet ?? autoTails(width, pinWidth))
  const params: DovetailParams = useMemo(
    () => ({ bit, width, tailThick, pinThick, tails, pinWidth, straightBit: straight.diameter, glueGap }),
    [bit, width, tailThick, pinThick, tails, pinWidth, straight.diameter, glueGap],
  )
  const layout = useMemo(() => dovetailLayout(params), [params])
  const model = useMemo(
    () => dovetailJoint(params, preset?.name ?? `Custom ${+bit.angle.toFixed(2)}° · Ø${+bit.diameter.toFixed(2)} mm`, preset?.bitId, L),
    [params, preset, bit, L],
  )
  const setBitField = (patch: Partial<DovetailBit>) => {
    setBit((b) => ({ ...b, ...patch }))
    setPresetId('custom')
  }
  const pos = (set: (v: number) => void, min = 0.5) => (v: number) => v > 0 && set(Math.max(min, v))

  const panel = (
    <>
      <Step n={1} title="Boards">
        <Plain label="width">
          <NumField label="Board width" adorn="W" units={units} value={width} onCommit={pos(setWidth, 10)} />
        </Plain>
        <div className="c3d-two">
          <Plain label="tail board">
            <NumField label="Tail board thickness" adorn="T" units={units} value={tailThick} onCommit={pos(setTailThick, 1)} />
          </Plain>
          <Plain label="pin board">
            <NumField label="Pin board thickness" adorn="T" units={units} value={pinThick} onCommit={pos(setPinThick, 1)} />
          </Plain>
        </div>
      </Step>

      <Step n={2} title="Layout">
        <Auto label="tails" auto={tailsSet == null} onReset={() => setTailsSet(null)}>
          <StepperParam label="Tails" value={tails} min={1} max={limit} onCommit={(v) => setTailsSet(v)} />
        </Auto>
        <Auto label="pin width (at least the bit)" auto={pinSet == null} onReset={() => setPinSet(null)}>
          <NumField label="Pin width" units={units} value={pinWidth} onCommit={(v) => v > 0 && setPinSet(Math.max(bit.diameter, v))} />
        </Auto>
        <span className="c3d-muted-note">
          Tails {L(layout.tailNarrow)} → {L(layout.tailWide)} · pins {L(Math.max(0, layout.pinNarrow))} → {L(pinWidth)}
        </span>
      </Step>

      <Step n={3} title="Bits">
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
              aria-label="Dovetail bit"
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
              <option value="custom">Custom dovetail bit</option>
            </select>
            <div className="c3d-two">
              <NumField label="Bit angle" adorn="∠" kind="angle" units={units} value={bit.angle} onCommit={(v) => v > 0 && v < 45 && setBitField({ angle: v })} />
              <NumField label="Bit diameter" adorn="Ø" units={units} value={bit.diameter} onCommit={pos((v) => setBitField({ diameter: v }), 2)} />
            </div>
          </div>
        </div>
        <Plain label="dovetail bit cutting length">
          <NumField label="Cutting length" units={units} value={bit.fluteLength} onCommit={pos((v) => setBitField({ fluteLength: v }), 1)} />
        </Plain>
        <Plain label="pin board bit">
          <select className="ss-select" aria-label="Straight bit" value={straight.id} onChange={(e) => setStraightId(e.target.value)}>
            {STRAIGHT_FOR_DOVETAIL.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Plain>
        <details className="jt-more">
          <summary>Fine-tune the fit</summary>
          <div className="jt-more__body">
            <Plain label="glue gap (per side)">
              <NumField label="Glue gap" adorn="G" units={units} value={glueGap} onCommit={(v) => v >= 0 && setGlueGap(Math.min(v, 2))} />
            </Plain>
          </div>
        </details>
      </Step>
    </>
  )
  return { model, panel }
}

// ---------------------------------------------------------------------------------------------
// The dialog

export default function DovetailDialog({ units, onClose, onImport }: DovetailDialogProps) {
  const L = useMemo(() => (mm: number) => fmtLen(mm, units), [units])
  /** A layout picked on the account's Joints page (./joineryStart); null = last session's joint. */
  const [start] = useState(readJoineryStart)
  useEffect(() => clearJoineryStart(), [])
  const [saved] = useState(() => loadSaved(units))
  const [kind, setKind] = useState<JointKind>(() => (start ? (START_KIND[start] ?? 'dovetail') : (saved.kind ?? 'dovetail')))
  const [fp, setFp] = useState<FinePinDraft>(() => (start === 'fine-pin' ? defaultFinePin(units) : (saved.finepin ?? defaultFinePin(units))))
  const [kn, setKn] = useState<KnappDraft>(() => (start === 'knapp' ? defaultKnapp(units) : (saved.knapp ?? defaultKnapp(units))))
  const [apart, setApart] = useState(false)
  const [big, setBig] = useState<'tail' | 'pin' | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify({ kind, finepin: fp, knapp: kn, units } satisfies Saved))
    } catch {
      /* storage full or blocked: nothing to remember */
    }
  }, [kind, fp, kn, units])

  const dove = useDovetailBit(units, start, L)
  const fpModel = useMemo(() => finePinJoint(fp, L), [fp, L])
  const knModel = useMemo(() => knappJoint(kn, L), [kn, L])
  const model: JointModel = kind === 'dovetail' ? dove.model : kind === 'finepin' ? fpModel : knModel

  const upFp = (patch: Partial<FinePinDraft>) => setFp((d) => ({ ...d, ...patch }))
  const upKn = (patch: Partial<KnappDraft>) => setKn((d) => ({ ...d, ...patch }))
  const pos = (set: (v: number) => void, min = 0.5) => (v: number) => {
    if (v > 0) set(Math.max(min, v))
  }

  function add() {
    onImport({ parts: jointParts(model) })
    onClose()
  }

  // ----- Fine pin
  const fr = resolveFinePin(fp)
  const finePanel = (
    <>
      <Step n={1} title="Boards">
        <Plain label="width">
          <NumField label="Board width" adorn="W" units={units} value={fp.width} onCommit={pos((v) => upFp({ width: v }), 10)} />
        </Plain>
        <div className="c3d-two">
          <Plain label="tail board">
            <NumField label="Tail board thickness" adorn="T" units={units} value={fp.tailThick} onCommit={pos((v) => upFp({ tailThick: v }), 1)} />
          </Plain>
          <Plain label="pin board">
            <NumField label="Pin board thickness" adorn="T" units={units} value={fp.pinThick} onCommit={pos((v) => upFp({ pinThick: v }), 1)} />
          </Plain>
        </div>
      </Step>

      <Step n={2} title="Pins">
        <Auto label="pins (plus a half pin at each edge)" auto={fp.pins == null} onReset={() => upFp({ pins: null })}>
          <StepperParam label="Pins" value={fr.pins} min={0} max={Math.max(0, fr.maxPins)} onCommit={(v) => upFp({ pins: v })} />
        </Auto>
        <Auto label="pin width at the face" auto={fp.pinWidth == null} onReset={() => upFp({ pinWidth: null })}>
          <NumField label="Pin width" units={units} value={fr.pinWidth} onCommit={(v) => v > 0 && upFp({ pinWidth: Math.max(fr.minPinWidth, v) })} />
        </Auto>
        <Plain label="slope">
          <div className="jt-row">
            <Seg
              label="Dovetail slope"
              value={[5, 6, 8].includes(fp.slope) ? fp.slope : null}
              options={[
                { v: 5, label: '1:5' },
                { v: 6, label: '1:6' },
                { v: 8, label: '1:8' },
              ]}
              onChange={(v) => upFp({ slope: v })}
            />
            <NumField label="Slope angle" adorn="∠" kind="angle" units={units} value={+fr.angle.toFixed(2)} onCommit={(v) => v > 0 && v < 40 && upFp({ slope: angleToSlope(v) })} />
          </div>
        </Plain>
        <Auto label="edge pins at the face" auto={fp.edgePin == null} onReset={() => upFp({ edgePin: null })}>
          <NumField label="Edge pin width" units={units} value={fr.edgePin} onCommit={(v) => v > 0 && upFp({ edgePin: Math.max(0.5, v) })} />
        </Auto>
        <span className="c3d-muted-note">
          Pins {L(fr.pinWidth)} → {L(fr.pinWide)} · tails {L(Math.max(0, fr.tailWide))} → {L(Math.max(0, fr.tailNarrow))} · finest pin {L(fr.minPinWidth)}
        </span>
      </Step>

      <Step n={3} title="Bits">
        <BitSelect label="tail board (finest pins)" choice={fp.tailBit} units={units} onChange={(c) => upFp({ tailBit: c, pinWidth: null })} />
        <BitSelect label="pin board (clears the waste)" choice={fp.pinBit} units={units} onChange={(c) => upFp({ pinBit: c })} />
        <FitFields fit={fp.fit} units={units} onChange={(f) => upFp({ fit: f })} cornerLabels={['Round to match', 'Chisel square']} />
      </Step>
    </>
  )

  // ----- Knapp
  const kr = resolveKnapp(kn)
  const knappPanel = (
    <>
      <Step n={1} title="Boards">
        <Plain label="height (board width)">
          <NumField label="Board width" adorn="H" units={units} value={kn.width} onCommit={pos((v) => upKn({ width: v }), 10)} />
        </Plain>
        <div className="c3d-two">
          <Plain label="drawer side">
            <NumField label="Side thickness" adorn="T" units={units} value={kn.sideThick} onCommit={pos((v) => upKn({ sideThick: v }), 2)} />
          </Plain>
          <Plain label="drawer front">
            <NumField label="Front thickness" adorn="T" units={units} value={kn.frontThick} onCommit={pos((v) => upKn({ frontThick: v }), 4)} />
          </Plain>
        </div>
      </Step>

      <Step n={2} title="Pins & coves">
        <Auto label="dowels" auto={kn.pins == null} onReset={() => upKn({ pins: null })}>
          <StepperParam label="Dowels" value={kr.pins} min={1} max={kr.maxPins} onCommit={(v) => upKn({ pins: v })} />
        </Auto>
        <div className="c3d-two">
          <Auto label="dowel Ø" auto={kn.dowel == null} onReset={() => upKn({ dowel: null })}>
            <NumField label="Dowel diameter" adorn="Ø" units={units} value={kr.dowel} onCommit={(v) => v > 0 && upKn({ dowel: Math.max(1, v) })} />
          </Auto>
          <Auto label={kn.style === 'straight' ? 'set-back' : 'cove radius'} auto={kn.cove == null} onReset={() => upKn({ cove: null })}>
            <NumField label="Cove radius" adorn="R" units={units} value={kr.cove} onCommit={(v) => v > 0 && upKn({ cove: v })} />
          </Auto>
        </div>
        <Plain label="side end">
          <Seg
            label="Side end"
            value={kn.style}
            options={[
              { v: 'cove', label: 'Coves' },
              { v: 'straight', label: 'Straight' },
            ]}
            onChange={(v) => upKn({ style: v })}
          />
        </Plain>
        <Plain label="joint on the side's face">
          <Seg
            label="Joint on the side's face"
            value={kn.hidden ? 'hidden' : 'shows'}
            options={[
              { v: 'shows', label: 'Shows' },
              { v: 'hidden', label: 'Hidden' },
            ]}
            onChange={(v) => upKn({ hidden: v === 'hidden' })}
          />
        </Plain>
        {kn.hidden && (
          <Plain label="outer skin left on the side">
            <NumField label="Skin" units={units} value={kn.skin} onCommit={(v) => v > 0 && upKn({ skin: Math.min(v, kn.sideThick - 1) })} />
          </Plain>
        )}
        <details className="jt-more">
          <summary>More layout</summary>
          <div className="jt-more__body">
            <div className="c3d-two">
              <Auto label="edge to 1st dowel" auto={kn.margin == null} onReset={() => upKn({ margin: null })}>
                <NumField label="Edge margin" units={units} value={kr.margin} onCommit={(v) => v > 0 && upKn({ margin: Math.min(v, kn.width / 2) })} />
              </Auto>
              <Auto label="dowel from inside" auto={kn.dowelPos == null} onReset={() => upKn({ dowelPos: null })}>
                <NumField label="Dowel position" units={units} value={kr.dowelPos} onCommit={(v) => v >= 0 && upKn({ dowelPos: Math.min(v, kn.frontThick) })} />
              </Auto>
            </div>
            <Plain label="dowel shape">
              <div className="jt-row">
                <Seg
                  label="Dowel shape"
                  value={kn.dowelLength > 0 ? 'slot' : 'round'}
                  options={[
                    { v: 'round', label: 'Round' },
                    { v: 'slot', label: 'Slot' },
                  ]}
                  onChange={(v) => upKn({ dowelLength: v === 'slot' ? Math.round(kr.dowel) : 0 })}
                />
                {kn.dowelLength > 0 && <NumField label="Extra slot length" adorn="+" units={units} value={kn.dowelLength} onCommit={(v) => v >= 0 && upKn({ dowelLength: v })} />}
              </div>
            </Plain>
            <span className="c3d-muted-note">
              Spacing {L(kr.pitch)} · front lap {L(Math.max(0, kr.lap))} · smallest cove for the front bit {L(kr.minCove)}
            </span>
          </div>
        </details>
      </Step>

      <Step n={3} title="Bits">
        <BitSelect label="drawer side (holes and coves)" choice={kn.sideBit} units={units} onChange={(c) => upKn({ sideBit: c })} />
        <BitSelect label="drawer front (around the dowels)" choice={kn.frontBit} units={units} onChange={(c) => upKn({ frontBit: c })} />
        <FitFields fit={kn.fit} units={units} onChange={(f) => upKn({ fit: f })} cornerLabels={['Round to match', 'Pare to a point']} />
      </Step>
    </>
  )

  const info = KINDS.find((k) => k.id === kind)!

  return (
    <div className="ss-dialog c3d-dialog dt-dialog" role="dialog" aria-label="Joinery">
      <div className="ss-dialog__header">
        <h1 className="ss-dialog__title">Joinery</h1>
      </div>

      <div className="ss-dialog__body">
        <div className="ss-dialog__main">
          <JointViewer model={model} apart={apart} />
          <div className="c3d-overlay">
            <div className="ss-seg c3d-viewtoggle" role="group" aria-label="3D view">
              <button type="button" aria-pressed={!apart} onClick={() => setApart(false)}>
                Joined
              </button>
              <button type="button" aria-pressed={apart} onClick={() => setApart(true)}>
                Apart
              </button>
            </div>
            <span className="ss-muted jt-summary">{model.summary}</span>
          </div>
          <div className={`dt-cards${big ? ' dt-cards--big' : ''}`}>
            {(['tail', 'pin'] as const).map((w) =>
              big && big !== w ? null : <LayoutCard key={w} layout={model.layouts[w]} big={big === w} onToggle={() => setBig((b) => (b === w ? null : w))} />,
            )}
          </div>
        </div>

        <aside className="ss-dialog__side c3d-side jt-side">
          <div className="jt-kinds" role="radiogroup" aria-label="Joint">
            {KINDS.map((k) => (
              <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className="jt-kind" onClick={() => setKind(k.id)}>
                <KindGlyph kind={k.id} />
                <span className="jt-kind__name">{k.name}</span>
              </button>
            ))}
          </div>
          <p className="jt-blurb">{info.blurb}</p>

          {kind === 'dovetail' ? dove.panel : kind === 'finepin' ? finePanel : knappPanel}

          {model.warnings.length > 0 && (
            <div className="c3d-section">
              {model.warnings.map((w) => (
                <div key={w} className="c3d-warn">
                  {w}
                </div>
              ))}
            </div>
          )}

          <section className="c3d-section jt-card" aria-label="Cut card">
            <div className="ss-section-title">cut card</div>
            <ol className="jt-cutsteps">
              {model.steps.map((s, i) => (
                <li key={i} className={`jt-cutstep jt-cutstep--${s.board}`}>
                  <span className="jt-cutstep__title">{s.title}</span>
                  {s.bit && <span className="jt-cutstep__bit">{s.bit}</span>}
                  <span className="jt-cutstep__text">{s.text}</span>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>

      <div className="ss-dialog__footer">
        <button type="button" className="ss-btn ss-btn--primary" disabled={!model.ok} onClick={add}>
          Add to Design
        </button>
        <button type="button" className="ss-btn-round" onClick={onClose} aria-label="Cancel">
          <IconClose />
        </button>
      </div>
    </div>
  )
}
