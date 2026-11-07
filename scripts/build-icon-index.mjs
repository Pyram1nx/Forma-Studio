#!/usr/bin/env node
// Builds Forma's own Find Art icon index from open-licensed icon sets.
//
//   node scripts/build-icon-index.mjs
//
// Reads the @iconify-json/* dev dependencies (the upstream sets, normalised to one JSON shape),
// keeps the icons that import cleanly as shapes, and writes:
//
//   server/icons/catalog.json       set credits + icon names + search keywords (loaded by search)
//   server/icons/sets/<prefix>.json  icon bodies for one set (loaded on demand by /icons/svg)
//
// Both are committed, so the API needs no network, no API key and no build step. Re-run after
// bumping an @iconify-json package or editing SETS below.
//
// Only permissive licences that need no per-use attribution in the user's work (MIT, Apache-2.0,
// ISC, BSD, CC0, OFL). CC BY sets (Font Awesome 6, Game Icons, ...) are left out on purpose.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'server/icons')
const LICENSES = new Set(['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'CC0-1.0', 'OFL-1.1', 'Unlicense'])

const endsWith = (...s) => (n) => s.some((x) => n.endsWith(x))
const not = (f) => (n) => !f(n)
/** Matches names with any of these hyphen-separated words (e.g. "home-outline-rounded"). */
const hasWord = (...w) => {
  const re = new RegExp(`(^|-)(${w.join('|')})(-|$)`)
  return (n) => re.test(n)
}

// Order is search rank: on equal scores, earlier sets come first. `keep` drops style variants
// so one icon does not show up five times; `size` keeps one size per icon (largest preferred
// listed first); `dupeSuffix` drops "x-24px" when "x" exists; `strip` removes style words
// from the searchable name.
const SETS = [
  { prefix: 'mdi', strip: ['outline'] },
  { prefix: 'material-symbols', keep: not(hasWord('rounded', 'sharp', 'outline')) },
  { prefix: 'ph', keep: endsWith('-fill'), strip: ['fill'] },
  { prefix: 'fluent', keep: endsWith('-filled'), size: [24, 20, 28, 32, 16, 48, 12, 10], strip: ['filled'] },
  { prefix: 'bi', strip: ['fill'] },
  { prefix: 'ri', keep: not(endsWith('-line')), strip: ['fill'] },
  { prefix: 'mingcute', keep: endsWith('-fill'), strip: ['fill'] },
  { prefix: 'tabler', strip: ['filled'] }, // the stroke filter leaves only the filled icons
  { prefix: 'healthicons', keep: not(hasWord('outline', 'negative')), dupeSuffix: '-24px', strip: ['24px'] },
  { prefix: 'fluent-emoji-high-contrast' },
  { prefix: 'pinhead' },
  { prefix: 'carbon', strip: ['filled'] },
  { prefix: 'heroicons', keep: (n) => n.endsWith('-solid') && !/-(16|20)-solid$/.test(n), strip: ['solid'] },
  { prefix: 'temaki' },
  { prefix: 'maki', keep: not(endsWith('-11')) },
  { prefix: 'ant-design', keep: not(endsWith('-outlined', '-twotone')), strip: ['filled'] },
  { prefix: 'clarity', keep: (n) => !/-(line|badged|alerted)$/.test(n) && !hasWord('outline')(n), strip: ['solid'] },
  { prefix: 'octicon', size: [24, 16, 12] },
  { prefix: 'la', strip: ['solid'] },
  { prefix: 'fa', strip: ['o'] },
  { prefix: 'fontisto' },
  { prefix: 'uis' },
  { prefix: 'el' },
  { prefix: 'wi' },
  { prefix: 'map' },
  { prefix: 'medical-icon' },
  { prefix: 'pixelarticons' },
]

// Geometry the importer (src/io/svgImport.ts) cannot turn into shapes.
const STROKE_RE = /stroke-width|stroke="(?!none)/
// Also anything active: these SVGs are served from our own origin.
const UNSUPPORTED_RE = /<(mask|clipPath|pattern|image|text|filter|linearGradient|radialGradient|use|script|foreignObject|style|a)\b|\son[a-z]+=|javascript:|href=/i
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

const read = (prefix, file) => JSON.parse(readFileSync(join(root, 'node_modules/@iconify-json', prefix, file), 'utf8'))
const tokens = (s) => s.split('-').filter(Boolean)

/** Keeps one size per icon: "x-24-filled" over "x-20-filled", per the `size` preference list. */
function pickSizes(names, sizes) {
  const sizeRe = new RegExp(`-(${sizes.join('|')})(?=-|$)`)
  const best = new Map()
  for (const n of names) {
    const m = n.match(sizeRe)
    const base = m ? n.replace(sizeRe, '') : n
    // An unsized name (often a hidden legacy copy) only wins when no sized variant exists.
    const rank = m ? sizes.indexOf(Number(m[1])) : sizes.length
    const cur = best.get(base)
    if (!cur || rank < cur.rank) best.set(base, { n, rank })
  }
  return new Set([...best.values()].map((v) => v.n))
}

rmSync(join(outDir, 'sets'), { recursive: true, force: true })
mkdirSync(join(outDir, 'sets'), { recursive: true })

const catalog = { generated: 'scripts/build-icon-index.mjs', sets: [] }
const report = []
let total = 0

for (const cfg of SETS) {
  const data = read(cfg.prefix, 'icons.json')
  const info = read(cfg.prefix, 'info.json')
  const pkg = read(cfg.prefix, 'package.json')
  const spdx = info.license?.spdx
  if (!LICENSES.has(spdx)) throw new Error(`${cfg.prefix}: licence ${spdx} is not on the allow list`)
  if (info.palette) throw new Error(`${cfg.prefix}: multicolour set, cannot import as shapes`)

  const W = data.width ?? 16
  const H = data.height ?? 16
  let names = Object.keys(data.icons).filter((n) => NAME_RE.test(n) && n.length <= 80 && !data.icons[n].hidden)
  if (cfg.keep) names = names.filter(cfg.keep)
  if (cfg.dupeSuffix) {
    const all = new Set(names)
    names = names.filter((n) => !(n.endsWith(cfg.dupeSuffix) && all.has(n.slice(0, -cfg.dupeSuffix.length))))
  }
  if (cfg.size) {
    const keep = pickSizes(names, cfg.size)
    names = names.filter((n) => keep.has(n))
  }

  const bodies = {}
  const kept = []
  let dropped = 0
  for (const n of names) {
    const ic = data.icons[n]
    if (ic.hidden || ic.rotate || ic.hFlip || ic.vFlip || STROKE_RE.test(ic.body) || UNSUPPORTED_RE.test(ic.body)) {
      dropped++
      continue
    }
    const w = ic.width ?? W
    const h = ic.height ?? H
    const l = ic.left ?? 0
    const t = ic.top ?? 0
    bodies[n] = w === W && h === H && !l && !t ? ic.body : [ic.body, w, h, l, t]
    kept.push(n)
  }

  // Plain aliases (no flips/rotations) are other names for the same drawing: search keywords.
  const extra = new Map()
  const keptSet = new Set(kept)
  // Size numbers ("-24") are not words anyone searches for or wants in the hover text.
  const stripWords = [...(cfg.strip ?? []), ...(cfg.size ?? []).map(String)]
  const strip = new Set(stripWords)
  for (const [alias, a] of Object.entries(data.aliases ?? {})) {
    if (a.rotate || a.hFlip || a.vFlip) continue
    let parent = a.parent
    for (let i = 0; i < 5 && data.aliases?.[parent]; i++) parent = data.aliases[parent].parent
    if (!keptSet.has(parent)) continue
    const set = extra.get(parent) ?? new Set()
    for (const t of tokens(alias)) if (!strip.has(t)) set.add(t)
    extra.set(parent, set)
  }

  // Keywords: alias words the name does not already contain, space separated, per icon.
  const keys = {}
  for (const n of kept) {
    const own = new Set(tokens(n))
    const words = [...(extra.get(n) ?? [])].filter((w) => !own.has(w))
    if (words.length) keys[n] = words.join(' ')
  }

  writeFileSync(join(outDir, 'sets', `${cfg.prefix}.json`), JSON.stringify({ w: W, h: H, icons: bodies }))
  catalog.sets.push({
    prefix: cfg.prefix,
    name: info.name,
    version: pkg.version,
    author: info.author?.name ?? '',
    authorUrl: info.author?.url ?? '',
    license: spdx,
    licenseUrl: info.license?.url ?? '',
    strip: stripWords,
    names: kept,
    keys,
  })
  total += kept.length
  report.push(`${cfg.prefix.padEnd(28)} ${String(kept.length).padStart(6)} kept ${String(dropped).padStart(5)} dropped  ${spdx}`)
}

writeFileSync(join(outDir, 'catalog.json'), JSON.stringify(catalog))
console.log(report.join('\n'))
console.log(`\n${total} icons from ${catalog.sets.length} sets -> server/icons/`)
