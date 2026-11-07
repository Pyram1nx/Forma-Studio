// Find Art icon search: Forma's own index of open-licensed icon sets, served by the API
// (server/icons.js, GET /api/icons/*). No sign-in needed. Only works in builds with VITE_API_URL
// set (see src/account/api.ts).
import { API_URL, accountsEnabled } from '../account/api'
import { importSVGText } from './svgImport'
import type { ShapesImport } from '../model/types'

export interface IconHit {
  /** "prefix:name", e.g. "mdi:dog". */
  id: string
  /** Readable icon name, e.g. "dog side". */
  name: string
  /** Icon set it comes from, e.g. "Material Design Icons". */
  set: string
  /** SPDX licence of that set, e.g. "Apache-2.0". */
  license: string
}

export interface IconPage {
  icons: IconHit[]
  /** Matches for the query in all; more pages while icons.length + offset < total. */
  total: number
}

export const ICON_PAGE = 36

export const iconsEnabled = accountsEnabled

/** Thumbnail URL for an icon. Served as image/svg+xml, so it can go straight into <img src>. */
export const iconUrl = (id: string) => `${API_URL}/icons/svg?id=${encodeURIComponent(id)}`

export async function searchIcons(q: string, offset = 0, signal?: AbortSignal): Promise<IconPage> {
  const params = new URLSearchParams({ q, limit: String(ICON_PAGE), offset: String(offset) })
  const res = await fetch(`${API_URL}/icons/search?${params}`, { signal })
  if (!res.ok) throw new Error('Icon search is unavailable right now.')
  return (await res.json()) as IconPage
}

/** Hover text for a result: what it is, where it comes from, and its licence. */
export const iconTitle = (h: IconHit) => `${h.name} · ${h.set} (${h.license})`

/** Fetches an icon and parses it into the same payload File Import produces. */
export async function iconPayload(id: string): Promise<ShapesImport> {
  const res = await fetch(iconUrl(id))
  if (!res.ok) throw new Error('Could not load that icon.')
  return importSVGText(await res.text(), id.split(':')[1] ?? 'icon')
}
