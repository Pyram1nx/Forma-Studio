// The standalone pages for /3d-carve, /joinery and /systainer. Each shows one tool full
// screen; Import takes its shapes to the studio's design, Close goes back to the studio.
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { ImportPayload, Units } from '../model/types'
import { defaultUnits, useStore } from '../state/store'
import { autosave, loadLast, setLastDesign } from '../io/projectFile'
import { flushDesigns } from '../storage/designStore'
import LoadingDomino from '../ui/LoadingDomino'
import { clearToolReturn, goToStudio, leaveTool, readHandoff, writeHandoff, type ToolId } from './toolRoutes'
import '../styles/app.css'
import '../styles/mobile-dialogs.css'
import '../styles/desktop.css'
import '../styles/no-select.css'

const TOOLS = {
  carve3d: { title: '3D Carve', Component: lazy(() => import('./carve3d/Carve3DDialog')) },
  joinery: { title: 'Joinery', Component: lazy(() => import('./dovetail/DovetailDialog')) },
  systainer: { title: 'Systainer Insert', Component: lazy(() => import('./systainer/SystainerDialog')) },
} satisfies Record<ToolId, unknown>

/**
 * Too large to hand over in sessionStorage: add it to the last design here and save that
 * (the studio opens it as usual, but the import is not an undo step there).
 */
async function importIntoLastDesign(payload: ImportPayload) {
  const st = useStore.getState()
  const last = loadLast()
  if (last) st.setDoc(last)
  st.importPayload(payload)
  const doc = useStore.getState().doc
  setLastDesign(doc.id)
  await autosave(doc)
  await flushDesigns()
  writeHandoff({ docId: doc.id, dirty: true })
}

export default function ToolPage({ tool }: { tool: ToolId }) {
  const { title, Component } = TOOLS[tool]
  // Units follow the design the shapes will land in.
  const [units] = useState<Units>(() => loadLast()?.units ?? defaultUnits())
  const [busy, setBusy] = useState(false)
  const importing = useRef(false)

  useEffect(() => {
    document.title = `Forma Studio | ${title}`
  }, [title])

  const onImport = (payload: ImportPayload) => {
    importing.current = true
    setBusy(true)
    void (async () => {
      if (!writeHandoff({ ...readHandoff(), payload })) await importIntoLastDesign(payload)
      clearToolReturn()
      goToStudio()
    })()
  }

  // The tool calls onClose right after onImport; that navigation is already under way.
  // Opened from the account home, Close goes back there instead of to the studio.
  const onClose = () => {
    if (!importing.current) leaveTool()
  }

  return (
    <div className="App theme--design tool-page">
      <Suspense fallback={<LoadingDomino withOverlay />}>
        <Component units={units} onClose={onClose} onImport={onImport} />
      </Suspense>
      {busy && <LoadingDomino withOverlay />}
    </div>
  )
}
