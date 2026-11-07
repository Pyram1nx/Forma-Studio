// Trace intro: welcome screen -> media choice (upload / paste / camera) -> live camera.
// The three layers stay mounted and cross-fade, so the transitions are pure
// CSS opacity. The media screen also asks what the drawing is on: a regular
// sheet of paper, a Shaper Trace frame (known window size), or nothing at all —
// any image (a logo, artwork, a photo) traced as a whole, with no sheet to find.
//
// While the camera is up, the sheet detector runs on a small copy of the video
// several times a second (in a worker) and its outline is drawn live over the
// preview, so you can see the page finder lock on before you shoot. Capture
// unlocks once the sheet is found (or, failing that, once a white sheet with
// dark drawing on it fills the frame). The live finder aims — and, for a
// Shaper Trace frame, calibrates the camera's lens from the dots it sees in
// many frames while you aim (see lens.ts). The capture (the sharpest of a
// short burst of the same video) is straightened
// with that lens and then goes through exactly the same path as an upload.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, JSX } from 'react'
import type { Pt } from '../../model/types'
import * as Ic from '../../ui/icons'
import { Detector } from './detectClient'
import { LENS_MIN_FRAMES, LensCalibrator, lensKey, loadLensFrames, saveLensFrames, straightenCanvas, trustedLens, type LensEstimate } from './lens'
import type { SheetKind } from './paperSize'
import { captureFromTrack, type SlotPair } from './traceDots'
import paperImg from './assets/sheet-paper.png'
import traceImg from './assets/sheet-trace.png'
import imageImg from './assets/sheet-image.svg'
import './traceIntro.css'

type Stage = 'welcome' | 'media' | 'camera'

export interface TraceIntroProps {
  sheet: SheetKind
  onSheet: (k: SheetKind) => void
  onFile: (file: File) => void
  /** A captured photo, treated exactly like an uploaded one. */
  onCapture: (frame: HTMLCanvasElement) => void
  onClose: () => void
}

/** Probe canvas size: small enough to be free, big enough to keep thin pen lines. */
const PROBE_W = 160
const PROBE_H = 120
/** Time between readiness probes (ms). */
const PROBE_MS = 140
/** Consecutive probes needed to switch the badge on / off (hysteresis, no flicker). */
const ON_STREAK = 3
const OFF_STREAK = 3
/** Long side (px) of the frame the live outline is detected on. */
const LIVE_SIDE = 400
/** Trace mode looks for the frame's dots, which need a bigger copy to be seen. */
const LIVE_SIDE_TRACE = 800
/** Consecutive live detections that lock the outline (and unlock capture). */
const LOCK_STREAK = 2
/** Consecutive misses before the live outline is dropped. */
const LOST_STREAK = 3
/** Frames looked at when capturing from video; the sharpest is kept. */
/** Live frames of dots after which capture is allowed even if the lens is still unsure. */
const LENS_GIVE_UP = 36
const BURST = 6
const BURST_GAP_MS = 45

/**
 * Sharpness of a video frame: variance of the Laplacian on a small grey
 * copy. A frame blurred by a shaking hand scores far lower.
 */
function sharpness(v: HTMLVideoElement, probe: CanvasRenderingContext2D, w: number, h: number): number {
  probe.drawImage(v, 0, 0, w, h)
  const d = probe.getImageData(0, 0, w, h).data
  const g = new Float32Array(w * h)
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = d[j] * 0.3 + d[j + 1] * 0.59 + d[j + 2] * 0.11
  let s = 0
  let s2 = 0
  let n = 0
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]
      s += l
      s2 += l * l
      n++
    }
  const m = s / n
  return s2 / n - m * m
}

/** The live outline in video pixels, and whether it is stable enough to trust. */
interface LiveQuad {
  /** The sheet's corners — or, for a Shaper Trace frame, its dot track. */
  quad: Pt[]
  /** Trace only: the capture window inside the track (always the frame's shape). */
  window?: Pt[]
  vw: number
  vh: number
  locked: boolean
}

/**
 * Does this frame look like a white sheet with dark drawing on it?
 * Paper level = 90th-percentile luma; the sheet must cover most of the frame,
 * and the centre must hold a small-but-real amount of ink-dark pixels.
 */
function looksLikeDrawing(data: Uint8ClampedArray): boolean {
  const n = PROBE_W * PROBE_H
  const lum = new Uint8Array(n)
  const hist = new Uint32Array(256)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const v = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8
    lum[i] = v
    hist[v]++
  }
  let acc = 0
  let paper = 255
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= n * 0.9) {
      paper = v
      break
    }
  }
  if (paper < 110) return false // too dark to be a lit sheet

  const bright = paper * 0.78
  const dark = paper * 0.62
  let paperPx = 0
  for (let v = Math.ceil(bright); v < 256; v++) paperPx += hist[v]
  if (paperPx < n * 0.5) return false // the sheet doesn't fill the view

  // Ink is counted in the central 80% so the table / frame edge never counts.
  const x0 = Math.floor(PROBE_W * 0.1)
  const x1 = Math.ceil(PROBE_W * 0.9)
  const y0 = Math.floor(PROBE_H * 0.1)
  const y1 = Math.ceil(PROBE_H * 0.9)
  let ink = 0
  let total = 0
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      total++
      if (lum[y * PROBE_W + x] < dark) ink++
    }
  const f = ink / total
  return f > 0.003 && f < 0.3
}

const SHEETS: { kind: SheetKind; title: string; sub: string; img: string }[] = [
  { kind: 'paper', title: 'Regular paper', sub: 'Any sheet — size found automatically', img: paperImg },
  { kind: 'trace', title: 'Shaper Trace', sub: 'Drawing inside the Trace frame', img: traceImg },
  { kind: 'image', title: 'Any image', sub: 'Logo, artwork or photo', img: imageImg },
]

/** Wrap clipboard image data as a File, named like a normal upload (ext from its MIME type). */
function namedImage(blob: Blob, type: string): File {
  const ext = type === 'image/jpeg' ? 'jpg' : type.slice('image/'.length) || 'png'
  return new File([blob], `pasted-image.${ext}`, { type })
}

export default function TraceIntro({ sheet, onSheet, onFile, onCapture, onClose }: TraceIntroProps): JSX.Element {
  const [stage, setStage] = useState<Stage>('welcome')
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [drawingReady, setDrawingReady] = useState(false)
  const [live, setLive] = useState<LiveQuad | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [pasting, setPasting] = useState(false)
  const sheetRef = useRef(sheet)
  sheetRef.current = sheet
  // The lens is known (or this camera's lens could not be pinned down).
  const [lensReady, setLensReady] = useState(false)
  // A Trace frame must be locked by its dots, and the lens learnt, before
  // capture; plain paper may also go on the simpler "white sheet with
  // drawing" test. Any image needs nothing found: the whole frame is traced.
  const locked = !!live?.locked
  const ready = sheet === 'image' ? true : sheet === 'trace' ? locked && lensReady : drawingReady || locked

  const fileRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const req = useRef(0)
  // The camera's lens, from the Trace frame's dots while aiming (lens.ts),
  // with this camera's frames from earlier scans brought back to join them.
  const calRef = useRef(new LensCalibrator())
  const lensRef = useRef<LensEstimate | null>(null)
  const lensKeyRef = useRef<string | null>(null)
  const [lensInfo, setLensInfo] = useState<string | null>(null)
  const debug = typeof location !== 'undefined' && new URLSearchParams(location.search).has('tracedebug')

  const stopStream = useCallback(() => {
    req.current++
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  useEffect(() => stopStream, [stopStream])

  async function startCamera() {
    if (asking) return
    setError(null)
    setAsking(true)
    const mine = ++req.current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // As sharp as the camera will stream: the capture is the scan's photo.
        video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } },
        audio: false,
      })
      if (mine !== req.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      calRef.current = new LensCalibrator()
      lensKeyRef.current = null
      lensRef.current = null
      setLensInfo(null)
      setLensReady(false)
      const v = videoRef.current
      if (v) {
        v.srcObject = stream
        void v.play().catch(() => undefined)
      }
      setDrawingReady(false)
      setLive(null)
      setStage('camera')
    } catch {
      if (mine === req.current) setError('Camera access was not granted. You can upload an image instead.')
    } finally {
      setAsking(false)
    }
  }

  function leaveCamera() {
    stopStream()
    setDrawingReady(false)
    setLive(null)
    setStage('media')
  }

  // Readiness probe, only while the camera layer is showing.
  useEffect(() => {
    if (stage !== 'camera') return
    const probe = document.createElement('canvas')
    probe.width = PROBE_W
    probe.height = PROBE_H
    const ctx = probe.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    let on = false
    let streak = 0
    // Live outline: detection on a LIVE_SIDE copy of the frame, in a worker.
    const detector = new Detector()
    const liveCanvas = document.createElement('canvas')
    const liveCtx = liveCanvas.getContext('2d', { willReadFrequently: true })
    let prev: Pt[] | null = null
    let prevKind: SheetKind | null = null
    let found = 0
    let missed = 0
    let alive = true
    const id = window.setInterval(() => {
      const v = videoRef.current
      if (!v || v.readyState < 2 || !v.videoWidth) return
      ctx.drawImage(v, 0, 0, PROBE_W, PROBE_H)
      const hit = looksLikeDrawing(ctx.getImageData(0, 0, PROBE_W, PROBE_H).data)
      streak = hit === on ? 0 : streak + 1
      if (streak >= (on ? OFF_STREAK : ON_STREAK)) {
        on = hit
        streak = 0
        setDrawingReady(on)
      }
      // Any image: there is no sheet to look for.
      if (sheetRef.current === 'image') {
        prev = null
        found = 0
        setLive(null)
        return
      }
      if (!liveCtx || detector.busy) return
      const vw = v.videoWidth
      const vh = v.videoHeight
      const side = sheetRef.current === 'trace' ? LIVE_SIDE_TRACE : LIVE_SIDE
      const k = Math.min(1, side / Math.max(vw, vh))
      liveCanvas.width = Math.max(2, Math.round(vw * k))
      liveCanvas.height = Math.max(2, Math.round(vh * k))
      liveCtx.drawImage(v, 0, 0, liveCanvas.width, liveCanvas.height)
      const lw = liveCanvas.width
      const lh = liveCanvas.height
      const data = liveCtx.getImageData(0, 0, lw, lh).data
      detector
        .detect(data, liveCanvas.width, liveCanvas.height, { kind: sheetRef.current, workMax: side, refine: false })
        .then((r) => {
          if (!alive) return
          if (!r.found) {
            if (++missed >= LOST_STREAK) {
              prev = null
              found = 0
              setLive(null)
            }
            return
          }
          missed = 0
          if (sheetRef.current === 'trace' && r.pairs) learnLens(r.pairs, lw, lh, vw, vh)
          // Trace: follow the dot track itself, never the white window.
          const kind = sheetRef.current
          if (kind !== prevKind) prev = null
          prevKind = kind
          const cur = (kind === 'trace' && r.track ? r.track : r.quad).map((p) => ({ x: p.x / k, y: p.y / k }))
          // Ease toward the new outline while it stays put (no jitter); jump
          // when the sheet has clearly moved.
          const diag = Math.hypot(vw, vh)
          const near = prev && prev.every((p, i) => Math.hypot(p.x - cur[i].x, p.y - cur[i].y) < diag * 0.06)
          const quad = near && prev ? prev.map((p, i) => ({ x: p.x * 0.45 + cur[i].x * 0.55, y: p.y * 0.45 + cur[i].y * 0.55 })) : cur
          found = near ? found + 1 : 1
          prev = quad
          setLive({ quad, window: kind === 'trace' ? captureFromTrack(quad, vw, vh, r.ratio >= 1) : undefined, vw, vh, locked: found >= LOCK_STREAK })
        })
        .catch(() => undefined)
    }, PROBE_MS)
    return () => {
      alive = false
      window.clearInterval(id)
      detector.dispose()
    }
  }, [stage])

  /** Feed one live frame's dots to the lens calibration, and re-solve now and then. */
  function learnLens(pairs: SlotPair[], lw: number, lh: number, vw: number, vh: number) {
    const cal = calRef.current
    const key = lensKey(streamRef.current?.getVideoTracks()[0]?.label ?? '', vw, vh)
    cal.add(pairs, lw, lh)
    let solveNow = cal.fresh >= LENS_MIN_FRAMES && cal.fresh % 3 === 0
    if (lensKeyRef.current !== key) {
      // First frame from this camera: bring back its frames from earlier scans.
      lensKeyRef.current = key
      cal.restore(loadLensFrames(key))
      solveNow = cal.count >= LENS_MIN_FRAMES
    }
    if (cal.fresh >= LENS_GIVE_UP) setLensReady(true)
    if (!solveNow) return
    const e = cal.solve()
    if (trustedLens(e)) {
      lensRef.current = e
      setLensReady(true)
    }
    if (cal.fresh % 12 === 0) saveLensFrames(key, cal)
    if (debug) {
      const l = lensRef.current
      const pct = (v: number) => (v * 100).toFixed(2) + '%'
      setLensInfo(
        `lens k1 ${e ? e.k1.toFixed(4) : '-'} k2 ${e ? e.k2.toFixed(4) : '-'} · scale ±${e ? pct(e.sigma) : '-'} · ${cal.fresh} new + ${cal.count - cal.fresh} stored frames · moved ${cal.variety().toFixed(2)} · dots off grid ${e ? e.rms0.toFixed(2) + ' → ' + e.rms1.toFixed(2) : '-'} px · using ${l ? l.k1.toFixed(4) + '/' + l.k2.toFixed(4) : 'none'}`,
      )
    }
  }

  /**
   * Take the photo: the sharpest of a short burst of video frames,
   * straightened with the lens learnt from the live view. Always the video,
   * on every browser — a separate still (ImageCapture on Android) comes
   * through another pipeline with its own crop and correction, which the
   * dots seen while aiming say nothing about. The live finder's outline is
   * not used: the photo is detected from scratch, like an upload.
   */
  async function capture() {
    const v = videoRef.current
    if (!ready || capturing || !v || !v.videoWidth) return
    setCapturing(true)
    if (sheet === 'trace' && lensKeyRef.current) saveLensFrames(lensKeyRef.current, calRef.current)
    const best = document.createElement('canvas')
    best.width = v.videoWidth
    best.height = v.videoHeight
    const bctx = best.getContext('2d')
    const pw = 480
    const ph = Math.max(2, Math.round((pw * v.videoHeight) / v.videoWidth))
    const probe = document.createElement('canvas')
    probe.width = pw
    probe.height = ph
    const pctx = probe.getContext('2d', { willReadFrequently: true })
    let top = -1
    for (let i = 0; i < BURST && bctx && pctx; i++) {
      if (i) await new Promise((r) => setTimeout(r, BURST_GAP_MS))
      const s = sharpness(v, pctx, pw, ph)
      if (s > top) {
        top = s
        bctx.drawImage(v, 0, 0, best.width, best.height)
      }
    }
    stopStream()
    const lens = sheet === 'trace' && top >= 0 ? lensRef.current : null
    setCapturing(false)
    onCapture(lens ? straightenCanvas(best, lens) : best)
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = '' // allow picking the same file again
    if (f) onFile(f)
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f && f.type.startsWith('image/')) onFile(f)
  }

  /**
   * Read the clipboard for an image (the Paste button). A click is the user
   * gesture the browser wants before handing the clipboard over; without one
   * (or without the API at all, e.g. Firefox) Ctrl/Cmd+V still works below.
   */
  async function pasteImage() {
    if (pasting) return
    setError(null)
    if (!navigator.clipboard?.read) {
      setError('This browser cannot read the clipboard — press Ctrl/Cmd+V instead.')
      return
    }
    setPasting(true)
    try {
      const items = await navigator.clipboard.read()
      const item = items.find((i) => i.types.some((t) => t.startsWith('image/')))
      const type = item?.types.find((t) => t.startsWith('image/'))
      if (!item || !type) {
        setError('No image found in the clipboard.')
        return
      }
      onFile(namedImage(await item.getType(type), type))
    } catch {
      setError('Clipboard access was not granted. You can upload an image instead.')
    } finally {
      setPasting(false)
    }
  }

  // Ctrl/Cmd+V on the media screen pastes a clipboard image straight in, like choosing Paste.
  useEffect(() => {
    if (stage !== 'media') return
    const onPaste = (e: globalThis.ClipboardEvent) => {
      const f = Array.from(e.clipboardData?.items ?? [])
        .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
        .map((i) => i.getAsFile())
        .find((f): f is File => !!f)
      if (!f) return
      e.preventDefault()
      onFile(f)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [stage, onFile])

  // Escape: back out one level.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (stage === 'camera') leaveCamera()
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, onClose])

  return (
    <div className="tintro">
      {/* 1 — welcome */}
      <section className={'tintro__layer tintro__welcome' + (stage === 'welcome' ? ' is-on' : '')} aria-hidden={stage !== 'welcome'}>
        <button type="button" className="tintro__x tintro__x--right" aria-label="Close Trace" onClick={onClose}>
          <Ic.IconClose size={22} />
        </button>
        <div className="tintro__hero">
          <div className="tintro__welcome-to">Welcome to</div>
          <h1 className="tintro__trace">TRACE</h1>
        </div>
        <button type="button" className="tintro__go" aria-label="Continue" onClick={() => setStage('media')}>
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="butt" strokeLinejoin="miter" aria-hidden="true">
            <path d="M4.5 12h14M13 5.5 19.5 12 13 18.5" />
          </svg>
        </button>
      </section>

      {/* 2 — choose media */}
      <section
        className={'tintro__layer tintro__media' + (stage === 'media' ? ' is-on' : '') + (dragOver ? ' is-over' : '')}
        aria-hidden={stage !== 'media'}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <button type="button" className="tintro__x tintro__x--right" aria-label="Close Trace" onClick={onClose}>
          <Ic.IconClose size={22} />
        </button>
        <div className="tintro__choices">
          <div className="tintro__sheet" role="radiogroup" aria-label="What are you tracing?">
            {SHEETS.map((o) => (
              <button
                key={o.kind}
                type="button"
                role="radio"
                aria-checked={sheet === o.kind}
                className={'tintro__sheet-opt' + (sheet === o.kind ? ' is-on' : '')}
                onClick={() => onSheet(o.kind)}
              >
                <img className="tintro__sheet-img" src={o.img} alt="" draggable={false} />
                <strong>{o.title}</strong>
                <span>{o.sub}</span>
              </button>
            ))}
          </div>
          <button type="button" className="tintro__box" onClick={() => fileRef.current?.click()}>
            <Ic.IconImportFile size={40} />
            <span>Upload from device</span>
          </button>
          <button type="button" className="tintro__box" onClick={() => void pasteImage()} disabled={pasting} title="Ctrl/Cmd+V">
            <Ic.IconPaste size={40} />
            <span>{pasting ? 'Reading clipboard…' : 'Paste image'}</span>
          </button>
          <button type="button" className="tintro__box" onClick={startCamera} disabled={asking}>
            <Ic.IconCamera size={40} />
            <span>{asking ? 'Waiting for camera…' : 'Use camera'}</span>
          </button>
        </div>
        {error && <div className="tintro__error" role="alert">{error}</div>}
      </section>

      {/* 3 — live camera */}
      <section className={'tintro__layer tintro__camera' + (stage === 'camera' ? ' is-on' : '')} aria-hidden={stage !== 'camera'}>
        <video ref={videoRef} className="tintro__video" playsInline muted autoPlay />
        {live && (
          // Same box as the video (object-fit: cover <-> slice), in video pixels.
          <svg className="tintro__live" viewBox={`0 0 ${live.vw} ${live.vh}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <polygon points={live.quad.map((p) => `${p.x},${p.y}`).join(' ')} className={'tintro__live-quad' + (live.locked ? ' is-locked' : '') + (live.window ? ' is-track' : '')} />
            {live.window && <polygon points={live.window.map((p) => `${p.x},${p.y}`).join(' ')} className="tintro__live-window" />}
            {live.quad.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={Math.max(live.vw, live.vh) * 0.008} className={'tintro__live-dot' + (live.locked ? ' is-locked' : '')} />
            ))}
          </svg>
        )}
        <button type="button" className="tintro__x tintro__x--left" aria-label="Back" onClick={leaveCamera}>
          <Ic.IconClose size={22} />
        </button>
        <div className="tintro__sheet tintro__sheet--cam" role="radiogroup" aria-label="What are you tracing?">
          {SHEETS.map((o) => (
            <button key={o.kind} type="button" role="radio" aria-checked={sheet === o.kind} className={'tintro__sheet-opt' + (sheet === o.kind ? ' is-on' : '')} onClick={() => onSheet(o.kind)}>
              <strong>{o.title}</strong>
            </button>
          ))}
        </div>
        <div className="tintro__shutter">
          {debug && lensInfo && <div className="tintro__lens-debug">{lensInfo}</div>}
          <div className={'tintro__badge' + (ready || locked ? ' is-on' : '') + (sheet === 'trace' && locked && !lensReady ? ' is-wait' : '')} role="status">
            {sheet === 'trace' ? (locked ? (lensReady ? 'Trace frame found' : 'Calibrating lens') : 'Ready to capture') : sheet === 'paper' && locked ? 'Paper found' : 'Ready to capture'}
          </div>
          <button
            type="button"
            className={'tintro__capture' + (ready ? ' is-ready' : '')}
            aria-label="Capture"
            aria-disabled={!ready || capturing}
            disabled={!ready || capturing}
            onClick={() => void capture()}
          />
        </div>
      </section>

      <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPick} />

    </div>
  )
}
