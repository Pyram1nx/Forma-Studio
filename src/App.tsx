import LoadingDomino from './ui/LoadingDomino'
import { Component, lazy, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { newDoc, selectionHasReference, useStore } from './state/store'
import Canvas from './editor/Canvas'
import { ActionBar, HelpButton, LeftRail, Toast, TopLeft, TopRight, ZoomControls } from './editor/Chrome'
import { DesignPanel, PlanPanel } from './editor/Panels'
import { ReferenceDialog, ShapesPopover, ShortcutsDialog } from './editor/Popovers'
import OffsetMode from './editor/OffsetMode'
import RadiusMode from './editor/RadiusMode'
import ShapeShifter from './editor/ShapeShifter'
import TextDialog from './editor/TextDialog'
import AppMenu from './editor/AppMenu'
import AccountDialog from './account/AccountDialog'
import UpdatePrompt from './desktop/UpdatePrompt'
import { onOpenDesignRequest } from './desktop/windows'
import { isDesktop } from './desktop/runtime'
import { autosave, createAutosaver, loadLast, loadRecent, nextUntitledName, serialize } from './io/projectFile'
import { onRemoteDesignChange, saveDesign } from './storage/designStore'
import { uid } from './model/ids'
import { exportSvg, openFromComputer, openRecent, saveToComputer } from './editor/fileActions'
import { nudgeSelection } from './editor/ops'
import { MM_PER_IN } from './model/types'
import './styles/app.css'
import './styles/canvas.css'
import './styles/mobile-topbar.css'
import './styles/mobile-fab.css'
import './styles/mobile-sheet.css'
import './styles/mobile-dialogs.css'
import './styles/desktop.css'
import './styles/text-tool.css'
import './styles/no-select.css'

// Heavy feature dialogs are code-split so the core editor stays light.
const Carve3DDialog = lazy(() => import('./features/carve3d/Carve3DDialog'))
const TraceMode = lazy(() => import('./features/paper/TraceMode'))
const DovetailDialog = lazy(() => import('./features/dovetail/DovetailDialog'))
const SystainerDialog = lazy(() => import('./features/systainer/SystainerDialog'))
const BitLibraryDialog = lazy(() => import('./features/bitlibrary/BitLibrary').then((m) => ({ default: m.BitLibraryDialog })))

/**
 * Keyboard shortcuts, in one place. Escape closes the topmost thing (menu, popover,
 * dialog), then leaves the draw tool, then clears the selection. The canvas calls
 * preventDefault() when it consumes Escape/Enter/Backspace for its own drafts, and
 * this handler runs after it, so a consumed key is ignored here.
 */
function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState()
      const mod = e.metaKey || e.ctrlKey
      const k = e.key.toLowerCase()
      const inField = !!(e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]')

      // File shortcuts work everywhere, including over dialogs and text fields.
      if (mod && !e.altKey) {
        if (k === 's') {
          e.preventDefault()
          saveToComputer(e.shiftKey)
          return
        }
        if (k === 'o') {
          e.preventDefault()
          openFromComputer()
          return
        }
        if (k === 'e') {
          e.preventDefault()
          exportSvg(e.shiftKey)
          return
        }
      }

      if (e.defaultPrevented) return

      if (k === 'escape') {
        if (st.anchorPicking) st.setAnchorPicking(false)
        else if (st.shifter) st.exitShapeShifter()
        else if (st.menuOpen) st.setMenuOpen(false)
        else if (st.popover) st.setPopover(null)
        else if (st.dialog) {
          // Typing in a dialog field: Escape belongs to the field (dialogs handle their own Escape).
          if (inField) return
          st.openDialog(null)
        } else if (inField) return
        else if (st.tool !== 'select') st.setTool('select')
        else if (st.penEditId) st.setPenEdit(null)
        else if (st.selection.length) st.select([])
        else return
        e.preventDefault()
        return
      }

      if (inField) return
      if (st.shifter) return
      // Editing keys stay away from modal dialogs.
      if (st.dialog) return

      if (mod) {
        if (k === 'z') {
          e.preventDefault()
          if (e.shiftKey) st.redo()
          else st.undo()
        } else if (k === 'y') {
          e.preventDefault()
          st.redo()
        } else if (k === 'd') {
          e.preventDefault()
          st.duplicateSelected(false)
        } else if (k === 'g') {
          // Group / Ungroup (⇧) are Design actions.
          e.preventDefault()
          if (st.mode === 'design' && st.tool === 'select') {
            if (e.shiftKey) st.ungroupSelected()
            else st.groupSelected()
          }
        } else if (k === 'h') {
          // Studio's Toggle Reference: each selected object flips between reference and editable.
          e.preventDefault()
          if (st.mode === 'design' && st.tool === 'select') st.toggleReferenceSelected()
        } else if (k === 'a') {
          e.preventDefault()
          st.select(st.doc.shapes.filter((s) => !s.hidden && !s.locked).map((s) => s.id))
        } else if (k === '=' || k === '+') {
          e.preventDefault()
          st.zoomIn()
        } else if (k === '-') {
          e.preventDefault()
          st.zoomOut()
        } else if (k === '0') {
          e.preventDefault()
          st.zoomToFit()
        }
        return
      }

      // Single-letter and arrow shortcuts don't fire while the app menu is open.
      if (st.menuOpen) return

      if (k === 'delete' || k === 'backspace') {
        if (st.tool !== 'select' || st.penEditId) return
        e.preventDefault()
        // Plan shapes can be deleted too; review is display-only.
        if (st.mode !== 'review') st.deleteSelected()
      } else if (k.startsWith('arrow') && st.mode === 'design' && st.selection.length) {
        e.preventDefault()
        // A selection with a reference in it is locked as a whole (it doesn't drag either).
        if (selectionHasReference(st.doc, st.selection)) return
        const step = (st.doc.units === 'in' ? MM_PER_IN / 16 : 1) * (e.shiftKey ? 10 : 1)
        nudgeSelection(k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0)
      } else if (k === 'p' && e.shiftKey && st.mode === 'design') {
        st.setTool(st.tool === 'pen' ? 'select' : 'pen')
      } else if (k === 'p' && st.mode === 'design') {
        st.setTool(st.tool === 'draw' ? 'select' : 'draw')
      } else if (k === '1' || k === '2' || k === '3') {
        st.setMode(k === '1' ? 'design' : k === '2' ? 'plan' : 'review')
      } else if (k === 'f') {
        st.zoomToFit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** In the desktop app, the home window asks an open studio to switch to a design. */
function useOpenDesignRequests() {
  useEffect(() => {
    if (!isDesktop()) return
    const unlisten = onOpenDesignRequest((id) => openRecent(id))
    return () => {
      void unlisten.then((stop) => stop())
    }
  }, [])
}

function useAutosave() {
  // Restore the last design on load, then autosave (debounced) on every change.
  useEffect(() => {
    const last = loadLast()
    if (last) useStore.getState().setDoc(last)
    const saver = createAutosaver(() => useStore.getState().doc, autosave)
    const unsub = useStore.subscribe((s, prev) => saver.onChange(s.doc, prev.doc))
    // Account sync brought a newer version of the open design from another device.
    const unRemote = onRemoteDesignChange((id) => {
      const st = useStore.getState()
      if (st.doc.id !== id) return
      const remote = loadRecent(id)
      if (!remote || serialize(remote) === serialize(st.doc)) return
      if (saver.isPending() || st.shifter || st.penEditId) {
        // Edits here are about to save over it: keep the other device's version as a copy.
        const copyId = uid()
        const name = `${remote.name} (from another device)`
        void saveDesign({ id: copyId, name, updatedAt: remote.updatedAt, shapes: remote.shapes.length, data: serialize({ ...remote, id: copyId, name }) })
        st.showToast(`“${remote.name}” was also changed on another device. That version is saved as a copy.`)
        return
      }
      // Swap the content in place: mode, tool and view stay as they are.
      useStore.setState({ doc: remote, past: [], future: [], selection: [] })
      st.showToast('Updated with changes from another device')
    })
    const beforeUnload = (e: BeforeUnloadEvent) => {
      saver.cancel()
      autosave(useStore.getState().doc)
      // Any unsaved change prompts, whether or not a file handle exists.
      if (useStore.getState().dirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      unsub()
      unRemote()
      saver.cancel()
      window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [])
}

interface BoundaryState {
  error: Error | null
}

/** Catches render errors so a bad state shows a recovery screen instead of a blank page. */
class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Editor crashed', error, info.componentStack)
  }

  private startNew = () => {
    useStore.getState().setDoc(newDoc(nextUntitledName()))
    this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="ss-error" role="alert" style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <h2>Something went wrong</h2>
          <p>Your autosave is kept. Reload the page, or start a new design.</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button className="ss-btn" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button className="ss-btn" onClick={this.startNew}>
              Start a new design
            </button>
          </div>
        </div>
      </div>
    )
  }
}

export default function App() {
  const mode = useStore((s) => s.mode)
  const dialog = useStore((s) => s.dialog)
  const units = useStore((s) => s.doc.units)
  const name = useStore((s) => s.doc.name)
  useKeyboard()
  useAutosave()
  useOpenDesignRequests()
  useEffect(() => {
    document.title = `Forma Studio | ${name}`
  }, [name])

  const st = useStore.getState
  const closeDialog = () => st().openDialog(null)

  return (
    <ErrorBoundary>
      <div className={'App theme--' + mode}>
        <div className="ui-layer">
          <Canvas />
        </div>
        <TopLeft />
        <LeftRail />
        <TopRight />
        <DesignPanel />
        <PlanPanel />
        <ActionBar />
      <ZoomControls />
        <ShapesPopover />
        <ShapeShifter />
        <OffsetMode />
        <RadiusMode />
        <HelpButton />
        <AppMenu />
        <TextDialog />
        <ShortcutsDialog />
        <ReferenceDialog />
        <AccountDialog />
        <UpdatePrompt checkOnLaunch={false} />
        <Suspense fallback={<LoadingDomino withOverlay />}>
          {dialog === 'carve3d' && <Carve3DDialog units={units} onClose={closeDialog} onImport={(p) => st().importPayload(p)} />}
          {dialog === 'trace' && <TraceMode units={units} onClose={closeDialog} onImport={(p) => st().importPayload(p)} />}
          {dialog === 'bits' && <BitLibraryDialog units={units} onClose={closeDialog} />}
          {dialog === 'dovetail' && <DovetailDialog units={units} onClose={closeDialog} onImport={(p) => st().importPayload(p)} />}
          {dialog === 'systainer' && <SystainerDialog units={units} onClose={closeDialog} onImport={(p) => st().importPayload(p)} />}
        </Suspense>
        <Toast />
      </div>
    </ErrorBoundary>
  )
}
