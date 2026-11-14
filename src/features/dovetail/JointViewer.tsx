// three.js preview of the finished corner, joined or pulled apart. Each board is built from the
// joint model's layers (./joints): regions in the joint plane extruded along b, so what you see
// is exactly what the two layouts cut, round bit corners included. Labels name the boards.
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { COLORS, hexNum, paintBackdrop } from '../../ui/colors'
import { useIsDark } from '../../state/theme'
import * as R from './region'
import type { JointModel } from './joints'
import { boardGeometry } from './boardGeometry'

export interface JointViewerProps {
  model: JointModel
  /** Pull the tail board off the pins (animated). */
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

interface View {
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  tail: THREE.Group
  pin: THREE.Group
  grid: THREE.GridHelper
  background: THREE.Color
  mats: { tail: THREE.MeshStandardMaterial; pin: THREE.MeshStandardMaterial; edge: THREE.LineBasicMaterial }
  /** Animated slide-off amount, eased toward `target`. */
  explode: { now: number; target: number; dist: number }
  /** Label anchors (world, the tail's moves with the board). */
  anchors: { tail: THREE.Vector3; pin: THREE.Vector3 }
}

function clearGroup(g: THREE.Group) {
  for (const child of [...g.children]) {
    ;(child as THREE.Mesh).geometry?.dispose()
    g.remove(child)
  }
}

export default function JointViewer({ model, apart }: JointViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const tailLabel = useRef<HTMLSpanElement>(null)
  const pinLabel = useRef<HTMLSpanElement>(null)
  const viewRef = useRef<View | null>(null)
  const framed = useRef('')
  const dark = useIsDark()

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    host.prepend(renderer.domElement)

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

    const tex = woodTexture()
    const mats = {
      tail: new THREE.MeshStandardMaterial({ map: tex, color: hexNum(COLORS.wood), roughness: 0.78, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      pin: new THREE.MeshStandardMaterial({ map: tex, color: 0xc89a62, roughness: 0.78, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
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
    const anchors = { tail: new THREE.Vector3(), pin: new THREE.Vector3() }
    const v3 = new THREE.Vector3()
    const TAIL_FACE = new THREE.Vector3(-1, 0, 0)
    const PIN_FACE = new THREE.Vector3(0, -1, 0)
    const look = new THREE.Vector3()
    /** Pin a label to a point on a board face; hide it while that face is turned away. */
    const place = (el: HTMLElement | null, p: THREE.Vector3, face: THREE.Vector3, dx = 0) => {
      if (!el) return
      v3.copy(p)
      v3.x += dx
      const away = look.subVectors(camera.position, v3).dot(face) <= 0
      v3.project(camera)
      const hidden = v3.z > 1 || away
      el.style.opacity = hidden ? '0' : ''
      el.style.transform = `translate(${((v3.x + 1) / 2) * host.clientWidth}px, ${((1 - v3.y) / 2) * host.clientHeight}px) translate(-50%, -50%)`
    }
    const timer = new THREE.Timer()
    renderer.setAnimationLoop(() => {
      timer.update()
      const dt = Math.min(0.05, timer.getDelta())
      explode.now += (explode.target - explode.now) * (1 - Math.exp(-dt * 9))
      // The tail board slides off across its own thickness (−x).
      tail.position.x = -explode.now * explode.dist
      controls.update()
      renderer.render(scene, camera)
      place(tailLabel.current, anchors.tail, TAIL_FACE, tail.position.x)
      place(pinLabel.current, anchors.pin, PIN_FACE)
    })
    viewRef.current = { camera, controls, tail, pin, grid, background, mats, explode, anchors }

    return () => {
      viewRef.current = null
      framed.current = ''
      ro.disconnect()
      renderer.setAnimationLoop(null)
      clearGroup(tail)
      clearGroup(pin)
      for (const m of Object.values(mats)) m.dispose()
      tex.dispose()
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

  // Board geometry, rebuilt when the joint changes.
  useEffect(() => {
    const v = viewRef.current
    if (!v) return
    clearGroup(v.tail)
    clearGroup(v.pin)
    for (const [g, solid, mat] of [
      [v.tail, model.tail, v.mats.tail],
      [v.pin, model.pin, v.mats.pin],
    ] as const) {
      if (!solid.layers.length) continue
      const { mesh, edges } = boardGeometry(solid)
      g.add(new THREE.Mesh(mesh, mat))
      g.add(new THREE.LineSegments(edges, v.mats.edge))
    }
    v.explode.dist = model.slide

    // Labels sit on each board, partway along it.
    const W = model.width
    const L = model.length
    const tLast = model.tail.layers[model.tail.layers.length - 1]
    const pFirst = model.pin.layers[0]
    const pinBounds = pFirst ? R.bounds(pFirst.region) : { minY: 0, maxY: 10 }
    const tP = Math.max(pinBounds.maxY, 1)
    // On each board's outer face, the faces the camera starts out looking at.
    if (tLast) v.anchors.tail.set(model.tail.layers[0].b0, tP + L * 0.55, W * 0.55)
    if (pFirst) v.anchors.pin.set((tLast?.b1 ?? 0) + L * 0.55, 0, W * 0.55)

    // Frame the corner once per board size (editing the layout keeps the user's view).
    const key = `${model.kind}|${W.toFixed(1)}|${L.toFixed(1)}`
    if (framed.current !== key) {
      framed.current = key
      const centre = new THREE.Vector3(L * 0.32, L * 0.32, W * 0.32)
      const r = Math.max(W, L) * 2.6
      v.camera.position.set(centre.x - r * 0.62, centre.y - r * 0.72, centre.z + r * 0.55)
      v.controls.target.copy(centre)
      v.camera.near = r / 200
      v.camera.far = r * 50
      v.camera.updateProjectionMatrix()
    }
  }, [model])

  useEffect(() => {
    if (viewRef.current) viewRef.current.explode.target = apart ? 1 : 0
  }, [apart])

  return (
    <div ref={hostRef} className="c3d-viewer jv">
      <span ref={tailLabel} className="jv-label jv-label--tail">
        {model.names.tail}
      </span>
      <span ref={pinLabel} className="jv-label jv-label--pin">
        {model.names.pin}
      </span>
    </div>
  )
}
