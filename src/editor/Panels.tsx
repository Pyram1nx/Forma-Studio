import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { activeOrigin, groupOutlineFor, selectedShapes, useStore, withoutCheckpoint, editableIds } from '../state/store'
import type { CutType, Shape, Units } from '../model/types'
import { MM_PER_IN } from '../model/types'
import { fmtNum } from '../model/factory'
import * as Ic from '../ui/icons'
import { worldD } from './geomCache'
import { anchorBBox, anchorPoint, parseLength, resizeSelection, rotateSelection, selectionBBox, type Anchor, type AnchorRef } from './ops'
import { buildFromParams } from './shapeFactory'
import { isBoxJoint, updateBoxJoint } from './boxJointGuides'
import { TEMPLATES } from '../geometry/templates'
import { polygonUnitSize } from '../geometry/primitives'
import { BITS } from '../features/carve3d/bits'
import { suggestBits, useBitLibrary } from '../features/bitlibrary/library'
import FontSelect from './FontSelect'
import { IconEditText } from './fontIcons'
import { isMixed, presetLabel, radiusValues, RADIUS_PRESETS, VERTEX_KINDS } from './radius'

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
  onFocus?: () => void
  onBlur?: () => void
}

export function NumField({ adorn, suffix, value, kind = 'length', units, placeholder, label, onCommit, className, step, onFocus, onBlur }: NumFieldProps) {
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
        onFocus={(e) => {
          e.target.select()
          onFocus?.()
        }}
        onBlur={() => {
          finish()
          onBlur?.()
        }}
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
export function StepperParam({ label, value, min = 1, max = 99, suffix, onCommit }: { label: string; value: number; min?: number; max?: number; suffix?: string; onCommit: (v: number, c: boolean) => void }) {
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

/** Studio's A / B side glyphs (20px icons, not text), as drawn in its box joint panel. */
const LETTER_GLYPHS: Record<string, string> = {
  A: 'M13.2898 16.98L12.2898 13.66H7.6298L6.6298 16.98H3.5498L8.1498 3.02002H11.9098L16.4498 16.98H13.2898ZM9.9898 5.78002H9.8898L8.3498 11.08H11.5498L9.9898 5.78002Z',
  B: 'M4.5 3.02002H11.28C12.44 3.02002 13.34 3.34669 13.98 4.00002C14.6333 4.65335 14.96 5.52002 14.96 6.60002C14.96 7.13335 14.8867 7.58669 14.74 7.96002C14.6067 8.33335 14.42 8.64002 14.18 8.88002C13.9533 9.12002 13.68 9.30002 13.36 9.42002C13.0533 9.52669 12.72 9.58669 12.36 9.60002V9.72002C12.6933 9.72002 13.04 9.78002 13.4 9.90002C13.7733 10.02 14.1133 10.2134 14.42 10.48C14.7267 10.7334 14.98 11.0667 15.18 11.48C15.3933 11.8934 15.5 12.4 15.5 13C15.5 13.5467 15.4067 14.0667 15.22 14.56C15.0467 15.04 14.8 15.46 14.48 15.82C14.16 16.18 13.78 16.4667 13.34 16.68C12.9 16.88 12.42 16.98 11.9 16.98H4.5V3.02002ZM7.54 14.42H11.04C11.44 14.42 11.7533 14.3134 11.98 14.1C12.22 13.8734 12.34 13.56 12.34 13.16V12.48C12.34 12.08 12.22 11.7734 11.98 11.56C11.7533 11.3334 11.44 11.22 11.04 11.22H7.54V14.42ZM7.54 8.74002H10.56C10.96 8.74002 11.2733 8.62669 11.5 8.40002C11.7267 8.17335 11.84 7.86002 11.84 7.46002V6.86002C11.84 6.46002 11.7267 6.14669 11.5 5.92002C11.2733 5.69335 10.96 5.58002 10.56 5.58002H7.54V8.74002Z',
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
          ) : o.icon === 'letter' && LETTER_GLYPHS[o.label] ? (
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d={LETTER_GLYPHS[o.label]} />
            </svg>
          ) : o.icon === 'letter' ? (
            <b className="ss-segmented__letter" aria-hidden="true">
              {o.label}
            </b>
          ) : o.icon === 'eye' ? (
            <Ic.IconEye size={20} />
          ) : o.icon === 'eyeOff' ? (
            <Ic.IconEyeOff size={20} />
          ) : (
            o.label
          )}
        </button>
      ))}
    </div>
  )
}

/**
 * Studio's slider (an MUI slider with the heart's tail curl / pin factor look): an 8px rail, the 20px thumb
 * travelling the whole rail width (its centre sits on the rail ends), tick marks that turn light blue once the
 * thumb is past them, and the value in a bubble above the thumb while it is hovered, focused or dragged.
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
  const root = useRef<HTMLSpanElement>(null)
  const [hover, setHover] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dragging, setDragging] = useState(false)
  const span = max - min || 1
  const pct = (v: number) => Math.max(0, Math.min(1, (v - min) / span)) * 100
  const snap = (v: number) => {
    const n = Math.round((v - min) / step)
    return Math.max(min, Math.min(max, +(min + n * step).toFixed(6)))
  }
  const commit = (v: number) => {
    const next = snap(v)
    if (next === value) return
    const now = performance.now()
    const coalesced = now - last.current < UNDO_BURST_MS
    last.current = now
    onCommit(next, coalesced)
  }
  const fromPointer = (clientX: number) => {
    const r = root.current!.getBoundingClientRect()
    commit(min + ((clientX - r.left) / (r.width || 1)) * span)
  }
  const onKey = (e: React.KeyboardEvent) => {
    const big = (max - min) / 10
    const to: Record<string, number> = {
      ArrowLeft: value - step,
      ArrowDown: value - step,
      ArrowRight: value + step,
      ArrowUp: value + step,
      PageDown: value - big,
      PageUp: value + big,
      Home: min,
      End: max,
    }
    e.stopPropagation()
    if (!(e.key in to)) return
    e.preventDefault()
    commit(to[e.key])
  }
  const open = hover || focused || dragging
  return (
    <span
      ref={root}
      className={'ss-slider' + (dragging ? ' is-dragging' : '')}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        ;(e.currentTarget.querySelector('.ss-slider__thumb') as HTMLElement).focus({ preventScroll: true })
        setDragging(true)
        fromPointer(e.clientX)
      }}
      onPointerMove={(e) => dragging && fromPointer(e.clientX)}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
    >
      <span className="ss-slider__rail" />
      {marks.map((m) => (
        <span key={m} className={'ss-slider__mark' + (m <= value ? ' is-active' : '')} style={{ left: `${pct(m)}%` }} aria-hidden="true" />
      ))}
      <span
        className="ss-slider__thumb"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        style={{ left: `${pct(value)}%` }}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKey}
      >
        <span className={'ss-slider__bubble' + (open ? ' is-open' : '')} aria-hidden="true">
          {String(+value.toFixed(2))}
        </span>
      </span>
    </span>
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
function AnchorButton({ value, inline }: { value: AnchorRef; inline?: boolean }) {
  const cells: Anchor[] = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br']
  const free = typeof value !== 'string'
  const btn = (
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
  )
  if (inline) return btn
  return (
    <div className="anchor-row">
      {btn}
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
  // Studio opens a polygon with its size fields linked.
  const polygonId = sel.length === 1 && sel[0].kind === 'polygon' ? sel[0].id : ''
  useEffect(() => {
    if (polygonId) setLock(true)
  }, [polygonId])
  // The Offset panel takes the right dock while it is open.
  if (mode !== 'design' || !sel.length || tool !== 'select' || dialog === 'offset' || dialog === 'radius' || anchorPicking) return null
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
  // Studio shows how many objects are selected beside the reference button (a group counts once).
  const selUnits = new Set(sel.map((s) => (s.groupId && mode === 'design' ? 'g:' + s.groupId : s.id))).size
  const countBadge = selUnits > 1 ? <span className="selection-count">{selUnits}</span> : null
  if (hasRef) return <div className="right-dock">{referenceBtn}</div>

  const setW = (v: number, c: boolean) => mut(c, () => resizeSelection(ids, Math.max(v, 0.01), lock ? (h * v) / (w || 1) : null, anchor))
  const setH = (v: number, c: boolean) => mut(c, () => resizeSelection(ids, lock ? (w * v) / (h || 1) : null, Math.max(v, 0.01), anchor))

  const setParam = (key: string, v: number, c: boolean) => {
    if (!single || single.locked) return
    // Box joints (basic and pro): Studio's clamps, the pocket, the guides and the anchor move together.
    if (isBoxJoint(single)) return mut(c, () => updateBoxJoint(single.id, { [key]: v }))
    const t = single.kind === 'template' ? TEMPLATES.find((x) => x.id === single.params?.template) : undefined
    mut(c, () =>
      st().updateShapes([single.id], (s) => {
        let params: Record<string, number | string | boolean> = { ...s.params!, [key]: v }
        if (s.kind === 'polygon' && key === 'n') {
          // Studio keeps the polygon's stretch when the side count changes, so the size follows the new shape.
          const a = polygonUnitSize(Number(s.params!.n ?? 5))
          const z = polygonUnitSize(v)
          params.w = (Number(s.params!.w) / a.w) * z.w
          params.h = (Number(s.params!.h) / a.h) * z.h
        }
        if (t?.constrain) {
          // Studio's own limits: some edits are refused, others carry the neighbouring params along.
          const nums: Record<string, number> = {}
          for (const d of t.params) nums[d.key] = Number(s.params![d.key] ?? d.default)
          const next = t.constrain(nums, key, v)
          if (!next) return s
          params = { ...s.params!, ...next }
        }
        const contours = buildFromParams(s.kind, params)
        return contours ? { ...s, params, contours } : s
      }),
    )
  }

  // Uniform radius from the field: every corner takes it and the Custom Radius corners are dropped.
  const setRadius = (v: number, c: boolean) => {
    if (!single || single.locked) return
    mut(c, () =>
      st().updateShapes([single.id], (s) => {
        const params: Record<string, number | string | boolean> = { ...s.params!, r: Math.max(0, v) }
        delete params.cr
        const contours = buildFromParams(s.kind, params)
        return contours ? { ...s, params, contours } : s
      }),
    )
  }

  const tpl = single?.kind === 'template' ? TEMPLATES.find((t) => t.id === single.params?.template) : undefined
  const group = single?.groupId ? doc.groups.find((g) => g.id === single.groupId) : undefined
  const pos = anchorPoint(anchorBBox(sel, b), anchor)
  const moveBy = (dx: number, dy: number, c: boolean) => mut(c, () => st().updateShapes(editableIds(ids), (s) => ({ ...s, x: s.x + dx, y: s.y + dy })))

  // Templates use Studio's own settings panel: their parameters, then rotation and anchor. No size fields.
  const isText = single?.kind === 'text'
  const tabs: { id: string; label: string; icon: ReactNode }[] = []
  if (isText) tabs.push({ id: 'font', label: 'Font', icon: <IconEditText width={20} height={20} /> })
  if (!tpl) tabs.push({ id: 'size', label: 'Size', icon: <MIcoSize /> })
  if (single?.kind === 'polygon') tabs.push({ id: 'sides', label: 'Sides', icon: <MIcoHash /> })
  if (single && VERTEX_KINDS.includes(single.kind)) tabs.push({ id: 'radius', label: 'Radius', icon: <MIcoCorner /> })
  if (tpl) tabs.push({ id: 'params', label: 'Shape', icon: <MIcoHash /> })
  if (tpl?.params.some((p) => p.radiusRow)) tabs.push({ id: 'radius', label: 'Radius', icon: <MIcoCorner /> })
  tabs.push({ id: 'rotation', label: 'Rotation', icon: <MIcoRotate /> })
  tabs.push({ id: 'more', label: 'Position and group', icon: <span className="sheet-tabs__dot" /> })
  const activeTab = tabs.some((t) => t.id === mtab) ? mtab : tpl ? 'params' : isText ? 'font' : 'size'

  return (
    <div className={'right-dock' + (sheetOpen ? ' is-sheet-open' : '')}>
      <div className="right-dock__head">
        {referenceBtn}
        {countBadge}
      </div>
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
        {single?.kind === 'polygon' && (
          <Field label="sides" tab="sides">
            <StepperParam label="Sides" value={Number(single.params?.n ?? 5)} min={3} max={500} onCommit={(v, c) => setParam('n', v, c)} />
          </Field>
        )}
        {single && VERTEX_KINDS.includes(single.kind) && <RadiusField key={single.id} shape={single} units={units} onCommit={setRadius} />}
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
              return <RadiusField key={single!.id} shape={single!} units={units} onCommit={setRadius} />
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
                  <SliderParam label={label} value={cur} min={p.min ?? 0} max={p.max ?? 1} step={p.step ?? 0.01} marks={p.marks} onCommit={(v, c) => setParam(p.key, v, c)} />
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
            <div className="size-fields">
              <div className="size-fields__inputs">
                <NumField label="Position X" adorn="X" value={pos.x} units={units} onCommit={(v, c) => moveBy(v - pos.x, 0, c)} />
                <NumField label="Position Y" adorn="Y" value={pos.y} units={units} onCommit={(v, c) => moveBy(0, v - pos.y, c)} />
              </div>
              <AnchorButton value={anchor} inline />
            </div>
          </Field>
        )}
        {!doc.settings.showPosition && (
          <div data-tab="more" className="sheet-more">
            <AnchorButton value={anchor} />
          </div>
        )}
        {group && !doc.shapes.some((s) => s.groupId === group.id && isBoxJoint(s)) && (
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
  const vals = radiusValues(shape)
  const mixed = isMixed(vals)
  const [show, setShow] = useState(vals.some((v) => v > 0))
  const [presets, setPresets] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const [justAdded, setJustAdded] = useState(false)
  // Studio's "+" opens the field already focused, with the preset list beside it.
  useEffect(() => {
    if (justAdded && show) {
      rowRef.current?.querySelector('input')?.focus()
      setJustAdded(false)
    }
  }, [justAdded, show])
  if (!show)
    return (
      <button
        className="radius-add"
        data-tab="radius"
        onClick={() => {
          setShow(true)
          setJustAdded(true)
        }}
        aria-label="Add radius"
      >
        <span>radius</span>
        <Ic.IconPlus size={14} />
      </button>
    )
  const pick = (mm: number) => {
    setPresets(false)
    onCommit(mm, false)
  }
  return (
    <Field label="radius" tab="radius">
      <div className="radius-row" ref={rowRef}>
        <NumField
          label="Radius"
          adorn="R"
          value={mixed ? null : vals[0]}
          placeholder={mixed ? 'mixed' : undefined}
          units={units}
          onCommit={(v, c) => {
            setPresets(false)
            onCommit(v, c)
          }}
          onFocus={() => setPresets(true)}
          onBlur={() => setPresets(false)}
        />
        {VERTEX_KINDS.includes(shape.kind) && (
          <button className="radius-edit" aria-label="Custom Radius" title="Custom Radius" onClick={() => useStore.getState().openDialog('radius')}>
            <MIcoCorner />
          </button>
        )}
        {presets &&
          rowRef.current &&
          // The panel scrolls and would clip it, so it is portalled out and placed beside the field.
          // Mousedown keeps focus in the field, so the field's blur does not close the list before a preset is picked.
          createPortal(
          <div className="radius-presets" style={presetPos(rowRef.current)} onMouseDown={(e) => e.preventDefault()}>
            <div className="radius-presets__title">presets</div>
            <div className="radius-presets__grid">
              {RADIUS_PRESETS.map((p) => (
                <button key={p.label} type="button" className="radius-presets__item" onClick={() => pick(p.inches * MM_PER_IN)}>
                  {presetLabel(p, units)}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
      </div>
    </Field>
  )
}

/** Studio opens the preset list to the left of the panel, centred on the radius field and overlapping the panel's edge. */
function presetPos(row: HTMLElement): CSSProperties {
  const r = row.getBoundingClientRect()
  return { top: r.top + r.height / 2, left: r.left - 7 - 180 }
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
export const BIT_PRESETS: Record<Units, { label: string; mm: number; icon?: ReactNode }[]> = {
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

type PlanTab = 'type' | 'depth' | 'offset' | 'bit'

// Studio's mobile cut-properties tabs. The active tab shows its label; the others show only the glyph.
const PLAN_TABS: { id: PlanTab; label: string; icon: ReactNode }[] = [
  { id: 'type', label: 'Cut Type', icon: <Ic.IconCutLines size={20} /> },
  { id: 'depth', label: 'Cut Depth', icon: <Ic.IconArrowDown size={20} /> },
  { id: 'offset', label: 'Offset', icon: <Ic.IconOffsetArrow size={20} /> },
  { id: 'bit', label: 'Bit Diameter', icon: <Ic.IconDiameter size={20} /> },
]

/** Title row with the collapse chevron. The sheet shows it on mobile only (CSS). */
function PlanSheetHead({ title, onCollapse }: { title: string; onCollapse: () => void }) {
  return (
    <div className="plan-sheet-head">
      <span className="ss-panel__header">{title}</span>
      <button className="sheet-collapse" aria-label={`Hide ${title}`} onClick={onCollapse}>
        <Ic.IconChevronDown size={14} />
      </button>
    </div>
  )
}

/** A shape's outline, fitted to its tile. */
function ShapeThumb({ s }: { s: Shape }) {
  const b = selectionBBox([s])
  if (!b) return null
  const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.08 || 0.1
  return (
    <svg
      className="manage-tile__svg"
      viewBox={`${b.minX - pad} ${b.minY - pad} ${b.maxX - b.minX + pad * 2} ${b.maxY - b.minY + pad * 2}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <path d={worldD(s)} fillRule="evenodd" />
    </svg>
  )
}

/**
 * Studio's Manage Selection view: a tile per selected shape. Tap a tile to deselect that shape;
 * tap and hold it to light the shape on the canvas.
 */
function ManageSelection({ onCollapse }: { onCollapse: () => void }) {
  const shapes = useStore((s) => s.doc.shapes)
  const selection = useStore((s) => s.selection)
  const picked = selection.map((id) => shapes.find((s) => s.id === id)).filter((s): s is Shape => s != null)
  const holdTimer = useRef(0)
  const held = useRef(false)
  const endHold = () => {
    window.clearTimeout(holdTimer.current)
    useStore.getState().setPlanHighlight(null)
  }
  // A held tile lights its shape until the pointer lifts, and never clears the cut path after the view closes.
  useEffect(() => endHold, [])
  return (
    <div className="ss-panel manage-panel" onPointerDown={(e) => e.stopPropagation()}>
      <PlanSheetHead title="Manage Selection" onCollapse={onCollapse} />
      <p className="manage-panel__hint">Tap to deselect, tap and hold to highlight</p>
      <div className="manage-grid">
        {picked.map((s) => (
          <button
            key={s.id}
            className="manage-tile"
            aria-label={`Deselect ${kindLabel(s)}`}
            onPointerDown={() => {
              held.current = false
              holdTimer.current = window.setTimeout(() => {
                held.current = true
                useStore.getState().setPlanHighlight(s.id)
              }, 400)
            }}
            onPointerUp={endHold}
            onPointerLeave={endHold}
            onPointerCancel={endHold}
            onClick={() => {
              // The click that ends a hold only ends the highlight; it does not deselect.
              if (held.current) {
                held.current = false
                return
              }
              useStore.getState().select(selection.filter((id) => id !== s.id))
            }}
          >
            <ShapeThumb s={s} />
          </button>
        ))}
      </div>
    </div>
  )
}

export function PlanPanel() {
  const doc = useStore((s) => s.doc)
  const selection = useStore((s) => s.selection)
  const mode = useStore((s) => s.mode)
  const [open, setOpen] = useState(false)
  const [bitsOpen, setBitsOpen] = useState(false)
  const [typeBtn, setTypeBtn] = useState<HTMLButtonElement | null>(null)
  const libOwned = useBitLibrary((s) => s.owned)
  const libCustom = useBitLibrary((s) => s.custom)
  // Desktop shows every field. The mobile sheet shows one tab at a time and can be collapsed.
  const [ptab, setPtab] = useState<PlanTab>('type')
  const [sheetOpen, setSheetOpen] = useState(true)
  const [manage, setManage] = useState(false)
  useEffect(() => {
    const showSheet = () => {
      if (useStore.getState().selection.length > 0) setSheetOpen(true)
    }
    window.addEventListener('ss:open-props-sheet', showSheet)
    return () => window.removeEventListener('ss:open-props-sheet', showSheet)
  }, [])
  // Manage Selection only lives in plan mode, and closes when the selection empties.
  useEffect(() => {
    if (mode !== 'plan' || !selection.length) setManage(false)
  }, [mode, selection.length])
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

  // The bit library dropdown: owned bits first, then the best owned bit for this cut.
  const isOwned = (id: string) => libOwned[id] != null
  const libBits = [...BITS, ...libCustom].sort((a, b) => (isOwned(b.id) ? 1 : 0) - (isOwned(a.id) ? 1 : 0))
  const suggested = type != null ? suggestBits({ owned: libOwned, custom: libCustom }, { depthMm: depth ?? undefined, use: type })[0] : undefined
  const suggestDifferent = suggested != null && suggested.fits && (bit == null || Math.abs(suggested.bit.diameter - bit) >= 0.01)

  // Open paths cannot be inside/outside/pocket: those shapes fall back to on-line.
  const pickType = (t: CutType) => {
    st().updateShapes(ids, (s) => {
      const isOpen = s.contours.every((c) => !c.closed)
      const next = isOpen && t !== 'online' && t !== 'guide' ? 'online' : t
      return { ...s, cut: { ...s.cut, type: next } }
    })
    setOpen(false)
  }

  // A guide has only a cut type, so the other tabs go.
  const tabs = type === 'guide' ? PLAN_TABS.slice(0, 1) : PLAN_TABS
  const activeTab = tabs.some((t) => t.id === ptab) ? ptab : 'type'
  const dockCls = 'right-dock plan-dock' + (manage ? ' is-manage' : '') + (sheetOpen ? '' : ' is-sheet-closed')
  // Studio's pencil: from the Manage Selection view it returns to the properties; on mobile it reopens a collapsed sheet.
  const editBtn = (
    <button
      className="plan-dock__edit"
      aria-label="Edit cut properties"
      title="Edit cut properties"
      onClick={() => {
        setManage(false)
        setSheetOpen(true)
      }}
    >
      <Ic.IconPencil size={18} />
    </button>
  )

  return (
    <div className={dockCls}>
      {!manage && (
        <button className="selection-editor-button" aria-label="Manage Selection" title="Manage Selection" onClick={() => setManage(true)}>
          {sel.length}
        </button>
      )}
      {editBtn}
      {manage ? (
        <ManageSelection onCollapse={() => setSheetOpen(false)} />
      ) : (
        <div className="ss-panel plan-panel" data-ptab={activeTab} onPointerDown={(e) => e.stopPropagation()}>
          <PlanSheetHead title="cut properties" onCollapse={() => setSheetOpen(false)} />
          <div className="sheet-tabs" role="tablist" aria-label="Cut properties">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={t.id === activeTab}
                aria-label={t.label}
                className={'sheet-tabs__tab' + (t.id === activeTab ? ' is-active' : '')}
                onClick={() => setPtab(t.id)}
              >
                {t.icon}
                <span className="sheet-tabs__label">{t.label}</span>
              </button>
            ))}
          </div>
          <div data-ptab-field="type">
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
          </div>
          {type !== 'guide' && (
            <>
              <div data-ptab-field="depth">
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
              </div>
              <div data-ptab-field="offset">
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
              </div>
              <div data-ptab-field="bit">
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
                    {suggestDifferent && suggested && (
                      <button
                        className="bit-lib__item bit-lib__sugg"
                        title={suggested.reasons.join(' · ')}
                        onClick={() => {
                          st().setCut(ids, { bitDia: suggested.bit.diameter })
                          setBitsOpen(false)
                        }}
                      >
                        <span className="bit-lib__sugg-label">Suggested</span>
                        {suggested.bit.name}
                        <span className="bit-lib__sugg-why">{suggested.reasons[0]}</span>
                      </button>
                    )}
                    {libBits.map((b) => (
                      <button
                        key={b.id}
                        className={'bit-lib__item' + (bit != null && Math.abs(bit - b.diameter) < 0.01 ? ' is-active' : '')}
                        onClick={() => {
                          st().setCut(ids, { bitDia: b.diameter })
                          setBitsOpen(false)
                        }}
                      >
                        {isOwned(b.id) && <span className="bit-lib__dot" title="In your bit gallery" />}
                        {b.name}
                      </button>
                    ))}
                    <button className="bit-lib__item bit-lib__open" onClick={() => st().openDialog('bits')}>
                      <Ic.IconBitLibrary size={14} /> Open bit gallery…
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
          {sel.length === 1 && first.meta?.note && <div className="plan-note">{first.meta.note}</div>}
        </div>
      )}
    </div>
  )
}
