// The egg-crate ("convoluted", pick-and-pluck lid) foam pad glued inside the Systainer lid: a
// flat-backed sheet whose exposed face is a regular field of rounded peaks and valleys,
// t = base + A·(1 + cos(kx·x)·cos(ky·y)), with the wavy profile showing on the cut sides.
//
// Frame of `lidFoamGeometry`: centred on x/y, the flat back on z = 0 and the egg-crate face toward
// −z, so mounted unrotated in the closed lid the back is glued to the ceiling and the peaks point
// down into the box. Closed and watertight (every edge shared by two faces), counter-clockwise
// seen from outside; each face has its own vertices so the creases stay sharp.
import * as THREE from 'three'

export interface LidFoamOptions {
  /** Solid layer under the valleys, mm. */
  base?: number
  /** Peak-to-valley height of the convolutions, mm. */
  amplitude?: number
  /** Target distance from a peak to the next along x or y, mm (fitted to whole half waves). */
  period?: number
  /** Grid cells per half wave (peak to valley). */
  cells?: number
  /** Speckle texture tile, mm. */
  tile?: number
}

export function lidFoamGeometry(w: number, d: number, opts: LidFoamOptions = {}): THREE.BufferGeometry {
  const base = opts.base ?? 8
  const amp = (opts.amplitude ?? 13) / 2
  const period = opts.period ?? 36
  const cells = opts.cells ?? 8
  const tile = opts.tile ?? 48
  // Whole half waves along each side, so every edge cuts the field on a crest/trough line and the
  // sides show the full wave.
  const hx = Math.max(1, Math.round((2 * w) / period))
  const hy = Math.max(1, Math.round((2 * d) / period))
  const nx = hx * cells
  const ny = hy * cells
  const kx = (hx * Math.PI) / w
  const ky = (hy * Math.PI) / d
  const X = (i: number) => -w / 2 + (w * i) / nx
  const Y = (j: number) => -d / 2 + (d * j) / ny
  const depth = (i: number, j: number) => base + amp * (1 + Math.cos(kx * (X(i) + w / 2)) * Math.cos(ky * (Y(j) + d / 2)))

  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const vert = (x: number, y: number, z: number, u: number, v: number) => {
    pos.push(x, y, z)
    uv.push(u / tile, v / tile)
    return pos.length / 3 - 1
  }
  /** Quad a-b-c-d, counter-clockwise seen from the side it faces. */
  const quad = (a: number, b: number, c: number, e: number) => idx.push(a, b, c, a, c, e)

  // Egg-crate face (normal −z) and flat back (+z): the same grid, opposite winding.
  for (const face of [-1, 1]) {
    const o = pos.length / 3
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) vert(X(i), Y(j), face < 0 ? -depth(i, j) : 0, X(i), Y(j))
    const at = (i: number, j: number) => o + j * (nx + 1) + i
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (face > 0) quad(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1))
        else quad(at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j))
      }
  }

  // Cut sides: a strip from the back edge down to the wavy edge. `pt(s)` walks the edge so that,
  // seen from outside, s runs left to right.
  const side = (n: number, pt: (s: number) => { x: number; y: number; t: number; u: number }) => {
    const o = pos.length / 3
    for (let s = 0; s <= n; s++) {
      const p = pt(s)
      vert(p.x, p.y, -p.t, p.u, -p.t) // 2s: wavy edge
      vert(p.x, p.y, 0, p.u, 0) // 2s + 1: back edge
    }
    for (let s = 0; s < n; s++) quad(o + 2 * s, o + 2 * s + 2, o + 2 * s + 3, o + 2 * s + 1)
  }
  side(nx, (s) => ({ x: X(s), y: -d / 2, t: depth(s, 0), u: X(s) })) // front (−y)
  side(ny, (s) => ({ x: w / 2, y: Y(s), t: depth(nx, s), u: Y(s) })) // right (+x)
  side(nx, (s) => ({ x: X(nx - s), y: d / 2, t: depth(nx - s, ny), u: -X(nx - s) })) // back (+y)
  side(ny, (s) => ({ x: -w / 2, y: Y(ny - s), t: depth(0, ny - s), u: -Y(ny - s) })) // left (−x)

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  g.computeBoundingBox()
  return g
}

/** Foam speckle: a small tiling noise texture (pores and flecks), or none without a DOM. */
function speckle(): THREE.Texture | null {
  if (typeof document === 'undefined') return null
  const n = 128
  const c = document.createElement('canvas')
  c.width = c.height = n
  const ctx = c.getContext('2d')
  if (!ctx) return null
  const img = ctx.createImageData(n, n)
  // Deterministic, so the foam doesn't change from one mount to the next.
  let seed = 0x2f6b1d
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  for (let i = 0; i < n * n; i++) {
    const r = rnd()
    let v = 228 + (rnd() - 0.5) * 28
    if (r < 0.06) v = 150 + rnd() * 50 // pore
    else if (r > 0.985) v = 255 // fleck
    img.data[4 * i] = img.data[4 * i + 1] = img.data[4 * i + 2] = v
    img.data[4 * i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

/** Matte foam with the speckle as its colour map; dispose `material.map` along with it. */
export function lidFoamMaterial(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0, map: speckle() })
}

// Measured on the SYS 1 lid of the reference mesh (systainerModel.ts frame, lid closed):
/** Top of the lid part's bounding box; the pad is placed relative to it, so it follows the lid. */
const LID_TOP = 112.0
/** Underside of the lid's recessed top panel, the lowest ceiling over the pad. */
const LID_CEILING = 88.7
/** The pad (21 mm thick, so it hangs 13 mm below the rim when shut), a few mm inside everything
 * it could meet: the lid's two side ribs (x ±182 at y ≈ 55, down to z 72), the latch housing
 * under the lid front (y < −114), the base walls (x ±191 at their tightest) and, as the lid
 * swings open, the hinge posts in the base's back corners (|x| > 178, y > 118). */
export const LID_FOAM = { w: 354, d: 220, cy: 0, gap: 0.2 }

/** The pad as a mesh in the lid's frame, its back on the lid's ceiling, given the lid geometry. */
export function lidFoamMesh(lidGeometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  if (!lidGeometry.boundingBox) lidGeometry.computeBoundingBox()
  const lift = lidGeometry.boundingBox!.max.z - LID_TOP
  const m = new THREE.Mesh(lidFoamGeometry(LID_FOAM.w, LID_FOAM.d), material)
  m.position.set(0, LID_FOAM.cy, LID_CEILING - LID_FOAM.gap + lift)
  m.castShadow = true
  m.receiveShadow = true
  m.name = 'lidFoam'
  return m
}
