// Web Worker for the heavy Paper Scan steps: ink extraction (from a sheet or
// from any image), colour-layer splitting and vectorising.
// Buffers move by transfer, so the photo never has to be copied back.
import { buildInkMask, type InkOptions } from './ink'
import { designLayers, imageInkMask, type ImageMaskOptions } from './imageMask'
import { vectorise, type VectorMode } from './trace'

export type WorkerRequest =
  | { id: number; type: 'ink'; gray: Uint8Array; w: number; h: number; opts: InkOptions }
  | { id: number; type: 'image'; rgba: Uint8ClampedArray; w: number; h: number; opts: ImageMaskOptions }
  | { id: number; type: 'layers'; rgba: Uint8ClampedArray; w: number; h: number; detail: number }
  | { id: number; type: 'vector'; mask: Uint8Array; w: number; h: number; ppm: number; ppmY: number; mode: VectorMode }

interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

const scope = self as unknown as WorkerScope

scope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  try {
    if (msg.type === 'ink') {
      const mask = buildInkMask(msg.gray, msg.w, msg.h, msg.opts)
      scope.postMessage({ id: msg.id, ok: true, mask }, [mask.buffer])
    } else if (msg.type === 'image') {
      const mask = imageInkMask(msg.rgba, msg.w, msg.h, msg.opts)
      scope.postMessage({ id: msg.id, ok: true, mask }, [mask.buffer])
    } else if (msg.type === 'layers') {
      const layers = designLayers(msg.rgba, msg.w, msg.h, msg.detail)
      const masks = layers.map((l) => l.mask)
      const colors = layers.map((l) => l.color)
      scope.postMessage({ id: msg.id, ok: true, result: { masks, colors } }, masks.map((m) => m.buffer))
    } else {
      const result = await vectorise(msg.mask, msg.w, msg.h, msg.ppm, msg.mode, msg.ppmY)
      scope.postMessage({ id: msg.id, ok: true, result })
    }
  } catch (err) {
    scope.postMessage({ id: msg.id, ok: false, error: String(err) })
  }
}
