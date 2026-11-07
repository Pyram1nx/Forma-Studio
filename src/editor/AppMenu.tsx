import { useRef, useState, type ReactNode } from 'react'
import { confirmDiscard } from './fileActions'
import { useStore } from '../state/store'
import { THEME_LABELS, THEME_PREFS, useTheme } from '../state/theme'
import * as Ic from '../ui/icons'
import { listRecent, removeRecent, type RecentEntry } from '../io/projectFile'
import DesignPreview from '../ui/DesignPreview'
import { getSession, accountsEnabled } from '../account/api'
import { isDesktop } from '../desktop/runtime'
import { CHECK_UPDATES_EVENT } from '../desktop/UpdatePrompt'
import { openHome } from '../desktop/windows'
import { duplicateDesign, exportSvg, newDesign, openFromComputer, openRecent, saveLabel, saveToComputer } from './fileActions'

/** Unsaved work needs confirmation before a different design replaces it. */

function Item({ icon, label, onClick, right }: { icon: ReactNode; label: string; onClick: () => void; right?: ReactNode }) {
  return (
    <button className="app-menu__item" onClick={onClick}>
      <span className="app-menu__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="app-menu__label">{label}</span>
      {right}
    </button>
  )
}

/** Studio's short date: 26-11-07. */
function shortDate(when: string | number) {
  const d = new Date(when)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getFullYear() % 100)}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function RecentRow({ entry, selected, onSelect, onOpen, onRemove }: { entry: RecentEntry; selected: boolean; onSelect: () => void; onOpen: () => void; onRemove?: () => void }) {
  return (
    <div className={'recent__row' + (selected ? ' is-selected' : '')}>
      <button className="recent__pick" aria-pressed={selected} onClick={onSelect} onDoubleClick={onOpen}>
        <DesignPreview id={entry.id} className="recent__thumb" />
        <span className="recent__text">
          <span className="recent__name">{entry.name}</span>
          <span className="recent__info">
            Modified<span className="recent__date">{shortDate(entry.updatedAt)}</span>
          </span>
        </span>
      </button>
      {onRemove && (
        <button className="recent__del" aria-label={`Remove ${entry.name} from this browser`} title="Remove from this browser" onClick={onRemove}>
          <Ic.IconClose size={16} />
        </button>
      )}
    </div>
  )
}

export default function AppMenu() {
  const open = useStore((s) => s.menuOpen)
  const doc = useStore((s) => s.doc)
  const dirty = useStore((s) => s.dirty)
  const selection = useStore((s) => s.selection)
  const theme = useTheme()
  const [recentOpen, setRecentOpen] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [, setRecentVersion] = useState(0)
  const [renaming, setRenaming] = useState(false)
  const cancelRename = useRef(false)
  const st = useStore.getState
  const close = () => {
    setRecentOpen(false)
    setPicked(null)
    setRenaming(false)
    st().setMenuOpen(false)
  }
  const run = (fn: () => void, confirm = false) => () => {
    if (confirm && !confirmDiscard()) return
    close()
    fn()
  }
  // The home window lists every design; the menu keeps to the latest few.
  const recent = recentOpen ? listRecent().slice(0, 30) : []
  const showRecent = (on: boolean) => {
    setPicked(null)
    setRecentOpen(on)
  }
  const openPicked = (id: string | null) => {
    if (!id) return
    if (id !== doc.id) openRecent(id)
    close()
  }
  const mod = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'
  const visible = doc.shapes.filter((s) => !s.hidden)
  const selected = visible.filter((s) => selection.includes(s.id))

  return (
    <>
      <div className={'app-menu-scrim' + (open ? ' is-open' : '')} onPointerDown={close} />
      <aside className={'app-menu' + (open ? ' is-open' : '')} aria-label="Menu" inert={!open}>
        <div className={'app-menu__leading' + (recentOpen ? ' is-full' : '')}>
          <div className="app-menu__top">
            <div className="app-menu__wordmark">FORMA</div>
            <button className="app-menu__close" onClick={close} aria-label="Close menu">
              <Ic.IconClose />
            </button>
          </div>
          {recentOpen ? (
            <div className="app-menu__separator" />
          ) : renaming ? (
            <input
              className="app-menu__rename"
              aria-label="Design name"
              autoFocus
              defaultValue={doc.name}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (!cancelRename.current && v && v !== doc.name) st().rename(v)
                cancelRename.current = false
                setRenaming(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') {
                  cancelRename.current = true
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
            />
          ) : (
            <div className="app-menu__file-name">{doc.name}</div>
          )}
          {!recentOpen ? (
            <>
              <Item icon={<Ic.IconPencil />} label="Rename" onClick={() => setRenaming(true)} />
              <Item
                icon={<Ic.IconSave />}
                label={saveLabel()}
                onClick={run(() => saveToComputer(false))}
                right={
                  <span className="app-menu__kbd">
                    {dirty && <span className="app-menu__dirty" aria-label="Unsaved changes" />} {mod}S
                  </span>
                }
              />
              <Item icon={<Ic.IconFolderOpen />} label="Open from Computer" onClick={run(openFromComputer)} right={<span className="app-menu__kbd">{mod}O</span>} />
              <Item icon={<Ic.IconDownload />} label="Export SVG" onClick={run(() => exportSvg(false))} right={<span className="export-count">Unlimited</span>} />
              {selection.length > 0 && (
                <Item icon={<Ic.IconDownload />} label="Export Selection" onClick={run(() => exportSvg(true))} right={<span className="export-count">{selected.length}</span>} />
              )}
              {doc.shapes.some((s) => s.locked) && (
                <Item icon={<Ic.IconUnlock />} label="Unlock All" onClick={run(() => st().unlockAll())} />
              )}
              <div className="app-menu__divider" />
              <Item icon={<Ic.IconCopyDesign />} label="Duplicate Design" onClick={run(duplicateDesign)} />
              <Item icon={<Ic.IconNewFile />} label="New Design" onClick={run(newDesign)} />
              <Item icon={<Ic.IconRecent />} label="Open Recent" onClick={() => showRecent(true)} right={<Ic.IconChevronRight size={18} />} />
            </>
          ) : (
            <div className="recent">
              <div className="recent__head">
                <Ic.IconRecents />
                <h2 className="recent__title">Recents</h2>
              </div>
              <div className="recent__list">
                {!recent.length && <div className="ss-muted recent__empty">No designs saved here yet.</div>}
                {recent.map((r) => (
                  <RecentRow
                    key={r.id + r.updatedAt}
                    entry={r}
                    selected={picked === r.id}
                    onSelect={() => setPicked(r.id)}
                    onOpen={() => openPicked(r.id)}
                    onRemove={
                      r.id === doc.id
                        ? undefined
                        : () => {
                            removeRecent(r.id)
                            if (picked === r.id) setPicked(null)
                            setRecentVersion((v) => v + 1)
                          }
                    }
                  />
                ))}
              </div>
              <div className="recent__foot">
                <div className="recent__actions">
                  <button className="recent__open-btn" disabled={!picked} onClick={() => openPicked(picked)}>
                    Open
                  </button>
                  <button className="recent__cancel" aria-label="Back to menu" onClick={() => showRecent(false)}>
                    <Ic.IconClose />
                  </button>
                </div>
                <button className="recent__browse" onClick={run(() => void openHome())}>
                  Browse all my Designs
                  <Ic.IconOpenExternal size={15} />
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="app-menu__dashboard" hidden={recentOpen}>
          <div className="app-menu__goto">Go To</div>
          <Item icon={<Ic.IconFolderOpen />} label="Designs" onClick={run(() => void openHome())} />
          <Item icon={<Ic.IconCube />} label="3D Carve" onClick={run(() => st().openDialog('carve3d'))} right={<span className="ss-badge ss-badge--new">new</span>} />
          <Item icon={<Ic.IconTrace />} label="Trace" onClick={run(() => st().openDialog('trace'))} right={<span className="ss-badge ss-badge--new">new</span>} />
          <Item icon={<Ic.IconDovetail />} label="Dovetails" onClick={run(() => st().openDialog('dovetail'))} right={<span className="ss-badge ss-badge--new">new</span>} />
          <Item icon={<Ic.IconSystainer />} label="Systainer Insert" onClick={run(() => st().openDialog('systainer'))} right={<span className="ss-badge ss-badge--new">new</span>} />
          <Item icon={<Ic.IconBitLibrary />} label="Bit Gallery" onClick={run(() => st().openDialog('bits'))} />
          <Item
            icon={<Ic.IconMoon />}
            label="Appearance"
            onClick={() => theme.set(THEME_PREFS[(THEME_PREFS.indexOf(theme.pref) + 1) % THEME_PREFS.length])}
            right={<span className="ss-muted">{THEME_LABELS[theme.pref]}</span>}
          />
          <Item icon={<Ic.IconKeyboard />} label="Keyboard Shortcuts" onClick={run(() => st().openDialog('shortcuts'))} />
          {accountsEnabled() && (
            <Item icon={<Ic.IconUser />} label="Account" onClick={run(() => st().openDialog('account'))} right={<span className="ss-muted">{getSession()?.needsSignIn ? 'Sign in again' : (getSession()?.email ?? 'Sign in')}</span>} />
          )}
          {isDesktop() && (
            <Item icon={<Ic.IconDownload />} label="Check for Updates" onClick={run(() => window.dispatchEvent(new Event(CHECK_UPDATES_EVENT)))} />
          )}
          <div className="app-menu__foot ss-muted">
            Forma Studio · runs locally in your browser.
            <br />
            Not affiliated with Shaper Tools.
          </div>
        </div>
      </aside>
    </>
  )
}
