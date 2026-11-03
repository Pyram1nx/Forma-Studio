// Catalogue tile pictures: each item rendered once, in its first pose, by one shared offscreen
// renderer (a WebGL context per tile would run out fast), and cached as a data URL.
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { ItemDef } from './catalog'
import { itemParams } from './catalog'
import { posed } from './layout'

let shared: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; env: THREE.Texture } | null = null
const cache = new Map<string, string>()

function setup(size: number) {
  if (!shared) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(1)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    const scene = new THREE.Scene()
    const pmrem = new THREE.PMREMGenerator(renderer)
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    scene.environment = env
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.8))
    const sun = new THREE.DirectionalLight(0xffffff, 1.6)
    sun.position.set(-1, -2, 3)
    scene.add(sun)
    const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100000)
    camera.up.set(0, 0, 1)
    shared = { renderer, scene, camera, env }
  }
  shared.renderer.setSize(size, size, false)
  return shared
}

export function itemThumb(def: ItemDef, size = 96): string {
  const hit = cache.get(def.id)
  if (hit) return hit
  const { renderer, scene, camera } = setup(size * 2)
  const p = posed(def, 0, itemParams(def))
  const obj = p.object.clone()
  scene.add(obj)
  const sphere = new THREE.Box3().setFromObject(obj).getBoundingSphere(new THREE.Sphere())
  const r = Math.max(sphere.radius, 1)
  const dist = r / Math.sin(((camera.fov / 2) * Math.PI) / 180)
  const dir = new THREE.Vector3(-0.55, -1, 0.9).normalize()
  camera.position.copy(sphere.center).addScaledVector(dir, dist * 1.02)
  camera.near = dist / 50
  camera.far = dist * 10
  camera.lookAt(sphere.center)
  camera.updateProjectionMatrix()
  renderer.render(scene, camera)
  const url = renderer.domElement.toDataURL('image/png')
  scene.remove(obj)
  cache.set(def.id, url)
  return url
}
