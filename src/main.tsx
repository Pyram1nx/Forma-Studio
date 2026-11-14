import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
// First so the store and file code below read migrated storage keys.
import './state/legacyStorage'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans/700.css'
import '@fontsource/ibm-plex-sans-condensed/500.css'
import '@fontsource/dosis/700.css'
import './styles/tokens.css'
import './styles/components.css'
import './index.css'
import './styles/caliper.css'
import './styles/numpad.css'
import App from './App'
import HomeApp from './home/HomeApp'
import LandingPage from './landing/LandingPage'
import TraceTestCard from './features/paper/TraceTestCard'
import LoadingDomino from './ui/LoadingDomino'
import { installPinchZoomGuard } from './ui/pinchZoomGuard'
import { installCaliperInput } from './ui/caliperInput'
import { installNumpad } from './ui/numpad'
import { installTheme } from './state/theme'
import { initStorage } from './storage/init'
import { toolForPath } from './features/toolRoutes'

// The bit gallery and the tool pages are code-split like the other heavy features.
const ToolPage = lazy(() => import('./features/ToolPage'))
const BitLibraryPage = lazy(() => import('./features/bitlibrary/BitLibrary').then((m) => ({ default: m.BitLibraryPage })))

// Routes: / is the public home page, /account the account and saved designs, /bits the bit
// gallery, /studio the editor, and /3d-carve, /joinery and /systainer the tools that make
// shapes for it. ?view=tracecard shows a Trace test card to scan. Unknown paths go to the
// home page.
const path = window.location.pathname.replace(/\/+$/, '') || '/'
const view = new URLSearchParams(window.location.search).get('view')
const tool = toolForPath(path)
const appPage = view !== 'tracecard' && (['/studio', '/account', '/bits'].includes(path) || tool !== null)

function Root() {
  if (view === 'tracecard') return <TraceTestCard />
  if (path === '/studio') return <App />
  if (tool)
    return (
      <Suspense fallback={<LoadingDomino />}>
        <ToolPage tool={tool} />
      </Suspense>
    )
  if (path === '/account') return <HomeApp initialPage="account" />
  if (path === '/bits')
    return (
      <Suspense fallback={<LoadingDomino />}>
        <BitLibraryPage />
      </Suspense>
    )
  return <LandingPage />
}

installPinchZoomGuard()
installCaliperInput()
installNumpad()
// Everything but the landing page (and the printed Trace card) follows the light/dark setting.
// index.html makes the same call before the first paint; keep the routes in step.
if (appPage) installTheme()

// The app pages open browser storage (designs in IndexedDB, account sync) before the first
// render; the landing page and the printed card do not need it.
const needsStorage = appPage

async function start() {
  if (needsStorage) {
    try {
      await initStorage()
    } catch (err) {
      console.error('Browser storage could not be opened', err)
    }
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  )
}

void start()
