import { useEffect, useState, type FormEvent } from 'react'
import { accountsEnabled, deleteAccount, selectSession, signIn, signUp, type Session } from './api'
import {
  copyLocalDesigns,
  countLocalDesignsToCopy,
  enterAccount,
  keepAccountDesignsOnDevice,
  leaveAccount,
  syncNow,
  useSync,
} from '../storage/sync'
import SyncStatus from './SyncStatus'
import { subscribeDesigns } from '../storage/designStore'
import { useSession } from './useSession'

/** "Member since" text for an account, or null when the server did not send a date. */
const memberSince = (s: Session) => (s.createdAt ? new Date(s.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : null)

const designsWord = (n: number) => `${n} ${n === 1 ? 'design' : 'designs'}`

/**
 * Sign in, create an account, or show the signed-in account. Shared by the studio's account
 * dialog and the home window's account page. Signing in or out switches the page to that
 * account's designs (or back to this device's designs) by reloading it.
 */
export default function AccountPanel() {
  const session = useSession()
  if (!accountsEnabled()) {
    return (
      <div className="account-panel">
        <p>Accounts are not set up in this build.</p>
        <p className="ss-muted">Your designs, presets and bit kit are saved in this browser on this device.</p>
      </div>
    )
  }
  if (!session) return <SignInForm />
  if (session.needsSignIn) return <SignInForm again={session} />
  return <SignedIn session={session} />
}

function SignInForm({ again }: { again?: Session }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState(again?.email ?? '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const s = mode === 'signup' && !again ? await signUp(email, password) : await signIn(email, password)
      setPassword('')
      if (again && s.id === again.id) {
        // Same account: same storage space, so no reload. Pick up syncing where it stopped.
        selectSession(s)
        void syncNow()
        window.dispatchEvent(new Event('formastudio:session-renewed'))
        setBusy(false)
        return
      }
      await enterAccount(s)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <form className="account-panel" onSubmit={submit}>
      {again ? (
        <>
          <p>
            Your session for <strong>{again.email}</strong> has ended. Sign in again to keep syncing.
          </p>
          <p className="ss-muted">Your designs are still here on this device, and you can keep working on them.</p>
        </>
      ) : (
        <>
          <p className="ss-muted">
            Without an account, everything is saved in this browser on this device. With an account, your designs, presets and bit kit sync across your
            devices. Designs made without an account stay on this device and come back when you sign out.
          </p>
          <div className="account-panel__tabs" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'signin'} className={'ss-btn' + (mode === 'signin' ? ' ss-btn--primary' : '')} onClick={() => setMode('signin')}>
              Sign in
            </button>
            <button type="button" role="tab" aria-selected={mode === 'signup'} className={'ss-btn' + (mode === 'signup' ? ' ss-btn--primary' : '')} onClick={() => setMode('signup')}>
              Create account
            </button>
          </div>
        </>
      )}
      <label className="ss-field">
        <span className="ss-label">email</span>
        <span className="ss-input">
          <input type="email" autoComplete="email" required readOnly={!!again} value={email} onChange={(e) => setEmail(e.target.value)} />
        </span>
      </label>
      <label className="ss-field">
        <span className="ss-label">password</span>
        <span className="ss-input">
          <input
            type="password"
            autoComplete={mode === 'signup' && !again ? 'new-password' : 'current-password'}
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </span>
      </label>
      {mode === 'signup' && !again && <p className="ss-muted">At least 8 characters.</p>}
      {error && <p className="account-panel__error">{error}</p>}
      <button className="ss-btn ss-btn--primary" type="submit" disabled={busy}>
        {busy ? 'Please wait…' : mode === 'signup' && !again ? 'Create account' : 'Sign in'}
      </button>
      {again && (
        <button type="button" className="ss-btn" disabled={busy} onClick={() => void leaveAccount({ keepUnsynced: true })}>
          Use this device without an account
        </button>
      )}
    </form>
  )
}

function SignedIn({ session }: { session: Session }) {
  const since = memberSince(session)
  const syncing = useSync((s) => s.status === 'syncing')
  const [toCopy, setToCopy] = useState(0)
  const [copied, setCopied] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    // Recount as designs arrive from the account (the first sync on a device pulls them in).
    const recount = () => void countLocalDesignsToCopy().then(setToCopy)
    recount()
    return subscribeDesigns(recount)
  }, [copied])

  const signOut = async () => {
    setBusy(true)
    await syncNow()
    const { pending } = useSync.getState()
    if (pending > 0) {
      const ok = window.confirm(
        `${pending === 1 ? '1 change has' : `${pending} changes have`} not reached your account yet. Sign out anyway?\n\n` +
          'They stay on this device and sync the next time you sign in to this account.',
      )
      if (!ok) {
        setBusy(false)
        return
      }
      await leaveAccount({ keepUnsynced: true })
      return
    }
    await leaveAccount({ keepUnsynced: false })
  }

  const copy = async () => {
    setBusy(true)
    setCopied(await copyLocalDesigns())
    setBusy(false)
  }

  return (
    <div className="account-panel">
      <p>
        Signed in as <strong>{session.email}</strong>.
      </p>
      {since && <p className="ss-muted">Member since {since}.</p>}
      <p className="account-panel__sync">
        <SyncStatus />
        <button className="ss-btn ss-btn--sm" onClick={() => void syncNow()} disabled={syncing}>
          Sync now
        </button>
      </p>
      <p className="ss-muted">
        Your designs, presets and bit kit are saved on this device and in your account. Designs you made without an account are kept apart on this device and
        show again when you sign out.
      </p>
      {toCopy > 0 && (
        <div className="account-panel__notice">
          <p>
            {designsWord(toCopy)} on this device {toCopy === 1 ? 'was' : 'were'} made without an account.
          </p>
          <button className="ss-btn" onClick={copy} disabled={busy}>
            Copy {toCopy === 1 ? 'it' : 'them'} to this account
          </button>
        </div>
      )}
      {copied !== null && copied > 0 && <p className="ss-muted">Copied {designsWord(copied)}. The originals stay on this device.</p>}
      <button className="ss-btn" onClick={signOut} disabled={busy}>
        {busy ? 'Please wait…' : 'Sign out'}
      </button>
      {deleting ? <DeleteAccount onCancel={() => setDeleting(false)} /> : (
        <button className="account-panel__link" onClick={() => setDeleting(true)}>
          Delete account…
        </button>
      )}
    </div>
  )
}

function DeleteAccount({ onCancel }: { onCancel: () => void }) {
  const [password, setPassword] = useState('')
  const [keep, setKeep] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await syncNow()
      if (keep) await keepAccountDesignsOnDevice()
      await deleteAccount(password)
      await leaveAccount({ keepUnsynced: false })
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <form className="account-panel__notice account-panel__notice--danger" onSubmit={submit}>
      <p>
        <strong>Delete your account?</strong> This removes the account and everything saved in it, on every device. It cannot be undone.
      </p>
      <label className="account-panel__check">
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep a copy of my designs on this device
      </label>
      <label className="ss-field">
        <span className="ss-label">password</span>
        <span className="ss-input">
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </span>
      </label>
      {error && <p className="account-panel__error">{error}</p>}
      <div className="account-panel__row">
        <button type="button" className="ss-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="ss-btn ss-btn--danger" disabled={busy}>
          {busy ? 'Deleting…' : 'Delete account'}
        </button>
      </div>
    </form>
  )
}
