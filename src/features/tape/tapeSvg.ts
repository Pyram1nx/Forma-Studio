// A tape layout as an SVG document at true physical size (width/height in mm, 1 user unit = 1 mm),
// for printing, cutting or a vinyl plotter. The tape itself is always black on white.
import { DOMINO_CORNER, DOMINO_H, DOMINO_W, DOT_D, dotCentres, footerParts, type TapeLayout } from './tapeGeometry'

/** Short, exact-enough number text for mm coordinates. */
export function num(v: number): string {
  const s = v.toFixed(3)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * One domino at (x, y), written out in full (no <use>/<defs>), so cutters, plotters and design apps
 * that do not resolve references still read every dot.
 */
function domino(code: number, x: number, y: number): string {
  const dots = dotCentres(code)
    .map((p) => `<circle cx="${num(x + p.x)}" cy="${num(y + p.y)}" r="${num(DOT_D / 2)}"/>`)
    .join('')
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(DOMINO_W)}" height="${num(DOMINO_H)}" rx="${num(DOMINO_CORNER)}" fill="#000"/><g fill="#fff">${dots}</g>`
}

export interface TapeSvgOptions {
  /** Add a white page background (on by default; off for cutting/plotting files). */
  background?: boolean
}

export function tapeSvg(layout: TapeLayout, opts: TapeSvgOptions = {}): string {
  const { w, h } = layout
  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(w)}mm" height="${num(h)}mm" viewBox="0 0 ${num(w)} ${num(h)}">`,
  )
  parts.push(`<title>${esc('Domino tape · ' + layout.label)}</title>`)
  if (opts.background !== false) parts.push(`<rect width="${num(w)}" height="${num(h)}" fill="#fff"/>`)

  if (layout.strips.length) {
    // Cut lines: a thin grey dashed outline around each strip, kept clear of the dominoes.
    parts.push('<g fill="none" stroke="#9a9a9a" stroke-width="0.2" stroke-dasharray="1.5 1">')
    for (const s of layout.strips) parts.push(`<rect x="${num(s.x)}" y="${num(s.y)}" width="${num(s.w)}" height="${num(s.h)}"/>`)
    parts.push('</g>')
  }

  parts.push('<g>')
  for (const d of layout.dominoes) parts.push(domino(d.code, d.x, d.y))
  parts.push('</g>')

  if (layout.footer) {
    const f = footerParts(layout.footer, layout.label)
    parts.push('<g fill="#000">')
    for (const b of f.bars) parts.push(`<rect x="${num(b.x)}" y="${num(b.y)}" width="${num(b.w)}" height="${num(b.h)}"/>`)
    for (const t of f.texts)
      parts.push(
        `<text x="${num(t.x)}" y="${num(t.y)}" font-size="${num(t.size)}" font-family="Helvetica, Arial, sans-serif" text-anchor="${t.anchor}">${esc(t.text)}</text>`,
      )
    parts.push('</g>')
  }

  parts.push('</svg>')
  return parts.join('\n')
}
