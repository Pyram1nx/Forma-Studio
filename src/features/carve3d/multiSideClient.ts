// Main-thread handle for the multi-side planner worker. One run at a time: `run` cancels
// whatever is in flight (by restarting the worker — the cheapest, most robust cancel), posts
// the analyze request, then the plan request. Stale replies are dropped by run id. Falls back
// to running inline when module workers are unavailable, still sliced across event-loop turns
// by the planner's own yields, so the page only ever pauses briefly.
import { CarveCancelled } from './carvePlan'
import { buildFinishedPart, type PartMesh } from './finishedPart'
import type { PlacedModel } from './loadModel'
import { buildLayeredPlan, type LayeredPlan, type LayeredSettings } from './layers'
import { analyzeSides, type SideAnalysis, type SideId } from './sideAnalysis'

export type AnalysisMap = Record<SideId, SideAnalysis>

export interface MultiSideHandlers {
  onAnalysis: (a: AnalysisMap) => void
  onPlan: (p: LayeredPlan) => void
  /** One layer's finished part of the last plan (null when there is nothing to show). */
  onPart: (layer: number, part: PartMesh | null, planKey: string) => void
  onProgress: (f: number) => void
  onError: (message: string) => void
}

export interface MultiSideClient {
  /** Cancel any run and start a new one. `settings = null` analyses only (no plan). */
  run(placed: PlacedModel, settings: LayeredSettings | null): void
  cancel(): void
  dispose(): void
}

type Req =
  | { type: 'analyze'; id: number; placed: PlacedModel }
  | { type: 'plan'; id: number; placed: PlacedModel; settings: LayeredSettings }

type Res =
  | { type: 'analysis'; id: number; analysis: AnalysisMap }
  | { type: 'progress'; id: number; f: number }
  | { type: 'plan'; id: number; plan: LayeredPlan }
  | { type: 'part'; id: number; layer: number; part: PartMesh | null }
  | { type: 'error'; id: number; message: string }

function spawnWorker(): Worker {
  return new Worker(new URL('./multiSideWorker.ts', import.meta.url), { type: 'module' })
}

export function createMultiSideClient(h: MultiSideHandlers): MultiSideClient {
  let worker: Worker | null = null
  let seq = 0
  let analysisId = -1
  let planId = -1
  let abortInline: (() => void) | null = null
  /** Key of the plan the next part belongs to. */
  let planKey = ''

  const cancelNow = () => {
    abortInline?.()
    abortInline = null
    if (worker) {
      worker.terminate()
      worker = null
    }
  }

  const ensure = (): Worker | null => {
    if (worker) return worker
    if (typeof Worker === 'undefined') return null
    try {
      worker = spawnWorker()
      worker.onmessage = (e: MessageEvent<Res>) => {
        const m = e.data
        if (m.type === 'analysis') {
          if (m.id === analysisId) h.onAnalysis(m.analysis)
        } else if (m.type === 'progress') {
          if (m.id === planId) h.onProgress(m.f)
        } else if (m.type === 'plan') {
          if (m.id === planId) {
            planKey = m.plan.key
            h.onPlan(m.plan)
          }
        } else if (m.type === 'part') {
          if (m.id === planId) h.onPart(m.layer, m.part, planKey)
        } else if (m.id === planId || m.id === analysisId) {
          h.onError(m.message)
        }
      }
      worker.onerror = () => {
        // A crashed worker (out of memory, script error) surfaces as an error on the live run.
        const message = 'The 3D carve worker crashed. Try a smaller step-down or fewer sides.'
        if (planId >= 0) h.onError(message)
        cancelNow()
      }
      return worker
    } catch {
      worker = null
      return null
    }
  }

  const post = (m: Req) => ensure()?.postMessage(m)

  const runInline = (placed: PlacedModel, settings: LayeredSettings | null) => {
    queueMicrotask(() => {
      let a: AnalysisMap
      try {
        a = analyzeSides(placed)
        h.onAnalysis(a)
      } catch (err) {
        h.onError(err instanceof Error ? err.message : String(err))
        return
      }
      if (!settings) return
      const ctrl = new AbortController()
      abortInline = () => ctrl.abort()
      buildLayeredPlan(placed, settings, h.onProgress, ctrl.signal, a)
        .then(async (p) => {
          h.onPlan(p)
          // A failure here only costs the preview, never the plan; a cancel stops it quietly.
          for (const l of p.layers) {
            const part = await buildFinishedPart(l.placed, l.plan, ctrl.signal).catch((err: unknown) => {
              if (err instanceof CarveCancelled) throw err
              return null
            })
            h.onPart(l.index, part, p.key)
          }
          abortInline = null
        })
        .catch((err: unknown) => {
          abortInline = null
          if (err instanceof CarveCancelled) return
          h.onError(err instanceof Error ? err.message : String(err))
        })
    })
  }

  return {
    run(placed, settings) {
      cancelNow()
      analysisId = ++seq
      planId = settings ? ++seq : -1
      const idA = analysisId
      const idP = planId
      if (ensure()) {
        post({ type: 'analyze', id: idA, placed })
        if (settings) post({ type: 'plan', id: idP, placed, settings })
      } else {
        runInline(placed, settings)
      }
    },
    cancel() {
      cancelNow()
    },
    dispose() {
      cancelNow()
    },
  }
}
