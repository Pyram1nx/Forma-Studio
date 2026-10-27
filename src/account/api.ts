// Client for the Forma Studio accounts API (see server/index.mjs). Accounts are optional:
// the editor works fully without signing in.

/** Base URL of the accounts API, set at build time. Empty means accounts are off in this build. */
export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/+$/, '')

export const accountsEnabled = () => API_URL.length > 0

export interface Session {
  email: string
  token: string
  expiresAt: string
  /** When the account was created. Older sessions may not have it. */
  createdAt?: string
}

const KEY = 'formastudio:session'

export function getSession(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Session | null
    if (!s || Date.parse(s.expiresAt) <= Date.now()) {
      localStorage.removeItem(KEY)
      return null
    }
    return s
  } catch {
    return null
  }
}

export function signOut() {
  localStorage.removeItem(KEY)
}

async function post(path: string, body: unknown): Promise<Session> {
  if (!accountsEnabled()) throw new Error('Accounts are not set up in this build.')
  let res: Response
  try {
    res = await fetch(API_URL + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.')
  }
  const data = (await res.json().catch(() => ({}))) as Partial<Session> & { error?: string }
  if (!res.ok || !data.token || !data.email || !data.expiresAt) throw new Error(data.error || `Request failed (${res.status})`)
  const session: Session = { email: data.email, token: data.token, expiresAt: data.expiresAt, createdAt: data.createdAt }
  localStorage.setItem(KEY, JSON.stringify(session))
  return session
}

export const signUp = (email: string, password: string) => post('/auth/signup', { email, password })
export const signIn = (email: string, password: string) => post('/auth/login', { email, password })
