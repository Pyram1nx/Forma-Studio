// Typesetting a text shape: shared by the Edit Text dialog and the font menu.
import { useStore, withoutCheckpoint } from '../state/store'
import type { Contour, Shape } from '../model/types'
import { DEFAULT_FONT, DEFAULT_STYLE, resolveFont, textToContours } from '../io/text'

export const textParams = (s: Shape) => ({
  text: String(s.params?.text ?? ''),
  font: String(s.params?.font ?? DEFAULT_FONT),
  fontStyle: String(s.params?.fontStyle ?? DEFAULT_STYLE),
  height: Number(s.params?.height) > 0 ? Number(s.params?.height) : 25,
})

export const textName = (text: string) => text.split('\n')[0].slice(0, 32)

/** Studio says so when the chosen font lacked glyphs and another was substituted. */
export const FALLBACK_FONT_MESSAGE = 'Font changed to support all characters'

/** Contours for the text in the requested font, falling back like Studio when glyphs are missing. */
export async function typeset(text: string, font: string, fontStyle: string, height: number) {
  const r = await resolveFont(text, font, fontStyle)
  const contours = await textToContours(text, r.font, height, r.style)
  return { ...r, contours }
}

/** Snapshot taken before a hover preview so it can be put back. */
export interface TextSnapshot {
  contours: Contour[]
  params: Shape['params']
  name: string
}

export const snapshotOf = (s: Shape): TextSnapshot => ({ contours: s.contours, params: s.params, name: s.name })

/** Show a font on the canvas without touching undo history. */
export function previewText(id: string, contours: Contour[]) {
  withoutCheckpoint(() => useStore.getState().updateShapes([id], (s) => ({ ...s, contours })))
}

export function restoreText(id: string, snap: TextSnapshot) {
  withoutCheckpoint(() => useStore.getState().updateShapes([id], (s) => ({ ...s, contours: snap.contours, params: snap.params, name: snap.name })))
}

/** Commit new text, font or style for a shape as one undo step. */
export async function applyText(id: string, patch: Partial<{ text: string; font: string; fontStyle: string }>) {
  const st = useStore.getState()
  const shape = st.doc.shapes.find((s) => s.id === id)
  if (!shape || shape.locked) return
  const cur = textParams(shape)
  const next = { ...cur, ...patch }
  try {
    const r = await typeset(next.text, next.font, next.fontStyle, next.height)
    st.updateShapes([id], (s) => ({
      ...s,
      contours: r.contours,
      name: textName(next.text),
      params: { ...s.params, text: next.text, font: r.font, fontStyle: r.style, height: next.height },
    }))
    if (r.changed) st.showToast(FALLBACK_FONT_MESSAGE)
  } catch (e) {
    st.showToast('Could not create text: ' + (e as Error).message)
  }
}
