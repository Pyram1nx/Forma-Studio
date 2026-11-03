// Build public/models/systainer/sys-tloc.bin from the Festool T-Loc reference STLs
// (printables.com/model/237425, CC BY-NC-SA 4.0; see public/models/systainer/LICENSE.md).
//
//   node scripts/build-systainer-model.mjs <stl-dir> <out.bin>
//
// <stl-dir> holds the printables download, extracted: "SYSn t-loc - SysN_Base-1.STL" for each
// size plus the shared "SYS t-loc - Top-1/Latch-1/Latch_Cover-1/Handle-1/Hinge-Pin.STL".
//
// The mesh ships at full resolution — decimation is what turned the flat moulded faces into a
// mosaic of tilted triangles in the previous build, and no shading fixes that. Every real base
// ships (SYS1–SYS5); the viewer no longer stretches SYS1's walls. The Reinforcement_Bar STL is
// skipped: it sits inside the front wall channel and never shows. The lid's Festool and Tanos
// lettering is pressed flat here (the viewer letters it FORMA instead).
//
// Each part is welded and quantised to int16 in the viewer's frame: mm, x across the width, y
// toward the back (hinges), z up from the bottom of the feet, centred on the outer footprint.
// The STLs are exported in their assembly's frame (y up, z front, each part at its stack
// height), so every part is placed with the SYS1 base's bounds and the taller bases with their
// own.
//
// File: "SYSM" u32 partCount, then per part: u8 nameLen, name (ascii), u32 vertexCount,
// u32 indexCount, f32 scale, int16[3 * vertexCount] (value * scale = mm), u32[indexCount].
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

const [dir, outPath] = process.argv.slice(2)
if (!outPath) {
  console.error('usage: node scripts/build-systainer-model.mjs <stl-dir> <out.bin>')
  process.exit(1)
}

const FILES = {
  base1: 'SYS1 t-loc - Sys1_Base-1.STL',
  base2: 'SYS2 t-loc - Sys2_Base-1.STL',
  base3: 'SYS3 t-loc - Sys3_Base-1.STL',
  base4: 'SYS4 t-loc - Sys4_Base-1.STL',
  base5: 'SYS5 t-loc - Sys5_Base-1.STL',
  lid: 'SYS t-loc - Top-1.STL',
  latch: 'SYS t-loc - Latch-1.STL',
  latchCover: 'SYS t-loc - Latch_Cover-1.STL',
  handle: 'SYS t-loc - Handle-1.STL',
  hingePin: 'SYS t-loc - Hinge-Pin.STL',
}

function readStl(p) {
  const b = fs.readFileSync(p)
  const n = b.readUInt32LE(80)
  if (84 + n * 50 !== b.length) throw new Error(`${p}: not a binary STL`)
  const pos = new Float32Array(n * 9)
  for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) pos[i * 9 + k] = b.readFloatLE(84 + i * 50 + 12 + k * 4)
  return pos
}

function bounds(pos) {
  const mn = [Infinity, Infinity, Infinity]
  const mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
    mn[k] = Math.min(mn[k], pos[i + k])
    mx[k] = Math.max(mx[k], pos[i + k])
  }
  return { mn, mx }
}

const raw = Object.fromEntries(Object.entries(FILES).map(([name, file]) => {
  const p = path.join(dir, file)
  if (!fs.existsSync(p)) {
    console.error(`missing ${p} — extract the printables download into <stl-dir> first`)
    process.exit(1)
  }
  return [name, readStl(p)]
}))

// Frame from the SYS1 base's outer bounds: x centred on the width, y on the depth, feet at zero.
// The taller bases were exported at another stack height, so they take their own depth centre.
const b1 = bounds(raw.base1)
const cx = (b1.mn[0] + b1.mx[0]) / 2
const cz = (b1.mn[2] + b1.mx[2]) / 2
const feet = b1.mn[1]
const own = (name) => {
  const b = bounds(raw[name])
  return { zc: (b.mn[2] + b.mx[2]) / 2, y0: b.mn[1] }
}

/** STL (x, y up, z front) to viewer (x, y back, z up). A proper rotation, so windings survive. */
function toViewer(pos, zc = cz, y0 = feet) {
  const out = new Float32Array(pos.length)
  for (let i = 0; i < pos.length; i += 3) {
    out[i] = pos[i] - cx
    out[i + 1] = -(pos[i + 2] - zc)
    out[i + 2] = pos[i + 1] - y0
  }
  return out
}

/**
 * Press the lid's raised lettering back into its panels (measured on the reference lid, relative
 * to its own bounds): FESTOOL on the top label (1 mm proud of the 60.8 panel, and the matching
 * 1 mm dent inside the shell), FESTOOL on the front left panel (0.8 mm proud of 144.2) and the
 * Tanos mark on the front right (0.5 mm proud).
 */
function flattenLettering(pos) {
  let y0 = Infinity
  for (let i = 1; i < pos.length; i += 3) y0 = Math.min(y0, pos[i])
  const near = (v, t) => Math.abs(v - t) < 0.05
  let moved = 0
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i] - cx
    const y = pos[i + 1] - y0
    const z = pos[i + 2] - cz
    let ny = y
    let nz = z
    if (x > -82 && x < 76 && z > 40 && z < 70) {
      if (near(y, 61.8)) ny = 60.8
      else if (near(y, 59)) ny = 58
    } else if (x > -170 && x < -86 && y > 38 && y < 53 && z > 144.3 && z < 145.1) nz = 144.2
    else if (x > 90 && x < 180 && y > 32 && y < 59 && z > 144.3 && z < 145.1) nz = 144.2
    if (ny !== y || nz !== z) moved++
    pos[i + 1] = ny + y0
    pos[i + 2] = nz + cz
  }
  console.log(`lid lettering: ${moved} vertices pressed flat`)
  return pos
}

function part(name, pos, zc, y0) {
  let geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(toViewer(pos, zc, y0), 3))
  geo = mergeVertices(geo, 1e-3)
  if (!geo.index) geo = mergeVertices(geo, 1e-3)
  const p = geo.attributes.position.array
  let ext = 0
  for (const v of p) ext = Math.max(ext, Math.abs(v))
  const scale = ext / 32000
  const q = new Int16Array(p.length)
  for (let i = 0; i < p.length; i++) q[i] = Math.round(p[i] / scale)
  const idx = Uint32Array.from(geo.index.array)
  console.log(`${name}: ${p.length / 3} vertices, ${idx.length / 3} triangles`)
  return { name, q, idx, scale }
}

const parts = Object.entries(FILES).map(([name]) => {
  // The taller bases sit at their own stack height in the CAD assembly: use their own bounds.
  const o = name.startsWith('base') && name !== 'base1' ? own(name) : {}
  if (name === 'lid') return part(name, flattenLettering(raw[name]), cz, feet)
  return part(name, raw[name], o.zc, o.y0)
})

const chunks = [Buffer.from('SYSM'), u32(parts.length)]
function u32(v) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v)
  return b
}
for (const p of parts) {
  const f = Buffer.alloc(4)
  f.writeFloatLE(p.scale)
  chunks.push(Buffer.from([p.name.length]), Buffer.from(p.name, 'ascii'), u32(p.q.length / 3), u32(p.idx.length), f)
  chunks.push(Buffer.from(p.q.buffer, p.q.byteOffset, p.q.byteLength))
  // Keep the index block 4-byte aligned for the browser's typed-array view.
  const used = chunks.reduce((s, c) => s + c.length, 0)
  if (used % 4) chunks.push(Buffer.alloc(4 - (used % 4)))
  chunks.push(Buffer.from(p.idx.buffer, p.idx.byteOffset, p.idx.byteLength))
}
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, Buffer.concat(chunks))
console.log(`wrote ${outPath} (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`)
