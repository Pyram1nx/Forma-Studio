// Digital-caliper input. A USB caliper types like a keyboard: Num Lock, F24, the reading on the
// keypad, Enter, Num Lock. It never says which unit it is in, but it always sends a fixed number
// of decimals: two for millimetres ("6.83"), four for inches ("0.2995"). From F24 until Enter the
// whole burst is swallowed wherever focus is — digits leaking to the studio would flip
// Design/Plan/Review — and the focused field only changes once, converted, when the burst lands.
// Browsers that never see F24 (macOS drops F21-F24 for some keyboards) get a fallback: the first
// digit of a possible reading is held back unseen, and a second digit tight on its heels confirms
// a caliper — the rest of the reading is swallowed and the field only changes once, converted,
// when the burst lands. A slower follow-up was a typist, and the held characters go back in where
// they came from. The landing is a green wipe across the whole field, the swipe revealing the
// glyph where the unit text was.
import { MM_PER_IN, type Units } from '../model/types'
import { useStore } from '../state/store'

export const FLASH_MS = 3000
/** A burst ends after this long without a key, or on Enter. */
const IDLE_MS = 500
/** Keys closer together than this (ms) are a caliper mid-reading, not a typist. */
const BURST_GAP_MS = 70
/** A held first digit is given up as a typist's after this long (ms). */
const PENDING_MS = 60
/** Digits this close together (ms) confirm a caliper at the start of a reading. */
const PENDING_GAP_MS = 50

/** Unit implied by the decimals a caliper sent: 2 → mm, 4 → in, anything else is unknown. */
export function caliperUnit(reading: string): Units | null {
  const m = /^-?\d*\.(\d+)$/.exec(reading)
  if (!m) return null
  return m[1].length === 2 ? 'mm' : m[1].length === 4 ? 'in' : null
}

/** The text to put in a field showing `docUnits`, given a raw caliper reading. */
export function convertCaliper(reading: string, docUnits: Units): { text: string; from: Units | null } {
  const from = caliperUnit(reading)
  const v = parseFloat(reading)
  if (!from || from === docUnits || !Number.isFinite(v)) return { text: reading, from }
  const out = from === 'in' ? v * MM_PER_IN : v / MM_PER_IN
  // 0.0005 in is 0.0127 mm, so three decimals keep every inch step; inches keep four.
  return { text: String(Number(out.toFixed(from === 'in' ? 3 : 4))), from }
}

/** Plain text fields only: not counts (numeric keyboard), checkboxes, passwords or opted-out fields. */
function isTarget(el: Element | null): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement) || el.readOnly || el.disabled) return false
  if (!['text', 'number', 'search', ''].includes(el.type)) return false
  if (el.inputMode === 'numeric' || el.closest('[data-caliper="off"]')) return false
  return true
}

function setValue(el: HTMLInputElement, text: string) {
  // The native setter bypasses React's value tracking so its onChange fires.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

// Shaper's caliper-input glyph: a square rail with a big and a small jaw at the top, and the same pair
// mirrored at the bottom, 2.7 apart (1.5 small-jaw heights). The big jaws' inner edges are horizontal.
const JAWS = '<path d="M2.5 6.2L12 2.6V8H2.5Z"/><rect x="17.6" y="6.2" width="4.4" height="1.8"/>'
const ICON =
  '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true">' +
  `<rect x="12" y="2.6" width="5.6" height="18.8"/>${JAWS}<g transform="translate(0 18.7) scale(1 -1)">${JAWS}</g></svg>`

function wipe(input: HTMLInputElement) {
  const box = input.closest<HTMLElement>('.ss-input') ?? input
  box.classList.add('caliper-host')
  // The glyph takes the unit text's place. That text can sit well in from the right edge — the
  // size and position fields keep it clear of the lock and anchor buttons overlapping the edge —
  // so pin the glyph to the text's own rect: the last adorn, whatever follows it in the DOM.
  const adorns = box === input ? [] : box.querySelectorAll<HTMLElement>('.ss-input__adorn')
  const adorn = adorns.length ? adorns[adorns.length - 1] : null
  if (adorn) adorn.style.visibility = 'hidden'
  const overlay = document.createElement('span')
  overlay.className = 'caliper-wipe'
  overlay.innerHTML = '<span class="caliper-wipe__sweep"></span>' + ICON
  if (adorn) {
    const b = box.getBoundingClientRect()
    const a = adorn.getBoundingClientRect()
    const svg = overlay.lastElementChild as SVGElement
    svg.style.cssText = `left:${a.left - b.left + a.width / 2}px;top:${a.top - b.top + a.height / 2}px;right:auto;transform:translate(-50%,-50%)`
  }
  if (box === input) {
    // A bare input has no wrapper to host the overlay; float one over its rect instead.
    const r = input.getBoundingClientRect()
    overlay.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border-radius:${getComputedStyle(input).borderRadius}`
    document.body.appendChild(overlay)
  } else {
    box.appendChild(overlay)
  }
  window.setTimeout(() => {
    overlay.remove()
    box.classList.remove('caliper-host')
    if (adorn) adorn.style.visibility = ''
  }, FLASH_MS)
}

export function installCaliperInput() {
  // Armed from F24 until Enter (or a pause): every key in between is the caliper's and is
  // swallowed wherever focus is; with no field focused the burst just ends silently.
  let armed = false
  let field: HTMLInputElement | null = null
  let buf = ''
  let timer = 0
  // Fallback for browsers that never deliver F24. A first digit is held back unseen; a second
  // digit tight on its heels starts a confirmed burst. `burst` holds the cursor the reading
  // started at, so held characters can be given back if it turns out a typist sent them.
  let burst: { el: Element; selStart: number; selEnd: number; last: number } | null = null
  let pend: { el: HTMLInputElement; base: string; chars: string; selStart: number; selEnd: number; last: number; timer: number } | null = null

  const finish = () => {
    window.clearTimeout(timer)
    const el = field
    const reading = buf
    armed = false
    field = null
    buf = ''
    if (!el || !el.isConnected || !reading) return
    setValue(el, convertCaliper(reading, useStore.getState().doc.units).text)
    wipe(el)
  }

  // Put held characters back into their field, at the cursor they were typed at.
  const unswallow = (el: HTMLInputElement, text: string, selStart: number, selEnd: number) => {
    if (!el.isConnected || !text) return
    if (el === document.activeElement && document.execCommand('insertText', false, text)) return
    // The field lost focus or execCommand refused: splice the text in directly.
    setValue(el, el.value.slice(0, selStart) + text + el.value.slice(selEnd))
    try {
      el.setSelectionRange(selStart + text.length, selStart + text.length)
    } catch {
      // Number inputs have no cursor to restore.
    }
  }

  // Hand a held digit back to its typist.
  const flush = (p: typeof pend) => {
    if (!p || pend !== p) return
    window.clearTimeout(p.timer)
    pend = null
    unswallow(p.el, p.base + p.chars, p.selStart, p.selEnd)
  }

  // Take a held digit out of circulation without returning it (a caliper claimed it).
  const take = () => {
    const p = pend
    if (p) {
      window.clearTimeout(p.timer)
      pend = null
    }
    return p
  }

  const stage = (el: HTMLInputElement, base: string, chars: string, ts: number) => {
    let selStart = el.value.length
    let selEnd = selStart
    try {
      selStart = el.selectionStart ?? selStart
      selEnd = el.selectionEnd ?? selEnd
    } catch {
      // Number inputs expose no cursor.
    }
    const p = { el, base, chars, selStart, selEnd, last: ts, timer: 0 }
    p.timer = window.setTimeout(() => flush(p), PENDING_MS)
    pend = p
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'F24' || e.code === 'F24') {
        // Nothing visible yet. With a field focused the reading is written into it, converted,
        // when the burst lands; with none, the burst just ends silently, written nowhere.
        flush(pend)
        const el = document.activeElement
        field = isTarget(el) ? el : null
        armed = true
        buf = ''
        burst = null
        e.preventDefault()
        e.stopPropagation()
        window.clearTimeout(timer)
        timer = window.setTimeout(finish, IDLE_MS)
        return
      }
      if (!armed) {
        const el = document.activeElement
        if (/^[0-9.,-]$/.test(e.key) && isTarget(el)) {
          const c = e.key === ',' ? '.' : e.key
          if (pend && pend.el === el) {
            if (e.timeStamp - pend.last <= PENDING_GAP_MS) {
              // A second tight digit: caliper confirmed. Nothing was ever on screen.
              const p = take()
              burst = { el, selStart: p!.selStart, selEnd: p!.selEnd, last: e.timeStamp }
              buf = p!.base + p!.chars + c
            } else {
              // A slower follow-up is a typist's cadence: hand the held characters back, then
              // hold this one in turn.
              flush(pend)
              stage(el, '', c, e.timeStamp)
            }
            e.preventDefault()
            e.stopPropagation()
            return
          }
          if (burst && burst.el === el) {
            if (e.timeStamp - burst.last <= BURST_GAP_MS) {
              // Mid-reading: keep swallowing. More characters than any caliper sends means a
              // held key rather than a caliper — give the whole run back to the field.
              if (buf.length >= 10) {
                const s0 = burst.selStart
                const s1 = burst.selEnd
                const held = buf
                burst = null
                buf = ''
                unswallow(el, held, s0, s1)
                stage(el, '', c, e.timeStamp)
              } else {
                buf += c
                burst.last = e.timeStamp
              }
            } else {
              // The reading stalled part-way: hold what it had like a fresh start, so the next
              // digit either continues it silently or a typist gets everything back.
              const held = buf
              burst = null
              buf = ''
              stage(el, held, c, e.timeStamp)
            }
            e.preventDefault()
            e.stopPropagation()
            return
          }
          // A first digit: hold it briefly, unseen, until it declares itself.
          stage(el, '', c, e.timeStamp)
          e.preventDefault()
          e.stopPropagation()
          return
        }
        if (e.key !== 'NumLock' && e.key !== 'Clear') {
          const landing = !pend && burst && burst.el === el && e.key === 'Enter' && caliperUnit(buf) && e.timeStamp - burst.last <= BURST_GAP_MS * 2
          if (landing) {
            // The caliper's Enter: rewrite the field, converted, and wipe it.
            field = el as HTMLInputElement
            burst = null
            finish()
            e.preventDefault()
            e.stopPropagation()
            window.setTimeout(() => (el as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })), 0)
          } else {
            // Not a caliper key: a typist's, or the end of a reading that never finished — hand
            // back whatever is held before the key does its thing.
            flush(pend)
            if (burst && burst.el === el) unswallow(el as HTMLInputElement, buf, burst.selStart, burst.selEnd)
            burst = null
            buf = ''
            window.clearTimeout(timer)
          }
        }
        return
      }
      // Armed mid-burst: everything is swallowed; only the landing is visible.
      if (/^[0-9.,-]$/.test(e.key)) {
        buf += e.key === ',' ? '.' : e.key
      } else if (e.key === 'Enter') {
        const el = field
        finish()
        e.preventDefault()
        e.stopPropagation()
        // Hold Enter back until React has rendered the converted text, then replay it so the field commits it.
        if (el) window.setTimeout(() => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })), 0)
        return
      } else if (e.key === 'NumLock' || e.key === 'Clear') {
        // The caliper's leading and trailing Num Locks.
      } else {
        finish()
        return // a key that is not the caliper's ends the burst and goes through as usual
      }
      e.preventDefault()
      e.stopPropagation()
      window.clearTimeout(timer)
      timer = window.setTimeout(finish, IDLE_MS)
    },
    true,
  )
  document.addEventListener('focusout', () => {
    flush(pend)
    if (armed) finish()
  })
}
