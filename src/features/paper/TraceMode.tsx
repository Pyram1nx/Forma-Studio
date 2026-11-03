// Trace: photograph a sheet of paper with pen or pencil drawings, frame the
// sheet, and the drawing is vectorised into real-millimetre geometry.
//
// One screen, no step timeline:
//   pick     choose regular paper or a Shaper Trace frame, then a photo
//   detect   the photo shows while the page finder runs. Once the sheet is
//            found (its size read from its perspective-corrected proportions)
//            a line swipes across the photo and cuts away everything that is
//            not paper; vectorising starts in the background as it does
//   frame    only when no sheet was found: drag the corners by hand
//   flatten  when both the cut and the vectors are done, the cut-out paper
//            flattens from its photographed shape into a rectangle and zooms
//            to fill the stage
//   working  on the flat paper ("Converting to vectors" if still busy), the
//            same line swipes once more like a before/after slider, revealing
//            the vectors
//   result   Outline / Centerline display, Edit Scan, Modify and Confirm. The
//            sub-modes share a header dropdown: Modify Vector (pick the groups
//            to keep), Adjust Scan (ink detail) and Paper Outline (fix the
//            sheet's corners and size by hand, then rescan)
//
// Ink extraction is fully automatic: lighting is normalised, shadows are
// divided out, and hysteresis keeps sensor noise and paper texture out of the
// mask (see ink.ts). Reuses the shared full-screen mode layout (modeview).
//
// "Any image" skips the sheet entirely: the whole picture (a logo, artwork, a
// screenshot, a photo) goes straight to working, split into design and
// background by imageMask.ts. It has no real size, so it starts at
// IMAGE_LONG_MM and Resize (in place of Paper Outline) scales the traced design
// to the size it should be.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, JSX, PointerEvent, ReactNode } from 'react'
import { MM_PER_IN, type Contour, type ImportPayload, type Pt, type Shape, type Units } from '../../model/types'
import { newShapeCut } from '../../state/prefs'
import { fmtLen, fromUnits, shapeFromWorld } from '../../model/factory'
import { COLORS } from '../../ui/colors'
import * as Ic from '../../ui/icons'
import { detectPaper, insetQuad, isSimpleQuad, type DetectResult } from './detect'
import { Detector } from './detectClient'
import { computeHomography, warpPerspective } from './homography'
import { grayFromImageData } from './ink'
import { estimateAspect, guessPaper, PRESETS, TRACE_FRAME, type PaperPreset, type SheetKind } from './paperSize'
import { CancelledError, cancelPaperJobs, runImageMask, runInk, runVector } from './pipeline'
import { captureFromTrack, defaultTrack, traceFrameFromTrack } from './traceDots'
import type { VectorMode, VectorResult } from './trace'
import TraceIntro from './TraceIntro'
import './trace.css'

export interface TraceModeProps {
  units: Units
  onClose: () => void
  onImport: (p: ImportPayload) => void
}

/** Longest side of the photo kept in memory (px). */
const MAX_PHOTO_SIDE = 3000

/** Corner handles move at this fraction of the cursor in Edit Scan, for precision. */
const EDIT_DRAG_GAIN = 0.4

/** Default edge margin (mm): ink this close to the sheet edge is ignored. */
const MARGIN_MM = 3

/** Radius (px) of the thumb-sized brush used to remove / select parts. */
const BRUSH_PX = 32

/** Duration (ms) of the single eased swipe that reveals the vectors. */
const SWEEP_MS = 1400

/** Duration (ms) of the paper flattening out and zooming to fit. */
const FLATTEN_MS = 950

/** Remembers the last sheet kind between sessions. */
const SHEET_KEY = 'forma.trace.sheet'

function loadSheet(): SheetKind {
  try {
    const v = localStorage.getItem(SHEET_KEY)
    return v === 'trace' || v === 'image' ? v : 'paper'
  } catch {
    return 'paper'
  }
}

/** Any image: long side (mm) it is traced at until Resize says otherwise. */
const IMAGE_LONG_MM: Record<Units, number> = { mm: 150, in: 6 * MM_PER_IN }

/**
 * Any image: long side (px) of the copy that is traced. Small images are
 * scaled up (smoothly, so their edges trace as curves rather than pixel
 * steps); big ones down, to keep tracing quick.
 */
const IMAGE_MIN_SIDE = 1200
const IMAGE_MAX_SIDE = 2000


/** The flattened paper plus the scale it was made at. */
interface ScanImage {
  img: ImageData
  ppmX: number
  ppmY: number
  wMm: number
  hMm: number
  label: string
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Copy a (possibly downscaled) image source into a new canvas (long side <= MAX_PHOTO_SIDE). */
function canvasFromSource(src: CanvasImageSource, sw: number, sh: number): HTMLCanvasElement {
  const k = Math.min(1, MAX_PHOTO_SIDE / Math.max(sw, sh))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(sw * k))
  c.height = Math.max(1, Math.round(sh * k))
  const ctx = c.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(src, 0, 0, c.width, c.height)
  }
  return c

}

/** Natural size of an image file as the browser decodes it (EXIF orientation applied). */
function imageFileSize(file: File): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('decode failed'))
    }
    img.src = url
  })
}

/** Vectors (mm) scaled about the sheet's top-left corner. */
function scaleVector(v: VectorResult, f: number): VectorResult {
  return {
    ...v,
    groups: v.groups.map((g) => g.map((c) => ({ ...c, pts: c.pts.map((p) => ({ x: p.x * f, y: p.y * f })) }))),
    strokeWidthMm: Math.round(v.strokeWidthMm * f * 100) / 100,
  }
}

/** Shape objects in ImportPayload carry no id. */
function withoutId(s: Shape): Omit<Shape, 'id'> {
  const out: Partial<Shape> = { ...s }
  delete out.id
  return out as Omit<Shape, 'id'>
}

/** Centerlines are open paths and stay On Line; outlines are closed and take the preset cut type. */
function cutFor(type: 'online' | 'outside') {
  return type === 'online' ? newShapeCut('online') : newShapeCut()
}

/** Preset size in the document units: inches to 2 decimals (A4 8.27 in), mm to 1 decimal (A4 210 mm). */
function fmtPaperSize(mm: number, units: Units): string {
  if (units === 'in') return (mm / MM_PER_IN).toFixed(2)
  return Number.isInteger(mm) ? String(mm) : mm.toFixed(1)
}

/** Custom paper defaults: US Letter in inches, A4 in millimetres. */
const CUSTOM_DEFAULT: Record<Units, { w: number; h: number }> = {
  in: { w: 8.5, h: 11 },
  mm: { w: 210, h: 297 },
}

/** Sheet size in mm (and its label) for the current settings, oriented as requested. */
function paperDims(sheet: SheetKind, preset: PaperPreset, customW: number, customH: number, units: Units, landscape: boolean): PaperSize {
  let w: number
  let h: number
  let label = preset.label
  if (sheet === 'trace') {
    w = TRACE_FRAME.w
    h = TRACE_FRAME.h
    label = TRACE_FRAME.label
  } else if (preset.id === 'custom') {
    w = Math.max(10, fromUnits(customW, units))
    h = Math.max(10, fromUnits(customH, units))
  } else {
    w = preset.w
    h = preset.h
  }
  const long = Math.max(w, h)
  const short = Math.min(w, h)
  return landscape ? { w: long, h: short, label } : { w: short, h: long, label }
}

interface PaperSize {
  w: number
  h: number
  label: string
}

/** Same paper settings, i.e. Done in Paper Outline needs no rescan. */
interface OutlineSnap {
  quad: Pt[] | null
  track: Pt[] | null
  sheet: SheetKind
  presetId: string
  customW: number
  customH: number
  landscape: boolean
  ppm: number
}

/**
 * Largest size (px) with `aspect` that fits the stage's content box. The stage
 * is pinned to the canvas area (not sized by its content), so this never feeds
 * back into its own measurement.
 */
function useFit(aspect: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !aspect) return
    const measure = () => {
      const cs = getComputedStyle(el)
      const W = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const H = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      if (W <= 0 || H <= 0) return
      const w = Math.min(W, H * aspect)
      setSize({ w: Math.floor(w), h: Math.floor(w / aspect) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [aspect])
  return { ref, size }
}

const pathD = (c: Contour) =>
  c.pts.length < 2 ? '' : 'M' + c.pts.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('L') + (c.closed ? 'Z' : '')

/**
 * Vector contours drawn like a selected shape in the studio: closed loops get
 * the selection fill (even-odd, so holes stay open), open lines stroke only.
 */
function VecPaths({ groups, className = 'trace-path' }: { groups: Contour[][]; className?: string }) {
  let closed = ''
  let open = ''
  for (const g of groups)
    for (const c of g) {
      if (c.closed) closed += pathD(c)
      else open += pathD(c)
    }
  return (
    <>
      {closed && <path d={closed} fillRule="evenodd" className={className} />}
      {open && <path d={open} className={className + ' is-open'} />}
    </>
  )
}

/**
 * The flattened page rendered as pure black and white: luma threshold on the
 * lighting-normalised pixels, so shadows and paper tone vanish entirely.
 */
function bwCanvas(img: ImageData): HTMLCanvasElement {
  const n = img.width * img.height
  const lum = new Uint8Array(n)
  const hist = new Uint32Array(256)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const v = (img.data[j] * 77 + img.data[j + 1] * 150 + img.data[j + 2] * 29) >> 8
    lum[i] = v
    hist[v]++
  }
  // Paper level = 85th percentile; anything clearly darker than the paper is
  // ink. Relative, so dim photos and bright photos both read as pure B/W.
  let acc = 0
  let paper = 255
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= n * 0.85) {
      paper = Math.max(v, 1)
      break
    }
  }
  const cut = paper * 0.62
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d')
  if (ctx) {
    const out = ctx.createImageData(img.width, img.height)
    const d = out.data
    for (let i = 0, j = 0; j < d.length; i++, j += 4) {
      d[j] = d[j + 1] = d[j + 2] = lum[i] < cut ? 17 : 255
      d[j + 3] = 255
    }
    ctx.putImageData(out, 0, 0)
  }
  return c
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

type Size = { w: number; h: number }

/** Centred box with the image aspect ratio; children get its pixel size. `bare` drops the card look. */
function Stage({ aspect, bare, children }: { aspect: number; bare?: boolean; children: (size: Size) => ReactNode }) {
  const { ref, size } = useFit(aspect)
  return (
    <div className="trace-stage" ref={ref}>
      <div className={'trace-stage__inner' + (bare ? ' is-bare' : '')} style={{ width: size.w, height: size.h }}>
        {size.w > 0 && children(size)}
      </div>
    </div>
  )
}

/**
 * Paints a canvas (photo / preview) at its native resolution. Painted before
 * the browser paints, so a view that replaces another never flashes empty.
 */
function CanvasView({ src, className, style }: { src: HTMLCanvasElement; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const c = ref.current
    if (!c) return
    c.width = src.width
    c.height = src.height
    c.getContext('2d')?.drawImage(src, 0, 0)
  }, [src])
  return <canvas ref={ref} className={className} style={style} />
}

/** Motif size label: inches to 2 decimals (3.29 in), millimetres to 1 (83.6 mm). */
function fmtDim(mm: number, units: Units): string {
  return units === 'in' ? `${(mm / MM_PER_IN).toFixed(2)} in` : `${mm.toFixed(1)} mm`
}

type Box = { x0: number; y0: number; x1: number; y1: number }

/**
 * Thin outline around the traced motif with its width above and its height
 * down the right side. `box` is in mm on the sheet; `size` is the stage in px.
 */
function MotifDims({ box, scan, size, units, shown }: { box: Box; scan: ScanImage; size: Size; units: Units; shown: boolean }) {
  const pct = (v: number, of: number) => `${(v / of) * 100}%`
  // Too close to the sheet's right edge for the label outside: tuck it inside.
  const tight = ((scan.wMm - box.x1) / scan.wMm) * size.w < 28
  return (
    <div
      className={'trace-dims' + (shown ? ' is-in' : '')}
      style={{
        left: pct(box.x0, scan.wMm),
        top: pct(box.y0, scan.hMm),
        width: pct(box.x1 - box.x0, scan.wMm),
        height: pct(box.y1 - box.y0, scan.hMm),
      }}
      aria-label={`Traced size ${fmtDim(box.x1 - box.x0, units)} by ${fmtDim(box.y1 - box.y0, units)}`}
    >
      <span className="trace-dims__w">{fmtDim(box.x1 - box.x0, units)}</span>
      <span className={'trace-dims__h' + (tight ? ' is-inside' : '')}>{fmtDim(box.y1 - box.y0, units)}</span>
    </div>
  )
}

/** The confirm button's check: thick, round-ended, white on the blue disc. */
function CheckMark() {
  return (
    <svg viewBox="0 0 64 64" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19.8 32 27.5 39.6 44.2 23.4" />
    </svg>
  )
}

/** Contour points re-spaced to at most `step` mm apart, so smoothing acts evenly in mm. */
function resample(c: Contour, step: number): Pt[] {
  const out: Pt[] = []
  const n = c.pts.length
  const segs = c.closed ? n : n - 1
  for (let i = 0; i < segs; i++) {
    const a = c.pts[i]
    const b = c.pts[(i + 1) % n]
    const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step))
    for (let j = 0; j < k; j++) out.push({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k })
  }
  if (!c.closed) out.push(c.pts[n - 1])
  return out
}

/**
 * Smoothness 0-10: repeated 1-2-1 averaging of each contour's points. Open
 * lines keep their end points; closed loops wrap around.
 */
function smoothGroups(groups: Contour[][], level: number): Contour[][] {
  if (level <= 0) return groups
  const passes = level * level * 2
  return groups.map((g) =>
    g.map((c) => {
      if (c.pts.length < 3) return c
      let a = resample(c, 0.5)
      const n = a.length
      for (let k = 0; k < passes; k++) {
        const b = a.map((p, i) => {
          if (!c.closed && (i === 0 || i === n - 1)) return p
          const q = a[(i + n - 1) % n]
          const r = a[(i + 1) % n]
          return { x: 0.25 * q.x + 0.5 * p.x + 0.25 * r.x, y: 0.25 * q.y + 0.5 * p.y + 0.25 * r.y }
        })
        a = b
      }
      return { ...c, pts: a }
    }),
  )
}

function TraceSlider({ value, min, max, onChange, label, dots }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string; dots?: boolean }) {
  const frac = (value - min) / (max - min)
  return (
    <label className="trace-slider" style={{ ['--p' as string]: `${frac * 100}%` }}>
      <input type="range" min={min} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      {dots &&
        Array.from({ length: max - min + 1 }, (_, i) =>
          i + min === value ? null : <i key={i} className="trace-slider__dot" style={{ left: `calc(11px + (100% - 22px) * ${i / (max - min)})` }} />,
        )}
    </label>
  )
}

/** Magnifier: zoomed view of the photo around the point being dragged. */
function Loupe({ src, at }: { src: HTMLCanvasElement; at: Pt }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const L = c.width
    const region = 40 // photo px shown across the loupe
    ctx.clearRect(0, 0, L, L)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(src, at.x - region / 2, at.y - region / 2, region, region, 0, 0, L, L)
    ctx.strokeStyle = COLORS.blue050
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(L / 2, L / 2 - 14)
    ctx.lineTo(L / 2, L / 2 + 14)
    ctx.moveTo(L / 2 - 14, L / 2)
    ctx.lineTo(L / 2 + 14, L / 2)
    ctx.stroke()
  }, [src, at])
  return <canvas ref={ref} className="trace-loupe" width={320} height={320} />
}

/**
 * Draggable quadrilateral over the photo, in photo pixel coordinates. In edit
 * mode handles follow the cursor at a fraction of its speed (`gain`), which
 * makes precise reframing easy; the loupe shows what is under the handle.
 */
function QuadOverlay({
  quad,
  pw,
  ph,
  size,
  gain,
  onDrag,
  inner,
}: {
  quad: Pt[]
  pw: number
  ph: number
  size: Size
  gain: number
  onDrag: (index: number, p: Pt | null) => void
  /** Shaper Trace: `quad` is the dot track, `inner` the window that gets scanned. */
  inner?: Pt[]
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const dragging = useRef<{ index: number; cursor: Pt; start: Pt } | null>(null)
  const r = size.w > 0 ? (10 * pw) / size.w : 10

  const toPhoto = (clientX: number, clientY: number): Pt => {
    const box = svgRef.current!.getBoundingClientRect()
    return {
      x: clamp(((clientX - box.left) * pw) / box.width, 0, pw),
      y: clamp(((clientY - box.top) * ph) / box.height, 0, ph),
    }
  }

  const pts = quad.map((p) => `${p.x},${p.y}`).join(' ')
  const cut = inner ?? quad
  const shade = `M0 0H${pw}V${ph}H0Z M${cut.map((p) => `${p.x} ${p.y}`).join(' L')} Z`

  return (
    <svg
      ref={svgRef}
      className="trace-overlay"
      viewBox={`0 0 ${pw} ${ph}`}
      onPointerMove={(e) => {
        const d = dragging.current
        if (!d) return
        const p = toPhoto(e.clientX, e.clientY)
        // Precision mode: the handle travels at `gain` times the cursor's move.
        const moved = { x: (p.x - d.cursor.x) * gain, y: (p.y - d.cursor.y) * gain }
        onDrag(d.index, {
          x: clamp(d.start.x + moved.x, 0, pw),
          y: clamp(d.start.y + moved.y, 0, ph),
        })
      }}
      onPointerUp={() => {
        dragging.current = null
        onDrag(-1, null)
      }}
      onPointerCancel={() => {
        dragging.current = null
        onDrag(-1, null)
      }}
    >
      <path d={shade} fillRule="evenodd" className="trace-overlay__shade" />
      <polygon points={pts} className={'trace-overlay__quad' + (inner ? ' is-track' : '')} />
      {inner && <polygon points={inner.map((p) => `${p.x},${p.y}`).join(' ')} className="trace-overlay__window" />}
      {quad.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={r}
          className="trace-handle"
          onPointerDown={(e) => {
            dragging.current = { index: i, cursor: toPhoto(e.clientX, e.clientY), start: quad[i] }
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
        />
      ))}
    </svg>
  )
}

/**
 * The page finder's result: the photo, and once the sheet is found a line
 * swipes across it like the vector reveal, cutting away everything that is not
 * paper as it passes. Underneath, a copy clipped to the sheet stays put; on
 * top, the full photo is clipped away from the left in step with the line.
 */
function CutSweep({ photo, quad, cut, onCut }: { photo: HTMLCanvasElement; quad: Pt[] | null; cut: boolean; onCut: () => void }) {
  const poly = quad ? `polygon(${quad.map((p) => `${(p.x / photo.width) * 100}% ${(p.y / photo.height) * 100}%`).join(', ')})` : undefined
  return (
    <div className="trace-revealbox" style={{ ['--sweep-ms' as string]: `${SWEEP_MS}ms` }}>
      {quad && <CanvasView src={photo} className="trace-cut__paper" style={{ clipPath: poly }} />}
      <CanvasView src={photo} className={'trace-cut__photo' + (quad ? ' is-cutting' : '')} />
      {quad && !cut && <div className="trace-reveal__line" onAnimationEnd={onCut} />}
    </div>
  )
}

/** Rectangle in the canvas area's pixels. */
type Rect = { x: number; y: number; w: number; h: number }

/**
 * The cut-out paper flattening: the flattened image is drawn through a
 * perspective transform whose corners travel from where the sheet sits in the
 * photo to the rectangle the flat page will fill, so it starts exactly on the
 * photographed sheet and ends exactly where the next view draws it.
 */
function FlattenMorph({ src, from, to, onDone }: { src: HTMLCanvasElement; from: Pt[]; to: Rect; onDone: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const done = useRef(onDone)
  useLayoutEffect(() => {
    done.current = onDone
  })
  useLayoutEffect(() => {
    const c = ref.current
    if (!c) return
    c.width = src.width
    c.height = src.height
    c.getContext('2d')?.drawImage(src, 0, 0)
    c.style.width = `${to.w}px`
    c.style.height = `${to.h}px`
    const local = [
      { x: 0, y: 0 },
      { x: to.w, y: 0 },
      { x: to.w, y: to.h },
      { x: 0, y: to.h },
    ]
    const target = local.map((p) => ({ x: p.x + to.x, y: p.y + to.y }))
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
    const place = (t: number) => {
      const k = ease(t)
      const pts = from.map((p, i) => ({ x: p.x + (target[i].x - p.x) * k, y: p.y + (target[i].y - p.y) * k }))
      try {
        const H = computeHomography(local, pts)
        // Row-major 3x3 homography -> column-major CSS matrix3d.
        c.style.transform = `matrix3d(${H[0]},${H[3]},0,${H[6]},${H[1]},${H[4]},0,${H[7]},0,0,1,0,${H[2]},${H[5]},0,${H[8]})`
      } catch {
        /* degenerate mid-flight: keep the last frame */
      }
    }
    place(0)
    let raf = 0
    const t0 = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / FLATTEN_MS)
      place(t)
      if (t < 1) raf = requestAnimationFrame(step)
      else done.current()
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [src, from, to])
  return <canvas ref={ref} className="trace-flatten" />
}

/* ------------------------------------------------------------------ */
/* Trace editor                                                        */
/* ------------------------------------------------------------------ */

type Phase = 'pick' | 'detect' | 'frame' | 'flatten' | 'working' | 'result'
type ResultMode = 'view' | 'outline' | 'modify' | 'adjust'

/** The header dropdown's sub-modes, in menu order. Any image has no paper: Resize instead. */
const subModes = (image: boolean): { mode: Exclude<ResultMode, 'view'>; label: string }[] => [
  { mode: 'modify', label: 'Modify Vector' },
  { mode: 'adjust', label: image ? 'Adjust Image' : 'Adjust Scan' },
  { mode: 'outline', label: image ? 'Resize' : 'Paper Outline' },
]
/**
 * The reveal: the black & white page shows while the vectors are computed
 * ('wait'), then a line swipes once from left to right ('run') like a
 * before/after slider, uncovering the vectors behind it.
 */
type Sweep = 'wait' | 'run' | 'done'

export default function TraceMode({ units, onClose, onImport }: TraceModeProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>('pick')
  const [error, setError] = useState<string | null>(null)

  // pick: photo (the intro handles upload / camera)
  const [photo, setPhoto] = useState<HTMLCanvasElement | null>(null)

  // detect / frame: corners and paper size
  const [sheet, setSheetState] = useState<SheetKind>(loadSheet)
  const [quad, setQuad] = useState<Pt[] | null>(null)
  // Shaper Trace: the frame's dot track. The scanned window is always derived
  // from it with the frame's real geometry, and sized by the dots.
  const [track, setTrack] = useState<Pt[] | null>(null)
  const [foundQuad, setFoundQuad] = useState<Pt[] | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [detectNote, setDetectNote] = useState<string | null>(null)
  const [sizeNote, setSizeNote] = useState<string | null>(null)
  const [presetId, setPresetId] = useState(() => (units === 'in' ? 'letter' : 'a4'))
  const [customW, setCustomW] = useState(() => CUSTOM_DEFAULT[units].w)
  const [customH, setCustomH] = useState(() => CUSTOM_DEFAULT[units].h)
  const [landscape, setLandscape] = useState(false)
  const [ppm, setPpm] = useState(6)
  const [loupe, setLoupe] = useState<Pt | null>(null)

  // working / result
  const [scan, setScan] = useState<ScanImage | null>(null)
  const [bw, setBw] = useState<HTMLCanvasElement | null>(null)
  // The flattened sheet in colour, and the cut / flatten animation state.
  const [flat, setFlat] = useState<HTMLCanvasElement | null>(null)
  const [cutDone, setCutDone] = useState(false)
  const [morph, setMorph] = useState<{ from: Pt[]; to: Rect } | null>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const [sweep, setSweep] = useState<Sweep>('wait')
  const [vec, setVec] = useState<VectorResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [mode, setMode] = useState<VectorMode>('centerline')
  const [resultMode, setResultMode] = useState<ResultMode>('view')
  const [keep, setKeep] = useState<Set<number>>(() => new Set())
  const job = useRef(0)
  // modify: what a tap / swipe does, and the selection to restore on Cancel
  const [pickMode, setPickMode] = useState<'toggle' | 'remove' | 'select'>('toggle')
  const [pickTool, setPickTool] = useState<'tap' | 'smooth'>('tap')
  const [smooth, setSmooth] = useState(0)
  const keepSnap = useRef<Set<number>>(new Set())
  const brushing = useRef(false)
  // adjust scan: detail (ink sensitivity 1-100), reverse swipe, header menu
  const [detail, setDetail] = useState(50)
  const [adjustReady, setAdjustReady] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const snap = useRef<{ detail: number; vec: VectorResult | null; smooth: number; invert: boolean }>({ detail: 50, vec: null, smooth: 0, invert: false })
  const appliedDetail = useRef(50)
  // Any image: swap design and background, and the size being typed in Resize.
  const [invert, setInvert] = useState(false)
  const appliedInvert = useRef(false)
  const [sizeDraft, setSizeDraft] = useState<{ w: string; h: string } | null>(null)
  const resizeSnap = useRef<{ scan: ScanImage; vec: VectorResult } | null>(null)
  const isImage = sheet === 'image'
  const [brushAt, setBrushAt] = useState<Pt | null>(null)

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[1]
  const paper = useMemo(
    () => paperDims(sheet, preset, customW, customH, units, landscape),
    [sheet, preset, customW, customH, units, landscape],
  )
  const outlineSnap = useRef<OutlineSnap | null>(null)
  // Debug (`?tracedebug` in the address): keep the camera's exact capture so
  // it can be saved and measured offline.
  const debug = useMemo(() => typeof location !== 'undefined' && new URLSearchParams(location.search).has('tracedebug'), [])
  const [captured, setCaptured] = useState<HTMLCanvasElement | null>(null)

  /** Debug: download the camera's capture, full resolution, lossless. */
  function saveCapture() {
    if (!captured) return
    captured.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `trace-capture-${captured.width}x${captured.height}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    }, 'image/png')
  }
  // Bumped for every new photo (and on close) so a stale auto-flow stops.
  const flow = useRef(0)
  const detector = useRef<Detector | null>(null)

  function setSheet(k: SheetKind) {
    setSheetState(k)
    // Into Trace with a photo already framed: the current corners become the
    // first guess of the dot track (the dots will correct it on Scan).
    if (k === 'trace' && photo && !track) setTrack(quad ?? defaultTrack(photo.width, photo.height))
    try {
      localStorage.setItem(SHEET_KEY, k)
    } catch {
      /* private mode: just not remembered */
    }
  }

  useEffect(
    () => () => {
      flow.current++
      cancelPaperJobs()
      detector.current?.dispose()
    },
    [],
  )

  // Escape backs out of a sub-mode first. Captured and marked handled, so the
  // app-wide Escape (which closes the whole dialog) only runs from the top level.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || phase !== 'result' || resultMode === 'view') return
      e.preventDefault()
      if (menuOpen) setMenuOpen(false)
      else if (resultMode === 'outline') cancelOutline()
      else setResultMode('view')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, resultMode, menuOpen])

  /** A photo from the camera: from here on exactly like an uploaded image. */
  function onCaptured(frame: HTMLCanvasElement) {
    setError(null)
    if (debug) setCaptured(frame)
    startFromPhoto(canvasFromSource(frame, frame.width, frame.height))
  }

  /**
   * Every photo — uploaded or captured — starts here: the full-quality
   * detection runs on it from scratch, never seeded by the live finder.
   */
  function startFromPhoto(c: HTMLCanvasElement) {
    setPhoto(c)
    resetFromPhoto()
    if (sheet === 'image') startImage(c)
    else void autoScan(c)
  }

  /**
   * Any image: no sheet to find or flatten. The picture (resampled to a
   * comfortable tracing size) is the scan, IMAGE_LONG_MM on its long side,
   * traced as filled shapes, which suits logos and artwork best.
   */
  function startImage(p: HTMLCanvasElement) {
    ++flow.current
    const long = Math.max(p.width, p.height)
    const k = long < IMAGE_MIN_SIDE ? IMAGE_MIN_SIDE / long : long > IMAGE_MAX_SIDE ? IMAGE_MAX_SIDE / long : 1
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(p.width * k))
    c.height = Math.max(1, Math.round(p.height * k))
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      setError('Could not read that image.')
      return
    }
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(p, 0, 0, c.width, c.height)
    const longMm = IMAGE_LONG_MM[units]
    const wMm = c.width >= c.height ? longMm : (longMm * c.width) / c.height
    const hMm = (wMm * c.height) / c.width
    const s: ScanImage = { img: ctx.getImageData(0, 0, c.width, c.height), ppmX: c.width / wMm, ppmY: c.height / hMm, wMm, hMm, label: 'Image' }
    setInvert(false)
    appliedInvert.current = false
    setMode('outline')
    setScan(s)
    setFlat(c)
    setBw(c)
    setSweep('wait')
    setResultMode('view')
    setPhase('working')
    void vectorise(s, 'outline', false)
  }

  /* ----- photo loading ----- */

  function resetFromPhoto() {
    setQuad(null)
    setTrack(null)
    setFoundQuad(null)
    setDetectNote(null)
    setSizeNote(null)
    setScan(null)
    setBw(null)
    setFlat(null)
    setCutDone(false)
    setMorph(null)
    setVec(null)
    setLoupe(null)
    setSweep('wait')
    setResultMode('view')
  }

  async function loadFile(file: File) {
    setError(null)
    try {
      let bmp: ImageBitmap
      try {
        const size = await imageFileSize(file)
        const k = Math.min(1, MAX_PHOTO_SIDE / Math.max(size.w, size.h))
        bmp = await createImageBitmap(file, {
          imageOrientation: 'from-image',
          resizeWidth: Math.max(1, Math.round(size.w * k)),
          resizeHeight: Math.max(1, Math.round(size.h * k)),
          resizeQuality: 'high',
        })
      } catch {
        bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
      }
      const c = canvasFromSource(bmp, bmp.width, bmp.height)
      bmp.close()
      startFromPhoto(c)
    } catch {
      setError('Could not read that file as an image.')
    }
  }

  /* ----- corner detection ----- */

  /**
   * Find the sheet off the main thread. `hint` (a dot track placed in the
   * editor) only seeds the dot search when Auto-Detect is pressed there.
   */
  async function detectSheet(p: HTMLCanvasElement, kind: SheetKind, hint: Pt[] | null): Promise<DetectResult> {
    setDetecting(true)
    setDetectNote(null)
    await tick()
    let r: DetectResult
    try {
      detector.current ??= new Detector()
      // Trace: the hint is the dot track (live lock or dragged corners) and only
      // ever seeds the dot search; it never stands in for the frame itself.
      r = await detector.current.detectCanvas(p, { kind, traceSeed: kind === 'trace' && hint ? hint : undefined })
    } catch {
      try {
        r = detectPaper(p, { kind, traceSeed: kind === 'trace' && hint ? hint : undefined })
      } catch {
        const q = insetQuad(p.width, p.height)
        r = { quad: q, found: false, reason: '', ratio: p.width / p.height }
      }
    }
    if (kind === 'paper' && !r.found && hint && isSimpleQuad(hint)) r = { quad: hint, found: true, reason: '', ratio: estimateAspect(hint, p.width, p.height).ratio }
    setDetecting(false)
    return r
  }

  /**
   * Take on a detection: the corners, the orientation and — for plain paper —
   * the size whose proportions match the sheet's true (perspective-corrected)
   * ratio. Returns the resulting sheet size so a scan can start right away.
   */
  function applyDetection(r: DetectResult, kind: SheetKind, pw: number, ph: number): PaperSize {
    const g = guessPaper(r.ratio, presetId)
    if (kind === 'trace') {
      // The handles go on the dot track; the window inside follows the frame.
      const t = r.track ?? (r.found ? null : defaultTrack(pw, ph))
      setTrack(t)
      // The orientation is the detector's (decided by the dots): the window's
      // corners and the scan's width and height must agree on it, or the
      // scan comes out squeezed by 173 / 263.
      const land = r.found ? r.ratio >= 1 : t ? estimateAspect(t, pw, ph).ratio >= 1 : g.landscape
      setQuad(r.found ? r.quad : t ? captureFromTrack(t, pw, ph, land) : r.quad)
      setLandscape(land)
      if (!r.found) setDetectNote("Couldn't see the Trace frame's dots — drag the corners onto the four rows of dots, or retake with the whole frame in view")
      setSizeNote(null)
      return paperDims('trace', preset, customW, customH, units, land)
    }
    setQuad(r.quad)
    setLandscape(g.landscape)
    if (!r.found) {
      setDetectNote("Couldn't find the paper edges — drag the corners onto the sheet")
      return paperDims(kind, preset, customW, customH, units, g.landscape)
    }
    let cw = customW
    let ch = customH
    if (g.presetId === 'custom') {
      // Not a standard sheet: keep the usual short side and give the long side
      // the measured proportion, then ask for the real size.
      const short = Math.min(CUSTOM_DEFAULT[units].w, CUSTOM_DEFAULT[units].h)
      const dec = units === 'in' ? 100 : 10
      cw = short
      ch = Math.round(short * g.aspect * dec) / dec
      setCustomW(cw)
      setCustomH(ch)
      setSizeNote(`Not a standard size (1 : ${g.aspect.toFixed(2)}) — set its real size in Paper Outline.`)
    } else setSizeNote(null)
    setPresetId(g.presetId)
    const pre = PRESETS.find((x) => x.id === g.presetId) ?? preset
    return paperDims('paper', pre, cw, ch, units, g.landscape)
  }

  /**
   * After a photo arrives: find the sheet, then flatten it and start
   * vectorising at once, while the cut sweep plays over the photo. The flatten
   * animation and the vector reveal follow on their own (see the effect below).
   * Only when no sheet is found does it stop for manual framing.
   */
  async function autoScan(p: HTMLCanvasElement) {
    const mine = ++flow.current
    setPhase('detect')
    const r = await detectSheet(p, sheet, null)
    if (mine !== flow.current) return
    const dims = applyDetection(r, sheet, p.width, p.height)
    if (!r.found) {
      setPhase('frame')
      return
    }
    // Flatten before the sweep starts, so the brief work never stutters it.
    const s = flattenSheet(p, r.quad, dims)
    if (!s) {
      setPhase('frame')
      return
    }
    setCutDone(false)
    setFoundQuad(r.quad)
    void vectorise(s)
  }

  // Cut done and vectors ready: flatten the cut-out paper into the stage.
  useEffect(() => {
    if (phase !== 'detect' || !cutDone || !vec || !flat || !foundQuad || !scan) return
    const m = measureFlatten(foundQuad, scan.img.width / scan.img.height)
    if (m) {
      setMorph(m)
      setPhase('flatten')
    } else setPhase('working')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, cutDone, vec, flat, foundQuad, scan])

  /**
   * Where the sheet sits in the photo now, and the rectangle the flat page
   * will fill (the same fit the working stage computes), both in the canvas
   * area's pixels.
   */
  function measureFlatten(q: Pt[], aspect: number): { from: Pt[]; to: Rect } | null {
    const main = mainRef.current
    const stage = main?.querySelector<HTMLElement>('.trace-stage')
    const inner = stage?.querySelector<HTMLElement>('.trace-stage__inner')
    if (!main || !stage || !inner || !photo) return null
    const m = main.getBoundingClientRect()
    const ir = inner.getBoundingClientRect()
    const sr = stage.getBoundingClientRect()
    if (!ir.width || !ir.height) return null
    const from = q.map((p) => ({
      x: ir.left - m.left + (p.x * ir.width) / photo.width,
      y: ir.top - m.top + (p.y * ir.height) / photo.height,
    }))
    const cs = getComputedStyle(stage)
    const pl = parseFloat(cs.paddingLeft)
    const pt = parseFloat(cs.paddingTop)
    const W = stage.clientWidth - pl - parseFloat(cs.paddingRight)
    const H = stage.clientHeight - pt - parseFloat(cs.paddingBottom)
    const w = Math.floor(Math.min(W, H * aspect))
    const h = Math.floor(w / aspect)
    return { from, to: { x: sr.left - m.left + pl + (W - w) / 2, y: sr.top - m.top + pt + (H - h) / 2, w, h } }
  }

  /** Auto-Detect in the corner editors: new corners and size, no automatic scan. */
  async function redetect() {
    if (!photo) return
    const mine = ++flow.current
    const r = await detectSheet(photo, sheet, sheet === 'trace' ? track : null)
    if (mine !== flow.current) return
    applyDetection(r, sheet, photo.width, photo.height)
  }

  /* ----- flatten + vectorise with the sweep animation ----- */

  /**
   * Shaper Trace, from a placed dot track: the dots near it decide the frame
   * (true proportions, size from the 9 mm grid) however roughly the corners
   * were put down, then the window is scanned.
   */
  function scanTrace(p: HTMLCanvasElement | null, t: Pt[] | null) {
    if (!p || !t || !isSimpleQuad(t)) return
    const ctx = p.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    const res = traceFrameFromTrack(ctx.getImageData(0, 0, p.width, p.height).data, p.width, p.height, t)
    setTrack(res.track)
    setQuad(res.window)
    setLandscape(res.landscape)
    setDetectNote(res.slotted >= 12 ? null : "Few of the frame's dots were found — the size may be off")
    void scanSheet(p, res.window, paperDims('trace', preset, customW, customH, units, res.landscape))
  }

  /** Scan with the current corners: the dot track in Trace mode, the sheet's corners otherwise. */
  const scanCurrent = () => (sheet === 'trace' ? scanTrace(photo, track ?? quad) : void scanSheet(photo, quad, paper))

  /** Flatten the sheet to `dims` and make it the current scan (no phase change). */
  function flattenSheet(p: HTMLCanvasElement, q: Pt[], dims: PaperSize): ScanImage | null {
    try {
      const outW = Math.max(1, Math.round(dims.w * ppm))
      const outH = Math.max(1, Math.round(dims.h * ppm))
      const src = p.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, p.width, p.height)
      const Hinv = computeHomography(
        [
          { x: 0, y: 0 },
          { x: outW, y: 0 },
          { x: outW, y: outH },
          { x: 0, y: outH },
        ],
        q,
      )
      const img = warpPerspective(src, Hinv, outW, outH)
      const s: ScanImage = { img, ppmX: outW / dims.w, ppmY: outH / dims.h, wMm: dims.w, hMm: dims.h, label: dims.label }
      const fc = document.createElement('canvas')
      fc.width = img.width
      fc.height = img.height
      fc.getContext('2d')?.putImageData(img, 0, 0)
      setScan(s)
      setFlat(fc)
      setBw(bwCanvas(s.img))
      setVec(null)
      setSweep('wait')
      setResultMode('view')
      return s
    } catch {
      setError('Could not flatten the photo. Move the corners apart and try again.')
      return null
    }
  }

  /** Flatten and vectorise straight into the reveal (rescans from the corner editors). */
  async function scanSheet(p: HTMLCanvasElement | null, q: Pt[] | null, dims: PaperSize) {
    if (!p || !q || !isSimpleQuad(q)) return
    setError(null)
    setBusy('Flattening…')
    await tick()
    const s = flattenSheet(p, q, dims)
    setBusy(null)
    if (!s) return
    setPhase('working')
    void vectorise(s)
  }

  /**
   * Ink (or, for any image, design) mask and vectors for a scan. Resolves
   * null when a newer job has started meanwhile.
   */
  async function traceScan(s: ScanImage, myJob: number, md: VectorMode = mode, inv: boolean = invert, det: number = detail): Promise<VectorResult | null> {
    const w = s.img.width
    const h = s.img.height
    const m =
      sheet === 'image'
        ? await runImageMask(s.img, { detail: det, invert: inv })
        : // Raw grayscale: the ink pipeline does its own lighting normalisation.
          await runInk(grayFromImageData(s.img), w, h, {
            ppm: s.ppmX,
            sensitivity: det,
            cOffset: 0,
            marginMm: MARGIN_MM,
            minBlobMm2: 3,
            closeGaps: false,
          })
    if (myJob !== job.current) return null
    const r = await runVector(m, w, h, s.ppmX, md, s.ppmY)
    if (myJob !== job.current) return null
    if (sheet === 'image') setError(r.groups.length ? null : 'Nothing to trace was found in this image. Try Adjust Image.')
    return r
  }

  async function vectorise(s: ScanImage, md: VectorMode = mode, inv: boolean = invert) {
    const myJob = ++job.current
    setBusy('Converting to vectors…')
    try {
      const r = await traceScan(s, myJob, md, inv)
      if (!r) return
      setVec(r)
      setKeep(new Set(r.groups.map((_, i) => i)))
      setBusy(null)
    } catch (err) {
      if (myJob !== job.current || err instanceof CancelledError) return
      setBusy(null)
      setError(sheet === 'image' ? 'Could not trace this image. Try another one.' : 'Could not trace the drawing. Try another photo.')
    }
  }

  // Re-vectorise when the display mode changes on the result screen.
  useEffect(() => {
    if (phase !== 'result' || !scan || !vec) return
    const myJob = ++job.current
    void (async () => {
      try {
        const r = await traceScan(scan, myJob)
        if (!r) return
        setVec(r)
        setKeep(new Set(r.groups.map((_, i) => i)))
      } catch {
        /* keep the previous vectors */
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  /* ----- sweep animation sequencing ----- */

  // As soon as the vectors exist, swipe once to reveal them.
  useEffect(() => {
    if (phase === 'working' && sweep === 'wait' && vec) setSweep('run')
  }, [phase, vec, sweep])

  const onSweepEnd = () => {
    setSweep('done')
    setPhase('result')
  }

  // Measurements and controls fade in only after the reveal has finished.
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    if (phase !== 'result') {
      setRevealed(false)
      return
    }
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setRevealed(true)))
    return () => cancelAnimationFrame(id)
  }, [phase])

  /* ----- import ----- */

  function addToDesign() {
    if (!scan || !vec) return
    // Each traced object (an outer loop with any holes inside it) becomes its own
    // ungrouped shape so it can be selected and moved on its own. The sheet itself
    // is not imported.
    const cutType = vec.mode === 'centerline' ? 'online' : 'outside'
    const meta = { source: 'paper' as const, role: 'outline' as const }
    const shapes = groups
      .filter((_, i) => keep.has(i))
      .map((g, i) => {
        const name = vec.mode === 'centerline' ? `Line ${i + 1}` : `Outline ${i + 1}`
        return withoutId(shapeFromWorld('sketch', name, g, { cut: cutFor(cutType), meta }))
      })
    onImport({ shapes })
    onClose()
  }

  /* ----- render helpers ----- */

  // The traced groups with the smoothness slider applied; indexes match vec.groups.
  const groups = useMemo(() => (vec ? smoothGroups(vec.groups, smooth) : []), [vec, smooth])

  // Preview and import show only the groups kept in Modify.
  const vecPaths = useMemo(
    () => (vec ? <VecPaths groups={groups.filter((_, i) => keep.has(i))} /> : null),
    [vec, groups, keep],
  )

  const groupBoxes = useMemo(
    () =>
      vec
        ? groups.map((g) => {
            let x0 = Infinity
            let y0 = Infinity
            let x1 = -Infinity
            let y1 = -Infinity
            for (const c of g)
              for (const p of c.pts) {
                if (p.x < x0) x0 = p.x
                if (p.x > x1) x1 = p.x
                if (p.y < y0) y0 = p.y
                if (p.y > y1) y1 = p.y
              }
            return { x0, y0, x1, y1 }
          })
        : [],
    [vec, groups],
  )

  // Bounding box (mm) of everything kept, for the size readout on the result.
  const keptBox = useMemo((): Box | null => {
    const b: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
    groupBoxes.forEach((g, i) => {
      if (!keep.has(i)) return
      b.x0 = Math.min(b.x0, g.x0)
      b.y0 = Math.min(b.y0, g.y0)
      b.x1 = Math.max(b.x1, g.x1)
      b.y1 = Math.max(b.y1, g.y1)
    })
    return b.x1 > b.x0 && b.y1 > b.y0 ? b : null
  }, [groupBoxes, keep])

  const groupDs = useMemo(() => (vec ? groups.map((g) => g.map(pathD).join('')) : []), [vec, groups])

  // The corners being edited: the dot track in Trace mode, the sheet otherwise.
  const editQuad = sheet === 'trace' ? track ?? quad : quad
  const cornersCross = !!editQuad && !isSimpleQuad(editQuad)
  const scanDisabled = !editQuad || cornersCross || detecting || !!busy

  const applyPick = (idx: number[]) =>
    setKeep((p) => {
      const n = new Set(p)
      let changed = false
      for (const i of idx) {
        if (pickMode === 'remove' ? n.delete(i) : !n.has(i) && n.add(i)) changed = true
      }
      return changed ? n : p
    })

  const tapGroup = (i: number) => {
    if (pickMode === 'toggle') toggleKeep(i)
  }

  function chooseSub(kind: Exclude<ResultMode, 'view'>) {
    setMenuOpen(false)
    if (kind === resultMode) return
    // Leaving Paper Outline through the menu drops its unapplied corner edits;
    // Done is what rescans.
    if (resultMode === 'outline') restoreOutline()
    if (kind === 'outline') {
      openOutline()
    } else if (kind === 'adjust') {
      setAdjustReady(false)
      setResultMode('adjust')
    } else {
      setPickMode('remove')
      setPickTool('tap')
      setResultMode('modify')
    }
  }

  /** Paper Outline: drag the corners and pick the sheet size by hand. */
  function openOutline() {
    outlineSnap.current = { quad, track, sheet, presetId, customW, customH, landscape, ppm }
    // Modify / Adjust reached from here through the menu cancel back to this state.
    keepSnap.current = new Set(keep)
    snap.current = { detail, vec, smooth, invert }
    appliedDetail.current = detail
    appliedInvert.current = invert
    setMenuOpen(false)
    if (sheet === 'image') openResize()
    setResultMode('outline')
  }

  function restoreOutline() {
    if (sheet === 'image') {
      restoreResize()
      return
    }
    const o = outlineSnap.current
    if (!o) return
    setQuad(o.quad)
    setTrack(o.track)
    setSheetState(o.sheet)
    setPresetId(o.presetId)
    setCustomW(o.customW)
    setCustomH(o.customH)
    setLandscape(o.landscape)
    setPpm(o.ppm)
    setDetectNote(null)
  }

  function cancelOutline() {
    restoreOutline()
    setMenuOpen(false)
    setResultMode('view')
  }

  /** Done in Paper Outline: rescan when anything changed, else just go back. */
  function applyOutline() {
    const o = outlineSnap.current
    setMenuOpen(false)
    if (sheet === 'image') {
      // Resize applies as it is typed: nothing to rescan.
      resizeSnap.current = null
      setSizeDraft(null)
      setResultMode('view')
      return
    }
    const same =
      !!o &&
      o.sheet === sheet &&
      o.presetId === presetId &&
      o.customW === customW &&
      o.customH === customH &&
      o.landscape === landscape &&
      o.ppm === ppm &&
      !!o.quad &&
      !!quad &&
      o.quad.every((p, i) => p.x === quad[i].x && p.y === quad[i].y) &&
      (o.track ?? []).every((p, i) => !!track && p.x === track[i].x && p.y === track[i].y)
    setResultMode('view')
    if (!same) {
      setSizeNote(null)
      scanCurrent()
    }
  }

  /* ----- any image: Resize ----- */

  /** Resize: the traced design's size, typed in the document units. */
  function openResize() {
    if (scan && vec) resizeSnap.current = { scan, vec }
    setSizeDraft(keptBox ? { w: fmtInput(keptBox.x1 - keptBox.x0), h: fmtInput(keptBox.y1 - keptBox.y0) } : null)
  }

  function restoreResize() {
    const r = resizeSnap.current
    resizeSnap.current = null
    setSizeDraft(null)
    if (!r) return
    setScan(r.scan)
    setVec(r.vec)
  }

  /** A length in mm as the inputs show it: 2 decimals in inches, 1 in mm. */
  function fmtInput(mm: number): string {
    return units === 'in' ? String(Math.round((mm / MM_PER_IN) * 100) / 100) : String(Math.round(mm * 10) / 10)
  }

  /**
   * Typed a width or height: the image and its vectors scale together, about
   * the top-left corner, so the kept design gets that size (aspect locked).
   * Scaling the result is exact; the next re-trace runs at the new scale too.
   */
  function onSizeInput(axis: 'w' | 'h', text: string) {
    if (!keptBox || !scan || !vec) return
    const cur = axis === 'w' ? keptBox.x1 - keptBox.x0 : keptBox.y1 - keptBox.y0
    const ratio = (keptBox.y1 - keptBox.y0) / (keptBox.x1 - keptBox.x0)
    const v = Number(text)
    const mm = fromUnits(v, units)
    if (!(v > 0) || !(mm >= 1) || !(cur > 0)) {
      setSizeDraft((d) => (d ? { ...d, [axis]: text } : d))
      return
    }
    const f = mm / cur
    const other = axis === 'w' ? mm * ratio : mm / ratio
    setSizeDraft(axis === 'w' ? { w: text, h: fmtInput(other) } : { w: fmtInput(other), h: text })
    setScan({ ...scan, wMm: scan.wMm * f, hMm: scan.hMm * f, ppmX: scan.ppmX / f, ppmY: scan.ppmY / f })
    setVec(scaleVector(vec, f))
  }

  const sizeInputs = sizeDraft && (
    <div className="trace-row">
      <input className="ss-select" type="number" min={0} step="any" value={sizeDraft.w} onChange={(e) => onSizeInput('w', e.target.value)} aria-label="Width" />
      <span className="modeview__label">×</span>
      <input className="ss-select" type="number" min={0} step="any" value={sizeDraft.h} onChange={(e) => onSizeInput('h', e.target.value)} aria-label="Height" />
      <span className="modeview__label">{units}</span>
    </div>
  )

  function cancelSub() {
    setKeep(new Set(keepSnap.current))
    setSmooth(snap.current.smooth)
    setDetail(snap.current.detail)
    appliedDetail.current = snap.current.detail
    setInvert(snap.current.invert)
    appliedInvert.current = snap.current.invert
    setVec(snap.current.vec)
    setMenuOpen(false)
    setResultMode('view')
  }

  // Re-trace with the new detail (or, for any image, inversion) once the slider settles.
  useEffect(() => {
    if (resultMode !== 'adjust' || !adjustReady || !scan) return
    if (detail === appliedDetail.current && invert === appliedInvert.current) return
    const t = window.setTimeout(() => {
      appliedDetail.current = detail
      appliedInvert.current = invert
      void (async () => {
        const myJob = ++job.current
        try {
          const r = await traceScan(scan, myJob)
          if (!r) return
          setVec(r)
          setKeep(new Set(r.groups.map((_, i) => i)))
        } catch {
          /* keep the previous vectors */
        }
      })()
    }, 220)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, invert, resultMode, adjustReady])

  /** Brush: groups with any stroke within the thumb-sized circle at the pointer. */
  function brushAtPointer(e: PointerEvent<SVGSVGElement>) {
    if (!scan || !vec) return
    const box = e.currentTarget.getBoundingClientRect()
    const kx = scan.wMm / box.width
    const ky = scan.hMm / box.height
    const cx = (e.clientX - box.left) * kx
    const cy = (e.clientY - box.top) * ky
    const r = BRUSH_PX * kx
    const r2 = r * r
    const near = (a: Pt, b: Pt) => {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const l2 = dx * dx + dy * dy
      const t = l2 ? clamp(((cx - a.x) * dx + (cy - a.y) * dy) / l2, 0, 1) : 0
      const px = a.x + t * dx - cx
      const py = a.y + t * dy - cy
      return px * px + py * py <= r2
    }
    const hit: number[] = []
    groups.forEach((g, i) => {
      const bb = groupBoxes[i]
      if (!bb || bb.x1 < cx - r || bb.x0 > cx + r || bb.y1 < cy - r || bb.y0 > cy + r) return
      for (const ct of g) {
        const pts = ct.pts
        for (let k = 0; k < pts.length - (ct.closed ? 0 : 1); k++) {
          if (near(pts[k], pts[(k + 1) % pts.length])) {
            hit.push(i)
            return
          }
        }
      }
    })
    if (hit.length) applyPick(hit)
    setBrushAt({ x: e.clientX, y: e.clientY })
  }

  function openModify(mobile: boolean) {
    keepSnap.current = new Set(keep)
    snap.current = { detail, vec, smooth, invert }
    appliedDetail.current = detail
    appliedInvert.current = invert
    setPickMode(mobile ? 'remove' : 'toggle')
    setPickTool('tap')
    setResultMode('modify')
  }

  const toggleKeep = (i: number) =>
    setKeep((p) => {
      const n = new Set(p)
      if (!n.delete(i)) n.add(i)
      return n
    })

  /* ----- render ----- */

  // One status line through finding, cutting, flattening and converting.
  const statusText =
    phase === 'detect'
      ? !foundQuad
        ? sheet === 'trace'
          ? 'FINDING THE TRACE FRAME'
          : 'FINDING THE PAPER'
        : !cutDone
          ? `${sheet === 'trace' ? 'TRACE FRAME' : 'PAPER'} FOUND · ${paper.label.toUpperCase()}`
          : 'CONVERTING TO VECTORS'
      : phase === 'working' && sweep === 'wait'
        ? 'CONVERTING TO VECTORS'
        : ''

  const paperOptions = PRESETS.map((p) => (
    <option key={p.id} value={p.id}>
      {p.id === 'custom' ? 'Custom' : `${p.label} (${fmtPaperSize(p.w, units)} × ${fmtPaperSize(p.h, units)} ${units})`}
    </option>
  ))
  const paperSelect = (className: string) => (
    <select className={className} value={presetId} onChange={(e) => setPresetId(e.target.value)} aria-label="Paper size">
      {paperOptions}
    </select>
  )
  const customInputs = (
    <div className="trace-row">
      <input
        className="ss-select"
        type="number"
        min={0}
        step="any"
        value={customW}
        onChange={(e) => setCustomW(Number(e.target.value) || 0)}
        aria-label="Custom width"
      />
      <input
        className="ss-select"
        type="number"
        min={0}
        step="any"
        value={customH}
        onChange={(e) => setCustomH(Number(e.target.value) || 0)}
        aria-label="Custom height"
      />
      <span className="modeview__label">{units}</span>
    </div>
  )

  return (
    <div
      className={
        'modeview trace' + (phase === 'pick' ? ' trace--intro' : '') + (phase === 'pick' || phase === 'frame' ? ' trace--frame' : '')
      }
      role="dialog"
      aria-label="Trace"
    >
      {phase === 'pick' && (
        <TraceIntro sheet={sheet} onSheet={setSheet} onFile={(f) => void loadFile(f)} onCapture={onCaptured} onClose={onClose} />
      )}
      <div className={'trace__title' + (phase === 'result' && resultMode !== 'view' ? ' is-swapped' : '')} aria-hidden="true">
        Trace
      </div>
      {phase === 'result' && resultMode !== 'view' && (
        <div className="trace__menu">
          <button type="button" className="trace__menu-btn" aria-haspopup="listbox" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
            {subModes(isImage).find((m) => m.mode === resultMode)?.label}
            <Ic.IconChevronDown size={12} />
          </button>
          {menuOpen && (
            <ul className="trace__menu-list" role="listbox">
              {subModes(isImage).map((m) => (
                <li key={m.mode} role="option" aria-selected={resultMode === m.mode} onClick={() => chooseSub(m.mode)}>
                  {m.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="modeview__canvas trace__main" ref={mainRef}>
        {phase === 'detect' && photo && (
          <Stage aspect={photo.width / photo.height} bare>
            {() => <CutSweep photo={photo} quad={foundQuad} cut={cutDone} onCut={() => setCutDone(true)} />}
          </Stage>
        )}

        {phase === 'flatten' && flat && morph && <FlattenMorph src={flat} from={morph.from} to={morph.to} onDone={() => setPhase('working')} />}

        {phase === 'frame' && photo && quad && (
          <Stage aspect={photo.width / photo.height}>
            {(size) => (
              <>
                <CanvasView src={photo} />
                {cornerEditor(size, 1)}
              </>
            )}
          </Stage>
        )}

        {phase === 'working' && scan && flat && (
          <Stage aspect={scan.img.width / scan.img.height}>
            {() => (
              <div className="trace-revealbox" style={{ ['--sweep-ms' as string]: `${SWEEP_MS}ms` }}>
                {/* "Before": the flattened paper itself. */}
                <CanvasView src={flat} />
                {sweep === 'run' && vec && (
                  <>
                    {/* "After": the vectors on clean paper, uncovered left to right. */}
                    <div className="trace-reveal">
                      <svg className="trace-vec" viewBox={`0 0 ${scan.wMm} ${scan.hMm}`} preserveAspectRatio="none">
                        {vecPaths}
                      </svg>
                    </div>
                    <div className="trace-reveal__line" onAnimationEnd={onSweepEnd} />
                  </>
                )}
              </div>
            )}
          </Stage>
        )}
        {statusText && <div className="trace-converting">{statusText}</div>}

        {phase === 'result' && (resultMode === 'view' || (isImage && resultMode === 'outline')) && scan && (
          <Stage aspect={scan.img.width / scan.img.height}>
            {(size) => (
              <>
                <svg className="trace-vec" viewBox={`0 0 ${scan.wMm} ${scan.hMm}`} preserveAspectRatio="none">
                  {vecPaths}
                </svg>
                {keptBox && <MotifDims box={keptBox} scan={scan} size={size} units={units} shown={revealed} />}
              </>
            )}
          </Stage>
        )}

        {phase === 'result' && resultMode === 'outline' && !isImage && photo && quad && (
          <Stage aspect={photo.width / photo.height}>
            {(size) => (
              <>
                <CanvasView src={photo} />
                {cornerEditor(size, EDIT_DRAG_GAIN)}
              </>
            )}
          </Stage>
        )}

        {phase === 'result' && resultMode === 'adjust' && scan && bw && (
          <Stage aspect={scan.img.width / scan.img.height}>
            {() => (
              <div className="trace-revealbox" style={{ ['--sweep-ms' as string]: `${SWEEP_MS}ms` }}>
                <CanvasView src={bw} />
                {!adjustReady ? (
                  <>
                    {/* Swipe back: the vectors are wiped away, uncovering the original scan. */}
                    <div className="trace-reveal is-back">
                      <svg className="trace-vec" viewBox={`0 0 ${scan.wMm} ${scan.hMm}`} preserveAspectRatio="none">
                        {vecPaths}
                      </svg>
                    </div>
                    <div className="trace-reveal__line is-back" onAnimationEnd={() => setAdjustReady(true)} />
                  </>
                ) : (
                  <svg className="trace-vec" viewBox={`0 0 ${scan.wMm} ${scan.hMm}`} preserveAspectRatio="none">
                    {vecPaths}
                  </svg>
                )}
              </div>
            )}
          </Stage>
        )}

        {phase === 'result' && resultMode === 'modify' && scan && vec && (
          <Stage aspect={scan.img.width / scan.img.height}>
            {() => (
              <svg
                className="trace-vec trace-vec--pick"
                viewBox={`0 0 ${scan.wMm} ${scan.hMm}`}
                preserveAspectRatio="none"
                onPointerDown={(e) => {
                  if (pickMode === 'toggle' || pickTool !== 'tap') return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  brushing.current = true
                  brushAtPointer(e)
                }}
                onPointerMove={(e) => {
                  if (brushing.current) brushAtPointer(e)
                }}
                onPointerUp={() => {
                  brushing.current = false
                  setBrushAt(null)
                }}
                onPointerCancel={() => {
                  brushing.current = false
                  setBrushAt(null)
                }}
              >
                {groupDs.map((d, i) =>
                  d ? (
                    <g key={i} data-testid={`trace-group-${i}`} onClick={() => tapGroup(i)}>
                      {/* invisible wide stroke = forgiving tap target */}
                      <path d={d} className="trace-group-hit" />
                      <VecPaths groups={[groups[i]]} className={'trace-path trace-group' + (keep.has(i) ? '' : ' is-dropped')} />
                    </g>
                  ) : null,
                )}
              </svg>
            )}
          </Stage>
        )}

        {brushAt && (
          <div
            className={'trace-brush ' + (pickMode === 'remove' ? 'is-remove' : 'is-select')}
            style={{ left: brushAt.x, top: brushAt.y, width: BRUSH_PX * 2, height: BRUSH_PX * 2 }}
          />
        )}
        {loupe && photo && <Loupe src={photo} at={loupe} />}
        {detecting && (phase === 'frame' || resultMode === 'outline') && <div className="trace-busy">Finding the paper…</div>}
        {error && <div className="trace-error">{error}</div>}
        {debug && captured && phase === 'result' && (
          <button type="button" className="trace-debug-save" onClick={saveCapture}>
            Save captured photo ({captured.width}×{captured.height})
          </button>
        )}
      </div>

      {(phase === 'detect' || phase === 'flatten' || phase === 'working') && (
        <div className="trace-status" role="status">
          {statusText}
        </div>
      )}

      <aside className="modeview__panel trace__side">
        <button type="button" className="modeview__close" aria-label="Close Trace" onClick={onClose}>
          <Ic.IconClose size={18} />
        </button>
        <div className="modeview__title">
          <Ic.IconTrace size={18} />
          Trace
        </div>

        {phase === 'result' && resultMode === 'outline' && isImage && (
          <>
            <p className="modeview__hint">Set the size of the traced design. Width and height stay in proportion.</p>
            <div className="modeview__label">size</div>
            {sizeInputs ?? <p className="modeview__hint">Keep at least one part of the trace to size it.</p>}
            <div className="modeview__spacer" />
            <div className="trace-row">
              <button type="button" className="modeview__pill modeview__pill--back" onClick={cancelOutline}>
                Cancel
              </button>
              <button type="button" className="modeview__finish" onClick={applyOutline}>
                Done
              </button>
            </div>
          </>
        )}

        {(phase === 'frame' || (phase === 'result' && resultMode === 'outline' && !isImage)) && (
          <>
            <p className="modeview__hint">
              {sheet === 'trace'
                ? 'Drag the corners onto the four rows of dots. The window inside keeps the frame’s real shape, and the dots set the exact size when you scan.'
                : resultMode === 'outline'
                  ? 'Drag the corners onto the sheet — they move slowly for precision — and set its size.'
                  : 'Check the corners, pick the paper size, then Scan.'}
            </p>
            <div className="modeview__label">sheet</div>
            <div className="ss-seg trace-seg" role="group" aria-label="Sheet">
              <button type="button" className={sheet === 'paper' ? 'is-active' : ''} onClick={() => setSheet('paper')}>
                Regular paper
              </button>
              <button type="button" className={sheet === 'trace' ? 'is-active' : ''} onClick={() => setSheet('trace')}>
                Shaper Trace
              </button>
            </div>
            {sheet === 'paper' ? paperSelect('ss-select trace-select') : <div className="modeview__hint">Trace frame window, {fmtLen(TRACE_FRAME.h, units)} × {fmtLen(TRACE_FRAME.w, units)}</div>}
            {sheet === 'paper' && preset.id === 'custom' && customInputs}
            {/* A Trace frame's orientation is read from its dots, never set by hand. */}
            {sheet === 'paper' && (
              <div className="ss-seg trace-seg" role="group" aria-label="Orientation">
                <button type="button" className={!landscape ? 'is-active' : ''} onClick={() => setLandscape(false)}>
                  Portrait
                </button>
                <button type="button" className={landscape ? 'is-active' : ''} onClick={() => setLandscape(true)}>
                  Landscape
                </button>
              </div>
            )}
            <div className="modeview__hint">
              {fmtLen(paper.w, units)} × {fmtLen(paper.h, units)}
            </div>
            <div className="modeview__label">detail</div>
            <div className="ss-seg trace-seg" role="group" aria-label="Detail">
              {[4, 6, 10].map((v) => (
                <button key={v} type="button" className={ppm === v ? 'is-active' : ''} onClick={() => setPpm(v)}>
                  {v} px/mm
                </button>
              ))}
            </div>
            <div className="modeview__label" style={{ marginTop: 4 }}>
              corners
            </div>
            <button type="button" className="modeview__pill" onClick={() => void redetect()} disabled={!photo || detecting}>
              Auto-Detect
            </button>
            {detectNote && <div className="trace-warn">{detectNote}</div>}
            {cornersCross && <div className="trace-warn">The corners cross over each other. Drag them back into shape.</div>}
            <div className="modeview__spacer" />
            {resultMode === 'outline' ? (
              <div className="trace-row">
                <button type="button" className="modeview__pill modeview__pill--back" onClick={cancelOutline}>
                  Cancel
                </button>
                <button type="button" className="modeview__finish" disabled={scanDisabled} onClick={applyOutline}>
                  Done
                </button>
              </div>
            ) : (
              <button type="button" className="modeview__finish" disabled={scanDisabled} onClick={scanCurrent}>
                Scan
              </button>
            )}
          </>
        )}

        {phase === 'detect' && (
          <p className="modeview__hint">
            {foundQuad ? 'Found the sheet — cutting it out and converting the drawing to vectors.' : 'Finding the edges and corners of the sheet.'}
          </p>
        )}

        {(phase === 'working' || phase === 'flatten') && (
          <>
            <p className="modeview__hint">{isImage ? 'Separating the design from its background and converting it to vectors.' : 'Finding the ink and converting it to vectors.'}</p>
          </>
        )}

        {phase === 'result' && resultMode !== 'outline' && (
          <>
            <div className={'trace-stats' + (revealed ? ' is-in' : '')}>
              <div className="modeview__label">display</div>
              <div className="ss-seg trace-seg" role="group" aria-label="Display mode">
                <button type="button" className={mode === 'outline' ? 'is-active' : ''} onClick={() => setMode('outline')}>
                  Outline
                </button>
                <button type="button" className={mode === 'centerline' ? 'is-active' : ''} onClick={() => setMode('centerline')}>
                  Centerline
                </button>
              </div>
              <div className="trace-stat">
                <span>{mode === 'centerline' ? 'Lines' : 'Shapes'}</span>
                <strong>{vec ? vec.lineCount : '–'}</strong>
              </div>
              {mode === 'centerline' && (
                <div className="trace-stat">
                  <span>Stroke width</span>
                  <strong>{vec && vec.strokeWidthMm > 0 ? fmtLen(vec.strokeWidthMm, units) : '–'}</strong>
                </div>
              )}
              <div className="trace-stat">
                <span>{isImage ? 'Image' : 'Paper'}</span>
                <strong>{scan ? (isImage ? '' : `${scan.label} · `) + `${fmtLen(scan.wMm, units)} × ${fmtLen(scan.hMm, units)}` : '–'}</strong>
              </div>
              {sizeNote && <div className="trace-warn">{sizeNote}</div>}
            </div>
            {resultMode === 'adjust' && (
              <>
                <div className="modeview__label">{isImage ? 'detail' : 'ink detail'}</div>
                {adjustReady ? (
                  <TraceSlider value={detail} min={1} max={100} onChange={setDetail} label="Detail" />
                ) : (
                  <p className="modeview__hint">{isImage ? 'Retrieving the original image…' : 'Retrieving the original scan…'}</p>
                )}
                {isImage && adjustReady && (
                  <>
                    <p className="modeview__hint">More detail takes in fainter parts of the image. Invert traces the background instead of the design.</p>
                    <div className="ss-seg trace-seg" role="group" aria-label="Trace">
                      <button type="button" className={!invert ? 'is-active' : ''} onClick={() => setInvert(false)}>
                        Design
                      </button>
                      <button type="button" className={invert ? 'is-active' : ''} onClick={() => setInvert(true)}>
                        Invert
                      </button>
                    </div>
                  </>
                )}
                <div className="trace-row">
                  <button type="button" className="modeview__pill" onClick={cancelSub}>
                    Cancel
                  </button>
                  <button type="button" className="modeview__pill" onClick={() => { setMenuOpen(false); setResultMode('view') }}>
                    Done
                  </button>
                </div>
              </>
            )}
            {resultMode === 'modify' && (
              <>
                <button type="button" className="modeview__pill modeview__pill--back" onClick={() => { setResultMode('view'); setKeep(new Set(vec?.groups.map((_, i) => i) ?? [])) }}>
                  Back
                </button>
                <div className="modeview__label">select</div>
                <div className="trace-row">
                  <button type="button" className="modeview__pill" onClick={() => setKeep(new Set(vec?.groups.map((_, i) => i) ?? []))}>
                    All
                  </button>
                  <button type="button" className="modeview__pill" onClick={() => setKeep(new Set())}>
                    None
                  </button>
                </div>
                <p className="modeview__hint">Tap parts of the trace to keep or remove them.</p>
              </>
            )}
            <div className="modeview__spacer" />
            {resultMode === 'view' && (
              <button type="button" className="modeview__pill" disabled={!vec} onClick={openOutline}>
                {isImage ? 'Resize' : 'Edit Scan'}
              </button>
            )}
            {resultMode === 'view' && (
              <button type="button" className="modeview__pill" disabled={!vec} onClick={() => openModify(false)}>
                Modify
              </button>
            )}
            <button
              type="button"
              className="trace-confirm"
              aria-label="Add to design"
              title="Add to design"
              disabled={!vec || !keep.size}
              onClick={addToDesign}
            >
              <CheckMark />
            </button>
          </>
        )}
      </aside>

      {/* Mobile control panel: display row, then Edit Scan / Confirm / Modify. */}
      {phase === 'result' && (
        <nav className={'trace-controls' + (revealed ? ' is-in' : '')} aria-label="Trace controls">
          {resultMode === 'outline' && isImage ? (
            <>
              <div className="trace-controls__row trace-controls__row--modes">{sizeInputs}</div>
              <div className="trace-controls__row">
                <button type="button" className="trace-controls__text" onClick={cancelOutline}>
                  Cancel
                </button>
                <button type="button" className="trace-controls__text trace-controls__text--done" onClick={applyOutline}>
                  Done
                </button>
              </div>
            </>
          ) : resultMode === 'outline' ? (
            <>
              <div className="trace-controls__row trace-controls__row--modes">
                <select
                  className="trace-paper-select"
                  aria-label="Sheet size"
                  value={sheet === 'trace' ? 'trace' : presetId}
                  onChange={(e) => {
                    if (e.target.value === 'trace') setSheet('trace')
                    else {
                      setSheet('paper')
                      setPresetId(e.target.value)
                    }
                  }}
                >
                  <option value="trace">Shaper Trace frame</option>
                  {paperOptions}
                </select>
                {sheet === 'paper' && (
                  <button type="button" className="trace-chip is-active" onClick={() => setLandscape((l) => !l)} aria-label="Orientation">
                    {landscape ? 'Landscape' : 'Portrait'}
                  </button>
                )}
              </div>
              {sheet === 'paper' && preset.id === 'custom' && <div className="trace-controls__row trace-controls__row--modes">{customInputs}</div>}
              {(detectNote || cornersCross) && <div className="trace-warn">{cornersCross ? 'The corners cross over each other.' : detectNote}</div>}
              <div className="trace-controls__row">
                <button type="button" className="trace-controls__text" onClick={cancelOutline}>
                  Cancel
                </button>
                <button type="button" className="trace-controls__text" onClick={() => void redetect()} disabled={detecting}>
                  Auto-detect
                </button>
                <button type="button" className="trace-controls__text trace-controls__text--done" disabled={scanDisabled} onClick={applyOutline}>
                  Done
                </button>
              </div>
            </>
          ) : resultMode === 'adjust' ? (
            adjustReady ? (
              <>
                <TraceSlider value={detail} min={1} max={100} onChange={setDetail} label="Detail" />
                {isImage && (
                  <div className="trace-controls__row trace-controls__row--modes" role="group" aria-label="Trace">
                    <button type="button" className={'trace-chip' + (!invert ? ' is-active' : '')} onClick={() => setInvert(false)}>
                      Design
                    </button>
                    <button type="button" className={'trace-chip' + (invert ? ' is-active' : '')} onClick={() => setInvert(true)}>
                      Invert
                    </button>
                  </div>
                )}
                <div className="trace-controls__row">
                  <button type="button" className="trace-controls__text" onClick={cancelSub}>
                    Cancel
                  </button>
                  <div className="trace-tools">
                    <button type="button" className="trace-tool is-active" aria-label="Detail">
                      <Ic.IconTraceDetail size={24} />
                    </button>
                  </div>
                  <button type="button" className="trace-controls__text trace-controls__text--done" onClick={() => { setMenuOpen(false); setResultMode('view') }}>
                    Done
                  </button>
                </div>
              </>
            ) : (
              <div className="trace-controls__status">{isImage ? 'RETRIEVING ORIGINAL IMAGE' : 'RETRIEVING ORIGINAL SCAN'}</div>
            )
          ) : resultMode === 'modify' ? (
            <>
              {pickTool === 'smooth' ? (
                <TraceSlider value={smooth} min={0} max={10} onChange={setSmooth} label="Smoothness" dots />
              ) : (
              <div className="trace-pick" role="group" aria-label="Tap action">
                <button type="button" className={'trace-pick__opt' + (pickMode === 'remove' ? ' is-remove' : '')} onClick={() => setPickMode('remove')}>
                  <span aria-hidden="true">−</span> Remove
                </button>
                <button type="button" className={'trace-pick__opt' + (pickMode === 'select' ? ' is-select' : '')} onClick={() => setPickMode('select')}>
                  <span aria-hidden="true">+</span> Select
                </button>
              </div>
              )}
              <div className="trace-controls__row">
                <button
                  type="button"
                  className="trace-controls__text"
                  onClick={cancelSub}
                >
                  Cancel
                </button>
                <div className="trace-tools">
                  <button type="button" className={'trace-tool' + (pickTool === 'tap' ? ' is-active' : '')} aria-label="Brush" onClick={() => setPickTool('tap')}>
                    <Ic.IconTracePick size={24} strokeWidth={1.8} />
                  </button>
                  <button type="button" className={'trace-tool' + (pickTool === 'smooth' ? ' is-active' : '')} aria-label="Smoothness" onClick={() => setPickTool('smooth')}>
                    <Ic.IconTraceLasso size={24} strokeWidth={1.8} />
                  </button>
                </div>
                <button type="button" className="trace-controls__text trace-controls__text--done" onClick={() => { setMenuOpen(false); setResultMode('view') }}>
                  Done
                </button>
              </div>
            </>
          ) : (
            <>
          <div className="trace-controls__row trace-controls__row--modes" role="group" aria-label="Display mode">
            <button type="button" className={'trace-chip' + (mode === 'outline' ? ' is-active' : '')} onClick={() => setMode('outline')}>
              Outline
            </button>
            <button type="button" className={'trace-chip' + (mode === 'centerline' ? ' is-active' : '')} onClick={() => setMode('centerline')}>
              Centerline
            </button>
          </div>
          <div className="trace-controls__row">
            <button type="button" className="trace-controls__icon" aria-label={isImage ? 'Resize' : 'Edit scan'} disabled={!vec} onClick={openOutline}>
              <Ic.IconTraceEditScan size={30} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="trace-confirm"
              aria-label="Add to design"
              disabled={!vec || !keep.size}
              onClick={addToDesign}
            >
              <CheckMark />
            </button>
            <button type="button" className="trace-controls__icon" aria-label="Modify" disabled={!vec} onClick={() => openModify(true)}>
              <Ic.IconTraceModify size={30} strokeWidth={2} />
            </button>
          </div>
            </>
          )}
        </nav>
      )}

    </div>
  )

  /** The corner handles: on the dot track (window shown inside) in Trace mode, on the sheet otherwise. */
  function cornerEditor(size: Size, gain: number) {
    if (!photo) return null
    if (sheet === 'trace') {
      const t = track ?? quad
      if (!t) return null
      return <QuadOverlay quad={t} inner={captureFromTrack(t, photo.width, photo.height, landscape)} pw={photo.width} ph={photo.height} size={size} gain={gain} onDrag={onTrackDrag} />
    }
    return quad ? <QuadOverlay quad={quad} pw={photo.width} ph={photo.height} size={size} gain={gain} onDrag={onFrameDrag} /> : null
  }

  function onTrackDrag(index: number, p: Pt | null) {
    if (index < 0 || !p) {
      setLoupe(null)
      return
    }
    setDetectNote(null)
    setTrack((t) => (t ?? quad)?.map((c, i) => (i === index ? p : c)) ?? t)
    setLoupe(p)
  }

  function onFrameDrag(index: number, p: Pt | null) {
    if (index < 0 || !p) {
      setLoupe(null)
      return
    }
    setDetectNote(null)
    setQuad((q) => (q ? q.map((c, i) => (i === index ? p : c)) : q))
    setLoupe(p)
  }

}
