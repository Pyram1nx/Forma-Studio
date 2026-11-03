# Plan & Review mode — behaviour measured in Shaper Studio (2026-10-18)

Measured by setting each cut type on real shapes in studio.shapertools.com and
reading the rendered DOM/computed styles. This is the spec Forma Studio must match.

## Plan mode settings popover (click the selected PLAN tab)
Dark popover under the mode switcher: bg `#2a2b2d`, 2px border `#0a0a0b`, radius 12,
width ≈287px. Rows (14px/500 white titles):
- **Units** — IN | MM segmented toggle (`.mode-menu--toggle`, radius 8, inset 1px `#56575d` ring; active segment blue).
- **Cut Path Display** — switch. ON = draw the tool-width band and cut path for *every* shape, not just the selected one.
- **Origin Anchor** — switch (with ⓘ).
Switch: 48×24 pill; off bg `#3f4145` + inset 1px white ring; on bg `#2d3f70` + inset 1px `#d5e0ff` ring.
The Design-mode popover has Units, Smart Alignment, Position, Origin Anchor (light theme).
Units must be switchable from both popovers and apply everywhere.

## Plan mode shape rendering
Canvas `#3f4145`. Every shape group: no fill. Base path stroke 1.25px non-scaling.

| cut type | base path (unselected) | tool band (`toolWidth`, stroke = bit Ø in world units) | cut path (`cutPath`) |
|---|---|---|---|
| outside | `#dfe1e7` | `#0a0a0b` @ opacity .45, on the offset path | white `#fdfdfe` 1.25px dash 5,10, marching ants counter-clockwise (dashoffset 0→15 over 1s, linear, infinite) |
| inside  | `#dfe1e7` | same, inside | white dash 5,10, marching **clockwise** (0→−15) |
| online  | `#dfe1e7` | same, centred on path | **black** `#0a0a0b` 1.5px dash 5,10, marching counter-clockwise |
| pocket  | `#dfe1e7`, fill transparent | filled area `#0a0a0b` @ .45 + white pattern overlay (`plan-mode_pocket_white`: small diagonal tick marks) | none |
| guide   | **blue `#2c9aff`** | hidden | hidden |

Visibility rules:
- Band + cut path are **hidden** by default for outside/inside/online/pocket.
- Shown when: the shape is **selected**, or it is **hovered** (`over-base`/`over-tool`), or **Cut Path Display** is on (`has-cut-paths`).
- Hover: band `rgba(10,10,11,.45)`, cut path visible. Pocket hover: base path `#b5f2d5`, band black .45 + pattern.
- **Selected** (outside/inside/online): base path `#1be09e` 2.5px, band stroke `#1be09e` @ opacity .3, cut path visible (white dashed, marching).
- **Selected pocket**: base path `#1be09e`, band fill+stroke `#1be09e` @ opacity .3, white tick pattern visible.
- **Selected guide**: base path `#1be09e`, nothing else.
- Shapes whose inside offset collapses (bit wider than the shape) show only their base path.
- Depth tooltip: black pill left of the selection, arrow-down + depth or "unset".

## Review mode
Background `#dfe1e7` with a wood-grain texture (ours is procedural — do not copy Shaper's PNG).
Guides are not shown. Each cut renders its swept material (`toolWidthReview*`) with a
depth class. **Depth level = clamp(ceil(depth_mm / 2.54), 1, 7)**; unset depth = level 0
(0.25 in → 3, 0.5 in → 5 measured).

| level | fill | stroke | stroke-w | shadow stroke | shadow fill | shadow sw | shadow dy |
|---|---|---|---|---|---|---|---|
| 0 | rgba(246,248,254,.3) | #fff | .25 | transparent | transparent | .264 | 0 |
| 1 | rgb(155,161,176) | rgba(255,255,255,.92) | .1 | rgba(0,0,0,.082) | rgba(255,255,255,.565) | .9 | .22 |
| 2 | rgb(144,149,162) | rgba(255,255,255,.71) | .2 | rgba(0,0,0,.125) | rgba(255,255,255,.5) | 1.2 | .35 |
| 3 | rgb(130,136,151) | rgba(255,255,255,.75) | .33 | rgba(0,0,0,.145) | rgba(255,255,255,.44) | 1.5 | .5 |
| 4 | rgb(119,124,136) | rgba(255,255,255,.7) | .33 | rgba(0,0,0,.145) | rgba(255,255,255,.396) | 1.7 | .5 |
| 5 | rgb(108,112,122) | rgba(255,255,255,.65) | .33 | rgba(0,0,0,.145) | rgba(255,255,255,.314) | 2.2 | .625 |
| 6 | rgb(96,99,108) | rgba(255,255,255,.6) | .33 | rgba(0,0,0,.145) | rgba(255,255,255,.27) | 2.6 | .75 |
| 7 | rgb(72,75,81) | rgba(255,255,255,.55) | .33 | rgba(0,0,0,.19) | rgba(255,255,255,.25) | 3 | .875 |

All strokes non-scaling, round joins. The shadow layer is drawn on top of the depth
fill, shifted by (0.1, dy) px, clipped to the swept area, giving an inner-shadow look.
Outside/online/inside: the swept band; pocket: the whole cleared region.
