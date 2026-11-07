// Client for the Forma Studio accounts API (server/app.js, served from /api on Vercel).
// Accounts are optional: the editor works fully without signing in, and every design and
// setting is kept in this browser either way (see src/storage/).

/** Base URL of the accounts API, set at build time. Empty means accounts are off in this build. */
export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/+$/, '')

export const accountsEnabled = () => API_URL.length > 0

export interface Session {
  /** Account id. Each account's designs and settings are stored apart on this device. */
  id: string
  email: string
  token: string
  expiresAt: string
  /** When the account was created. */
  createdAt?: string
  /**
   * The server no longer accepts the token (expired, or the server's secret changed).
   * The account stays selected on this device, so its designs stay visible and editable;
   * syncing waits until the person signs in again.
   */
  needsSignIn?: boolean
}

export const SESSION_KEY = 'formastudio:session'

/** The account selected on this device, or null for no account (designs stay on this device only). */
export function getSession(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Session | null
    // Sessions from before per-account storage have no id: treat them as signed out.
    if (!s || typeof s.id !== 'string' || !s.id || typeof s.email !== 'string') return null
    if (!s.needsSignIn && Date.parse(s.expiresAt) <= Date.now()) return { ...s, needsSignIn: true }
    return s
  } catch {
    return null
  }
}

function storeSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s))
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    /* storage blocked: the session lasts until the page closes */
  }
}

/** Forget the account on this device. Callers clear its local copy first (see storage/sync.ts). */
export function forgetSession() {
  storeSession(null)
}

/** Keep the account selected but mark it as needing a new sign-in. */
export function markNeedsSignIn() {
  const s = getSession()
  if (s && !s.needsSignIn) storeSession({ ...s, needsSignIn: true })
}

export class ApiError extends Error {
  status: number
  body: Record<string, unknown>
  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.body = body
  }
}

/** One API call. Throws ApiError (status 0 when the server could not be reached). */
export async function api<T = Record<string, unknown>>(method: string, path: string, opts: { body?: unknown; auth?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  if (!accountsEnabled()) throw new ApiError(0, 'Accounts are not set up in this build.')
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.auth) {
    const s = getSession()
    if (!s || s.needsSignIn) throw new ApiError(401, 'Please sign in again.')
    headers.authorization = 'Bearer ' + s.token
  }
  let res: Response
  try {
    res = await fetch(API_URL + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: opts.signal })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.')
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    if (res.status === 401 && opts.auth) markNeedsSignIn()
    throw new ApiError(res.status, typeof data.error === 'string' ? data.error : `Request failed (${res.status})`, data)
  }
  return data as T
}

type SessionReply = Partial<Session>

function toSession(d: SessionReply): Session {
  if (!d.id || !d.email || !d.token || !d.expiresAt) throw new ApiError(500, 'The server sent an unexpected reply.')
  return { id: d.id, email: d.email, token: d.token, expiresAt: d.expiresAt, createdAt: d.createdAt }
}

async function authenticate(path: string, email: string, password: string): Promise<Session> {
  return toSession(await api<SessionReply>('POST', path, { body: { email, password } }))
}

/** Check the credentials without selecting the account yet (the caller switches spaces). */
export const signUp = (email: string, password: string) => authenticate('/auth/signup', email, password)
export const signIn = (email: string, password: string) => authenticate('/auth/login', email, password)

/** Make this account the selected one on this device. */
export function selectSession(s: Session) {
  storeSession(s)
}

/** Confirm the session with the server and pick up a refreshed token. */
export async function refreshSession(): Promise<Session | null> {
  const s = getSession()
  if (!s || s.needsSignIn) return s
  const d = await api<SessionReply>('GET', '/auth/me', { auth: true })
  const next: Session = { ...s, email: d.email ?? s.email, createdAt: d.createdAt ?? s.createdAt, ...(d.token && d.expiresAt ? { token: d.token, expiresAt: d.expiresAt } : {}) }
  storeSession(next)
  return next
}

/** Delete the account and everything stored in it on the server. */
export const deleteAccount = (password: string) => api('DELETE', '/account', { body: { password }, auth: true })
