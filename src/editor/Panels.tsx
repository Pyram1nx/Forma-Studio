import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { activeOrigin, groupOutlineFor, selectedShapes, useStore, withoutCheckpoint, editableIds } from '../state/store'
import type { CutType, Shape, Units } from '../model/types'
import { MM_PER_IN } from '../model/types'
import { fmtNum } from '../model/factory'
import * as Ic from '../ui/icons'
import { anchorPoint, parseLength, resizeSelection, rotateSelection, selectionBBox, type Anchor, type AnchorRef } from './ops'
import { buildFromParams } from './shapeFactory'
import { isBoxJoint, updateBoxJoint } from './boxJointGuides'
import { TEMPLATES } from '../geometry/templates'
import { BITS } from '../features/carve3d/bits'
import FontSelect from './FontSelect'
import { IconEditText } from './fontIcons'

/** Display a length in doc units (number only). */
export const fmtLenValue = (mm: number, units: Units) => fmtNum(mm, units)

/** Run fn; when coalesced, it adds no new undo step. */
const mut = (coalesced: boolean, fn: () => void) => (coalesced ? withoutCheckpoint(fn) : fn())

const UNDO_BURST_MS = 600

// ---------- Number field ----------
export interface NumFieldProps {
  adorn?: ReactNode
  suffix?: string
  value: number | null
  /** 'length' values are mm internally and shown in doc units. */
  kind?: 'length' | 'angle' | 'count' | 'ratio'
  units: Units
  placeholder?: string
  /** Accessible name, e.g. "Width". */
  label: string
  /** coalesced = true for an arrow-key step that follows another step within 600 ms (no new undo entry). */
  onCommit: (v: number, coalesced: boolean) => void
  className?: string
  /** Step for arrow keys (defaults to the same step as the depth +/- buttons). */
  step?: number
}

export function NumField({ adorn, suffix, value, kind = 'length', units, placeholder, label, onCommit, className, step }: NumFieldProps) {
  const fmt = (v: number | null) => {
    if (v == null || !Number.isFinite(v)) return ''
    if (kind === 'length') return fmtLenValue(v, units)
    if (kind === 'angle' || kind === 'ratio') return String(+v.toFixed(2))
    return String(Math.round(v))
  }
  const [text, setText] = useState(fmt(value))
  const edited = useRef(false)
  const cancel = useRef(false)
  const lastStep = useRef(0)
  const [commits, setCommits] = useState(0)
  useEffect(() => {
    if (!edited.current) setText(fmt(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, units, commits])

  const finish = () => {
    const commitIt = edited.current && !cancel.current
    edited.current = false
    cancel.current = false
    if (!commitIt) return setText(fmt(value))
    if (text.trim() === fmt(value)) return // unchanged text: never commit (avoids rounding drift and empty undo steps)
    const t = text.replace(/(\d),(\d)/g, '$1.$2') // accept comma decimals
    const v = kind === 'length' ? parseLength(t, units) : parseFloat(t)
    if (v != null && Number.isFinite(v) && (value == null || Math.abs(v - value) > 1e-9)) {
      onCommit(v, false)
      // Re-show the stored value even when the commit leaves it unchanged (e.g. clamped back to the same bound).
      setCommits((n) => n + 1)
    } else setText(fmt(value))
  }

  const baseStep = step ?? (kind === 'length' ? (units === 'in' ? MM_PER_IN / 16 : 0.5) : 1)

  return (
    <div className={'ss-input ' + (className ?? '')}>
      {adorn != null && <span className="ss-input__adorn">{adorn}</span>}
      <input
        aria-label={label}
        inputMode={kind === 'count' ? 'numeric' : 'decimal'}
        value={text}
        placeholder={placeholder}
        onFocus={(e) => e.target.select()}
        onBlur={finish}
        onChange={(e) => {
          edited.current = true
          setText(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            cancel.current = true
            ;(e.target as HTMLInputElement).blur()
          }
          if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && value != null) {
            e.preventDefault()
            const now = performance.now()
            const coalesced = now - lastStep.current < UNDO_BURST_MS
            lastStep.current = now
            edited.current = false
            onCommit(value + (e.key === 'ArrowUp' ? 1 : -1) * baseStep * (e.shiftKey ? 10 : 1), coalesced)
          }
          e.stopPropagation()
        }}
      />
      <span className="ss-input__adorn">{suffix ?? (kind === 'length' ? units : kind === 'angle' ? 'º' : '')}</span>
    </div>
  )
}

function Field({ label, tab, children }: { label: string; tab?: string; children: ReactNode }) {
  return (
    <div className="ss-field" role="group" aria-label={label} data-tab={tab}>
      <span className="ss-label">{label}</span>
      {children}
    </div>
  )
}

/** Whole-number count with − / + steppers, as in Studio's template panels. */
function StepperParam({ label, value, min = 1, max = 99, suffix, onCommit }: { label: string; value: number; min?: number; max?: number; suffix?: string; onCommit: (v: number, c: boolean) => void }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v)))
  const step = (d: number) => onCommit(clamp(value + d), false)
  // As in Studio the count can also be typed; it commits on Enter or blur and snaps to the allowed range.
  const [text, setText] = useState<string | null>(null)
  const cancel = useRef(false)
  const commitText = () => {
    if (text === null || cancel.current) {
      cancel.current = false
      setText(null)
      return
    }
    const v = parseFloat(text)
    setText(null)
    if (Number.isFinite(v) && clamp(v) !== value) onCommit(clamp(v), false)
  }
  return (
    <div className="ss-stepper">
      <button type="button" className="ss-stepper__btn" aria-label={`Decrease ${label}`} onClick={() => step(-1)}>
        −
      </button>
      <input
        aria-label={label}
        value={text ?? String(value)}
        inputMode="numeric"
        className="ss-stepper__value"
        onFocus={(e) => e.target.select()}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          else if (e.key === 'Escape') {
            cancel.current = true
            ;(e.target as HTMLInputElement).blur()
          }
          e.stopPropagation()
        }}
      />
      {suffix && <span className="ss-stepper__suffix">{suffix}</span>}
      <button type="button" className="ss-stepper__btn" aria-label={`Increase ${label}`} onClick={() => step(1)}>
        +
      </button>
    </div>
  )
}

type ToggleOption = { v: number; label: string; aria?: string; icon?: 'letter' | 'eye' | 'eyeOff'; path?: string }

/** Two- or more-way choice (sharp/smooth, A/B, centers/edges, show/hide) as a segmented control. */
function ToggleParam({ label, options, value, onCommit }: { label: string; options: ToggleOption[]; value: number; onCommit: (v: number) => void }) {
  return (
    <div className="ss-segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          aria-pressed={o.v === value}
          aria-label={o.aria}
          className={'ss-segmented__btn' + (o.v === value ? ' is-active' : '')}
          onClick={() => onCommit(o.v)}
        >
          {o.path ? (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d={o.path} fill="currentColor" fillRule="evenodd" />
            </svg>
          ) : o.icon === 'letter' ? (
            <b className="ss-segmented__letter" aria-hidden="true">
              {o.label}
            </b>
          ) : o.icon === 'eye' ? (
            <Ic.IconEye size={18} />
          ) : o.icon === 'eyeOff' ? (
            <Ic.IconEyeOff size={18} />
          ) : (
            o.label
          )}
        </button>
      ))}
    </div>
  )
}

/**
 * A slider with tick marks (Studio's pin factor): the track fills from the left up to the thumb, and
 * the value shows in a bubble above the thumb only while it is focused or dragged — no fixed readout.
 * Changes within 600 ms of each other are one undo step.
 */
function SliderParam({
  label,
  value,
  min,
  max,
  step,
  marks = [],
  onCommit,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  marks?: number[]
  onCommit: (v: number, coalesced: boolean) => void
}) {
  const last = useRef(0)
  const [focused, setFocused] = useState(false)
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    if (!dragging) return
    const up = () => setDragging(false)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [dragging])
  const at = (v: number) => String(Math.max(0, Math.min(1, (v - min) / (max - min || 1))))
  return (
    <div className="ss-slider" style={{ ['--at' as string]: at(value) }}>
      {marks.map((m) => (
        <span key={m} className="ss-slider__mark" style={{ ['--at' as string]: at(m) }} aria-hidden="true" />
      ))}
      <input
        type="range"
        className="ss-slider__input"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onPointerDown={() => setDragging(true)}
        onChange={(e) => {
          const now = performance.now()
          const coalesced = now - last.current < UNDO_BURST_MS
          last.current = now
          onCommit(Number(e.target.value), coalesced)
        }}
        onKeyDown={(e) => e.stopPropagation()}
      />
      {(focused || dragging) && (
        <span className="ss-slider__bubble" aria-hidden="true">
          {String(+value.toFixed(2))}
        </span>
      )}
    </div>
  )
}

/**
 * A floating panel positioned from an anchor element and rendered in <body>, so the
 * right dock's transform and overflow clipping don't cut it off. Closes on outside
 * pointer-down and on Escape (captured, so the global Escape handler doesn't also run).
 */
export function Floating({
  anchor,
  side,
  className,
  onDismiss,
  children,
}: {
  anchor: HTMLElement
  side: 'left' | 'above'
  className: string
  onDismiss: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = anchor.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const m = 15
    let left = side === 'left' ? r.left - 30 - w : r.left
    let top = side === 'left' ? r.top - 18 : r.top - h - 8
    left = Math.max(m, Math.min(left, window.innerWidth - w - m))
    top = Math.max(m, Math.min(top, window.innerHeight - h - m))
    setPos({ top, left })
  }, [anchor, side])
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.contains(t)) return
      onDismiss()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      onDismiss()
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [anchor, onDismiss])
  return createPortal(
    <div ref={ref} className={className} style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
      {children}
    </div>,
    document.body,
  )
}

const CELL_NAME: Record<Anchor, string> = {
  tl: 'top left',
  tc: 'top centre',
  tr: 'top right',
  ml: 'middle left',
  mc: 'centre',
  mr: 'middle right',
  bl: 'bottom left',
  bc: 'bottom centre',
  br: 'bottom right',
}

/** Shows the current anchor; clicking it enters Shape Anchor mode so the point is picked on the canvas. */
function AnchorButton({ value }: { value: AnchorRef }) {
  const cells: Anchor[] = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br']
  const free = typeof value !== 'string'
  return (
    <div className="anchor-row">
      <button
        className="anchor-btn"
        onClick={() => useStore.getState().setAnchorPicking(true)}
        aria-label={`Anchor: ${free ? 'free point' : CELL_NAME[value]}. Choose on canvas`}
        title="Choose anchor on canvas"
      >
        {free ? (
          <span className="anchor-btn__free" />
        ) : (
          cells.map((c) => <span key={c} className={'anchor-btn__dot' + (c === value ? ' is-active' : '')} />)
        )}
      </button>
      <span className="ss-label" style={{ padding: 0 }}>
        anchor
      </span>
    </div>
  )
}

const mIco = (children: ReactNode) => (
  <svg className="icon" width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
)
const MIcoSize = () => mIco(<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />)
const MIcoHash = () => mIco(<path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16" />)
const MIcoCorner = () => mIco(<path d="M5 20v-6a9 9 0 0 1 9-9h6" />)
const MIcoRotate = () => mIco(<><path d="M20 12a8 8 0 1 1-2.5-5.8" /><path d="M20 4v5h-5" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /></>)

const kindLabel = (s: Shape) => {
  if (s.kind === 'template') return s.name.toLowerCase()
  if (s.kind === 'rect') return s.params?.r ? 'rounded rectangle' : 'rectangle'
  if (s.kind === 'slice') return '3d slice'
  if (s.kind === 'sketch') return 'sketch'
  return s.kind
}

// ---------- Design panel ----------
export function DesignPanel() {
  const doc = useStore((s) => s.doc)
  const selection = useStore((s) => s.selection)
  const mode = useStore((s) => s.mode)
  const tool = useStore((s) => s.tool)
  const dialog = useStore((s) => s.dialog)
  const [lock, setLock] = useState(false)
  // Mobile bottom sheet: active tab and collapsed state (CSS shows these only at <=700px).
  const [mtab, setMtab] = useState('size')
  const [sheetOpen, setSheetOpen] = useState(false)
  useEffect(() => {
    const open = () => {
      if (useStore.getState().selection.length > 0) setSheetOpen(true)
    }
    window.addEventListener('ss:open-props-sheet', open)
    return () => window.removeEventListener('ss:open-props-sheet', open)
  }, [])
  const hasSel = selection.length > 0
  useEffect(() => {
    if (!hasSel) setSheetOpen(false)
  }, [hasSel])
  // The pivot for panel resize and rotate is the document's origin point (picked on the canvas).
  // Computed outside the store selector: activeOrigin returns a new object, which would loop a selector.
  const anchor: AnchorRef = activeOrigin(doc, selection) ?? 'mc'
  const anchorPicking = useStore((s) => s.anchorPicking)
  const sel = selectedShapes({ doc, selection })
  // The Offset panel takes the right dock while it is open.
  if (mode !== 'design' || !sel.length || tool !== 'select' || dialog === 'offset' || anchorPicking) return null
  const units = doc.units
  const b = selectionBBox(sel)
  if (!b) return null
  const w = b.maxX - b.minX
  const h = b.maxY - b.minY
  // A grouped box joint is one object to the user: its settings panel belongs to the group's outline.
  const single = sel.length === 1 ? sel[0] : (groupOutlineFor(doc, selection) ?? null)
  const ids = sel.map((s) => s.id)
  const st = useStore.getState
  // Studio: with a reference in the selection there is no properties panel, only Make Editable.
  const hasRef = sel.some((s) => s.locked)
  const referenceBtn = (
    <button
      className={'reference-btn' + (hasRef ? ' is-active' : '')}
      aria-label={hasRef ? 'Make Editable' : 'Set As Reference & Lock'}
      onClick={() => st().setReferenceSelected(!hasRef)}
    >
      <span className="reference-btn__label" aria-hidden="true">
        {hasRef ? 'Make Editable' : 'Set As Reference & Lock'}
      </span>
      <Ic.IconPathTypeLock size={24} />
    </button>
  )
  if (hasRef) return <div className="right-dock">{referenceBtn}</div>

  const setW = (v: number, c: boolean) => mut(c, () => resizeSelection(ids, Math.max(v, 0.01), lock ? (h * v) / (w || 1) : null, anchor))
  const setH = (v: number, c: boolean) => mut(c, () => resizeSelection(ids, lock ? (w * v) / (h || 1) : null, Math.max(v, 0.01), anchor))

  const setParam = (key: string, v: number, c: boolean) => {
    if (!single || single.locked) return
    // Box joints (basic and pro): Studio's clamps, the pocket, the guides and the anchor move together.
    if (isBoxJoint(single)) return mut(c, () => updateBoxJoint(single.id, { [key]: v }))
    mut(c, () =>
      st().updateShapes([single.id], (s) => {
        const params = { ...s.params!, [key]: v }
        const contours = buildFromParams(s.kind, params)
        return contours ? { ...s, params, contours } : s
      }),
    )
  }

  const tpl = single?.kind === 'template' ? TEMPLATES.find((t) => t.id === single.params?.template) : undefined
  const group = single?.groupId ? doc.groups.find((g) => g.id === single.groupId) : undefined
  const pos = anchorPoint(b, anchor)
  const moveBy = (dx: number, dy: number, c: boolean) => mut(c, () => st().updateShapes(editableIds(ids), (s) => ({ ...s, x: s.x + dx, y: s.y + dy })))

  // Templates use Studio's own settings panel: their parameters, then rotation and anchor. No size fields.
  const isText = single?.kind === 'text'
  const tabs: { id: string; label: string; icon: ReactNode }[] = []
  if (isText) tabs.push({ id: 'font', label: 'Font', icon: <IconEditText width={20} height={20} /> })
  if (!tpl) tabs.push({ id: 'size', label: 'Size', icon: <MIcoSize /> })
  if (single?.kind === 'polygon') tabs.push({ id: 'sides', label: 'Sides', icon: <MIcoHash /> })
  if (single?.kind === 'rect') tabs.push({ id: 'radius', label: 'Radius', icon: <MIcoCorner /> })
  if (tpl) tabs.push({ id: 'params', label: 'Shape', icon: <MIcoHash /> })
  if (tpl?.params.some((p) => p.radiusRow)) tabs.push({ id: 'radius', label: 'Radius', icon: <MIcoCorner /> })
  tabs.push({ id: 'rotation', label: 'Rotation', icon: <MIcoRotate /> })
  tabs.push({ id: 'more', label: 'Position and group', icon: <span className="sheet-tabs__dot" /> })
  const activeTab = tabs.some((t) => t.id === mtab) ? mtab : tpl ? 'params' : isText ? 'font' : 'size'

  return (
    <div className={'right-dock' + (sheetOpen ? ' is-sheet-open' : '')}>
      {referenceBtn}
      <div
        className="ss-panel design-panel"
        data-mtab={activeTab}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="ss-panel__header">
          <span>{single ? kindLabel(single) : `${sel.length} objects`}</span>
          <button className="sheet-collapse" aria-label="Collapse properties" onClick={() => setSheetOpen(false)}>
            <Ic.IconChevronDown size={16} />
          </button>
        </div>
        <div className="sheet-tabs" role="tablist" aria-label="Properties">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={t.id === activeTab} aria-label={t.label} className={'sheet-tabs__tab' + (t.id === activeTab ? ' is-active' : '')} onClick={() => setMtab(t.id)}>
              {t.icon}
              {t.id === 'font' && <span>FONT</span>}
              {t.id === 'size' && <span>SIZE</span>}
            </button>
          ))}
        </div>
        {isText && single && (
          <Field label="font" tab="font">
            <FontSelect key={single.id} shape={single} disabled={single.locked} />
          </Field>
        )}
        {!tpl && (
        <Field label="size" tab="size">
          <div className="size-fields">
            <div className="size-fields__inputs">
              <NumField label="Width" adorn="W" value={w} units={units} onCommit={setW} />
              <NumField label="Height" adorn="H" value={h} units={units} onCommit={setH} />
            </div>
            <button
              className={'lock-ratio' + (lock ? ' is-active' : '')}
              aria-pressed={lock}
              aria-label="Lock aspect ratio"
              title="Lock aspect ratio"
              onClick={() => setLock(!lock)}
            >
              {lock ? <Ic.IconLink size={18} /> : <Ic.IconUnlink size={18} />}
            </button>
          </div>
        </Field>
        )}
        {single?.kind === 'rect' &&<RadiusField key={single.id} shape={single} units={units} onCommit={(v, c) => setParam('r', Math.max(0, v), c)} />}
        {single?.kind === 'polygon' && (
          <Field label="sides" tab="sides">
            <NumField
              label="Sides"
              kind="count"
              adorn="N"
              suffix=""
              value={Number(single.params?.n ?? 6)}
              units={units}
              onCommit={(v, c) => setParam('n', Math.max(3, Math.min(64, Math.round(v))), c)}
            />
          </Field>
        )}
        {tpl &&
          tpl.params
            .filter((p) => !p.showWhen || Number(single!.params?.[p.showWhen.key] ?? 0) >= p.showWhen.min)
            .map((p) => {
            const sub = p.edgeSub && Number(single!.params?.spacing ?? 0) === 1 ? Number(single!.params?.[p.edgeSub] ?? 0) : 0
            const cur = Number(single!.params?.[p.key] ?? p.default) - sub
            const clampTo = (v: number) => Math.max(p.min ?? -Infinity, Math.min(p.max ?? Infinity, v)) + sub
            // Spacing shown as gap between edges rather than centre distance, as in Studio.
            const edges = p.edgeLabel && Number(single!.params?.spacing ?? 0) === 1
            const label = edges ? p.edgeLabel! : p.label
            if (p.radiusRow)
              return <RadiusField key={single!.id} shape={single!} units={units} onCommit={(v, c) => setParam('r', Math.max(0, v), c)} />
            return (
              <Field key={p.key} label={label} tab="params">
                {p.kind === 'toggle' && p.options && p.dropdown ? (
                  <select className="ss-select" aria-label={p.label} value={cur} onChange={(e) => setParam(p.key, Number(e.target.value), false)}>
                    {p.options.map((o) => (
                      <option key={o.v} value={o.v}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : p.kind === 'toggle' && p.options ? (
                  <ToggleParam label={p.label} options={p.options} value={cur} onCommit={(v) => setParam(p.key, v, false)} />
                ) : p.kind === 'slider' ? (
                  p.reverse ? (
                    <SliderParam
                      label={label}
                      value={-cur}
                      min={-(p.max ?? 1)}
                      max={-(p.min ?? 0)}
                      step={p.step ?? 0.01}
                      marks={p.marks?.map((m) => -m)}
                      onCommit={(v, c) => setParam(p.key, -v, c)}
                    />
                  ) : (
                    <SliderParam label={label} value={cur} min={p.min ?? 0} max={p.max ?? 1} step={p.step ?? 0.01} marks={p.marks} onCommit={(v, c) => setParam(p.key, v, c)} />
                  )
                ) : p.kind === 'count' ? (
                  <StepperParam label={label} value={cur} min={p.min} max={p.max} suffix={p.adorn} onCommit={(v, c) => setParam(p.key, v, c)} />
                ) : (
                  <NumField
                    label={label}
                    adorn={edges && p.edgeAdorn ? p.edgeAdorn : p.adorn}
                    kind={p.kind === 'toggle' ? 'count' : p.kind}
                    value={cur}
                    units={units}
                    step={p.kind === 'ratio' ? 0.05 : p.kind === 'angle' ? 1 : undefined}
                    onCommit={(v, c) => setParam(p.key, clampTo(v), c)}
                  />
                )}
              </Field>
            )
          })}
        <Field label="rotation" tab="rotation">
          {/* Single: absolute angle. Multi: "—" placeholder and the typed value is applied as a delta. */}
          <NumField
            label="Rotation"
            kind="angle"
            adorn="A"
            value={single ? single.rotation : null}
            placeholder="—"
            units={units}
            step={1}
            onCommit={(v, c) => mut(c, () => rotateSelection(ids, v, anchor, !!single))}
          />
        </Field>
        {doc.settings.showPosition && (
          <Field label="position" tab="more">
            <div className="size-fields__inputs">
              <NumField label="Position X" adorn="X" value={pos.x} units={units} onCommit={(v, c) => moveBy(v - pos.x, 0, c)} />
              <NumField label="Position Y" adorn="Y" value={pos.y} units={units} onCommit={(v, c) => moveBy(0, v - pos.y, c)} />
            </div>
          </Field>
        )}
        <div data-tab="more" className="sheet-more">
          <AnchorButton value={anchor} />
        </div>
        {group && (
          <div className="group-info" data-tab="more">
            <div className="group-info__name">
              <Ic.IconLayers size={16} /> {group.name}
            </div>
            {single?.meta?.note && <div className="ss-muted">{single.meta.note}</div>}
            <button className="ss-btn ss-btn--sm ss-btn--block" onClick={() => st().selectGroup(group.id)}>
              Select Group
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function RadiusField({ shape, units, onCommit }: { shape: Shape; units: Units; onCommit: (v: number, c: boolean) => void }) {
  const r = Number(shape.params?.r ?? 0)
  const [show, setShow] = useState(r > 0)
  if (!show)
    return (
      <button className="radius-add" data-tab="radius" onClick={() => setShow(true)} aria-label="Add radius">
        <span>radius</span>
        <Ic.IconPlus size={14} />
      </button>
    )
  return (
    <Field label="radius" tab="radius">
      <NumField label="Radius" adorn="R" value={r} units={units} onCommit={onCommit} />
    </Field>
  )
}

// ---------- Plan panel ----------
export const CUT_TYPES: { id: CutType; label: string; icon: ReactNode }[] = [
  { id: 'online', label: 'On Line', icon: <Ic.IconCutOnline size={18} /> },
  { id: 'guide', label: 'Guide', icon: <Ic.IconCutGuide size={18} /> },
  { id: 'inside', label: 'Inside', icon: <Ic.IconCutInside size={18} /> },
  { id: 'pocket', label: 'Pocket', icon: <Ic.IconCutPocket size={18} /> },
  { id: 'outside', label: 'Outside', icon: <Ic.IconCutOutside size={18} /> },
]

// Studio's preset glyphs: fractions for inch, the engraving bit for the 0.5 mm preset.
const BIT_PRESETS: Record<Units, { label: string; mm: number; icon?: ReactNode }[]> = {
  in: [
    { label: '0.02', mm: 0.508, icon: <Ic.IconBit size={20} /> },
    { label: '⅛', mm: 3.175, icon: <Ic.IconBitEighth size={20} /> },
    { label: '¼', mm: 6.35, icon: <Ic.IconBitQuarter size={20} /> },
    { label: '½', mm: 12.7, icon: <Ic.IconBitHalf size={20} /> },
  ],
  mm: [
    { label: '0.5', mm: 0.5, icon: <Ic.IconBitEngraveMm size={20} /> },
    { label: '3', mm: 3 },
    { label: '6', mm: 6 },
    { label: '8', mm: 8 },
  ],
}

export function PlanPanel() {
  const doc = useStore((s) => s.doc)
  const selection = useStore((s) => s.selection)
  const mode = useStore((s) => s.mode)
  const [open, setOpen] = useState(false)
  const [bitsOpen, setBitsOpen] = useState(false)
  const [typeBtn, setTypeBtn] = useState<HTMLButtonElement | null>(null)
  const dismissType = () => setOpen(false)
  const sel = selectedShapes({ doc, selection })
  if (mode !== 'plan' || !sel.length) return null
  const units = doc.units
  const ids = sel.map((s) => s.id)
  const st = useStore.getState
  const first = sel[0]
  const same = <K extends keyof Shape['cut']>(k: K) => (sel.every((s) => s.cut[k] === first.cut[k]) ? first.cut[k] : null)
  const type = same('type') as CutType | null
  const depth = same('depth') as number | null
  const offset = same('offset') as number | null
  const bit = same('bitDia') as number | null
  const allOpen = sel.every((s) => s.contours.every((c) => !c.closed))
  const types = allOpen ? CUT_TYPES.filter((t) => t.id === 'online' || t.id === 'guide') : CUT_TYPES
  const cur = CUT_TYPES.find((t) => t.id === type)
  const step = units === 'in' ? MM_PER_IN / 16 : 0.5
  const bitInfo = bit != null ? BITS.find((b) => Math.abs(b.diameter - bit) < 0.01) : undefined
  const tooDeep = depth != null && bitInfo != null && depth > bitInfo.fluteLength + 1e-6

  // Open paths cannot be inside/outside/pocket: those shapes fall back to on-line.
  const pickType = (t: CutType) => {
    st().updateShapes(ids, (s) => {
      const isOpen = s.contours.every((c) => !c.closed)
      const next = isOpen && t !== 'online' && t !== 'guide' ? 'online' : t
      return { ...s, cut: { ...s.cut, type: next } }
    })
    setOpen(false)
  }

  return (
    <div className="right-dock">
      <div className="ss-panel plan-panel" onPointerDown={(e) => e.stopPropagation()}>
        <Field label="cut type">
          <div className="cut-type-select">
            <button
              ref={setTypeBtn}
              className={'cut-type-select__btn' + (open ? ' is-open' : '')}
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-label={`Cut type: ${cur?.label ?? 'mixed'}`}
              onClick={() => setOpen(!open)}
            >
              {cur?.icon ?? <Ic.IconCutMixed size={18} />}
              <span>{cur?.label ?? 'mixed'}</span>
              <Ic.IconChevronDown size={16} className={'icon cut-type-select__chev' + (open ? ' is-open' : '')} />
            </button>
            {open && typeBtn && (
              <Floating anchor={typeBtn} side="left" className="cut-type-menu" onDismiss={dismissType}>
                {types.map((t) => (
                  <button key={t.id} className={'cut-type-menu__item' + (t.id === type ? ' is-active' : '')} aria-current={t.id === type} onClick={() => pickType(t.id)}>
                    {t.icon}
                    <span>{t.label}</span>
                  </button>
                ))}
              </Floating>
            )}
          </div>
        </Field>
        {type !== 'guide' && (
          <>
            <Field label="depth">
              <div className="stepper">
                <button
                  aria-label="Decrease depth"
                  onClick={() =>
                    // Step each shape on its own, so a mixed selection keeps its differences; unset stays unset.
                    st().updateShapes(ids, (s) => ({ ...s, cut: { ...s.cut, depth: s.cut.depth == null ? null : Math.max(0, s.cut.depth - step) || null } }))
                  }
                >
                  −
                </button>
                <NumField
                  label="Depth"
                  value={depth}
                  units={units}
                  step={step}
                  placeholder={sel.some((x) => x.cut.depth !== first.cut.depth) ? 'mixed' : 'unset'}
                  suffix=""
                  onCommit={(v, c) => mut(c, () => st().setCut(ids, { depth: v > 0 ? v : null }))}
                  className="stepper__input"
                />
                <button
                  aria-label="Increase depth"
                  onClick={() => st().updateShapes(ids, (s) => ({ ...s, cut: { ...s.cut, depth: (s.cut.depth ?? 0) + step } }))}
                >
                  +
                </button>
              </div>
              {tooDeep && bitInfo && (
                <div className="plan-warn">
                  Deeper than the {bitInfo.name} flute ({fmtLenValue(bitInfo.fluteLength, units)} {units}).
                </div>
              )}
            </Field>
            <Field label="offset">
              <div className="offset-field">
                <button
                  className="offset-field__flip"
                  aria-label="Flip offset direction"
                  title="Flip offset direction"
                  disabled={!offset}
                  onClick={() => st().setCut(ids, { offset: -(offset ?? 0) })}
                >
                  <Ic.IconFlipOffset size={16} />
                </button>
                <NumField label="Offset" value={offset} units={units} onCommit={(v, c) => mut(c, () => st().setCut(ids, { offset: v }))} />
              </div>
            </Field>
            <Field label="bit diameter">
              <NumField label="Bit diameter" adorn="D" value={bit} units={units} onCommit={(v, c) => v > 0 && mut(c, () => st().setCut(ids, { bitDia: v }))} />
            </Field>
            <div className="bit-presets">
              <button className={'bit-presets__lib' + (bitsOpen ? ' is-active' : '')} aria-label="Bit library" aria-expanded={bitsOpen} title="Bit library" onClick={() => setBitsOpen(!bitsOpen)}>
                <Ic.IconBitLibrary size={20} />
              </button>
              {BIT_PRESETS[units].map((p) => (
                <button
                  key={p.label}
                  aria-label={`Bit diameter ${p.label}`}
                  aria-pressed={bit != null && Math.abs(bit - p.mm) < 0.01}
                  className={'bit-presets__btn' + (bit != null && Math.abs(bit - p.mm) < 0.01 ? ' is-active' : '')}
                  onClick={() => st().setCut(ids, { bitDia: p.mm })}
                >
                  {p.icon ?? p.label}
                </button>
              ))}
            </div>
            {bitsOpen && (
              <div className="bit-lib">
                {BITS.map((b) => (
                  <button
                    key={b.id}
                    className={'bit-lib__item' + (bit != null && Math.abs(bit - b.diameter) < 0.01 ? ' is-active' : '')}
                    onClick={() => {
                      st().setCut(ids, { bitDia: b.diameter })
                      setBitsOpen(false)
                    }}
                  >
                    {b.name}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {sel.length === 1 && first.meta?.note && <div className="plan-note">{first.meta.note}</div>}
      </div>
    </div>
  )
}
