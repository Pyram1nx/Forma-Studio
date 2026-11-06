// three.js view of the Systainer and its insert. The foam is built from the evaluated pockets
// (stacked slabs, each with the pockets that reach through it cut out), the items sit in them, and
// the user moves items by dragging them and turns them with the ring round the selected one.
// "2D" is the same scene from straight above with an orthographic camera.
import { useEffect, useImperativeHandle, useRef, type Ref, type RefObject } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { Contour } from '../../model/types'
import { boolean, splitRegions, unionNonZero } from '../../geometry/offset'
import { COLORS, hexNum, paintBackdrop } from '../../ui/colors'
import { useIsDark } from '../../state/theme'
import { getItem, itemParams, resizeAxes, spinRolls, uidSeed, type ResizeAxes } from './catalog'
import { posed, type Evaluation, type Layout } from './layout'
import { textToContours } from '../../io/text'
import { lidFoamMaterial, lidFoamMesh } from './lidFoam'
import { KNOB_AXIS, KNOB_TURN_DEG, LID_HINGE, LID_OPEN_DEG, loadSystainerParts, rimZ, SYS_OUTER, sysSpec, systainerGeometry, type SysSize } from './systainerModel'

export type ViewMode = '3d' | '2d'

export interface ViewerHandle {
  /** Foam-surface point under a client position, or null off the view. */
  pick: (clientX: number, clientY: number) => { x: number; y: number } | null
  /** Show (or clear) the item being dragged in from the catalogue. */
  ghost: (g: { item: string; x: number; y: number } | null) => void
}

export interface SystainerViewerProps {
  layout: Layout
  ev: Evaluation
  selected: string | null
  view: ViewMode
  /** Lid open (the default) or shut over the insert. */
  lidOpen: boolean
  onSelect: (uid: string | null) => void
  /** done = the drag ended (one undo step per drag). */
  onMove: (uid: string, x: number, y: number, done: boolean) => void
  onRotate: (uid: string, rot: number, done: boolean) => void
  /** A corner handle resized the item: its new params (done = the drag ended). */
  onResize: (uid: string, params: Record<string, number>, done: boolean) => void
  /** Floating toolbar kept above the selected item. */
  toolbarRef: RefObject<HTMLDivElement | null>
  ref?: Ref<ViewerHandle>
}

/** Foam faces (top and pocket floors) and pocket walls, darker so the cutouts read. */
const FOAM = 0x6b717c
const FOAM_WALL = 0x2c2f35
const SYS_PLASTIC = 0x4b4f57
const LATCH = 0x2b2d32
const LETTERING = 0xa9aeb8

interface ItemNode {
  key: string
  obj: THREE.Object3D
}

interface Scene3 {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  /** Kept so the backdrop can follow the light/dark appearance (paintBackdrop). */
  background: THREE.Color
  grid: THREE.GridHelper
  persp: THREE.PerspectiveCamera
  ortho: THREE.OrthographicCamera
  orbit: OrbitControls
  pan: OrbitControls
  sys: THREE.Group
  /** Hinged at the back: the pivot sits on the hinge axis, the lid's parts hang off it. */
  lidPivot: THREE.Group
  lid: THREE.Group
  /** The T-Loc turn: the whole lock block (`latchTurn`, one merged mesh from systainerGeometry)
   * spins in this group, pivoted on the turn axis inside the lid. */
  turn: THREE.Group
  letters: THREE.Group
  lidAngle: { now: number; target: number }
  knobAngle: { now: number; target: number }
  /** Whether the lid should be open; the animation sequences spin-then-swing towards it. */
  lidOpen: boolean
  foam: THREE.Group
  items: THREE.Group
  lines: THREE.Group
  ring: THREE.Group
  /** Resize chevrons at the selection's footprint corners (in the ring group, so in its turned frame). */
  handles: THREE.Group
  ghost: THREE.Group
  mats: { foam: THREE.MeshStandardMaterial; foamWall: THREE.MeshStandardMaterial; sys: THREE.MeshStandardMaterial; latch: THREE.MeshStandardMaterial; letters: THREE.MeshStandardMaterial; lidFoam: THREE.MeshStandardMaterial }
  nodes: Map<string, ItemNode>
}

/**
 * Aim the 3D camera at the base box (not base + open lid): its centre in plan (the outer shell is
 * centred on the origin), at the foam top, but no higher than 40 mm over the base's mid-height so
 * tall sizes don't sink off the bottom. From the front-left, 48° above the horizon, backed off
 * until the base's front-bottom edge (y −150, z 0) and the open lid's top edge with its latch
 * (≈ y 210, z rim + 265) fit the height, and the base's width fits a narrow (phone) view.
 */
function frameCamera(persp: THREE.PerspectiveCamera, orbit: OrbitControls, size: SysSize, foamTop: number) {
  const rim = rimZ(size)
  const tz = Math.min(foamTop, rim / 2 + 40)
  orbit.target.set(0, 0, tz)
  const el = (48 * Math.PI) / 180
  const az = (-7 * Math.PI) / 180
  const below = 150 * Math.sin(el) + tz * Math.cos(el)
  const above = 210 * Math.sin(el) + (rim + 265 - tz) * Math.cos(el)
  const tanV = Math.tan((persp.fov * Math.PI) / 360)
  const byHeight = Math.max(below, above) / tanV
  const byWidth = (SYS_OUTER.w / 2 + 12) / (tanV * Math.max(0.1, persp.aspect))
  const dist = Math.max(byHeight, byWidth) * 1.05
  persp.position.set(dist * Math.cos(el) * Math.sin(az), -dist * Math.cos(el) * Math.cos(az), tz + dist * Math.sin(el))
  persp.updateProjectionMatrix()
  orbit.update()
}

function disposeChildren(g: THREE.Object3D, geometries = true) {
  for (const c of [...g.children]) {
    if (geometries) c.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
    g.remove(c)
  }
}

/** Contours (outer + holes) as a THREE.Shape. */
function toShape(region: Contour[]): THREE.Shape {
  const s = new THREE.Shape(region[0].pts.map((p) => new THREE.Vector2(p.x, p.y)))
  for (const h of region.slice(1)) s.holes.push(new THREE.Path(h.pts.map((p) => new THREE.Vector2(p.x, p.y))))
  return s
}

/** The foam as stacked slabs: each slab has the pockets that reach through it removed. */
function buildFoam(ev: Evaluation): THREE.BufferGeometry[] {
  const depths = [...new Set(ev.pockets.map((p) => Math.round(p.depth * 10) / 10))].filter((d) => d > 0 && d < ev.thickness).sort((a, b) => a - b)
  const bounds = [0, ...depths, ev.thickness]
  const geos: THREE.BufferGeometry[] = []
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i]
    const b = bounds[i + 1]
    // Union first (non-zero): an item's nested steps and touching pockets overlap.
    const holes = unionNonZero(ev.pockets.filter((p) => p.depth > a + 0.01).flatMap((p) => p.contours))
    const region = holes.length ? boolean('difference', [ev.outline], holes) : [ev.outline]
    for (const r of splitRegions(region)) {
      const g = new THREE.ExtrudeGeometry(toShape(r), { depth: b - a, bevelEnabled: false, curveSegments: 1 })
      g.translate(0, 0, ev.foamTop - b)
      geos.push(g)
    }
  }
  return geos
}

function lineLoop(c: Contour, z: number, mat: THREE.LineBasicMaterial): THREE.LineLoop {
  const g = new THREE.BufferGeometry().setFromPoints(c.pts.map((p) => new THREE.Vector3(p.x, p.y, z)))
  return new THREE.LineLoop(g, mat)
}

const LINE = {
  normal: new THREE.LineBasicMaterial({ color: 0xb7c3e6, transparent: true, opacity: 0.55 }),
  selected: new THREE.LineBasicMaterial({ color: hexNum(COLORS.blue050) }),
  problem: new THREE.LineBasicMaterial({ color: 0xff274e }),
  outline: new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }),
}

export default function SystainerViewer({ layout, ev, selected, view, lidOpen, onSelect, onMove, onRotate, onResize, toolbarRef, ref }: SystainerViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const s3 = useRef<Scene3 | null>(null)
  /** Size the camera was last framed for; a new scene (remount) frames again. */
  const framedSize = useRef<SysSize | null>(null)
  /** The user has orbited or zoomed since the last framing: resizes then keep their view. */
  const userOrbited = useRef(false)
  const dark = useIsDark()
  // Latest props for the event handlers, which are bound once.
  const live = useRef({ layout, ev, selected, view, lidOpen, onSelect, onMove, onRotate, onResize })
  live.current = { layout, ev, selected, view, lidOpen, onSelect, onMove, onRotate, onResize }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const background = new THREE.Color(COLORS.gray50)
    scene.background = background
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.55
    pmrem.dispose()

    const persp = new THREE.PerspectiveCamera(30, 1, 5, 20000)
    persp.up.set(0, 0, 1)
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 5000)
    ortho.up.set(0, 1, 0)

    scene.add(new THREE.HemisphereLight(0xffffff, hexNum(COLORS.ground), 0.7))
    const sun = new THREE.DirectionalLight(0xffffff, 1.5)
    sun.position.set(-160, -260, 700)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    Object.assign(sun.shadow.camera, { left: -260, right: 260, top: 220, bottom: -220, near: 100, far: 1400 })
    sun.shadow.bias = -0.0004
    sun.shadow.normalBias = 0.6
    scene.add(sun)
    const rim = new THREE.DirectionalLight(0xffffff, 0.35)
    rim.position.set(300, 250, 200)
    scene.add(rim)

    const grid = new THREE.GridHelper(2400, 96, hexNum(COLORS.gray200), hexNum(COLORS.gridMinor))
    grid.rotation.x = Math.PI / 2
    grid.position.z = -0.5
    scene.add(grid)

    const mats = {
      foam: new THREE.MeshStandardMaterial({ color: FOAM, roughness: 0.97, metalness: 0 }),
      foamWall: new THREE.MeshStandardMaterial({ color: FOAM_WALL, roughness: 1, metalness: 0 }),
      sys: new THREE.MeshStandardMaterial({ color: SYS_PLASTIC, roughness: 0.62, metalness: 0.05 }),
      latch: new THREE.MeshStandardMaterial({ color: LATCH, roughness: 0.5, metalness: 0.05 }),
      letters: new THREE.MeshStandardMaterial({ color: LETTERING, roughness: 0.55, metalness: 0.05 }),
      // The egg-crate pad inside the lid (lidFoam.ts), speckled foam.
      lidFoam: lidFoamMaterial(FOAM),
    }
    const groups = { sys: new THREE.Group(), foam: new THREE.Group(), items: new THREE.Group(), lines: new THREE.Group(), ring: new THREE.Group(), ghost: new THREE.Group() }
    for (const g of Object.values(groups)) scene.add(g)
    const lidPivot = new THREE.Group()
    const lid = new THREE.Group()
    const letters = new THREE.Group()
    const turn = new THREE.Group()
    lid.add(letters, turn)
    lidPivot.add(lid)
    scene.add(lidPivot)
    const lidAngle = { now: -LID_OPEN_DEG, target: -LID_OPEN_DEG }
    const knobAngle = { now: KNOB_TURN_DEG, target: KNOB_TURN_DEG }

    // Rotation ring: a flat band with a grip, laid on the foam round the selected item.
    const ringMat = new THREE.MeshBasicMaterial({ color: hexNum(COLORS.blue050), transparent: true, opacity: 0.85, depthTest: false })
    const band = new THREE.Mesh(new THREE.RingGeometry(1, 1.035, 96), ringMat)
    band.renderOrder = 10
    const grip = new THREE.Mesh(new THREE.CircleGeometry(1, 32), ringMat)
    grip.renderOrder = 11
    const gripDot = new THREE.Mesh(new THREE.CircleGeometry(1, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }))
    gripDot.renderOrder = 12
    groups.ring.add(band, grip, gripDot)
    groups.ring.visible = false

    // Resize chevrons, one per footprint corner, in the ring's (the item's) turned frame. Drawn in
    // screen pixels (the loop scales them): an L whose apex points out of the corner at +x +y.
    const handleMat = new THREE.MeshBasicMaterial({ color: hexNum(COLORS.blue050), transparent: true, opacity: 0.95, depthTest: false })
    const chevron = new THREE.ShapeGeometry(
      new THREE.Shape([[0, 0], [-10, 0], [-10, -3.2], [-3.2, -3.2], [-3.2, -10], [0, -10]].map(([x, y]) => new THREE.Vector2(x, y))),
    )
    const handles = new THREE.Group()
    for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      const m = new THREE.Mesh(chevron, handleMat)
      m.renderOrder = 13
      m.userData.corner = [sx, sy]
      m.rotation.z = Math.atan2(sy, sx) - Math.PI / 4
      handles.add(m)
    }
    handles.visible = false
    groups.ring.add(handles)

    // Pointer handlers are added before the controls so a press on an item can switch them off first.
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
    const hitPt = new THREE.Vector3()
    const camera = () => (live.current.view === '2d' ? ortho : persp)
    const setRay = (cx: number, cy: number) => {
      const r = renderer.domElement.getBoundingClientRect()
      ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera())
      return r
    }
    const onFoam = (cx: number, cy: number): THREE.Vector3 | null => {
      setRay(cx, cy)
      plane.constant = -live.current.ev.foamTop
      return ray.ray.intersectPlane(plane, hitPt) ? hitPt.clone() : null
    }
    const uidOf = (o: THREE.Object3D | null): string | null => {
      for (let p = o; p; p = p.parent) if (p.userData.uid) return p.userData.uid as string
      return null
    }

    // The resize chevron under a client point, picked in screen space (a finger gets a wider
    // reach than a mouse), with the cursor that matches its diagonal on screen.
    const hv = new THREE.Vector3()
    const hc = new THREE.Vector3()
    const handleAt = (cx: number, cy: number, touch: boolean): { corner: [number, number]; cursor: string } | null => {
      if (!groups.ring.visible || !handles.visible) return null
      const r = renderer.domElement.getBoundingClientRect()
      const cam = camera()
      const scr = (v: THREE.Vector3) => {
        v.project(cam)
        return [r.left + (v.x * 0.5 + 0.5) * r.width, r.top + (-v.y * 0.5 + 0.5) * r.height]
      }
      const [ox, oy] = scr(hc.copy(groups.ring.position))
      let best: { corner: [number, number]; cursor: string } | null = null
      let bestD = touch ? 24 : 13
      for (const m of handles.children) {
        // Aim at the body of the chevron, a little in from its apex.
        const [x, y] = scr(hv.set(-3, -3, 0).applyMatrix4(m.matrixWorld))
        const dd = Math.hypot(cx - x, cy - y)
        if (dd < bestD) {
          bestD = dd
          best = { corner: m.userData.corner as [number, number], cursor: (x - ox) * (y - oy) > 0 ? 'nwse-resize' : 'nesw-resize' }
        }
      }
      return best
    }
    /** A foam point in the selected item's turned frame. */
    const toLocal = (f: THREE.Vector3, d: { cx: number; cy: number; c: number; s: number }) => {
      const dx = f.x - d.cx
      const dy = f.y - d.cy
      return [dx * d.c + dy * d.s, -dx * d.s + dy * d.c]
    }

    type Drag =
      | { kind: 'move'; uid: string; dx: number; dy: number; moved: boolean; sx: number; sy: number }
      | { kind: 'rotate'; uid: string; cx: number; cy: number; a0: number; r0: number }
      | {
          kind: 'resize'
          uid: string
          cx: number
          cy: number
          /** cos / sin of the item's turn. */
          c: number
          s: number
          /** The corner dragged, ±1 per axis. */
          sx: number
          sy: number
          /** Where the press landed, in the item's frame. */
          lx0: number
          ly0: number
          axes: ResizeAxes
          params0: Record<string, number>
          limits: Record<string, [number, number]>
          last: string
          moved: boolean
        }
      | { kind: 'empty'; sx: number; sy: number }
    let drag: Drag | null = null

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      setRay(e.clientX, e.clientY)
      const { layout: L, selected: sel } = live.current
      // Resize handles first: they sit inside the ring and over the item.
      const h = sel ? handleAt(e.clientX, e.clientY, e.pointerType !== 'mouse') : null
      if (h && sel) {
        const p = L.items.find((i) => i.uid === sel)
        const def = p && getItem(p.item)
        const axes = p && def ? resizeAxes(def, p.pose) : null
        const f = onFoam(e.clientX, e.clientY)
        if (p && def && axes && f) {
          const a = (p.rot * Math.PI) / 180
          const frame = { cx: p.x, cy: p.y, c: Math.cos(a), s: Math.sin(a) }
          const [lx0, ly0] = toLocal(f, frame)
          const params0 = itemParams(def, p.params)
          const limits = Object.fromEntries((def.params ?? []).map((pd) => [pd.key, [pd.min, pd.max] as [number, number]]))
          drag = { kind: 'resize', uid: sel, ...frame, sx: h.corner[0], sy: h.corner[1], lx0, ly0, axes, params0, limits, last: JSON.stringify(params0), moved: false }
          orbit.enabled = pan.enabled = false
          renderer.domElement.setPointerCapture(e.pointerId)
          renderer.domElement.style.cursor = h.cursor
          return
        }
      }
      if (groups.ring.visible && band.visible && sel) {
        const hit = ray.intersectObjects([band, grip], false)[0]
        const p = L.items.find((i) => i.uid === sel)
        const f = onFoam(e.clientX, e.clientY)
        if (hit && p && f) {
          drag = { kind: 'rotate', uid: sel, cx: p.x, cy: p.y, a0: Math.atan2(f.y - p.y, f.x - p.x), r0: p.rot }
          orbit.enabled = pan.enabled = false
          renderer.domElement.setPointerCapture(e.pointerId)
          return
        }
      }
      const hit = ray.intersectObjects(groups.items.children, true)[0]
      const uid = hit ? uidOf(hit.object) : null
      if (uid) {
        const p = L.items.find((i) => i.uid === uid)
        const f = onFoam(e.clientX, e.clientY)
        if (p && f) {
          drag = { kind: 'move', uid, dx: p.x - f.x, dy: p.y - f.y, moved: false, sx: e.clientX, sy: e.clientY }
          orbit.enabled = pan.enabled = false
          renderer.domElement.setPointerCapture(e.pointerId)
          if (uid !== sel) live.current.onSelect(uid)
          return
        }
      }
      drag = { kind: 'empty', sx: e.clientX, sy: e.clientY }
    }
    const snap = (v: number, step: number) => Math.round(v / step) * step
    const onMovePtr = (e: PointerEvent) => {
      if (!drag) {
        // Touch has no hover; a finger resting on the canvas doesn't need a cursor.
        if (e.pointerType === 'touch') return
        const h = handleAt(e.clientX, e.clientY, false)
        if (h) {
          renderer.domElement.style.cursor = h.cursor
          return
        }
        setRay(e.clientX, e.clientY)
        const overRing = groups.ring.visible && band.visible && ray.intersectObjects([band, grip], false).length > 0
        const overItem = !overRing && ray.intersectObjects(groups.items.children, true).length > 0
        renderer.domElement.style.cursor = overRing ? 'ew-resize' : overItem ? 'grab' : ''
        return
      }
      if (drag.kind === 'empty') return
      const f = onFoam(e.clientX, e.clientY)
      if (!f) return
      if (drag.kind === 'resize') {
        const d = drag
        const [lx, ly] = toLocal(f, d)
        const step = e.shiftKey ? 0.1 : 0.5
        const fit = (key: string, v: number) => {
          const [lo, hi] = d.limits[key] ?? [0.1, Infinity]
          return Math.min(hi, Math.max(lo, Math.round(snap(v, step) * 100) / 100))
        }
        const next = { ...d.params0 }
        if ('round' in d.axes) {
          // Uniform: the size follows the corner's distance from the centre.
          const k = Math.hypot(lx, ly) / Math.max(1e-6, Math.hypot(d.lx0, d.ly0))
          next[d.axes.round] = fit(d.axes.round, d.params0[d.axes.round] * k)
        } else if (e.altKey) {
          // Alt keeps the proportions: scale both by the drag along the corner's diagonal.
          const k = (lx * d.lx0 + ly * d.ly0) / Math.max(1e-6, d.lx0 * d.lx0 + d.ly0 * d.ly0)
          next[d.axes.x] = fit(d.axes.x, d.params0[d.axes.x] * k)
          next[d.axes.y] = fit(d.axes.y, d.params0[d.axes.y] * k)
        } else {
          // Centre fixed: each side moves as far as the corner, so the size changes twice that.
          next[d.axes.x] = fit(d.axes.x, d.params0[d.axes.x] + 2 * d.sx * (lx - d.lx0))
          next[d.axes.y] = fit(d.axes.y, d.params0[d.axes.y] + 2 * d.sy * (ly - d.ly0))
        }
        const key = JSON.stringify(next)
        if (key === d.last) return
        d.last = key
        d.moved = true
        live.current.onResize(d.uid, next, false)
      } else if (drag.kind === 'move') {
        if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 3) return
        drag.moved = true
        renderer.domElement.style.cursor = 'grabbing'
        live.current.onMove(drag.uid, snap(f.x + drag.dx, 0.5), snap(f.y + drag.dy, 0.5), false)
      } else {
        const a = Math.atan2(f.y - drag.cy, f.x - drag.cx)
        let rot = drag.r0 + ((a - drag.a0) * 180) / Math.PI
        rot = e.shiftKey ? Math.round(rot) : snap(rot, 15)
        live.current.onRotate(drag.uid, ((rot % 360) + 360) % 360, false)
      }
    }
    const onUp = (e: PointerEvent) => {
      const d = drag
      drag = null
      orbit.enabled = live.current.view === '3d'
      pan.enabled = live.current.view === '2d'
      if (!d) return
      if (renderer.domElement.hasPointerCapture(e.pointerId)) renderer.domElement.releasePointerCapture(e.pointerId)
      const p = live.current.layout.items.find((i) => i.uid === (d.kind === 'empty' ? '' : d.uid))
      if (d.kind === 'resize') {
        const def = p && getItem(p.item)
        if (d.moved && p && def) live.current.onResize(d.uid, itemParams(def, p.params), true)
        renderer.domElement.style.cursor = ''
      } else if (d.kind === 'move' && d.moved && p) live.current.onMove(d.uid, p.x, p.y, true)
      else if (d.kind === 'rotate' && p) live.current.onRotate(d.uid, p.rot, true)
      else if (d.kind === 'empty' && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) live.current.onSelect(null)
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointermove', onMovePtr)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointercancel', onUp)

    const orbit = new OrbitControls(persp, renderer.domElement)
    orbit.enableDamping = true
    orbit.maxPolarAngle = Math.PI * 0.49
    orbit.minDistance = 120
    orbit.maxDistance = 3000
    orbit.addEventListener('start', () => (userOrbited.current = true))
    const pan = new OrbitControls(ortho, renderer.domElement)
    pan.enableRotate = false
    pan.screenSpacePanning = true
    pan.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
    pan.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN }
    pan.minZoom = 0.5
    pan.maxZoom = 12
    pan.enabled = false

    const ro = new ResizeObserver(() => {
      const w = Math.max(1, host.clientWidth)
      const h = Math.max(1, host.clientHeight)
      renderer.setSize(w, h)
      persp.aspect = w / h
      persp.updateProjectionMatrix()
      // Until the user moves the camera, keep the base framed for the view's new shape.
      if (framedSize.current != null && !userOrbited.current) frameCamera(persp, orbit, live.current.layout.size, live.current.ev.foamTop)
      // Fit the whole Systainer with a margin.
      const sw = SYS_OUTER.w + 90
      const sh = SYS_OUTER.d + 120
      const k = Math.max(sw / w, sh / h)
      Object.assign(ortho, { left: (-w * k) / 2, right: (w * k) / 2, top: (h * k) / 2, bottom: (-h * k) / 2 })
      ortho.updateProjectionMatrix()
    })
    ro.observe(host)

    const tmp = new THREE.Vector3()
    const timer = new THREE.Timer()
    renderer.setAnimationLoop(() => {
      const v = live.current
      const cam = v.view === '2d' ? ortho : persp
      timer.update()
      const dt = Math.min(0.05, timer.getDelta())
      // The T-Loc sequences: the block turns its full 135° first, and only then does the lid
      // swing open; on the way back the lid shuts completely before the block turns to lock.
      if (v.lidOpen) {
        knobAngle.target = KNOB_TURN_DEG
        if (Math.abs(knobAngle.now - knobAngle.target) < 0.5) lidAngle.target = -LID_OPEN_DEG
      } else {
        lidAngle.target = 0
        if (Math.abs(lidAngle.now) < 0.5) knobAngle.target = 0
      }
      lidAngle.now += (lidAngle.target - lidAngle.now) * (1 - Math.exp(-dt * 7))
      lidPivot.rotation.x = (lidAngle.now * Math.PI) / 180
      knobAngle.now += (knobAngle.target - knobAngle.now) * (1 - Math.exp(-dt * 9))
      turn.rotation.y = (knobAngle.now * Math.PI) / 180
      // From straight above the lid is only in the way.
      lidPivot.visible = v.view === '3d'
      ;(v.view === '2d' ? pan : orbit).update()
      // Keep the ring a constant thickness on screen.
      if (groups.ring.visible) {
        const px = cam === ortho ? (ortho.right - ortho.left) / ortho.zoom / Math.max(1, host.clientWidth) : (persp.position.distanceTo(groups.ring.position) * 2 * Math.tan((persp.fov * Math.PI) / 360)) / Math.max(1, host.clientHeight)
        const r = groups.ring.userData.radius as number
        const t = px * 3
        const [lr, lt] = (band.userData.dims as [number, number] | undefined) ?? [0, 0]
        if (Math.abs(lr - r) > 0.01 || Math.abs(lt - t) > lt * 0.03) {
          band.geometry.dispose()
          band.geometry = new THREE.RingGeometry(r, r + t, 96)
          band.userData.dims = [r, t]
        }
        const gr = px * 9
        grip.scale.setScalar(gr)
        gripDot.scale.setScalar(gr * 0.45)
        // Chevrons: constant size, just outside the footprint corners.
        if (handles.visible) {
          const { w, d } = handles.userData as { w: number; d: number }
          const off = px * 3
          for (const m of handles.children) {
            const [sx, sy] = m.userData.corner as [number, number]
            m.position.set(sx * (w / 2 + off), sy * (d / 2 + off), 0.02)
            m.scale.setScalar(px)
          }
        }
      }
      // Toolbar over the selected item.
      const tb = toolbarRef.current
      const node = v.selected ? s3.current?.nodes.get(v.selected) : undefined
      if (tb) {
        if (node && groups.ring.visible) {
          // Just in front of the ring (below it on screen).
          tmp.set(groups.ring.position.x, groups.ring.position.y - (groups.ring.userData.radius as number), v.ev.foamTop)
          tmp.project(cam)
          const x = (tmp.x * 0.5 + 0.5) * host.clientWidth
          const y = (-tmp.y * 0.5 + 0.5) * host.clientHeight
          tb.style.transform = `translate(${Math.round(Math.min(host.clientWidth - 8, Math.max(8, x)))}px, ${Math.round(Math.min(host.clientHeight - tb.offsetHeight - 18, Math.max(8, y)))}px)`
          tb.style.visibility = 'visible'
        } else tb.style.visibility = 'hidden'
      }
      renderer.render(scene, cam)
    })

    s3.current = { renderer, scene, background, grid, persp, ortho, orbit, pan, ...groups, handles, lidPivot, lid, turn, letters, lidAngle, knobAngle, lidOpen: live.current.lidOpen, mats, nodes: new Map() }

    return () => {
      s3.current = null
      framedSize.current = null
      ro.disconnect()
      renderer.setAnimationLoop(null)
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointermove', onMovePtr)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointercancel', onUp)
      disposeChildren(groups.sys)
      disposeChildren(letters)
      disposeChildren(lid)
      disposeChildren(groups.foam)
      disposeChildren(groups.lines)
      // Item clones share the catalogue's cached geometry: leave it alone.
      disposeChildren(groups.items, false)
      disposeChildren(groups.ghost, false)
      band.geometry.dispose()
      grip.geometry.dispose()
      gripDot.geometry.dispose()
      ringMat.dispose()
      chevron.dispose()
      handleMat.dispose()
      mats.lidFoam.map?.dispose()
      for (const m of Object.values(mats)) m.dispose()
      scene.environment?.dispose()
      grid.geometry.dispose()
      ;(grid.material as THREE.Material).dispose()
      orbit.dispose()
      pan.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    }
    // toolbarRef is a stable ref object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Background and grid follow the light/dark appearance.
  useEffect(() => {
    const v = s3.current
    if (v) paintBackdrop(v.background, v.grid, dark)
  }, [dark])

  // The Systainer itself, per size.
  const size: SysSize = layout.size
  useEffect(() => {
    let cancelled = false
    loadSystainerParts()
      .then((parts) => {
        const v = s3.current
        if (cancelled || !v) return
        disposeChildren(v.sys)
        for (const c of [...v.lid.children]) {
          if (c === v.letters || c === v.turn) continue
          ;(c as THREE.Mesh).geometry?.dispose()
          v.lid.remove(c)
        }
        disposeChildren(v.turn)
        const dz = sysSpec(size).stretch
        for (const { name, geometry } of systainerGeometry(parts, size)) {
          // The base (with its hinge pin) is static; the lid and everything mounted on it swings
          // on the hinge pivot — except `latchTurn`, the whole T-Loc lock block, which turns on
          // the latch's own axis.
          const sysPart = name.startsWith('base') || name === 'hingePin'
          const m = new THREE.Mesh(geometry, sysPart || name === 'lid' ? v.mats.sys : v.mats.latch)
          m.castShadow = sysPart || name === 'lid'
          m.receiveShadow = true
          if (name === 'latchTurn') v.turn.add(m)
          else if (sysPart) v.sys.add(m)
          else v.lid.add(m)
          // The egg-crate foam pad glued under the lid's ceiling swings with it.
          if (name === 'lid') v.lid.add(lidFoamMesh(geometry, v.mats.lidFoam))
        }
        // The lid turns about its hinge: pivot on the axis, the lid's parts offset back into place.
        v.lidPivot.position.set(0, LID_HINGE.y, LID_HINGE.z + dz)
        v.lid.position.set(0, -LID_HINGE.y, -(LID_HINGE.z + dz))
        v.letters.position.z = dz
        v.turn.position.set(KNOB_AXIS.x, 0, KNOB_AXIS.z + dz)
      })
      .catch(() => {
        // Without the model the insert still works; the walls just aren't drawn.
      })
    return () => {
      cancelled = true
    }
  }, [size])

  useEffect(() => {
    const v = s3.current
    if (!v) return
    v.lidOpen = lidOpen
  }, [lidOpen])

  // FORMA on the lid, in the Forma Studio face, where the Festool lettering was (pressed flat in
  // the model): big across the top and on the left front panel. The top face's flat field spans
  // x −100..100 / y −112..−10 at z = 110 (measured on the mesh) — the text is centred on it, so
  // the R sits on the lid's centreline. Front panel field: x −180..−95 / z 81..111. Placed for
  // SYS 1; the group rides up with the lid for taller sizes.
  useEffect(() => {
    let cancelled = false
    const place = async (text: string, cap: number) => {
      const cs = await textToContours(text, 'Forma Studio', cap)
      const pts = cs.flatMap((c) => c.pts)
      const cx = (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2
      const cy = (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2
      // Glyph contours run y down; flip them to read upright.
      return cs.map((c) => ({ closed: true, pts: c.pts.map((p) => ({ x: p.x - cx, y: -(p.y - cy) })) }))
    }
    Promise.all([place('FORMA', 22), place('FORMA', 7)])
      .then(([top, left]) => {
        const v = s3.current
        if (cancelled || !v) return
        disposeChildren(v.letters)
        const solid = (cs: Contour[], t: number) => {
          const regions = splitRegions(cs).map((r) => toShape(r))
          return new THREE.ExtrudeGeometry(regions, { depth: t, bevelEnabled: false, curveSegments: 6 })
        }
        // Top label: flat on the top face (z = 110), centred so the R sits mid-face, reading from
        // the front.
        const g1 = solid(top, 0.8)
        g1.translate(0, -62, 110)
        // Front panel (face at y = −144.2): stand the glyphs up and push them out toward −y.
        const g2 = solid(left, 0.6)
        g2.rotateX(Math.PI / 2)
        g2.translate(-138, -144.2, 96)
        for (const g of [g1, g2]) {
          const m = new THREE.Mesh(g, v.mats.letters)
          m.castShadow = true
          v.letters.add(m)
        }
      })
      .catch(() => {
        // No font, no lettering: the lid is still plain.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Frame the 3D camera when the size changes (the user's view is kept otherwise).
  useEffect(() => {
    const v = s3.current
    if (!v || framedSize.current === size) return
    framedSize.current = size
    userOrbited.current = false
    frameCamera(v.persp, v.orbit, size, ev.foamTop)
    // 2D: centred on the base, the latch at the front (y ≈ −160) to the hinge ears (y ≈ 150).
    v.pan.target.set(0, -5, 0)
    v.ortho.position.set(0, -5, 2000)
    v.ortho.lookAt(0, -5, 0)
  }, [size, ev.foamTop])

  // Switching views: the inactive controls stop listening.
  useEffect(() => {
    const v = s3.current
    if (!v) return
    v.orbit.enabled = view === '3d'
    v.pan.enabled = view === '2d'
  }, [view])

  // Foam and pocket outlines.
  useEffect(() => {
    const v = s3.current
    if (!v) return
    disposeChildren(v.foam)
    for (const g of buildFoam(ev)) {
      // ExtrudeGeometry: group 0 is the caps (top, pocket floors), group 1 the walls.
      const m = new THREE.Mesh(g, [v.mats.foam, v.mats.foamWall])
      m.receiveShadow = true
      m.castShadow = true
      v.foam.add(m)
    }
    disposeChildren(v.lines)
    const z = ev.foamTop + 0.25
    v.lines.add(lineLoop(ev.outline, z, LINE.outline))
    const bad = new Set(ev.items.filter((e) => e.problems.length).map((e) => e.uid))
    for (const pk of ev.pockets) {
      const mat = pk.uid === selected ? LINE.selected : bad.has(pk.uid) ? LINE.problem : LINE.normal
      // In 3D only the selection and problems are outlined; the cut foam shows the rest.
      if (view === '3d' && mat === LINE.normal) continue
      for (const c of pk.contours) v.lines.add(lineLoop(c, z, mat))
    }
  }, [ev, selected, view])

  // Items: one clone of the posed model per placed item, kept while its pose and size are unchanged.
  useEffect(() => {
    const v = s3.current
    if (!v) return
    const seen = new Set<string>()
    for (const pl of layout.items) {
      const def = getItem(pl.item)
      const e = ev.items.find((x) => x.uid === pl.uid)
      if (!def || !e) continue
      seen.add(pl.uid)
      const params = itemParams(def, pl.params)
      const spin = def.randomSpin ? (pl.spinSeed ?? uidSeed(pl.uid)) : null
      const key = `${def.id}|${pl.pose}|${Object.values(params).join(',')}|${spin}`
      let node = v.nodes.get(pl.uid)
      if (!node || node.key !== key) {
        if (node) v.items.remove(node.obj)
        const obj = posed(def, pl.pose, params).object.clone()
        // Display-only spin of each roll, on the clone (its own child transforms), not the cache.
        if (spin !== null) spinRolls(obj, spin)
        obj.userData.uid = pl.uid
        obj.traverse((o) => {
          const m = o as THREE.Mesh
          if (m.isMesh && !def.notch) m.castShadow = m.receiveShadow = true
        })
        node = { key, obj }
        v.nodes.set(pl.uid, node)
        v.items.add(obj)
      }
      node.obj.position.set(pl.x, pl.y, ev.foamTop - e.sink)
      node.obj.rotation.set(0, 0, (pl.rot * Math.PI) / 180)
      // Notches show as a faint column down to their depth.
      if (def.notch) node.obj.scale.set(1, 1, Math.max(0.1, e.sink / 10))
    }
    for (const [uid, node] of v.nodes)
      if (!seen.has(uid)) {
        v.items.remove(node.obj)
        v.nodes.delete(uid)
      }

    // Ring round the selection.
    const sel = layout.items.find((i) => i.uid === selected)
    const se = sel && ev.items.find((x) => x.uid === sel.uid)
    if (sel && se) {
      const r = Math.hypot(se.posed.w, se.posed.d) / 2 + 10
      v.ring.userData.radius = r
      v.ring.position.set(sel.x, sel.y, ev.foamTop + 0.6)
      v.ring.rotation.set(0, 0, (sel.rot * Math.PI) / 180)
      const [band, grip, dot] = [v.ring.children[0], v.ring.children[1], v.ring.children[2]]
      grip.position.set(r + 1, 0, 0)
      dot.position.set(r + 1, 0, 0.01)
      // Resizable items get corner chevrons; round ones look the same at any turn, so no ring.
      const axes = resizeAxes(se.def, sel.pose)
      band.visible = grip.visible = dot.visible = !(axes && 'round' in axes)
      v.handles.visible = !!axes
      v.handles.userData = { w: se.posed.w, d: se.posed.d }
      v.ring.visible = true
    } else v.ring.visible = false
  }, [layout, ev, selected])

  useImperativeHandle(
    ref,
    () => ({
      pick(cx, cy) {
        const v = s3.current
        if (!v) return null
        const r = v.renderer.domElement.getBoundingClientRect()
        if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return null
        const ray = new THREE.Raycaster()
        ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), live.current.view === '2d' ? v.ortho : v.persp)
        const p = new THREE.Vector3()
        return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -live.current.ev.foamTop), p) ? { x: Math.round(p.x * 2) / 2, y: Math.round(p.y * 2) / 2 } : null
      },
      ghost(g) {
        const v = s3.current
        if (!v) return
        const cur = v.ghost.children[0]
        if (!g) {
          if (cur) v.ghost.remove(cur)
          return
        }
        const def = getItem(g.item)
        if (!def) return
        if (!cur || cur.userData.item !== g.item) {
          if (cur) v.ghost.remove(cur)
          const obj = posed(def, 0, itemParams(def)).object.clone()
          obj.userData.item = g.item
          v.ghost.add(obj)
        }
        const p = posed(def, 0, itemParams(def))
        const sink = def.notch ? 10 : Math.min(live.current.ev.maxDepth, Math.max(1, (def.poses[0].sink ? def.poses[0].sink(p.height) : p.height) + live.current.ev.depthShift))
        v.ghost.children[0].position.set(g.x, g.y, live.current.ev.foamTop - sink + 0.5)
      },
    }),
    [],
  )

  return <div ref={hostRef} className="c3d-viewer sys-viewer" />
}
