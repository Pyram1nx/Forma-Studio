// Side panel for multi-sided carving: which faces to carve, the bit for each process stage,
// the bridges that keep the part seated in the block between flips, and the resulting process
// table (one row per side × stage). Selecting a row points the 3D preview at that stage.
import type { Units } from '../../model/types'
import { BITS, ORIGIN_MAX_DEPTH } from './bits'
import { Field, NumInput } from './fields'
import { SIDE_LABEL, STAGE_LABEL, type MultiSidePlan, type StageBits, type StageRole } from './multiSide'
import type { TabSettings } from './carvePlan'
import { SIDE_ORDER, type SideAnalysis, type SideId } from './sideAnalysis'

export interface MultiSidePanelProps {
  units: Units
  /** Result of analyzeSides for the placed model, when available. */
  analysis: Record<SideId, SideAnalysis> | null
  enabled: SideId[]
  onToggleSide: (s: SideId) => void
  bits: StageBits
  onBits: (b: StageBits) => void
  allowance: number
  engraveDepth: number
  stepDown: number
  onStepDown: (v: number) => void
  stockMm: number
  onStock: (v: number) => void
  marginMm: number
  onMargin: (v: number) => void
  onAllowance: (v: number) => void
  onEngraveDepth: (v: number) => void
  bridges: TabSettings
  onBridges: (t: TabSettings) => void
  /** The selected layer's plan (the whole block when it is one board). */
  layerPlan: MultiSidePlan | null
  /** "Layer 2 of 3" when the block is split, else null. */
  layerLabel: string | null
  /** Every layer's warnings. */
  warnings: string[]
  shapesCount: number
  /** Boards the block is split into. */
  layers: number
  onLayers: (n: number) => void
  /** Boards that would bring every top/bottom carve and cut-out within reach, when more are needed. */
  splitTo: number | null
  /** Thickest board the chosen bits handle, mm. */
  layerLimitMm: number | null
  /** Thickness of each board, mm. */
  boardMm: number
  /** Bit length lost to the collet and spindle, mm. */
  holderMm: number
  onHolder: (v: number) => void
  planCurrent: boolean
  computing: boolean
  progress: number
  /** Viewer selection: side + stage index into that side's plans. */
  selected: { side: SideId | null; stage: number }
  onSelect: (side: SideId, stage: number) => void
  L: (mm: number) => string
  toU: (mm: number) => number
  fromU: (v: number) => number
  dec: number
}

type BitRole = Exclude<StageRole, 'cutout'>

const ROLES: BitRole[] = ['rough', 'detail', 'engrave']

const ROLE_HINT: Record<BitRole, string> = {
  rough: 'largest owned bit — clears the bulk',
  detail: 'finer bit — finishing pass to the surface',
  engrave: 'V-bit — finest detail at the bottom',
}

export default function MultiSidePanel(p: MultiSidePanelProps) {
  const carvable = BITS.filter((b) => b.carvable)
  const stage = (role: BitRole) => (
    <Field key={role} label={`${ROLE_HINT[role].split(' — ')[0]} bit`}>
      <select
        className="ss-select"
        value={p.bits[role] ?? ''}
        aria-label={`${role} bit`}
        onChange={(e) => p.onBits({ ...p.bits, [role]: e.target.value || null })}
      >
        <option value="">off</option>
        {carvable.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </Field>
  )

  return (
    <>
      <div className="c3d-section">
        <div className="ss-section-title">sides</div>
        <div className="c3d-two">
          <Field label="stock thickness">
            <NumInput value={p.toU(p.stockMm)} onChange={(v) => p.onStock(v)} decimals={p.dec} suffix={p.units} ariaLabel="stock thickness" />
          </Field>
          <Field label="step-down">
            <NumInput value={p.toU(p.stepDown)} onChange={(v) => p.onStepDown(v)} decimals={p.dec} suffix={p.units} ariaLabel="step-down" />
          </Field>
        </div>
        <Field label="margin">
          <NumInput value={p.toU(p.marginMm)} onChange={(v) => p.onMargin(p.fromU(v))} decimals={p.dec} suffix={p.units} ariaLabel="margin" />
        </Field>
        <div className="c3d-chips" role="group" aria-label="faces to carve">
          {SIDE_ORDER.map((s) => {
            const a = p.analysis?.[s]
            const on = p.enabled.includes(s)
            return (
              <button
                key={s}
                type="button"
                className={'c3d-chip' + (on ? ' is-on' : '') + (a && !a.needed ? ' is-empty' : '')}
                aria-pressed={on}
                title={a && !a.needed ? 'flush with the model — nothing to carve' : a ? `carve ${p.L(a.cutDepth)} deep` : undefined}
                onClick={() => p.onToggleSide(s)}
              >
                {SIDE_LABEL[s]}
                {a?.needed ? <em>{p.L(a.cutDepth)}</em> : null}
              </button>
            )
          })}
        </div>
      </div>

      <div className="c3d-section">
        <div className="ss-section-title">process stages</div>
        {ROLES.map(stage)}
        <div className="c3d-two">
          <Field label="finish allowance">
            <NumInput value={p.toU(p.allowance)} onChange={(v) => p.onAllowance(p.fromU(v))} decimals={p.dec} suffix={p.units} ariaLabel="finish allowance" />
          </Field>
          <Field label="engrave depth">
            <NumInput value={p.toU(p.engraveDepth)} onChange={(v) => p.onEngraveDepth(p.fromU(v))} decimals={p.dec} suffix={p.units} ariaLabel="engrave depth" />
          </Field>
        </div>
        <span className="ss-muted">Rough clears the bulk and leaves the finish allowance, detail finishes the whole surface, engrave adds the finest detail. Order: rough → detail → engrave.</span>
      </div>

      <div className="c3d-section">
        <div className="ss-section-title">depth limits</div>
        <div className="c3d-two">
          <Field label="layers">
            <NumInput value={p.layers} decimals={0} onChange={(v) => p.onLayers(v)} ariaLabel="layers" />
          </Field>
          <Field label="collet allowance">
            <NumInput value={p.toU(p.holderMm)} decimals={p.dec} suffix={p.units} onChange={(v) => p.onHolder(v)} ariaLabel="collet allowance" />
          </Field>
        </div>
        <span className="ss-muted">
          Origin cuts at most {p.L(ORIGIN_MAX_DEPTH)}; a bit reaches its stated max depth, or its length less the collet allowance.
          {p.layerLimitMm !== null && Number.isFinite(p.layerLimitMm) ? ` Your bits reach ${p.L(p.layerLimitMm)}.` : ''}
          {p.layers > 1 ? ` ${p.layers} boards of ${p.L(p.boardMm)}, carved one by one and glued up.` : ''}
        </span>
        {p.splitTo !== null && (
          <div className="c3d-warn c3d-split">
            <span>
              This block is too deep for your bits. Split it into {p.splitTo} layers of {p.L((p.boardMm * p.layers) / p.splitTo)}: each board is carved
              from both faces and cut out within reach, then the boards are glued back up.
            </span>
            <button type="button" className="ss-btn ss-btn--sm ss-btn--primary" onClick={() => p.onLayers(p.splitTo!)}>
              Split into {p.splitTo} layers
            </button>
          </div>
        )}
      </div>

      <div className="c3d-section">
        <div className="ss-section-title">bridges</div>
        <span className="ss-muted">The part is cut out once, on the last top/bottom face, leaving bridges so it stays seated in the block while you flip it. No setup cuts through them.</span>
        <div className="c3d-three">
          <Field label="count">
            <NumInput value={p.bridges.count} decimals={0} onChange={(v) => p.onBridges({ ...p.bridges, count: Math.max(0, Math.round(v)) })} ariaLabel="bridge count" />
          </Field>
          <Field label="width">
            <NumInput value={p.toU(p.bridges.width)} decimals={p.dec} suffix={p.units} onChange={(v) => p.onBridges({ ...p.bridges, width: p.fromU(v) })} ariaLabel="bridge width" />
          </Field>
          <Field label="height">
            <NumInput value={p.toU(p.bridges.height)} decimals={p.dec} suffix={p.units} onChange={(v) => p.onBridges({ ...p.bridges, height: p.fromU(v) })} ariaLabel="bridge height" />
          </Field>
        </div>
      </div>

      {p.computing && (
        <div className="c3d-progress" aria-label="computing">
          <span style={{ width: `${Math.round(p.progress * 100)}%` }} />
        </div>
      )}
      {p.warnings.map((w, i) => (
        <div key={i} className="c3d-warn">
          {w}
        </div>
      ))}

      {p.layerPlan && p.layerPlan.sides.length > 0 && (
        <div className="c3d-section">
          <div className="ss-section-title">process plan{p.layerLabel ? ` · ${p.layerLabel}` : ''}</div>
          <span className="c3d-order">Run the rows top to bottom: each side's stages in order, flipping the block between sides. ⧉ cuts the part out (leave the bridges).</span>
          <table className="c3d-table">
            <thead>
              <tr>
                <th>side</th>
                <th>stage</th>
                <th>depth</th>
                <th>layers</th>
              </tr>
            </thead>
            <tbody>
              {p.layerPlan.sides.map((s) =>
                s.plans.map((plan, k) => {
                  // Depths from the stock face, as set on the machine.
                  const cutout = s.stages[k].role === 'cutout'
                  const from = cutout ? 0 : s.faceOffset + s.stages[k].depthFrom
                  const to = cutout ? plan.throughDepth : plan.layers[plan.layers.length - 1]?.depth ?? from
                  const sel = p.selected.side === s.side && p.selected.stage === k
                  return (
                    <tr
                      key={`${s.side}-${k}`}
                      className={sel ? 'is-sel' : undefined}
                      onClick={() => p.onSelect(s.side, k)}
                      title={`${s.label} · ${STAGE_LABEL[s.stages[k].role]} — ${plan.bit.name}`}
                    >
                      <td>{s.label}</td>
                      <td>
                        {STAGE_LABEL[s.stages[k].role]}
                        <span className="ss-muted"> · {plan.bit.name}</span>
                      </td>
                      <td>
                        {p.L(from)} → {p.L(to)}
                        {plan.throughCut ? ' ⧉' : ''}
                      </td>
                      <td>{cutout ? '—' : plan.layers.length}</td>
                    </tr>
                  )
                }),
              )}
            </tbody>
          </table>
          <span className="ss-muted">
            {p.shapesCount} shapes will be added
            {p.planCurrent ? '' : ' (settings changed, recalculating)'}
          </span>
        </div>
      )}
    </>
  )
}
