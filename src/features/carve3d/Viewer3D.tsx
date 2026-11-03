// three.js preview: the finished carved piece (a wood height map cut with the bit's real profile,
// with dark cut lines at every layer floor), the uncut model (ghosted over the wood), a translucent stock box, and the real slice
// outlines of every layer. Effects are split so that each piece is rebuilt only when its own
// inputs change, and the camera is framed only when a new model arrives.
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Contour } from '../../model/types'
import type { Vec3 } from './loadModel'
import type { CarvedSurface } from './finishedSurface'
import { createHeightfield, createHeightfieldGeometry, floorClip, worldRect } from './heightfield'
import type { CarvePlan } from './carvePlan'
import { CarveAnimation } from './carveAnimation'
import { dimLayout, type DimAxis } from './dimGuides'
import { COLORS, hexNum, paintBackdrop } from '../../ui/colors'
import { useIsDark } from '../../state/theme'

/** One layer's real outlines. `z` is world height; contours are design space (y down). */
export interface LayerOutline {
  z: number
  guide: Contour[]
  toolpath: Contour[]
}

/** Cutting animation controls. A new `run` (or a new plan) restarts it from uncut stock. */
export interface AnimState {
  on: boolean
  playing: boolean
  /** Feed multiplier (1 = 150 mm/s). */
  speed: number
  run: number
}

/** Which parts of the preview are visible. */
export interface CarveView {
  /** The finished part: every side's carve applied to the block. */
  finished: boolean
  /** The selected stage's carve alone, on uncut stock. */
  carved: boolean
  model: boolean
  layers: boolean
  /** Width / length / height measurement guides. */
  dims: boolean
}

export interface Viewer3DProps {
  positions: Float32Array
  /** Model size in mm (Z up, min Z = 0). */
  modelSize: Vec3
  /** Stock box: x/y footprint incl. margin, z = stock thickness (top at `stockTop`). */
  stockSize: Vec3
  /** z of the stock top, mm. Default: the model top. */
  stockTop?: number
  outlines: LayerOutline[]
  /** Finished-piece height map. null until a plan has been carved. */
  surface: CarvedSurface | null
  /** The whole job's finished part, in this view's frame. null until it has been built. */
  part?: { positions: Float32Array; indices: Uint32Array } | null
  show: CarveView
  /** Plan the animation cuts (with plan.bit). */
  plan: CarvePlan | null
  anim: AnimState
  onAnimProgress?: (fraction: number) => void
  onAnimComplete?: () => void
  /** Formatted model width, length and height for the measurement guides. */
  dimLabels: Record<DimAxis, string>
}

/** Materials shared by every band or line of a kind; owned by the viewer and disposed on unmount. */
interface CarveMaterials {
  woodTex: THREE.CanvasTexture
  /** Top surface and stock edge; clips away material cut down to the floor. */
  woodCut: THREE.MeshStandardMaterial
  woodBottom: THREE.MeshStandardMaterial
  /** The finished part: no floor clip, the mesh is the whole solid. */
  woodPart: THREE.MeshStandardMaterial
  cutMat: THREE.LineBasicMaterial
  modelMat: THREE.MeshStandardMaterial
  dimLine: THREE.LineBasicMaterial
  dimArrow: THREE.MeshBasicMaterial
}

interface ViewState {
  renderer: THREE.WebGLRenderer
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  model: THREE.Group
  carved: THREE.Group
  part: THREE.Group
  anim: THREE.Group
  dims: THREE.Group
  stock: THREE.Group
  layers: THREE.Group
  grid: THREE.GridHelper
  background: THREE.Color
  mats: CarveMaterials
}

function disposeChildren(group: THREE.Group) {
  for (const child of [...group.children]) {
    child.traverse((o) => {
      const obj = o as THREE.Mesh
      obj.geometry?.dispose()
      const mat = obj.material
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else mat?.dispose()
    })
    group.remove(child)
  }
}

/** Frees geometry only, for groups whose materials are shared and owned by the viewer. */
function disposeGeometry(group: THREE.Group) {
  for (const child of [...group.children]) {
    child.traverse((o) => (o as THREE.Mesh).geometry?.dispose())
    group.remove(child)
  }
}

/** Design-space point (x, y down) to world (x, Y up). */
const toWorld = (p: { x: number; y: number }, z: number) => new THREE.Vector3(p.x, -p.y, z)

/**
 * Procedural light-wood texture, one tile per 120 mm (height-map UVs are in mm). Grain
 * streaks wrap across the tile edges; the growth rings are faint enough that their edges don't show.
 */
function makeWoodTexture(): THREE.CanvasTexture {
  const S = 512
  const canvas = document.createElement('canvas')
  canvas.width = S
  canvas.height = S
  const g = canvas.getContext('2d')
  if (g) {
    g.fillStyle = COLORS.wood
    g.fillRect(0, 0, S, S)
    // Fixed seed so the grain is the same on every load.
    let seed = 1234567
    const rnd = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    const wraps = [-S, 0, S]
    for (let i = 0; i < 220; i++) {
      const y0 = rnd() * S
      const k = 1 + Math.floor(rnd() * 3) // whole periods across the tile keep it seamless
      const amp = 1.5 + rnd() * 5
      const phase = rnd() * Math.PI * 2
      g.strokeStyle = `rgba(120, 75, 35, ${(0.04 + rnd() * 0.12).toFixed(3)})`
      g.lineWidth = 0.5 + rnd() * 1.5
      for (const dy of wraps) {
        g.beginPath()
        for (let x = 0; x <= S; x += 4) {
          const y = y0 + dy + Math.sin((x / S) * k * Math.PI * 2 + phase) * amp
          if (x === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        }
        g.stroke()
      }
    }
    // Growth rings: concentric arcs centred above the tile.
    g.lineWidth = 1
    g.strokeStyle = 'rgba(120, 75, 35, 0.08)'
    const cx = S * 0.45
    const cy = -S * 0.8
    for (let r = S * 0.7; r < S * 3; r += 28 + rnd() * 22) {
      for (const dx of wraps) {
        for (const dy of wraps) {
          g.beginPath()
          g.arc(cx + dx, cy + dy, r, 0, Math.PI * 2)
          g.stroke()
        }
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.repeat.set(1 / 120, 1 / 120)
  return tex
}

export default function Viewer3D({ positions, modelSize, stockSize, stockTop, outlines, surface, part, show, plan, anim, onAnimProgress, onAnimComplete, dimLabels }: Viewer3DProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<ViewState | null>(null)
  const dark = useIsDark()
  const sizeRef = useRef(modelSize)
  const framedRef = useRef<Float32Array | null>(null)
  const animRef = useRef<CarveAnimation | null>(null)
  const stockRef = useRef(stockSize)
  const labelRefs = useRef<Record<DimAxis, HTMLSpanElement | null>>({ x: null, y: null, z: null })
  // Latest callbacks, so a re-render does not restart the animation.
  const progressRef = useRef(onAnimProgress)
  const completeRef = useRef(onAnimComplete)
  useEffect(() => {
    progressRef.current = onAnimProgress
    completeRef.current = onAnimComplete
  })

  // Renderer, camera, controls, groups, shared materials. Created once; disposed on unmount.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.localClippingEnabled = true // the wood's floor clip (through-cuts)
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const background = new THREE.Color(COLORS.gray50)
    scene.background = background
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100000)
    camera.up.set(0, 0, 1) // CAD convention: Z up
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    scene.add(new THREE.AmbientLight(0xffffff, 0.5))
    scene.add(new THREE.HemisphereLight(0xffffff, hexNum(COLORS.ground), 1.0))
    const sun = new THREE.DirectionalLight(0xffffff, 1.4)
    sun.position.set(-1, -2, 3)
    scene.add(sun)

    const grid = new THREE.GridHelper(2000, 100, hexNum(COLORS.gray200), hexNum(COLORS.gridMinor))
    grid.rotation.x = Math.PI / 2 // lie in the XY plane
    scene.add(grid)

    const model = new THREE.Group()
    const carved = new THREE.Group()
    const partGroup = new THREE.Group()
    const animGroup = new THREE.Group()
    const dims = new THREE.Group()
    const stock = new THREE.Group()
    const layers = new THREE.Group()
    scene.add(model, carved, partGroup, animGroup, stock, layers, dims)

    // Polygon offset pushes the solid back so the cut lines on its edges win the depth test.
    const solidOffset = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }
    const woodTex = makeWoodTexture()
    const mats: CarveMaterials = {
      woodTex,
      woodCut: new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.75, ...solidOffset }),
      woodBottom: new THREE.MeshStandardMaterial({ map: woodTex, color: 0xe0c8a8, roughness: 0.85, ...solidOffset }),
      woodPart: new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.75 }),
      cutMat: new THREE.LineBasicMaterial({ color: hexNum(COLORS.cutLine) }),
      modelMat: new THREE.MeshStandardMaterial({ color: COLORS.meshGrey, roughness: 0.6, metalness: 0, side: THREE.DoubleSide }),
      // Guides draw over everything: they annotate the piece and must never hide behind it.
      dimLine: new THREE.LineBasicMaterial({ color: COLORS.blue050, depthTest: false, depthWrite: false, transparent: true }),
      dimArrow: new THREE.MeshBasicMaterial({ color: COLORS.blue050, depthTest: false, depthWrite: false, transparent: true }),
    }

    // Measurement guides follow the camera: rebuilt only when they move to other edges (or the
    // sizes change); the labels are re-projected every frame.
    let dimKey = ''
    const proj = new THREE.Vector3()
    const updateDims = () => {
      const labels = labelRefs.current
      if (!dims.visible) {
        for (const ax of ['x', 'y', 'z'] as const) if (labels[ax]) labels[ax]!.style.display = 'none'
        return
      }
      const layout = dimLayout(sizeRef.current, stockRef.current, camera.position)
      if (layout.key !== dimKey) {
        dimKey = layout.key
        buildDims(dims, layout, mats.dimLine, mats.dimArrow)
      }
      const w = host.clientWidth
      const h = host.clientHeight
      for (const g of layout.guides) {
        const el = labels[g.axis]
        if (!el) continue
        proj.set(g.label.x, g.label.y, g.label.z).project(camera)
        const visible = proj.z > -1 && proj.z < 1
        el.style.display = visible ? '' : 'none'
        if (visible) el.style.transform = `translate(${((proj.x + 1) / 2) * w}px, ${((1 - proj.y) / 2) * h}px) translate(-50%, -50%)`
      }
    }

    const ro = new ResizeObserver(() => {
      const w = Math.max(1, host.clientWidth)
      const h = Math.max(1, host.clientHeight)
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    })
    ro.observe(host)

    const timer = new THREE.Timer()
    renderer.setAnimationLoop(() => {
      timer.update()
      const dt = timer.getDelta()
      animRef.current?.update(dt)
      controls.update()
      updateDims()
      renderer.render(scene, camera)
    })
    viewRef.current = { renderer, camera, controls, model, carved, part: partGroup, anim: animGroup, dims, stock, layers, grid, background, mats }

    return () => {
      viewRef.current = null
      framedRef.current = null
      ro.disconnect()
      renderer.setAnimationLoop(null)
      disposeGeometry(model)
      disposeGeometry(dims)
      disposeGeometry(carved) // the animation disposes itself in its own effect
      disposeGeometry(partGroup)
      disposeChildren(stock)
      disposeChildren(layers)
      for (const m of Object.values(mats)) m.dispose()
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

  // Latest model size for the camera framing below (kept out of render).
  useEffect(() => {
    sizeRef.current = modelSize
    stockRef.current = stockSize
  })

  // Model geometry: only when the placed positions change. Frames the camera on a new model.
  useEffect(() => {
    const v = viewRef.current
    if (!v) return
    disposeGeometry(v.model)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.computeVertexNormals()
    v.model.add(new THREE.Mesh(geo, v.mats.modelMat))

    if (framedRef.current !== positions) {
      framedRef.current = positions
      const size = sizeRef.current
      const r = Math.max(size.x, size.y, size.z, 10)
      const target = new THREE.Vector3(0, 0, size.z / 2)
      v.controls.target.copy(target)
      // A little wider than the model alone, so the measurement guides outside the stock fit too.
      const k = 1.3
      v.camera.position.set(target.x + r * 1.1 * k, target.y - r * 1.6 * k, target.z + r * 1.2 * k)
      v.camera.near = r / 100
      v.camera.far = r * 100
      v.camera.updateProjectionMatrix()
      v.controls.update()
    }
  }, [positions])

  // Carved solid: the height map as one mesh, plus the cut lines above every layer floor.
  useEffect(() => {
    const v = viewRef.current
    if (!v) return
    disposeGeometry(v.carved)
    if (!surface) return
    v.mats.woodCut.clippingPlanes = [floorClip(surface.hf)]
    v.carved.add(new THREE.Mesh(createHeightfieldGeometry(surface.hf), [v.mats.woodCut, v.mats.woodBottom]))
    if (surface.cutLines.length) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(surface.cutLines, 3))
      v.carved.add(new THREE.LineSegments(geo, v.mats.cutMat))
    }
  }, [surface])

  // Finished part: indexed mesh, smooth normals, wood grain projected along each vertex's
  // dominant normal axis (the part has no height-map UVs).
  useEffect(() => {
    const v = viewRef.current
    if (!v) return
    disposeGeometry(v.part)
    if (!part || !part.indices.length) return
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(part.positions, 3))
    geo.setIndex(new THREE.BufferAttribute(part.indices, 1))
    geo.computeVertexNormals()
    const p = part.positions
    const nrm = geo.getAttribute('normal').array as Float32Array
    const uv = new Float32Array((p.length / 3) * 2)
    for (let i = 0, t = 0; i < p.length; i += 3, t += 2) {
      const ax = Math.abs(nrm[i])
      const ay = Math.abs(nrm[i + 1])
      const az = Math.abs(nrm[i + 2])
      if (az >= ax && az >= ay) uv.set([p[i], p[i + 1]], t)
      else if (ay >= ax) uv.set([p[i], p[i + 2]], t)
      else uv.set([p[i + 1], p[i + 2]], t)
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    v.part.add(new THREE.Mesh(geo, v.mats.woodPart))
  }, [part])

  // Animation: a fresh run on uncut stock whenever it is switched on, restarted, or the plan
  // changes. It shares the wood materials with the finished surface (same stock, same floor).
  const animOn = anim.on
  const animRun = anim.run
  useEffect(() => {
    const v = viewRef.current
    if (!v || !animOn || !plan) return
    const hf = createHeightfield(worldRect(plan.stock), plan.modelH, plan.modelH - Math.max(plan.stockThickness, plan.carveDepth, plan.throughDepth), 160_000)
    v.mats.woodCut.clippingPlanes = [floorClip(hf)]
    const a = new CarveAnimation({ parent: v.anim, plan, bit: plan.bit, hf, solidMaterials: [v.mats.woodCut, v.mats.woodBottom] })
    a.onProgress = (f) => progressRef.current?.(f)
    a.onComplete = () => completeRef.current?.()
    animRef.current = a
    return () => {
      a.dispose()
      if (animRef.current === a) animRef.current = null
    }
  }, [animOn, animRun, plan])

  const animPlaying = anim.playing
  const animSpeed = anim.speed
  useEffect(() => {
    const a = animRef.current
    if (!a) return
    a.setSpeed(animSpeed)
    if (animPlaying) a.play()
    else a.pause()
  }, [animPlaying, animSpeed, animOn, animRun, plan])

  // Visibility only: no geometry is rebuilt here. The carved solid replaces the stock box, and the
  // model ghosts over it when both are shown.
  const showFinished = show.finished
  const showCarved = show.carved
  const showModel = show.model
  const showLayers = show.layers
  const showDims = show.dims
  const hasSurface = !!surface
  const hasPart = !!part && part.indices.length > 0
  useEffect(() => {
    const v = viewRef.current
    if (!v) return
    const partOn = showFinished && hasPart && !animOn
    const carvedOn = showCarved && hasSurface && !animOn && !partOn
    const solidOn = partOn || carvedOn
    const modelOn = animOn ? showModel : showModel || !solidOn
    const ghost = (solidOn || animOn) && modelOn
    v.part.visible = partOn
    v.carved.visible = carvedOn
    v.model.visible = modelOn
    v.layers.visible = showLayers
    v.dims.visible = showDims
    v.anim.visible = animOn
    v.stock.visible = !solidOn && !animOn
    const m = v.mats.modelMat
    m.transparent = ghost
    m.opacity = ghost ? 0.35 : 1
    m.depthWrite = !ghost
  }, [showFinished, showCarved, showModel, showLayers, showDims, hasSurface, hasPart, animOn])

  // Stock box: translucent, from (top − T) to top.
  const { x: sx, y: sy, z: sz } = stockSize
  const modelZ = stockTop ?? modelSize.z
  useEffect(() => {
    const v = viewRef.current
    if (!v) return
    disposeChildren(v.stock)
    const geo = new THREE.BoxGeometry(sx, sy, Math.max(sz, 0.01))
    const pos = new THREE.Vector3(0, 0, modelZ - sz / 2)
    const fill = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: COLORS.blue050, transparent: true, opacity: 0.06, depthWrite: false }),
    )
    fill.position.copy(pos)
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: COLORS.gray400 }))
    edges.position.copy(pos)
    v.stock.add(fill, edges)
  }, [sx, sy, sz, modelZ])

  // Layer outlines: the real slice contours (blue) and centre paths (green) at their heights.
  useEffect(() => {
    const v = viewRef.current
    if (!v) return
    disposeChildren(v.layers)
    const guideMat = new THREE.LineBasicMaterial({ color: COLORS.blue050 })
    const pathMat = new THREE.LineBasicMaterial({ color: COLORS.cutGreen })
    for (const layer of outlines) {
      for (const c of layer.guide) addLoop(v.layers, c, layer.z, guideMat)
      for (const c of layer.toolpath) addLoop(v.layers, c, layer.z, pathMat)
    }
  }, [outlines])

  return (
    <>
      <div ref={hostRef} className="c3d-viewer" />
      <div className="c3d-dims" aria-hidden="true">
        {(['x', 'y', 'z'] as const).map((ax) => (
          <span
            key={ax}
            ref={(el) => {
              labelRefs.current[ax] = el
            }}
            className="c3d-dims__label"
          >
            {dimLabels[ax]}
          </span>
        ))}
      </div>
    </>
  )
}

function addLoop(group: THREE.Group, c: Contour, z: number, mat: THREE.Material) {
  if (c.pts.length < 2) return
  const pts = c.pts.map((p) => toWorld(p, z))
  const geo = new THREE.BufferGeometry().setFromPoints(pts)
  group.add(c.closed ? new THREE.LineLoop(geo, mat) : new THREE.Line(geo, mat))
}

/** Guide lines, extension lines and arrowheads for a layout (replaces the group's contents). */
function buildDims(group: THREE.Group, layout: ReturnType<typeof dimLayout>, lineMat: THREE.Material, arrowMat: THREE.Material) {
  disposeGeometry(group)
  const pts: number[] = []
  for (const g of layout.guides) {
    pts.push(g.a.x, g.a.y, g.a.z, g.b.x, g.b.y, g.b.z)
    for (const [p, q] of g.ext) pts.push(p.x, p.y, p.z, q.x, q.y, q.z)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  const lines = new THREE.LineSegments(geo, lineMat)
  lines.renderOrder = 10
  group.add(lines)

  // Arrowheads: one cone per guide end, tip on the end, pointing outward along the guide.
  const L = layout.arrow
  const up = new THREE.Vector3(0, 1, 0)
  for (const g of layout.guides) {
    const a = new THREE.Vector3(g.a.x, g.a.y, g.a.z)
    const b = new THREE.Vector3(g.b.x, g.b.y, g.b.z)
    const len = a.distanceTo(b)
    const size = Math.min(L, len / 4)
    if (!(size > 0)) continue
    for (const [tip, from] of [[a, b], [b, a]]) {
      const cone = new THREE.ConeGeometry(size * 0.32, size, 12)
      cone.translate(0, -size / 2, 0) // tip at the origin, body along −Y
      const m = new THREE.Mesh(cone, arrowMat)
      m.position.copy(tip)
      m.quaternion.setFromUnitVectors(up, tip.clone().sub(from).normalize())
      m.renderOrder = 10
      group.add(m)
    }
  }
}
