import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../state/store'
import type { Shape } from '../model/types'
import * as Ic from '../ui/icons'
import { FONTS, FONT_FILTERS, fontUrl, isHeavyFont, findFont, findStyle, type FontCategory, type FontDef, type FontStyleDef } from '../io/fontCatalog'
import { fontSupports, linePathData, loadStyle, textToContours } from '../io/text'
import { FONT_FILTER_ICONS, IconUnfoldLess, IconUnfoldMore } from './fontIcons'
import { applyText, previewText, restoreText, snapshotOf, textParams, type TextSnapshot } from './textOps'

/** Registers the library's typefaces with the browser so the menu can show each name in its own font. */
let facesRegistered = false
function registerMenuFaces() {
  if (facesRegistered) return
  facesRegistered = true
  for (const f of FONTS)
    for (const s of f.fontStyles) {
      if (s.singleLine || isHeavyFont(f)) continue
      const face = new FontFace(s.fontFamily, `url("${fontUrl(s)}")`)
      face.load().then((l) => document.fonts.add(l), () => {})
    }
}

/** A single-line font drawn as engraved strokes, as in Studio's menu. */
function SlfLabel({ label, style, size }: { label: string; style: FontStyleDef; size: number }) {
  const [d, setD] = useState<{ path: string; w: number } | null>(null)
  useEffect(() => {
    let live = true
    loadStyle(style).then(
      (font) => live && setD({ path: linePathData(font, label, size, 1, size), w: font.getAdvanceWidth(label, size) + 2 }),
      () => {},
    )
    return () => {
      live = false
    }
  }, [label, style, size])
  return (
    <div className="font-menu--item--slf" aria-label={label}>
      {d && (
        <svg width={d.w} height={size * 1.4} viewBox={`0 0 ${d.w} ${size * 1.4}`} fill="none" stroke="black" strokeWidth={1}>
          <path d={d.path} />
        </svg>
      )}
    </div>
  )
}

function Label({ label, style, size = 16, singleLine }: { label: string; style: FontStyleDef; size?: number; singleLine: boolean }) {
  return singleLine ? <SlfLabel label={label} style={style} size={size} /> : <div style={{ fontSize: size, fontFamily: `"${style.fontFamily}", sans-serif` }}>{label}</div>
}

/** Menu surface anchored to a field: opens to its left like Studio's, kept on screen. */
function Menu({ anchor, onClose, children }: { anchor: HTMLElement | null; onClose: () => void; children: React.ReactNode }) {
  const paper = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    if (!anchor || !paper.current) return
    const r = anchor.getBoundingClientRect()
    const h = paper.current.offsetHeight
    const top = Math.max(8, Math.min(r.top - 18, window.innerHeight - h - 8))
    setPos({ position: 'fixed', top, right: window.innerWidth - r.left + 8 })
  }, [anchor])
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return createPortal(
    <div className="font-menu" onPointerDown={(e) => e.stopPropagation()}>
      <div className="font-menu__backdrop" onClick={onClose} />
      <div ref={paper} className="font-menu__paper" style={pos}>
        {children}
      </div>
    </div>,
    document.body,
  )
}

/** Studio's font and style selectors for a text shape's properties. */
export default function FontSelect({ shape, disabled }: { shape: Shape; disabled?: boolean }) {
  const { text, font: fontName, fontStyle } = textParams(shape)
  const def = findFont(fontName)
  const [open, setOpen] = useState<null | 'font' | 'style'>(null)
  const [filters, setFilters] = useState<Set<FontCategory>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [supported, setSupported] = useState<Record<string, boolean>>({})
  const [tip, setTip] = useState<{ label: string; x: number; y: number } | null>(null)
  const fontBtn = useRef<HTMLButtonElement>(null)
  const styleBtn = useRef<HTMLButtonElement>(null)
  const snap = useRef<TextSnapshot | null>(null)
  const token = useRef(0)
  const leave = useRef<number | undefined>(undefined)
  const id = shape.id

  // Hover previews are applied to the shape without history and put back when the pointer leaves.
  const restore = useCallback(() => {
    window.clearTimeout(leave.current)
    token.current++
    if (snap.current) {
      restoreText(id, snap.current)
      snap.current = null
    }
  }, [id])
  useEffect(() => restore, [restore])

  const preview = (name: string, style: FontStyleDef) => {
    window.clearTimeout(leave.current)
    const live = useStore.getState().doc.shapes.find((s) => s.id === id)
    if (!live) return
    if (!snap.current) snap.current = snapshotOf(live)
    const mine = ++token.current
    const p = textParams(live)
    textToContours(p.text, name, p.height, style.displayStyle).then(
      (c) => mine === token.current && snap.current && previewText(id, c),
      () => {},
    )
  }
  const endPreview = () => {
    window.clearTimeout(leave.current)
    leave.current = window.setTimeout(restore, 300)
  }
  const close = useCallback(() => {
    restore()
    setOpen(null)
  }, [restore])
  const choose = (name: string, style: FontStyleDef) => {
    restore()
    setOpen(null)
    void applyText(id, { font: name, fontStyle: style.displayStyle })
  }

  // Which fonts can typeset the current text: others are listed greyed out beneath.
  useEffect(() => {
    if (open !== 'font') return
    registerMenuFaces()
    let live = true
    Promise.all(FONTS.map(async (f) => [f.fontDisplayName, await fontSupports(f, f.fontStyles[0].displayStyle, text)] as const)).then((r) => live && setSupported(Object.fromEntries(r)))
    return () => {
      live = false
    }
  }, [open, text])

  const [shown, hidden] = useMemo(() => {
    const list = filters.size === 0 ? FONTS : FONTS.filter((f) => f.fontCategories.some((c) => filters.has(c)))
    const ok = (f: FontDef) => supported[f.fontDisplayName] !== false
    return [list.filter(ok), list.filter((f) => !ok(f))]
  }, [filters, supported])

  const toggle = <T,>(set: Set<T>, v: T) => {
    const n = new Set(set)
    if (!n.delete(v)) n.add(v)
    return n
  }
  const selected = (name: string, style?: string) => name === fontName && (style === undefined || style === fontStyle)

  const item = (f: FontDef, style: FontStyleDef, sub = false) => (
    <li
      key={f.fontDisplayName + (sub ? '/' + style.displayStyle : '')}
      className={'font-menu--item' + (sub ? ' font-menu--sub-item' : '') + (selected(f.fontDisplayName, sub ? style.displayStyle : undefined) ? ' font-menu--item-selected' : '')}
      onMouseEnter={() => preview(f.fontDisplayName, style)}
      onMouseLeave={endPreview}
      onClick={() => choose(f.fontDisplayName, style)}
    >
      <Label label={sub ? style.displayStyle : f.fontDisplayName} style={style} size={f.fontDisplaySizeOverride} singleLine={!!style.singleLine} />
      {!sub && f.fontStyles.length > 1 && (
        <button
          className="additional-styles-button"
          aria-label={expanded.has(f.fontDisplayName) ? 'Hide styles' : 'Show styles'}
          onClick={(e) => {
            e.stopPropagation()
            setExpanded(toggle(expanded, f.fontDisplayName))
          }}
        >
          {expanded.has(f.fontDisplayName) ? <IconUnfoldLess /> : <IconUnfoldMore />}
        </button>
      )}
    </li>
  )

  return (
    <div className="font-select" data-cy="font-selector">
      <button
        ref={fontBtn}
        type="button"
        className={'font-field--input' + (open === 'font' ? ' font-field--input-focused' : '')}
        aria-label="Font"
        aria-haspopup="listbox"
        aria-expanded={open === 'font'}
        disabled={disabled}
        onClick={() => setOpen(open === 'font' ? null : 'font')}
      >
        <span>{fontName}</span>
        <Ic.IconChevronDown size={12} />
      </button>
      {open === 'font' && (
        <Menu anchor={fontBtn.current} onClose={close}>
          <div className="font-menu--filters">
            {FONT_FILTERS.map(({ category, label }) => {
              const Icon = FONT_FILTER_ICONS[category]
              return (
                <button
                  key={category}
                  className={'font-menu--filter' + (filters.has(category) ? ' font-menu--filter-active' : '')}
                  aria-label={label}
                  aria-pressed={filters.has(category)}
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    setTip({ label, x: r.left + r.width / 2, y: r.top - 4 })
                  }}
                  onMouseLeave={() => setTip(null)}
                  onClick={() => setFilters(toggle(filters, category))}
                >
                  <Icon />
                </button>
              )
            })}
          </div>
          {tip && createPortal(<div className="font-menu__tip" style={{ left: tip.x, top: tip.y }}>{tip.label}</div>, document.body)}
          <ul className="font-menu--list" role="listbox">
            {shown.flatMap((f) => [item(f, f.fontStyles[0]), ...(expanded.has(f.fontDisplayName) && f.fontStyles.length > 1 ? f.fontStyles.map((s) => item(f, s, true)) : [])])}
            {hidden.map((f) => (
              <li key={f.fontDisplayName} className="font-menu--unsupported-item">
                <Label label={f.fontDisplayName} style={f.fontStyles[0]} size={f.fontDisplaySizeOverride} singleLine={!!f.fontStyles[0].singleLine} />
              </li>
            ))}
          </ul>
        </Menu>
      )}
      {def && def.fontStyles.length > 1 && (
        <>
          <button
            ref={styleBtn}
            type="button"
            className={'font-field--input font-field--style-input' + (open === 'style' ? ' font-field--input-focused' : '')}
            aria-label="Font style"
            aria-haspopup="listbox"
            aria-expanded={open === 'style'}
            disabled={disabled}
            onClick={() => setOpen(open === 'style' ? null : 'style')}
          >
            <span>{findStyle(def, fontStyle).displayStyle}</span>
            <Ic.IconChevronDown size={12} />
          </button>
          {open === 'style' && (
            <Menu anchor={styleBtn.current} onClose={close}>
              <ul className="font-menu--list" role="listbox">
                {def.fontStyles.map((s) => (
                  <li
                    key={s.displayStyle}
                    className={'font-menu--item' + (s.displayStyle === fontStyle ? ' font-menu--item-selected' : '')}
                    onMouseEnter={() => preview(def.fontDisplayName, s)}
                    onMouseLeave={endPreview}
                    onClick={() => choose(def.fontDisplayName, s)}
                  >
                    <div style={{ fontFamily: `"${s.fontFamily}", sans-serif` }}>{s.displayStyle}</div>
                  </li>
                ))}
              </ul>
            </Menu>
          )}
        </>
      )}
    </div>
  )
}
