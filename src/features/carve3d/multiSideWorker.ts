// Web worker for the multi-side planner. Slicing, clipper booleans and the analysis are all
// pure JS on typed arrays, so they run happily off the UI thread; the page never blocks.
// One analyze message and one plan message per run; ids let the client drop stale replies.
import { buildFinishedPart, type PartMesh } from './finishedPart'
import { buildLayeredPlan, type LayeredPlan, type LayeredSettings } from './layers'
import type { PlacedModel } from './loadModel'
import { analyzeSides, type SideAnalysis, type SideId } from './sideAnalysis'

type Req =
  | { type: 'analyze'; id: number; placed: PlacedModel }
  | { type: 'plan'; id: number; placed: PlacedModel; settings: LayeredSettings }

type Res =
  | { type: 'analysis'; id: number; analysis: Record<SideId, SideAnalysis> }
  | { type: 'progress'; id: number; f: number }
  | { type: 'plan'; id: number; plan: LayeredPlan }
  | { type: 'part'; id: number; layer: number; part: PartMesh | null }
  | { type: 'error'; id: number; message: string }

// `self` typing without pulling the WebWorker lib into the app's tsconfig.
const ctx = self as unknown as {
  postMessage: (m: Res, transfer?: Transferable[]) => void
  onmessage: ((e: MessageEvent<Req>) => void) | null
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * The analysis of the run's model. The client posts analyze then plan for the same model, and
 * a new model always comes with a fresh worker, so the plan reuses it instead of re-analysing.
 */
let lastAnalysis: Record<SideId, SideAnalysis> | undefined

ctx.onmessage = (e) => {
  const msg = e.data
  try {
    if (msg.type === 'analyze') {
      lastAnalysis = analyzeSides(msg.placed)
      ctx.postMessage({ type: 'analysis', id: msg.id, analysis: lastAnalysis })
      return
    }
    buildLayeredPlan(msg.placed, msg.settings, (f) => ctx.postMessage({ type: 'progress', id: msg.id, f }), undefined, lastAnalysis)
      .then(async (plan) => {
        ctx.postMessage({ type: 'plan', id: msg.id, plan })
        // Each layer's finished part (every side applied to its board) follows the plan, one
        // layer at a time: the plan is usable as soon as it lands, the parts fill in after.
        for (const l of plan.layers) {
          // A failure here only costs the preview, never the plan.
          const part = await buildFinishedPart(l.placed, l.plan).catch(() => null)
          ctx.postMessage({ type: 'part', id: msg.id, layer: l.index, part }, part ? [part.positions.buffer, part.indices.buffer] : [])
        }
      })
      .catch((err: unknown) => ctx.postMessage({ type: 'error', id: msg.id, message: text(err) }))
  } catch (err) {
    ctx.postMessage({ type: 'error', id: msg.id, message: text(err) })
  }
}
