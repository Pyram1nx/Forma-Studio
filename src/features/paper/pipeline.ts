// Runs the ink and vectorise steps in a module worker when one is available.
// A new job cancels the one in flight (its promise rejects with CancelledError),
// so slider changes never queue up stale work. Falls back to the main thread,
// where the work yields to the UI between steps.
import { buildInkMask, type InkOptions } from './ink'
import { imageInkMask, type ImageMaskOptions } from './imageMask'
import { vectorise, type VectorMode, type VectorResult } from './trace'
import type { WorkerRequest } from './worker'

export class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

let worker: Worker | null = null
let workerBroken = false
let nextId = 1
let pending: { id: number; reject: (e: Error) => void; kill: () => void } | null = null

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === 'undefined') return null
  if (!worker) {
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    } catch {
      workerBroken = true
      return null
    }
  }
  return worker
}

/** Cancel whatever job is running. */
export function cancelPaperJobs(): void {
  if (pending) {
    const p = pending
    pending = null
    p.kill()
    p.reject(new CancelledError())
  }
}

/** Dispatch a request to the worker and resolve with its reply. */
function dispatch<T>(req: WorkerRequest, transfer: Transferable[]): Promise<T> {
  cancelPaperJobs()
  const w = getWorker()
  if (!w) return Promise.reject(new Error('no worker'))
  return new Promise<T>((resolve, reject) => {
    const id = req.id
    const onMsg = (e: MessageEvent) => {
      if (e.data.id !== id) return
      cleanup()
      pending = null
      if (e.data.ok) resolve(e.data.mask ?? e.data.result)
      else reject(new Error(e.data.error))
    }
    const onErr = () => {
      cleanup()
      pending = null
      workerBroken = true
      worker?.terminate()
      worker = null
      reject(new Error('worker failed'))
    }
    const cleanup = () => {
      w.removeEventListener('message', onMsg)
      w.removeEventListener('error', onErr)
    }
    w.addEventListener('message', onMsg)
    w.addEventListener('error', onErr)
    pending = {
      id,
      reject,
      kill: () => {
        cleanup()
        // Terminating drops the whole worker, which is the only real cancel for a busy thread.
        worker?.terminate()
        worker = null
      },
    }
    w.postMessage(req, transfer)
  })
}

/** Ink mask for a flattened grayscale paper image. */
export async function runInk(gray: Uint8Array, w: number, h: number, opts: InkOptions): Promise<Uint8Array> {
  const id = nextId++
  if (getWorker()) {
    try {
      const copy = gray.slice()
      return await dispatch<Uint8Array>({ id, type: 'ink', gray: copy, w, h, opts }, [copy.buffer])
    } catch (err) {
      if (err instanceof CancelledError) throw err
      // Worker failed: fall through to the main thread.
    }
  }
  if (pending) cancelPaperJobs()
  return buildInkMask(gray, w, h, opts)
}

/** Design mask for any image (no sheet of paper involved). */
export async function runImageMask(img: ImageData, opts: ImageMaskOptions): Promise<Uint8Array> {
  const id = nextId++
  if (getWorker()) {
    try {
      const copy = img.data.slice()
      return await dispatch<Uint8Array>({ id, type: 'image', rgba: copy, w: img.width, h: img.height, opts }, [copy.buffer])
    } catch (err) {
      if (err instanceof CancelledError) throw err
    }
  }
  if (pending) cancelPaperJobs()
  return imageInkMask(img.data, img.width, img.height, opts)
}

/** Millimetre geometry for an ink mask. */
export async function runVector(
  mask: Uint8Array,
  w: number,
  h: number,
  ppm: number,
  mode: VectorMode,
  ppmY: number = ppm,
): Promise<VectorResult> {
  const id = nextId++
  if (getWorker()) {
    try {
      const copy = mask.slice()
      return await dispatch<VectorResult>({ id, type: 'vector', mask: copy, w, h, ppm, ppmY, mode }, [copy.buffer])
    } catch (err) {
      if (err instanceof CancelledError) throw err
    }
  }
  if (pending) cancelPaperJobs()
  return vectorise(mask, w, h, ppm, mode, ppmY)
}
