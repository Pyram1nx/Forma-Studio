// Account home: the Joints page. The Joinery tool cuts dovetails (with a dovetail bit, or fine-pin
// with straight bits only) and Knapp joints; the cards are the layouts it can start from. Picking one opens /joinery with that layout set
// (features/dovetail/joineryStart.ts); Close in the tool comes back here.
import { useId } from 'react'
import type { Units } from '../model/types'
import { openToolFromAccount } from '../features/toolRoutes'
import { setJoineryStart, type JointLayout } from '../features/dovetail/joineryStart'
import * as Ic from '../ui/icons'
import './jointsPage.css'

/** Drawing of one layout, in illustration units: board width, tail count, pin width at the baseline. */
interface Sketch {
  width: number
  tails: number
  pin: number
  /** How much each flank leans over the joint depth (default FLARE). */
  flare?: number
  /** Draw a Knapp joint instead: `tails` dowels across `width`. */
  knapp?: boolean
}

interface Joint {
  id: JointLayout
  name: string
  description: string
  sketch: Sketch
}

const JOINTS: Joint[] = [
  {
    id: 'through',
    name: 'Through dovetail',
    description: 'Tails about twice the pin width, spread evenly across the board.',
    sketch: { width: 140, tails: 4, pin: 17 },
  },
  {
    id: 'single',
    name: 'Single tail',
    description: 'One wide tail between two half pins, for rails and narrow stock.',
    sketch: { width: 70, tails: 1, pin: 18 },
  },
  {
    id: 'fine',
    name: 'Fine dovetails',
    description: 'As many tails as the straight bit leaves room for, for drawer sides.',
    sketch: { width: 140, tails: 7, pin: 14 },
  },
  {
    id: 'wide-pins',
    name: 'Wide pins',
    description: 'Pins twice the bit diameter, cut as pockets, for a bolder pattern.',
    sketch: { width: 140, tails: 3, pin: 26 },
  },
  {
    id: 'fine-pin',
    name: 'Fine-pin dovetails',
    description: 'Hairline pins with straight bits only: no dovetail bit needed.',
    sketch: { width: 140, tails: 6, pin: 10, flare: 4 },
  },
  {
    id: 'knapp',
    name: 'Knapp joint',
    description: 'The pin-and-cove drawer joint: dowels on the front, coves on the side.',
    sketch: { width: 140, tails: 5, pin: 0, knapp: true },
  },
]

// Illustration frame (viewBox units): the widest board, 140 wide, centred in a 200 wide frame,
// cropped to the drawing with a little air around it.
const VIEW_W = 200
const VIEW_BOX = '18 16 164 86'
/** Top of the tail board and its baseline (the pin board's inside face). */
const TOP = 26
const BASE = 66
/** Joint depth: the pin board's thickness, the tails' length. */
const DEPTH = 26
/** How much each flank leans over the joint depth (about an 11° bit, drawn deeper than life). */
const FLARE = 5

const f = (n: number) => +n.toFixed(2)
const poly = (pts: [number, number][]) => 'M' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L') + 'Z'

/**
 * The joint as seen on the tail board's face: the tail board above, its tails flaring into the
 * pin board's end grain, the pins (half pins at the edges) between them.
 */
/**
 * A Knapp joint on the drawer side's face: the side above with a half-round cove per dowel, the
 * dowel ends in it, the front's end grain between the coves and across the lap.
 */
function KnappSketch({ sketch }: { sketch: Sketch }) {
  const uid = 'jk' + useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const { width: W, tails: n } = sketch
  const x0 = (VIEW_W - W) / 2
  const x1 = x0 + W
  const end = BASE + DEPTH
  const pitch = W / n
  const R = pitch * 0.48
  const cy = BASE + 4
  const centres = Array.from({ length: n }, (_, k) => x0 + pitch * (k + 0.5))
  // Side outline: across the top, down the right edge, then each cove right to left.
  let side = `M${f(x0)} ${TOP}H${f(x1)}V${f(cy)}`
  for (let k = n - 1; k >= 0; k--) {
    const c = centres[k]
    side += `H${f(Math.min(x1, c + R))}A${f(R)} ${f(R)} 0 0 1 ${f(Math.max(x0, c - R))} ${f(cy)}`
  }
  side += `H${f(x0)}Z`
  return (
    <svg className="home-joints-sketch" viewBox={VIEW_BOX} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs>
        <clipPath id={`${uid}-front`}>
          <rect x={x0} y={TOP} width={W} height={end - TOP} />
        </clipPath>
      </defs>
      <rect x={x0} y={BASE - 6} width={W} height={end - BASE + 6} className="home-joints-sketch__pin" />
      <g clipPath={`url(#${uid}-front)`} className="home-joints-sketch__rings">
        {centres.map((c) => [9, 16].map((r) => <circle key={`${c}-${r}`} cx={f(c)} cy={end + 2} r={r} />))}
      </g>
      <path d={side} className="home-joints-sketch__tail" />
      {centres.map((c) => (
        <circle key={c} cx={f(c)} cy={f(cy)} r={f(pitch * 0.2)} className="home-joints-sketch__pin" />
      ))}
      <path d={side} className="home-joints-sketch__edge" />
      {centres.map((c) => (
        <circle key={`e${c}`} cx={f(c)} cy={f(cy)} r={f(pitch * 0.2)} className="home-joints-sketch__edge" />
      ))}
    </svg>
  )
}

function JointSketch({ sketch }: { sketch: Sketch }) {
  const uid = 'jt' + useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const { width: W, tails: n, pin: pw } = sketch
  const x0 = (VIEW_W - W) / 2
  const x1 = x0 + W
  const end = BASE + DEPTH
  const pn = pw - 2 * (sketch.flare ?? FLARE)
  const pitch = W / n
  const centres = Array.from({ length: n + 1 }, (_, k) => x0 + k * pitch)
  const clamp = (x: number) => Math.min(x1, Math.max(x0, x))

  // Tail board outline: across the top, down the right edge, then each tail right to left.
  const tailPts: [number, number][] = [
    [x0, TOP],
    [x1, TOP],
    [x1, BASE],
  ]
  for (let k = n; k >= 1; k--) {
    const r = centres[k]
    const l = centres[k - 1]
    tailPts.push([r - pw / 2, BASE], [r - pn / 2, end], [l + pn / 2, end], [l + pw / 2, BASE])
  }
  tailPts.push([x0, BASE])
  const tailPath = poly(tailPts)

  const pins = centres.map((c) =>
    poly([
      [clamp(c - pn / 2), end],
      [clamp(c + pn / 2), end],
      [clamp(c + pw / 2), BASE],
      [clamp(c - pw / 2), BASE],
    ]),
  )

  // Long grain on the tail board, gently wavy, running into the tails.
  const lines = Math.max(3, Math.round(W / 16))
  const grain = Array.from({ length: lines }, (_, i) => {
    const x = x0 + ((i + 0.5) * W) / lines
    const w = i % 2 ? 1.6 : -1.6
    return `M${f(x)} ${TOP + 4}C${f(x + w)} ${TOP + 26} ${f(x - w)} ${BASE - 16} ${f(x + w * 0.5)} ${end}`
  })

  return (
    <svg className="home-joints-sketch" viewBox={VIEW_BOX} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs>
        <clipPath id={`${uid}-tail`}>
          <path d={tailPath} />
        </clipPath>
        <clipPath id={`${uid}-pins`}>
          {pins.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </clipPath>
      </defs>
      <path d={tailPath} className="home-joints-sketch__tail" />
      <g clipPath={`url(#${uid}-tail)`} className="home-joints-sketch__grain">
        {grain.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
      {pins.map((d, i) => (
        <path key={i} d={d} className="home-joints-sketch__pin" />
      ))}
      {/* End grain on the pins: growth rings centred below the pin board's outer face. */}
      <g clipPath={`url(#${uid}-pins)`} className="home-joints-sketch__rings">
        {centres.map((c) =>
          [8, 15, 22].map((r) => <circle key={`${c}-${r}`} cx={f(c)} cy={end + 4} r={r} />),
        )}
      </g>
      <path d={tailPath} className="home-joints-sketch__edge" />
      {pins.map((d, i) => (
        <path key={i} d={d} className="home-joints-sketch__edge" />
      ))}
    </svg>
  )
}

const STEPS = [
  { title: 'Pick a joint', text: 'Dovetails with a dovetail bit, fine-pin dovetails with straight bits only, or a Knapp joint.' },
  { title: 'Set the boards', text: 'Enter the board sizes and bits. Every other number has an automatic value you can override.' },
  { title: 'Cut', text: 'Add both layouts to a design and follow the cut card: which board, which bit, how deep.' },
]

/** The account home's Joints page: the Joinery tool's layouts, each opening the tool. */
export default function JointsPage(_props: { units?: Units } = {}) {
  const open = (layout: JointLayout | null) => {
    setJoineryStart(layout)
    openToolFromAccount('joinery', 'joints')
  }

  return (
    <section className="home-joints">
      <header className="home__head">
        <div>
          <h1>Joints</h1>
          <p className="ss-muted">
            Dovetails, fine-pin dovetails and Knapp joints, previewed in 3D. Pick a starting point, tune it in Joinery and add both boards to a design.
          </p>
        </div>
        <button className="ss-btn ss-btn--primary" onClick={() => open(null)}>
          <Ic.IconNewFile size={16} /> New joint
        </button>
      </header>

      <ul className="home-grid home-joints-grid">
        {JOINTS.map((j) => (
          <li key={j.id}>
            <button className="home-card home-joints-card" onClick={() => open(j.id)} aria-label={`Open Joinery with ${j.name}`}>
              <span className="home-card__thumb home-joints-card__thumb">
                {j.sketch.knapp ? <KnappSketch sketch={j.sketch} /> : <JointSketch sketch={j.sketch} />}
              </span>
              <span className="home-card__name">{j.name}</span>
              <span className="home-card__meta home-joints-card__desc">{j.description}</span>
            </button>
          </li>
        ))}
      </ul>

      <ol className="home-joints-steps" aria-label="How a joint is cut">
        {STEPS.map((s, i) => (
          <li key={s.title} className="home-joints-steps__item">
            <span className="home-joints-steps__num" aria-hidden="true">
              {i + 1}
            </span>
            <span>
              <span className="home-joints-steps__title">{s.title}</span>
              <span className="ss-muted home-joints-steps__text">{s.text}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
