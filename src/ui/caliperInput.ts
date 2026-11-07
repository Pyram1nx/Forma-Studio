// Digital-caliper input. A USB caliper types like a keyboard: Num Lock, F24, the reading on the
// keypad, Enter, Num Lock. It never says which unit it is in, but it always sends a fixed number
// of decimals: two for millimetres ("6.83"), four for inches ("0.2995"). When F24 arrives while a
// text field is focused we swallow the burst, read the unit from the decimals, convert to the
// document units, write the result into the field and flash it green for a few seconds.
import { MM_PER_IN, type Units } from '../model/types'
import { useStore } from '../state/store'

export const FLASH_MS = 3000
/** A burst ends after this long without a key, or on Enter. */
const IDLE_MS = 500
/** Keys closer together than this (ms) are a caliper, not a typist. */
const BURST_GAP_MS = 70
/** Badge size in px. */
const BADGE_PX = 24

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

function flash(input: HTMLInputElement) {
  const box = input.closest<HTMLElement>('.ss-input') ?? input
  const r = box.getBoundingClientRect()
  box.classList.remove('caliper-hit')
  void box.offsetWidth // restart the animation if hit twice in a row
  box.classList.add('caliper-hit')
  const icon = document.createElement('span')
  icon.className = 'caliper-badge'
  icon.innerHTML = ICON
  // Sit left of the unit suffix when the field has one, else at the right edge.
  const adorn = box.querySelector<HTMLElement>('.ss-input__adorn:last-child')
  const right = adorn && adorn !== box.firstElementChild ? adorn.getBoundingClientRect().left - 4 : r.right - 6
  icon.style.cssText = `width:${BADGE_PX}px;height:${BADGE_PX}px;left:${right - BADGE_PX}px;top:${r.top + (r.height - BADGE_PX) / 2}px`
  document.body.appendChild(icon)
  window.setTimeout(() => {
    box.classList.remove('caliper-hit')
    icon.remove()
  }, FLASH_MS)
}

export function installCaliperInput() {
  let field: HTMLInputElement | null = null
  let buf = ''
  let timer = 0
  // The green and the badge appear as soon as a reading is recognised, not when it ends.
  let flashed = false
  let cand: { el: Element | null; buf: string; last: number } = { el: null, buf: '', last: 0 }

  const finish = () => {
    window.clearTimeout(timer)
    const el = field
    const reading = buf
    field = null
    buf = ''
    if (!el || !el.isConnected || !reading) return
    setValue(el, convertCaliper(reading, useStore.getState().doc.units).text)
    if (!flashed) flash(el)
    flashed = false
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (!field) {
        if ((e.key === 'F24' || e.code === 'F24') && isTarget(document.activeElement)) {
          field = document.activeElement
          buf = ''
          flash(field)
          flashed = true
          e.preventDefault()
          window.clearTimeout(timer)
          timer = window.setTimeout(finish, IDLE_MS)
          return
        }
        // The browser may never see F24 (macOS drops F21-F24 for some keyboards). The reading itself still
        // gives it away: digits arrive a few ms apart, ending in Enter with exactly 2 or 4 decimals.
        const el = document.activeElement
        if (/^[0-9.,-]$/.test(e.key) && isTarget(el)) {
          if (cand.el !== el || e.timeStamp - cand.last > BURST_GAP_MS) {
            cand = { el, buf: '', last: e.timeStamp }
            flashed = false
          }
          cand.buf += e.key === ',' ? '.' : e.key
          cand.last = e.timeStamp
          if (cand.buf.length === 3 && !flashed) {
            flash(el)
            flashed = true
          }
        } else if (e.key === 'Enter' && cand.el === el && caliperUnit(cand.buf) && e.timeStamp - cand.last <= BURST_GAP_MS * 2) {
          field = el as HTMLInputElement
          buf = cand.buf
          cand = { el: null, buf: '', last: 0 }
          finish()
          e.preventDefault()
          e.stopPropagation()
          window.setTimeout(() => el!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })), 0)
        } else if (e.key !== 'NumLock' && e.key !== 'Clear' && e.key !== 'Enter') cand = { el: null, buf: '', last: 0 }
        return
      }
      // Mid-burst: swallow the reading so the field only changes once, with the converted value.
      if (/^[0-9.,-]$/.test(e.key)) {
        buf += e.key === ',' ? '.' : e.key
      } else if (e.key === 'Enter') {
        // Hold Enter back until React has rendered the new text, then replay it so the field commits it.
        const el = field
        finish()
        e.preventDefault()
        e.stopPropagation()
        window.setTimeout(() => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })), 0)
        return
      } else if (e.key === 'NumLock' || e.key === 'Clear') {
        // The caliper's trailing Num Lock.
      } else {
        finish()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      window.clearTimeout(timer)
      timer = window.setTimeout(finish, IDLE_MS)
    },
    true,
  )
  document.addEventListener('focusout', () => {
    if (field) finish()
  })
}
