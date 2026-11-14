import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import AccountPanel from '../account/AccountPanel'
import { useSession } from '../account/useSession'
import { accountsEnabled } from '../account/api'
import SyncStatus from '../account/SyncStatus'
import { persistPendingNow, subscribeDesigns } from '../storage/designStore'
import { copyLocalDesigns, countLocalDesignsToCopy } from '../storage/sync'
import { autosave, listRecent, nextUntitledName, type RecentEntry } from '../io/projectFile'
import { defaultUnits, newDoc } from '../state/store'
import type { Units } from '../model/types'
import LoadingDomino from '../ui/LoadingDomino'
import SettingsPage from './SettingsPage'

// Code-split like the other feature surfaces.
const BitLibrary = lazy(() => import('../features/bitlibrary/BitLibrary'))
const SystainersPage = lazy(() => import('./SystainersPage'))
const JointsPage = lazy(() => import('./JointsPage'))
const TapeGenerator = lazy(() => import('../features/tape/TapeGenerator'))
import { openDesignInStudio } from '../desktop/windows'
import * as Ic from '../ui/icons'
import DesignPreview from '../ui/DesignPreview'
import UpdatePrompt from '../desktop/UpdatePrompt'
import '../styles/home.css'

export type Page = 'designs' | 'systainers' | 'joints' | 'tape' | 'bits' | 'settings' | 'account'

interface NavItem {
  page: Page
  label: string
  /** Shorter label for the phone tab bar. */
  short?: string
  icon: ReactNode
}

// The sidebar, in groups. On phones it becomes a scrolling bottom tab bar (home.css).
const NAV: { label: string; items: NavItem[] }[] = [
  {
    label: 'Studio',
    items: [
      { page: 'designs', label: 'Studio designs', short: 'Designs', icon: <Ic.IconFolderOpen size={18} /> },
      { page: 'systainers', label: 'Systainers', icon: <Ic.IconSystainer size={18} /> },
      { page: 'joints', label: 'Joints', icon: <Ic.IconDovetail size={18} /> },
      { page: 'tape', label: 'Tape generator', short: 'Tape', icon: <Ic.IconTape size={18} /> },
    ],
  },
  { label: 'Library', items: [{ page: 'bits', label: 'Bits', icon: <Ic.IconBitLibrary size={18} /> }] },
  {
    label: 'You',
    items: [
      { page: 'settings', label: 'Settings', icon: <Ic.IconSliders size={18} /> },
      { page: 'account', label: 'Account', icon: <Ic.IconUser size={18} /> },
    ],
  },
]
const PAGES = NAV.flatMap((g) => g.items.map((i) => i.page))

/** /account?page=systainers opens that page (tools opened from here come back that way). */
function pageFromUrl(): Page | null {
  const p = new URLSearchParams(window.location.search).get('page')
  return PAGES.includes(p as Page) ? (p as Page) : null
}

/** The home window: saved designs, the tools, the bit gallery, presets and the account. Opens designs in the studio window. */
export default function HomeApp({ initialPage = 'designs' }: { initialPage?: Page }) {
  const [page, setPageState] = useState<Page>(() => pageFromUrl() ?? initialPage)
  const setPage = (next: Page) => {
    setPageState(next)
    // Keep the page in the address so a reload (or Close in a tool) lands back on it.
    const url = new URL(window.location.href)
    url.searchParams.set('page', next)
    window.history.replaceState(window.history.state, '', url)
  }
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
          {NAV.map((group) => (
            <div className="home__nav-group" key={group.label} role="group" aria-labelledby={`home-nav-${group.label}`}>
              <span className="home__nav-label" id={`home-nav-${group.label}`}>
                {group.label}
              </span>
              {group.items.map((item) => (
                <button
                  key={item.page}
                  className="home__nav-item"
                  aria-current={page === item.page ? 'page' : undefined}
                  onClick={() => setPage(item.page)}
                >
                  <span className="home__nav-icon">{item.icon}</span>
                  <span className="home__nav-text">{item.label}</span>
                  {item.short && (
                    <span className="home__nav-short" aria-hidden="true">
                      {item.short}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
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
                <h1>Studio designs</h1>
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
        ) : page === 'systainers' || page === 'joints' || page === 'tape' ? (
          <Suspense fallback={<LoadingDomino />}>
            {page === 'systainers' ? <SystainersPage units={units} /> : page === 'joints' ? <JointsPage units={units} /> : <TapeGenerator units={units} />}
          </Suspense>
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
  const updated = new Date(entry.updatedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })

  return (
    <button className="home-card" onClick={onOpen} aria-label={`Open ${entry.name}`}>
      <DesignPreview id={entry.id} className="home-card__thumb" />
      <span className="home-card__name">{entry.name}</span>
      <span className="home-card__meta">
        {entry.shapes} {entry.shapes === 1 ? 'shape' : 'shapes'} · edited {updated}
      </span>
    </button>
  )
}
