// Small still renders of a mesh for the layer / side tiles over the 3D view. One offscreen
// renderer is shared by every tile (a WebGL context per tile would run out fast); each render
// is read back as a data URL and the scene is cleared again.
import * as THREE from 'three'
import { COLORS } from '../../ui/colors'

let shared: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera } | null = null

function setup(size: number) {
  if (!shared) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(1)
    const scene = new THREE.Scene()
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 0.9))
    const sun = new THREE.DirectionalLight(0xffffff, 1.5)
    sun.position.set(-1, -2, 3)
    scene.add(sun)
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100000)
    camera.up.set(0, 0, 1)
    shared = { renderer, scene, camera }
  }
  shared.renderer.setSize(size, size, false)
  return shared
}

/**
 * Render a mesh (triangle soup, or indexed with `indices`) from the 3D view's usual angle,
 * framed to fit. `finished` shades it as wood, otherwise as the grey model.
 */
export function renderThumbnail(positions: Float32Array, indices: Uint32Array | null, finished: boolean, size = 128): string {
  if (positions.length < 9) return ''
  const { renderer, scene, camera } = setup(size * 2)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (indices) geo.setIndex(new THREE.BufferAttribute(indices, 1))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  const mat = new THREE.MeshStandardMaterial({ color: finished ? 0xc99a64 : COLORS.meshGrey, roughness: 0.75, side: THREE.DoubleSide })
  const mesh = new THREE.Mesh(geo, mat)
  scene.add(mesh)
  const s = geo.boundingSphere!
  const r = Math.max(s.radius, 1)
  const dir = new THREE.Vector3(1.1, -1.6, 1.2).normalize()
  const dist = r / Math.sin(((camera.fov / 2) * Math.PI) / 180)
  camera.position.copy(s.center).addScaledVector(dir, dist * 1.02)
  camera.near = dist / 100
  camera.far = dist * 10
  camera.lookAt(s.center)
  camera.updateProjectionMatrix()
  renderer.render(scene, camera)
  const url = renderer.domElement.toDataURL('image/png')
  scene.remove(mesh)
  geo.dispose()
  mat.dispose()
  return url
}

/** Free the shared renderer (when the 3D Carve dialog closes). */
export function disposeThumbnails() {
  if (!shared) return
  shared.renderer.dispose()
  shared.renderer.forceContextLoss()
  shared = null
}
