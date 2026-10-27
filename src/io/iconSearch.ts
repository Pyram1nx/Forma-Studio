// Find Art icon search, served by the accounts Lambda (server/index.mjs, GET /icons/*).
// No sign-in needed. Only works in builds with VITE_API_URL set (see src/account/api.ts).
import { API_URL, accountsEnabled } from '../account/api'
import { importSVGText } from './svgImport'
import type { ImportPayload } from '../model/types'

export interface IconHit {
  id: string
}

export const iconsEnabled = accountsEnabled

/** Thumbnail URL for an icon. Served as image/svg+xml, so it can go straight into <img src>. */
export const iconUrl = (id: string) => `${API_URL}/icons/svg?id=${encodeURIComponent(id)}`

export async function searchIcons(q: string, signal?: AbortSignal): Promise<IconHit[]> {
  const res = await fetch(`${API_URL}/icons/search?q=${encodeURIComponent(q)}&limit=36`, { signal })
  if (!res.ok) throw new Error('Icon search is unavailable right now.')
  const body = (await res.json()) as { icons: IconHit[] }
  return body.icons
}

/** Fetches an icon and parses it into the same payload File Import produces. */
export async function iconPayload(id: string): Promise<ImportPayload> {
  const res = await fetch(iconUrl(id))
  if (!res.ok) throw new Error('Could not load that icon.')
  return importSVGText(await res.text(), id.split(':')[1] ?? 'icon')
}
