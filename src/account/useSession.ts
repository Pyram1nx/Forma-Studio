import { useEffect, useState } from 'react'
import { useSync } from '../storage/sync'
import { getSession, type Session } from './api'

/**
 * The selected account, re-read when it changes: signing in again, or sync finding the
 * session expired.
 */
export function useSession(): Session | null {
  const [, force] = useState(0)
  const status = useSync((s) => s.status)
  useEffect(() => {
    const f = () => force((n) => n + 1)
    window.addEventListener('formastudio:session-renewed', f)
    return () => window.removeEventListener('formastudio:session-renewed', f)
  }, [])
  // Re-read on every sync status change (a rejected token flips the session to needsSignIn).
  void status
  return getSession()
}

