# Shaper Studio — design research notes

Captured from studio.shapertools.com (logged in, 1440×900 viewport). These are the
measurements and tokens the Forma Studio UI is built from.

## Typography
- UI font: **IBM Plex Sans** (fallback sans-serif). Condensed variant used in a few spots.
- Sizes: 14px (most common), 16px (menu items), 15px (hover labels), 12px/11px (panel labels, adornments), 19px (menu file name).
- Weights: 400 / 500 (labels and buttons are 500).
- Mode tabs: 14px, 500, `letter-spacing: .5px`, `text-transform: uppercase`.
- Panel labels: 11px, 400, `letter-spacing: 1%`, lowercase.
- Panel header (object type): 14px, 500, .5px, lowercase, color `#56575d`.

## Color tokens
| token | value | use |
|---|---|---|
| white | `#fdfdfe` | canvas bg (design), buttons, inputs |
| gray-50 | `#f6f7f9` | mode switcher track (design) |
| gray-100 | `#edeef2` | parameter panel bg, menu lower section, round icon buttons |
| gray-200 | `#dfe1e7` | borders |
| gray-300 | `#b9bcc6` | |
| gray-400 | `#8e929f` | mode track (review) |
| gray-500 | `#72757e` | secondary labels ("Go To") |
| gray-600 | `#56575d` | panel text |
| gray-700 | `#3f4145` | plan canvas bg |
| gray-800 | `#2a2b2d` | dark buttons (bottom action bar), plan inputs |
| gray-900 | `#0a0a0b` | primary text, plan panel bg |
| blue-050 | `#2c65ff` | primary / selection |
| blue-060 | `#0546f6` | selected path stroke |
| blue-light | `#e2eaff` | template tiles |
| cut green | `#1be09e` | plan mode cut path / tool width |
| snap red | `#ff274e` | snapping guides, badges |
| export yellow | `#efdd3a` | export count badge |

Selected path in design: fill `rgba(184,202,255,.5)`, stroke `#0546f6` 3.5px.
Unselected closed path: fill `rgba(180,185,203,.18)`, stroke dark gray 1px.
Bounding box: `rgba(44,101,255,.4)` 1px, corner handles `#2c65ff` 3px L-brackets, dimension labels 13.5px `#2c65ff` on `rgba(253,253,254,.75)`.

## Layout
- Top-left: 40px black circle logo launcher (15,15), file name 16px/500 next to it (click to rename).
- Under logo: Undo / Redo round 40px white buttons (hover shows label to the right).
- Left rail (vertically centred): 40px round `#edeef2` buttons — Find Art, Draw, Make Shape, Add Text, File Import. Hover/active: blue circle + label to the right (15px/500).
- Top-right: Recenter / Zoom-to-selection round button, then the mode switcher: track `#f6f7f9`, radius 13px, height 40; selected tab white, 2px `#dfe1e7` border, radius 12, icon + label + chevron (opens settings: Units IN/MM, Smart Alignment, Position, Origin Anchor).
- Bottom-right: help "?" button.
- Bottom-centre (when selection): row of 40px dark (`#2a2b2d`) round buttons — Offset, ShapeShifter, Mirror (stacked V/H), Duplicate (stacked), Delete. Labels appear above on hover.
- Right: parameter panel (188px wide, `#edeef2`, radius 12, 1px `#dfe1e7` border) — object type header, Size (W/H inputs + lock aspect ratio), Radius (+), Rotation (A °), Anchor 3×3 picker. Above it: a 42px round "reference path" button.

## App menu (slide-in from left, 357px)
White upper section: "STUDIO" wordmark, file name, Rename / Move / Export (n of n) / Share Design, divider, Duplicate Design / New Design / Open Recent.
Gray lower section (`#edeef2`): "GO TO" 11px uppercase, Trace / My Files / ShaperHub / Forum / Shop / Account, user avatar + email + Sign Out.

## Make Shape popover
White card, radius 12, border. "Shapes": circle, ellipse, rectangle, rounded rect, polygon, triangle (40px round `#edeef2`). "Templates" (48px `#e2eaff` radius 8, blue icons): barbell, bowtie, box joint basic/pro, compass, corner round, dogbone rectangle, heart, keyhole, linear holes, linear rectangles, radial holes, snowflake, star. New shapes default to 1.000 in.

## Text tool
Full-screen white dialog: "Edit Text" header, large centred placeholder "Insert Text", blue "Place Text" button + round cancel. Text is converted to outlines; panel shows a font picker.

## Plan mode (dark)
- Canvas `#3f4145`, mode track `#0a0a0b`, selected tab `#2a2b2d`.
- The selected PLAN tab also has a chevron: dark settings popover with Units, Cut Path Display, Origin Anchor (see `plan-review-spec.md`).
- Panel `#0a0a0b` radius 12: Cut Type (select: On Line, Guide, Inside, Pocket, Outside), Depth stepper (− value +, "unset"), Offset (in), Bit Diameter (D, in) + presets 1/8, 1/4, 1/2 and a bit icon.
- Inputs `#2a2b2d`, labels `#dfe1e7`.
- Selected path: base path `#1be09e` 2.5px (Studio rule `.selected path.basePath { stroke-width: 2.5px }`); tool width band = translucent green stroke of bit diameter; cut path = white dashed (5,10) 1.25px, **except On Line, whose cut path is black 1.5px**.
- Full per-cut-type rules (hover, Cut Path Display, marching ants, pocket ticks) are in `plan-review-spec.md`, which supersedes this section.
- Depth tooltip: black tag, radius 4px (measured), arrow-down icon + value (bold 14px).

## Review mode
Light gray (`#8e929f` track) over a `#dfe1e7` canvas with soft wood grain. Cuts with **no depth** render as a pale overlay; cuts **with** a depth get darker per 0.1″ of depth (7 levels) with an inner shadow — see `plan-review-spec.md`.

## SVG cut encoding
Shaper Origin reads `xmlns:shaper="http://www.shapertools.com/namespaces/shaper"` attributes on paths:
`shaper:cutType` (online|outside|inside|pocket|guide), `shaper:cutDepth` (e.g. `6.35mm`). Fill/stroke colour also implies cut type
(black fill = exterior, white fill + black stroke = interior, black stroke no fill = on-line, grey = pocket, blue = guide).
The tool offset can't be relied on from the SVG, so Forma Studio generates explicit offset paths instead.
