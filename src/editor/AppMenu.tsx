import { useRef, useState, type ReactNode } from 'react'
import { confirmDiscard } from './fileActions'
import { useStore } from '../state/store'
import * as Ic from '../ui/icons'
import { listRecent, removeRecent } from '../io/projectFile'
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

export default function AppMenu() {
  const open = useStore((s) => s.menuOpen)
  const doc = useStore((s) => s.doc)
  const dirty = useStore((s) => s.dirty)
  const selection = useStore((s) => s.selection)
  const [recentOpen, setRecentOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const cancelRename = useRef(false)
  const st = useStore.getState
  const close = () => {
    setRecentOpen(false)
    setRenaming(false)
    st().setMenuOpen(false)
  }
  const run = (fn: () => void, confirm = false) => () => {
    if (confirm && !confirmDiscard()) return
    close()
    fn()
  }
  const recent = recentOpen ? listRecent() : []
  const mod = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'
  const visible = doc.shapes.filter((s) => !s.hidden)
  const selected = visible.filter((s) => selection.includes(s.id))

  return (
    <>
      <div className={'app-menu-scrim' + (open ? ' is-open' : '')} onPointerDown={close} />
      <aside className={'app-menu' + (open ? ' is-open' : '')} aria-label="Menu" inert={!open}>
        <div className="app-menu__leading">
          <div className="app-menu__top">
            <div className="app-menu__wordmark">FORMA</div>
            <button className="app-menu__close" onClick={close} aria-label="Close menu">
              <Ic.IconClose />
            </button>
          </div>
          {renaming ? (
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
              <Item icon={<Ic.IconRecent />} label="Open Recent" onClick={() => setRecentOpen(true)} right={<Ic.IconChevronRight size={18} />} />
            </>
          ) : (
            <div className="recent">
              <button className="recent__back" onClick={() => setRecentOpen(false)}>
                <Ic.IconChevronLeft size={18} /> Open Recent
              </button>
              {!recent.length && <div className="ss-muted recent__empty">No recent designs in this browser yet.</div>}
              {recent.map((r) => (
                <div key={r.id} className={'recent__row' + (r.id === doc.id ? ' is-current' : '')}>
                  <button
                    className="recent__open"
                    onClick={() => {
                      if (r.id === doc.id) return close()
                      openRecent(r.id)
                      close()
                    }}
                  >
                    <span className="recent__name">{r.name}</span>
                    <span className="ss-muted">
                      {new Date(r.updatedAt).toLocaleString()} · {r.shapes} paths
                    </span>
                  </button>
                  {r.id !== doc.id && (
                    <button
                      className="recent__del"
                      aria-label={`Remove ${r.name} from this browser`}
                      title="Remove from this browser"
                      onClick={() => {
                        removeRecent(r.id)
                        setRecentOpen(false)
                        setTimeout(() => setRecentOpen(true))
                      }}
                    >
                      <Ic.IconClose size={16} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="app-menu__dashboard">
          <div className="app-menu__goto">Go To</div>
          <Item icon={<Ic.IconFolderOpen />} label="Designs" onClick={run(() => void openHome())} />
          <Item icon={<Ic.IconCube />} label="3D Carve" onClick={run(() => st().openDialog('carve3d'))} right={<span className="ss-badge ss-badge--new">new</span>} />
          <Item icon={<Ic.IconTrace />} label="Trace" onClick={run(() => st().openDialog('trace'))} right={<span className="ss-badge ss-badge--new">new</span>} />
          <Item icon={<Ic.IconKeyboard />} label="Keyboard Shortcuts" onClick={run(() => st().openDialog('shortcuts'))} />
          {accountsEnabled() && (
            <Item icon={<Ic.IconUser />} label="Account" onClick={run(() => st().openDialog('account'))} right={<span className="ss-muted">{getSession()?.email ?? 'Sign in'}</span>} />
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
