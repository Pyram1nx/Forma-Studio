import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { iconPayload, iconUrl, iconsEnabled, searchIcons, type IconHit } from '../io/iconSearch'
import * as Ic from '../ui/icons'
import { BASIC_SHAPES, createBasic, createTemplate } from './shapeFactory'
import { TEMPLATES } from '../geometry/templates'
import { TemplateIcon } from '../geometry/templateIcons'
import { placeBoxJoint } from './boxJointGuides'
import { boxJointKind } from '../geometry/boxJoints'
import { MM_PER_IN } from '../model/types'

function viewCentre() {
  const { view, viewport } = useStore.getState()
  return { x: (viewport.w / 2 - view.panX) / view.zoom, y: (viewport.h / 2 - view.panY) / view.zoom }
}

const dismissPopover = () => useStore.getState().setPopover(null)

/** Close a popover on a pointer-down outside it. Clicks on chrome that toggles or changes
 *  state itself (hover buttons, the mode tabs) are left to those controls. */
function useOutsideDismiss(active: boolean, inside: string) {
  useEffect(() => {
    if (!active) return
    const down = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(inside)) dismissPopover()
    }
    window.addEventListener('pointerdown', down, true)
    return () => window.removeEventListener('pointerdown', down, true)
  }, [active, inside])
}

const SHAPE_INSIDE = '.shape-creator, .hover-btn, .mode-switcher, .settings-pop'

export function ShapesPopover() {
  const popover = useStore((s) => s.popover)
  const mode = useStore((s) => s.mode)
  const [query, setQuery] = useState('')
  // Results are tagged with the query they answer, so a slow reply never shows under a newer query.
  const [iconRes, setIconRes] = useState<{ q: string; hits: IconHit[]; error: boolean } | null>(null)
  useOutsideDismiss(popover === 'shapes' && mode === 'design', SHAPE_INSIDE)
  const trimmed = query.trim()
  const icons = iconRes?.q === trimmed ? iconRes.hits : []
  const iconError = iconRes?.q === trimmed && iconRes.error
  // Debounced icon search. Each keystroke aborts the request still in flight.
  useEffect(() => {
    if (!iconsEnabled() || trimmed.length < 2 || popover !== 'shapes') return
    const ac = new AbortController()
    const t = setTimeout(() => {
      searchIcons(trimmed, ac.signal)
        .then((hits) => setIconRes({ q: trimmed, hits, error: false }))
        .catch(() => {
          if (!ac.signal.aborted) setIconRes({ q: trimmed, hits: [], error: true })
        })
    }, 250)
    return () => {
      clearTimeout(t)
      ac.abort()
    }
  }, [trimmed, popover])
  if (popover !== 'shapes' || mode !== 'design') return null
  const st = useStore.getState
  const placeIcon = async (id: string) => {
    try {
      const payload = await iconPayload(id)
      if (!payload.shapes.length) st().showToast('No paths found in that icon')
      else st().importPayload(payload)
    } catch (e) {
      st().showToast('Import failed: ' + (e as Error).message)
    }
  }
  // Box joints (basic and pro) come with their guides as a group; other templates are a single shape.
  const placeTemplate = (id: string) => {
    const s = createTemplate(id, viewCentre().x, viewCentre().y, st().doc.units)
    if (!boxJointKind(id) || !s) return place(s)
    placeBoxJoint(s)
    const { view, viewport } = st()
    if (view.zoom * MM_PER_IN < Math.min(viewport.w, viewport.h) / 8) st().zoomToFit()
  }
  const place = (s: ReturnType<typeof createBasic> | null) => {
    if (!s) return
    st().addShapes([s])
    // Zoom so a fresh 1" shape is comfortably visible, like Studio does.
    const { view, viewport } = st()
    if (s.contours.length && view.zoom * MM_PER_IN < Math.min(viewport.w, viewport.h) / 8) st().zoomToFit()
  }
  // The search filters basic shapes (by label) and templates (by name).
  const q = query.trim().toLowerCase()
  const basics = q ? BASIC_SHAPES.filter((b) => b.label.toLowerCase().includes(q)) : BASIC_SHAPES
  const templates = q ? TEMPLATES.filter((t) => t.name.toLowerCase().includes(q)) : TEMPLATES
  return (
    <div className="shape-creator" role="dialog" aria-label="Make shape">
      <input
        id="shape-search"
        // Focus immediately so typing right after Find Art / Make Shape filters.
        autoFocus
        type="search"
        className="shape-creator__search"
        placeholder={iconsEnabled() ? 'Search shapes, templates & icons' : 'Search shapes & templates'}
        aria-label="Search shapes and templates"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {basics.length > 0 && (
        <>
          <div className="shape-creator__label">shapes</div>
          <div className="shape-creator__basic">
            {basics.map((b) => (
              <button key={b.id} className="basic-shape-btn" title={b.label} aria-label={b.label} onClick={() => place(createBasic(b.id, viewCentre().x, viewCentre().y))}>
                <TemplateIcon id={b.id} size={24} />
              </button>
            ))}
          </div>
        </>
      )}
      {templates.length > 0 && (
        <>
          <div className="shape-creator__label">
            templates <span className="ss-badge ss-badge--new">new</span>
          </div>
          <div className="shape-creator__templates">
            {templates.map((t) => (
              <button key={t.id} className="template-btn" title={t.name} aria-label={t.name} onClick={() => placeTemplate(t.id)}>
                <TemplateIcon id={t.id} size={36} />
              </button>
            ))}
          </div>
        </>
      )}
      {trimmed.length >= 2 && iconsEnabled() && (
        <>
          <div className="shape-creator__label">icons</div>
          {iconError ? (
            <div className="ss-muted shape-creator__none">Icon search is unavailable right now.</div>
          ) : (
            <div className="shape-creator__icons">
              {icons.map((h) => (
                <button key={h.id} className="icon-result-btn" title={h.id} aria-label={h.id} onClick={() => placeIcon(h.id)}>
                  <img src={iconUrl(h.id)} alt="" />
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {!basics.length && !templates.length && !icons.length && <div className="ss-muted shape-creator__none">No shapes or templates match “{trimmed}”.</div>}
      <button className="shape-creator__close ss-btn-round" onClick={dismissPopover} aria-label="Close make shape">
        <Ic.IconClose />
      </button>
    </div>
  )
}

export function ShortcutsDialog() {
  const dialog = useStore((s) => s.dialog)
  useEffect(() => {
    if (dialog !== 'shortcuts') return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && useStore.getState().openDialog(null)
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [dialog])
  if (dialog !== 'shortcuts') return null
  const mod = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'
  // Only shortcuts that are implemented. "(Design)" marks ones that only work in Design mode.
  const rows: [string, string][] = [
    [`${mod} S`, 'Save to computer'],
    [`${mod} ⇧ S`, 'Save as…'],
    [`${mod} O`, 'Open from computer'],
    [`${mod} E`, 'Export SVG'],
    [`${mod} ⇧ E`, 'Export selection as SVG'],
    [`${mod} Z / ${mod} ⇧ Z / ${mod} Y`, 'Undo / Redo'],
    [`${mod} D`, 'Duplicate'],
    [`${mod} G / ${mod} ⇧ G`, 'Group / Ungroup (Design)'],
    [`${mod} H`, 'Set as reference / make editable (Design)'],
    [`${mod} A`, 'Select all'],
    [`${mod} +  /  ${mod} −`, 'Zoom in / out'],
    [`${mod} 0`, 'Zoom to fit'],
    ['F', 'Zoom to fit'],
    ['Delete', 'Delete selection (Design)'],
    ['Arrows', 'Nudge (⇧ ×10) (Design)'],
    ['↑ / ↓ in a field', 'Step the value'],
    ['Space + drag', 'Pan (also middle or right drag)'],
    ['Pinch / ⌘ scroll', 'Zoom'],
    ['P', 'Draw tool'],
    ['Enter / Backspace / Esc', 'Finish / remove last point / cancel while drawing'],
    ['1 / 2 / 3', 'Design / Plan / Review'],
    ['Alt + click', 'Select one object of a group'],
    ['Shift', 'Snap angle / free scale / add to selection'],
    ['Alt + drag', 'Move without smart alignment'],
  ]
  return (
    <div className="modal-backdrop" onPointerDown={() => useStore.getState().openDialog(null)}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-card__head">
          <Ic.IconKeyboard /> Keyboard Shortcuts
          <button className="ss-btn-round" onClick={() => useStore.getState().openDialog(null)} aria-label="Close keyboard shortcuts">
            <Ic.IconClose />
          </button>
        </div>
        <div className="shortcut-list">
          {rows.map(([k, v]) => (
            <div key={k} className="shortcut-list__row">
              <kbd>{k}</kbd>
              <span>{v}</span>
            </div>
          ))}
        </div>
        <div className="ss-muted" style={{ marginTop: 12 }}>
          Forma Studio runs entirely in your browser. Designs autosave locally; use Save to keep a <code>.formastudio</code> file on your computer and Export SVG to
          send it to Shaper Origin.
        </div>
      </div>
    </div>
  )
}

/** Studio's Reference explainer, opened from the info button on the "set to Reference" toast. */
export function ReferenceDialog() {
  const dialog = useStore((s) => s.dialog)
  useEffect(() => {
    if (dialog !== 'reference') return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && useStore.getState().openDialog(null)
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [dialog])
  if (dialog !== 'reference') return null
  const close = () => useStore.getState().openDialog(null)
  return (
    <div className="reference-modal" onPointerDown={close}>
      <div className="reference-modal__card" role="dialog" aria-modal="true" aria-labelledby="reference-modal-title" onPointerDown={(e) => e.stopPropagation()}>
        <button className="reference-modal__close" onClick={close} aria-label="Close">
          <Ic.IconClose size={20} />
        </button>
        <div className="reference-modal__title" id="reference-modal-title">
          <Ic.IconPathTypeLock size={24} /> Reference
        </div>
        <div className="reference-modal__info">
          <p>
            Objects set to “Reference” will be locked (non-editable), excluded from lasso selections, and will not be visible in other modes or on Origin.
          </p>
          <p>Use this feature to more easily draw over your traces or reference designs and keep your working designs out of your cut files.</p>
          <a className="reference-modal__more" href="https://support.shapertools.com/hc/articles/21945983196187-Reference-Paths-Deep-Dive" target="_blank" rel="noreferrer">
            Learn more <Ic.IconChevronRight size={14} />
          </a>
        </div>
      </div>
    </div>
  )
}
