// Full-screen "3D Carve" dialog: load a model, preview the process plan, add toolpaths to the
// design. The plan is always multi-sided: the block is carved from the faces that need it, each
// in process stages (rough → detail → engrave), with the outline cut through the stock and
// bridges holding the part in the block between flips.
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { Group, ImportPayload, Units } from '../../model/types'
import { fmtLen, fromUnits, toUnits } from '../../model/factory'
import { IconCube, IconClose, IconLink, IconUnlink, IconPause, IconPlay, IconRestart } from '../../ui/icons'
import { NumField } from '../../editor/Panels'
import { CarveCancelled, type TabSettings } from './carvePlan'
import { MODEL_ACCEPT, defaultsFor, orientedSize, placeModel, readModelFile, type ModelUnit, type UpAxis, type Vec3 } from './loadModel'
import { carvedSurface, type CarvedSurface } from './finishedSurface'
import { Field } from './fields'
import MultiSidePanel from './MultiSidePanel'
import { autoStageBits, defaultSides, STAGE_LABEL, type StageBits } from './multiSide'
import { createMultiSideClient, type AnalysisMap, type MultiSideClient } from './multiSideClient'
import type { PartMesh } from './finishedPart'
import type { LayeredPlan } from './layers'
import { HOLDER_ALLOWANCE } from './bits'
import { sideFrame, type SideId } from './sideAnalysis'
import { disposeThumbnails, renderThumbnail } from './thumbnails'
import Viewer3D, { type AnimState, type CarveView, type LayerOutline } from './Viewer3D'
import LoadingDomino from '../../ui/LoadingDomino'
import './carve3d.css'

export interface Carve3DDialogProps {
  units: Units
  onClose: () => void
  onImport: (p: ImportPayload) => void
}

export default function Carve3DDialog({ units, onClose, onImport }: Carve3DDialogProps) {
  // ---- model -------------------------------------------------------------
  const [file, setFile] = useState<File | null>(null)
  const [modelRev, setModelRev] = useState(0)
  const [raw, setRaw] = useState<Float32Array | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [modelUnit, setModelUnit] = useState<ModelUnit>('mm')
  const [up, setUp] = useState<UpAxis>('z')
  /** Target model size in mm (W = x, L = y, H = z). null = the file's natural size. */
  const [sizeMm, setSizeMm] = useState<Vec3 | null>(null)
  const [lockRatio, setLockRatio] = useState(true)
  const fileInputRef = useRef<HTMLInputElement>(null)
  /** Only the newest load may update state (a slow earlier load must not overwrite a newer one). */
  const loadSeq = useRef(0)

  // ---- carve settings (stored in mm) --------------------------------------
  const [stepOverride, setStepOverride] = useState<number | null>(null)
  const [stockOverride, setStockOverride] = useState<number | null>(null)
  const [marginMm, setMarginMm] = useState(12)
  const [outputs, setOutputs] = useState({ contour: false, toolpath: true, pocket: false })

  // ---- results -----------------------------------------------------------
  const [computing, setComputing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [planError, setPlanError] = useState<string | null>(null)
  const [surface, setSurface] = useState<CarvedSurface | null>(null)
  const [show, setShow] = useState<CarveView>({ finished: true, carved: false, model: false, layers: false, dims: true })
  const [anim, setAnim] = useState<AnimState>({ on: false, playing: false, speed: 10, run: 0 })
  const [animProgress, setAnimProgress] = useState(0)

  // ---- multi-side process plan --------------------------------------------
  const [msSides, setMsSides] = useState<SideId[]>([])
  const [msBits, setMsBits] = useState<StageBits>(() => autoStageBits())
  const [msAllowance, setMsAllowance] = useState(1)
  const [msEngraveDepth, setMsEngraveDepth] = useState(1.5)
  const [msBridges, setMsBridges] = useState<TabSettings>({ count: 2, width: 5, height: 1 })
  /** Boards the block is split into (each a multi-sided job of its own). */
  const [msLayers, setMsLayers] = useState(1)
  /** Bit length lost to the collet and spindle (sets how deep a bit reaches). */
  const [holderMm, setHolderMm] = useState(HOLDER_ALLOWANCE)
  const [msPlan, setMsPlan] = useState<LayeredPlan | null>(null)
  /** Each layer's finished part (its own frame), for the plan key they were built for. */
  const [parts, setParts] = useState<{ key: string; byLayer: Record<number, PartMesh | null> } | null>(null)
  /** Which layer (or the glued-up block, 'all'), side and stage the 3D preview shows. */
  const [msSel, setMsSel] = useState<{ layer: number | 'all'; side: SideId | null; stage: number }>({ layer: 0, side: null, stage: 0 })

  const toU = (mm: number) => toUnits(mm, units)
  const fromU = (v: number) => fromUnits(v, units)
  const L = (mm: number) => fmtLen(mm, units)
  const dec = units === 'in' ? 3 : 2

  const natural = useMemo(() => (raw ? orientedSize(raw, modelUnit, up) : null), [raw, modelUnit, up])
  const placed = useMemo(() => (raw ? placeModel(raw, modelUnit, up, sizeMm) : null), [raw, modelUnit, up, sizeMm])

  /** Set one extent. With the aspect lock on, the other two scale by the same factor. */
  function setDim(axis: keyof Vec3, v: number) {
    const cur = sizeMm ?? natural
    if (!cur || !(v > 0)) return
    const target = Math.max(v, 0.01)
    if (lockRatio && cur[axis] > 0) {
      const k = target / cur[axis]
      setSizeMm({ x: cur.x * k, y: cur.y * k, z: cur.z * k })
    } else {
      setSizeMm({ ...cur, [axis]: target })
    }
  }
  const H = placed?.size.z ?? 0
  const stepMm = stepOverride ?? 2
  const stockMm = stockOverride ?? H
  /** Viewer stock margin; each stage plan raises the margin to its own bit's reach itself. */
  const effMargin = Math.max(marginMm, 9)
  const stockSize = useMemo(
    () => (placed ? { x: placed.size.x + 2 * effMargin, y: placed.size.y + 2 * effMargin, z: Math.max(stockMm, 0.01) } : null),
    [placed, effMargin, stockMm],
  )

  // ---- multi-side analysis & planning -------------------------------------
  // The planner (grid analysis, mesh slicing, clipper booleans) runs in a worker so the page
  // never blocks; see multiSideClient. One run at a time — a new run cancels the old one.

  /** Which faces of the block have claimed work, from the last analysis. */
  const [analysis, setAnalysis] = useState<AnalysisMap | null>(null)

  const msKey = [
    file?.name ?? '',
    modelRev,
    modelUnit,
    up,
    sizeMm ? `${sizeMm.x.toFixed(6)}:${sizeMm.y.toFixed(6)}:${sizeMm.z.toFixed(6)}` : 'natural',
    msSides.join(','),
    msBits.rough ?? '',
    msBits.detail ?? '',
    msBits.engrave ?? '',
    msAllowance.toFixed(6),
    msEngraveDepth.toFixed(6),
    stepMm.toFixed(6),
    marginMm.toFixed(6),
    stockMm.toFixed(6),
    msBridges.count,
    msBridges.width.toFixed(6),
    msBridges.height.toFixed(6),
    msLayers,
    holderMm.toFixed(6),
    outputs.contour ? 1 : 0,
    outputs.toolpath ? 1 : 0,
    outputs.pocket ? 1 : 0,
    units,
  ].join('|')
  const msCurrent = !!msPlan && msPlan.key === msKey

  // Build the multi-sided plan (all enabled sides × all stages) whenever its inputs change,
  // off the main thread. Chip auto-selection runs once per placed model so user toggles stick.
  const clientRef = useRef<MultiSideClient | null>(null)
  const placedRef = useRef(placed)
  useEffect(() => {
    placedRef.current = placed
  })
  const chipDefaultsFor = useRef<Float32Array | null>(null)
  const getClient = () => {
    if (!clientRef.current) {
      clientRef.current = createMultiSideClient({
        onAnalysis: (a) => {
          setAnalysis(a)
          const pos = placedRef.current?.positions ?? null
          if (pos && chipDefaultsFor.current !== pos) {
            chipDefaultsFor.current = pos
            setMsSides(defaultSides(a))
          }
        },
        onPlan: (p) => {
          setMsPlan(p)
          setParts({ key: p.key, byLayer: {} })
          setComputing(false)
        },
        onPart: (layer, mesh, key) => {
          setParts((cur) => (cur && cur.key === key ? { key, byLayer: { ...cur.byLayer, [layer]: mesh } } : cur))
        },
        onProgress: (f) => setProgress(f),
        onError: (message) => {
          setMsPlan(null)
          setPlanError(message)
          setComputing(false)
        },
      })
    }
    return clientRef.current
  }
  useEffect(
    () => () => {
      clientRef.current?.dispose()
      clientRef.current = null
      disposeThumbnails()
    },
    [],
  )

  useEffect(() => {
    if (!placed) {
      clientRef.current?.cancel()
      return
    }
    if (!msSides.length) {
      // Every face switched off: still analyse, so the chips light up for a new model.
      setMsPlan(null)
      setComputing(false)
      getClient().run(placed, null)
      return
    }
    setComputing(true)
    setProgress(0)
    setPlanError(null)
    // Debounce so a burst of settings edits plans once.
    const timer = window.setTimeout(() => {
      getClient().run(placed, {
        sides: msSides,
        bits: msBits,
        finishAllowance: msAllowance,
        engraveDepth: msEngraveDepth,
        stepDown: stepMm,
        margin: marginMm,
        stockThickness: stockMm,
        holderAllowance: holderMm,
        bridges: msBridges,
        layers: msLayers,
        outputs,
        units,
        key: msKey,
      })
    }, 250)
    return () => window.clearTimeout(timer)
    // The key captures every input; the closure reads the current values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, msKey])

  // Keep the preview selection inside the plan.
  useEffect(() => {
    if (!msPlan) return
    if (msSel.layer === 'all' && msPlan.layers.length > 1) return
    const layer = msPlan.layers.find((l) => l.index === msSel.layer) ?? msPlan.layers[0]
    if (!layer) return
    const cur = layer.plan.sides.find((s) => s.side === msSel.side)
    if (layer.index !== msSel.layer || !cur || msSel.stage >= cur.plans.length)
      setMsSel({ layer: layer.index, side: cur?.side ?? layer.plan.sides[0]?.side ?? null, stage: cur && msSel.stage < cur.plans.length ? msSel.stage : 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msPlan])

  /** What the viewer shows: the glued-up block, or the selected layer's side and stage. */
  const assembled = msSel.layer === 'all' && !!msPlan && msPlan.layers.length > 1
  const selLayer = msPlan && !assembled ? msPlan.layers.find((l) => l.index === msSel.layer) ?? msPlan.layers[0] ?? null : null
  const selSide = selLayer ? selLayer.plan.sides.find((s) => s.side === msSel.side) ?? selLayer.plan.sides[0] ?? null : null
  const selStage = selSide ? Math.min(Math.max(0, msSel.stage), selSide.plans.length - 1) : 0
  const activePlan = selSide?.plans[selStage] ?? null
  const activePlaced = selSide ? selSide.placed : placed
  const partsCurrent = !!parts && !!msPlan && parts.key === msPlan.key
  const partBusy = !!msPlan && msPlan.layers.some((l) => !partsCurrent || !(l.index in parts!.byLayer))
  const activeStockSize = useMemo(() => {
    if (!activePlaced) return null
    if (selSide) {
      return {
        x: selSide.placed.size.x + 2 * effMargin,
        y: selSide.placed.size.y + 2 * effMargin,
        z: Math.max(selSide.blockDepth, 0.01),
      }
    }
    return stockSize
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlaced, selSide, effMargin, stockSize])
  /** The selected setup's stock face sits `faceOffset` above the model face. */
  const activeStockTop = selSide ? selSide.placed.size.z + selSide.faceOffset : undefined

  // Each layer's finished part is built in its piece's own frame. The glued-up block stacks
  // every layer's part back at its height in the model frame.
  const assembledPart = useMemo(() => {
    if (!partsCurrent || !msPlan || msPlan.layers.length < 2) return null
    const meshes = msPlan.layers.map((l) => ({ l, m: parts!.byLayer[l.index] })).filter((x) => x.m)
    if (!meshes.length) return null
    const positions = new Float32Array(meshes.reduce((a, x) => a + x.m!.positions.length, 0))
    const indices = new Uint32Array(meshes.reduce((a, x) => a + x.m!.indices.length, 0))
    let pv = 0
    let pi = 0
    for (const { l, m } of meshes) {
      const src = m!.positions
      for (let i = 0; i < src.length; i += 3) positions.set([src[i], src[i + 1], src[i + 2] + l.offsetZ], pv + i)
      for (let i = 0; i < m!.indices.length; i++) indices[pi + i] = m!.indices[i] + pv / 3
      pv += src.length
      pi += m!.indices.length
    }
    return { positions, indices }
  }, [parts, partsCurrent, msPlan])

  // One layer: turn its part to the side being viewed, so it lines up with that setup's stock,
  // paths and animation.
  const viewPart = useMemo(() => {
    if (assembled) return assembledPart
    const mesh = partsCurrent && selLayer ? parts!.byLayer[selLayer.index] : null
    if (!mesh || !selLayer || !selSide) return null
    const { toSide } = sideFrame(selSide.side, selLayer.placed)
    const src = mesh.positions
    const out = new Float32Array(src.length)
    for (let i = 0; i < src.length; i += 3) out.set(toSide(src[i], src[i + 1], src[i + 2]), i)
    return { positions: out, indices: mesh.indices }
  }, [assembled, assembledPart, parts, partsCurrent, selLayer, selSide])

  // Tile pictures: each layer (its finished part once built, else its piece of the model), and
  // the selected layer's sides, each turned that side up.
  const layerThumbs = useMemo(() => {
    const out: Record<string, string> = {}
    if (!msPlan) return out
    for (const l of msPlan.layers) {
      const m = partsCurrent ? parts!.byLayer[l.index] : null
      out[l.index] = m ? renderThumbnail(m.positions, m.indices, true) : renderThumbnail(l.placed.positions, null, false)
    }
    if (msPlan.layers.length > 1) {
      const allDone = partsCurrent && msPlan.layers.every((l) => parts!.byLayer[l.index])
      out.all = allDone && assembledPart ? renderThumbnail(assembledPart.positions, assembledPart.indices, true) : placed ? renderThumbnail(placed.positions, null, false) : ''
    }
    return out
  }, [msPlan, parts, partsCurrent, assembledPart, placed])
  const sideThumbs = useMemo(() => {
    const out: Record<string, string> = {}
    if (!selLayer) return out
    const m = partsCurrent ? parts!.byLayer[selLayer.index] : null
    for (const s of selLayer.plan.sides) {
      if (m) {
        const { toSide } = sideFrame(s.side, selLayer.placed)
        const pos = new Float32Array(m.positions.length)
        for (let i = 0; i < pos.length; i += 3) pos.set(toSide(m.positions[i], m.positions[i + 1], m.positions[i + 2]), i)
        out[s.side] = renderThumbnail(pos, m.indices, true)
      } else out[s.side] = renderThumbnail(s.placed.positions, null, false)
    }
    return out
  }, [selLayer, parts, partsCurrent])

  // The finished surface follows the plan the viewer shows. It is the slow part of the preview
  // after the plan itself, so it runs async and a newer plan aborts it; the old surface stays up.
  const [carving, setCarving] = useState(false)
  useEffect(() => {
    if (!activePlan) {
      setSurface(null)
      return
    }
    const ctrl = new AbortController()
    setCarving(true)
    carvedSurface(activePlan, activePlan.bit, ctrl.signal)
      .then((s) => {
        if (ctrl.signal.aborted) return
        setSurface(s)
        setCarving(false)
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || e instanceof CarveCancelled) return
        setSurface(null)
        setCarving(false)
      })
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlan])

  // Escape closes the dialog, but not while a text field has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const outlines: LayerOutline[] = useMemo(
    () => (activePlan ? activePlan.layers.map((l) => ({ z: activePlan.modelH - l.depth, guide: l.guide, toolpath: l.toolpath })) : []),
    [activePlan],
  )

  async function loadFile(f: File) {
    const seq = ++loadSeq.current
    setError(null)
    setLoading(true)
    try {
      const positions = await readModelFile(f)
      if (seq !== loadSeq.current) return
      const d = defaultsFor(f.name)
      setRaw(positions)
      setFile(f)
      setModelUnit(d.unit)
      setUp(d.up)
      setStockOverride(null)
      setSizeMm(null)
      setModelRev((r) => r + 1)
    } catch (e) {
      if (seq === loadSeq.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }

  function resetModel() {
    loadSeq.current++
    setRaw(null)
    setFile(null)
    setMsPlan(null)
    setParts(null)
    setAnalysis(null)
    setPlanError(null)
    setError(null)
    setLoading(false)
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) void loadFile(f)
  }

  function add() {
    if (!msPlan || !file || !msCurrent || msPlan.shapes.length === 0) return
    const baseName = file.name.replace(/\.[^.]+$/, '')
    const nl = msPlan.layers.length
    const ns = msPlan.layers.reduce((a, l) => a + l.plan.sides.length, 0)
    const group: Omit<Group, 'id'> = {
      name: `3D Carve – ${baseName} – ${nl > 1 ? `${nl} layers, ` : ''}${ns} side${ns === 1 ? '' : 's'}`,
      source: '3d',
      info: msPlan.info,
    }
    onImport({ group, shapes: msPlan.shapes })
    onClose()
  }

  const baseName = file ? file.name.replace(/\.[^.]+$/, '') : ''

  return (
    <div className="ss-dialog c3d-dialog" role="dialog" aria-label="3D Carve">
      {(loading || computing || carving || partBusy) && <LoadingDomino withOverlay passThrough />}
      <div className="ss-dialog__header">
        <IconCube />
        3D Carve
      </div>

      <div className="ss-dialog__body">
        <div className="ss-dialog__main">
          {activePlaced && activeStockSize ? (
            <>
              <Viewer3D
                positions={activePlaced.positions}
                modelSize={activePlaced.size}
                stockSize={activeStockSize}
                stockTop={activeStockTop}
                outlines={outlines}
                surface={surface}
                part={viewPart}
                show={show}
                plan={activePlan}
                anim={anim}
                onAnimProgress={setAnimProgress}
                onAnimComplete={() => setAnim((a) => ({ ...a, playing: false }))}
                dimLabels={{ x: `W ${L(activePlaced.size.x)}`, y: `L ${L(activePlaced.size.y)}`, z: `H ${L(activePlaced.size.z)}` }}
              />
              <div className="c3d-overlay">
                <span className="ss-badge">{baseName}</span>
                <span className="ss-muted">
                  {L(activePlaced.size.x)} × {L(activePlaced.size.y)} × {L(activePlaced.size.z)}
                </span>
                {assembled && <span className="ss-badge">All layers · glued up</span>}
                {selSide && (
                  <span className="ss-badge">
                    {msPlan && msPlan.layers.length > 1 && selLayer ? `Layer ${selLayer.index + 1} · ` : ''}
                    {selSide.label} · {STAGE_LABEL[selSide.stages[selStage]?.role ?? 'detail']}
                    {selSide.freeing ? ' · bridges' : ''}
                  </span>
                )}
                <div className="ss-seg c3d-viewtoggle" role="group" aria-label="3D view">
                  {(
                    [
                      ['finished', 'Finished'],
                      ['carved', 'Stage'],
                      ['model', 'Model'],
                      ['layers', 'Paths'],
                      ['dims', 'Dims'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={show[key]}
                      title={key === 'finished' ? 'The finished part: every side carved' : key === 'carved' ? 'The selected stage alone, on uncut stock' : undefined}
                      onClick={() =>
                        // Finished and Stage are two views of the solid: one at a time.
                        setShow((s) => ({
                          ...s,
                          [key]: !s[key],
                          ...(key === 'finished' && !s.finished ? { carved: false } : {}),
                          ...(key === 'carved' && !s.carved ? { finished: false } : {}),
                        }))
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {(computing || carving) && show.carved && surface && <span className="ss-muted c3d-updating">updating…</span>}
                {(computing || partBusy) && show.finished && <span className="ss-muted c3d-updating">{viewPart ? 'updating…' : 'building finished part…'}</span>}
              </div>
              {msPlan && msPlan.layers.length > 0 && (
                // Layers stacked downwards; the selected layer's sides fold out to its right.
                <div className="c3d-stack" role="group" aria-label="layers and sides">
                  {msPlan.layers.length > 1 && (
                    <div className="c3d-stack__row">
                      <button
                        type="button"
                        className={'c3d-tile' + (assembled ? ' is-on' : '')}
                        aria-pressed={assembled}
                        title="Every layer, glued up"
                        onClick={() => setMsSel((cur) => ({ ...cur, layer: 'all' }))}
                      >
                        {layerThumbs.all && <img src={layerThumbs.all} alt="" />}
                        <span>All</span>
                      </button>
                    </div>
                  )}
                  {msPlan.layers.map((l) => {
                    const on = !assembled && selLayer?.index === l.index
                    return (
                      <div className="c3d-stack__row" key={l.index}>
                        <button
                          type="button"
                          className={'c3d-tile' + (on ? ' is-on' : '')}
                          aria-pressed={on}
                          title={`Layer ${l.index + 1}: ${L(l.z1 - l.z0)} board`}
                          onClick={() => setMsSel((cur) => ({ layer: l.index, side: cur.side, stage: cur.stage }))}
                        >
                          {layerThumbs[l.index] && <img src={layerThumbs[l.index]} alt="" />}
                          <span>{msPlan.layers.length > 1 ? `Layer ${l.index + 1}` : 'Block'}</span>
                        </button>
                        {on && (
                          // Remounts per layer, so the sides fold out again on every switch.
                          <div className="c3d-stack__sides" key={`${msPlan.key}-${l.index}`}>
                            {l.plan.sides.map((sd, i) => (
                              <button
                                key={sd.side}
                                type="button"
                                className={'c3d-tile c3d-tile--side' + (selSide?.side === sd.side ? ' is-on' : '')}
                                aria-pressed={selSide?.side === sd.side}
                                style={{ animationDelay: `${i * 70}ms` }}
                                title={`${sd.label}: ${sd.stages.map((x) => STAGE_LABEL[x.role]).join(' → ')}`}
                                onClick={() => setMsSel({ layer: l.index, side: sd.side, stage: selSide?.side === sd.side ? selStage : 0 })}
                              >
                                {sideThumbs[sd.side] && <img src={sideThumbs[sd.side]} alt="" />}
                                <span>{sd.label}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="c3d-animbar">
                {anim.on ? (
                  <>
                    <button
                      type="button"
                      className="ss-btn-round c3d-animbar__btn"
                      aria-label={anim.playing ? 'Pause' : 'Play'}
                      onClick={() => {
                        // Play after the end starts a fresh run.
                        if (!anim.playing && animProgress >= 1) setAnimProgress(0)
                        setAnim((a) => ({ ...a, playing: !a.playing, run: !a.playing && animProgress >= 1 ? a.run + 1 : a.run }))
                      }}
                    >
                      {anim.playing ? <IconPause size={16} /> : <IconPlay size={16} />}
                    </button>
                    <button
                      type="button"
                      className="ss-btn-round c3d-animbar__btn"
                      aria-label="Restart"
                      onClick={() => {
                        setAnimProgress(0)
                        setAnim((a) => ({ ...a, playing: true, run: a.run + 1 }))
                      }}
                    >
                      <IconRestart size={16} />
                    </button>
                    <div className="c3d-animbar__track" aria-label="cut progress">
                      <span style={{ width: `${Math.round(animProgress * 100)}%` }} />
                    </div>
                    <div className="ss-seg" role="group" aria-label="animation speed">
                      {[1, 10, 50, 200].map((x) => (
                        <button key={x} type="button" aria-pressed={anim.speed === x} onClick={() => setAnim((a) => ({ ...a, speed: x }))}>
                          {x}×
                        </button>
                      ))}
                    </div>
                    <button type="button" className="ss-btn ss-btn--sm" onClick={() => setAnim((a) => ({ ...a, on: false, playing: false }))}>
                      Done
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="ss-btn ss-btn--sm"
                    disabled={!activePlan || activePlan.layers.length === 0}
                    onClick={() => {
                      setAnimProgress(0)
                      setAnim((a) => ({ ...a, on: true, playing: true, run: a.run + 1 }))
                    }}
                  >
                    <IconPlay size={14} /> Animate cut
                  </button>
                )}
              </div>
            </>
          ) : (
            <div
              className={`ss-dropzone c3d-drop${dragOver ? ' is-over' : ''}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept={MODEL_ACCEPT}
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void loadFile(f)
                  e.target.value = ''
                }}
              />
              <strong>{loading ? 'Loading model…' : 'Drop a 3D model here'}</strong>
              <span className="ss-muted">STL (binary or ASCII), OBJ, GLB or GLTF. Click to choose a file.</span>
              {error && <span className="c3d-error">{error}</span>}
            </div>
          )}
        </div>

        <aside className="ss-dialog__side c3d-side">
          {placed && (
            <div className="c3d-section">
              <div className="ss-section-title">model</div>
              <Field label="model units">
                <select className="ss-select" value={modelUnit} onChange={(e) => {
                    setModelUnit(e.target.value as ModelUnit)
                    setSizeMm(null)
                  }}>
                  <option value="mm">millimetres (mm)</option>
                  <option value="cm">centimetres (cm)</option>
                  <option value="in">inches (in)</option>
                  <option value="m">metres (m)</option>
                </select>
              </Field>
              <Field label="up axis">
                <select className="ss-select" value={up} onChange={(e) => {
                    setUp(e.target.value as UpAxis)
                    setSizeMm(null)
                  }}>
                  <option value="z">Z up</option>
                  <option value="y">Y up</option>
                  <option value="-y">-Y up</option>
                  <option value="x">X up</option>
                </select>
              </Field>
              <Field label="size">
                <div className="size-fields">
                  <div className="size-fields__inputs">
                    <NumField label="Width" adorn="W" value={placed.size.x} units={units} onCommit={(v) => setDim('x', v)} />
                    <NumField label="Length" adorn="L" value={placed.size.y} units={units} onCommit={(v) => setDim('y', v)} />
                    <NumField label="Height" adorn="H" value={placed.size.z} units={units} onCommit={(v) => setDim('z', v)} />
                  </div>
                  <button
                    type="button"
                    className={'lock-ratio' + (lockRatio ? ' is-active' : '')}
                    aria-pressed={lockRatio}
                    aria-label="Lock aspect ratio"
                    title="Lock aspect ratio"
                    onClick={() => setLockRatio(!lockRatio)}
                  >
                    {lockRatio ? <IconLink size={18} /> : <IconUnlink size={18} />}
                  </button>
                </div>
              </Field>
              <div className="c3d-row c3d-row--between">
                {sizeMm ? (
                  <button type="button" className="ss-btn ss-btn--sm" onClick={() => setSizeMm(null)}>
                    Original Size
                  </button>
                ) : (
                  <span className="ss-muted">original size</span>
                )}
                <button type="button" className="ss-btn ss-btn--sm" onClick={resetModel}>
                  Other File
                </button>
              </div>
              {error && <span className="c3d-error">{error}</span>}
            </div>
          )}

          {placed && (
            <MultiSidePanel
              units={units}
              analysis={selLayer?.plan.analysis ?? analysis}
              enabled={msSides}
              onToggleSide={(s) => setMsSides((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))}
              bits={msBits}
              onBits={setMsBits}
              allowance={msAllowance}
              engraveDepth={msEngraveDepth}
              stepDown={stepMm}
              onStepDown={(v) => v > 0 && setStepOverride(fromU(v))}
              stockMm={stockMm}
              onStock={(v) => setStockOverride(fromU(v))}
              marginMm={marginMm}
              onMargin={setMarginMm}
              onAllowance={setMsAllowance}
              onEngraveDepth={setMsEngraveDepth}
              bridges={msBridges}
              onBridges={setMsBridges}
              layerPlan={selLayer?.plan ?? null}
              layerLabel={msPlan && msPlan.layers.length > 1 && selLayer ? `Layer ${selLayer.index + 1} of ${msPlan.layers.length}` : null}
              warnings={msPlan?.warnings ?? []}
              shapesCount={msPlan?.shapes.length ?? 0}
              layers={msLayers}
              onLayers={(n) => setMsLayers(Math.max(1, Math.min(20, Math.round(n) || 1)))}
              splitTo={msPlan?.splitTo ?? null}
              layerLimitMm={msPlan?.layerLimit ?? null}
              boardMm={Math.max(stockMm, H) / msLayers}
              holderMm={holderMm}
              onHolder={(v) => v >= 0 && setHolderMm(fromU(v))}
              planCurrent={msCurrent}
              computing={computing}
              progress={progress}
              selected={{ side: selSide?.side ?? null, stage: selStage }}
              onSelect={(side, stage) => setMsSel((cur) => ({ ...cur, side, stage }))}
              L={L}
              toU={toU}
              fromU={fromU}
              dec={dec}
            />
          )}

          <div className="c3d-section">
            <div className="ss-section-title">outputs</div>
            <label className="ss-check">
              <input type="checkbox" checked={outputs.contour} onChange={(e) => setOutputs({ ...outputs, contour: e.target.checked })} />
              model contours (guide)
            </label>
            <label className="ss-check">
              <input type="checkbox" checked={outputs.toolpath} onChange={(e) => setOutputs({ ...outputs, toolpath: e.target.checked })} />
              outline toolpaths (on line)
            </label>
            <label className="ss-check">
              <input type="checkbox" checked={outputs.pocket} onChange={(e) => setOutputs({ ...outputs, pocket: e.target.checked })} />
              clear pockets (slower, removes all waste)
            </label>

            {planError && <div className="c3d-error">{planError}</div>}
          </div>
        </aside>
      </div>

      <div className="ss-dialog__footer">
        <button
          type="button"
          className="ss-btn ss-btn--primary"
          disabled={computing || !msCurrent || !msPlan || msPlan.shapes.length === 0}
          onClick={add}
        >
          Add to Design
        </button>
        <button type="button" className="ss-btn-round" onClick={onClose} aria-label="Cancel">
          <IconClose />
        </button>
      </div>
    </div>
  )
}
