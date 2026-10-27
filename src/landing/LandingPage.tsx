import { useEffect } from 'react'
import * as Ic from '../ui/icons'
import '../styles/landing.css'

const FEATURES = [
  { title: 'Works on any device', body: 'Open Forma Studio in a browser on your laptop, tablet or phone. No install, no sync dance.', art: 'devices' },
  { title: 'Real-world units', body: 'Draw in millimetres or inches and see exactly what Origin will cut. What you design is the size you get.', art: 'ruler' },
  { title: 'Origin-ready files', body: 'Export clean SVGs with the right cut types, offsets and depths in minutes, ready for your Shaper Origin.', art: 'export' },
  { title: '3D carve and paper scan', body: 'Turn a relief into a toolpath plan, or trace a sketch on paper into editable shapes.', art: 'carve' },
] as const

const STEPS = [
  { n: '01', title: 'Combine shapes', body: 'Start from rectangles, circles, polygons and stars. Union, subtract and intersect them into anything.' },
  { n: '02', title: 'Add text', body: 'Set type in any font on your system, then turn it into outlines ready to cut.' },
  { n: '03', title: 'Plan the cut', body: 'Choose inside, outside, on-line or pocket cuts, set depth and bit, and review the plan before you head to the shop.' },
]

const REPO_URL = 'https://github.com/Pyram1nx/Forma-Studio'

const FAQ = [
  { q: 'Do I need an account?', a: 'No. Designs are saved on your device. An account is only needed if you want to sign in across devices.' },
  { q: 'Which files can I export?', a: 'SVG files that Shaper Origin reads directly, with cut types and depths preserved.' },
  { q: 'Does it work offline?', a: 'Yes. Everything runs on your device, and the desktop app works without a connection.' },
  { q: 'Can I use it on my phone?', a: 'Yes. The studio has a touch layout for phones and tablets.' },
]

function Art({ kind }: { kind: (typeof FEATURES)[number]['art'] }) {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const
  return (
    <svg viewBox="0 0 200 120" className="landing-art" aria-hidden="true">
      {kind === 'devices' && (
        <g {...stroke}>
          <rect x="30" y="22" width="110" height="72" rx="6" />
          <path d="M20 100h130" />
          <rect x="150" y="40" width="32" height="56" rx="6" />
        </g>
      )}
      {kind === 'ruler' && (
        <g {...stroke}>
          <rect x="24" y="40" width="152" height="40" rx="4" />
          {Array.from({ length: 13 }, (_, i) => (
            <path key={i} d={`M${36 + i * 11.5} 40v${i % 4 === 0 ? 18 : 10}`} />
          ))}
        </g>
      )}
      {kind === 'export' && (
        <g {...stroke}>
          <path d="M60 20h56l24 24v56H60z" />
          <path d="M116 20v24h24" />
          <circle cx="100" cy="76" r="14" strokeDasharray="4 5" />
        </g>
      )}
      {kind === 'carve' && (
        <g {...stroke}>
          <path d="M24 90 70 40l30 30 26-36 50 56z" />
          <path d="M24 100h152" />
        </g>
      )}
    </svg>
  )
}

/** The public home page, served at the root of the site. */
export default function LandingPage() {
  useEffect(() => {
    document.title = 'Forma Studio: the simplified design tool for craftspeople'
  }, [])

  return (
    <div className="landing">
      <header className="landing-nav">
        <a className="landing-brand" href="/">
          <Ic.FormaLogo size={28} />
          <span>Forma Studio</span>
        </a>
        <nav aria-label="Main">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#faq">FAQ</a>
          <a href="/account">Account</a>
          <a href={REPO_URL} target="_blank" rel="noreferrer">GitHub</a>
          <a className="ss-btn ss-btn--primary" href="/studio">Open studio</a>
        </nav>
      </header>

      <section className="landing-hero">
        <Ic.FormaLogo size={72} />
        <h1>The simplified design tool for craftspeople</h1>
        <p>Draw, plan and export cuts for Shaper Origin from any device. Everything you need, nothing you don't.</p>
        <div className="landing-cta">
          <a className="ss-btn ss-btn--primary landing-btn" href="/studio">Start designing</a>
          <a className="ss-btn landing-btn" href="#how">See how it works</a>
        </div>
        <div className="landing-shot" aria-hidden="true">
          <div className="landing-shot__bar"><i /><i /><i /></div>
          <svg viewBox="0 0 640 300">
            <rect x="40" y="40" width="560" height="220" fill="none" stroke="#b9bcc6" strokeDasharray="6 6" />
            <rect x="120" y="90" width="200" height="120" rx="14" fill="#e2eaff" stroke="#0546f6" strokeWidth="3" />
            <circle cx="430" cy="150" r="70" fill="#2a2b2d" />
            <circle cx="430" cy="150" r="34" fill="#fdfdfe" stroke="#1be09e" strokeWidth="3" />
            <text x="170" y="158" fontSize="28" fontWeight="600" fill="#0546f6">FORMA</text>
          </svg>
        </div>
      </section>

      <section className="landing-section" id="features">
        <p className="landing-eyebrow">Everything you need, nothing you don't</p>
        <h2>Spend more time making. Less time fussing with a computer.</h2>
        <div className="landing-grid">
          {FEATURES.map((f) => (
            <article key={f.title} className="landing-card">
              <Art kind={f.art} />
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-section landing-section--dark" id="how">
        <p className="landing-eyebrow">How it all works</p>
        <h2>From idea to cut in three steps</h2>
        <ol className="landing-steps">
          {STEPS.map((s) => (
            <li key={s.n}>
              <span>{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
        <a className="ss-btn ss-btn--primary landing-btn" href="/studio">Start designing</a>
      </section>

      <section className="landing-section" id="get-started">
        <p className="landing-eyebrow">Get started</p>
        <h2>Free in your browser. Native on your desktop.</h2>
        <div className="landing-plans">
          <article className="landing-card">
            <h3>Web</h3>
            <p className="landing-price">Free</p>
            <p>Open the studio instantly in any modern browser. Designs are saved on your device.</p>
            <a className="ss-btn ss-btn--primary landing-btn" href="/studio">Open studio</a>
          </article>
          <article className="landing-card">
            <h3>Desktop</h3>
            <p className="landing-price">Free</p>
            <p>Windows, macOS and Linux apps that work offline and update themselves.</p>
            <a className="ss-btn landing-btn" href="/account">Your account</a>
          </article>
        </div>
      </section>

      <section className="landing-section landing-section--narrow" id="faq">
        <p className="landing-eyebrow">FAQ</p>
        <h2>Questions, answered</h2>
        {FAQ.map((f) => (
          <details key={f.q} className="landing-faq">
            <summary>{f.q}</summary>
            <p>{f.a}</p>
          </details>
        ))}
      </section>

      <footer className="landing-footer">
        <a className="landing-brand" href="/">
          <Ic.FormaLogo size={22} />
          <span>Forma Studio</span>
        </a>
        <nav aria-label="Footer">
          <a href="/studio">Studio</a>
          <a href="/account">Account</a>
          <a href="#faq">FAQ</a>
          <a href={REPO_URL} target="_blank" rel="noreferrer">GitHub</a>
        </nav>
      </footer>
    </div>
  )
}
