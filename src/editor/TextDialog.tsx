import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { useStore } from '../state/store'
import * as Ic from '../ui/icons'
import { DEFAULT_FONT, DEFAULT_STYLE } from '../io/text'
import { uid } from '../model/ids'
import { MM_PER_IN } from '../model/types'
import { newShapeCut } from '../state/prefs'
import { IconEditText } from './fontIcons'
import { FALLBACK_FONT_MESSAGE, applyText, textName, typeset } from './textOps'

/** Default cap height: 1 in, or 25 mm in a millimetre document. */
const defaultHeight = (units: 'in' | 'mm') => (units === 'in' ? MM_PER_IN : 25)

/**
 * Studio's full-screen "Edit Text" dialog: one line of text, Place Text or cancel. The font is
 * chosen afterwards in the text's properties; text becomes cuttable outlines.
 */
export default function TextDialog() {
  const dialog = useStore((s) => s.dialog)
  const editingId = useStore((s) => s.editingTextId)
  const shapes = useStore((s) => s.doc.shapes)
  const units = useStore((s) => s.doc.units)
  const editing = editingId ? shapes.find((s) => s.id === editingId) : undefined
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [width, setWidth] = useState(100)
  const ref = useRef<HTMLInputElement>(null)
  const measure = useRef<HTMLSpanElement>(null)
  const open = dialog === 'text'
  const placeholder = editing ? 'Edit Text' : 'Insert Text'

  useEffect(() => {
    if (!open) return
    // Studio's field is a single line: line breaks from older documents become spaces.
    setText(editing ? String(editing.params?.text ?? '').replace(/\s*\n\s*/g, ' ') : '')
    const t = setTimeout(() => ref.current?.focus(), 30)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // The field is as wide as what is typed (or its placeholder), centred on the page.
  useLayoutEffect(() => {
    if (open && measure.current) setWidth(Math.max(100, Math.ceil(measure.current.getBoundingClientRect().width) + 4))
  }, [open, text, placeholder])

  // Escape closes from anywhere in the dialog (the global shortcut handler is suppressed while a dialog is open).
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useStore.getState().openDialog(null)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [open])

  if (!open) return null
  const st = useStore.getState
  const close = () => st().openDialog(null)

  const place = async (e: FormEvent) => {
    e.preventDefault()
    const entry = text.trim()
    if (!entry || busy) return
    setBusy(true)
    try {
      if (editing && !editing.locked) {
        await applyText(editing.id, { text: entry })
      } else {
        const h = defaultHeight(units)
        const r = await typeset(entry, DEFAULT_FONT, DEFAULT_STYLE, h)
        const { view, viewport } = st()
        st().addShapes([
          {
            id: uid(),
            name: textName(entry),
            kind: 'text',
            params: { text: entry, font: r.font, fontStyle: r.style, height: h },
            contours: r.contours,
            pen: r.pen,
            x: (viewport.w / 2 - view.panX) / view.zoom,
            y: (viewport.h / 2 - view.panY) / view.zoom,
            rotation: 0,
            sx: 1,
            sy: 1,
            cut: newShapeCut(),
          },
        ])
        if (r.changed) st().showToast(FALLBACK_FONT_MESSAGE)
      }
      close()
      // Like Studio, the text's properties open (the phone's bottom sheet) once it is placed.
      window.dispatchEvent(new Event('ss:open-props-sheet'))
    } catch (err) {
      st().showToast('Could not create text: ' + (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ss-dialog text-tool-dialog" role="dialog" aria-modal="true" aria-label="Edit Text" data-cy="text-tool-dialog">
      <div className="text-tool-dialog--heading">
        <IconEditText />
        Edit Text
      </div>
      <form className="text-tool-dialog--form" onSubmit={place} onReset={close}>
        <div className="text-tool-dialog--content">
          <input
            ref={ref}
            className="text-tool-dialog--input"
            type="text"
            name="textEntry"
            aria-label="Text"
            data-cy="add-text-input"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={placeholder}
            value={text}
            style={{ width }}
            onChange={(e) => setText(e.target.value)}
          />
          <span ref={measure} className="text-tool-dialog--measure" aria-hidden="true">
            {text || placeholder}
          </span>
        </div>
        <div className="text-tool-dialog--actions">
          <button className="text-tool-dialog--submit-button" type="submit" disabled={busy}>
            Place Text
          </button>
          <button className="text-tool-dialog--cancel-button" type="reset" aria-label="Cancel">
            <Ic.IconClose />
          </button>
        </div>
      </form>
    </div>
  )
}
