// Small procedural-modelling kit for the Systainer catalogue: every item is built from these
// primitives in mm, z up. Geometry is cached by the catalogue, so building is cheap enough to do
// lazily the first time an item is shown.
import * as THREE from 'three'
import type { Contour, Pt } from '../../model/types'
import { boolean, offsetContours, splitRegions } from '../../geometry/offset'

export type MatName = 'steel' | 'carbide' | 'black' | 'knob' | 'white' | 'brass' | 'tape' | 'core' | 'paper' | 'rollcore' | 'domino' | 'screen' | 'yellow' | 'wood' | 'graphite' | 'grey' | 'red' | 'gloss' | 'anodized' | 'edgeblack' | 'hidden' | 'custom' | 'ghost'

const MAT_DEFS: Record<MatName, THREE.MeshStandardMaterialParameters | THREE.MeshPhysicalMaterialParameters> = {
  steel: { color: 0xc9ccd2, metalness: 0.9, roughness: 0.3 },
  carbide: { color: 0x8f949c, metalness: 0.8, roughness: 0.36 },
  black: { color: 0x2e3036, metalness: 0.45, roughness: 0.42 },
  knob: { color: 0x1d1e21, metalness: 0.05, roughness: 0.72 },
  white: { color: 0xf0efea, metalness: 0, roughness: 0.55 },
  brass: { color: 0xc8a15a, metalness: 0.9, roughness: 0.35 },
  tape: { color: 0x1b1c1f, metalness: 0.1, roughness: 0.45 },
  core: { color: 0xa98058, metalness: 0, roughness: 0.92 },
  paper: { color: 0xf5f4ef, metalness: 0, roughness: 0.5 },
  rollcore: { color: 0xe3e2dc, metalness: 0, roughness: 0.6 },
  domino: { color: 0x131315, metalness: 0, roughness: 0.55 },
  screen: { color: 0x0b0c0e, metalness: 0.3, roughness: 0.12 },
  yellow: { color: 0xf0bf2c, metalness: 0.05, roughness: 0.5 },
  wood: { color: 0xe2b56b, metalness: 0, roughness: 0.7 },
  graphite: { color: 0x3a3b3f, metalness: 0.4, roughness: 0.5 },
  grey: { color: 0x6c7079, metalness: 0.2, roughness: 0.55 },
  red: { color: 0xc8352e, metalness: 0.05, roughness: 0.5 },
  anodized: { color: 0x25262a, metalness: 0.55, roughness: 0.55 },
  edgeblack: { color: 0x1a1512, metalness: 0.15, roughness: 0.55 },
  hidden: { visible: false },
  gloss: { color: 0x151618, metalness: 0.1, roughness: 0.3 },
  custom: { color: 0xa9b0bd, metalness: 0, roughness: 0.7 },
  ghost: { color: 0x2c65ff, metalness: 0, roughness: 1, transparent: true, opacity: 0.18, depthWrite: false },
}

const mats = new Map<MatName, THREE.MeshStandardMaterial>()
export function mat(name: MatName): THREE.MeshStandardMaterial {
  let m = mats.get(name)
  if (!m) {
    m = new THREE.MeshStandardMaterial(MAT_DEFS[name])
    mats.set(name, m)
  }
  return m
}

/** A mesh placed at (x, y, z), optionally rotated (degrees, XYZ). */
export function M(geo: THREE.BufferGeometry, m: MatName, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat(m))
  mesh.position.set(x, y, z)
  mesh.rotation.set((rx * Math.PI) / 180, (ry * Math.PI) / 180, (rz * Math.PI) / 180)
  return mesh
}

export function G(...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group()
  for (const c of children) g.add(c)
  return g
}

/** Cylinder (or cone frustum) along z from 0 to h; r0 at the bottom, r1 at the top. */
export function cyl(r0: number, r1: number, h: number, seg = 40): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, h, seg)
  g.rotateX(Math.PI / 2)
  g.translate(0, 0, h / 2)
  return g
}

/** Same geometry with hard edges (one normal per face): hex nuts, knurls. */
export function faceted(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g
  n.computeVertexNormals()
  return n
}

/** A shape drawn in the x–z plane (x across, y up in the shape = z), extruded `t` thick centred on y. */
export function extrudeXZ(shape: THREE.Shape, t: number, bevel = 0.6): THREE.BufferGeometry {
  const g = extrude(shape, t, bevel)
  g.rotateX(Math.PI / 2)
  g.translate(0, t / 2, 0)
  return g
}

/** Box centred on x and y, z from 0 to h. */
export function box(w: number, d: number, h: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, d, h)
  g.translate(0, 0, h / 2)
  return g
}

/** Solid of revolution about z from (r, z) pairs, bottom to top. */
export function lathe(profile: [number, number][], seg = 48): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(
    profile.map(([r, z]) => new THREE.Vector2(Math.max(0, r), z)),
    seg,
  )
  g.rotateX(Math.PI / 2)
  return g
}

/** A flat shape extruded along z from 0 to h, with a small bevel (inside the outline) for nicer edges. */
export function extrude(shape: THREE.Shape, h: number, bevel = 0.6, curveSegments = 24): THREE.BufferGeometry {
  const b = Math.min(bevel, h / 4)
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: h - 2 * b,
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    // Bevel inward, so the outline stays the true size.
    bevelOffset: -b,
    bevelSegments: 2,
    curveSegments,
  })
  g.translate(0, 0, b)
  return g
}

/** Rounded rectangle centred on the origin. */
export function roundRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape()
  const x = -w / 2
  const y = -h / 2
  r = Math.min(r, w / 2, h / 2)
  s.moveTo(x + r, y)
  s.lineTo(x + w - r, y)
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false)
  s.lineTo(x + w, y + h - r)
  s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false)
  s.lineTo(x + r, y + h)
  s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false)
  s.lineTo(x, y + r)
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false)
  return s
}

/** A closed path (for holes) from points, counter-clockwise or not. */
export function pathOf(pts: [number, number][]): THREE.Path {
  const p = new THREE.Path()
  pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)))
  p.closePath()
  return p
}

export function circlePath(cx: number, cy: number, r: number): THREE.Path {
  const p = new THREE.Path()
  p.absarc(cx, cy, r, 0, Math.PI * 2, false)
  return p
}

/** Stadium (slot) of length `len` between end centres along x, width 2r, centred on the origin. */
export function stadium(len: number, r: number): THREE.Shape {
  const s = new THREE.Shape()
  s.moveTo(-len / 2, -r)
  s.lineTo(len / 2, -r)
  s.absarc(len / 2, 0, r, -Math.PI / 2, Math.PI / 2, false)
  s.lineTo(-len / 2, r)
  s.absarc(-len / 2, 0, r, Math.PI / 2, Math.PI * 1.5, false)
  return s
}

/** Knurled knob: a cylinder whose rim is ribbed, along z from 0 to h. */
export function knurled(r: number, h: number, ribs = 18): THREE.BufferGeometry {
  const s = new THREE.Shape()
  const n = ribs * 4
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2
    const rr = r * (1 - 0.06 * (0.5 + 0.5 * Math.cos(a * ribs)))
    const x = Math.cos(a) * rr
    const y = Math.sin(a) * rr
    if (i === 0) s.moveTo(x, y)
    else s.lineTo(x, y)
  }
  return extrude(s, h, Math.min(1.2, h / 5), 4)
}

/**
 * A fluted cutter along z from 0 to `len`: `radius(z)` gives the envelope, and `flutes` helical
 * grooves wind round it (`twist` turns per mm). The top is capped.
 */
export function fluted(radius: (z: number) => number, len: number, flutes: number, twist: number): THREE.BufferGeometry {
  const S = 36
  const N = Math.max(8, Math.min(60, Math.ceil(len / 0.8)))
  const pos: number[] = []
  const idx: number[] = []
  const groove = (u: number) => {
    const f = u - Math.floor(u)
    return f > 0.55 && f < 0.95 ? Math.sin((Math.PI * (f - 0.55)) / 0.4) : 0
  }
  for (let j = 0; j <= N; j++) {
    const z = (len * j) / N
    const R = radius(z)
    for (let i = 0; i < S; i++) {
      const a = (i / S) * Math.PI * 2
      const r = R * (1 - 0.2 * groove((a * flutes) / (Math.PI * 2) + z * twist))
      pos.push(Math.cos(a) * r, Math.sin(a) * r, z)
    }
  }
  for (let j = 0; j < N; j++)
    for (let i = 0; i < S; i++) {
      const a = j * S + i
      const b = j * S + ((i + 1) % S)
      const c = a + S
      const d = b + S
      idx.push(a, b, d, a, d, c)
    }
  // Caps: bottom (facing down) and top (facing up), fanned from a centre vertex.
  const bot = pos.length / 3
  pos.push(0, 0, 0)
  const top = bot + 1
  pos.push(0, 0, len)
  for (let i = 0; i < S; i++) {
    const n = (i + 1) % S
    idx.push(bot, n, i)
    idx.push(top, N * S + i, N * S + n)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** Closed outlines (outer contours and their holes, any winding) as THREE shapes. */
export function shapesOf(contours: Contour[]): THREE.Shape[] {
  return splitRegions(contours).map((region) => {
    const s = new THREE.Shape(region[0].pts.map((p) => new THREE.Vector2(p.x, p.y)))
    for (const h of region.slice(1)) s.holes.push(new THREE.Path(h.pts.map((p) => new THREE.Vector2(p.x, p.y))))
    return s
  })
}

/**
 * A traced pocket outline as the tool's own outline: shrunk by `inset` (the clearance the insert's
 * designer left round it), and optionally kept to one side of a vertical line.
 */
export function profile(pts: Pt[], inset = 0.5, clip?: { minX?: number; maxX?: number }): Contour[] {
  let cs = offsetContours([{ closed: true, pts }], -inset)
  if (clip) {
    const x0 = clip.minX ?? -1e4
    const x1 = clip.maxX ?? 1e4
    const box: Contour = { closed: true, pts: [{ x: x0, y: -1e4 }, { x: x1, y: -1e4 }, { x: x1, y: 1e4 }, { x: x0, y: 1e4 }] }
    cs = boolean('intersection', cs, [box])
  }
  return cs
}

/** Outlines extruded along z from 0 to h. */
export function extrudeOutline(contours: Contour[], h: number, bevel = 0.6): THREE.BufferGeometry {
  const b = Math.min(bevel, h / 4)
  const g = new THREE.ExtrudeGeometry(shapesOf(contours), {
    depth: h - 2 * b,
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: -b,
    bevelSegments: 2,
    curveSegments: 4,
  })
  g.translate(0, 0, b)
  return g
}

/** Bounds of contours. */
export function boundsOf(cs: Contour[]): { x0: number; x1: number; y0: number; y1: number; cx: number; cy: number; w: number; h: number } {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const c of cs)
    for (const p of c.pts) {
      x0 = Math.min(x0, p.x)
      x1 = Math.max(x1, p.x)
      y0 = Math.min(y0, p.y)
      y1 = Math.max(y1, p.y)
    }
  return { x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 }
}

/** A lobed (star) clamping knob along z from 0 to h. */
export function starKnob(r: number, h: number, lobes = 5): THREE.BufferGeometry {
  const s = new THREE.Shape()
  const n = 120
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2
    const rr = r * (0.8 + 0.2 * Math.cos(a * lobes))
    const x = Math.cos(a) * rr
    const y = Math.sin(a) * rr
    if (i === 0) s.moveTo(x, y)
    else s.lineTo(x, y)
  }
  return extrude(s, h, Math.min(2.5, h / 5), 4)
}
