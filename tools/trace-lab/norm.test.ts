import { readFileSync, writeFileSync } from 'node:fs'
import { it } from 'vitest'
class ImageDataPoly { constructor(public width:number, public height:number){ this.data = new Uint8ClampedArray(width*height*4) } data: Uint8ClampedArray }
;(globalThis as Record<string, unknown>).ImageData = ImageDataPoly
import { detectPaperRgba } from '../../src/features/paper/detect'
import { computeHomography, warpPerspective } from '../../src/features/paper/homography'
import { grayFromImageData, normaliseLighting, paperLevelAndNoise } from '../../src/features/paper/ink'
import { decodeBmp } from './bmp'
import { encodePng } from './png'

it('norm dump', () => {
  const img = decodeBmp(readFileSync(new URL('./samples/photo1.bmp', import.meta.url)).buffer as ArrayBuffer)
  const det = detectPaperRgba(img.data, img.width, img.height)
  const d = (a:any,b:any)=>Math.hypot(a.x-b.x,a.y-b.y)
  const q = det.quad
  const wPx = (d(q[0],q[1])+d(q[3],q[2]))/2, hPx = (d(q[0],q[3])+d(q[1],q[2]))/2
  const ppm = 6, wMm = 210, hMm = wMm*hPx/wPx
  const outW = Math.round(wMm*ppm), outH = Math.round(hMm*ppm)
  const Hinv = computeHomography([{x:0,y:0},{x:outW,y:0},{x:outW,y:outH},{x:0,y:outH}], q)
  const src = new ImageDataPoly(img.width, img.height)
  src.data.set(img.data)
  const flat = warpPerspective(src as any, Hinv, outW, outH)
  const gray = grayFromImageData(flat as any)
  const norm = normaliseLighting(gray, outW, outH, ppm)
  const { paper, sigma } = paperLevelAndNoise(norm)
  writeFileSync(new URL('./out/photo1-norm.png', import.meta.url), (() => { const d = new Uint8ClampedArray(outW*outH*4); for (let i=0;i<norm.length;i++){ d[i*4]=d[i*4+1]=d[i*4+2]=norm[i]; d[i*4+3]=255 } return encodePng({data:d,width:outW,height:outH}) })())
  const lines = [`paper=${paper} sigma=${sigma.toFixed(2)}`]
  for (const [x,y] of [[1000,1700],[1100,1600],[1150,1500],[900,1750],[630,900],[400,400]]) {
    const i = y*outW+x
    lines.push(`(${x},${y}) gray=${gray[i]} norm=${norm[i]}`)
  }
  writeFileSync(new URL('./out/norm.txt', import.meta.url), lines.join('\n'))
})
