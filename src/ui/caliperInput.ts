// Digital-caliper input. A USB caliper types like a keyboard: Num Lock, F24, the reading on the
// keypad, Enter, Num Lock. It never says which unit it is in, but it always sends a fixed number
// of decimals: two for millimetres ("6.83"), four for inches ("0.2995"). From F24 until Enter the
// whole burst is swallowed wherever focus is — digits leaking to the studio would flip
// Design/Plan/Review — and the focused field only changes once, converted, when the burst lands.
// Browsers that never see F24 (macOS drops F21-F24 for some keyboards) get a fallback in text
// fields: every number key is held back unseen as part of a run, and each key tight on the last
// one's heels joins it. A run followed tightly by Enter, holding a reading with a caliper's
// decimals, is a caliper's — it lands like an F24 burst. Anything else goes back into the field,
// where it was typed, as soon as the run pauses or another key arrives, so a misjudged typist is
// only ever a moment late, never lost. The give-back can be undone: if a key that belongs to the
// run turns up after it (the timer won a race against a queued keystroke), the run is taken back
// out of the field and carries on, so the first digit of a reading can never be dropped.
// The landing is a green wipe across the whole field, the swipe revealing the glyph where the
// unit text was. Set localStorage.caliperDebug = '1' to log key timings to the console.
import { MM_PER_IN, type Units } from '../model/types'
import { useStore } from '../state/store'

export const FLASH_MS = 3000
/** An F24 burst ends after this long without a key, or on Enter. */
const IDLE_MS = 500
/** Keys closer together than this (ms) belong to one run — a caliper mid-reading. */
const RUN_GAP_MS = 80
/** A held run goes back into its field this long (ms) after its last key. */
const HOLD_MS = 90
/** A caliper's Enter follows the last digit of its reading within this long (ms). */
const ENTER_GAP_MS = 200
/** More characters than any reading: a run this long is a held key, not a caliper. */
const MAX_READING = 12

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
/** The glyph as an SVG payload, shared with the number pad's banner. */
export const CALIPER_ICON =
  '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" aria-hidden="true">' +
  `<rect x="12" y="2.6" width="5.6" height="18.8"/>${JAWS}<g transform="translate(0 18.7) scale(1 -1)">${JAWS}</g></svg>`

/** The sweep that reveals a landed reading (ms), and its curve: unhurried over the digits, gliding out. */
const SWEEP_MS = 850
const SWEEP_EASE: [number, number, number, number] = [0.55, 0.05, 0.25, 1]
/** Width (px) of the soft edge just ahead of the line, where the new text fades in. */
const FEATHER = 28

/** Progress (0..1) of a CSS cubic-bezier curve at time fraction `t`. */
function bezierAt([x1, y1, x2, y2]: [number, number, number, number], t: number) {
  // Find the curve parameter u whose x is t by bisection, then return its y.
  const at = (a: number, b: number, u: number) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (at(x1, x2, mid) < t) lo = mid
    else hi = mid
  }
  return at(y1, y2, (lo + hi) / 2)
}

/** The time fraction at which an eased sweep reaches progress `p`. */
function bezierTimeOf(ease: [number, number, number, number], p: number) {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (bezierAt(ease, mid) < p) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** First opaque background behind `el`, so the cover can hide its text. */
function backdrop(el: Element | null): string {
  for (; el; el = el.parentElement) {
    const bg = getComputedStyle(el).backgroundColor
    if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) return bg
  }
  return getComputedStyle(document.body).backgroundColor || '#000'
}

const landed = new WeakMap<Element, () => void>()

/** A lifeless copy of `box` showing `prev` in `input`'s place, to keep the old reading on screen. */
function ghostOf(box: HTMLElement, input: HTMLInputElement, prev: string) {
  const at = box === input ? 0 : Array.from(box.querySelectorAll('input')).indexOf(input)
  const copy = box.cloneNode(true) as HTMLElement
  copy.classList.remove('caliper-host')
  for (const el of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) {
    el.removeAttribute('id')
    el.removeAttribute('name')
    el.removeAttribute('for')
  }
  copy.setAttribute('inert', '')
  copy.setAttribute('aria-hidden', 'true')
  const field = copy instanceof HTMLInputElement ? copy : copy.querySelectorAll('input')[at]
  if (field) field.value = prev
  // Sit exactly over the original: the overlay starts inside its border.
  const cs = getComputedStyle(box)
  copy.style.cssText += `;position:absolute;margin:0;box-sizing:border-box;left:${-parseFloat(cs.borderLeftWidth) || 0}px;top:${-parseFloat(cs.borderTopWidth) || 0}px;width:${box.offsetWidth}px;height:${box.offsetHeight}px`
  return copy
}

// The landing: the old reading stays put while a bright green line sweeps across the field like a
// caliper jaw, overwriting it as it goes — the new reading revealed behind the line with a green
// glow trailing it. Where the unit text was, the caliper glyph pops in as the line passes; ring,
// tint and glyph hold, then fade out together and the unit text comes back.
function wipe(input: HTMLInputElement, prev: string) {
  const box = input.closest<HTMLElement>('.ss-input') ?? input
  landed.get(box)?.() // a second reading on the heels of the first restarts the reveal
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // The old reading, copied before the box gains anything of ours.
  const ghost = reduced ? null : ghostOf(box, input, prev)
  box.classList.add('caliper-host')
  // The glyph takes the unit text's place. That text can sit well in from the right edge — the
  // size and position fields keep it clear of the lock and anchor buttons overlapping the edge —
  // so pin the glyph to the text's own rect: the last adorn, whatever follows it in the DOM.
  const adorns = box === input ? [] : box.querySelectorAll<HTMLElement>('.ss-input__adorn')
  const adorn = adorns.length ? adorns[adorns.length - 1] : null
  const b = box.getBoundingClientRect()
  const overlay = document.createElement('span')
  overlay.className = 'caliper-wipe'
  overlay.innerHTML =
    '<span class="caliper-wipe__sweep"><span class="caliper-wipe__trail"></span>' +
    '<span class="caliper-wipe__cover"><span class="caliper-wipe__ghost"></span></span>' +
    '<span class="caliper-wipe__edge"></span></span>' +
    CALIPER_ICON
  overlay.style.setProperty('--caliper-bg', backdrop(box))
  overlay.style.setProperty('--caliper-feather', `${FEATHER}px`)
  const ghostHost = overlay.querySelector<HTMLElement>('.caliper-wipe__ghost')!
  if (ghost) ghostHost.appendChild(ghost)
  const svg = overlay.lastElementChild as SVGElement
  let glyphX = b.width - 17
  if (adorn) {
    const a = adorn.getBoundingClientRect()
    glyphX = a.left - b.left + a.width / 2
    svg.style.cssText = `left:${glyphX}px;top:${a.top - b.top + a.height / 2}px;right:auto`
    adorn.classList.add('caliper-adorn-out')
  }
  // The glyph pops the moment the line crosses it.
  const reach = bezierTimeOf(SWEEP_EASE, Math.min(1, (glyphX + FEATHER) / (b.width + FEATHER)))
  svg.style.animationDelay = `${Math.round(reach * SWEEP_MS)}ms`
  if (box === input) {
    // A bare input has no wrapper to host the overlay; float one over its rect instead.
    overlay.style.cssText += `;position:fixed;left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;border-radius:${getComputedStyle(input).borderRadius}`
    ghost?.style.setProperty('left', '0px')
    ghost?.style.setProperty('top', '0px')
    document.body.appendChild(overlay)
  } else {
    // First, not last: the unit text is placed by :last-child rules (the size and position
    // fields shift it clear of their lock and anchor buttons), and must not move under us.
    box.insertBefore(overlay, box.firstChild)
  }
  const sweep = overlay.firstElementChild as HTMLElement
  // Left edge of the sweep (the line) runs from just off the left of the field to past its right
  // edge, so the feathered cover in front of it fully clears the text. The old reading rides
  // inside the cover, counter-moving so it stays exactly where it was until the line eats it.
  const timing: KeyframeAnimationOptions = { duration: SWEEP_MS, easing: `cubic-bezier(${SWEEP_EASE.join(',')})`, fill: 'forwards' }
  const anims = reduced
    ? []
    : [
        sweep.animate([{ transform: `translateX(${-FEATHER}px)` }, { transform: `translateX(${b.width + FEATHER}px)` }], timing),
        ghostHost.animate([{ transform: `translateX(${FEATHER}px)` }, { transform: `translateX(${-(b.width + FEATHER)}px)` }], timing),
      ]
  if (reduced) sweep.remove()
  const t = window.setTimeout(() => cleanup(), FLASH_MS)
  const cleanup = () => {
    window.clearTimeout(t)
    for (const a of anims) a.cancel()
    overlay.remove()
    box.classList.remove('caliper-host')
    adorn?.classList.remove('caliper-adorn-out')
    landed.delete(box)
  }
  landed.set(box, cleanup)
}

export function installCaliperInput() {
  // Armed from F24 until Enter (or a pause): every key in between is the caliper's and is
  // swallowed wherever focus is; with no field focused the burst just ends silently.
  let armed = false
  let field: HTMLInputElement | null = null
  let buf = ''
  let timer = 0
  // Fallback for browsers that never deliver F24: the run of number keys being held back in a
  // field. `before` and the selection are the field as the run found it, so the run can go back
  // in where it was typed and, if it went back too early, come out again; `after` is the field
  // right after it went back, to tell whether anything has touched it since.
  type Run = {
    el: HTMLInputElement
    text: string
    held: boolean
    before: string
    selStart: number
    selEnd: number
    after: string
    last: number
    timer: number
  }
  let run: Run | null = null

  let debug = false
  try {
    debug = localStorage.getItem('caliperDebug') === '1'
  } catch {
    // Storage blocked: no logging.
  }
  let lastKeyAt = 0

  const finish = () => {
    window.clearTimeout(timer)
    const el = field
    const reading = buf
    armed = false
    field = null
    buf = ''
    if (debug) console.debug('[caliper] landing', JSON.stringify(reading), el ? 'into field' : 'nowhere')
    if (!el || !el.isConnected || !reading) return
    const prev = el.value
    setValue(el, convertCaliper(reading, useStore.getState().doc.units).text)
    wipe(el, prev)
  }

  const select = (el: HTMLInputElement, start: number, end: number) => {
    try {
      el.setSelectionRange(start, end)
    } catch {
      // Number inputs have no cursor to restore.
    }
  }

  // Put held characters back into their field, at the cursor they were typed at.
  const unswallow = (el: HTMLInputElement, text: string, selStart: number, selEnd: number) => {
    if (!el.isConnected || !text) return
    if (el === document.activeElement && typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) return
    // The field lost focus or execCommand refused: splice the text in directly.
    setValue(el, el.value.slice(0, selStart) + text + el.value.slice(selEnd))
    select(el, selStart + text.length, selStart + text.length)
  }

  // Give a held run back to its field. The run stays current, so a key that turns out to belong
  // to it can still take it back out.
  const release = (r: Run | null) => {
    if (!r || !r.held) return
    window.clearTimeout(r.timer)
    r.held = false
    unswallow(r.el, r.text, r.selStart, r.selEnd)
    r.after = r.el.value
    if (debug) console.debug('[caliper] gave back', JSON.stringify(r.text))
  }

  // The run went back too early: take it out of the field again, if nothing has touched it since.
  const retract = (r: Run) => {
    if (!r.el.isConnected || r.el.value !== r.after) return false
    setValue(r.el, r.before)
    select(r.el, r.selStart, r.selEnd)
    r.held = true
    if (debug) console.debug('[caliper] took back', JSON.stringify(r.text))
    return true
  }

  // Close the current run, giving back whatever it still holds.
  const endRun = () => {
    release(run)
    run = null
  }

  const hold = (r: Run) => {
    window.clearTimeout(r.timer)
    r.timer = window.setTimeout(() => release(r), HOLD_MS)
  }

  const startRun = (el: HTMLInputElement, c: string, ts: number) => {
    endRun()
    let selStart = el.value.length
    let selEnd = selStart
    try {
      selStart = el.selectionStart ?? selStart
      selEnd = el.selectionEnd ?? selEnd
    } catch {
      // Number inputs expose no cursor.
    }
    run = { el, text: c, held: true, before: el.value, selStart, selEnd, after: '', last: ts, timer: 0 }
    hold(run)
  }

  const replayEnter = (el: HTMLInputElement) =>
    // Hold Enter back until React has rendered the converted text, then replay it so the field commits it.
    window.setTimeout(() => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })), 0)

  document.addEventListener(
    'keydown',
    (e) => {
      if (debug) {
        console.debug('[caliper]', JSON.stringify(e.key), `+${Math.round(e.timeStamp - lastKeyAt)}ms`, armed ? 'armed' : run?.held ? `holding ${JSON.stringify(run.text)}` : '')
        lastKeyAt = e.timeStamp
      }
      if (e.key === 'F24' || e.code === 'F24') {
        // Nothing visible yet. With a field focused the reading is written into it, converted,
        // when the burst lands; with none, the burst just ends silently, written nowhere.
        endRun()
        const el = document.activeElement
        field = isTarget(el) ? el : null
        armed = true
        buf = ''
        e.preventDefault()
        e.stopPropagation()
        window.clearTimeout(timer)
        timer = window.setTimeout(finish, IDLE_MS)
        return
      }
      if (!armed) {
        const el = document.activeElement
        const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing && !e.repeat
        if (plain && /^[0-9.,-]$/.test(e.key) && isTarget(el)) {
          const c = e.key === ',' ? '.' : e.key
          const r = run
          // Tight on the last key of this field's run: it carries on, taken back out of the field
          // first if the hold ran out before this key got here.
          if (r && r.el === el && e.timeStamp - r.last <= RUN_GAP_MS && r.text.length < MAX_READING && (r.held || retract(r))) {
            r.text += c
            r.last = e.timeStamp
            hold(r)
          } else {
            startRun(el, c, e.timeStamp)
          }
          e.preventDefault()
          e.stopPropagation()
          return
        }
        if (e.key === 'NumLock' || e.key === 'Clear' || e.code === 'NumLock') {
          // The caliper's leading and trailing Num Locks. On a Mac the keypad's Num Lock is Clear,
          // which deletes a selection — a select-all field would empty before the reading lands.
          if (isTarget(el)) e.preventDefault()
          return
        }
        const r = run
        if (
          e.key === 'Enter' &&
          r &&
          r.el === el &&
          e.timeStamp - r.last <= ENTER_GAP_MS &&
          caliperUnit(r.text) &&
          (r.held || r.el.value === r.after)
        ) {
          // The caliper's Enter: rewrite the field, converted, and wipe it.
          window.clearTimeout(r.timer)
          run = null
          field = r.el
          buf = r.text
          finish()
          e.preventDefault()
          e.stopPropagation()
          replayEnter(r.el)
          return
        }
        // Not a caliper key: hand back whatever is held before the key does its thing.
        endRun()
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
        if (el) replayEnter(el)
        return
      } else if (e.key === 'NumLock' || e.key === 'Clear' || e.code === 'NumLock') {
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
    endRun()
    if (armed) finish()
  })
}
