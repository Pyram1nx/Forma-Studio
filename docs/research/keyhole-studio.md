# Keyhole — how Shaper Studio does it

Source: studio.shapertools.com bundle (`assets/vendor-*.js`, module `keyhole`, and the resize
interaction in `assets/index-*.js`), read 2026-11-07. Studio builds it with maker.js, **y-up**.

## Parameters

| Studio id | label | in | mm | ours |
|---|---|---|---|---|
| `slotLength` | slot length | 0.35 | 9 | `slotLength` |
| `headDiameter` | head diameter | 0.4133 | 10.5 | `headDiameter` |
| `neckDiameter` | neck diameter | 0.1969 | 5 | `slotWidth` (kept for saved designs) |

Each is clamped to `[MIN_SIZE, MAX_SIZE]` (`MIN_SIZE = 0.005` in document units). Nothing ties
them together: a neck wider than the head is allowed.

## Geometry

`Slot([0,0], [0,-slotLength], neck/2)` (round at both ends) ∪ `Circle([0,-slotLength], head/2)`.
The neck centre is the origin and the head hangs **below** it. The SVG carries a custom anchor at
(0,0), so the neck centre is the keyhole's anchor: it is placed by it and param edits keep it still.

Cuts: the outline is a **guide**; the cut is an **online** open path head centre → neck centre →
back (0.004 in / 0.1 mm short of the head), tool diameter = neck diameter, depth 0.39 (in doc
units, so 0.39 mm in mm documents — looks like a Studio bug). *Not implemented here yet: ours
is a single closed outline with the usual cut.*

## Resizing

`dragToResizeRestrictions: ['lm','rm','tm','tl','tr','bl','br']`: only the bottom-middle handle.
(The only other template with restrictions is `radialHoles`: `['lm','rm','tm','bm']`, corners only.)
With several templates selected, the hidden handles are the union of their restrictions.

`getParametersAfterScale`: `slotLength = max((slotLength + head/2) · dy − head/2, MIN_SIZE)`;
width and both diameters never change. With the default custom anchor, the resize origin is the
neck centre, `dy = 1 + Δ / (slotLength + head/2)`, so the slot grows by exactly the pointer's
travel and the neck stays put. With a preset anchor, the position scales about it like any shape.
