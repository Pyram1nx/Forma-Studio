// Trace lab: runs the full paper pipeline (detect -> warp -> ink -> vectorise)
// over real + synthetic photos in Node and writes previews I can inspect.
//   npx vitest run tools/trace-lab/lab.test.ts
// Outputs land in tools/trace-lab/out/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Node has no ImageData; warpPerspective only needs {data,width,height}.
class ImageDataPoly {
  data: Uint8ClampedArray
  width: number
  height: number
  constructor(w: number, h: number) {
    this.data = new Uint8ClampedArray(w * h * 4)
    this.width = w
    this.height = h
  }
}
;(globalThis as Record<string, unknown>).ImageData = ImageDataPoly

import { detectPaperRgba } from '../../src/features/paper/detect'
import { computeHomography, warpPerspective } from '../../src/features/paper/homography'
import { buildInkMask, grayFromImageData } from '../../src/features/paper/ink'
import { vectorise } from '../../src/features/paper/trace'
import { decodeBmp, type RgbaImage } from './bmp'
import { encodePng, grayPng } from './png'
import { synthPhoto } from './synth'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, 'out')
const samples = join(here, 'samples')
mkdirSync(outDir, { recursive: true })

interface CaseResult {
  name: string
  found: boolean
  reason: string
  cornersError: number[] | null
  lines: number
  strokeWidthMm: number
  inkPx: number
}

function cornersErrorPx(detected: { x: number; y: number }[], truth: { x: number; y: number }[] | null) {
  if (!truth) return null
  return detected.map((p) => Math.min(...truth.map((t) => Math.hypot(p.x - t.x, p.y - t.y))))
}

/** Full pipeline on one photo; writes preview PNGs + vector SVG into outDir. */
async function runCase(
  name: string,
  img: RgbaImage,
  opts: { ppm?: number; truth?: { x: number; y: number }[] | null } = {},
): Promise<CaseResult> {
  const ppm = opts.ppm ?? 6
  const det = detectPaperRgba(img.data, img.width, img.height)
  const err = cornersErrorPx(det.quad, opts.truth ?? null)

  // Flatten using A4-ish proportions derived from the quad (like the UI: user
  // picks the size; here we use the detected quad's own aspect at a fixed width).
  const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
  const q = det.quad
  const wPx = (d(q[0], q[1]) + d(q[3], q[2])) / 2
  const hPx = (d(q[0], q[3]) + d(q[1], q[2])) / 2
  const wMm = 210
  const hMm = (wMm * hPx) / wPx
  const outW = Math.round(wMm * ppm)
  const outH = Math.round(hMm * ppm)
  const Hinv = computeHomography(
    [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }],
    q,
  )
  const src = new ImageDataPoly(img.width, img.height)
  src.data.set(img.data)
  const flat = warpPerspective(src as unknown as ImageData, Hinv, outW, outH)
  const gray = grayFromImageData(flat as unknown as ImageData)

  const inkOpts = { ppm, sensitivity: 50, cOffset: 0, marginMm: 3, minBlobMm2: 3, closeGaps: false }
  const mask = buildInkMask(gray, outW, outH, inkOpts)
  let inkPx = 0
  for (let i = 0; i < mask.length; i++) inkPx += mask[i]
  const vec = await vectorise(mask, outW, outH, ppm, 'centerline')

  // Previews: B/W pixel render, ink mask, vector SVG.
  const bw = new Uint8ClampedArray(outW * outH * 4)
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i] < 150 ? 0 : 255
    bw[i * 4] = v
    bw[i * 4 + 1] = v
    bw[i * 4 + 2] = v
    bw[i * 4 + 3] = 255
  }
  writeFileSync(join(outDir, `${name}-bw.png`), encodePng({ data: bw, width: outW, height: outH }))
  writeFileSync(join(outDir, `${name}-mask.png`), grayPng(mask, outW, outH))
  const parts: string[] = []
  for (const g of vec.groups) {
    for (const c of g) {
      if (c.pts.length < 2) continue
      parts.push('M' + c.pts.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('L') + (c.closed ? 'Z' : ''))
    }
  }
  writeFileSync(
    join(outDir, `${name}-vec.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${outW / ppm} ${outH / ppm}"><rect width="100%" height="100%" fill="white"/><path d="${parts.join('')}" fill="none" stroke="black" stroke-width="0.3"/></svg>`,
  )

  return {
    name,
    found: det.found,
    reason: det.reason,
    cornersError: err,
    lines: vec.lineCount,
    strokeWidthMm: vec.strokeWidthMm,
    inkPx,
  }
}

describe('trace lab: real photo', () => {
  it('nails the user photo (circle + rectangle on A4, shadowed desk)', async () => {
    const bmpPath = join(samples, 'photo1.bmp')
    if (!existsSync(bmpPath)) return console.warn('photo1.bmp missing — skipping')
    const img = decodeBmp(readFileSync(bmpPath).buffer as ArrayBuffer)
    const r = await runCase('photo1', img)
    console.log('photo1', JSON.stringify(r))
    expect(r.found).toBe(true)
    // Exactly two drawings: the circle and the rectangle.
    expect(r.lines).toBe(2)
  })
})

describe('trace lab: synthetic photos', () => {
  it('handles shadow, noise, dark desk and perspective', async () => {
    const cases = synthPhoto.allCases()
    for (const c of cases) {
      const r = await runCase(c.name, c.img, { truth: c.truth })
      console.log(c.name, JSON.stringify(r))
      expect(r.found).toBe(true)
      expect(Math.max(...(r.cornersError ?? [0]))).toBeLessThan(4)
      expect(r.lines).toBe(c.expectedLines)
    }
  }, 60000)
})
