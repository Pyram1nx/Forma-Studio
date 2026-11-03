import { it, expect } from 'vitest'
import { useStore } from '../../src/state/store'
import { penShapeFrom } from '../../src/editor/canvas/usePen'
import { bake } from '../../src/geometry/transform'
import { mapPen, moveNode, nearestOnPen, penOf, withPen, toggleSmooth, deleteNode } from '../../src/geometry/pen'
import { snapPoint, snapKindsOn, alignLines } from '../../src/editor/snapTargets'
import { toWorld } from '../../src/geometry/transform'

it('pen flow at 1% zoom terminates', () => {
  const t0 = performance.now()
  const z = 0.01
  const W = (x: number, y: number) => ({ x: x / z, y: y / z })
  const a = W(362, 434), b = W(512, 334), c = W(662, 484)
  const out = { x: b.x + 8000, y: b.y }
  const s = penShapeFrom([{ ...a }, { ...b, out, in: { x: 2 * b.x - out.x, y: b.y }, smooth: true }, { ...c }], true)!
  const st = useStore.getState()
  st.addShapes([s])
  const on = snapKindsOn(st.doc.settings)
  const hit = snapPoint(W(500, 400), [s], on, 6 / z, {})
  expect(hit).toBeTruthy()
  alignLines([s], on)
  st.patchShapes([s.id], bake)
  let sh = useStore.getState().doc.shapes[0]
  const pens = mapPen(penOf(sh)!, (p) => toWorld(sh, p))
  nearestOnPen(pens, W(512, 384))
  for (let i = 0; i < 20; i++) {
    sh = useStore.getState().doc.shapes[0]
    const pc = penOf(sh)!
    const nodes = pc[0].nodes.slice()
    nodes[1] = moveNode(nodes[1], { x: nodes[1].x, y: nodes[1].y + 100 })
    st.patchShapes([sh.id], (x) => withPen(x, [{ closed: true, nodes }]))
    snapPoint(W(512, 384 + i), [], on, 6 / z, {})
  }
  sh = useStore.getState().doc.shapes[0]
  toggleSmooth(penOf(sh)![0], 1)
  deleteNode(penOf(sh)![0], 1)
  console.log('ms', performance.now() - t0, sh.contours[0].pts.length)
})
