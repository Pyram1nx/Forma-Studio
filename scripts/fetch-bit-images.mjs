#!/usr/bin/env node
// Refreshes the bit gallery's product photos in public/bit-images/<id>.webp from the IMAGES map
// in src/features/carve3d/bits.ts (Shaper's image CDN, already resized to 840 × 720 WebP).
// The files are committed so the gallery works offline and on every deploy; the app falls back
// to the CDN URL, then to the drawn side profile, when a file is missing.
//
// Usage: node scripts/fetch-bit-images.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Read the map straight from bits.ts so the two never drift apart.
const src = await readFile(fileURLToPath(new URL('../src/features/carve3d/bits.ts', import.meta.url)), 'utf8')
const base = src.match(/const photo = \(path: string\) => `([^`]+)`/)?.[1]
const block = src.match(/export const IMAGES[^{]+\{([\s\S]*?)\n\}/)?.[1]
if (!base || !block) throw new Error('Could not find photo() or IMAGES in bits.ts')
const IMAGES = Object.fromEntries(
  [...block.matchAll(/'([^']+)':\s*photo\('([^']+)'\)/g)].map(([, id, path]) => [id, base.replace('${path}', path)]),
)

const outDir = fileURLToPath(new URL('../public/bit-images/', import.meta.url))
await mkdir(outDir, { recursive: true })

let ok = 0
for (const [id, url] of Object.entries(IMAGES)) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FormaStudio-bit-gallery)' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const type = res.headers.get('content-type') ?? ''
    if (type !== 'image/webp') throw new Error(`unexpected content-type ${type || 'none'}`)
    await writeFile(join(outDir, `${id}.webp`), Buffer.from(await res.arrayBuffer()))
    ok++
    console.log(`ok   ${id}.webp`)
  } catch (e) {
    console.warn(`FAIL ${id}: ${e.message} (${url})`)
  }
}
console.log(`\n${ok}/${Object.keys(IMAGES).length} photos in public/bit-images/`)
