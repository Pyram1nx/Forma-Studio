import { useEffect, useState } from 'react'
import * as Ic from '../ui/icons'
import '../styles/landing.css'

// Grid order matches the layout: top-left, top-middle, wide bottom, tall right.
const FEATURES = [
  { title: 'Works on any device', body: 'Open Forma Studio in a browser on your laptop, tablet or phone.', tone: 'dark', icons: true },
  { title: 'Real-world units', body: 'Draw in millimetres or inches and see exactly what Origin will cut. What you design is the size you get.', tone: 'blue', image: '/images/caliper.png', imageClass: 'landing-feature-caliper' },
  { title: 'SVGs for Shaper Origin', body: 'Export clean SVGs with cut types, offsets and depths set, in a format Shaper Origin can open. Unofficial; not affiliated with Shaper Tools.', tone: 'graphite' },
  { title: '3D carve and paper scan', body: 'Turn a relief into a toolpath plan, or trace a sketch on paper into editable shapes.', tone: 'light', image: '/images/iphone-carve.png' },
] as const

// Alternating image/text rows in How it works. Every image sits in the same 4:3 frame: photos fill
// it, art drawn on white sits on a matching light tile. `images` with more than one entry splits
// the frame into equal columns.
const SHOWCASE = [
  {
    eyebrow: 'Design · Plan · Review',
    title: 'See every cut before you make it',
    body: 'The studio follows the way you already think about a project, in three modes you switch between at any time.',
    points: [
      'Design: draw with shapes, text and freehand paths, and line everything up to the millimetre.',
      'Plan: set how each path is cut (inside, outside, on the line or pocket) with its own depth and bit.',
      'Review: see the finished piece shaded by depth, so mistakes show up on screen, not in your wood.',
    ],
    images: [{ src: '/images/origin-ready.jpg', fit: 'cover', position: '50% 55%' }],
  },
  {
    eyebrow: 'Trace',
    title: 'Turn a sketch or picture into cut paths',
    body: 'Draw it by hand or start from any picture. Trace turns the lines into clean, editable shapes at their real size.',
    points: [
      'Shaper Trace frame: lay your drawing in the frame and take a photo. The frame straightens the picture and sets the exact scale.',
      'Plain paper: no frame needed. Photograph a sheet of A4, Letter or similar and the studio uses its edges to get the size right.',
      'Any image: vectorize a logo, photo or scan into outlines you can resize, edit and cut.',
    ],
    images: [{ src: '/images/Trace.jpeg', fit: 'cover', position: '50% 50%' }],
  },
  {
    eyebrow: '3D carve',
    title: 'Carve 3D models with a handheld router',
    body: 'Bring in a 3D model and the studio slices it into layers of cut paths that Shaper Origin can follow, one depth at a time.',
    points: [
      'Opens STL, OBJ and glTF files, in millimetres, centimetres, metres or inches.',
      'Plans a fast roughing pass, a finishing pass and fine detail, each with the right bit.',
      'Flips the block for parts that need carving from more than one side, and previews the result in 3D first.',
    ],
    images: [{ src: '/images/carve-3d.jpg', fit: 'cover', position: '50% 50%' }],
  },
  {
    eyebrow: 'Bit gallery',
    title: 'Your bits, set up once',
    body: 'Keep the bits you own in one place and pick them by name whenever you plan a cut. No more looking up specs or typing the same numbers twice.',
    points: [
      'The full Shaper bit range is ready to add, with photos and sizes filled in.',
      'Add your own bits with diameter, flute length and notes, saved as presets.',
      'Choosing a bit fills in its settings for you.',
    ],
    images: [
      { src: '/bit-images/SF1-8-8DP.webp', fit: 'cover', position: '50% 50%' },
      { src: '/bit-images/SE1-2500-V90E.webp', fit: 'cover', position: '50% 50%' },
      { src: '/bit-images/SF1-8-3U.webp', fit: 'cover', position: '50% 50%' },
    ],
  },
  {
    eyebrow: 'Connected caliper',
    title: 'Measure it, and the number is already there',
    body: 'Plug in a digital caliper, click a field and press send on the caliper. The reading goes straight into the box, with no typing and no misread digits.',
    points: [
      'Unit intelligence: the studio can tell whether the caliper sent millimetres or inches.',
      'If the caliper is set to the wrong unit, the reading is converted to your design’s units for you.',
      'The field flashes green, so you always know the value came from the caliper.',
    ],
    images: [{ src: '/images/caliper.png', fit: 'cover', position: '50% 45%' }],
  },
  {
    eyebrow: 'Account',
    title: 'Your workshop on every device',
    body: 'Sign in with a free account to keep your work in the cloud. Start a design at your desk and open it on the tablet next to your machine.',
    points: [
      'Designs are saved to your account and open on any device you sign in on.',
      'Your bit gallery comes with you too.',
      'Optional: without an account, everything still works and stays on your device.',
    ],
    images: [{ src: '/images/account-sync.svg', fit: 'cover', position: '50% 50%' }],
  },
] as const

const REPO_URL ='https://github.com/Pyram1nx/Forma-Studio'
const RELEASES_URL = REPO_URL + '/releases/latest'

const FAQ = [
  { q: 'Do I need an account?', a: 'No. Designs are saved on your device. An account is only needed if you want to sign in across devices.' },
  { q: 'Which files can I export?', a: 'SVG files that Shaper Origin reads directly, with cut types and depths preserved.' },
  { q: 'Does it work offline?', a: 'Yes. Everything runs on your device, and the desktop app works without a connection.' },
  { q: 'Can I use it on my phone?', a: 'Yes. The studio has a touch layout for phones and tablets.' },
]

/** One FAQ row. The answer animates open by growing its grid row from 0fr to 1fr. */
function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="landing-faq">
      <button type="button" className="landing-faq-summary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {q}
        <svg className="landing-faq-icon" data-open={open} width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
          <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z" />
        </svg>
      </button>
      <div className="landing-faq-body" data-open={open}>
        <div>
          <p>{a}</p>
        </div>
      </div>
    </div>
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
          <span className="forma-wordmark">Forma Studio</span>
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
        <h1 className="forma-wordmark">FORMA STUDIO</h1>
        <p>The simplified design tool for craftspeople. Free and open-source.</p>
        <div className="landing-cta">
          <a className="ss-btn ss-btn--primary landing-btn" href="/studio">Start designing</a>
          <a className="ss-btn landing-btn" href={RELEASES_URL} target="_blank" rel="noreferrer"><Ic.IconGitHub size={18} />Download</a>
        </div>
      </section>

      <section className="landing-section" id="features">
        <h2>Spend more time making. Less time fussing with a computer.</h2>
        <div className="landing-feature-grid">
          {FEATURES.map((f) => (
            <article key={f.title} className={`landing-feature landing-feature--${f.tone}`}>
              {'icons' in f && (
                <div className="landing-feature-os" aria-hidden="true">
                  <Ic.IconAppleOutline size={56} />
                  <Ic.IconWindowsOutline size={56} />
                  <Ic.IconLinuxOutline size={56} />
                </div>
              )}
              {'image' in f && <img className={'imageClass' in f ? f.imageClass : 'landing-feature-media'} src={f.image} alt="" loading="lazy" />}
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-section landing-section--dark" id="how">
        <p className="landing-eyebrow">What’s inside</p>
        <h2>From first sketch to finished cut</h2>
        <div className="landing-showcase">
          {SHOWCASE.map((s) => (
            <article key={s.eyebrow} className="landing-showcase-row">
              <div className="landing-showcase-media">
                {s.images.map((img) => (
                  <img key={img.src} src={img.src} alt="" loading="lazy" style={{ objectFit: img.fit, objectPosition: img.position }} />
                ))}
              </div>
              <div className="landing-showcase-text">
                <p className="landing-eyebrow">{s.eyebrow}</p>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
                <ul>
                  {s.points.map((p) => <li key={p}>{p}</li>)}
                </ul>
              </div>
            </article>
          ))}
        </div>
        <a className="ss-btn ss-btn--primary landing-btn" href="/studio">Start designing</a>
      </section>

      <section className="landing-section landing-section--gradient" id="get-started">
        <h2 className="landing-section-title">Get started</h2>
        <p className="landing-section-lead">Free in your browser. Native on your desktop.</p>
        <div className="landing-plans">
          <article className="landing-plan">
            <div className="landing-plan-head"><h3>Web</h3></div>
            <hr className="landing-plan-rule" />
            <div className="landing-plan-body">
              <div className="landing-icon-row" aria-hidden="true">
                <Ic.IconMobileOutline size={28} />
                <Ic.IconDesktopOutline size={28} />
              </div>
              <p className="landing-price">Free</p>
              <p>Open the studio instantly in any modern browser. Designs are saved on your device.</p>
            </div>
            <a className="landing-plan-bar landing-plan-bar--blue" href="/studio">Open studio</a>
          </article>
          <article className="landing-plan">
            <div className="landing-plan-head"><h3>Desktop</h3></div>
            <hr className="landing-plan-rule" />
            <div className="landing-plan-body">
              <div className="landing-icon-row" aria-hidden="true">
                <Ic.IconAppleOutline size={28} />
                <Ic.IconWindowsOutline size={28} />
                <Ic.IconLinuxOutline size={28} />
              </div>
              <p className="landing-price">Free</p>
              <p>Windows, macOS and Linux apps that work offline and update themselves.</p>
            </div>
            <a className="landing-plan-bar landing-plan-bar--white" href={RELEASES_URL} target="_blank" rel="noreferrer">Download</a>
          </article>
        </div>
      </section>

      <section className="landing-section landing-section--faq" id="faq">
        <h2 className="landing-faq-title">Frequently asked questions</h2>
        {FAQ.map((f) => (
          <FaqItem key={f.q} q={f.q} a={f.a} />
        ))}
      </section>

      <footer className="landing-footer">
        <div className="landing-footer-cols">
          <div className="landing-footer-col">
            <h6>Product</h6>
            <ul>
              <li><a href="/studio">Studio</a></li>
              <li><a href="#features">Features</a></li>
              <li><a href="#how">How it works</a></li>
              <li><a href="#faq">FAQ</a></li>
            </ul>
          </div>
          <div className="landing-footer-col">
            <h6>Resources</h6>
            <ul>
              <li><a href={RELEASES_URL} target="_blank" rel="noreferrer">Downloads</a></li>
              <li><a href={REPO_URL} target="_blank" rel="noreferrer">GitHub</a></li>
              <li><a href="/account">Account</a></li>
            </ul>
          </div>
        </div>
        <div className="landing-footer-bottom">
          <a className="landing-brand" href="/">
            <Ic.FormaLogo size={22} />
            <span className="forma-wordmark">Forma Studio</span>
          </a>
          <a className="landing-footer-pill" href="/studio">Open studio</a>
        </div>
      </footer>
    </div>
  )
}
