import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import AccountPanel from '../account/AccountPanel'
import { useSession } from '../account/useSession'
import { accountsEnabled } from '../account/api'
import SyncStatus from '../account/SyncStatus'
import { persistPendingNow, subscribeDesigns } from '../storage/designStore'
import { copyLocalDesigns, countLocalDesignsToCopy } from '../storage/sync'
import { exportSVG } from '../io/svgExport'
import { autosave, listRecent, loadRecent, nextUntitledName, type RecentEntry } from '../io/projectFile'
import { defaultUnits, newDoc } from '../state/store'
import type { Units } from '../model/types'
import LoadingDomino from '../ui/LoadingDomino'
import SettingsPage from './SettingsPage'

// Code-split like the other feature surfaces.
const BitLibrary = lazy(() => import('../features/bitlibrary/BitLibrary'))
import { openDesignInStudio } from '../desktop/windows'
import * as Ic from '../ui/icons'
import UpdatePrompt from '../desktop/UpdatePrompt'
import '../styles/home.css'

type Page = 'designs' | 'bits' | 'settings' | 'account'

/** The home window: saved designs, the bit gallery, presets and the account. Opens designs in the studio window. */
export default function HomeApp({ initialPage = 'designs' }: { initialPage?: Page }) {
  const [page, setPage] = useState<Page>(initialPage)
  const session = useSession()
  const [designs, setDesigns] = useState<RecentEntry[]>(() => listRecent())
  const [error, setError] = useState('')
  const [units, setUnits] = useState<Units>(defaultUnits)
  const [toCopy, setToCopy] = useState(0)

  useEffect(() => {
    document.title = 'Forma Studio'
    // Saved in another window (the studio), pulled from the account, or deleted.
    return subscribeDesigns(() => setDesigns(listRecent()))
  }, [])

  useEffect(() => {
    void countLocalDesignsToCopy().then(setToCopy)
  }, [designs])

  const openDesign = async (id: string) => {
    setError('')
    try {
      await openDesignInStudio(id)
    } catch (e) {
      setError('Could not open the design: ' + (e as Error).message)
    }
  }

  const newDesign = () => {
    const doc = newDoc(nextUntitledName())
    // Saved straight away, and journalled synchronously, so the studio opening next has it.
    // (No await before window.open: browsers only allow popups straight after the click.)
    void autosave(doc)
    persistPendingNow()
    void openDesign(doc.id)
  }

  const copyToAccount = async () => {
    await copyLocalDesigns()
    setToCopy(await countLocalDesignsToCopy())
  }

  return (
    <div className="home">
      {/* Phones only (home.css): brand + account avatar; the sidebar's nav becomes a bottom tab bar. */}
      <header className="home__topbar">
        <div className="home__brand">
          <Ic.FormaLogo size={24} />
          <span className="forma-wordmark">Forma Studio</span>
        </div>
        <button
          className="home__topbar-account"
          onClick={() => setPage('account')}
          aria-label={session ? `Account (${session.email})` : 'Account'}
        >
          <span className="home__avatar" aria-hidden="true">
            {session ? session.email.charAt(0).toUpperCase() : '?'}
          </span>
        </button>
      </header>
      <aside className="home__side">
        <div className="home__brand">
          <Ic.FormaLogo size={24} />
          <span className="forma-wordmark">Forma Studio</span>
        </div>
        <nav className="home__nav" aria-label="Home">
          <button className="home__nav-item" aria-current={page === 'designs' ? 'page' : undefined} onClick={() => setPage('designs')}>
            <Ic.IconFolderOpen size={18} /> Designs
          </button>
          <button className="home__nav-item" aria-current={page === 'bits' ? 'page' : undefined} onClick={() => setPage('bits')}>
            <Ic.IconBitLibrary size={18} /> Bits
          </button>
          <button className="home__nav-item" aria-current={page === 'settings' ? 'page' : undefined} onClick={() => setPage('settings')}>
            <Ic.IconSliders size={18} /> Settings
          </button>
          <button className="home__nav-item" aria-current={page === 'account' ? 'page' : undefined} onClick={() => setPage('account')}>
            <Ic.IconUser size={18} /> Account
          </button>
        </nav>
        <button className="home__account-chip" onClick={() => setPage('account')}>
          <span className="home__avatar" aria-hidden="true">
            {session ? session.email.charAt(0).toUpperCase() : '?'}
          </span>
          <span className="home__account-text">{session ? session.email : accountsEnabled() ? 'Sign in' : 'Local only'}</span>
        </button>
      </aside>

      <main className="home__main">
        {page === 'designs' ? (
          <>
            <header className="home__head">
              <div>
                <h1>Designs</h1>
                {session && !session.needsSignIn ? (
                  <p className="ss-muted">
                    Saved on this device and in your account. <SyncStatus />
                  </p>
                ) : session ? (
                  <p className="ss-muted">
                    Saved on this device. <SyncStatus />
                  </p>
                ) : (
                  <p className="ss-muted">Saved in this browser on this device{accountsEnabled() ? '. Sign in to sync them across devices.' : '.'}</p>
                )}
              </div>
              <button className="ss-btn ss-btn--primary" onClick={newDesign}>
                <Ic.IconNewFile size={16} /> New design
              </button>
            </header>
            {error && <p className="home__error" role="alert">{error}</p>}
            {session && toCopy > 0 && (
              <div className="home__notice">
                <span>
                  {toCopy} {toCopy === 1 ? 'design' : 'designs'} on this device {toCopy === 1 ? 'was' : 'were'} made without an account.
                </span>
                <button className="ss-btn ss-btn--sm" onClick={copyToAccount}>
                  Copy to account
                </button>
              </div>
            )}
            {designs.length ? (
              <ul className="home-grid">
                {designs.map((d) => (
                  <li key={d.id}>
                    {/* Keyed on the save time, so the thumbnail is rebuilt after each change. */}
                    <DesignCard key={d.id + d.updatedAt} entry={d} onOpen={() => openDesign(d.id)} />
                  </li>
                ))}
              </ul>
            ) : (
              <div className="home-empty">
                <Ic.IconLayers size={36} />
                <h2>No designs yet</h2>
                <p className="ss-muted">Start a new design and it will be saved here.</p>
                <button className="ss-btn ss-btn--primary" onClick={newDesign}>
                  New design
                </button>
              </div>
            )}
          </>
        ) : page === 'bits' ? (
          <Suspense fallback={<LoadingDomino />}>
            <BitLibrary units={units} onUnitsChange={setUnits} />
          </Suspense>
        ) : page === 'settings' ? (
          <SettingsPage />
        ) : (
          <section className="home-account">
            <h1>Account</h1>
            <div className="home-account__card">
              <AccountPanel />
            </div>
          </section>
        )}
      </main>
      <UpdatePrompt checkOnLaunch />
    </div>
  )
}

function DesignCard({ entry, onOpen }: { entry: RecentEntry; onOpen: () => void }) {
  // Thumbnail of the design as it would export. Built once per saved version.
  const thumb = useMemo(() => {
    try {
      const doc = loadRecent(entry.id)
      if (!doc || !doc.shapes.length) return null
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(exportSVG(doc, undefined, { includeReference: true }))
    } catch {
      return null
    }
  }, [entry.id])

  const updated = new Date(entry.updatedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })

  return (
    <button className="home-card" onClick={onOpen} aria-label={`Open ${entry.name}`}>
      <span className="home-card__thumb">
        {thumb ? <img src={thumb} alt="" /> : <Ic.IconDraw size={28} />}
      </span>
      <span className="home-card__name">{entry.name}</span>
      <span className="home-card__meta">
        {entry.shapes} {entry.shapes === 1 ? 'shape' : 'shapes'} · edited {updated}
      </span>
    </button>
  )
}
