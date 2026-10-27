import { beforeEach, describe, expect, it } from 'vitest'
import { useStore, newDoc } from '../src/state/store'
import { createBasic } from '../src/editor/shapeFactory'
import { nudgeSelection, offsetSelection, parseLength, resizeSelection, rotateSelection, selectionBBox } from '../src/editor/ops'
import { editableIds } from '../src/state/store'
import { fmtLen, fmtNum, shapeFromWorld } from '../src/model/factory'
import { rect } from '../src/geometry/primitives'
import { exportSVG } from '../src/io/svgExport'

beforeEach(() => useStore.getState().setDoc(newDoc('t')))

describe('parseLength', () => {
  it('parses fractions, mixed numbers and units', () => {
    expect(parseLength('1/4', 'in')).toBeCloseTo(6.35)
    expect(parseLength('1 1/2', 'in')).toBeCloseTo(38.1)
    expect(parseLength('10mm', 'in')).toBeCloseTo(10)
    expect(parseLength('2in', 'mm')).toBeCloseTo(50.8)
    expect(parseLength('abc', 'mm')).toBeNull()
  })
})

describe('store', () => {
  it('undo/redo restores shapes', () => {
    const st = useStore.getState()
    st.addShapes([createBasic('rect', 0, 0)])
    expect(useStore.getState().doc.shapes.length).toBe(1)
    useStore.getState().undo()
    expect(useStore.getState().doc.shapes.length).toBe(0)
    useStore.getState().redo()
    expect(useStore.getState().doc.shapes.length).toBe(1)
  })
  it('resizing a rotated rectangle keeps its rotation', () => {
    const r = createBasic('rect', 0, 0)
    useStore.getState().addShapes([r])
    rotateSelection([r.id], 45, 'mc', true)
    const before = selectionBBox(useStore.getState().doc.shapes)!
    resizeSelection([r.id], (before.maxX - before.minX) * 2, null, 'mc')
    const s = useStore.getState().doc.shapes[0]
    const after = selectionBBox([s])!
    // still a diamond: bbox doubled in x, unchanged in y
    expect(after.maxX - after.minX).toBeCloseTo((before.maxX - before.minX) * 2, 3)
    expect(after.maxY - after.minY).toBeCloseTo(before.maxY - before.minY, 3)
  })
  it('exports real size with shaper attributes', () => {
    const r = createBasic('rect', 0, 0)
    useStore.getState().addShapes([r])
    useStore.getState().setCut([r.id], { depth: 6, type: 'pocket' })
    const svg = exportSVG(useStore.getState().doc)
    expect(svg).toContain('width="25.4mm"')
    expect(svg).toContain('shaper:cutType="pocket"')
    expect(svg).toContain('shaper:cutDepth="0.23622 in"')
  })
})

describe('parseLength (units)', () => {
  it('accepts comma decimals and rejects empty input', () => {
    expect(parseLength('2,5', 'mm')).toBeCloseTo(2.5)
    expect(parseLength('0,5in', 'mm')).toBeCloseTo(12.7)
    expect(parseLength('', 'in')).toBeNull()
    expect(parseLength('   ', 'in')).toBeNull()
  })
})

describe('fmtNum / fmtLen', () => {
  it('trims millimetres to at most 3 decimals', () => {
    expect(fmtNum(3.175, 'mm')).toBe('3.175')
    expect(fmtNum(25.4, 'mm')).toBe('25.4')
    expect(fmtNum(6, 'mm')).toBe('6')
    expect(fmtLen(3.175, 'mm')).toBe('3.175 mm')
  })
  it('shows inches with 3 decimals', () => {
    expect(fmtNum(3.175, 'in')).toBe('0.125')
    expect(fmtLen(25.4, 'in')).toBe('1.000 in')
  })
})

describe('locks', () => {
  it('deleteSelected never removes locked shapes', () => {
    const a = createBasic('rect', 0, 0)
    const b = { ...createBasic('rect', 50, 0), locked: true }
    useStore.getState().addShapes([a, b])
    useStore.getState().select([a.id, b.id])
    useStore.getState().deleteSelected()
    const left = useStore.getState().doc.shapes.map((s) => s.id)
    expect(left).toEqual([b.id])
  })
  it('moves, nudges and resizes skip locked shapes', () => {
    const a = createBasic('rect', 0, 0)
    const b = { ...createBasic('rect', 50, 0), locked: true }
    useStore.getState().addShapes([a, b])
    useStore.getState().select([a.id, b.id])
    const bx = useStore.getState().doc.shapes[1].x
    nudgeSelection(5, 0)
    resizeSelection([a.id, b.id], 10, null, 'tl')
    const after = useStore.getState().doc.shapes[1]
    expect(after.x).toBe(bx)
    expect(editableIds([a.id, b.id])).toEqual([a.id])
  })
  it('mirror leaves locked shapes alone', () => {
    const b = { ...createBasic('rect', 50, 0), locked: true }
    useStore.getState().addShapes([b])
    useStore.getState().select([b.id])
    useStore.getState().mirrorSelected('h')
    expect(useStore.getState().doc.shapes[0].x).toBe(b.x)
  })
  it('offset keeps locked source shapes and never removes them', () => {
    const b = { ...createBasic('rect', 0, 0), locked: true }
    useStore.getState().addShapes([b])
    useStore.getState().select([b.id])
    offsetSelection({ distance: 2, join: 'round', combine: false })
    const shapes = useStore.getState().doc.shapes
    expect(shapes.some((s) => s.id === b.id)).toBe(true)
    expect(shapes.length).toBe(2)
  })
  it('unlockAll clears locks and is undoable', () => {
    const b = { ...createBasic('rect', 0, 0), locked: true }
    useStore.getState().addShapes([b])
    useStore.getState().unlockAll()
    expect(useStore.getState().doc.shapes[0].locked).toBeFalsy()
    useStore.getState().undo()
    expect(useStore.getState().doc.shapes[0].locked).toBe(true)
  })
  it('selectGroup skips locked shapes', () => {
    const a = { ...createBasic('rect', 0, 0), groupId: 'g1' }
    const b = { ...createBasic('rect', 50, 0), groupId: 'g1', locked: true }
    useStore.getState().addShapes([a, b], false)
    useStore.getState().selectGroup('g1')
    expect(useStore.getState().selection).toEqual([a.id])
  })
})

describe('rotation and mirror', () => {
  it('bake turns a rotated parametric shape into a path (no unrotated rebuild)', () => {
    const r = createBasic('rect', 0, 0)
    useStore.getState().addShapes([r])
    rotateSelection([r.id], 30, 'mc', true)
    resizeSelection([r.id], 40, null, 'mc')
    const s = useStore.getState().doc.shapes[0]
    expect(s.kind).toBe('path')
    expect(s.params).toBeUndefined()
  })
  it('mirroring a rect keeps a usable path', () => {
    const r = createBasic('rect', 0, 0)
    useStore.getState().addShapes([r])
    useStore.getState().mirrorSelected('v')
    const s = useStore.getState().doc.shapes[0]
    expect(s.kind).toBe('path')
    expect(s.params).toBeUndefined()
    expect(s.contours[0].pts.length).toBeGreaterThan(2)
  })
  it('mirroring text keeps the text kind and params', () => {
    const t = { ...createBasic('rect', 0, 0), kind: 'text' as const, params: { text: 'hi', height: 25 } }
    useStore.getState().addShapes([t])
    useStore.getState().mirrorSelected('h')
    const s = useStore.getState().doc.shapes[0]
    expect(s.kind).toBe('text')
    expect(s.params).toEqual({ text: 'hi', height: 25 })
  })
})

describe('store history and selection', () => {
  it('units and settings are view preferences: not undo steps, and kept across undo/redo', () => {
    useStore.getState().addShapes([createBasic('rect', 0, 0)])
    const before = useStore.getState().past.length
    useStore.getState().setUnits('mm')
    useStore.getState().setSetting('cutPathDisplay', true)
    expect(useStore.getState().past.length).toBe(before)
    useStore.getState().undo() // undoes the rect, not the view prefs
    expect(useStore.getState().doc.shapes.length).toBe(0)
    expect(useStore.getState().doc.units).toBe('mm')
    expect(useStore.getState().doc.settings.cutPathDisplay).toBe(true)
    useStore.getState().redo()
    expect(useStore.getState().doc.shapes.length).toBe(1)
    expect(useStore.getState().doc.units).toBe('mm')
  })
  it('hidden and locked shapes are not editable', async () => {
    const { editableIds } = await import('../src/state/store')
    const a = createBasic('rect', 0, 0)
    const b = { ...createBasic('rect', 50, 0), locked: true }
    const c = { ...createBasic('rect', 100, 0), hidden: true }
    useStore.getState().addShapes([a, b, c])
    expect(editableIds([a.id, b.id, c.id])).toEqual([a.id])
  })
  it('bringToFront / sendToBack with no selection do nothing and do not checkpoint', () => {
    useStore.getState().addShapes([createBasic('rect', 0, 0)], false)
    const before = useStore.getState().past.length
    useStore.getState().select([])
    useStore.getState().bringToFront()
    useStore.getState().sendToBack()
    expect(useStore.getState().past.length).toBe(before)
  })
  it('duplicate gives copies their own groups', () => {
    const a = { ...createBasic('rect', 0, 0), groupId: 'g_orig' }
    useStore.setState({ doc: { ...useStore.getState().doc, groups: [{ id: 'g_orig', name: 'Set' }] } })
    useStore.getState().addShapes([a])
    useStore.getState().select([a.id])
    useStore.getState().duplicateSelected(false)
    const st = useStore.getState()
    const copy = st.doc.shapes[st.doc.shapes.length - 1]
    expect(copy.groupId).toBeDefined()
    expect(copy.groupId).not.toBe('g_orig')
    const grp = st.doc.groups.find((g) => g.id === copy.groupId)
    expect(grp?.name).toBe('Set copy')
  })
  it('duplicate offset is 1/4 in for inch documents and 5 mm for mm documents', () => {
    const a = createBasic('rect', 0, 0)
    useStore.getState().addShapes([a])
    useStore.getState().select([a.id])
    useStore.getState().duplicateSelected(false)
    let c = useStore.getState().doc.shapes[1]
    expect(c.x - a.x).toBeCloseTo(6.35)
    useStore.getState().setDoc({ ...useStore.getState().doc, units: 'mm' })
    useStore.getState().addShapes([a], false)
    useStore.getState().select([a.id])
    useStore.getState().duplicateSelected(false)
    c = useStore.getState().doc.shapes[useStore.getState().doc.shapes.length - 1]
    expect(c.x - a.x).toBeCloseTo(5)
  })
  it('markSaved only clears dirty for the document that was written', () => {
    useStore.getState().addShapes([createBasic('rect', 0, 0)])
    const written = useStore.getState().doc
    useStore.getState().addShapes([createBasic('rect', 30, 0)])
    useStore.getState().markSaved(written)
    expect(useStore.getState().dirty).toBe(true)
    useStore.getState().markSaved(useStore.getState().doc)
    expect(useStore.getState().dirty).toBe(false)
  })
  it('consecutive nudges share one undo checkpoint', () => {
    const a = createBasic('rect', 0, 0)
    useStore.getState().addShapes([a])
    useStore.getState().select([a.id])
    const before = useStore.getState().past.length
    nudgeSelection(1, 0)
    nudgeSelection(1, 0)
    nudgeSelection(1, 0)
    expect(useStore.getState().past.length).toBe(before + 1)
  })
  it('zoomToFit keeps a positive zoom on a tiny viewport', () => {
    useStore.getState().addShapes([createBasic('rect', 0, 0)])
    useStore.getState().setViewport(10, 10)
    useStore.getState().zoomToFit()
    expect(useStore.getState().view.zoom).toBeGreaterThan(0)
    useStore.getState().zoomIn()
    expect(useStore.getState().view.zoom).toBeGreaterThan(0)
  })
})

describe('shape from world', () => {
  it('centres geometry and keeps the requested cut', () => {
    const s = shapeFromWorld('path', 'r', rect(10, 10).map((c) => ({ ...c, pts: c.pts.map((p) => ({ x: p.x + 100, y: p.y })) })), {
      cut: { type: 'pocket', depth: 2, offset: 0, bitDia: 3 },
    })
    expect(s.x).toBeCloseTo(100)
    expect(s.cut.type).toBe('pocket')
  })
})

describe('group pruning', () => {
  it('deleting the last member of a group removes the group', () => {
    const a = shapeFromWorld('path', 'a', rect(10, 10), { groupId: 'g1' })
    const b = shapeFromWorld('path', 'b', rect(10, 10), { groupId: 'g2' })
    const groups = [
      { id: 'g1', name: 'one' },
      { id: 'g2', name: 'two' },
    ]
    useStore.getState().setDoc({ ...newDoc('t'), shapes: [a, b], groups })
    useStore.getState().select([a.id])
    useStore.getState().deleteSelected()
    expect(useStore.getState().doc.groups.map((g) => g.id)).toEqual(['g2'])
  })

  it('replaceShapes prunes groups that no shape uses any more', () => {
    const a = shapeFromWorld('path', 'a', rect(10, 10), { groupId: 'g1' })
    useStore.getState().setDoc({ ...newDoc('t'), shapes: [a], groups: [{ id: 'g1', name: 'one' }] })
    useStore.getState().replaceShapes([a.id], [shapeFromWorld('path', 'c', rect(5, 5))])
    expect(useStore.getState().doc.groups).toEqual([])
  })
})
