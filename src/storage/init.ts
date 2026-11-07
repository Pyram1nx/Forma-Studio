// Start-up for local storage and account sync. main.tsx awaits this before rendering the
// studio, the home window or the bit gallery, so every page reads its space synchronously.
import { flushDesigns, initDesignStore, onFirstDesignSave } from './designStore'
import { reloadOnSpaceChange } from './space'
import { finishPendingClears, startSync } from './sync'

/**
 * Ask the browser to keep this site's storage even when the disk runs low. Chrome and Edge
 * decide silently; Firefox may ask once. Asked on the first save, not on load, so nobody is
 * prompted before they have made something worth keeping.
 */
async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist()
  } catch {
    /* not supported: storage is best-effort */
  }
}

export async function initStorage() {
  await initDesignStore()
  await finishPendingClears()
  onFirstDesignSave(() => void requestPersistence())
  reloadOnSpaceChange(flushDesigns)
  startSync()
}
