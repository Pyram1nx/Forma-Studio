// A starting layout for the Joinery tool, picked on the account's Joints page. It rides along
// in sessionStorage to /joinery; the dialog reads it once and clears it. No key, usual defaults.

/** The layouts the Joinery tool can start from: dovetail-bit layouts, fine-pin dovetails, Knapp joints. */
export type JointLayout = 'through' | 'single' | 'fine' | 'wide-pins' | 'fine-pin' | 'knapp'

const KEY = 'formastudio:joinery-start'
const LAYOUTS: JointLayout[] = ['through', 'single', 'fine', 'wide-pins', 'fine-pin', 'knapp']

/** Remember a layout for the next Joinery page (null forgets it). */
export function setJoineryStart(layout: JointLayout | null) {
  try {
    if (layout) sessionStorage.setItem(KEY, layout)
    else sessionStorage.removeItem(KEY)
  } catch {
    /* storage blocked: the tool opens with its defaults */
  }
}

export function readJoineryStart(): JointLayout | null {
  try {
    const v = sessionStorage.getItem(KEY)
    return LAYOUTS.includes(v as JointLayout) ? (v as JointLayout) : null
  } catch {
    return null
  }
}

export function clearJoineryStart() {
  setJoineryStart(null)
}
