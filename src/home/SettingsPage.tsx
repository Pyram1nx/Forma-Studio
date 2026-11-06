// The account's Settings tab: presets every new design and new shape start with, so the user
// does not set units, grid, snapping and cut settings again each time. Stored by state/prefs.
import type { ReactNode } from 'react'
import { BIT_PRESETS, CUT_TYPES, NumField } from '../editor/Panels'
import { allBits, useBitLibrary } from '../features/bitlibrary/library'
import { fmtLen } from '../model/factory'
import { MM_PER_IN, SNAP_KINDS, type SnapKind, type Units } from '../model/types'
import { DEFAULT_PREFS, usePrefs, type Prefs } from '../state/prefs'
import { lastUnits } from '../state/store'
import { THEME_LABELS, THEME_PREFS, useTheme } from '../state/theme'
import * as Ic from '../ui/icons'
import '../styles/settings.css'

const SNAP_LABELS: Record<SnapKind, string> = {
  points: 'Points',
  midpoints: 'Midpoints',
  edges: 'Edges',
  bounds: 'Bounding box',
  centers: 'Centers',
  origin: 'Origin',
}

type Flag = 'smartAlignment' | 'showPosition' | 'showGrid' | 'snapToGrid' | 'positionLabels' | 'originAnchor' | 'cutPathDisplay'

const POSITION_OPTS: { k: Flag; label: string }[] = [
  { k: 'showGrid', label: 'Show grid' },
  { k: 'snapToGrid', label: 'Snap to grid' },
  { k: 'positionLabels', label: 'Show position labels' },
]

function Switch({ on, label, sm, onChange }: { on: boolean; label: string; sm?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={'ss-switch' + (sm ? ' ss-switch--sm' : '') + (on ? ' is-on' : '')}
      onClick={() => onChange(!on)}
    />
  )
}

/** One setting: icon, label and hint on the left, its control on the right. */
function Row({ icon, label, hint, children, sub }: { icon?: ReactNode; label: string; hint?: string; children: ReactNode; sub?: boolean }) {
  return (
    <div className={'prefs-row' + (sub ? ' prefs-row--sub' : '')}>
      {icon && <span className="prefs-row__icon">{icon}</span>}
      <span className="prefs-row__text">
        <span className="prefs-row__label">{label}</span>
        {hint && <span className="prefs-row__hint">{hint}</span>}
      </span>
      <span className="prefs-row__control">{children}</span>
    </div>
  )
}

function Card({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <section className="prefs-card" aria-label={title}>
      <header className="prefs-card__head">
        <h2>{title}</h2>
        <p>{sub}</p>
      </header>
      <div className="prefs-card__body">{children}</div>
    </section>
  )
}

/** Diameters of the bits in the user's kit, smallest first, one per size. */
function useKitSizes(): { mm: number; name: string }[] {
  const owned = useBitLibrary((s) => s.owned)
  const custom = useBitLibrary((s) => s.custom)
  const seen = new Set<string>()
  return allBits({ custom })
    .filter((b) => owned[b.id])
    .sort((a, b) => a.diameter - b.diameter)
    .filter((b) => {
      const key = b.diameter.toFixed(3)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((b) => ({ mm: b.diameter, name: b.name }))
}

const same = (a: number, b: number) => Math.abs(a - b) < 1e-3

export default function SettingsPage() {
  const p = usePrefs()
  const set = usePrefs((s) => s.set)
  // Lengths show in the preset units; until those are picked, in the units last used.
  const units: Units = p.units ?? lastUnits()
  const kit = useKitSizes()
  const theme = useTheme()
  const flag = (k: Flag) => (on: boolean) => set({ [k]: on } as Partial<Prefs>)
  const gridDefault = units === 'in' ? MM_PER_IN : 10
  const isDefault =
    p.units === undefined &&
    p.gridSize === undefined &&
    (Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]).every((k) => JSON.stringify(p[k]) === JSON.stringify(DEFAULT_PREFS[k]))

  return (
    <section className="home-settings">
      <header className="home__head">
        <div>
          <h1>Settings</h1>
          <p className="ss-muted">Presets every new design starts with. Saved on this device.</p>
        </div>
        <button type="button" className="ss-btn" disabled={isDefault} onClick={() => usePrefs.getState().reset()}>
          Reset to defaults
        </button>
      </header>

      <div className="prefs-cards">
        <Card title="Appearance" sub="Light or dark, for the studio and this window. Saved on this device.">
          <Row icon={<Ic.IconMoon size={20} />} label="Theme" hint={theme.pref === 'system' ? 'Following your system setting.' : undefined}>
            <div className="ss-seg" role="group" aria-label="Theme">
              {THEME_PREFS.map((t) => (
                <button key={t} type="button" aria-pressed={theme.pref === t} onClick={() => theme.set(t)}>
                  {THEME_LABELS[t]}
                </button>
              ))}
            </div>
          </Row>
        </Card>

        <Card title="Controls" sub="How the mouse and trackpad drive the studio canvas. Ctrl or ⌘ + scroll always zooms.">
          <Row
            icon={<Ic.IconMouse size={20} />}
            label="Scroll wheel"
            hint={
              p.mouseNav === 'pan'
                ? 'Scrolling pans; drag the middle mouse button to zoom.'
                : 'Scrolling zooms; drag the middle mouse button to pan, as in Studio.'
            }
          >
            <div className="ss-seg" role="group" aria-label="Scroll wheel">
              <button type="button" aria-pressed={p.mouseNav === 'zoom'} onClick={() => set({ mouseNav: 'zoom' })}>
                Zoom
              </button>
              <button type="button" aria-pressed={p.mouseNav === 'pan'} onClick={() => set({ mouseNav: 'pan' })}>
                Pan
              </button>
            </div>
          </Row>
        </Card>

        <Card title="Units" sub="New designs, the bit gallery and the fields below use these.">
          <Row icon={<Ic.IconUnits size={20} />} label="Measure in" hint={p.units ? undefined : 'Following the units you last used in the studio.'}>
            <div className="ss-seg ss-seg--units" role="group" aria-label="Units">
              {(['in', 'mm'] as Units[]).map((u) => (
                <button key={u} type="button" aria-pressed={units === u} onClick={() => set({ units: u })}>
                  {u}
                </button>
              ))}
            </div>
          </Row>
        </Card>

        <Card title="Canvas" sub="How the canvas behaves when a new design opens. Each design can still change these.">
          <Row icon={<Ic.IconMagnet size={20} />} label="Smart Alignment" hint="Snap shapes to each other while you move them.">
            <Switch on={p.smartAlignment} label="Smart Alignment" onChange={flag('smartAlignment')} />
          </Row>
          {p.smartAlignment && (
            <div className="prefs-sub" role="group" aria-label="Snap to">
              {SNAP_KINDS.map((k) => (
                <Row key={k} label={SNAP_LABELS[k]} sub>
                  <Switch sm on={p.snap[k]} label={'Snap to ' + SNAP_LABELS[k].toLowerCase()} onChange={(on) => set({ snap: { ...p.snap, [k]: on } })} />
                </Row>
              ))}
            </div>
          )}
          <Row icon={<Ic.IconPosition size={20} />} label="Position" hint="Show where shapes sit on the canvas.">
            <Switch on={p.showPosition} label="Position" onChange={flag('showPosition')} />
          </Row>
          {p.showPosition && (
            <div className="prefs-sub" role="group" aria-label="Position options">
              {POSITION_OPTS.map((o) => (
                <Row key={o.k} label={o.label} sub>
                  <Switch sm on={p[o.k] as boolean} label={o.label} onChange={flag(o.k)} />
                </Row>
              ))}
            </div>
          )}
          <Row icon={<Ic.IconLayers size={20} />} label="Grid size" hint={`Spacing of grid lines. Default ${fmtLen(gridDefault, units)}.`}>
            <NumField
              className="prefs-num"
              label="Grid size"
              units={units}
              value={p.gridSize ?? gridDefault}
              onCommit={(v) => set({ gridSize: v > 0 ? v : undefined })}
            />
          </Row>
          <Row icon={<Ic.IconAnchor size={20} />} label="Origin Anchor" hint="Custom anchors help you position your design on Origin.">
            <Switch on={p.originAnchor} label="Origin Anchor" onChange={flag('originAnchor')} />
          </Row>
        </Card>

        <Card title="Cutting" sub="Cut settings new shapes start with in Plan mode.">
          <div className="prefs-block">
            <span className="prefs-row__label">Cut type</span>
            <span className="prefs-row__hint">Open paths from the pen or freehand tool start as On Line.</span>
            <div className="prefs-tiles" role="radiogroup" aria-label="Cut type">
              {CUT_TYPES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={p.cutType === c.id}
                  className={'prefs-tile' + (p.cutType === c.id ? ' is-active' : '')}
                  onClick={() => set({ cutType: c.id })}
                >
                  {c.icon}
                  <span>{c.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="prefs-block">
            <span className="prefs-row__label">Bit diameter</span>
            <div className="prefs-bits">
              <div className="prefs-chips" role="group" aria-label="Common bit sizes">
                {BIT_PRESETS[units].map((b) => (
                  <button
                    key={b.label}
                    type="button"
                    aria-pressed={same(p.bitDia, b.mm)}
                    className={'prefs-chip' + (same(p.bitDia, b.mm) ? ' is-active' : '')}
                    title={fmtLen(b.mm, units)}
                    onClick={() => set({ bitDia: b.mm })}
                  >
                    {/* Text, not Studio's glyphs: those already spell the fraction. */}
                    <Ic.IconBitLibrary size={16} />
                    <span>
                      {b.label} {units}
                    </span>
                  </button>
                ))}
              </div>
              <NumField className="prefs-num" label="Bit diameter" units={units} value={p.bitDia} onCommit={(v) => v > 0 && set({ bitDia: v })} />
            </div>
            {kit.length > 0 && (
              <>
                <span className="prefs-row__hint">From your kit</span>
                <div className="prefs-chips" role="group" aria-label="Bits in your kit">
                  {kit.map((b) => (
                    <button
                      key={b.mm}
                      type="button"
                      aria-pressed={same(p.bitDia, b.mm)}
                      className={'prefs-chip' + (same(p.bitDia, b.mm) ? ' is-active' : '')}
                      title={b.name}
                      onClick={() => set({ bitDia: b.mm })}
                    >
                      <Ic.IconBitLibrary size={16} />
                      <span>{fmtLen(b.mm, units)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <Row label="Cut depth" hint="Leave empty to set the depth per shape, as Studio does.">
            <span className="prefs-depth">
              <NumField className="prefs-num" label="Cut depth" units={units} value={p.depth} placeholder="none" onCommit={(v) => set({ depth: v > 0 ? v : null })} />
              {p.depth != null && (
                <button type="button" className="prefs-clear" aria-label="Clear cut depth" onClick={() => set({ depth: null })}>
                  <Ic.IconClose size={14} />
                </button>
              )}
            </span>
          </Row>
          <Row icon={<Ic.IconPlanMode size={20} />} label="Cut Path Display" hint="In Plan mode, show the cut path of every shape, not only the selection.">
            <Switch on={p.cutPathDisplay} label="Cut Path Display" onChange={flag('cutPathDisplay')} />
          </Row>
        </Card>
      </div>
    </section>
  )
}
