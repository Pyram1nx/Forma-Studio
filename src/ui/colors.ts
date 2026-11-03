// Colours for canvas and WebGL drawing (Viewer3D, Paper Scan). They mirror the
// values in src/styles/tokens.css; keep the two in step when a token changes.
import type { Color, GridHelper } from 'three'

export const COLORS = {
  white: '#fdfdfe',
  gray50: '#f6f7f9',
  gray200: '#dfe1e7',
  gray400: '#8e929f',
  blue050: '#2c65ff',
  cutGreen: '#1be09e',
  // Not in tokens.css: 3D-only greys.
  meshGrey: '#9aa0ab',
  gridMinor: '#e9ebf0',
  ground: '#c9ced8',
  wood: '#d9b17a',
  cutLine: '#5a3a1e',
} as const

/** '#rrggbb' to the 0xRRGGBB number that three.js takes. */
export const hexNum = (c: string): number => parseInt(c.slice(1), 16)

/** The 3D viewers' backdrop in each appearance: background and grid (centre lines, the rest). */
const BACKDROP = {
  light: { bg: COLORS.gray50, gridCenter: COLORS.gray200, grid: COLORS.gridMinor },
  // gray-50 of the dark ramp in tokens.css, and two steps up for the grid.
  dark: { bg: '#1e1f22', gridCenter: '#3d4046', grid: '#2b2d31' },
}

/** Paint a viewer's background colour and GridHelper for the light or dark appearance. */
export function paintBackdrop(background: Color, grid: GridHelper, dark: boolean) {
  const c = dark ? BACKDROP.dark : BACKDROP.light
  background.set(c.bg)
  const center = background.clone().set(c.gridCenter)
  const rest = background.clone().set(c.grid)
  // GridHelper writes 4 vertices (two lines) per division, the middle division in its centre colour.
  const attr = grid.geometry.getAttribute('color')
  const mid = (attr.count / 4 - 1) / 2
  for (let v = 0; v < attr.count; v++) {
    const col = Math.floor(v / 4) === mid ? center : rest
    attr.setXYZ(v, col.r, col.g, col.b)
  }
  attr.needsUpdate = true
}
