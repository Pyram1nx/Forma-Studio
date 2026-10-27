// Web Worker for sheet detection, so finding the paper never blocks the UI:
// the full-size detection after a photo is taken, and the live outline shown
// over the camera preview several times a second.
import { detectPaperRgba, type DetectOptions } from './detect'

export interface DetectRequest {
  id: number
  rgba: Uint8ClampedArray
  w: number
  h: number
  opts: DetectOptions
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<DetectRequest>) => void) | null
  postMessage(message: unknown): void
}

const scope = self as unknown as WorkerScope

scope.onmessage = (e: MessageEvent<DetectRequest>) => {
  const { id, rgba, w, h, opts } = e.data
  try {
    scope.postMessage({ id, ok: true, result: detectPaperRgba(rgba, w, h, opts) })
  } catch (err) {
    scope.postMessage({ id, ok: false, error: String(err) })
  }
}
