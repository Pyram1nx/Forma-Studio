The audit is complete — I've traced every control in `src/editor/*`, `App.tsx`, the store, both feature dialogs, and the io/geometry wiring. Here is the report.

# Forma Studio audit — feature inventory & wiring

Scope: README claims, controls in `src/editor/*.tsx` + `src/App.tsx`, store actions, settings, shortcuts dialog, error paths, and gaps vs `docs/research/shaper-studio-design.md`. Read-only audit; nothing was modified.

---

## Findings

### Major

**M1. Locked shapes can never be unlocked — the only unlock affordance removes itself.**
- `src/editor/Panels.tsx:172` — locking runs `st().select([])`, which unmounts the whole design panel (`Panels.tsx:138` returns null with no selection).
- `src/editor/Canvas.tsx:142` — `hitTest` skips locked shapes, so they can't be clicked.
- `src/editor/Canvas.tsx:388` — marquee skips locked shapes.
- `src/App.tsx:49` — `⌘A` excludes locked shapes.
- **User impact:** click the reference-path button on a shape → it deselects and becomes unreachable. The Unlock button (which only renders when a selection exists, and only shows "Unlock" when *all* selected are locked) can never be shown again. Only `⌘Z` (undo, same session) recovers. The lock also persists in saved/autosaved files.
- **Fix:** don't clear the selection when locking (keep `sel` so the button flips to Unlock, matching the real Studio's reference-path toggle); and/or let `hitTest` return locked shapes as selectable-but-immovable so they can be re-selected and unlocked.

**M2. Plan-mode Depth "−" button *sets* a depth when depth is unset, instead of stepping toward unset.**
- `src/editor/Panels.tsx:338`: `depth: depth == null ? step : Math.max(0, depth - step) || null`
- With depth unset (`null`), the − button assigns `depth = +step` — identical to the **+** button (`Panels.tsx:340`). Pressing "−" silently gives the shape a real cut depth (⅟₁₆″ / 0.5 mm) that gets exported as `shaper:cutDepth`.
- **Fix:** `depth: depth == null ? null : (Math.max(0, depth - step) || null)`.

### Minor

**m1. Autosave failure is silent, and old document blobs leak toward the quota.**
- `src/io/projectFile.ts:113-116` — quota errors only `console.warn`. A user who relies on autosave (README: "Autosave + Open Recent") gets no sign their work is no longer persisting; closing the tab loses everything after the last successful write.
- `src/io/projectFile.ts:112` — the recent list is capped at 20, but the `shaperstudio:doc:<id>` payload of entries that fall off the list is never deleted, so large designs (README itself notes 3D slice sets) accumulate until the quota trips.
- `src/io/projectFile.ts:136` — `removeRecent`'s `setItem` is unguarded (can throw under quota pressure, unlike `autosave`).
- **Fix:** purge orphaned `KEY_DOC` entries when trimming the recent list; wrap `removeRecent` in try/catch; show a one-time toast ("Autosave paused — browser storage full, use Save") when `autosave` fails.

**m2. "Origin Anchor" setting's effect doesn't match its label and is inconsistently applied.**
- It *is* read — but only at `src/editor/Canvas.tsx:267`, where it changes canvas corner-handle scaling to anchor at the bbox center instead of the opposite corner. Panel resize/rotate (`src/editor/ops.ts:41-79`) ignores it entirely and uses the panel's own AnchorPicker, and nothing about the document origin is affected. The Position readout is also always the top-left corner (`src/editor/Panels.tsx:162`) regardless of the chosen anchor cell.
- **User impact:** a toggle labeled "Origin Anchor" (design doc §Layout: settings = Units / Smart Alignment / Position / Origin Anchor) mysteriously changes how drag-scaling pivots.
- **Fix:** either wire it to what the name says (make the panel AnchorPicker/position readout relative to a document origin) or rename it (e.g. "Scale from centre") and document it.

**m3. Delete does nothing in Plan and Review mode — and Plan mode has no delete control at all.**
- `src/App.tsx:50-53`: `preventDefault()` runs, then the delete only fires `if (st.mode === 'design')`. The ActionBar and DesignPanel are design-only (`src/editor/Chrome.tsx:229`, `Panels.tsx:138`), so in Plan mode there is no way to delete a shape. Inconsistent: `⌘D` *does* work in Plan (`App.tsx:44-46` has no mode guard).
- **Fix:** drop the `mode === 'design'` condition on `deleteSelected()` (cut settings already survive deletion fine), or add a delete button to the Plan UI.

**m4. Escape closes the 3D Carve / Paper Scan dialogs even while the user is typing in a field — destroying all dialog state.**
- `src/features/carve3d/Carve3DDialog.tsx:166-172` and `src/features/paper/PaperScanDialog.tsx:348-354` add a window-level Escape listener with no target check and no input guard. The App-level handler is suppressed while a dialog is open (`App.tsx:25`), so this is the only Escape path.
- **User impact:** pressing Escape in a number field (a common "clear/revert" habit) throws away the loaded model, bit choice, plan; or the photo, corners, and all ink settings.
- **Fix:** add the same `closest('input, textarea, select, [contenteditable]')` guard used at `App.tsx:23`, or require a modifier/confirm before closing a wizard mid-flow.

**m5. Escape inside the Text dialog only works while focus is in the textarea.**
- `src/editor/TextDialog.tsx:83` handles Escape only in the textarea's `onKeyDown`; unlike the two feature dialogs there is no window listener, and the global handler is suppressed (`App.tsx:25`). Click the dialog header, press Escape → nothing.
- **Fix:** add a window keydown listener for Escape (with the input guard omitted here — the dialog has a single textarea, so closing on Escape anywhere is acceptable), matching `Carve3DDialog.tsx:166`.

**m6. Alt+click "select whole group" doesn't work on an already-selected shape.**
- `src/editor/Canvas.tsx:237-241`: the Alt branch only exists in the `!sel.includes(hit.id)` path. If the clicked shape is already selected (the common case when picking group members), Alt+click is a no-op. The shortcuts dialog (`src/editor/Popovers.tsx:191`) promises "Alt + click — Select whole group" unconditionally.
- **Fix:** hoist the Alt+groupId expansion out of the `else if`, e.g. `if (e.altKey && hit.groupId) sel = groupId members` after the toggle branch.

**m7. Inside/Outside/Pocket can be applied to open paths in mixed selections; preview and export silently coerce to on-line.**
- `src/editor/Panels.tsx:300-301` only restricts the cut-type menu when *all* selected paths are open. With a mixed selection, choosing "Inside" leaves the open shape's `cut.type` as `inside`, but `src/editor/geomCache.ts:53` previews it as on-line and `src/editor/svgExport.ts:46` exports it as `online` — the panel label then lies about what will be cut.
- **Fix:** apply the type only to shapes it's valid for (set open shapes to `online` in the same `setCut`), or filter per-shape.

**m8. Shortcuts dialog is out of date in both directions.**
- Implemented but unlisted:
  - `F` — zoom to fit (`src/App.tsx:67-68`)
  - `⌘Y` — redo (`src/App.tsx:32-34`)
  - `⌘⇧E` — export *selection* as SVG (`src/App.tsx:43`)
  - Pen tool: `Enter` finishes, `Backspace` removes last point, `Escape` cancels (`src/editor/Canvas.tsx:99-107`)
  - Middle/right-button drag pans (`src/editor/Canvas.tsx:210`)
  - `↑/↓` steps value in any panel number field (`src/editor/Panels.tsx:67-72`)
- Listed with unstated conditions: "Delete" and "Arrows" are design-mode only (`src/App.tsx:53,59` — see m3); "Alt + click" (see m6).
- **Fix:** add the missing rows, annotate the conditional ones ("Design mode"), and fix m3/m6 so the rest are true.

**m9. `Group.info` is written by both feature dialogs and never read anywhere.**
- Written at `src/features/carve3d/Carve3DDialog.tsx:206` (bit summary, layer table) and `src/features/paper/PaperScanDialog.tsx:596-604` (paper size, stroke width, mode, px/mm). The only group UI is `src/editor/Panels.tsx:228-238`, which shows `group.name` and `meta.note` but not `info`. It's stored in the doc and autosave forever, displayed nowhere, and not written to SVG export.
- **Fix:** render the `info` key/values in the DesignPanel's group section (it's exactly the "bit summary" context a user wants back after importing), or stop storing it.

**m10. Real-Studio features in the design doc that are missing.**
- `docs/research/shaper-studio-design.md:42` — "Find Art" left-rail button: absent (`src/editor/Chrome.tsx:101-122` has Draw/Make Shape/Add Text/File Import/3D Carve/Paper Scan only).
- `shaper-studio-design.md:49` — App menu "Move", "Share Design", and the "Export (n of n)" count: absent (`src/editor/AppMenu.tsx:63-75` shows a static "for Origin" badge instead of a count).
- `shaper-studio-design.md:50` — "GO TO: Trace / My Files / ShaperHub / Forum / Shop / Account + Sign Out": replaced by 3D Carve/Paper Scan/Shortcuts. Clearly intentional (no backend) but worth noting in README since the doc is the measurement source.
- `shaper-studio-design.md:56` — "panel shows a font picker" for text: the clone's font picker exists only inside the Edit Text dialog (`src/editor/TextDialog.tsx:88`); a placed text shape's panel offers no font/height control.
- **Fix (cheap ones):** compute the export count (`doc.shapes.filter(!hidden).length` vs selection) for the menu item; add a font `<select>` to DesignPanel for `kind === 'text'`.

### Nit

**n1.** `src/editor/Canvas.tsx:447` — `style={{ order: s.cut.depth ?? 0 }}` on an SVG `<g>` is a no-op (CSS `order` doesn't apply to SVG children). Harmless: real ordering comes from the sort at `Canvas.tsx:408`. Delete the style.

**n2.** `src/model/types.ts:69` — `Shape.hidden` is filtered everywhere (`Canvas.tsx:71`, `App.tsx:49`, `svgExport.ts:25`, `store.ts:158,245`) but no code ever sets it and there's no hide UI. Dead model field; remove or ship the feature.

**n3.** `src/editor/Chrome.tsx:97` — opening a malformed `.json`/`.shaperstudio` via File Import toasts the raw `SyntaxError` text ("Import failed: Unexpected token…"). Wrap the `parseDoc` call to substitute "Not a Forma Studio design file" for JSON syntax errors.

**n4.** `src/App.tsx:82-86` + `src/state/store.ts:135-138` — the 600 ms autosave debounce isn't flushed by `setDoc`; choosing New Design / Open Recent / a recent file within 600 ms of an edit loses that edit from localStorage (in-memory undo history is also cleared). Flush pending autosave in `setDoc` before swapping.

**n5.** `src/io/text.ts:26-35` — `loadFont(name)` ignores `name` when loading (always fetches the IBM Plex file). Works only because `addCustomFont` pre-seeds the cache (`text.ts:22`). Fragile: any cache miss for a custom font silently renders IBM Plex. Fetch per-name or assert.

**n6.** `src/editor/Panels.tsx:213` — Rotation shows `0` for a multi-selection instead of "mixed" (cut settings and depth already handle this, `Panels.tsx:295-299,339`); committing a value silently *adds* that angle as a delta.

---

## Feature inventory

Legend: ✅ wired and does what it says · 🟡 wired but with a defect noted · ❌ claimed/present but not functional.

### README Design row

| Claim / control | Implementation | Status |
|---|---|---|
| Pen tool | `Canvas.tsx:174-231` (click-to-place, close-on-start-click, ⌃double-click/Enter finish, Shift angle snap) | ✅ |
| Make Shape: circle, ellipse, rect, rounded rect, polygon, triangle | `shapeFactory.ts:51-67` → `addShapes` | ✅ |
| + 14 templates | `templates.ts:163` (14 entries) → `Popovers.tsx:53-59`, params editable in panel `Panels.tsx:196-208` | ✅ |
| Text to outlines (IBM Plex Sans / own font) | `TextDialog.tsx` + `io/text.ts` (opentype.js, font upload) | ✅ (n5) |
| SVG import | `Chrome.tsx:86-99` → `io/svgImport.ts` (units, transforms, shaper attrs) | ✅ |
| Move / scale / rotate / anchor | drag `Canvas.tsx:297-343`; 8 handles `Canvas.tsx:256-273,344-371`; Rotation field `Panels.tsx:209-218` (n6); AnchorPicker `Panels.tsx:90-119,227` | ✅ |
| Smart-alignment snapping | `Canvas.tsx:306-335`, honors toggle + Alt-bypass | ✅ |
| Offset | `Chrome.tsx:234` → `Popovers.tsx:101-165` → `ops.ts:146-169`, incl. direction/corners/merge/keep | ✅ |
| ShapeShifter union/subtract/intersect/exclude | `Popovers.tsx:67-99` → `ops.ts:116-135` (z-order base for subtract; empty-result guard) | ✅ |
| Mirror / duplicate / z-order / lock | `store.ts:199-236`; lock = reference-path button `Panels.tsx:166-176` | 🟡 lock → **M1** |

### README Plan row

| Claim / control | Implementation | Status |
|---|---|---|
| Cut type on line / guide / inside / pocket / outside | `Panels.tsx:262-268, 305-333`; open-path guard `Panels.tsx:300-301` | 🟡 mixed-selection gap → **m7** |
| Depth stepper (unset) | `Panels.tsx:336-342` | 🟡 **M2** |
| Offset (+flip) | `Panels.tsx:343-355` | ✅ |
| Bit diameter ⅛ ¼ ½ presets + bit library | `Panels.tsx:270-284, 356-384` → `bits.ts` (13 bits) | ✅ |
| Live tool-width + cut-path preview | `geomCache.ts:44-78` (`bandD`/`centreD` from `bitDia`+`offset`) rendered `Canvas.tsx:429-439` | ✅ |

### README Review / Files rows

| Claim / control | Implementation | Status |
|---|---|---|
| Depth-shaded material preview | `Canvas.tsx:407-450` (sorted shallow→deep, gray scale, grain pattern) | ✅ (n1 cosmetic) |
| Autosave + Open Recent | `App.tsx:76-97`, `projectFile.ts:85-144`, menu `AppMenu.tsx:75-116` | 🟡 **m1**, n4 |
| Save/Open `.shaperstudio` (writes back in Chrome/Edge) | `fileActions.ts:8-29`, `projectFile.ts:38-62` (FSA + download/input fallback) | ✅ |
| Export SVG for Origin | `fileActions.ts:31-40` → `svgExport.ts` (mm size, colour + `shaper:cutType`/`cutDepth`) | ✅ |

### README 3D Carve / Paper Scan rows

| Claim / control | Implementation | Status |
|---|---|---|
| STL/OBJ/GLB/GLTF, units, up-axis, fit-to-size | `Carve3DDialog.tsx:70-123, 174-201, 266-309` | ✅ |
| 13-bit gallery with profile drawings | `BitGallery` ← `bits.ts` (13 entries) | ✅ |
| Step-down / layers / stock / margin, through-cut, 3 outputs | `Carve3DDialog.tsx:83-89, 313-366` → `carvePlan.ts` | ✅ |
| Camera or photo upload | `PaperScanDialog.tsx:356-413` (getUserMedia + file/drop) | ✅ |
| Corner detection + draggable corners | `PaperScanDialog.tsx:201-270, 417-433, 850-860` (auto-detect, loupe, rotate) | ✅ |
| A3/A4/A5/Letter/Legal/Tabloid/custom | `PaperScanDialog.tsx:31-39, 773-830` | ✅ |
| Lighting correction, adaptive threshold | `paper/ink.ts` (background division via integral image + adaptive mean) | ✅ |
| Centerline/outline, stroke-width estimate | `PaperScanDialog.tsx:866-925` → `paper/trace.ts` | ✅ |

### Controls in App.tsx / editor components

All chrome controls are wired: logo→menu, inline rename (TopLeft + AppMenu), Undo/Redo, left rail (6 buttons), zoom-to-selection/recenter, mode switcher (+ design-tab settings popover: Units in/mm, Smart Alignment, Position, Origin Anchor — all persisted via `setSetting`), action bar (Offset, Edit Text, ShapeShifter, Mirror H/V, Duplicate ×2, Front/Back, Delete), Make Shape popover (6 + 14 + close), ShapeShifter popover (4 ops, disabled <2), Offset panel (7 controls), Shortcuts dialog, Help button, Toast. No dead/no-op controls found other than those flagged above.

---

## Store actions never called

**None.** All 33 actions on the store interface are invoked from UI or ops code (checked by cross-referencing every call site). The closest things to dead state are the *data* fields in the previous section: `Group.info` (written, never read — m9) and `Shape.hidden` (read everywhere, never written — n2).

---

## Shortcuts cross-check

| Listed in help dialog | Implemented? |
|---|---|
| ⌘S / ⌘⇧S Save / Save as | ✅ `App.tsx:35-37`, `projectFile.ts:38-52` (⇧ forces picker) |
| ⌘O Open | ✅ |
| ⌘E Export SVG | ✅ (⇧ = selection only, unlisted) |
| ⌘Z / ⌘⇧Z Undo/Redo | ✅ (+ unlisted ⌘Y) |
| ⌘D Duplicate | ✅ |
| ⌘A Select all | ✅ (skips locked — part of M1) |
| Delete | 🟡 design mode only (m3) |
| Arrows nudge (⇧ ×10) | ✅ design mode only, unstated |
| Space+drag pan, Pinch/⌘scroll zoom | ✅ `Canvas.tsx:155-171, 210` |
| P, 1/2/3 | ✅ |
| Alt+click group | 🟡 only on unselected shapes (m6) |
| Shift snap/free-scale/add | ✅ `Canvas.tsx:195-201, 349-353, 237` |
| Alt+drag no snap | ✅ `Canvas.tsx:308` |

Unlisted-but-implemented: **F** (zoom fit), ⌘Y, ⌘⇧E, pen Enter/Backspace/Escape, middle/right-button drag pan, ↑/↓ in number fields (m8).

---

## Error handling (as requested)

| Scenario | Behaviour | Verdict |
|---|---|---|
| Bad SVG (garbage, parsererror, non-SVG) | `svgImport.ts:58` throws "Not an SVG file" → toast; 0 paths → "No paths found in that SVG" (`Chrome.tsx:94`) | ✅ |
| Bad `.shaperstudio`/`.json` | `parseDoc` validates `app`/`shapes` with a clear message; malformed JSON leaks raw SyntaxError (n3) | 🟡 |
| Save cancelled (user aborts picker) | `AbortError` silenced (`fileActions.ts:6,16`); same for open (`:27`) | ✅ |
| Storage full | `autosave` catches quota but only `console.warn`s; orphaned doc keys accumulate; `removeRecent` unguarded (m1) | ❌ surfaced silently |
| 3D model load/plan failure | inline error text, plan gate on Add button (`Carve3DDialog.tsx:153-157, 409`) | ✅ |
| Paper: camera denied, bad image, degenerate quad | friendly inline errors (`PaperScanDialog.tsx:365-367, 397-399, 464-466`) | ✅ |
| Font load failure, empty text, empty boolean/offset results | toasts / no-ops with messages (`TextDialog.tsx:61-63`, `ops.ts:119-128, 163-166`) | ✅ |

---

## Verified as correct

- **Every store action is called** from somewhere; no dead actions in `src/state/store.ts`.
- **All three doc settings are read**: `smartAlignment` (`Canvas.tsx:308`), `showPosition` (`Panels.tsx:219`, `Canvas.tsx:505`), `originAnchor` (`Canvas.tsx:267` — though see m2).
- Template count (14, `templates.ts:163`) and bit count (13, `bits.ts:22`) match README; bundled IBM Plex font exists (`public/fonts/IBMPlexSans-Regular.woff`).
- SVG cut encoding matches the design doc exactly: fill/stroke convention + `shaper:cutType` + `shaper:cutDepth`, plus `shaper:toolDia`/`cutOffset`/`pathType` (`svgExport.ts:13-61`), and import reads the namespace attrs back (`svgImport.ts:31-33, 103`).
- Plan previews genuinely derive from `bitDia` and `offset` (`geomCache.ts:44-78`); pocket mode renders the cleared region, guide mode suppresses depth/preview correctly.
- Undo/redo preserves selection validity; history capped at 100; checkpoint-before-mutate ordering is consistent (no double-checkpoints found).
- Autosave restore-on-launch, Open Recent round-trip, FSA handle write-back, and the download/input fallback path all hang together; `beforeunload` guard only fires for unsaved *file* work.
- All 16 shortcut rows in the help dialog correspond to real handlers (two with undocumented conditions — m3/m8).
- All README feature-table rows resolve to working code except the defects listed above.
