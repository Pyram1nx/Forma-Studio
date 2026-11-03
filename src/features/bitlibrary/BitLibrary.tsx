// The bit gallery: every bit the user owns (Shaper's catalogue plus their own additions), with
// photos, specs and a "what bit should I use?" suggester. It is the shared source of truth for
// bit ownership — the Plan panel and 3D Carve read suggestions through features/bitlibrary.
// Rendered three ways: full page (route /bits), inside the home window, and as a studio dialog.
//
// Layout: a calm photo grid (name + diameter only, a check to mark a bit as owned); everything
// else — specs, quantity, notes, the suggester and the add/edit form — opens in a sheet that
// slides in from the right (from the bottom on phones).
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { fmtLen, fmtNum } from '../../model/factory'
import type { Units } from '../../model/types'
import { reachDepth, type Bit, type BitGroup, type BitType } from '../carve3d/bits'
import { Field } from '../carve3d/fields'
import { NumField } from '../../editor/Panels'
import * as Ic from '../../ui/icons'
import BitPhoto from './BitPhoto'
import { allBits, suggestBits, useBitLibrary, type CustomBitInput, type SuggestRequest } from './library'
import { lastUnits } from '../../state/store'
import './bitlibrary.css'

const GROUPS: { id: BitGroup; title: string }[] = [
  { id: 'origin', title: 'Ships with Origin' },
  { id: 'flat', title: 'Flat & spiral' },
  { id: 'ball', title: 'Ball & tapered' },
  { id: 'engraving', title: 'Engraving / V' },
  { id: 'specialty', title: 'Specialty' },
]

const TYPE_LABEL: Record<BitType, string> = {
  flat: 'flat',
  ball: 'ball nose',
  taperedball: 'tapered ball',
  vbit: 'V-bit',
  undercut: 'undercut',
}

/** Catalogue names without the noise: '1/4" X 1" Up-Spiral Flat Router Bit' → '1/4" × 1" Up-Spiral Flat'. */
const shortName = (bit: Bit) =>
  bit.name
    .replace(/\s*\(in Origin box\)/i, '')
    .replace(/\s+Router Bit$/i, '')
    .replace(/(\S) X (\S)/g, '$1 × $2')

/** Mark values inferred from the catalogue (rather than stated by Shaper) with "≈". */
function stated(bit: Bit, field: keyof Bit, text: string): string {
  return bit.inferred.includes(field as never) ? `≈ ${text}` : text
}

const isCustom = (bit: Bit) => bit.id.startsWith('custom-')

// ---- sheet ---------------------------------------------------------------

/** Side sheet (bottom sheet on phones) over everything, including the studio dialog. */
function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    // Capture phase, so the studio's own Escape handler (which closes the whole dialog) sees it consumed.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return createPortal(
    <div className="bl-sheet-backdrop" onPointerDown={onClose}>
      <aside className="bl-sheet" role="dialog" aria-modal="true" aria-label={label} onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" className="bl-sheet__close" aria-label="Close" onClick={onClose}>
          <Ic.IconClose size={18} />
        </button>
        {children}
      </aside>
    </div>,
    document.body,
  )
}

// ---- suggester -----------------------------------------------------------

const USES: { id: NonNullable<SuggestRequest['use']>; label: string }[] = [
  { id: 'inside', label: 'Inside' },
  { id: 'pocket', label: 'Pocket' },
  { id: 'online', label: 'On line' },
  { id: 'carve', label: '3D carve' },
  { id: 'engrave', label: 'Engrave' },
]

/** "Which bit should I use?" — ranks the gallery (owned first) against one cut. */
function SuggestPanel({ units, onPick }: { units: Units; onPick: (id: string) => void }) {
  const owned = useBitLibrary((s) => s.owned)
  const custom = useBitLibrary((s) => s.custom)
  const [depth, setDepth] = useState<number | null>(3)
  const [use, setUse] = useState<NonNullable<SuggestRequest['use']>>('inside')

  const top = useMemo(
    () => suggestBits({ owned, custom }, { depthMm: depth ?? undefined, use }).slice(0, 3),
    [owned, custom, depth, use],
  )

  return (
    <div className="bl-sheet__body">
      <h2 className="bl-sheet__title">Help me choose</h2>
      <p className="bl-sheet__lead">Pick the cut and how deep it goes. Bits in your kit come first.</p>

      <div className="bl-field-label">Cut</div>
      <div className="bl-chips" role="group" aria-label="Kind of cut">
        {USES.map((u) => (
          <button key={u.id} type="button" className={'bl-chip' + (use === u.id ? ' is-active' : '')} aria-pressed={use === u.id} onClick={() => setUse(u.id)}>
            {u.label}
          </button>
        ))}
      </div>

      <div className="bl-field-label">Depth</div>
      <div className="bl-depth">
        <NumField label="Cut depth" kind="length" units={units} value={depth} placeholder="any" onCommit={(v) => setDepth(v > 0 ? v : null)} />
      </div>

      <div className="bl-field-label">Best matches</div>
      <ol className="bl-picks">
        {top.map((s) => (
          <li key={s.bit.id}>
            <button type="button" className={'bl-pick' + (s.fits ? '' : ' is-nofit')} onClick={() => onPick(s.bit.id)}>
              <span className="bl-pick__media">
                <BitPhoto bit={s.bit} className="bl-pick__img" />
              </span>
              <span className="bl-pick__text">
                <span className="bl-pick__name">{shortName(s.bit)}</span>
                <span className="bl-pick__why">{s.fits ? s.reasons.join(' · ') || s.bit.subtype : "Won't reach this depth"}</span>
              </span>
              <Ic.IconChevronRight size={16} />
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}

// ---- custom bit form -----------------------------------------------------

/** Numeric form field: blank until set; commits mm (or degrees/counts) or null. */
function FormNum({
  label,
  kind = 'length',
  units,
  value,
  placeholder,
  onCommit,
}: {
  label: string
  kind?: 'length' | 'angle' | 'count'
  units: Units
  value: number | null
  placeholder?: string
  onCommit: (v: number | null) => void
}) {
  return (
    <NumField
      label={label}
      kind={kind}
      units={units}
      value={value}
      placeholder={placeholder}
      onCommit={(v) => onCommit(v > 0 || kind !== 'length' ? v : null)}
    />
  )
}

interface FormState {
  name: string
  type: BitType
  subtype: string
  diameter: number | null
  shank: number | null
  flute: number | null
  overall: number | null
  maxDepth: number | null
  angle: number | null
  flutes: number | null
  tipDiameter: number | null
  tipRadius: number | null
  imageUrl: string
  notes: string
}

const emptyForm: FormState = {
  name: '', type: 'flat', subtype: '', diameter: null, shank: null, flute: null,
  overall: null, maxDepth: null, angle: null, flutes: null, tipDiameter: null, tipRadius: null,
  imageUrl: '', notes: '',
}

function BitForm({ initial, units, onDone, onCancel }: { initial?: Bit; units: Units; onDone: (input: CustomBitInput) => void; onCancel: () => void }) {
  const [f, setF] = useState<FormState>(
    initial
      ? {
          name: initial.name,
          type: initial.type,
          subtype: initial.subtype,
          diameter: initial.diameter,
          shank: initial.shankDiameter,
          flute: initial.fluteLength,
          overall: initial.overallLength,
          maxDepth: initial.maxDepth,
          angle: initial.angle,
          flutes: initial.flutes,
          tipDiameter: initial.tipDiameter,
          tipRadius: initial.tipRadius,
          imageUrl: initial.imageUrl ?? '',
          notes: initial.notes,
        }
      : emptyForm,
  )
  const [more, setMore] = useState(!!initial)
  const set = (patch: Partial<FormState>) => setF((prev) => ({ ...prev, ...patch }))

  const valid = f.name.trim().length > 0 && (f.diameter ?? 0) > 0 && (f.flute ?? 0) > 0 && (f.type !== 'vbit' && f.type !== 'taperedball' || (f.angle ?? 0) > 0)
  const submit = () => {
    if (!valid) return
    onDone({
      name: f.name,
      type: f.type,
      subtype: f.subtype || undefined,
      diameter: f.diameter!,
      shankDiameter: f.shank ?? undefined,
      fluteLength: f.flute!,
      overallLength: f.overall,
      maxDepth: f.maxDepth,
      angle: f.angle,
      flutes: f.flutes,
      tipDiameter: f.type === 'vbit' ? (f.tipDiameter ?? 0) : null,
      tipRadius: f.type === 'ball' || f.type === 'taperedball' ? (f.tipRadius ?? undefined) : null,
      imageUrl: f.imageUrl || null,
      notes: f.notes || undefined,
    })
  }

  return (
    <form
      className="bl-sheet__body bl-form"
      aria-label={initial ? 'Edit bit' : 'Add a bit'}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <h2 className="bl-sheet__title">{initial ? 'Edit bit' : 'Add a bit'}</h2>
      <p className="bl-sheet__lead">A bit that isn't in Shaper's catalogue. Name, diameter and flute length are enough.</p>

      <Field label="name">
        <input className="ss-input bl-text" aria-label="Bit name" value={f.name} placeholder="e.g. 3 mm two-flute downcut" onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <div className="bl-form__grid">
        <Field label="type">
          <select
            className="ss-select"
            aria-label="Bit type"
            value={f.type}
            onChange={(e) => {
              const type = e.target.value as BitType
              // Sensible angles so a half-filled form still produces a sane profile.
              const angle = f.angle ?? (type === 'vbit' ? 60 : type === 'taperedball' ? 11 : null)
              set({ type, angle })
            }}
          >
            {(Object.keys(TYPE_LABEL) as BitType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Ø cutting">
          <FormNum label="Cutting diameter" units={units} value={f.diameter} onCommit={(v) => set({ diameter: v })} />
        </Field>
        <Field label="flute length">
          <FormNum label="Flute length" units={units} value={f.flute} onCommit={(v) => set({ flute: v })} />
        </Field>
        {(f.type === 'vbit' || f.type === 'taperedball') && (
          <Field label="angle">
            <FormNum label="Included angle" kind="angle" units={units} value={f.angle} onCommit={(v) => set({ angle: v })} />
          </Field>
        )}
      </div>

      <button type="button" className="bl-disclosure" aria-expanded={more} onClick={() => setMore(!more)}>
        More details
        <Ic.IconChevronRight size={14} />
      </button>
      {more && (
        <>
          <div className="bl-form__grid">
            <Field label="flutes">
              <FormNum label="Flutes" kind="count" units={units} value={f.flutes} placeholder="—" onCommit={(v) => set({ flutes: v })} />
            </Field>
            <Field label="Ø shank">
              <FormNum label="Shank diameter" units={units} value={f.shank} placeholder="= cutting" onCommit={(v) => set({ shank: v })} />
            </Field>
            <Field label="overall length">
              <FormNum label="Overall length" units={units} value={f.overall} placeholder="—" onCommit={(v) => set({ overall: v })} />
            </Field>
            <Field label="stated max depth">
              <FormNum label="Stated maximum depth" units={units} value={f.maxDepth} placeholder="flute length" onCommit={(v) => set({ maxDepth: v })} />
            </Field>
            {f.type === 'vbit' && (
              <Field label="tip Ø">
                <FormNum label="Tip diameter" units={units} value={f.tipDiameter} placeholder="sharp" onCommit={(v) => set({ tipDiameter: v })} />
              </Field>
            )}
            {(f.type === 'ball' || f.type === 'taperedball') && (
              <Field label="tip R">
                <FormNum label="Tip radius" units={units} value={f.tipRadius} placeholder="= Ø/2" onCommit={(v) => set({ tipRadius: v })} />
              </Field>
            )}
          </div>
          <Field label="image URL">
            <input className="ss-input bl-text" aria-label="Image URL" type="url" value={f.imageUrl} placeholder="https://…" onChange={(e) => set({ imageUrl: e.target.value })} />
          </Field>
          <Field label="notes">
            <textarea className="bl-text bl-textarea" aria-label="Notes" rows={2} value={f.notes} placeholder="For acrylic, 6 mm shank…" onChange={(e) => set({ notes: e.target.value })} />
          </Field>
        </>
      )}

      <div className="bl-sheet__actions">
        <button type="button" className="ss-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="ss-btn ss-btn--primary" disabled={!valid}>
          {initial ? 'Save changes' : 'Add to my kit'}
        </button>
      </div>
    </form>
  )
}

// ---- tile ----------------------------------------------------------------

function Tile({ bit, units, ownedQty, onOpen, onToggleOwned }: { bit: Bit; units: Units; ownedQty: number | null; onOpen: () => void; onToggleOwned: () => void }) {
  const owned = ownedQty != null
  return (
    <div className={'bl-tile' + (owned ? ' is-owned' : '')}>
      <button type="button" className="bl-tile__main" onClick={onOpen} aria-label={`${shortName(bit)}, details`}>
        <span className="bl-tile__media">
          <BitPhoto bit={bit} className="bl-tile__img" />
        </span>
        <span className="bl-tile__name">{shortName(bit)}</span>
        <span className="bl-tile__meta">
          Ø {stated(bit, 'diameter', fmtLen(bit.diameter, units))}
          {isCustom(bit) && ' · yours'}
        </span>
      </button>
      <button
        type="button"
        className="bl-tile__own"
        aria-pressed={owned}
        aria-label={owned ? `In my kit ×${ownedQty}; remove ${bit.name}` : `Add ${bit.name} to my kit`}
        title={owned ? 'In my kit' : 'I own this'}
        onClick={onToggleOwned}
      >
        <Ic.IconCheck size={14} />
        {owned && ownedQty! > 1 && <span>{ownedQty}</span>}
      </button>
    </div>
  )
}

// ---- detail --------------------------------------------------------------

function BitDetail({ bit, units, onEdit, onDelete }: { bit: Bit; units: Units; onEdit: () => void; onDelete: () => void }) {
  const owned = useBitLibrary((s) => s.owned[bit.id])
  const setOwned = useBitLibrary((s) => s.setOwned)
  const setQty = useBitLibrary((s) => s.setQty)
  const setNotes = useBitLibrary((s) => s.setNotes)
  const [specsOpen, setSpecsOpen] = useState(false)

  const big: [string, string][] = [
    ['Ø cutting', stated(bit, 'diameter', fmtNum(bit.diameter, units))],
    ['flute', stated(bit, 'fluteLength', fmtNum(bit.fluteLength, units))],
    ['reaches', fmtNum(reachDepth(bit), units)],
  ]

  const specs: [string, string][] = [
    ['Ø shank', stated(bit, 'shankDiameter', fmtLen(bit.shankDiameter, units))],
    ['overall length', bit.overallLength == null ? 'not stated' : stated(bit, 'overallLength', fmtLen(bit.overallLength, units))],
  ]
  if (bit.angle != null) specs.push(['angle', `${stated(bit, 'angle', String(bit.angle))}° included`])
  if (bit.flutes != null) specs.push(['flutes', stated(bit, 'flutes', String(bit.flutes))])
  if (bit.type === 'vbit') specs.push(['tip Ø', stated(bit, 'tipDiameter', fmtLen(bit.tipDiameter ?? 0, units))])
  if (bit.type === 'ball' || bit.type === 'taperedball') specs.push(['tip R', stated(bit, 'tipRadius', fmtLen(bit.tipRadius ?? bit.diameter / 2, units))])
  specs.push(['SKU', bit.sku ?? (bit.inBox ? 'none (in Origin box)' : '—')])

  const group = GROUPS.find((g) => g.id === bit.group)?.title

  return (
    <>
      <div className="bl-hero">
        <BitPhoto bit={bit} className="bl-hero__img" />
      </div>
      <div className="bl-sheet__body">
        <div className="bl-eyebrow">
          {group} · {bit.subtype}
        </div>
        <h2 className="bl-sheet__title">{shortName(bit)}</h2>

        <dl className="bl-stats">
          {big.map(([k, v]) => (
            <div key={k} className="bl-stat">
              <dd>
                {v}
                <small>{units}</small>
              </dd>
              <dt>{k}</dt>
            </div>
          ))}
        </dl>

        {owned ? (
          <div className="bl-kit">
            <span className="bl-kit__label">
              <Ic.IconCheck size={16} /> In my kit
            </span>
            <span className="bl-qty" aria-label="Quantity owned">
              <button type="button" aria-label="Fewer" onClick={() => setQty(bit.id, owned.qty - 1)} disabled={owned.qty <= 1}>
                <Ic.IconMinus size={14} />
              </button>
              <span>{owned.qty}</span>
              <button type="button" aria-label="More" onClick={() => setQty(bit.id, owned.qty + 1)} disabled={owned.qty >= 99}>
                <Ic.IconPlus size={11} />
              </button>
            </span>
            <button type="button" className="bl-textbtn" onClick={() => setOwned(bit.id, false)}>
              Remove
            </button>
          </div>
        ) : (
          <button type="button" className="ss-btn ss-btn--primary ss-btn--block bl-own-btn" onClick={() => setOwned(bit.id, true)}>
            <Ic.IconCheck size={16} /> I own this bit
          </button>
        )}
        {owned && (
          <input className="ss-input bl-text bl-notes" aria-label="My notes for this bit" placeholder="Add a note — dull, in the shop drawer…" value={owned.notes} onChange={(e) => setNotes(bit.id, e.target.value)} />
        )}

        {!bit.carvable && bit.carveReason && <p className="bl-note bl-note--warn">{bit.carveReason}</p>}

        <button type="button" className="bl-disclosure" aria-expanded={specsOpen} onClick={() => setSpecsOpen(!specsOpen)}>
          All specs
          <Ic.IconChevronRight size={14} />
        </button>
        {specsOpen && (
          <>
            <dl className="bl-specs">
              {specs.map(([k, v]) => (
                <div key={k} className="bl-spec">
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            {bit.notes && <p className="bl-note">{bit.notes}</p>}
            {bit.inferred.length > 0 && <p className="bl-note">≈ marks values inferred from the catalogue, not stated by Shaper.</p>}
          </>
        )}

        <div className="bl-sheet__foot">
          {bit.productUrl && (
            <a className="bl-link" href={bit.productUrl} target="_blank" rel="noopener noreferrer">
              View on shapertools.com <span aria-hidden="true">↗</span>
            </a>
          )}
          {isCustom(bit) && (
            <span className="bl-sheet__foot-actions">
              <button type="button" className="bl-textbtn" onClick={onEdit}>
                <Ic.IconPencil size={14} /> Edit
              </button>
              <button type="button" className="bl-textbtn bl-textbtn--danger" onClick={onDelete}>
                Delete
              </button>
            </span>
          )}
        </div>
      </div>
    </>
  )
}

// ---- main gallery --------------------------------------------------------

type SheetState = { kind: 'bit'; id: string } | { kind: 'suggest' } | { kind: 'new' } | { kind: 'edit'; bit: Bit } | null

export default function BitLibrary({
  units,
  onUnitsChange,
  onClose,
  title = 'Bits',
}: {
  units: Units
  /** Shows a units toggle in the header (the page and home window; the studio uses its own units). */
  onUnitsChange?: (u: Units) => void
  onClose?: () => void
  /** Heading; the studio's popup names it after its menu item. */
  title?: string
}) {
  const state = useBitLibrary((s) => s)
  const { owned } = state
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'all' | 'kit'>(() => (Object.keys(owned).length ? 'kit' : 'all'))
  const [sheet, setSheet] = useState<SheetState>(null)

  const bits = useMemo(() => allBits(state), [state])
  const ownedCount = bits.filter((b) => owned[b.id]).length

  const q = query.trim().toLowerCase()
  const matches = (b: Bit) =>
    !q ||
    b.name.toLowerCase().includes(q) ||
    (b.sku ?? '').toLowerCase().includes(q) ||
    b.subtype.toLowerCase().includes(q) ||
    TYPE_LABEL[b.type].toLowerCase().includes(q)
  const passes = (b: Bit) => matches(b) && (view === 'all' || !!owned[b.id])
  const anyShown = bits.some(passes)

  const openBit = bits.find((b) => sheet?.kind === 'bit' && b.id === sheet.id)
  const closeSheet = () => setSheet(null)

  const deleteBit = (bit: Bit) => {
    if (!window.confirm(`Delete "${bit.name}" from your gallery?`)) return
    state.removeCustomBit(bit.id)
    setSheet(null)
  }

  return (
    <div className="bl-root">
      <header className="bl-head">
        <div className="bl-head__text">
          <h1 className="bl-head__title">{title}</h1>
          <p className="bl-head__sub">
            {ownedCount ? `${ownedCount} in your kit` : 'Tick the bits you own'}
            <span className="bl-head__hint"> — Plan and 3D Carve suggest from your kit.</span>
          </p>
        </div>
        <div className="bl-head__actions">
          {onUnitsChange && (
            <div className="ss-seg ss-seg--units" role="group" aria-label="Units">
              {(['mm', 'in'] as Units[]).map((u) => (
                <button key={u} type="button" aria-pressed={units === u} onClick={() => onUnitsChange(u)}>
                  {u}
                </button>
              ))}
            </div>
          )}
          <button type="button" className="ss-btn ss-btn--sm bl-help" onClick={() => setSheet({ kind: 'suggest' })}>
            <Ic.IconHelp size={16} /> Help me choose
          </button>
          <button type="button" className="ss-btn ss-btn--sm ss-btn--primary bl-add" aria-label="Add a bit" onClick={() => setSheet({ kind: 'new' })}>
            <Ic.IconPlus size={12} /> <span className="bl-add__label">Add bit</span>
          </button>
          {onClose && (
            <button type="button" className="bl-close" aria-label="Close bit gallery" onClick={onClose}>
              <Ic.IconClose size={18} />
            </button>
          )}
        </div>
      </header>

      <div className="bl-bar">
        <div className="bl-tabs" role="tablist" aria-label="Show">
          <button type="button" role="tab" aria-selected={view === 'kit'} className={view === 'kit' ? 'is-active' : ''} onClick={() => setView('kit')}>
            My kit <span className="bl-tabs__count">{ownedCount}</span>
          </button>
          <button type="button" role="tab" aria-selected={view === 'all'} className={view === 'all' ? 'is-active' : ''} onClick={() => setView('all')}>
            All bits <span className="bl-tabs__count">{bits.length}</span>
          </button>
        </div>
        <label className="bl-search">
          <Ic.IconSearch size={14} />
          <input type="search" aria-label="Search bits" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>

      {view === 'kit' && ownedCount === 0 ? (
        <div className="bl-empty">
          <div className="bl-empty__icon">
            <Ic.IconBitLibrary size={28} />
          </div>
          <h2>Your kit is empty</h2>
          <p>Tick the bits you own and the studio will suggest from them when you plan a cut.</p>
          <button type="button" className="ss-btn ss-btn--primary ss-btn--sm" onClick={() => setView('all')}>
            Browse all bits
          </button>
        </div>
      ) : (
        <div className="bl-groups">
          {GROUPS.map((g) => {
            const items = bits.filter((b) => b.group === g.id && passes(b))
            if (!items.length) return null
            return (
              <section key={g.id} className="bl-group" aria-label={g.title}>
                <h3 className="bl-group__title">
                  {g.title} <span>{items.length}</span>
                </h3>
                <div className="bl-grid">
                  {items.map((b) => (
                    <Tile
                      key={b.id}
                      bit={b}
                      units={units}
                      ownedQty={owned[b.id]?.qty ?? null}
                      onOpen={() => setSheet({ kind: 'bit', id: b.id })}
                      onToggleOwned={() => state.setOwned(b.id, !owned[b.id])}
                    />
                  ))}
                </div>
              </section>
            )
          })}
          {!anyShown && <div className="bl-none">No bits match “{query}”.</div>}
        </div>
      )}

      {sheet?.kind === 'bit' && openBit && (
        <Sheet label={openBit.name} onClose={closeSheet}>
          <BitDetail bit={openBit} units={units} onEdit={() => setSheet({ kind: 'edit', bit: openBit })} onDelete={() => deleteBit(openBit)} />
        </Sheet>
      )}
      {sheet?.kind === 'suggest' && (
        <Sheet label="Help me choose" onClose={closeSheet}>
          <SuggestPanel units={units} onPick={(id) => setSheet({ kind: 'bit', id })} />
        </Sheet>
      )}
      {(sheet?.kind === 'new' || sheet?.kind === 'edit') && (
        <Sheet label={sheet.kind === 'edit' ? 'Edit bit' : 'Add a bit'} onClose={closeSheet}>
          <BitForm
            initial={sheet.kind === 'edit' ? sheet.bit : undefined}
            units={units}
            onCancel={closeSheet}
            onDone={(input) => {
              const bit = sheet.kind === 'edit' ? state.updateCustomBit(sheet.bit.id, input) : state.addCustomBit(input)
              // Adding a bit of your own means you have it.
              if (bit && sheet.kind === 'new') state.setOwned(bit.id, true)
              setSheet(bit ? { kind: 'bit', id: bit.id } : null)
            }}
          />
        </Sheet>
      )}
    </div>
  )
}

// ---- entry points --------------------------------------------------------

/** The studio dialog (the 'bits' entry of the editor store's Dialog union). */
export function BitLibraryDialog({ units, onClose }: { units: Units; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="bl-dialog" role="dialog" aria-modal="true" aria-label="Bit gallery" onPointerDown={(e) => e.stopPropagation()}>
        <BitLibrary units={units} onClose={onClose} title="Bit Gallery" />
      </div>
    </div>
  )
}

/** The standalone page for route /bits. */
export function BitLibraryPage({ onClose }: { onClose?: () => void }) {
  const [units, setUnits] = useState<Units>(lastUnits())
  return (
    <div className="bl-page">
      <header className="bl-page__head">
        <a className="bl-page__brand" href="/">
          <Ic.FormaLogo size={22} />
          <span>Forma Studio</span>
        </a>
        {onClose && (
          <button type="button" className="ss-btn ss-btn--sm" onClick={onClose}>
            Back
          </button>
        )}
      </header>
      <BitLibrary units={units} onUnitsChange={setUnits} />
    </div>
  )
}
