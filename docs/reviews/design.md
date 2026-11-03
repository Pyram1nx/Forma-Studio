# Forma Studio — Design-Language Fidelity Audit

Ground truth: `docs/research/shaper-studio-design.md`. All findings are read-only observations; nothing was modified.

---

## A. Deviations from the measured design doc

**A1. minor — `src/styles/app.css:64` — selected path stroke width 2.5px, doc says 3.5px**
`.cv-shape.is-selected { stroke-width: 2.5px }` but the doc measures the selected stroke in design mode as `#0546f6` **3.5px**. Every selection in design mode looks thinner than Studio.
Fix: `stroke-width: 3.5px`.

**A2. minor — `src/styles/app.css:164` — plan selected base stroke 3px, doc says 4px**
`.pl-base-sel { stroke: var(--cut-green); stroke-width: 3px }`; doc: "base path `#1be09e` 4px".
Fix: `stroke-width: 4px`.

**A3. minor — `src/styles/app.css:190` — depth tooltip radius 4px, doc says "pill"**
`.cut-depth-tooltip { border-radius: 4px; height: 24px }`. A 24px-tall pill should have fully rounded ends (~12px). Currently renders as a near-square black tag in plan mode.
Fix: `border-radius: 12px` (or `var(--radius-pill)`).

**A4. minor — `src/editor/Chrome.tsx:167` — chevron only on the Design tab**
Doc: the selected mode tab shows "icon + label + **chevron** (opens settings)". Forma Studio renders the chevron (and settings popover) only for `design`; selected Plan/Review tabs have no chevron and clicking them does nothing, even though Units (used by Plan fields) and the other settings are presented as global.
Fix: render the chevron on whichever tab is selected and let it open the settings popover in all modes (or consciously update the doc).

**A5. minor — `src/editor/AppMenu.tsx:68-71` + `src/styles/app.css:1144-1152` — export badge shows "for Origin", doc says "(n of n)"**
Doc: "Export (n of n)" with the yellow count badge. The badge is yellow (correct) but contains static text `for Origin` instead of an exported/total path count, so users can't see how much will export.
Fix: compute exported path count and render e.g. `{n} of {total}` inside `.export-count`.

**A6. minor — `src/editor/Chrome.tsx:100-123` — "Find Art" missing from the left rail**
Doc rail order: Find Art, Draw, Make Shape, Add Text, File Import. Forma Studio starts at Draw. (3D Carve / Paper Scan with the red "new" dot are extensions, not the issue.) If Find Art is intentionally out of scope, it should be recorded in the research doc; today it just reads as a missing button to anyone comparing against Studio.
Fix: add the Find Art rail button (or a stub) above Draw, or document the omission.

**A7. minor — `src/editor/AppMenu.tsx:63-75,118-122` — menu sections diverge from doc**
Doc upper section: Rename / **Move** / Export / **Share Design**, divider, Duplicate / New / Open Recent. Lower "GO TO": Trace / My Files / ShaperHub / Forum / Shop / Account + avatar/email/Sign Out. Forma Studio replaces Move/Share Design and the whole Go-To list with local-app entries (3D Carve, Paper Scan, Shortcuts). Understandable for a local, unaffiliated clone, but it's a measurable deviation: no "GO TO" list items from the doc survive, and there is no user footer.
Fix: if deliberate, note it in the design doc; otherwise add disabled entries for Move/Share Design.

**A8. minor — `src/editor/Canvas.tsx:444-448` — review mode shades cuts *darker* with depth; doc says "cut areas lighter"**
`t = depth/maxDepth; c = 246 − t*120` → deeper cuts render darker gray on the `#d9dbe1` canvas. Doc: "material render of the result (**cut areas lighter**)" — i.e. revealed end-grain reads lighter than the surface.
Fix: invert the ramp (e.g. `c = 126 + t*120`) or re-measure; also the review fill/stroke/grain colors here (`rgb(...)`, `rgba(253,253,254,.9)`, `rgba(120,124,138,…)` Canvas.tsx:578-579) are hard-coded — see B2.

**A9. minor — `src/styles/components.css:317-329` — `ss-badge` is blue; doc reserves **snap red** for badges**
Doc token table: `snap red #ff274e — snapping guides, badges`. The generic badge ("new" in App Menu and Templates header, bit type in 3D Carve) is blue-light/blue. Only the rail new-dot (`app.css:375-385`) is red.
Fix: give `.ss-badge` a red variant (`background: var(--snap-red); color: var(--white)`) for "new" chips, or add a `.ss-badge--new` and keep blue for neutral info chips.

**A10. nit — `src/styles/app.css:786` (`.stepper__input`), `.ss-select`, `.cut-type-select__btn` — control heights 32 vs 35px mixed in one panel**
Plan panel column mixes 35px controls (cut type, offset flip is 32) and 32px inputs/stepper; `.radius-add` and `.ss-select` are 35px while `.ss-input` is 32px. If Studio really does use 35 for selects and 32 for inputs this is fine — but it's undocumented and untokenized.
Fix: measure once, then encode as `--control-h` / `--control-h-sm` tokens.

---

## B. Hard-coded colors that should use tokens

**B1. minor — `src/styles/app.css:49` and `app.css:153`**
`.cv-shape { stroke: #56575d }` (= `--gray-600`) and `.pl-base.is-guide { stroke: #6b93ff }` (= `--blue-soft`). If the gray-600 token ever changes, unselected path strokes silently diverge.
Fix: `stroke: var(--gray-600)` / `stroke: var(--blue-soft)`.

**B2. nit — review-mode colors are raw literals**
`tokens.css:78` (`--canvas-bg: #d9dbe1`), `Canvas.tsx:448` (`rgb(c,c+1,c+4)`, `rgba(253,253,254,.9)`), `Canvas.tsx:578-579` (grain `rgba(120,124,138,…)`). Review is entirely off-token. Acceptable for a one-off material render, but add a `--review-canvas`/`--review-ink` pair in tokens.css so the doc table and code agree.

**B3. nit — canvas/WebGL contexts can't read CSS vars, so blues are re-hard-coded**
`PaperScanDialog.tsx:185` (`ctx.strokeStyle = '#2c65ff'`), `Viewer3D.tsx:51,119,122,137` (`'#f6f7f9'`, `'#2c65ff'`, `'#8e929f'`), `Viewer3D.tsx:109` (`'#9aa0ab'` — *not* any token; sits between gray-400 and gray-500).
Fix: export a small `tokens.ts` (`export const BLUE = '#2c65ff' …`) sourced from the same values, and use it in both files; either tokenize `#9aa0ab` or pick `--gray-400`.

*(Not violations: `svgExport.ts:14-18` — those colors are mandated by the Origin cut-encoding spec in the doc itself.)*

---

## C. Internal consistency (same thing styled differently in different places)

**C1. minor — three different "section title" styles**
- `.ss-section-title` 14px/500 gray-700 (`components.css:157-162`) — used in 3D Carve ("model", "carving", "bit", "outputs", "layers")
- `.shape-creator__label` 14px/500 gray-700 (`app.css:920-929`) — Make Shape ("Shapes", "Templates")
- `.pp-group__title` **12px/600** gray-800 (`paper.css:214-219`) — Paper Scan ("Photo", "Paper size", "Ink"…)

Paper Scan's headings are visibly smaller/bolder than 3D Carve's, so the two dialogs don't read as one product.
Fix: delete `.pp-group__title` and use `.ss-section-title` in PaperScanDialog.

**C2. minor — the two feature dialogs' side panels are built differently**
Carve3D: `ss-dialog__side c3d-side` flat 360px column (`carve3d.css:3-5`). Paper: `ss-dialog__side pp-side ss-panel` (`PaperScanDialog.tsx:737`) — `ss-panel` adds its own 13/16px padding, 1px border and 12px radius *inside* the padded sidebar, producing a double-padded, rounded panel that Carve3D doesn't have. Same product should use the same sidebar anatomy.
Fix: drop `ss-panel` from the paper aside (keep `ss-dialog__side pp-side`), matching Carve3D.

**C3. minor — labels/section headers ignore the lowercase convention in Paper Scan**
Doc: panel labels are lowercase. `.ss-label` enforces `text-transform: lowercase`, but Paper's `.pp-range-head` ("Sensitivity", "Threshold offset", "Edge margin", "Min blob", `paper.css:238-244`) and `.pp-group__title` are Title Case with no transform; Carve3D authors its titles lowercase by hand ("model", "bit"). Case convention therefore varies by dialog.
Fix: add `text-transform: lowercase` to `.pp-range-head span`/`.pp-group__title` (or the shared class after C1), matching `.ss-label`.

**C4. minor — three different "close" icons with three stroke weights**
Real `IconClose` is 1.75 stroke (`icons.tsx:57`). Carve3D inlines its own X at **1.8** (`Carve3DDialog.tsx:415-417`), Paper inlines one at **2** (`PaperScanDialog.tsx:950-952`), and Carve3D's header inlines a cube at **1.6** (`Carve3DDialog.tsx:218-221`) although `Ic.IconCube` (1.75) exists. Paper also inlines upload/scan-frame icons at 1.6–2.0 (`PaperScanDialog.tsx:628,664,685`). Side by side, the dialog ✕s and the editor ✕ don't match.
Fix: use `Ic.IconClose` / `Ic.IconCube`; add a scan-frame icon to `icons.tsx` if needed.

**C5. minor — `.ss-btn--primary` sets `font-weight: 400` (`components.css:98`)**
Doc: "labels and buttons are 500". Every other button is 500; primary CTAs (Place Text, Add to Design, Apply, Next) are 400, so the most prominent buttons are the *lightest* text in the UI.
Fix: delete the `font-weight: 400` override (inherit 500).

**C6. minor — duplicated checkbox-row style**
`.check-row` (`app.css:894-904`) and `.c3d-check` (`carve3d.css:72-83`) are pixel-identical (13px, gray-800, gap 8, blue accent). Already drifting (one adds `margin: 0` to the input).
Fix: keep one shared class (`check-row`) and use it in Carve3D.

**C7. nit — icon size drift for identical roles**
Recenter/zoom buttons use 18px glyphs in a 40px button (`Chrome.tsx:150`) while Undo/Redo/Rail use 24px in 40px (`Chrome.tsx:54,59,103…`); chevrons are 16px (mode tab, `Chrome.tsx:167`) vs 18px (cut-type, recent, `Panels.tsx:313`, `AppMenu.tsx:75`). Pick one size per role (chrome 24, inline-chevron 16 or 18 — not both).

**C8. nit — extra font weights outside the doc's 400/500**
`.ss-badge` 600 (`components.css:326`), `.pp-step__num` 600 (`paper.css:38`). Doc allows 400/500 only. Either measure 600 in Studio or drop to 500.

**C9. nit — dead CSS classes / tokens**
- `ui-round--sm` is applied at `Chrome.tsx:141` but defined nowhere — the class does nothing (the button silently renders 40px). Either define it (32px round) or remove it and use 24px icons per C7.
- `.pp-footer-note` (`paper.css:274-278`) is never used.
- Unused tokens: `--blue-070`, `--blue-tint`, `--hover-fill`, `--radius-xs`, `--radius-md` (`tokens.css:20-39`).
- Unused icon exports: `IconSearch`, `IconMinus`, `IconCamera`, `IconRadius`, `IconRotate`, `IconEye`, `IconEyeOff`, `IconFolder` (`icons.tsx`).
- `mode-*` on the viewport (`Canvas.tsx:565`) and `rv-shape`/`cv-overlay`/`icon` class names have no CSS rules — dead hooks.

---

## D. Icons: off-grid / unclear paths

**D1. minor — `src/ui/icons.tsx:31-39` — `IconDraw` is muddled at 24px and half-pixel off-grid**
Three problems: (1) the polyline endpoints `(14, 7.5)` and `(8, 17)` miss their node-square centers `(14.5, 7.5)` and `(8, 17.5)` by 0.5px; (2) the stray diagonal `M14 15.5 19 20.5` runs through the *middle* of the pencil body (the body quad spans (16.5,15)-(18.5,17)-(15,20.5)-(13,18.5)), reading as a strike-through rather than a tip separator; (3) it stacks a sketch polyline + 3 node squares + a pencil — too much for 24px.
Fix: snap line ends to `(14.5, 7.5)`/`(8, 17.5)`; move the tip line parallel to the short edge near the tip, e.g. `M14.2 17.2l2.3 2.3` (or delete it); consider dropping the node squares to 2.

**D2. nit — `icons.tsx:82` — `IconHelp` question-mark dot nearly invisible**
`<circle cx="12" cy="18" r=".6" strokeWidth={1.5}>` renders a ~2px blob detached from the glyph's optical center. Use `r={1.25}` fill-only (like `cv-center`) for a crisp dot.

*(Checked the rest at 24px/1.75: mirror, duplicate, cut-type, mode, boolean, and template icons are on-grid and read cleanly; `TemplateIcon` auto-fits real template geometry, so tile icons are guaranteed consistent with placed shapes — good.)*

---

## E. Things verified as correct

- **Tokens match the doc exactly**: all 15 color tokens (`tokens.css:6-29`), selected fill `rgba(184,202,255,.5)`, bbox `rgba(44,101,255,.4)` 1px, dimension labels 13.5px blue on `rgba(253,253,254,.75)`, snap-red guides, cut-green plan colors, white dashed (5,10) 1.25px plan centre-line.
- **Typography skeleton**: IBM Plex Sans (+Condensed) actually loaded via @fontsource (`main.tsx:3-7`); 14px base, 16px menu items, 15px hover labels, 12/11px adorns/labels, 19px menu file name; mode tabs 14px/500/.5px/uppercase; panel labels 11px/400/lowercase; panel header 14px/500/lowercase #56575d.
- **Layout chrome**: logo 40px at (15,15); file name 16px/500 with click-to-rename; undo/redo stacked under logo; rail vertically centred at left:15 with 40px `#edeef2` buttons and blue hover + right label; recenter + mode switcher top-right; track `#f6f7f9` radius 13/h40 with white 2px `#dfe1e7` radius-12 selected tab; dark `#2a2b2d` bottom action bar with above-labels and stacked mirror/duplicate; help button bottom-right; 42px reference button above the 188px `#edeef2` radius-12 parameter panel with W/H + lock, Radius (+), Rotation A°, 3×3 anchor picker.
- **App menu**: 357px, white upper / `#edeef2` lower, "GO TO" 11px uppercase, 16px/500 items, divider, yellow export badge present.
- **Make Shape popover**: white radius-12 card; six 40px `#edeef2` round basic shapes (exact doc list); fourteen 48px `#e2eaff` radius-8 blue template tiles matching the doc's 14 templates by id and name; new shapes default to 1in (`shapeFactory.ts:62-80`).
- **Plan mode theming**: canvas `#3f4145`, track `#0a0a0b`, selected tab `#2a2b2d`, panel `#0a0a0b` radius 12, inputs `#2a2b2d`, labels `#dfe1e7` — all via the `.theme--plan` token overrides (`tokens.css:61-75`); cut-type select with the doc's five options; depth stepper with "unset"; offset field; bit presets ⅛/¼/½ (+mm) and bit icon; translucent green tool-width band.
- **Text dialog**: full-screen white, "Edit Text" header, centered "Insert Text" placeholder, blue "Place Text" + round cancel, font picker.
- **Review mode**: track switches to `#8e929f`; wood-grain stripes + blurred overlay present.
- **Settings popover** contents: Units IN/MM seg, Smart Alignment, Position, Origin Anchor — all four doc items.

**Suggested fix order**: C1/C2/C4 (make the two dialogs one product) → A1–A3 (canvas stroke widths + tooltip radius, cheapest visible wins) → B1 → A4/A5/A9 → the nits.
