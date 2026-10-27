# Box joint basic / pro — how Shaper Studio does it

Source: studio.shapertools.com (live app, 2026-10-22). The generators were read from Studio's
own bundle (`assets/vendor-*.js`, modules `boxJointBasic` and `boxJointIrregular`) and checked
against shapes placed in a live design. Studio builds both with maker.js, **y-up**, with the
board ("stock") occupying `x ∈ [0, W]`, `y ∈ [0, T]`. Our canvas is y-down, so flip y.

## Template ids, labels, parameters

| Studio id | label | ours |
|---|---|---|
| `boxJointBasic` | box joint basic | `boxJointBasic` |
| `boxJointIrregular` | box joint pro | `boxJointPro` |

Panel order (both): **side** (toggle, icon-only bold "A" / "B", aria "side A"/"side B"),
**width** (W), **thickness** (T), **bit diameter** (B), **pin count** (− n + stepper, step 1),
[pro only: **pin factor** — a slider, min −1, max 1, step 0.05, a tick mark at 0, no number shown],
**glue gap** (G), **guides** (basic) / **show guides** (pro) — icon toggle (eye / eye-off),
then the common **rotation** (A) and **anchor** rows.

Defaults:

| param | in | mm (basic) | mm (pro) |
|---|---|---|---|
| side | A | A | A |
| width | 10 | 200 | 200 |
| thickness | 0.75 | 20 | 19.05 |
| bit diameter | 0.25 | 6 | 6 |
| pin count | 5 | 5 | 5 |
| pin factor (pro) | −0.75 | | |
| glue gap | 0 | 0 | 0 |
| guides | show | show | show |
| anchor | stock-top-left | | |

## Validation (Studio clamps, it does not reject)

`BIT_TOL = 1.1`, `MIN_SIZE = 0.005` (in the doc's units), `EPS = 1e-6`.

- width, thickness: `[MIN_SIZE, ∞)`
- bit diameter: `[MIN_SIZE, max(thickness, MIN_SIZE)]` ("Bit diameter must be ≤ material thickness.")
- pin count: integer, `[2, max(2, floor(W / (bit·1.1)))]`
- ratio (pro): `[-1, 1]`
- glue gap basic: `[0, W/N − EPS]`
- glue gap pro: `N−1 ≤ 0 ? 0 : [0, max(0, (W − bit·1.1·N)/(N−1) − EPS)]`

When a value breaks a rule it is replaced by the bound it broke (min if below, max if above;
non-integer pin count → rounded). Then the whole set is re-validated.

## Box joint basic geometry (Studio `buildPocketModel$1`)

```
bit = B; r = bit/2; p = W/N; g = glueGap/2
removed(k) = side A ? k odd : k even           // pins the pocket cuts
for each removed k:
   x0 = k·p − g ; x1 = x0 + p + glueGap        // widened by the glue gap, centred on the pin
   rect y from  −r  to  T + r                  // y-up: r below board bottom, r above board top
   points pushed: [x0,−r] [x0,T+r] [x1,T+r] [x1,−r]
then from the last point go down 2·bit, then left across the full span (first x0 → last x1),
closing back up to the first point.
fillet every right turn (convex corners) with radius r. Concave corners stay sharp.
cutType inside, toolDia = bit diameter.
```

So in y-down (board top at y = 0): removed pins rise r above the board top, the floor between
them sits r below the board bottom, and a channel 2·bit deep runs under the whole span.
Verified on canvas: W 254, T 19.05, bit 8 → pin tops 4 above board top, floor 4 below board
bottom, return edge 16 below the floor, corner radius 4.

## Box joint pro geometry (Studio `computeSegments` + `buildPocketModel`)

```
N = round(pinCount); minW = bit·1.1
nOdd = ceil(N/2)   // pins with even index (0,2,4…) — Studio calls these "odd pins"
nEven = floor(N/2) // pins with odd index
widths(W):
  if ratio <= 0:
     t = ratio + 1
     odd  = minW + t·(W/N − minW)
     even = E + t·(W/N − E)     where E = nEven>0 ? (W − nOdd·minW)/nEven : minW
  else:
     t = ratio
     odd  = W/N + t·(O − W/N)   where O = nOdd>0 ? (W − nEven·minW)/nOdd : minW
     even = W/N + t·(minW − W/N)
nominal width of pin k = k even ? odd : even;  nominal boundaries = running sum from 0.
```
(ratio −1 → index-even pins are minW wide; ratio 0 → all equal W/N; ratio +1 → index-odd pins are minW.)

Pocket: same as basic, but each removed pin k is centred on its nominal segment:
`c = b[k] + w[k]/2`, half = `(w[k] + glueGap)/2`, x0 = c − half, x1 = c + half. Same y levels,
same 2·bit channel, same fillets. Removed = side A ? k odd : k even.

Check (defaults, inches): W 10, N 5, bit .25, ratio −.75 → odd .70625, even 3.940625. Side A
pocket spans x .70625 → 9.29375, pin tops .125 above board, floor .125 below, bottom 2·bit below floor.

## Guides (both)

Only when guides = show (hide → no guide paths at all). One per *kept* pin of this side:
`guidePin(k) = side B ? k odd : k even` (the complement of `removed`).
Each guide = rectangle (pin width × T, sitting exactly on the board, y 0..T) + a letter
(the side's letter, "A" or "B") drawn as an open polyline (closing point repeated):

```
A (50×80): [0,0] [7.5,30] [42.5,30] [50,0] [30,80] [20,80] [0,0]
B (50×80): [0,0] [30,0] [48,10] [48,30] [30,40] [0,40] [30,40] [45,50] [45,70] [30,80] [0,80] [0,0]
scale s = min(pinWidth, T) / 80 · 0.5   → letter height = min(pinWidth, T)/2
placed at (pinWidth/2 − 25s, T/2 − 40s) inside the pin rectangle (centred). y-up.
```
Basic: pin width p = W/N, x = k·p. Pro: nominal widths/boundaries (no glue gap).
Guides cutType "guide".

## Anchor

Five preset anchors on the *stock* (board) rectangle, not on the shape's bounds:
`stock-bottom-left (0,0)`, `stock-top-left (0,T)`, `stock-top-right (W,T)`,
`stock-bottom-right (W,0)`, `stock-center (W/2,T/2)`. Default `stock-top-left`.
Shape Anchor mode shows only those five points for these templates.

## Scaling with the handles (`getParametersAfterScale`)

Bit diameter never scales. Uniform (|dx − dy| < .001): width, thickness, glue gap × d.
Otherwise width × dx, thickness × dy, glue gap × dx. Then re-validate (clamp) and regenerate —
the result is always a clean template, never a stretched one.

## Studio object model (for reference)

One object (`shapes_plus` tool) with paths `geometry` (inside, toolDia = bit) and `guides`,
`guides-1`… (each closed guide chain is its own path, cutType guide).
