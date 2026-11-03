import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { confirmDiscard } from './fileActions'
import { groupAction, selectionHasReference, useStore } from '../state/store'
import * as Ic from '../ui/icons'
import { MM_PER_IN, SNAP_KINDS, type DocSettings, type Mode, type SnapKind, type Units } from '../model/types'
import { importSVGFile } from '../io/svgImport'
import { parseDoc, pickFile } from '../io/projectFile'
import { shapesBBox } from '../geometry/transform'
import { gridSizeMm } from './grid'

/** Unsaved work needs confirmation before it is replaced (New / Open / Recent / Import of a design file). */

/** 100% zoom = real size at the CSS inch (96 px per inch). */
const PX_PER_MM_AT_100 = 96 / 25.4

// ---------- Logo + file name + undo/redo ----------
export function TopLeft() {
  const name = useStore((s) => s.doc.name)
  const dirty = useStore((s) => s.dirty)
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(name)
  const cancel = useRef(false)
  useEffect(() => setVal(name), [name])

  return (
    <>
      <div className="app-launcher">
        <button className="app-launcher__logo" onClick={() => useStore.getState().setMenuOpen(true)} aria-label="Open menu">
          <Ic.FormaLogo size={40} />
        </button>
        {editing ? (
          <input
            className="app-launcher__name-input"
            aria-label="Design name"
            autoFocus
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={() => {
              const keep = !cancel.current
              cancel.current = false
              setEditing(false)
              if (keep && val.trim() && val !== name) useStore.getState().rename(val.trim())
              else setVal(name)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') {
                cancel.current = true
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />
        ) : (
          <button className="app-launcher__name" onClick={() => setEditing(true)} title="Rename" aria-label={`Rename design, currently ${name}`}>
            <span className="app-launcher__text">{name}</span>
            {dirty && <span className="app-launcher__dirty" role="img" aria-label="Unsaved changes" title="Unsaved changes" />}
          </button>
        )}
      </div>
      <div className="undo-redo">
        <HoverButton label="Undo" onClick={() => useStore.getState().undo()} className={'ui-round' + (canUndo ? '' : ' is-empty')}>
          <Ic.IconUndo />
        </HoverButton>
        {canRedo && (
          <HoverButton label="Redo" onClick={() => useStore.getState().redo()} className="ui-round">
            <Ic.IconRedo />
          </HoverButton>
        )}
      </div>
    </>
  )
}

function HoverButton(props: {
  label: string
  onClick: () => void
  children: ReactNode
  className?: string
  active?: boolean
  labelSide?: 'right' | 'top'
  pressed?: boolean
  style?: CSSProperties
}) {
  const side = props.labelSide ?? 'right'
  return (
    <div className={'hover-btn hover-btn--' + side + (props.active ? ' is-active' : '')} style={props.style}>
      <button className={props.className ?? 'ui-round'} onClick={props.onClick} aria-label={props.label} aria-pressed={props.pressed}>
        {props.children}
      </button>
      <span className="hover-btn__label" aria-hidden="true">
        {props.label}
      </span>
    </div>
  )
}

// ---------- Left action rail ----------
// Each rail item's position in the ladder; CSS turns it into a staggered transition delay.
const rung = (i: number) => ({ '--i': i }) as CSSProperties

export function LeftRail() {
  const mode = useStore((s) => s.mode)
  const tool = useStore((s) => s.tool)
  const popover = useStore((s) => s.popover)
  const hasSel = useStore((s) => s.selection.length > 0)
  // Find Art and Make Shape open the same popover; the origin decides which button is active.
  const [shapesOrigin, setShapesOrigin] = useState<'find' | 'make' | null>(null)
  if (mode !== 'design') return null
  const st = useStore.getState
  const shapesActive = (origin: 'find' | 'make') => popover === 'shapes' && shapesOrigin === origin
  // A second click on the button that opened the popover closes it.
  const toggleShapes = (origin: 'find' | 'make') => {
    if (shapesActive(origin)) return st().setPopover(null)
    setShapesOrigin(origin)
    st().setPopover('shapes')
    if (origin === 'find') {
      // The Make Shape popover mounts on this render; focus its search box after it does.
      setTimeout(() => document.getElementById('shape-search')?.focus(), 30)
    }
  }
  const importFile = async () => {
    // The picker takes focus and gives no outside pointer-down, so close the popover first.
    st().setPopover(null)
    try {
      const f = await pickFile('.svg,image/svg+xml,.forma,.formastudio,.shaperstudio,.json')
      if (/\.(forma|formastudio|shaperstudio|json)$/i.test(f.name)) {
        if (!confirmDiscard()) return
        st().setDoc(parseDoc(await f.text()))
        return
      }
      const payload = await importSVGFile(f)
      if (!payload.shapes.length) st().showToast('No paths found in that SVG')
      else st().importPayload(payload)
    } catch (e) {
      if ((e as Error).message !== 'No file') st().showToast('Import failed: ' + (e as Error).message)
    }
  }
  return (
    <>
    <MobileCreate
      items={[
        { label: 'Find Art', icon: <Ic.IconSearch />, onClick: () => toggleShapes('find') },
        { label: 'Pen', icon: <Ic.IconPen />, onClick: () => st().setTool('pen') },
        { label: 'Draw', icon: <Ic.IconDraw />, onClick: () => st().setTool('draw') },
        { label: 'Make Shape', icon: <Ic.IconShapes />, onClick: () => toggleShapes('make') },
        { label: 'Add Text', icon: <Ic.IconText />, onClick: () => (st().setEditingText(null), st().openDialog('text')) },
        { label: 'File Import', icon: <Ic.IconImportFile />, onClick: importFile },
        { label: 'Trace', icon: <Ic.IconTrace />, onClick: () => st().openDialog('trace') },
        { label: 'Dovetails', icon: <Ic.IconDovetail />, onClick: () => st().openDialog('dovetail') },
        { label: 'Systainer Insert', icon: <Ic.IconSystainer />, onClick: () => st().openDialog('systainer') },
      ]}
    />
    {/* While something is selected the rail ladders off to the left, one tool at a time (see .ladder). */}
    <nav className={'canvas-action-menu ladder' + (hasSel ? ' is-hidden' : '')} aria-label="Tools" aria-hidden={hasSel} inert={hasSel}>
      <HoverButton style={rung(0)} label="Find Art" className="rail-btn" active={shapesActive('find')} onClick={() => toggleShapes('find')}>
        <Ic.IconSearch />
      </HoverButton>
      <HoverButton style={rung(1)} label="Pen" className="rail-btn" active={tool === 'pen'} pressed={tool === 'pen'} onClick={() => st().setTool(tool === 'pen' ? 'select' : 'pen')}>
        <Ic.IconPen />
      </HoverButton>
      <HoverButton style={rung(2)} label="Draw" className="rail-btn" active={tool === 'draw'} pressed={tool === 'draw'} onClick={() => st().setTool(tool === 'draw' ? 'select' : 'draw')}>
        <Ic.IconDraw />
      </HoverButton>
      <HoverButton style={rung(3)} label="Make Shape" className="rail-btn" active={shapesActive('make')} onClick={() => toggleShapes('make')}>
        <Ic.IconShapes />
      </HoverButton>
      <HoverButton style={rung(4)} label="Add Text" className="rail-btn" onClick={() => (st().setEditingText(null), st().openDialog('text'))}>
        <Ic.IconText />
      </HoverButton>
      <HoverButton style={rung(5)} label="File Import" className="rail-btn" onClick={importFile}>
        <Ic.IconImportFile />
      </HoverButton>
      <div className="canvas-action-menu__divider" style={rung(6)} role="separator" />
      <HoverButton style={rung(7)} label="3D Carve" className="rail-btn rail-btn--new" onClick={() => st().openDialog('carve3d')}>
        <Ic.IconCube />
      </HoverButton>
      <HoverButton style={rung(8)} label="Trace" className="rail-btn rail-btn--new" onClick={() => st().openDialog('trace')}>
        <Ic.IconTrace />
      </HoverButton>
      <HoverButton style={rung(9)} label="Dovetails" className="rail-btn rail-btn--new" onClick={() => st().openDialog('dovetail')}>
        <Ic.IconDovetail />
      </HoverButton>
      <HoverButton style={rung(10)} label="Systainer Insert" className="rail-btn rail-btn--new" onClick={() => st().openDialog('systainer')}>
        <Ic.IconSystainer />
      </HoverButton>
    </nav>
    </>
  )
}

type StackItem = { label: string; icon: ReactNode; onClick: () => void; dark?: boolean }

/** Mobile-only FAB: opens a scrim with a vertical stack of labelled round buttons. Hidden on desktop by CSS. */
function MobileStack({ items, fabIcon, fabClass, dark, extra }: { items: StackItem[]; fabIcon: ReactNode; fabClass: string; dark?: boolean; extra?: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className={'m-fab ' + fabClass} aria-label="Open actions" onClick={() => setOpen(true)}>
        {fabIcon}
      </button>
      {extra}
      {open && (
        <div className="m-scrim" onClick={() => setOpen(false)}>
          <div className="m-stack" onClick={(e) => e.stopPropagation()}>
            {items.map((it, i) => (
              <button
                key={it.label}
                className="m-stack__item"
                style={{ animationDelay: (items.length - i) * 30 + 'ms' }}
                onClick={() => {
                  setOpen(false)
                  it.onClick()
                }}
              >
                <span className={'m-stack__btn' + (dark ? ' is-dark' : '')}>{it.icon}</span>
                <span className="m-stack__label">{it.label}</span>
              </button>
            ))}
            <button className="m-fab m-fab--close" aria-label="Cancel" onClick={() => setOpen(false)}>
              <Ic.IconClose size={20} />
            </button>
          </div>
        </div>
      )}
    </>
  )
}

function MobileCreate({ items }: { items: StackItem[] }) {
  const hasSel = useStore((s) => s.selection.length > 0)
  const tool = useStore((s) => s.tool)
  if (hasSel || tool !== 'select') return null
  return <MobileStack items={items} fabIcon={<Ic.IconPlus size={14} />} fabClass="m-fab--blue" />
}

const IconWrench = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z" />
  </svg>
)

// ---------- Mode switcher + settings popover ----------
const MODES: { id: Mode; label: string; icon: ReactNode }[] = [
  { id: 'design', label: 'Design', icon: <Ic.IconDesignMode /> },
  { id: 'plan', label: 'Plan', icon: <svg width={20} height={20} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} strokeDasharray="2 3" strokeLinecap="round" aria-hidden><circle cx="10" cy="10" r="9" /></svg> },
  { id: 'review', label: 'Review', icon: <Ic.IconReviewMode /> },
]

export function TopRight() {
  const mode = useStore((s) => s.mode)
  const hasSel = useStore((s) => s.selection.length > 0)
  const popover = useStore((s) => s.popover)
  const st = useStore.getState
  return (
    <div className="top-right">
      <HoverButton
        label={hasSel ? 'Zoom to Selection' : 'Recenter'}
        className="ui-round"
        labelSide="right"
        onClick={() => {
          const s = st()
          if (s.selection.length) s.zoomToFit(shapesBBox(s.doc.shapes.filter((x) => s.selection.includes(x.id))))
          else s.zoomToFit()
        }}
      >
        {hasSel ? <Ic.IconZoomSel size={22} /> : <Ic.IconFullscreen size={22} />}
      </HoverButton>
      <div className="mode-switcher" role="group" aria-label="Mode">
        {MODES.map((m) => {
          const sel = m.id === mode
          // Studio gives Design and Plan a settings chevron on the selected tab; Review has none.
          const hasSettings = sel && m.id !== 'review'
          const open = hasSettings && popover === 'settings'
          return (
            <button
              type="button"
              key={m.id}
              className={'mode-switcher__tab' + (sel ? ' is-selected' : '')}
              aria-pressed={sel}
              aria-expanded={hasSettings ? open : undefined}
              aria-haspopup={hasSettings ? 'dialog' : undefined}
              onClick={() => {
                if (!sel) st().setMode(m.id)
                else if (hasSettings) st().setPopover(open ? null : 'settings')
              }}
            >
              <span className="mode-switcher__icon" aria-hidden="true">{m.icon}</span>
              <span className="mode-switcher__text">{m.label}</span>
              {hasSettings && <Ic.IconChevronDown size={16} className={'icon mode-switcher__chev' + (open ? ' is-open' : '')} />}
            </button>
          )
        })}
      </div>
      {popover === 'settings' && (mode === 'design' || mode === 'plan') && <SettingsPopover plan={mode === 'plan'} />}
    </div>
  )
}

const ORIGIN_ANCHOR_INFO = "Custom Anchors help you position your design on Origin."
function SettingsRow(p: { icon: ReactNode; label: string; info?: string; children: ReactNode }) {
  return (
    <div className="settings-pop__row">
      {p.icon}
      <span className="settings-pop__label">{p.label}</span>
      {p.info && (
        <span className="settings-pop__info" role="img" aria-label={p.info} title={p.info}>
          <Ic.IconHelp size={14} />
        </span>
      )}
      {p.children}
    </div>
  )
}

const SNAP_LABELS: Record<SnapKind, string> = {
  points: 'Points',
  midpoints: 'Midpoints',
  edges: 'Edges',
  bounds: 'Bounding box',
  centers: 'Centers',
  origin: 'Origin',
}

/** What Smart Alignment snaps to; folds out under the Smart Alignment row while it is on. */
function SnapAccordion() {
  const open = useStore((s) => s.doc.settings.smartAlignment)
  const snap = useStore((s) => s.doc.settings.snap)
  return (
    <div className={'settings-pop__accordion' + (open ? ' is-open' : '')} aria-hidden={!open}>
      <div className="settings-pop__accordion-inner">
        {SNAP_KINDS.map((k) => {
          const on = snap?.[k] !== false
          return (
            <div key={k} className="settings-pop__subrow">
              <span className="settings-pop__label">{SNAP_LABELS[k]}</span>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={'Snap to ' + SNAP_LABELS[k].toLowerCase()}
                tabIndex={open ? 0 : -1}
                className={'ss-switch ss-switch--sm' + (on ? ' is-on' : '')}
                onClick={() => useStore.getState().setSnapKind(k, !on)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

type PositionOpt = 'showGrid' | 'snapToGrid' | 'positionLabels'
const POSITION_OPTS: { k: PositionOpt; label: string }[] = [
  { k: 'showGrid', label: 'Show grid' },
  { k: 'snapToGrid', label: 'Snap to grid' },
  { k: 'positionLabels', label: 'Show position labels' },
]

/** Grid spacing field beside Show grid: shown in the document units, commits on Enter or blur. */
function GridSizeInput() {
  const units = useStore((s) => s.doc.units)
  const size = useStore((s) => gridSizeMm(s.doc))
  const fmt = (mm: number) => (units === 'in' ? (mm / MM_PER_IN).toFixed(3) : String(+mm.toFixed(3)))
  const [text, setText] = useState(fmt(size))
  const editing = useRef(false)
  useEffect(() => {
    if (!editing.current) setText(fmt(size))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, units])
  const commit = () => {
    editing.current = false
    const v = parseFloat(text.replace(',', '.'))
    if (Number.isFinite(v) && v > 0) useStore.getState().setGridSize(units === 'in' ? v * MM_PER_IN : v)
    else setText(fmt(size))
  }
  return (
    <div className="settings-pop__grid-input">
      <input
        aria-label="Grid size"
        inputMode="decimal"
        value={text}
        onFocus={(e) => e.target.select()}
        onChange={(e) => {
          editing.current = true
          setText(e.target.value)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            editing.current = false
            setText(fmt(size))
            ;(e.target as HTMLInputElement).blur()
          }
          e.stopPropagation()
        }}
      />
      <span>{units}</span>
    </div>
  )
}

/** What Position adds (grid, grid snapping, labels on the canvas); folds out under the Position row while it is on. */
function PositionAccordion() {
  const open = useStore((s) => s.doc.settings.showPosition)
  const settings = useStore((s) => s.doc.settings)
  return (
    <div className={'settings-pop__accordion' + (open ? ' is-open' : '')} aria-hidden={!open}>
      <div className="settings-pop__accordion-inner">
        {POSITION_OPTS.map(({ k, label }) => {
          const on = settings[k] === true
          return (
            <div key={k} className="settings-pop__subrow">
              <span className="settings-pop__label">{label}</span>
              {k === 'showGrid' && <GridSizeInput />}
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={label}
                tabIndex={open ? 0 : -1}
                className={'ss-switch ss-switch--sm' + (on ? ' is-on' : '')}
                onClick={() => useStore.getState().setSetting(k, !on)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Studio switch: 48x24 pill. `dark` is the Plan (dark) variant. */
export function Switch({ k, label, dark }: { k: keyof DocSettings; label: string; dark?: boolean }) {
  const on = useStore((s) => s.doc.settings[k]) === true
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={'ss-switch' + (dark ? ' ss-switch--dark' : '') + (on ? ' is-on' : '')}
      onClick={() => useStore.getState().setSetting(k, !on)}
    />
  )
}

function UnitsSeg({ units }: { units: Units }) {
  return (
    <div className="ss-seg ss-seg--units" role="group" aria-label="Units">
      <button type="button" aria-pressed={units === 'in'} className={units === 'in' ? 'is-active' : ''} onClick={() => useStore.getState().setUnits('in')}>
        in
      </button>
      <button type="button" aria-pressed={units === 'mm'} className={units === 'mm' ? 'is-active' : ''} onClick={() => useStore.getState().setUnits('mm')}>
        mm
      </button>
    </div>
  )
}

function SettingsPopover({ plan }: { plan: boolean }) {
  const units = useStore((s) => s.doc.units)
  const dismiss = () => useStore.getState().setPopover(null)
  // Outside click (anything but this popover and the mode tabs, which toggle it) and Escape close it.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('.settings-pop, .mode-switcher')) return
      dismiss()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      dismiss()
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [])
  return (
    <div className={'settings-pop' + (plan ? ' settings-pop--plan' : '')} role="dialog" aria-label={plan ? 'Plan settings' : 'Design settings'}>
      <SettingsRow icon={<Ic.IconUnits size={20} />} label="Units">
        <UnitsSeg units={units} />
      </SettingsRow>
      {plan ? (
        <>
          <SettingsRow icon={<Ic.IconPlanMode size={20} />} label="Cut Path Display">
            <Switch k="cutPathDisplay" label="Cut Path Display" dark />
          </SettingsRow>
          <SettingsRow icon={<Ic.IconAnchor size={20} />} label="Origin Anchor" info={ORIGIN_ANCHOR_INFO}>
            <Switch k="originAnchor" label="Origin Anchor" dark />
          </SettingsRow>
        </>
      ) : (
        <>
          <SettingsRow icon={<Ic.IconMagnet size={20} />} label="Smart Alignment">
            <Switch k="smartAlignment" label="Smart Alignment" />
          </SettingsRow>
          <SnapAccordion />
          <SettingsRow icon={<Ic.IconPosition size={20} />} label="Position">
            <Switch k="showPosition" label="Position" />
          </SettingsRow>
          <PositionAccordion />
          <SettingsRow icon={<Ic.IconAnchor size={20} />} label="Origin Anchor" info={ORIGIN_ANCHOR_INFO}>
            <Switch k="originAnchor" label="Origin Anchor" />
          </SettingsRow>
        </>
      )}
    </div>
  )
}

// ---------- Zoom + empty hint ----------
/** Bottom-left zoom buttons and readout. The readout is zoom relative to real size; click it to fit. */
export function ZoomControls() {
  const zoom = useStore((s) => s.view.zoom)
  const pct = Math.round((zoom / PX_PER_MM_AT_100) * 100)
  return (
    <div className="zoom-controls">
      <button className="ui-round zoom-controls__btn" onClick={() => useStore.getState().zoomBy(0.8)} aria-label="Zoom out" title="Zoom out (⌘−)">
        <Ic.IconMinus size={16} />
      </button>
      <button className="ui-round zoom-controls__btn" onClick={() => useStore.getState().zoomBy(1.25)} aria-label="Zoom in" title="Zoom in (⌘+)">
        <Ic.IconPlus size={16} />
      </button>
      <button className="zoom-controls__readout" onClick={() => useStore.getState().zoomToFit()} aria-label={`Zoom ${pct} percent, fit to screen`} title="Fit to screen (F)">
        {pct}%
      </button>
    </div>
  )
}

// ---------- Bottom action bar (selection) ----------
export function ActionBar() {
  const mode = useStore((s) => s.mode)
  const selection = useStore((s) => s.selection)
  const shapes = useStore((s) => s.doc.shapes)
  const tool = useStore((s) => s.tool)
  const anchorPicking = useStore((s) => s.anchorPicking)
  // Group with two or more objects selected; Ungroup when the selection is one whole group.
  const groupAct = useStore((s) => groupAction(s.doc, s.selection))
  // Studio hides the selection actions while a reference is selected.
  const hasRef = useStore((s) => selectionHasReference(s.doc, s.selection))
  const visible = mode === 'design' && selection.length > 0 && tool === 'select' && !anchorPicking && !hasRef
  const textShape = selection.length === 1 ? shapes.find((s) => s.id === selection[0]) : undefined
  // ShapeShifter applies to two or more shapes, or to a single result of an earlier merge (to re-edit it).
  // Locked text can't be re-typeset.
  const live = {
    groupAct,
    canShapeShift: selection.length >= 2 || !!textShape?.meta?.shifterOf?.length,
    isText: textShape?.kind === 'text' && !textShape.locked,
  }
  // The desktop bar stays mounted so it can ladder out; it keeps the last selection's tools while it leaves.
  const frozen = useRef(live)
  if (visible) frozen.current = live
  if (mode !== 'design') return null
  const { canShapeShift, isText } = frozen.current
  const st = useStore.getState
  const groupItem =
    frozen.current.groupAct === 'group'
      ? { label: 'Group', icon: <Ic.IconGroup />, onClick: () => st().groupSelected() }
      : frozen.current.groupAct === 'ungroup'
        ? { label: 'Ungroup', icon: <Ic.IconUngroup />, onClick: () => st().ungroupSelected() }
        : null
  let n = 0
  const next = () => rung(n++)
  return (
    <>
    {visible && (
    <div className="m-selbar">
      <MobileStack
        dark
        fabClass="m-fab--blue"
        fabIcon={<IconWrench />}
        items={[
          ...(canShapeShift ? [{ label: 'ShapeShifter', icon: <Ic.IconShapeShifter />, onClick: () => st().enterShapeShifter() }] : []),
          { label: 'Offset', icon: <Ic.IconOffset />, onClick: () => st().openDialog('offset') },
          { label: 'Mirror', icon: <Ic.IconMirrorH />, onClick: () => st().mirrorSelected('h') },
          ...(groupItem ? [groupItem] : []),
        ]}
        extra={
          <>
            <button className="m-fab m-fab--grey" aria-label="Duplicate" onClick={() => st().duplicateSelected(false)}>
              <Ic.IconDuplicate />
            </button>
            <button className="m-fab m-fab--grey" aria-label="Delete Object" onClick={() => st().deleteSelected()}>
              <Ic.IconDelete />
            </button>
          </>
        }
      />
      <button className="m-fab m-fab--blue m-fab--edit" aria-label="Edit properties" onClick={() => window.dispatchEvent(new CustomEvent('ss:open-props-sheet'))}>
        <Ic.IconPencil size={20} />
      </button>
    </div>
    )}
    {/* Tools fly up one at a time, left to right, when something is selected, and drop away the same way. */}
    <div className={'action-bar ladder' + (visible ? '' : ' is-hidden')} role="toolbar" aria-label="Selection actions" aria-hidden={!visible} inert={!visible}>
      <HoverButton style={next()} label="Offset" labelSide="top" className="ui-round ui-round--dark" onClick={() => st().openDialog('offset')}>
        <Ic.IconOffset />
      </HoverButton>
      {isText && (
        <HoverButton style={next()} label="Edit Text" labelSide="top" className="ui-round ui-round--dark" onClick={() => (st().setEditingText(selection[0]), st().openDialog('text'))}>
          <Ic.IconText />
        </HoverButton>
      )}
      {canShapeShift && (
        <HoverButton
          style={next()}
          label="ShapeShifter"
          labelSide="top"
          className="ui-round ui-round--dark"
          onClick={() => st().enterShapeShifter()}
        >
          <Ic.IconShapeShifter />
        </HoverButton>
      )}
      {groupItem && (
        <HoverButton style={next()} label={groupItem.label} labelSide="top" className="ui-round ui-round--dark" onClick={groupItem.onClick}>
          {groupItem.icon}
        </HoverButton>
      )}
      {/* Each stacked pair is its own flush dark pill that grows as the second action flies up. */}
      <Stacked
        style={next()}
        a={{ label: 'Mirror Horizontal', icon: <Ic.IconMirrorH />, onClick: () => st().mirrorSelected('h') }}
        b={{ label: 'Mirror Vertical', icon: <Ic.IconMirrorV />, onClick: () => st().mirrorSelected('v') }}
      />
      <Stacked
        style={next()}
        a={{ label: 'Duplicate', icon: <Ic.IconDuplicate />, onClick: () => st().duplicateSelected(false) }}
        b={{ label: 'Duplicate in Place', icon: <Ic.IconDuplicateInPlace />, onClick: () => st().duplicateSelected(true) }}
      />
      <Stacked
        style={next()}
        a={{ label: 'Bring to Front', icon: <Ic.IconFront />, onClick: () => st().bringToFront() }}
        b={{ label: 'Send to Back', icon: <Ic.IconBack />, onClick: () => st().sendToBack() }}
      />
      <HoverButton style={next()} label="Delete Object" labelSide="top" className="ui-round ui-round--dark" onClick={() => st().deleteSelected()}>
        <Ic.IconDelete />
      </HoverButton>
    </div>
    </>
  )
}

type Act = { label: string; icon: ReactNode; onClick: () => void }

/**
 * Studio's stacked button: hover (mouse) or a first tap (touch) reveals a second action above.
 * Labels appear above each button.
 */
function Stacked({ a, b, style }: { a: Act; b: Act; style?: CSSProperties }) {
  const [open, setOpen] = useState(false)
  // Which action the pointer is on; its name shows above the whole pill.
  const [hot, setHot] = useState<'a' | 'b' | null>(null)
  const touch = useRef(false)
  const t = useRef<ReturnType<typeof setTimeout>>(undefined)
  return (
    <div
      className={'stacked' + (open ? ' is-open' : '')}
      style={style}
      onPointerDown={(e) => {
        touch.current = e.pointerType === 'touch'
      }}
      onMouseEnter={() => {
        if (touch.current) return
        clearTimeout(t.current)
        setOpen(true)
      }}
      onMouseLeave={() => {
        if (touch.current) return
        t.current = setTimeout(() => setOpen(false), 120)
      }}
    >
      <span className={'stacked__label' + (hot && !touch.current ? ' is-shown' : '')} aria-hidden="true">
        {hot === 'b' ? b.label : a.label}
      </span>
      <div className="stacked__alt" onMouseEnter={() => setHot('b')} onMouseLeave={() => setHot(null)}>
        <HoverButton
          label={b.label}
          labelSide="top"
          className="ui-round ui-round--dark"
          onClick={() => {
            setOpen(false)
            b.onClick()
          }}
        >
          {b.icon}
        </HoverButton>
      </div>
      <div onMouseEnter={() => setHot('a')} onMouseLeave={() => setHot(null)}>
      <HoverButton
        label={a.label}
        labelSide="top"
        className="ui-round ui-round--dark"
        onClick={() => {
          // On touch the first tap only opens the stack; the second tap runs the action.
          if (touch.current && !open) {
            setOpen(true)
            return
          }
          setOpen(false)
          a.onClick()
        }}
      >
        {a.icon}
      </HoverButton>
      </div>
    </div>
  )
}

// ---------- Help + toast ----------
export function HelpButton() {
  return (
    <button className="help-launcher" onClick={() => useStore.getState().openDialog('shortcuts')} aria-label="Keyboard shortcuts" title="Keyboard shortcuts">
      <Ic.IconHelp size={22} />
      <span className="help-launcher__q">?</span>
      <span className="help-launcher__badge">1</span>
    </button>
  )
}

export function Toast() {
  const toast = useStore((s) => s.toast)
  const info = useStore((s) => s.toastInfo)
  // Studio's reference toast: at the top, with the path-type icon and an info button for its explainer.
  if (toast && info === 'reference')
    return (
      <div role="status" aria-live="polite" aria-atomic="true">
        <div className="toast toast--guide">
          <Ic.IconPathTypeLock size={20} />
          <span>{toast}</span>
          <button className="toast__info" aria-label="About reference paths" onClick={() => useStore.getState().openDialog('reference')}>
            <Ic.IconInfoOutline size={20} />
          </button>
        </div>
      </div>
    )
  // The live region stays mounted so screen readers announce each new message.
  return <div role="status" aria-live="polite" aria-atomic="true">{toast && <div className="toast">{toast}</div>}</div>
}
