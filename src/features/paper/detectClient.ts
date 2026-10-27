// Runs sheet detection in its own worker (see detectWorker.ts), falling back to
// the main thread where workers are unavailable. Each Detector owns one worker
// and one job at a time: the live camera preview simply skips frames while a
// detection is still running, so work never queues up.
import { detectPaperRgba, type DetectOptions, type DetectResult } from './detect'
import type { DetectRequest } from './detectWorker'

export class Detector {
  private worker: Worker | null = null
  private broken = false
  private nextId = 1
  private pending: { id: number; resolve: (r: DetectResult) => void; reject: (e: Error) => void } | null = null

  /** True while a detection is running. */
  get busy(): boolean {
    return this.pending !== null
  }

  private getWorker(): Worker | null {
    if (this.broken || typeof Worker === 'undefined') return null
    if (!this.worker) {
      try {
        this.worker = new Worker(new URL('./detectWorker.ts', import.meta.url), { type: 'module' })
        this.worker.onmessage = (e: MessageEvent) => {
          const p = this.pending
          if (!p || e.data.id !== p.id) return
          this.pending = null
          if (e.data.ok) p.resolve(e.data.result)
          else p.reject(new Error(e.data.error))
        }
        this.worker.onerror = () => {
          const p = this.pending
          this.pending = null
          this.broken = true
          this.worker?.terminate()
          this.worker = null
          p?.reject(new Error('detect worker failed'))
        }
      } catch {
        this.broken = true
        return null
      }
    }
    return this.worker
  }

  /** Detect the sheet in RGBA pixels. The buffer is transferred to the worker (do not reuse it). */
  detect(rgba: Uint8ClampedArray, w: number, h: number, opts: DetectOptions = {}): Promise<DetectResult> {
    const wk = this.getWorker()
    if (!wk) return Promise.resolve(detectPaperRgba(rgba, w, h, opts))
    this.cancel()
    const id = this.nextId++
    return new Promise<DetectResult>((resolve, reject) => {
      this.pending = { id, resolve, reject }
      const req: DetectRequest = { id, rgba, w, h, opts }
      wk.postMessage(req, [rgba.buffer])
    })
  }

  /**
   * Detect the sheet on a canvas (copies its pixels). If the worker fails, the
   * detection runs on the main thread instead.
   */
  async detectCanvas(c: HTMLCanvasElement, opts: DetectOptions = {}): Promise<DetectResult> {
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('no 2d context')
    const grab = () => ctx.getImageData(0, 0, c.width, c.height).data
    try {
      return await this.detect(grab(), c.width, c.height, opts)
    } catch (err) {
      if (!this.broken) throw err
      return detectPaperRgba(grab(), c.width, c.height, opts)
    }
  }

  /** Abandon the running job (its promise rejects). */
  cancel(): void {
    const p = this.pending
    if (!p) return
    this.pending = null
    p.reject(new Error('cancelled'))
  }

  dispose(): void {
    this.cancel()
    this.worker?.terminate()
    this.worker = null
  }
}
