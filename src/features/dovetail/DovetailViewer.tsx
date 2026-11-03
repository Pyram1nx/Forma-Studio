// three.js preview of the finished corner: the tail board and the pin board as they come off
// Origin, joined or pulled apart. Both boards are extrusions of the joint's exact cross-sections
// (dovetailLayout), so what you see is what the two layouts cut.
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Pt } from '../../model/types'
import { COLORS, hexNum, paintBackdrop } from '../../ui/colors'
import { useIsDark } from '../../state/theme'
import { dovetailLayout, type DovetailParams } from './dovetail'

export interface DovetailViewerProps {
  params: DovetailParams
  /** 0 = joined, 1 = pulled apart. Animated. */
  apart: boolean
}

/** Light wood with long grain along u; tinted per board. */
function woodTexture(): THREE.CanvasTexture {
  const S = 512
  const canvas = document.createElement('canvas')
  canvas.width = S
  canvas.height = S
  const g = canvas.getContext('2d')
  if (g) {
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, S, S)
    let seed = 7654321
    const rnd = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    for (let i = 0; i < 200; i++) {
      const y0 = rnd() * S
      const k = 1 + Math.floor(rnd() * 3)
      const amp = 1 + rnd() * 4
      const phase = rnd() * Math.PI * 2
      g.strokeStyle = `rgba(110, 70, 30, ${(0.05 + rnd() * 0.14).toFixed(3)})`
      g.lineWidth = 0.5 + rnd() * 1.5
      for (const dy of [-S, 0, S]) {
        g.beginPath()
        for (let x = 0; x <= S; x += 4) {
          const y = y0 + dy + Math.sin((x / S) * k * Math.PI * 2 + phase) * amp
          if (x === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        }
        g.stroke()
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.repeat.set(1 / 140, 1 / 140)
  return tex
}

/**
 * Extrude a (c, a) outline by `depth` along b, then place it in the world: x = b (from `b0`),
 * y = c, z = a (board width standing up). The axis map is a rotation, so faces keep their winding.
 */
function prism(outline: Pt[], b0: number, depth: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p.y, p.x)))
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 })
  const m = new THREE.Matrix4().set(0, 0, 1, b0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1)
  geo.applyMatrix4(m)
  return geo
}

/**
 * The pin board as one closed solid, so the pins run into the board without a seam: its two
 * faces are single comb-shaped polygons, and every face shares its edges exactly with its
 * neighbours (EdgesGeometry then draws only real creases). World axes as in `prism`.
 * UVs run u along the board's length (x), so the grain follows it.
 */
export function pinBoardGeometry(pins: Pt[][], tails: Pt[][], W: number, tP: number, tT: number, len: number): THREE.BufferGeometry {
  const B = tT + len
  const pos: number[] = []
  const nor: number[] = []
  const uv: number[] = []
  const P = (a: number, b: number, c: number) => new THREE.Vector3(b, c, a)
  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  const tri = new THREE.Vector3()

  /** A planar polygon facing `n` (an outward axis it leans toward; exact normals come from the points). */
  const face = (pts: THREE.Vector3[], n: THREE.Vector3) => {
    const ax = Math.abs(n.x) >= Math.abs(n.y) && Math.abs(n.x) >= Math.abs(n.z) ? 'x' : Math.abs(n.y) >= Math.abs(n.z) ? 'y' : 'z'
    const flat = pts.map((p) => (ax === 'x' ? new THREE.Vector2(p.z, p.y) : ax === 'y' ? new THREE.Vector2(p.x, p.z) : new THREE.Vector2(p.x, p.y)))
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(flat, [])) {
      let [a, b, c] = [pts[i], pts[j], pts[k]]
      tri.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a))
      if (tri.dot(n) < 0) [b, c] = [c, b]
      tri.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a)).normalize()
      for (const p of [a, b, c]) {
        pos.push(p.x, p.y, p.z)
        nor.push(tri.x, tri.y, tri.z)
        // End grain (facing x) maps across the width; every other face runs along the length.
        if (ax === 'x') uv.push(p.z, p.y)
        else uv.push(p.x, ax === 'y' ? p.z : p.y)
      }
    }
  }

  /** One board face (c = const): the solid board plus every pin, as a single comb. */
  const comb = (c: number, side: 0 | 2) => {
    const pts = [P(0, B, c)]
    pins.forEach((pin) => {
      const l = side === 0 ? pin[0].x : pin[3].x
      const r = side === 0 ? pin[1].x : pin[2].x
      if (l > 1e-9) pts.push(P(l, tT, c), P(l, 0, c))
      else pts.push(P(0, 0, c))
      if (r < W - 1e-9) pts.push(P(r, 0, c), P(r, tT, c))
      else pts.push(P(W, 0, c))
    })
    pts.push(P(W, B, c))
    return pts
  }

  face(comb(0, 0), new THREE.Vector3(0, -1, 0))
  face(comb(tP, 2), new THREE.Vector3(0, 1, 0))
  face([P(0, 0, 0), P(0, B, 0), P(0, B, tP), P(0, 0, tP)], new THREE.Vector3(0, 0, -1))
  face([P(W, 0, 0), P(W, B, 0), P(W, B, tP), P(W, 0, tP)], new THREE.Vector3(0, 0, 1))
  face([P(0, B, 0), P(W, B, 0), P(W, B, tP), P(0, B, tP)], new THREE.Vector3(1, 0, 0))
  for (const [o0, o1, i1, i0] of pins) {
    // The pin's end grain, then its flanks (none on the board edges).
    face([P(o0.x, 0, 0), P(o1.x, 0, 0), P(i1.x, 0, tP), P(i0.x, 0, tP)], new THREE.Vector3(-1, 0, 0))
    if (o0.x > 1e-9) face([P(o0.x, 0, 0), P(o0.x, tT, 0), P(i0.x, tT, tP), P(i0.x, 0, tP)], new THREE.Vector3(0, 0, -1))
    if (o1.x < W - 1e-9) face([P(o1.x, 0, 0), P(o1.x, tT, 0), P(i1.x, tT, tP), P(i1.x, 0, tP)], new THREE.Vector3(0, 0, 1))
  }
  // Socket floors, where the tails bottom out.
  for (const [o0, o1, i1, i0] of tails) face([P(o0.x, tT, 0), P(o1.x, tT, 0), P(i1.x, tT, tP), P(i0.x, tT, tP)], new THREE.Vector3(-1, 0, 0))

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  return geo
}

interface View {
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  tail: THREE.Group
  pin: THREE.Group
  grid: THREE.GridHelper
  background: THREE.Color
  mats: { tail: THREE.MeshStandardMaterial; pin: THREE.MeshStandardMaterial; edge: THREE.LineBasicMaterial }
  /** Animated explode amount, eased toward `target`. */
  explode: { now: number; target: number; dist: number }
}

function clearGroup(g: THREE.Group) {
  for (const child of [...g.children]) {
    ;(child as THREE.Mesh).geometry?.dispose()
    g.remove(child)
  }
}

export default function DovetailViewer({ params, apart }: DovetailViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<View | null>(null)
  const framed = useRef('')
  const dark = useIsDark()

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const background = new THREE.Color(COLORS.gray50)
    scene.background = background
    const camera = new THREE.PerspectiveCamera(32, 1, 1, 100000)
    camera.up.set(0, 0, 1)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    scene.add(new THREE.AmbientLight(0xffffff, 0.55))
    scene.add(new THREE.HemisphereLight(0xffffff, hexNum(COLORS.ground), 0.9))
    const sun = new THREE.DirectionalLight(0xffffff, 1.5)
    sun.position.set(-2, -3, 4)
    scene.add(sun)
    const rim = new THREE.DirectionalLight(0xffffff, 0.35)
    rim.position.set(3, 2, 1)
    scene.add(rim)

    const grid = new THREE.GridHelper(3000, 120, hexNum(COLORS.gray200), hexNum(COLORS.gridMinor))
    grid.rotation.x = Math.PI / 2
    scene.add(grid)

    // One grain texture; both boards map u along their length.
    const tailTex = woodTexture()
    const mats = {
      tail: new THREE.MeshStandardMaterial({ map: tailTex, color: hexNum(COLORS.wood), roughness: 0.78, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      pin: new THREE.MeshStandardMaterial({ map: tailTex, color: 0xc89a62, roughness: 0.78, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      edge: new THREE.LineBasicMaterial({ color: hexNum(COLORS.cutLine), transparent: true, opacity: 0.45 }),
    }
    const tail = new THREE.Group()
    const pin = new THREE.Group()
    scene.add(tail, pin)

    const ro = new ResizeObserver(() => {
      const w = Math.max(1, host.clientWidth)
      const h = Math.max(1, host.clientHeight)
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    })
    ro.observe(host)

    const explode = { now: 0, target: 0, dist: 40 }
    const timer = new THREE.Timer()
    renderer.setAnimationLoop(() => {
      timer.update()
      const dt = Math.min(0.05, timer.getDelta())
      explode.now += (explode.target - explode.now) * (1 - Math.exp(-dt * 9))
      // The tails slide out of the pins across the tail board's thickness (−x).
      tail.position.x = -explode.now * explode.dist
      controls.update()
      renderer.render(scene, camera)
    })
    viewRef.current = { camera, controls, tail, pin, grid, background, mats, explode }

    return () => {
      viewRef.current = null
      framed.current = ''
      ro.disconnect()
      renderer.setAnimationLoop(null)
      clearGroup(tail)
      clearGroup(pin)
      for (const m of Object.values(mats)) m.dispose()
      tailTex.dispose()
      grid.geometry.dispose()
      ;(grid.material as THREE.Material).dispose()
      controls.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    }
  }, [])

  // Background and grid follow the light/dark appearance.
  useEffect(() => {
    const v = viewRef.current
    if (v) paintBackdrop(v.background, v.grid, dark)
  }, [dark])

  // Board geometry, rebuilt on every parameter change (a handful of prisms: cheap).
  useEffect(() => {
    const v = viewRef.current
    if (!v) return
    const L = dovetailLayout(params)
    const W = params.width
    const len = Math.min(320, Math.max(70, W * 0.75))
    clearGroup(v.tail)
    clearGroup(v.pin)
    const add = (g: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material) => {
      g.add(new THREE.Mesh(geo, mat))
      g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), v.mats.edge))
    }
    // Tail board: its face profile, through its thickness.
    if (L.tailNarrow > 0) add(v.tail, prism(L.tailProfile(params.pinThick + len), 0, params.tailThick), v.mats.tail)
    // Pin board: the pins across the joint, then the solid board.
    if (L.tailNarrow > 0 && L.pinNarrow > 0) add(v.pin, pinBoardGeometry(L.pins, L.tails, W, params.pinThick, params.tailThick, len), v.mats.pin)
    else {
      // No valid joint (the sidebar says why): show the plain board.
      const body = [
        { x: 0, y: 0 },
        { x: W, y: 0 },
        { x: W, y: params.pinThick },
        { x: 0, y: params.pinThick },
      ]
      add(v.pin, prism(body, 0, params.tailThick + len), v.mats.pin)
    }
    v.explode.dist = params.tailThick + Math.max(18, W * 0.12)

    // Frame the corner once per board size (editing the layout keeps the user's view).
    const key = `${W.toFixed(1)}|${len.toFixed(1)}`
    if (framed.current !== key) {
      framed.current = key
      // Aim a little low so the corner sits above the layout cards.
      const centre = new THREE.Vector3(len * 0.32, len * 0.32, W * 0.32)
      const r = Math.max(W, len) * 2.6
      v.camera.position.set(centre.x - r * 0.62, centre.y - r * 0.72, centre.z + r * 0.55)
      v.controls.target.copy(centre)
      v.camera.near = r / 200
      v.camera.far = r * 50
      v.camera.updateProjectionMatrix()
    }
  }, [params])

  useEffect(() => {
    if (viewRef.current) viewRef.current.explode.target = apart ? 1 : 0
  }, [apart])

  return <div ref={hostRef} className="c3d-viewer" />
}
