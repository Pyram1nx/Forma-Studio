// Export to an SVG that Shaper Origin understands.
// - Real-world size: width/height in mm, viewBox in mm.
// - Cut type is encoded twice, exactly as Shaper Studio's own export does: its
//   fill/stroke colour convention and the shaper:cutType attribute. Depth goes in
//   shaper:cutDepth and the bit in shaper:toolDia, both in inches ("0.250 in").
// - The cut offset is baked into the geometry, so the exported path is the path
//   the bit edge follows, and shaper:cutOffset is always 0 (writing the real
//   offset as well would make Origin apply it twice).
import type { CutType, Contour, Shape, StudioDoc } from '../model/types'
import { contoursToD } from '../geometry/svgPath'
import { offsetContours } from '../geometry/offset'
import { bboxOfContours, bboxValid, emptyBBox, worldContours } from '../geometry/transform'

export const SHAPER_NS = 'http://www.shapertools.com/namespaces/shaper'

const STYLE: Record<CutType, { fill: string; stroke: string }> = {
  outside: { fill: '#000000', stroke: 'none' },
  inside: { fill: '#FFFFFF', stroke: '#000000' },
  online: { fill: 'none', stroke: '#7F7F7F' },
  pocket: { fill: '#7F7F7F', stroke: 'none' },
  guide: { fill: '#0068FF', stroke: '#0068FF' },
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const n = (v: number) => +v.toFixed(4)
/** Shaper writes cut lengths in inches, whatever the design's units. */
const inches = (mm: number) => +(mm / 25.4).toFixed(5)

/**
 * World-space contours as they should be cut. A non-zero cut offset is applied:
 * outside grows the closed shapes, inside and pocket shrink them, and on-line
 * moves closed paths outward. Open paths have no inside or outside, so they are
 * left alone except for on-line (where they're exported unchanged too).
 * Guides are never offset.
 */
export function exportContours(s: Shape, type: CutType): Contour[] {
  const w = worldContours(s)
  const off = s.cut.offset
  if (!off || type === 'guide') return w
  const closed = w.filter((c) => c.closed)
  const open = w.filter((c) => !c.closed)
  switch (type) {
    case 'outside':
    case 'online':
      return [...offsetContours(closed, off), ...open]
    case 'inside':
    case 'pocket':
      return [...offsetContours(closed, -off), ...open]
  }
}

/** `includeReference` keeps reference (locked) shapes, e.g. for thumbnails; the cut file leaves them out, as in Studio. */
export function exportSVG(doc: StudioDoc, only?: Shape[], { includeReference = false } = {}): string {
  const shapes = (only ?? doc.shapes).filter((s) => !s.hidden && (includeReference || !s.locked))

  // Each shape's effective type and exported geometry, computed once.
  const items = shapes.map((s) => {
    const allOpen = worldContours(s).every((c) => !c.closed)
    // Open paths can only be cut on-line or used as guides.
    const type: CutType = allOpen && s.cut.type !== 'guide' ? 'online' : s.cut.type
    return { s, type, allOpen, cs: exportContours(s, type) }
  })

  // Bounding box of what is actually exported (offsets can grow past the design).
  const b = emptyBBox()
  for (const it of items) bboxOfContours(it.cs, b)
  const valid = bboxValid(b)
  const minX = valid ? b.minX : 0
  const minY = valid ? b.minY : 0
  const w = valid ? b.maxX - b.minX : 10
  const h = valid ? b.maxY - b.minY : 10

  const groups = new Map<string, typeof items>()
  const loose: typeof items = []
  for (const it of items) {
    if (it.s.groupId) {
      if (!groups.has(it.s.groupId)) groups.set(it.s.groupId, [])
      groups.get(it.s.groupId)!.push(it)
    } else loose.push(it)
  }

  const pathEl = ({ s, type, allOpen, cs }: (typeof items)[number]) => {
    const local = cs.map((c) => ({ closed: c.closed, pts: c.pts.map((p) => ({ x: p.x - minX, y: p.y - minY })) }))
    const st = STYLE[type]
    const attrs = [
      `id="${esc(s.id)}"`,
      `d="${contoursToD(local)}"`,
      `fill="${st.fill}"`,
      `stroke="${st.stroke}"`,
      `stroke-width="0.1"`,
      // Pocket holes and any other inner contours stay holes.
      `fill-rule="evenodd"`,
      `vector-effect="non-scaling-stroke"`,
      `shaper:cutType="${type}"`,
    ]
    // Guides are not cut, so they carry no depth.
    if (type !== 'guide' && s.cut.depth != null) attrs.push(`shaper:cutDepth="${inches(s.cut.depth)} in"`)
    attrs.push(`shaper:cutOffset="0in"`)
    if (s.cut.bitDia) attrs.push(`shaper:toolDia="${inches(s.cut.bitDia)}in"`)
    attrs.push(`shaper:pathType="${allOpen ? 'open' : 'closed'}"`)
    return `    <path ${attrs.join(' ')}><title>${esc(s.name)}</title></path>`
  }

  const body: string[] = []
  for (const it of loose) body.push(pathEl(it))
  for (const [gid, list] of groups) {
    const g = doc.groups.find((x) => x.id === gid)
    body.push(`  <g id="${esc(gid)}"${g ? ` inkscape:label="${esc(g.name)}"` : ''}>`)
    for (const it of list) body.push(pathEl(it))
    body.push('  </g>')
  }

  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:shaper="${SHAPER_NS}" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`,
    `     width="${n(w)}mm" height="${n(h)}mm" viewBox="0 0 ${n(w)} ${n(h)}" version="1.1">`,
    `  <!-- Created with Forma Studio: ${esc(doc.name)} -->`,
    ...body,
    `</svg>`,
  ].join('\n')
}
