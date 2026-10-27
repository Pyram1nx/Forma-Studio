// A Shaper Trace test card (?view=tracecard): a perfect frame — dots exactly
// on their 9 mm slots, two sizes, on a black band — around a drawn rectangle
// of exactly 150 x 100 mm (to the line's centre). Shown full screen on any
// flat screen and scanned with Trace, it should measure 150.0 x 100.0 mm in
// centerline mode, whatever the screen's size: the dots set the scale. Unlike
// a photo of a real frame shown on screen, it carries no camera's lens bow of
// its own, so what is left is the scanning phone's.
import type { JSX } from 'react'
import { TRACK_LONG, TRACK_SHORT, slotPoints } from './traceDots'

const FRAME_W = 338
const FRAME_H = 248
const OPEN_W = 271.3
const OPEN_H = 182.3
const RECT_W = 150
const RECT_H = 100
const LINE = 1.2
const PAD = 14

/** Which slots hold a dot, and how big: a fixed pseudo-random code (about two in three filled). */
function dots(): { x: number; y: number; r: number }[] {
  let s = 3
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
  const ox = (FRAME_W - TRACK_LONG) / 2
  const oy = (FRAME_H - TRACK_SHORT) / 2
  return slotPoints(true)
    .filter(() => rand() < 0.68)
    .map((p) => ({ x: ox + p.x, y: oy + p.y, r: rand() < 0.4 ? 1.8 : 1.15 }))
}

export default function TraceTestCard(): JSX.Element {
  const cx = FRAME_W / 2
  const cy = FRAME_H / 2
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: '#6b625a', display: 'grid', placeItems: 'center', cursor: 'pointer' }}
      title="Click for full screen"
      onClick={() => void document.documentElement.requestFullscreen?.().catch(() => undefined)}
    >
      <svg
        viewBox={`${-PAD} ${-PAD} ${FRAME_W + 2 * PAD} ${FRAME_H + 2 * PAD}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: '100vw', height: '100vh', display: 'block' }}
        aria-label={`Trace test card: rectangle ${RECT_W} x ${RECT_H} mm`}
      >
        <rect x={0} y={0} width={FRAME_W} height={FRAME_H} rx={10} fill="#141414" />
        <rect x={cx - OPEN_W / 2} y={cy - OPEN_H / 2} width={OPEN_W} height={OPEN_H} rx={6} fill="#f2f2ef" />
        {dots().map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={d.r} fill="#f4f4f4" />
        ))}
        <rect x={cx - RECT_W / 2} y={cy - RECT_H / 2} width={RECT_W} height={RECT_H} fill="none" stroke="#161616" strokeWidth={LINE} />
        <text x={cx} y={FRAME_H + PAD * 0.62} textAnchor="middle" fontSize={5} fill="#ece8e2" fontFamily="system-ui, sans-serif">
          Trace test card · rectangle {RECT_W} × {RECT_H} mm (centerline) · show full screen on a flat screen
        </text>
      </svg>
    </div>
  )
}
