import { beforeEach, describe, expect, it } from 'vitest'
import { newDoc, REFERENCE_TOAST, selectionHasReference, useStore } from '../src/state/store'
import { createBasic } from '../src/editor/shapeFactory'
import { exportSVG } from '../src/io/svgExport'
import type { Shape } from '../src/model/types'

beforeEach(() => useStore.getState().setDoc(newDoc('t')))

const st = () => useStore.getState()
const shape = (id: string) => st().doc.shapes.find((s) => s.id === id)!

function addRects(n: number): Shape[] {
  const rs = Array.from({ length: n }, (_, i) => createBasic('rect', i * 40, 0))
  st().addShapes(rs)
  return rs
}

describe('reference paths (Studio: Set As Reference & Lock)', () => {
  it('sets the selection to reference in one undo step, keeps it selected and shows the toast', () => {
    const [a, b] = addRects(2)
    st().select([a.id])
    const pastBefore = st().past.length
    st().setReferenceSelected(true)
    expect(shape(a.id).locked).toBe(true)
    expect(shape(b.id).locked).toBeFalsy()
    expect(st().past.length).toBe(pastBefore + 1)
    expect(st().selection).toEqual([a.id])
    expect(st().toast).toBe(REFERENCE_TOAST)
    expect(st().toastInfo).toBe('reference')
    expect(selectionHasReference(st().doc, st().selection)).toBe(true)
    st().undo()
    expect(shape(a.id).locked).toBeFalsy()
  })

  it('Make Editable unlocks every selected reference without a toast', () => {
    const [a, b] = addRects(2)
    st().select([a.id, b.id])
    st().setReferenceSelected(true)
    st().showToast('other')
    st().setReferenceSelected(false)
    expect(shape(a.id).locked).toBe(false)
    expect(shape(b.id).locked).toBe(false)
    expect(st().toast).toBe('other')
    expect(st().selection).toEqual([a.id, b.id])
  })

  it('Cmd/Ctrl+H flips each selected object on its own', () => {
    const [a, b] = addRects(2)
    st().select([a.id])
    st().setReferenceSelected(true)
    st().select([a.id, b.id])
    st().toggleReferenceSelected()
    expect(shape(a.id).locked).toBe(false)
    expect(shape(b.id).locked).toBe(true)
  })

  it('Delete keeps references: silent with only references, removes the editable rest of a mixed selection', () => {
    const [a, b] = addRects(2)
    st().select([a.id])
    st().setReferenceSelected(true)
    st().showToast('before')
    st().deleteSelected()
    expect(st().doc.shapes).toHaveLength(2)
    expect(st().toast).toBe('before')
    st().select([a.id, b.id])
    st().deleteSelected()
    expect(st().doc.shapes.map((s) => s.id)).toEqual([a.id])
    expect(st().selection).toEqual([])
  })

  it('references leave the selection outside Design', () => {
    const [a, b] = addRects(2)
    st().select([a.id])
    st().setReferenceSelected(true)
    st().select([a.id, b.id])
    st().setMode('plan')
    expect(st().selection).toEqual([b.id])
  })

  it('references are left out of the exported cut file (kept for thumbnails)', () => {
    const [a] = addRects(2)
    st().select([a.id])
    st().setReferenceSelected(true)
    const count = (svg: string) => (svg.match(/<path/g) ?? []).length
    expect(count(exportSVG(st().doc))).toBe(1)
    expect(count(exportSVG(st().doc, undefined, { includeReference: true }))).toBe(2)
  })
})
