import { newDoc, selectedShapes, useStore } from '../state/store'
import { downloadBlob, loadRecent, nextUntitledName, openDocFromComputer, saveDoc, supportsFileSystemAccess } from '../io/projectFile'
import { exportSVG } from '../io/svgExport'
import { uid } from '../model/ids'

const isAbort = (e: unknown) => (e as Error)?.name === 'AbortError'

/**
 * Before replacing the current design (New, Open, Import, Open Recent, Duplicate):
 * when there are unsaved changes, ask. Returns true when it is fine to go ahead.
 */
export function confirmDiscard(): boolean {
  const st = useStore.getState()
  if (!st.dirty) return true
  return window.confirm(`Discard unsaved changes to ${st.doc.name}?`)
}

export async function saveToComputer(saveAs = false) {
  const st = useStore.getState()
  const doc = st.doc
  try {
    const h = await saveDoc(doc, st.fileHandle, saveAs)
    st.setFileHandle(h)
    // Only clears dirty if nothing changed while the file was being written.
    useStore.getState().markSaved(doc)
    st.showToast(h ? `Saved ${h.name}` : 'Design downloaded — open it later with “Open from Computer”')
  } catch (e) {
    if (!isAbort(e)) st.showToast('Save failed: ' + (e as Error).message)
  }
}

export async function openFromComputer() {
  const st = useStore.getState()
  if (!confirmDiscard()) return
  try {
    const { doc, handle } = await openDocFromComputer()
    st.setDoc(doc, handle)
    st.showToast(`Opened ${doc.name}`)
  } catch (e) {
    if (!isAbort(e) && (e as Error).message !== 'No file') st.showToast('Could not open: ' + (e as Error).message)
  }
}

/** Open a design from browser storage (Open Recent). */
export function openRecent(id: string) {
  const st = useStore.getState()
  if (!confirmDiscard()) return
  const doc = loadRecent(id)
  if (!doc) {
    st.showToast('That design could not be opened')
    return
  }
  st.setDoc(doc, null)
  st.showToast(`Opened ${doc.name}`)
}

export function exportSvg(selectionOnly = false) {
  const st = useStore.getState()
  const only = selectionOnly && st.selection.length ? selectedShapes(st) : undefined
  if (!(only ?? st.doc.shapes).some((s) => !s.hidden && !s.locked)) {
    st.showToast('Nothing to export yet')
    return
  }
  const svg = exportSVG(st.doc, only)
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), st.doc.name.replace(/[\\/:*?"<>|]+/g, '-') + '.svg')
}

export function newDesign() {
  if (!confirmDiscard()) return
  useStore.getState().setDoc(newDoc(nextUntitledName()))
}

export function duplicateDesign() {
  if (!confirmDiscard()) return
  const st = useStore.getState()
  const copy = { ...structuredClone(st.doc), id: uid('d'), name: st.doc.name + ' copy' }
  st.setDoc(copy)
  // The copy only exists in memory/autosave until it's saved.
  useStore.setState({ dirty: true })
  st.showToast('Duplicated design')
}

export const saveLabel = () => (supportsFileSystemAccess() ? 'Save to Computer' : 'Download Design File')
