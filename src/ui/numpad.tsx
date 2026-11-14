// On-screen numeric keypad for touch devices. Focusing any number field — sizes, rotation,
// depth, offset, radius, grid spacing, counts — opens this pad instead of the phone or tablet
// keyboard: big targets, no autocorrect, and dimension-specific keys — a sign toggle, an In/mm
// switch that converts the entry as it flips, and an operator column so "3/8" or "25.4*2" can be
// typed out and evaluated before Done lands it in the field. Mouse-and-keyboard devices never
// see the pad: everything below is gated on a coarse primary pointer, and there the fields keep
// their plain typing behaviour.
//
// The entry lives in the field itself, written through the same native setter the caliper input
// uses so React's onChange fires and each field's own commit-on-blur keeps working. Done (and
// the = key) evaluate with normal precedence; Done also converts an entry made in the other unit
// back to the document's units. Cancel — or the banner's back arrow — puts back what the field
// showed when the pad opened. Tapping anywhere outside the pad blurs the field, which commits
// the entry the same way a hardware Enter would.
import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MM_PER_IN } from '../model/types'
import { CALIPER_ICON } from './caliperInput'

/** The unit an entry is typed in, shown in the banner: the document's unit, the other length unit, degrees or none. */
type EntryUnit = '' | 'mm' | 'in' | 'º'

interface Pad {
  input: HTMLInputElement
  label: string
  /** The field's own unit: what Done commits in, and where the entry starts. */
  docUnit: EntryUnit
  /** The unit the entry is being typed in; flips with the In/mm key. */
  entryUnit: EntryUnit
  /** Whole-number entry (counts): digits and delete only. */
  int: boolean
  /** The field's text when the pad opened; Cancel puts it back. */
  orig: string
}

/** A field the pad takes over: number entries only, never opted-out fields. */
function isPadField(el: Element | null): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement) || el.readOnly || el.disabled) return false
  if (el.dataset.pad === 'off') return false
  return el.inputMode === 'decimal' || el.inputMode === 'numeric' || el.type === 'number'
}

/** Evaluate a typed entry: numbers with + - * / at their usual precedence, unary minus allowed. Null when incomplete or invalid. */
function evalEntry(text: string): number | null {
  const src = text.trim()
  let i = 0
  const num = (): number | null => {
    const m = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(src.slice(i))
    if (!m) return null
    i += m[0].length
    return parseFloat(m[0])
  }
  const unary = (): number | null => {
    if (src[i] === '-') {
      i++
      const v = unary()
      return v == null ? null : -v
    }
    if (src[i] === '+') {
      i++
      return unary()
    }
    return num()
  }
  const term = (): number | null => {
    let v = unary()
    if (v == null) return null
    while (src[i] === '*' || src[i] === '/') {
      const op = src[i++]
      const r = unary()
      if (r == null) return null
      if (op === '/' && r === 0) return null
      v = op === '*' ? v * r : v / r
    }
    return v
  }
  const expr = (): number | null => {
    let v = term()
    if (v == null) return null
    while (src[i] === '+' || src[i] === '-') {
      const op = src[i++]
      const r = term()
      if (r == null) return null
      v = op === '+' ? v + r : v - r
    }
    return v
  }
  const v = expr()
  return v != null && Number.isFinite(v) && i === src.length ? v : null
}

/** Flip the sign of the number being typed: negate the trailing operand, or start a negative one after an operator. */
function toggleSign(buf: string): string {
  let i = buf.length
  while (i > 0 && /[\d.]/.test(buf[i - 1])) i--
  if (i === 0) return '-' + buf // the whole entry so far is one number: negate it
  const prev = buf[i - 1]
  if (i === buf.length) {
    // The entry ends on an operator, or is a lone sign: start or drop the negative operand.
    if (prev === '-' && (i === 1 || '+-*/'.includes(buf[i - 2]))) return buf.slice(0, -1)
    return buf + '-'
  }
  if (prev === '-') {
    if (i === 1 || '+-*/'.includes(buf[i - 2])) return buf.slice(0, i - 1) + buf.slice(i) // already signed: drop the sign
    return buf.slice(0, i - 1) + '+' + '-' + buf.slice(i) // a subtraction becomes an added negative
  }
  return buf.slice(0, i) + '-' + buf.slice(i) // negate the trailing operand (it follows + * / or stray text)
}

/** Convert between length units; null when either side has none (degrees, counts), so there is nothing to convert. */
function convertUnit(v: number, from: EntryUnit, to: EntryUnit): number | null {
  const lengths = from === 'mm' || from === 'in'
  return lengths && (to === 'mm' || to === 'in') ? (from === 'in' ? v * MM_PER_IN : v / MM_PER_IN) : null
}

/** Round an entry for the field: inches keep four decimals (a caliper's), millimetres three, bare numbers five. */
function fmtEntry(v: number, unit: EntryUnit): string {
  return String(Number(v.toFixed(unit === 'in' ? 4 : unit === 'mm' ? 3 : 5)))
}

/** The native setter bypasses React's value tracking so its onChange fires — the caliper input's trick. */
function setFieldValue(el: HTMLInputElement, text: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Set by NumpadHost so the document-level focusin listener can reach the React side. */
let requestOpen: ((input: HTMLInputElement) => void) | null = null

function NumpadHost() {
  const [pad, setPad] = useState<Pad | null>(null)
  const [buf, setBuf] = useState('')
  const padEl = useRef<HTMLDivElement>(null)
  // Mirrors of the state for the stable handlers, which always read the current pad and entry.
  const live = useRef({ pad, buf })
  live.current = { pad, buf }
  /** The value to write when the closing blur comes through: Done's landing or Cancel's original. */
  const pending = useRef<string | null>(null)

  const write = (text: string) => {
    const p = live.current.pad
    if (!p) return
    setFieldValue(p.input, text)
    setBuf(text)
  }

  const open = (input: HTMLInputElement) => {
    if (live.current.pad?.input === input) return
    const raw = input.dataset.padUnit
    const docUnit: EntryUnit = raw === 'mm' || raw === 'in' || raw === 'º' ? raw : ''
    const orig = input.value
    pending.current = null
    setBuf(orig)
    setPad({ input, label: input.getAttribute('aria-label') ?? '', docUnit, entryUnit: docUnit, int: input.dataset.padInt !== undefined, orig })
    reveal(input)
  }

  // Leaving the field — Done, Cancel, a tap anywhere else — closes the pad and lands the entry.
  // A capture listener, so the write happens before the field's own blur handler commits: React
  // has re-rendered with the landed text by the time that handler reads it.
  const close = () => {
    const { pad: p, buf: text } = live.current
    if (!p) return
    let out: string | null = pending.current
    if (out == null && p.entryUnit !== p.docUnit) {
      // A blur from outside the pad: convert an entry typed in the other unit back to the field's.
      const v = evalEntry(text)
      const conv = v != null ? convertUnit(v, p.entryUnit, p.docUnit) : null
      if (conv != null) out = fmtEntry(conv, p.docUnit)
    }
    if (out != null && out !== text) setFieldValue(p.input, out)
    pending.current = null
    setPad(null)
  }

  const done = () => {
    const p = live.current.pad
    if (!p) return
    const text = live.current.buf
    const v = evalEntry(text)
    if (text.trim() !== '' && v == null) return // nothing valid to land; the button is disabled too
    const conv = v != null ? convertUnit(v, p.entryUnit, p.docUnit) : null
    pending.current = v != null ? fmtEntry(conv ?? v, p.docUnit) : ''
    if (document.activeElement === p.input) p.input.blur()
    else close()
  }

  const cancel = () => {
    const p = live.current.pad
    if (!p) return
    pending.current = p.orig
    if (document.activeElement === p.input) p.input.blur()
    else close()
  }

  const typeKey = (k: string) => write(live.current.buf + k)
  const sign = () => write(toggleSign(live.current.buf))
  const back = () => write(live.current.buf.slice(0, -1))
  const equals = () => {
    const v = evalEntry(live.current.buf)
    if (v != null) write(fmtEntry(v, live.current.pad?.entryUnit ?? ''))
  }
  const swapUnit = () => {
    const p = live.current.pad
    if (!p || (p.entryUnit !== 'mm' && p.entryUnit !== 'in')) return
    const to = p.entryUnit === 'mm' ? 'in' : 'mm'
    const v = evalEntry(live.current.buf)
    if (v == null) return // a half-typed entry has no value to convert; the key waits
    setPad({ ...p, entryUnit: to })
    write(fmtEntry(convertUnit(v, p.entryUnit, to) ?? v, to))
  }

  // Nudge the field above the pad: walk up from it, scrolling each scrollable ancestor by what is
  // still hidden, then the window. Best effort — the pad is a fixed overlay, like the keyboard it replaces.
  function reveal(input: HTMLInputElement) {
    requestAnimationFrame(() => {
      const el = padEl.current
      if (!el) return
      const room = window.innerHeight - el.offsetHeight - 12
      let need = input.getBoundingClientRect().bottom - room
      let scroller: HTMLElement | null = input.parentElement
      while (scroller && need > 0.5) {
        if (scroller.scrollHeight > scroller.clientHeight + 1) {
          const before = scroller.scrollTop
          scroller.scrollTop = before + need
          need -= scroller.scrollTop - before
        }
        scroller = scroller.parentElement
      }
      if (need > 0) window.scrollBy(0, need)
    })
  }

  // Keep buf in step with the field when keys arrive from elsewhere (an attached hardware
  // keyboard, a caliper burst), and land the pad when the field blurs. A field that left the DOM
  // (its panel closed) never blurs, so a quiet timer watches for it and just drops the pad.
  useEffect(() => {
    if (!pad) return
    const input = pad.input
    const sync = () => setBuf(input.value)
    const onOut = (e: FocusEvent) => {
      if (e.target === input) close()
    }
    input.addEventListener('input', sync)
    document.addEventListener('focusout', onOut, true)
    const gone = window.setInterval(() => {
      if (!input.isConnected) {
        pending.current = null
        setPad(null)
      }
    }, 400)
    return () => {
      input.removeEventListener('input', sync)
      document.removeEventListener('focusout', onOut, true)
      window.clearInterval(gone)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pad?.input])

  useEffect(() => {
    requestOpen = open
    return () => {
      requestOpen = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!pad) return null
  const bad = buf.trim() !== '' && evalEntry(buf) == null
  const showUnitSwap = pad.docUnit === 'mm' || pad.docUnit === 'in'
  return (
    <div
      className="numpad"
      ref={padEl}
      aria-label={`Number pad for ${pad.label || 'value'}`}
      // Keys must never take focus from the field: a blur mid-entry would commit it half-typed.
      onPointerDown={(e) => e.preventDefault()}
    >
      <div className="numpad__banner">
        <span className="numpad__glyph" aria-hidden="true" dangerouslySetInnerHTML={{ __html: CALIPER_ICON }} />
        <span className="numpad__text">
          {pad.label && <span className="numpad__field">{pad.label}</span>}
          <span className="numpad__value">
            {buf || <span className="numpad__hint">0</span>}
            {pad.entryUnit && <span className="numpad__unit">{pad.entryUnit}</span>}
          </span>
        </span>
        <button type="button" className="numpad__back" aria-label="Cancel entry" onClick={cancel}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5" />
            <path d="m11 18-6-6 6-6" />
          </svg>
        </button>
      </div>
      <div className={'numpad__grid' + (pad.int ? ' numpad__grid--int' : '')}>
        {pad.int ? (
          <>
            {['7', '8', '9', '4', '5', '6', '1', '2', '3'].map((d) => (
              <button key={d} type="button" className="numpad__key" aria-label={d} onClick={() => typeKey(d)}>
                {d}
              </button>
            ))}
            <button type="button" className="numpad__key" aria-label="Delete" onClick={back}>
              <DeleteGlyph />
            </button>
            <button type="button" className="numpad__key" aria-label="0" onClick={() => typeKey('0')}>
              0
            </button>
          </>
        ) : (
          <>
            <button type="button" className="numpad__key numpad__key--fn" aria-label="Delete" onClick={back}>
              <DeleteGlyph />
            </button>
            <button type="button" className="numpad__key numpad__key--fn" aria-label="Positive or negative" onClick={sign}>
              +|−
            </button>
            {showUnitSwap ? (
              <button type="button" className="numpad__key numpad__key--fn" aria-label="Switch between inches and millimetres" onClick={swapUnit}>
                In/mm
              </button>
            ) : (
              <span className="numpad__void" />
            )}
            <button type="button" className="numpad__key numpad__key--op" aria-label="Divide" onClick={() => typeKey('/')}>
              /
            </button>
            {['7', '8', '9'].map((d) => (
              <button key={d} type="button" className="numpad__key" aria-label={d} onClick={() => typeKey(d)}>
                {d}
              </button>
            ))}
            <button type="button" className="numpad__key numpad__key--op" aria-label="Times" onClick={() => typeKey('*')}>
              ×
            </button>
            {['4', '5', '6'].map((d) => (
              <button key={d} type="button" className="numpad__key" aria-label={d} onClick={() => typeKey(d)}>
                {d}
              </button>
            ))}
            <button type="button" className="numpad__key numpad__key--op" aria-label="Minus" onClick={() => typeKey('-')}>
              −
            </button>
            {['1', '2', '3'].map((d) => (
              <button key={d} type="button" className="numpad__key" aria-label={d} onClick={() => typeKey(d)}>
                {d}
              </button>
            ))}
            <button type="button" className="numpad__key numpad__key--op" aria-label="Plus" onClick={() => typeKey('+')}>
              +
            </button>
            <button type="button" className="numpad__key" aria-label="0" onClick={() => typeKey('0')}>
              0
            </button>
            <button type="button" className="numpad__key" aria-label="Decimal point" onClick={() => typeKey('.')}>
              .
            </button>
            <span className="numpad__void" />
            <button type="button" className="numpad__key numpad__key--eq" disabled={bad} aria-label="Equals: evaluate the entry" onClick={equals}>
              =
            </button>
          </>
        )}
      </div>
      <div className="numpad__foot">
        <button type="button" className="numpad__cancel" onClick={cancel}>
          Cancel
        </button>
        <button type="button" className="numpad__done" disabled={bad} onClick={done}>
          Done
        </button>
      </div>
    </div>
  )
}

function DeleteGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.5 5h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-9l-6-7 6-7Z" />
      <path d="m12.5 9.5 5 5" />
      <path d="m17.5 9.5-5 5" />
    </svg>
  )
}

/**
 * Install the pad for the whole page: one React root for the overlay, plus the document-level
 * wiring that notices a number field gaining focus on a touch device. On those devices the
 * fields also stop asking the OS for its keyboard — input mode `none` suppresses the virtual
 * keyboard (a hardware keyboard still types normally; input mode only shapes the virtual one) —
 * and React may mount new fields at any time, so a mutation observer re-applies it.
 */
export function installNumpad() {
  const mount = document.createElement('div')
  document.body.appendChild(mount)
  createRoot(mount).render(
    <StrictMode>
      <NumpadHost />
    </StrictMode>,
  )

  const touch = () => window.matchMedia?.('(pointer: coarse)').matches ?? false
  const tame = (el: Element) => {
    if (touch() && isPadField(el) && el.inputMode !== 'none') el.inputMode = 'none'
  }
  const tameTree = (root: Element) => {
    if (root instanceof HTMLInputElement) tame(root)
    root.querySelectorAll('input').forEach(tame)
  }
  tameTree(document.documentElement)
  new MutationObserver((muts) => {
    if (!touch()) return
    for (const m of muts) {
      if (m.type === 'attributes' && m.target instanceof Element) tame(m.target)
      else for (const n of m.addedNodes) if (n instanceof Element) tameTree(n)
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributeFilter: ['inputmode', 'type'] })

  document.addEventListener(
    'focusin',
    (e) => {
      const el = e.target as Element | null
      if (touch() && isPadField(el)) {
        tame(el)
        requestOpen?.(el)
      }
    },
    true,
  )
}
