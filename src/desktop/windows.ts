// Home and studio are separate windows in the desktop app. In a browser they are
// separate tabs, reached through named windows so each one is reused.
import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { isDesktop } from './runtime'
import { setLastDesign } from '../io/projectFile'

export const HOME_LABEL = 'home'
export const STUDIO_LABEL = 'studio'
/** Sent from the home window to an open studio window, with the design id as payload. */
export const OPEN_DESIGN_EVENT = 'open-design'

type WindowConfig = NonNullable<ConstructorParameters<typeof WebviewWindow>[1]>

const HOME_URL = '/account'
const STUDIO_URL = '/studio'

const HOME_WINDOW: WindowConfig = { title: 'Forma Studio', url: HOME_URL, width: 1080, height: 700, minWidth: 720, minHeight: 520 }
const STUDIO_WINDOW: WindowConfig = { title: 'Forma Studio', url: STUDIO_URL, width: 1440, height: 900, minWidth: 960, minHeight: 640 }

/** Bring an existing window to the front, or create it. */
async function showOrCreate(label: string, options: WindowConfig) {
  const existing = await WebviewWindow.getByLabel(label)
  if (existing) {
    await existing.show()
    await existing.setFocus()
    return
  }
  const win = new WebviewWindow(label, options)
  void win.once('tauri://error', (e) => console.error(`Could not open the ${label} window`, e))
}

/** Show the home window (desktop), or open it in a tab (browser). */
export async function openHome() {
  if (!isDesktop()) {
    window.open(HOME_URL, 'formastudio-home')
    return
  }
  await showOrCreate(HOME_LABEL, HOME_WINDOW)
}

/**
 * Open a saved design in the studio. The id is stored as the last design first, so a
 * studio that is starting up loads it. A studio that is already open is told to switch.
 */
export async function openDesignInStudio(id: string) {
  setLastDesign(id)
  if (!isDesktop()) {
    window.open(STUDIO_URL, 'formastudio-studio')
    return
  }
  const studio = await WebviewWindow.getByLabel(STUDIO_LABEL)
  if (studio) {
    await studio.show()
    await studio.setFocus()
    await emitTo(STUDIO_LABEL, OPEN_DESIGN_EVENT, id)
    return
  }
  await showOrCreate(STUDIO_LABEL, STUDIO_WINDOW)
}

/** Listen in the studio window for designs chosen from the home window. */
export function onOpenDesignRequest(cb: (id: string) => void): Promise<UnlistenFn> {
  return listen<string>(OPEN_DESIGN_EVENT, (e) => cb(e.payload))
}
