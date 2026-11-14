// Shaper's branding as printed on their tools: the SHAPER wordmark, drawn in the app's Forma face
// (tokens.css), whose A is Shaper's open triangle, and the round logo mark from
// public/images/shaper-mark.svg (taken from shapertools.com's header logo).
import type * as THREE from 'three'

export const FORMA_FONT = '"Forma Studio", "Helvetica Neue", Helvetica, Arial, sans-serif'
const PROBE = '100px "Forma Studio"'

/** SHAPER fitted to `w` wide, its caps centred on (x, y), in the context's current units. */
export function shaperWordmark(g: CanvasRenderingContext2D, x: number, y: number, w: number) {
  g.font = `400 100px ${FORMA_FONT}`
  const m = g.measureText('SHAPER')
  const size = (100 * w) / m.width
  const cap = (m.actualBoundingBoxAscent * size) / 100
  g.font = `400 ${size}px ${FORMA_FONT}`
  g.textBaseline = 'alphabetic'
  g.textAlign = 'center'
  g.fillText('SHAPER', x, y + cap / 2)
}

const formaReady = () => typeof document === 'undefined' || document.fonts.check(PROBE)

/** Resolves once the Forma face can be drawn (or failed to load, so the fallback stays). */
export function formaLoaded(): Promise<void> {
  if (formaReady()) return Promise.resolve()
  return document.fonts.load(PROBE, 'SHAPER').then(
    () => {},
    () => {},
  )
}

/**
 * If the Forma face isn't loaded yet (a canvas would have drawn the fallback), repaint once it is and
 * flag the textures for upload; the viewers render continuously, so they pick it up.
 */
export function whenFormaLoads(repaint: () => void, ...textures: THREE.Texture[]) {
  if (formaReady()) return
  formaLoaded().then(() => {
    repaint()
    for (const t of textures) t.needsUpdate = true
  })
}

/** The logo mark's paths and its SVG viewBox (the disc's bounds). */
export interface ShaperMark {
  paths: { path: Path2D; rule: CanvasFillRule }[]
  box: [x: number, y: number, w: number, h: number]
}

const MARK_URL = '/images/shaper-mark.svg'
let markLoaded: ShaperMark | null = null
let markLoading: Promise<ShaperMark | null> | null = null

/** The logo mark, fetched and parsed once; null where it can't be (no DOM, or the fetch failed). */
export function loadShaperMark(): Promise<ShaperMark | null> {
  if (markLoading) return markLoading
  if (typeof document === 'undefined' || typeof Path2D === 'undefined') return Promise.resolve(null)
  markLoading = fetch(MARK_URL)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${MARK_URL}: ${r.status}`))))
    .then((txt) => {
      const svg = new DOMParser().parseFromString(txt, 'image/svg+xml').documentElement
      const box = (svg.getAttribute('viewBox') ?? '0 0 1 1').split(/[\s,]+/).map(Number) as ShaperMark['box']
      const paths = [...svg.querySelectorAll('path')].map((p) => ({
        path: new Path2D(p.getAttribute('d') ?? ''),
        rule: (p.getAttribute('fill-rule') === 'evenodd' ? 'evenodd' : 'nonzero') as CanvasFillRule,
      }))
      markLoaded = { paths, box }
      return markLoaded
    })
    .catch(() => null)
  return markLoading
}

/** The mark if it has already loaded, for drawing straight away. */
export const shaperMarkNow = (): ShaperMark | null => markLoaded

/**
 * The logo mark `d` across, centred on (x, y) in canvas pixels, upright, in the current fill style.
 */
export function drawShaperMark(g: CanvasRenderingContext2D, mark: ShaperMark, x: number, y: number, d: number) {
  const [bx, by, bw, bh] = mark.box
  const k = d / bw
  g.save()
  g.transform(k, 0, 0, k, x - (bx + bw / 2) * k, y - (by + bh / 2) * k)
  for (const { path, rule } of mark.paths) g.fill(path, rule)
  g.restore()
}
