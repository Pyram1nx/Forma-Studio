// A tape layout as a one-page vector PDF at true size, written by hand (no PDF library): rounded
// rectangles and dots as Bézier paths, the label in the PDF base font Helvetica.
import { DOMINO_CORNER, DOMINO_H, DOMINO_W, DOT_D, dotCentres, footerParts, type TapeLayout } from './tapeGeometry'

const PT_PER_MM = 72 / 25.4
/** Bézier handle length for a quarter circle, as a fraction of the radius. */
const KAPPA = 0.5522847498

function n(v: number): string {
  const s = v.toFixed(2)
  return s.replace(/\.?0+$/, '') || '0'
}

/** Text as a WinAnsi PDF string literal. Characters outside WinAnsi become '?'. */
function pdfString(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch === '–' ? 0x96 : ch === '—' ? 0x97 : ch === '·' ? 0xb7 : ch.codePointAt(0)!
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + ch
    else if (c >= 0x20 && c < 0x7f) out += ch
    else if (c >= 0xa0 && c <= 0xff) out += String.fromCharCode(c)
    else if (c === 0x96 || c === 0x97) out += String.fromCharCode(c)
    else out += '?'
  }
  return '(' + out + ')'
}

export function tapePdf(layout: TapeLayout): Uint8Array {
  const H = layout.h
  // Page space: points, y up. X/Y take mm with y down.
  const X = (x: number) => n(x * PT_PER_MM)
  const Y = (y: number) => n((H - y) * PT_PER_MM)
  const ops: string[] = []

  const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
    const k = r * KAPPA
    ops.push(
      `${X(x + r)} ${Y(y)} m`,
      `${X(x + w - r)} ${Y(y)} l`,
      `${X(x + w - r + k)} ${Y(y)} ${X(x + w)} ${Y(y + r - k)} ${X(x + w)} ${Y(y + r)} c`,
      `${X(x + w)} ${Y(y + h - r)} l`,
      `${X(x + w)} ${Y(y + h - r + k)} ${X(x + w - r + k)} ${Y(y + h)} ${X(x + w - r)} ${Y(y + h)} c`,
      `${X(x + r)} ${Y(y + h)} l`,
      `${X(x + r - k)} ${Y(y + h)} ${X(x)} ${Y(y + h - r + k)} ${X(x)} ${Y(y + h - r)} c`,
      `${X(x)} ${Y(y + r)} l`,
      `${X(x)} ${Y(y + r - k)} ${X(x + r - k)} ${Y(y)} ${X(x + r)} ${Y(y)} c`,
      'h',
    )
  }
  const circle = (cx: number, cy: number, r: number) => {
    const k = r * KAPPA
    ops.push(
      `${X(cx + r)} ${Y(cy)} m`,
      `${X(cx + r)} ${Y(cy + k)} ${X(cx + k)} ${Y(cy + r)} ${X(cx)} ${Y(cy + r)} c`,
      `${X(cx - k)} ${Y(cy + r)} ${X(cx - r)} ${Y(cy + k)} ${X(cx - r)} ${Y(cy)} c`,
      `${X(cx - r)} ${Y(cy - k)} ${X(cx - k)} ${Y(cy - r)} ${X(cx)} ${Y(cy - r)} c`,
      `${X(cx + k)} ${Y(cy - r)} ${X(cx + r)} ${Y(cy - k)} ${X(cx + r)} ${Y(cy)} c`,
      'h',
    )
  }
  const rect = (x: number, y: number, w: number, h: number) => ops.push(`${X(x)} ${Y(y + h)} ${n(w * PT_PER_MM)} ${n(h * PT_PER_MM)} re`)

  if (layout.strips.length) {
    ops.push('q 0.6 G', `${n(0.2 * PT_PER_MM)} w`, `[${n(1.5 * PT_PER_MM)} ${n(1 * PT_PER_MM)}] 0 d`)
    for (const s of layout.strips) rect(s.x, s.y, s.w, s.h)
    ops.push('S Q')
  }

  for (const d of layout.dominoes) {
    ops.push('0 g')
    roundRect(d.x, d.y, DOMINO_W, DOMINO_H, DOMINO_CORNER)
    ops.push('f', '1 g')
    for (const p of dotCentres(d.code)) circle(d.x + p.x, d.y + p.y, DOT_D / 2)
    ops.push('f')
  }

  if (layout.footer) {
    const f = footerParts(layout.footer, layout.label)
    ops.push('0 g')
    for (const b of f.bars) rect(b.x, b.y, b.w, b.h)
    ops.push('f')
    for (const t of f.texts) {
      // No font metrics here: right-aligned runs use Helvetica's rough average advance (0.5 em).
      const size = t.size * PT_PER_MM
      const x = t.anchor === 'end' ? t.x - t.text.length * t.size * 0.5 : t.x
      ops.push(`BT /F1 ${n(size)} Tf ${X(x)} ${Y(t.y)} Td ${pdfString(t.text)} Tj ET`)
    }
  }

  const content = ops.join('\n')
  const W = n(layout.w * PT_PER_MM)
  const Hp = n(layout.h * PT_PER_MM)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${Hp}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Title ${pdfString('Domino tape')} /Producer ${pdfString('Forma Studio')} >>`,
  ]
  // Every character is one byte (Latin-1), so string offsets are byte offsets.
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const bytes = new Uint8Array(out.length)
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff
  return bytes
}
