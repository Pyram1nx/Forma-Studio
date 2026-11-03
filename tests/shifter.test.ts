import { beforeEach, describe, expect, it } from 'vitest'
import { useStore, newDoc } from '../src/state/store'
import { createBasic } from '../src/editor/shapeFactory'
import { finishShapeShifter } from '../src/editor/ops'
import { world } from '../src/editor/geomCache'
import { bboxOfContours } from '../src/geometry/transform'

beforeEach(() => useStore.getState().setDoc(newDoc('t')))

/** Two overlapping squares, selected. */
function addPair() {
  const a = createBasic('rect', 0, 0)
  const b = createBasic('rect', 12, 0)
  useStore.getState().addShapes([a, b])
  return [a, b]
}

describe('ShapeShifter re-editing', () => {
  it('records the merge on the result and selects it', () => {
    const [a, b] = addPair()
    finishShapeShifter([a, b], [world(a), world(b)], false)
    const after = useStore.getState().doc.shapes
    expect(after.length).toBe(1)
    expect(after[0].meta?.shifterOf).toEqual([a.id, b.id])
    expect(after[0].meta?.shifterSources?.length).toBe(2)
    expect(useStore.getState().selection).toEqual([after[0].id])
  })

  it('a single result re-enters on its surviving sources, replacing the result on finish', () => {
    const [a, b] = addPair()
    finishShapeShifter([a, b], [world(a), world(b)], true)
    const r = useStore.getState().doc.shapes.find((s) => s.meta?.shifterOf)!
    useStore.getState().select([r.id])
    useStore.getState().enterShapeShifter()
    expect(useStore.getState().shifter).toEqual({ ids: [a.id, b.id], editId: r.id })
    finishShapeShifter([a, b], [world(a), world(b)], false, r.id)
    // Sources and the old result are all consumed by the re-edit.
    const after = useStore.getState().doc.shapes
    expect(after.length).toBe(1)
    expect(after[0].id).not.toBe(r.id)
    expect(after[0].meta?.shifterOf).toEqual([a.id, b.id])
  })

  it('re-enters on ghosts rebuilt from the snapshot once its sources are gone', () => {
    const [a, b] = addPair()
    finishShapeShifter([a, b], [world(a), world(b)], false)
    const r = useStore.getState().doc.shapes[0]
    useStore.getState().select([r.id])
    useStore.getState().enterShapeShifter()
    const sh = useStore.getState().shifter!
    expect(sh.ids).toEqual([])
    expect(sh.editId).toBe(r.id)
    expect(sh.ghosts?.length).toBe(2)
    // The ghosts land where the originals were.
    const [ga, gb] = sh.ghosts!
    const want = [bboxOfContours(world(a)), bboxOfContours(world(b))]
    const got = [bboxOfContours(world(ga)), bboxOfContours(world(gb))]
    for (let i = 0; i < 2; i++)
      for (const k of ['minX', 'minY', 'maxX', 'maxY'] as const) expect(got[i][k]).toBeCloseTo(want[i][k], 3)
    // Finishing the re-edit replaces the old result and keeps the root provenance.
    finishShapeShifter(sh.ghosts!, [world(ga), world(gb)], true, r.id)
    const after = useStore.getState().doc.shapes
    expect(after.length).toBe(1)
    expect(after[0].id).not.toBe(r.id)
    expect(after[0].meta?.shifterOf).toEqual([a.id, b.id])
  })

  it('two selected shapes enter the mode without an edit target', () => {
    const [a, b] = addPair()
    useStore.getState().enterShapeShifter()
    expect(useStore.getState().shifter).toEqual({ ids: [a.id, b.id] })
  })

  it('a single shape that is not a merge result is refused', () => {
    const [a] = addPair()
    useStore.getState().select([a.id])
    useStore.getState().enterShapeShifter()
    expect(useStore.getState().shifter).toBeNull()
    expect(useStore.getState().toast).toBe('Select two or more overlapping shapes')
  })
})
