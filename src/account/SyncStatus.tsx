import { useEffect, useState } from 'react'
import { useSync } from '../storage/sync'

function ago(iso: string | null): string {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

const changes = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`

/** One line saying whether this device and the account are in step. Empty without an account. */
export default function SyncStatus({ className = '' }: { className?: string }) {
  const { status, pending, lastSyncedAt, error } = useSync()
  // Re-render now and then so "2 min ago" stays true.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  if (status === 'off') return null
  const text =
    status === 'syncing'
      ? 'Syncing…'
      : status === 'offline'
        ? pending
          ? `Offline. ${changes(pending)} will sync when you are back online.`
          : 'Offline. Changes will sync when you are back online.'
        : status === 'signin'
          ? pending
            ? `Sign in again to sync ${changes(pending)}.`
            : 'Sign in again to keep syncing.'
          : status === 'error'
            ? (error ?? 'Sync failed. It will try again shortly.')
            : pending
              ? `${changes(pending)} waiting to sync.`
              : `Synced ${ago(lastSyncedAt)}`.trim()
  return (
    <span className={`sync-status sync-status--${status} ${className}`} role="status">
      <span className="sync-status__dot" aria-hidden="true" />
      {text}
    </span>
  )
}
