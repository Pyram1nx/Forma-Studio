# Units audit — Forma Studio

Internal model is mm everywhere (`src/model/types.ts:1`), with conversion helpers `toUnits`/`fromUnits`/`fmtLen` in `src/model/factory.ts:31-33`. Below: findings first, verified items at the end.

---

## Findings

### 1. minor — mm display rounds 3.175 → "3.17" (the ⅛″ case)
- **Where:** `src/model/factory.ts:33` (`fmtLen`) and `src/editor/Panels.tsx:29` (`NumField` fmt): `toFixed(units === 'in' ? 3 : 2)`.
- **What:** mm values are shown with 2 decimals, but the most common imperial values have 3 significant decimals. `(3.175).toFixed(2)` is `"3.17"` in JS (the double for 3.175 is 3.174999…). So a ⅛″ bit preset (`Panels.tsx:272`, stored 3.175 mm) displays **0.125 in** in inch mode but **3.17 mm** after switching to mm — and a user who types `3.175` in the Bit Diameter field sees it "become" 3.17 on blur, implying their input was rejected. Same for 6.35→"6.35" (ok) and depth 1/16″=1.5875→"1.59". Internal value and SVG export (`+v.toFixed(4)`, `src/io/svgExport.ts:22`) stay exact, so this is display-only — but it's exactly the 0.125 in → 3.17 vs 3.175 case.
- **How hit:** set any depth/bit to an imperial value in `in`, switch units to `mm`, read the Plan panel, depth tooltip, or bbox labels.
- **Fix:** in `fmtLen` and `NumField.fmt`, use 3 decimals for mm too, or trim instead of truncate: `const s = toUnits(mm,u).toFixed(u==='in'?3:3).replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'')`. If 2-decimal mm is desired for compactness, round the *displayed* value with `Math.round(v*1000)/1000` and only fall back to 3 decimals when the 3rd decimal is non-zero.

### 2. minor — units cannot be switched from Plan or Review mode
- **Where:** `src/editor/Chrome.tsx:160-163` (clicking the active Plan/Review tab is a no-op; only the Design tab toggles `popover === 'settings'`) and `Chrome.tsx:172` (`popover === 'settings' && mode === 'design'`).
- **What:** the Settings popover (Units/Smart Alignment/Position/Origin Anchor) only exists in Design mode. In Plan mode — where the user is actively typing depths and bit diameters in the current unit — there is no way to change units without first switching back to Design.
- **How hit:** enter Plan mode (key `2`), select a path, realise the bit presets are in the wrong unit, look for the unit toggle — it's gone.
- **Fix:** render the chevron and allow the settings popover for whichever tab is selected: drop `m.id === 'design'` at `Chrome.tsx:167` and the `mode === 'design'` guard at `Chrome.tsx:172`. (`docs/research/shaper-studio-design.md:43` describes the chevron as living on the *selected* tab, not specifically Design.)

### 3. minor — Paper Scan "Custom" sheet defaults are inch values shown raw in mm mode
- **Where:** `src/features/paper/PaperScanDialog.tsx:292-293` (`useState(8.5)`, `useState(11)`) and the clamp at `:109-110` (`Math.max(10, fromUnits(customW, units))`).
- **What:** `customW/H` are stored in *display* units. In an `in` document the defaults 8.5×11 mean US Letter — sensible. In an `mm` document, selecting Custom pre-fills **8.5 × 11 mm**, which the clamp silently raises to 10 mm; a user who doesn't look closely scans at 10×11 mm and every traced line comes out ~25× too small.
- **How hit:** doc units = mm → Paper Scan → Photo → Paper → preset "Custom".
- **Fix:** initialise from units, e.g. `useState(units === 'in' ? 8.5 : 210)` / `useState(units === 'in' ? 11 : 297)`, or default the preset to Custom-with-current-units-Letter/A4.

### 4. minor — `parseLength` rejects comma decimals
- **Where:** `src/editor/ops.ts:195` — the arithmetic guard `/^[-+*/().\d\s]+$/` does not include `,`.
- **What:** typing `3,5` (comma decimal, standard in much of Europe) into any `NumField` returns `null`, so `commit()` reverts the field to the previous value with no feedback. Fraction and unit-suffix parsing otherwise work well (`3/8`, `1 1/2`, `10mm`, `0.5in`).
- **How hit:** any length field (Size, Depth, Offset, Bit Diameter, Offset distance, template params); type `2,5` → Enter → the old value snaps back.
- **Fix:** before the arithmetic branch, normalise `t = t.replace(/,(\d)/, '.$1')` (or `/(\d),(\d)/ → '$1.$2'` so `1,500` isn't mangled in ways users don't expect — arguably accept both and let `1,5 → 1.5`). The Carve3D/Paper dialogs use `type="number"` inputs, which the browser locale-handles, so they're fine.

### 5. minor — text height is hard-wired to 1 inch, no height control
- **Where:** `src/editor/TextDialog.tsx:38` — `const height = … ?? MM_PER_IN : MM_PER_IN`.
- **What:** every new text block is 25.4 mm cap-height. In an `mm` document the panel then shows the odd value **25.40 mm**, and in inch mode there's no way to type a different height at all (the dialog has no size field; only later W/H scaling in the Design panel).
- **How hit:** doc units = mm → Add Text → panel shows 25.4 mm; or any user wanting 50 mm text must place then resize numerically.
- **Fix:** minimum: pick the default from doc units (`units === 'mm' ? 25 : MM_PER_IN`) and store it in `params.height`. Better: add a height `NumField` to the dialog, converting via `fromUnits/toUnits` like Carve3DDialog does.

### 6. nit — Offset panel default distance is an inch constant
- **Where:** `src/editor/Popovers.tsx:105` — `distance: MM_PER_IN / 8` (= 3.175 mm, displayed "3.18 mm" in mm mode).
- **How hit:** mm document → Offset → the field reads the awkward 3.18 mm.
- **Fix:** `distance: units === 'in' ? MM_PER_IN / 8 : 3` (or 5 mm). Note also the state persists across dialog opens because `OffsetPanel` stays mounted — arguably a feature (last value remembered), but the *first* default is the only one users see.

### 7. nit — new shapes are always exactly 1 inch (25.4 mm), even in mm docs
- **Where:** `src/editor/shapeFactory.ts:20,55-65` (`const IN = MM_PER_IN`, all `createBasic` sizes derive from it). Same pattern for template defaults (50.8/25.4/19.05 mm in `src/geometry/templates.ts`) and the 3D dialog's fixed `margin` default of 5 mm.
- **Assessment:** `docs/research/shaper-studio-design.md:53` records that real Studio defaults new shapes to **1.000 in**, so matching the physical size and converting the display is defensible — in mm mode the panel correctly shows 25.40 mm. But a mm-native user gets non-round geometry (25.4 mm) for a "default" shape. If fidelity to Studio is the goal, current behaviour matches the documented measurement; if mm-first ergonomics matter more, use 25 mm (or 30 mm) when `doc.units === 'mm'`. Passing `units` into `createBasic` would be the minimal change.

### 8. nit — paper preset labels hardcode "mm" while the surrounding UI converts
- **Where:** `src/features/paper/PaperScanDialog.tsx:784` — `` `${p.label} (${fmtMm(p.w)} × ${fmtMm(p.h)} mm)` ``.
- **What:** in an `in` document the dropdown reads "A4 (210 × 297 mm)" while the summary two rows below (`:828`) shows the same sheet as "210.00 mm × 297.00 mm" converted… no — `:828` uses `fmtLen(paper.w, units)`, which in `in` mode shows inches. So the select shows mm, the summary shows inches, and Custom fields are inches. Consistent enough (presets *are* real mm sheets), but mixed. Fix: show both, e.g. `A4 (210 × 297 mm · 8.3 × 11.7 in)` when `units === 'in'`.

### 9. nit — ink sliders hardcoded to mm / mm²
- **Where:** `src/features/paper/PaperScanDialog.tsx:899-900` — `unit="mm"` on Edge margin and Min blob regardless of doc units.
- **How hit:** in-mode user sees "Edge margin 4 mm". Not wrong (labelled), just unit-unaware in an otherwise unit-aware dialog. Fix: convert for display (`fmtLen`-style) or leave as-is deliberately since they're scanner-domain values.

### 10. nit — mm depth step differs between the stepper buttons and arrow keys
- **Where:** `src/editor/Panels.tsx:303` (`step = units === 'in' ? MM_PER_IN/16 : 0.5` for the ± buttons) vs `Panels.tsx:69` (NumField arrow-key default `1` mm).
- **How hit:** mm mode, focus the Depth field: `+` adds 0.5 mm, `↑` adds 1 mm. Fix: pass `step={step}` to the depth NumField (`Panels.tsx:339`) so both use 0.5 mm.

### 11. nit — duplicate placement offset fixed at 6.35 mm (¼″)
- **Where:** `src/state/store.ts:195` (`const off = inPlace ? 0 : 6.35`).
- **How hit:** mm document, Duplicate → copy lands 6.35 mm away. Fix: `doc.units === 'mm' ? 5 : 6.35` (or leave; it's invisible to most users). Same class of constant: import placement gap `+25` at `store.ts:161` — fine either way.

### 12. nit — bbox label pills have fixed widths that overflow in mm
- **Where:** `src/editor/Canvas.tsx:494` (68 px wide pill) and `Canvas.tsx:507` (150 px). Labels are `fmtLen` strings; "2540.00 mm" (10 chars) or "x -254.00 mm · y -254.00 mm" exceed the pills.
- **How hit:** mm document, select a large shape → text spills past the rounded rect. Fix: size the `<rect>` from the string length (`text.getComputedTextLength()` or a rough char-width estimate), as the in-mode strings are shorter so this mostly surfaces in mm.

### 13. nit — every new document starts as `in`; no global preference
- **Where:** `src/state/store.ts:24` (`units: 'in'` in `newDoc`). Per-document storage and persistence are otherwise correct (`types.ts:96`, `projectFile.ts:28` backfills `'in'` for old files, autosave round-trips it).
- **How hit:** a mm user creates New Design repeatedly and re-picks mm every time. Fix: remember the last unit in `localStorage` (e.g. alongside `KEY_LAST`) and seed `newDoc` from it. Answer to the audit question: units are **per document**, persisted in the `.shaperstudio` file and autosave; there is no global setting.

### 14. nit — group `info` metadata hardcodes mm and is never rendered
- **Where:** `src/features/carve3d/carvePlan.ts:202` (`stepDown: round2(s), stock: round2(T)` — raw mm) and `src/features/paper/PaperScanDialog.tsx:597` (`"… mm"`); grep shows `Group.info` is written but never read by any UI.
- **Fix:** either render it (then format with `fmtLen` and doc units) or drop it. Harmless dead data today.

---

## Verified as correct

- **Model/IO spine:** all geometry, cut settings (depth/offset/bitDia), and template params are stored in mm; a single pair of helpers (`toUnits`/`fromUnits`, `factory.ts:31-32`) does every conversion — no stray ×25.4 in UI code.
- **SVG export is always mm** regardless of doc units: `width/height="…mm"`, viewBox in mm, `shaper:cutDepth/toolDia/cutOffset` in mm (`svgExport.ts:58-60,77`) — what Origin requires.
- **SVG import** resolves `width`/`height` units (mm/cm/in/pt/pc/px, unitless = px @96 dpi) against the viewBox into `mmPerUnit` correctly (`svgImport.ts:10-17,71-74`), and reads `shaper:cutDepth` back in mm incl. `in`-suffixed values.
- **Design panel:** Size W/H, Radius, Rotation, Position, and all template params display and parse in doc units; `parseLength` additionally accepts fractions (`3/8`, `1 1/2`), arithmetic (`2*3`), and explicit unit suffixes (`10mm`, `0.5in`, `2cm`) in either mode (`ops.ts:172-204`).
- **Plan panel:** Depth, Offset, Bit Diameter all convert; bit presets are unit-appropriate (⅛/¼/½″ vs 3/6/8 mm) with a correct cross-unit active highlight (`Math.abs(bit - p.mm) < 0.01`); the BIT catalogue, flute-length warnings, and stepper all work in mm internally.
- **Canvas labels:** bbox W/H, x/y position label (design mode) and the plan-mode depth tooltip all use `fmtLen(…, doc.units)`, with `mixed`/`unset` states handled.
- **Nudge:** arrow keys step 1/16″ in inch docs and 1 mm in mm docs, Shift ×10 (`App.tsx:61`).
- **3D Carve dialog:** fully unit-aware — every field goes through `toU/fromU/L` with per-unit decimals (`dec = units === 'in' ? 3 : 2`); fit-width default is unit-aware (4 in / 100 mm); the model-units select (mm/cm/in/m) is correctly independent of doc units; bit gallery annotations and layer table all convert.
- **Dialogs vs. unit switching mid-open:** carve3d/paper are true modals (overlay + the `App.tsx:25` keydown guard), so units *cannot* change while they're open, and they remount per open so their unit-dependent defaults are always fresh; the Offset panel (non-modal) re-syncs its display on a unit switch via `NumField`'s `[value, units]` effect.
- **Paper Scan:** custom sheet W/H are entered in doc units and converted at use; the paper-size summary and stroke-width result use doc units; presets are real fixed mm sheet sizes; the scan pipeline works in px/mm internally and emits mm geometry.
- **New shape default of 1 in matches the measured Studio behaviour** (`docs/research/shaper-studio-design.md:53`), shown converted as 25.40 mm in mm mode.
- **Depth stepper semantics:** stepping down to 0 unsets depth (`|| null`), consistent with the "unset" placeholder and Origin's ask-at-cut-time model.
