import { useEffect, useState } from 'react'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { isDesktop } from './runtime'
import { useStore } from '../state/store'

/** Dispatched on window by the app menu to run a check that reports "up to date" too. */
export const CHECK_UPDATES_EVENT = 'formastudio:check-updates'

/**
 * Checks GitHub Releases for a newer version when the app opens (desktop only). When one
 * exists, asks the user first, with the release notes available on request. Pass
 * checkOnLaunch={false} in windows that open after launch, so only one window checks.
 */
export default function UpdatePrompt({ checkOnLaunch = true }: { checkOnLaunch?: boolean }) {
  const [update, setUpdate] = useState<Update | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isDesktop()) return
    let cancelled = false
    const run = async (manual: boolean) => {
      try {
        const found = await check()
        if (cancelled) return
        if (found) setUpdate(found)
        else if (manual) useStore.getState().showToast('Forma Studio is up to date')
      } catch (e) {
        // A failed check (offline, release not public yet) should not interrupt the editor.
        console.warn('Update check failed', e)
        if (manual && !cancelled) useStore.getState().showToast('Could not check for updates')
      }
    }
    if (checkOnLaunch) void run(false)
    const onManual = () => void run(true)
    window.addEventListener(CHECK_UPDATES_EVENT, onManual)
    return () => {
      cancelled = true
      window.removeEventListener(CHECK_UPDATES_EVENT, onManual)
    }
  }, [checkOnLaunch])

  if (!update) return null

  const install = async () => {
    setError('')
    setBusy('Downloading…')
    let total = 0
    let got = 0
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === 'Started') total = ev.data.contentLength ?? 0
        if (ev.event === 'Progress') {
          got += ev.data.chunkLength
          if (total) setBusy(`Downloading ${Math.min(100, Math.round((got / total) * 100))}%`)
        }
        if (ev.event === 'Finished') setBusy('Installing…')
      })
      await relaunch()
    } catch (e) {
      setBusy(null)
      setError('The update could not be installed: ' + (e as Error).message)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-card update-card" role="dialog" aria-modal="true" aria-label="Update available">
        <div className="modal-card__head">Update available</div>
        <p>
          Forma Studio {update.version} is ready to download. You have version {update.currentVersion}. Download and install it now?
        </p>
        <details className="update-card__notes">
          <summary>Release notes</summary>
          <div className="update-card__body">{update.body?.trim() || 'No release notes were published for this version.'}</div>
        </details>
        {error && <p className="update-card__error">{error}</p>}
        <div className="update-card__actions">
          <button className="ss-btn" disabled={!!busy} onClick={() => setUpdate(null)}>
            Later
          </button>
          <button className="ss-btn ss-btn--primary" disabled={!!busy} onClick={install}>
            {busy ?? 'Download and install'}
          </button>
        </div>
      </div>
    </div>
  )
}
