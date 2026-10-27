// Native save / open for the desktop app. Used instead of the browser file pickers,
// which WebView does not provide.
import { open, save } from '@tauri-apps/plugin-dialog'
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'

export interface DesktopFileHandle {
  kind: 'desktop'
  name: string
  path: string
}

const basename = (p: string) => p.split(/[\\/]/).pop() || p

/** Ask where to save. Throws an AbortError when the user cancels, like the browser picker. */
export async function desktopPickSave(suggestedName: string, ext: string): Promise<DesktopFileHandle> {
  const path = await save({
    defaultPath: suggestedName,
    filters: [{ name: 'Forma Studio design', extensions: [ext.replace(/^\./, '')] }],
  })
  if (!path) throw new DOMException('Save cancelled', 'AbortError')
  return { kind: 'desktop', name: basename(path), path }
}

/** Ask which design to open. Throws an AbortError when the user cancels. */
export async function desktopPickOpen(exts: string[]): Promise<DesktopFileHandle> {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'Forma Studio design', extensions: exts }],
  })
  if (!path) throw new DOMException('Open cancelled', 'AbortError')
  return { kind: 'desktop', name: basename(path), path }
}

export const desktopWrite = (h: DesktopFileHandle, text: string) => writeTextFile(h.path, text)
export const desktopRead = (h: DesktopFileHandle) => readTextFile(h.path)
