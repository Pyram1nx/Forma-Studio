import { beforeEach, describe, expect, it } from 'vitest'
import { groupAction, groupOutlineFor, newDoc, selectedGroup, useStore } from '../src/state/store'
import { createBasic } from '../src/editor/shapeFactory'
import { parseDoc, serialize } from '../src/io/projectFile'
import type { Group, Shape } from '../src/model/types'

beforeEach(() => useStore.getState().setDoc(newDoc('t')))

const st = () => useStore.getState()
const shape = (id: string) => st().doc.shapes.find((s) => s.id === id)!

function addRects(n: number): Shape[] {
  const rs = Array.from({ length: n }, (_, i) => createBasic('rect', i * 40, 0))
  st().addShapes(rs)
  return rs
}

describe('group / ungroup', () => {
  it('groups two or more objects into one new group, keeping them selected, in one undo step', () => {
    const [a, b, c] = addRects(3)
    st().select([a.id, b.id])
    expect(groupAction(st().doc, st().selection)).toBe('group')
    const pastBefore = st().past.length
    st().groupSelected()
    expect(st().past.length).toBe(pastBefore + 1)
    const gid = shape(a.id).groupId!
    expect(gid).toBeTruthy()
    expect(shape(b.id).groupId).toBe(gid)
    expect(shape(c.id).groupId).toBeUndefined()
    expect(st().doc.groups).toEqual([{ id: gid, name: 'Group', source: 'user' }])
    expect(st().selection).toEqual([a.id, b.id])
    // The selection is now exactly one group: the action switches to Ungroup.
    expect(selectedGroup(st().doc, st().selection)?.id).toBe(gid)
    expect(groupAction(st().doc, st().selection)).toBe('ungroup')

    st().undo()
    expect(st().doc.groups).toEqual([])
    expect(st().doc.shapes.every((s) => !s.groupId)).toBe(true)
    st().redo()
    expect(shape(a.id).groupId).toBe(gid)
  })

  it('needs two objects and names new groups Group, Group 2, …', () => {
    const [a, b, c, d] = addRects(4)
    st().select([a.id])
    expect(groupAction(st().doc, st().selection)).toBeNull()
    st().groupSelected()
    expect(st().doc.groups).toEqual([])
    st().select([a.id, b.id])
    st().groupSelected()
    st().select([c.id, d.id])
    st().groupSelected()
    expect(st().doc.groups.map((g) => g.name)).toEqual(['Group', 'Group 2'])
  })

  it('merges members of other groups into the new flat group and prunes the emptied groups', () => {
    const [a, b, c, d, e] = addRects(5)
    st().select([a.id, b.id])
    st().groupSelected()
    const g1 = shape(a.id).groupId!
    st().select([c.id, d.id])
    st().groupSelected()
    const g2 = shape(c.id).groupId!
    st().select([a.id, b.id, c.id, d.id, e.id])
    expect(groupAction(st().doc, st().selection)).toBe('group')
    st().groupSelected()
    const g3 = shape(a.id).groupId!
    expect(g3).not.toBe(g1)
    expect(g3).not.toBe(g2)
    expect([a, b, c, d, e].every((s) => shape(s.id).groupId === g3)).toBe(true)
    expect(st().doc.groups.map((g) => g.id)).toEqual([g3])
    st().undo()
    expect(st().doc.groups.map((g) => g.id).sort()).toEqual([g1, g2].sort())
    expect(shape(e.id).groupId).toBeUndefined()
  })

  it('ungroups a whole group, keeping its members selected, in one undo step', () => {
    const [a, b] = addRects(2)
    st().select([a.id, b.id])
    st().groupSelected()
    const gid = shape(a.id).groupId!
    const pastBefore = st().past.length
    st().ungroupSelected()
    expect(st().past.length).toBe(pastBefore + 1)
    expect(st().doc.groups).toEqual([])
    expect('groupId' in shape(a.id)).toBe(false)
    expect('groupId' in shape(b.id)).toBe(false)
    expect(st().selection).toEqual([a.id, b.id])
    expect(groupAction(st().doc, st().selection)).toBe('group')
    st().undo()
    expect(shape(a.id).groupId).toBe(gid)
    expect(st().doc.groups.map((g) => g.id)).toEqual([gid])
  })

  it('ungroup only applies to a whole group', () => {
    const [a, b, c] = addRects(3)
    st().select([a.id, b.id])
    st().groupSelected()
    const gid = shape(a.id).groupId!
    st().select([a.id]) // one member (Alt+click)
    expect(groupAction(st().doc, st().selection)).toBeNull()
    st().ungroupSelected()
    expect(shape(a.id).groupId).toBe(gid)
    st().select([a.id, b.id, c.id])
    st().ungroupSelected()
    expect(shape(a.id).groupId).toBe(gid)
  })

  it('leaves locked shapes out of grouping and ungrouping', () => {
    const [a, b, c] = addRects(3)
    st().updateShapes([c.id], (s) => ({ ...s, locked: true }))
    st().select([a.id, b.id, c.id])
    st().groupSelected()
    const gid = shape(a.id).groupId!
    expect(shape(b.id).groupId).toBe(gid)
    expect(shape(c.id).groupId).toBeUndefined()
    expect(st().selection).toEqual([a.id, b.id])

    // Only one unlocked shape: nothing to group.
    expect(groupAction(st().doc, [a.id, c.id])).toBeNull()

    // A group with a locked member: the selection (its unlocked members) is the group;
    // ungroup frees only the unlocked ones and the locked one keeps the group.
    st().updateShapes([b.id], (s) => ({ ...s, locked: true }))
    st().select([a.id])
    expect(selectedGroup(st().doc, st().selection)?.id).toBe(gid)
    st().ungroupSelected()
    expect(shape(a.id).groupId).toBeUndefined()
    expect(shape(b.id).groupId).toBe(gid)
    expect(st().doc.groups.map((g) => g.id)).toEqual([gid])
  })

  it('keeps feature groups (box joints, 3D carves) whole: no ungroup, no merge', () => {
    const [x] = addRects(1)
    const group: Group = { id: 'g-feature', name: '3D Carve', source: '3d' }
    const outline: Shape = { ...createBasic('rect', 100, 0), groupId: group.id, meta: { role: 'outline' } }
    const layer: Shape = { ...createBasic('rect', 100, 0), groupId: group.id }
    st().addGroupShapes(group, [outline, layer])
    expect(groupAction(st().doc, st().selection)).toBeNull()
    st().ungroupSelected()
    expect(shape(outline.id).groupId).toBe(group.id)

    st().select([x.id, outline.id, layer.id])
    expect(groupAction(st().doc, st().selection)).toBeNull()
    st().groupSelected()
    expect(shape(x.id).groupId).toBeUndefined()
    expect(shape(layer.id).groupId).toBe(group.id)
  })

  it('a user group is plain even with an outline-role member (no settings-object outline)', () => {
    const [a] = addRects(1)
    const traced: Shape = { ...createBasic('rect', 50, 0), meta: { source: 'paper', role: 'outline' } }
    st().addShapes([traced])
    st().select([a.id, traced.id])
    st().groupSelected()
    expect(groupOutlineFor(st().doc, st().selection)).toBeUndefined()
    expect(groupAction(st().doc, st().selection)).toBe('ungroup')
  })

  it('SVG import groups can be ungrouped', () => {
    st().importPayload({ group: { name: 'drawing.svg', source: 'svg' }, shapes: [createBasic('rect', 0, 0), createBasic('circle', 30, 0)] })
    expect(groupAction(st().doc, st().selection)).toBe('ungroup')
    st().ungroupSelected()
    expect(st().doc.groups).toEqual([])
  })

  it('user groups survive save and load', () => {
    const [a, b] = addRects(2)
    st().select([a.id, b.id])
    st().groupSelected()
    const back = parseDoc(serialize(st().doc))
    const g = back.groups[0]
    expect(g).toMatchObject({ name: 'Group', source: 'user' })
    expect(back.shapes.filter((s) => s.groupId === g.id).map((s) => s.id).sort()).toEqual([a.id, b.id].sort())
  })
})
