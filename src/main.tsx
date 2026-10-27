import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// First so the store and file code below read migrated storage keys.
import './state/legacyStorage'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans/700.css'
import '@fontsource/ibm-plex-sans-condensed/500.css'
import './styles/tokens.css'
import './styles/components.css'
import './index.css'
import App from './App'
import HomeApp from './home/HomeApp'
import LandingPage from './landing/LandingPage'
import TraceTestCard from './features/paper/TraceTestCard'

// Routes: / is the public home page, /account the account and saved designs, /studio the
// editor. ?view=tracecard shows a Trace test card to scan. Unknown paths go to the home page.
const path = window.location.pathname.replace(/\/+$/, '') || '/'
const view = new URLSearchParams(window.location.search).get('view')

function Root() {
  if (view === 'tracecard') return <TraceTestCard />
  if (path === '/studio') return <App />
  if (path === '/account') return <HomeApp initialPage="account" />
  return <LandingPage />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
