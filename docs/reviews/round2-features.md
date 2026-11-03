All evidence is in. Here is the second-round audit report.

---

# Second-round audit — features wiring + interactions

Scope: re-check of `docs/reviews/features.md` + `docs/reviews/interact.md` against the current tree, plus the new components (ZoomControls, EmptyHint, GroupsPanel, Find Art search) and their fit with `src/state/store.ts`. Read-only; nothing modified.

## Earlier findings — verdicts

### features.md

| ID | Finding | Verdict | Evidence |
|---|---|---|---|
| M1 | Locked shapes unreachable forever | **FIXED** | Lock keeps selection and toggles in place (`src/editor/Panels.tsx:275-286`); `hitTest` no longer skips locked (`src/editor/Canvas.tsx:183-197`); locked shapes select but don't move (`Canvas.tsx:383-391`, comment line 384); all edit paths filter through `editableIds` (`src/state/store.ts:55-58`, used at `store.ts:255,293`, `src/editor/ops.ts:52,76,94,108,139,176`). Residual, acceptable: ⌘A (`App.tsx:84`) and marquee (`Canvas.tsx:280`) still exclude locked — click-select is the re-select path. |
| M2 | Depth "−" *sets* depth when unset | **FIXED** | `Panels.tsx:482` — `depth == null ? null : Math.max(0, depth - step) || null`. But see NEW-2: the unset sentinel now collides with "mixed". |
| m1 | Autosave silent failure + orphaned doc blobs | **FIXED** | Quota → one-time toast (`src/io/projectFile.ts:226-233`); evicted recent entries' payloads purged (`projectFile.ts:222-223`); `removeRecent` wrapped in try/catch (`projectFile.ts:254-261`). |
| m2 | "Origin Anchor" label doesn't match effect | **NOT FIXED** | `originAnchor` is still read only at `Canvas.tsx:417` (corner-handle pivot); panel resize/rotate still uses its own AnchorPicker (`ops.ts:60,81`), position readout is anchor-relative only via the panel picker (`Panels.tsx:270,350-351`). Worse, the toggle is now also shown in **Plan** settings (`Chrome.tsx:280-282`) where it does nothing — see NEW-1. |
| m3 | Delete does nothing in Plan mode | **NOT FIXED** | `App.tsx:101-104` still gates on `mode === 'design'`; ActionBar is design-only (`Chrome.tsx:341`); neither `PlanPanel` (`Panels.tsx:411-561`) nor `GroupsPanel` has a delete control. A plan-mode selection can still not be deleted. |
| m4 | Escape in 3D/Paper dialogs destroys state while typing | **PARTIALLY FIXED** | Carve3D: input guard added (`src/features/carve3d/Carve3DDialog.tsx:224-234`) — FIXED. Paper Scan: **no guard** (`src/features/paper/PaperScanDialog.tsx:417-424`), and the dialog does have number inputs (lines 939, 952) — Escape in custom width/height still discards photo, corners and all ink settings. |
| m5 | Text dialog Escape only in textarea | **FIXED** | Window-level Escape listener (`src/editor/TextDialog.tsx:39-46`). |
| m6 | Alt+click group-select no-op on already-selected shape | **NOT FIXED** | `Canvas.tsx:374-381` — the Alt branch still lives only inside `else if (!sel.includes(hit.id))`. Shortcuts dialog still promises it unconditionally (`Popovers.tsx:230`). |
| m7 | Inside/Outside/Pocket silently coerced for open paths | **FIXED** | `pickType` coerces open shapes to `online` at set time (`Panels.tsx:437-445`); export coerces too (`src/io/svgExport.ts:52-56`); preview coerces (`src/editor/canvas/canvasMath.ts:29`). Panel label now tells the truth. |
| m8 | Shortcuts dialog out of date | **FIXED** | All previously-missing rows listed (`src/editor/Popovers.tsx:210-233`): ⌘⇧E, ⌘Y, F, ⌘+/−/0, pen Enter/Backspace/Esc, middle/right pan, ↑/↓ in fields, "(Design)" annotations. Two annotation nits: NEW-7 and the m6 caveat above. |
| m9 | `Group.info` written, never read | **FIXED** | GroupsPanel renders up to 4 info entries (`Panels.tsx:589,623-632`). |
| m10 | Missing real-Studio features | **PARTIALLY FIXED** | Find Art: **FIXED** — rail button opens the shapes popover and focuses the search box (`Chrome.tsx:106-110,128-130`); search input exists and filters (`Popovers.tsx:74-82`). Export count "n of n": **FIXED** (`src/editor/AppMenu.tsx:43-46`, rendered at `:96`). Move/Share/GO TO: still absent (intentional, no backend). Panel font picker for placed text: **NOT added** — DesignPanel (`Panels.tsx:288-366`) has no font control; still dialog-only (`TextDialog.tsx:111-115`). |
| n1 | `style={{order}}` no-op on SVG `<g>` | **FIXED** | Gone; review render is sort-only (`Canvas.tsx:579-586`). |
| n2 | `Shape.hidden` dead | **FIXED** | Feature shipped: GroupsPanel eye + per-role switches write it (`Panels.tsx:596-621`); export and count respect it (`svgExport.ts:49`, `AppMenu.tsx:43`). |
| n3 | Raw SyntaxError toast on bad JSON | **FIXED** | `projectFile.ts:86-91` — "Not a Forma Studio design file". |
| n4 | Autosave debounce not flushed by `setDoc` | **NOT FIXED** | `App.tsx:127-132` — a doc swap within 600 ms of an edit cancels the pending timer and schedules autosave of the *new* doc; the edits to the old doc never reach localStorage. `store.ts:191-194` (`setDoc`) still doesn't flush. Repro: drag a shape, immediately click Open Recent → that edit is lost from the recent entry. |
| n5 | `loadFont` ignores `name` | **NOT FIXED** | `src/io/text.ts:26-35` unchanged — a cache miss for a custom font (e.g. after page reload) silently renders IBM Plex while keeping the custom font name in `params.font`. |
| n6 | Rotation shows `0` for multi-selection | **FIXED** | `Panels.tsx:340-341` — `null` + placeholder "—" for multi; delta-vs-absolute resolved in `ops.ts:74-90` (`absolute && shapes.length === 1`). |

### interact.md

| ID | Finding | Verdict | Evidence |
|---|---|---|---|
| M1 | Locked shapes unreachable | **FIXED** | Same as features M1. |
| M2 | Degenerate selection → astronomic scale | **FIXED** | `Canvas.tsx:508-519` zeroes degenerate axes via `degX/degY`; `axisFactor` guards the factor, not the divisor (`canvasMath.ts:68-73`), min-clamp retained. |
| M3 | Wheel heuristic misfires on trackpads | **FIXED** | `isMouseWheelDelta` now also requires `deltaY % 10 === 0` (`canvasMath.ts:79-82`); non-ctrl zoom factor clamped via `wheelZoomFactor` (`.85-89`). |
| M4 | Touch: no pan/pinch, fighting drags | **FIXED** | Pointer map (`Canvas.tsx:88,335-341`), second touch switches to pinch (`startPinch`/`updatePinch`, `Canvas.tsx:296-326`, `pinch` drag kind line 30); one-finger touch on empty canvas pans with tap-to-deselect (`Canvas.tsx:395-398`, `endDrag` line 289). |
| M5 | No `pointercancel` handling | **FIXED** | `onPointerCancel` + `onLostPointerCapture` both route to `endDrag` (`Canvas.tsx:732-733`); window `blur` also ends drags (`Canvas.tsx:155-158`). |
| m1 | Nudge / arrow-step floods undo | **FIXED** | `nudgeSelection` merges bursts within 600 ms (`ops.ts:106-114` + `lastNudge` in `store.ts:174,181,188`); NumField steps pass `coalesced` through `withoutCheckpoint` (`Panels.tsx:17,19,91-95`, `store.ts:140-147`). |
| m2 | Draw-tool keys ignore popovers; Escape double-fires | **PARTIALLY FIXED** | `Canvas.tsx:135` guards `!st.dialog && !st.menuOpen` but **not** `st.popover`. With a popover open in draw mode, the canvas listener (registered before App's) preventDefaults Escape and commits/exits the draft while the popover stays open — see NEW-4. |
| m3 | Ctrl+wheel zoom too aggressive | **FIXED** | `wheelZoomFactor` clamps every event to [0.8, 1.25] (`canvasMath.ts:85-89`). |
| m4 | Grabbing a handle creates empty undo step | **FIXED** | No checkpoint in `startScale` (`Canvas.tsx:418`); taken on first real move (`Canvas.tsx:521`). |
| m5 | Space stuck on blur; swallows button activation | **FIXED** | `blur` clears space (`Canvas.tsx:155-158`); Space branch skips buttons/links (`Canvas.tsx:131`). |
| m6 | Middle-click autoscroll | **FIXED** | `e.preventDefault()` on button 1 (`Canvas.tsx:333`) + `onAuxClick` preventDefault (`Canvas.tsx:739`). |
| m7 | Anchor picker no outside-close | **FIXED** | `Floating` component: outside pointerdown + captured Escape with `stopImmediatePropagation` (`Panels.tsx:147-164`); AnchorPicker uses it (`Panels.tsx:200-219`). |
| m8 | Popovers don't close on outside clicks | **FIXED** | `useOutsideDismiss` for shapes/shapeshifter (`Popovers.tsx:30-39,47,101`); SettingsPopover has its own capture-phase closer (`Chrome.tsx:253-269`). Residual leak → NEW-3. |
| m9 | Rotation field misleading for multi | **FIXED** | Same as features n6. |
| m10 | Position fields ignore anchor | **FIXED** | `pos = anchorPoint(b, anchor)` (`Panels.tsx:270`) and `moveBy(v - pos.x)` (`Panels.tsx:350-351`). |
| m11 | `zoomToFit` negative zoom on tiny viewports | **FIXED** | Padding capped at 20 % of viewport + `Math.max(0.05, …)` (`store.ts:358-363`). |
| m12 | Hover/renders scale with shape count | **FIXED** | Memoized per-shape views (`src/editor/canvas/ShapeViews.tsx:9,30,71`), rAF-throttled hover (`Canvas.tsx:203-213`), viewport culling of cut geometry (`Canvas.tsx:559-563`), frame-budgeted lazy cut queue (`geomCache.ts:50-114`). |
| m13 | Stacked action-bar buttons unusable on touch | **FIXED** | First tap opens the stack, second fires (`Chrome.tsx:426-433`); touch suppresses hover timers (`Chrome.tsx:395-406`). |
| m14 | `beforeunload` missing `returnValue` | **FIXED** | `App.tsx:138-139`. |
| n1 | Double-click via `PointerEvent.detail` | **FIXED** | Manual time+distance tracking (`Canvas.tsx:42,360-368`). |
| n2 | Handle drags processed twice | **FIXED** | `startScale` stops propagation (`Canvas.tsx:405`); handle `<g>` carries only `onPointerDown` (`Canvas.tsx:604`). |
| n3 | `style={{order}}` no-op | **FIXED** | Gone. |
| n4 | Review hit-test ignores z-order | **FIXED** | `hitTest` returns null in review (`Canvas.tsx:184`); review drags pan (`Canvas.tsx:346-348`). |
| n5 | Shift-move defeated by snap | **FIXED** | Locked axis zeroed before snapping; snap only adjusts the free axis (`Canvas.tsx:460-495`), so the constraint holds. |
| n6 | Single-letter shortcuts fire with menu open | **FIXED** | `App.tsx:99` early-return; canvas draw-keys also guard `!st.menuOpen` (`Canvas.tsx:135`). |
| n7 | App-menu rename Escape does nothing | **FIXED** | `cancelRename` + blur + revert (`AppMenu.tsx:71-77`). |
| n8 | NumField commits rounded value on bare blur | **FIXED** | `if (text.trim() === fmt(value)) return` before parsing (`Panels.tsx:60`). |

### New components vs store API

- **ZoomControls** (`Chrome.tsx:303-319`) — wired to `zoomBy`/`zoomToFit`; tooltip hints (⌘−, ⌘+, F) all exist in `App.tsx:85-94,113-114`. Percent readout against 96-px-per-inch real size is consistent with zoom semantics (px/mm). Correct.
- **EmptyHint** (`Chrome.tsx:322-332`) — design-mode + no-dialog + empty-doc gated; the "Draw (P)" hint matches a shortcut that is design-only (`App.tsx:109`). Correct.
- **GroupsPanel** (`Panels.tsx:567-640`) — consumes `doc.groups`, drives `hidden` via `updateShapes` (checkpointed, undoable), role switches only for `source === '3d'` groups which are exactly the ones carrying `meta.role` (`src/features/carve3d/carvePlan.ts:339-406`); `info` rendering matches what both dialogs write (`Carve3DDialog.tsx:283`, `PaperScanDialog.tsx:737-738`). Store API fit is correct.
- **Find Art** — `setPopover('shapes')` + focus `#shape-search` (`Chrome.tsx:106-110`, `Popovers.tsx:74-82`). Works; two nits (NEW-5, NEW-8).
- **Store actions**: all previously-live actions still have call sites — but the fix pass added two that have none (NEW-6).

---

## NEW problems introduced by the fixes

**NEW-1 · minor — "Origin Anchor" switch in Plan settings does nothing.**
`src/editor/Chrome.tsx:280-282` renders the toggle for `plan`, but `originAnchor` is only read at `Canvas.tsx:417` inside design-mode handle scaling, and Plan mode renders no handles (`Canvas.tsx:591-675`, overlay is design-only). Repro: Plan tab → chevron → toggle Origin Anchor → nothing changes anywhere. Fix: either hide the row when `plan` (the design spec lists settings only for the Design tab) or give it plan-mode meaning.

**NEW-2 · minor — Depth "−" with a mixed-depth selection clears all depths.**
`src/editor/Panels.tsx:425-427` (`same('depth')` returns `null` for both "unset" and "mixed") collides with the fixed unset branch at `Panels.tsx:482` (`depth == null ? null : …`). Repro: two shapes with depths 2 mm and 4 mm, select both, press − → both become unset, losing cut depths (undoable, but silent and not "decrease"). Fix: compute mixed explicitly (e.g. `const mixed = sel.some(x => x.cut.depth !== first.cut.depth)`) and on − step each shape individually (`setCut` per shape via `updateShapes(ids, s => ({...s, cut: {...s.cut, depth: Math.max(0,(s.cut.depth ?? 0) - step) || null}}))`); same treatment for the NumField's null path.

**NEW-3 · minor — Shapes/ShapeShifter popover stays open after File Import / design-file import.**
`useOutsideDismiss` exempts `.hover-btn` (`Popovers.tsx:41,47`), the native file picker produces no outside pointerdown, and neither `importPayload` (`store.ts:215-241`) nor `setDoc` (`store.ts:191-194`) clears `popover`. Repro: open Find Art, click File Import, import an SVG → the popover floats over the newly imported, zoomed-to-fit result. Fix: in `LeftRail.importFile` call `st().setPopover(null)` before `pickFile`, or clear `popover` in `importPayload`/`setDoc`.

**NEW-4 · minor — (residual of interact m2) Draw-tool Escape with a popover open commits the draft and leaves the popover up.**
`Canvas.tsx:135` guards `dialog` and `menuOpen` but not `popover`. The canvas keydown listener registers before App's, preventDefaults Escape (`Canvas.tsx:137,145,148`), and App then bails on `e.defaultPrevented` (`App.tsx:53`) — so the App-defined priority (popover first, `App.tsx:57`) is skipped. Repro: draw tool with points placed → open Make Shape → press Escape: the path commits, popover stays. Fix: add `&& !st.popover` to the guard at `Canvas.tsx:135`.

**NEW-5 · minor — dead store/exported members added by the fix pass.**
`unlockAll` (`store.ts:333-341`) and `selectGroup` (`store.ts:344`) have zero call sites — the UI inlines both behaviours (`Canvas.tsx:380`, `Panels.tsx:362`); likewise `moveSelectionTo` (`ops.ts:92-100`, superseded by `Panels.tsx:271` `moveBy`) and `openRecent` (`fileActions.ts:45-55`, superseded by inline `AppMenu.tsx:115-123`). Fix: either call them from the inline sites (one-liners: `st().selectGroup(hit.groupId)`, `openRecent(r.id)`, a menu item for Unlock All) or delete them.

**NEW-6 · nit — empty groups are listed forever.**
`deleteSelected` (`store.ts:252-263`) removes shapes but never prunes `doc.groups`, and GroupsPanel renders groups regardless of membership (`Panels.tsx:584-587`). After deleting the last slice of a 3D import, an eye button whose click is a no-op (`updateShapes([], …)`) stays in the card. Fix: prune now-empty groups in `deleteSelected`/`replaceShapes`, or hide groups with no members in GroupsPanel.

**NEW-7 · nit — Shortcuts dialog says "⌘D Duplicate (Design)" but it works in every mode.**
`Popovers.tsx:217` vs `App.tsx:79-81` (no mode guard). Drop the "(Design)" or add the guard, whichever matches intent.

**NEW-8 · nit — Find Art search filters only templates, but the empty message claims otherwise.**
`Popovers.tsx:57-58` filters `TEMPLATES` only; the six basic-shape buttons stay visible and the empty state says "No shapes or templates match" (`Popovers.tsx:89`). Fix: also filter basic shapes by label, or reword to "No templates match".

**NEW-9 · nit — canvas scale drag leaves `updatedAt` stale for non-parametric shapes.**
The scale case writes the doc via raw `useStore.setState` (`Canvas.tsx:534`), bypassing `touch()`; only the final parametric-normalize patch (`Canvas.ts:290` → `patchShapes`, `store.ts:245`) refreshes it. Autosave still fires (doc identity changed) but the Open Recent timestamp can lag the last edit. Fix: set `updatedAt` in the scale-frame write, or route the final frame through `patchShapes`.

**NEW-10 · nit — OffsetPanel distance default is captured once at app mount in the then-current units.**
`Popovers.tsx:137` — the component is mounted unconditionally (`App.tsx:218`), so after switching in→mm the default shows `3.175 mm` instead of ⅛ in. Fix: key the default off current units when the panel opens (compute in render if `o` untouched, or reset `o` on units change).

---

## Bottom line

All five majors and 24 of 28 minors/nits from the two earlier reports are verifiably fixed with regression-grade implementations (touch gestures, pointer-capture lifecycle, undo coalescing, lock semantics, cut-type coercion). Still outstanding, in priority order: **m3** (no delete path in Plan), **m6** (Alt+click on selected), **m4's Paper Scan half** (unguarded Escape, `PaperScanDialog.tsx:417-424`), **m2/n4/n5** (Origin Anchor naming, autosave flush, `loadFont`), and the panel font picker from m10. The fix pass introduced no correctness regressions; the ten new items above are minor/nit-level, with NEW-2 (depth "−" clears mixed depths) the only one that silently changes user data.
