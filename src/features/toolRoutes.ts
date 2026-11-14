// 3D Carve, Joinery and Systainer Insert are pages of their own (/3d-carve, /joinery,
// /systainer). The studio leaves for them and they come back to /studio, in the same tab.
// What the studio needs to know on return (unsaved changes, shapes to import) rides along
// in sessionStorage, so the import is an ordinary undoable step in the studio.
import type { ImportPayload } from '../model/types'

export type ToolId = 'carve3d' | 'joinery' | 'systainer'

export const TOOL_PATHS: Record<ToolId, string> = {
  carve3d: '/3d-carve',
  joinery: '/joinery',
  systainer: '/systainer',
}

export const STUDIO_PATH = '/studio'

export function toolForPath(path: string): ToolId | null {
  for (const [id, p] of Object.entries(TOOL_PATHS) as [ToolId, string][]) if (p === path) return id
  return null
}

const HANDOFF_KEY = 'formastudio:studio-handoff'

export interface StudioHandoff {
  /** The design the studio had open when it left for a tool. */
  docId?: string
  /** It had changes not yet saved to the computer. */
  dirty?: boolean
  /** Shapes a tool made, to import into the studio's design. */
  payload?: ImportPayload
}

export function readHandoff(): StudioHandoff {
  try {
    return JSON.parse(sessionStorage.getItem(HANDOFF_KEY) ?? '{}') as StudioHandoff
  } catch {
    return {}
  }
}

/** Returns false when it could not be stored (storage blocked, or the payload is too large). */
export function writeHandoff(h: StudioHandoff): boolean {
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(h))
    return true
  } catch {
    return false
  }
}

let taken: StudioHandoff | null = null
/**
 * The studio's handoff for this page load. Cleared from storage on first read so a reload
 * doesn't import twice, and kept in memory so a re-run start-up (StrictMode) sees it too.
 */
export function takeHandoff(): StudioHandoff {
  if (taken) return taken
  taken = readHandoff()
  try {
    sessionStorage.removeItem(HANDOFF_KEY)
  } catch {
    /* storage blocked */
  }
  return taken
}

let leaving = false
/** True while the studio is navigating to a tool page (its autosave is done; no "Leave site?" prompt). */
export const leavingForTool = () => leaving

/** Called by the studio: remember its state, then go to the tool's page. */
export function goToTool(tool: ToolId, state: { docId: string; dirty: boolean }, beforeLeave?: () => void) {
  setReturnPath(null)
  writeHandoff({ docId: state.docId, dirty: state.dirty })
  beforeLeave?.()
  leaving = true
  window.location.assign(TOOL_PATHS[tool])
}

export function goToStudio() {
  window.location.assign(STUDIO_PATH)
}

// A tool opened from the account home (its Systainers or Joints page) goes back there on
// Close. Import still goes to the studio, which adds the shapes to the last design.
const RETURN_KEY = 'formastudio:tool-return'

function setReturnPath(path: string | null) {
  try {
    if (path) sessionStorage.setItem(RETURN_KEY, path)
    else sessionStorage.removeItem(RETURN_KEY)
  } catch {
    /* storage blocked */
  }
}

/** Called by an account home page: open the tool, and come back to /account?page=<page> on Close. */
export function openToolFromAccount(tool: ToolId, page: string) {
  writeHandoff({})
  setReturnPath(`/account?page=${encodeURIComponent(page)}`)
  window.location.assign(TOOL_PATHS[tool])
}

/** Close in a tool page: back to where it was opened from (the account home or the studio). */
export function leaveTool() {
  let back: string | null = null
  try {
    back = sessionStorage.getItem(RETURN_KEY)
    sessionStorage.removeItem(RETURN_KEY)
  } catch {
    /* storage blocked */
  }
  window.location.assign(back?.startsWith('/account') ? back : STUDIO_PATH)
}

/** Import in a tool page always lands in the studio; forget any account return path. */
export function clearToolReturn() {
  setReturnPath(null)
}
