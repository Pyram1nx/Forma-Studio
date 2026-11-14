// Tape generator: printable ShaperTape-style domino strips (or a full sticker sheet) with a live
// preview, SVG / PDF download and a print path that prints only the sheet, at 100% scale.
// Domino rules and sources: see tapeGeometry.ts.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { downloadBlob } from '../../io/projectFile'
import { MM_PER_IN, type Units } from '../../model/types'
import * as Ic from '../../ui/icons'
import { DEFAULT_TAPE_OPTIONS, DOMINO_COUNT, PAGE_SIZES, layoutTape, type TapeOptions } from './tapeGeometry'
import { tapePdf } from './tapePdf'
import { tapeSvg } from './tapeSvg'
import './tape.css'

const STORE_KEY = 'formastudio:tape'

function loadOptions(): TapeOptions {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) return { ...DEFAULT_TAPE_OPTIONS, ...(JSON.parse(raw) as Partial<TapeOptions>) }
  } catch {
    /* storage unavailable or bad JSON: defaults */
  }
  return DEFAULT_TAPE_OPTIONS
}

function randomSeed(): string {
  const a = new Uint32Array(1)
  crypto.getRandomValues(a)
  return a[0].toString(36).padStart(6, '0').slice(-6)
}

function fileStem(o: TapeOptions, first: number): string {
  const seed = o.seed.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'tape'
  return `domino-tape-${seed}-${first}`
}

/** Print only the sheet: a hidden frame holding the SVG at its physical size, @page sized to match. */
function printSheet(svg: string, w: number, h: number) {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.className = 'tape-print-frame'
  document.body.appendChild(frame)
  const win = frame.contentWindow
  const doc = frame.contentDocument
  if (!win || !doc) {
    frame.remove()
    return
  }
  doc.open()
  doc.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>Domino tape</title><style>` +
      `@page{size:${w}mm ${h}mm;margin:0}` +
      `html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}` +
      `svg{display:block;width:${w}mm;height:${h}mm}` +
      `</style></head><body>${svg}</body></html>`,
  )
  doc.close()
  let done = false
  const cleanup = () => {
    if (done) return
    done = true
    frame.remove()
  }
  win.addEventListener('afterprint', () => setTimeout(cleanup, 0))
  // Give the frame a tick to lay out, then print. Fallback cleanup in case afterprint never fires.
  setTimeout(() => {
    win.focus()
    win.print()
    setTimeout(cleanup, 60_000)
  }, 50)
}

// ---------- Fields ----------

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="ss-field tape-field">
      <span className="ss-label">{label}</span>
      {children}
      {hint && <span className="tape-hint">{hint}</span>}
    </label>
  )
}

/** A number box that keeps what is typed until Enter or blur, then commits a clamped value. */
function NumberBox({
  value,
  onCommit,
  adorn,
  min,
  max,
  placeholder,
  ariaLabel,
}: {
  value: number | null
  onCommit: (v: number | null) => void
  adorn?: string
  min?: number
  max?: number
  placeholder?: string
  ariaLabel?: string
}) {
  const shown = value === null ? '' : String(value)
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const t = draft.trim()
    setDraft(null)
    if (t === '') return onCommit(null)
    const v = Number(t.replace(',', '.'))
    if (!Number.isFinite(v)) return
    onCommit(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)))
  }
  return (
    <span className="ss-input">
      <input
        type="text"
        inputMode="decimal"
        aria-label={ariaLabel}
        value={draft ?? shown}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setDraft(null)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
      {adorn && <span className="ss-input__adorn">{adorn}</span>}
    </span>
  )
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="ss-seg tape-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} type="button" aria-pressed={value === o.v} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ---------- Page ----------

export default function TapeGenerator({ units = 'mm' }: { units?: Units }) {
  const [opts, setOpts] = useState<TapeOptions>(loadOptions)
  const set = (patch: Partial<TapeOptions>) => setOpts((o) => ({ ...o, ...patch }))

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(opts))
    } catch {
      /* private mode etc.: settings just do not persist */
    }
  }, [opts])

  const layout = useMemo(() => layoutTape(opts), [opts])
  const svg = useMemo(() => tapeSvg(layout), [layout])

  // Lengths are stored in mm and shown in the user's units.
  const k = units === 'in' ? MM_PER_IN : 1
  const dp = units === 'in' ? 3 : 1
  const show = (mm: number) => Number((mm / k).toFixed(dp))
  const toMm = (v: number) => v * k
  const u = units

  const first = layout.dominoes[0]?.id ?? opts.start + 1
  const strips = opts.mode === 'strips'
  const count = layout.dominoes.length

  const downloadSvg = () => downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), fileStem(opts, first) + '.svg')
  const downloadPdf = () => downloadBlob(new Blob([tapePdf(layout) as BlobPart], { type: 'application/pdf' }), fileStem(opts, first) + '.pdf')

  const summary = strips
    ? `${count} dominoes · ${layout.rows} strip${layout.rows === 1 ? '' : 's'} of ${layout.perRow}`
    : `${count} dominoes · ${layout.rows} row${layout.rows === 1 ? '' : 's'} of ${layout.perRow}`

  return (
    <div className="tape">
      <header className="home__head">
        <div>
          <h1>Tape generator</h1>
          <p className="ss-muted">Print domino marker tape for Shaper Origin: strips to cut out, or a full sheet for sticker paper.</p>
        </div>
      </header>

      <div className="tape-layout">
        <aside className="tape-settings" aria-label="Tape settings">
          <section className="tape-group">
            <h2 className="ss-section-title">page</h2>
            <Field label="paper">
              <Seg
                label="Paper size"
                value={opts.page}
                onChange={(page) => set({ page })}
                options={[
                  { v: 'letter', label: PAGE_SIZES.letter.label },
                  { v: 'a4', label: PAGE_SIZES.a4.label },
                  { v: 'custom', label: 'Custom' },
                ]}
              />
            </Field>
            {opts.page === 'custom' && (
              <div className="tape-pair">
                <Field label="width">
                  <NumberBox value={show(opts.customW)} adorn={u} onCommit={(v) => v !== null && set({ customW: Math.max(20, toMm(v)) })} />
                </Field>
                <Field label="height">
                  <NumberBox value={show(opts.customH)} adorn={u} onCommit={(v) => v !== null && set({ customH: Math.max(20, toMm(v)) })} />
                </Field>
              </div>
            )}
            <Field label="orientation">
              <Seg
                label="Orientation"
                value={opts.orientation}
                onChange={(orientation) => set({ orientation })}
                options={[
                  { v: 'portrait', label: 'Portrait' },
                  { v: 'landscape', label: 'Landscape' },
                ]}
              />
            </Field>
            <Field label="margins" hint="Most printers leave about 5 mm unprinted at the edges.">
              <NumberBox value={show(opts.margin)} adorn={u} min={0} onCommit={(v) => v !== null && set({ margin: Math.min(60, toMm(v)) })} />
            </Field>
          </section>

          <section className="tape-group">
            <h2 className="ss-section-title">layout</h2>
            <Field label="print as">
              <Seg
                label="Print as"
                value={opts.mode}
                onChange={(mode) => set({ mode })}
                options={[
                  { v: 'strips', label: 'Strips' },
                  { v: 'sheet', label: 'Full sheet' },
                ]}
              />
            </Field>
            {strips ? (
              <div className="tape-pair">
                <Field label="strips">
                  <NumberBox
                    ariaLabel="Number of strips"
                    value={opts.stripCount > 0 ? opts.stripCount : null}
                    placeholder="fill page"
                    min={0}
                    onCommit={(v) => set({ stripCount: v === null ? 0 : Math.round(v) })}
                  />
                </Field>
                <Field label="strip length">
                  <NumberBox
                    value={opts.stripLength > 0 ? show(opts.stripLength) : null}
                    placeholder="full width"
                    adorn={u}
                    min={0}
                    onCommit={(v) => set({ stripLength: v === null ? 0 : toMm(v) })}
                  />
                </Field>
              </div>
            ) : (
              <p className="tape-hint tape-hint--block">For sticker or label paper: dominoes fill the page. Stick the sheet down whole, or cut it into pieces.</p>
            )}
            <div className="tape-pair">
              <Field label="domino gap">
                <NumberBox value={show(opts.dominoGap)} adorn={u} min={0} onCommit={(v) => v !== null && set({ dominoGap: Math.min(50, Math.max(1, toMm(v))) })} />
              </Field>
              <Field label={strips ? 'strip gap' : 'row gap'}>
                <NumberBox value={show(opts.rowGap)} adorn={u} min={0} onCommit={(v) => v !== null && set({ rowGap: Math.min(100, toMm(v)) })} />
              </Field>
            </div>
          </section>

          <section className="tape-group">
            <h2 className="ss-section-title">dominoes</h2>
            <Field label="seed" hint="The seed shuffles the 452 distinct dominoes. The same seed and start print the same sheet again.">
              <span className="tape-row">
                <span className="ss-input tape-grow">
                  <input type="text" aria-label="Seed" value={opts.seed} maxLength={40} onChange={(e) => set({ seed: e.target.value, start: 0 })} />
                </span>
                <button type="button" className="ss-btn ss-btn--sm" onClick={() => set({ seed: randomSeed(), start: 0 })}>
                  New seed
                </button>
              </span>
            </Field>
            <Field label="start at domino" hint="For more sheets in the same workspace, keep the seed and go to the next sheet, so no domino repeats.">
              <span className="tape-row">
                <span className="tape-grow">
                  <NumberBox ariaLabel="Start at domino" value={opts.start + 1} min={1} max={DOMINO_COUNT} onCommit={(v) => v !== null && set({ start: Math.round(v) - 1 })} />
                </span>
                <button type="button" className="ss-btn ss-btn--sm" disabled={!count} onClick={() => set({ start: layout.nextStart })}>
                  Next sheet
                </button>
              </span>
            </Field>
            <label className="ss-check">
              <input type="checkbox" checked={opts.footer} onChange={(e) => set({ footer: e.target.checked })} />
              Scale ruler and sheet label
            </label>
          </section>

          <p className="tape-note">
            <strong>Print at 100% scale</strong> (“Actual size”, not “Fit to page”), then measure the 50 mm bar. Use a laser printer or matte paper; glossy
            paper and smudged dots read poorly.
          </p>
        </aside>

        <section className="tape-preview" aria-label="Sheet preview">
          <div className="tape-actions">
            <button type="button" className="ss-btn ss-btn--sm" disabled={!count} onClick={downloadSvg}>
              <Ic.IconDownload /> SVG
            </button>
            <button type="button" className="ss-btn ss-btn--sm" disabled={!count} onClick={downloadPdf}>
              <Ic.IconDownload /> PDF
            </button>
            <button type="button" className="ss-btn ss-btn--sm ss-btn--primary" disabled={!count} onClick={() => printSheet(svg, layout.w, layout.h)}>
              Print
            </button>
          </div>
          <div className="tape-stage">
            <div
              className="tape-sheet"
              style={{ aspectRatio: `${layout.w} / ${layout.h}`, maxWidth: `min(100%, ${(layout.w / layout.h) * 70}vh)` }}
              role="img"
              aria-label={`Preview: ${summary}`}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
          <p className="tape-stats">
            {layout.problem ?? summary}
            {count > 0 && ` · dominoes ${layout.range} of ${DOMINO_COUNT}`}
          </p>
          {layout.wrapped && !layout.capped && (
            <p className="tape-warn">This sheet runs past domino {DOMINO_COUNT} and starts the sequence again, so it shares dominoes with the first sheet of this seed. Don’t use both in one workspace.</p>
          )}
          {layout.capped && <p className="tape-warn">There are only {DOMINO_COUNT} distinct dominoes, so the rest of the page is left empty.</p>}
        </section>
      </div>
    </div>
  )
}
