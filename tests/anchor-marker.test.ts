import { describe, expect, it } from 'vitest'
import { useStore } from '../src/state/store'
import { createBasic } from '../src/editor/shapeFactory'

describe('custom anchor marker', () => {
  it('goes away when a stock point is picked or its shape is deleted', () => {
    const st = useStore.getState()
    const a = createBasic('rect', 0, 0)
    st.addShapes([a])
    useStore.getState().setOriginPoint({ fx: 0.3, fy: 0.3 })
    useStore.getState().setCustomAnchor({ x: 3, y: 3 })
    expect(useStore.getState().doc.settings.customAnchor).toBeTruthy()
    useStore.getState().setOriginPoint('tl')
    expect(useStore.getState().doc.settings.customAnchor).toBeUndefined()

    useStore.getState().setOriginPoint({ fx: 0.3, fy: 0.3 })
    useStore.getState().setCustomAnchor({ x: 3, y: 3 })
    useStore.getState().select([a.id])
    useStore.getState().deleteSelected()
    expect(useStore.getState().doc.settings.customAnchor).toBeUndefined()
    expect(useStore.getState().doc.settings.originPoint).toBe('mc')
  })
})
