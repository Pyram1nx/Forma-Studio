# Modelling a Systainer catalogue item from a product photo

Learned on the 4 mm T-handle hex key (`shaperHexKey` in `src/features/systainer/catalog.ts`). Follow this
whenever a catalogue item is restyled from a shop photo.

## The rules

1. **The traced outline is law.** Outlines in `hubProfiles.ts` come from community ShaperHub inserts and
   are what users actually cut. A restyle must keep the footprint: build the 3D shape *on* that outline
   (`profile(OUTLINE, inset)`), never invent a new one from the photo. The photo decides styling only:
   cross-section, materials, sleeves/collars, tips, print. Never edit the data in `hubProfiles.ts`.
2. **Pockets derive from the model** (`layout.ts` projects every non-`deco` mesh). So the model's
   silhouette *is* the pocket. Anything printed or decorative must set `mesh.userData.deco = true`.
3. **Read the photo by measurement, not by eye.** Open the image in the browser pane (same origin as the
   image, so canvas readback works), threshold on **alpha** (product PNGs have transparent
   backgrounds; plain luminance reads the whole background as "dark"), and take per-column / per-row
   extents. Calibrate scale from a known dimension (the key's 217 mm length; the 4 mm shaft then
   measures 8 px, which confirms it). Zoom with CSS `width: 4×` on the `<img>`; the `zoom` screenshot
   action does not magnify.
4. **Straight edges stay straight.** Traced outlines have flat sides and flat end caps with corner
   fillets. Do not round them into capsules/pills. If the user says "the ends are wrong", they mean the
   plan view differs from the outline.
5. **Round sections without changing the plan view.** `extrudeOutline`/`ExtrudeGeometry` bevels round
   *every* edge, ends included, and collapse on narrow necks. To get a round section with flat caps use
   `roundedBar` (catalog.ts): slice the outline at each x, make the section an ellipse as wide as the
   outline at that x. Sides are exactly the outline; ends stay flat.
6. **Split what is too thin to bevel, then blend it back.** A neck/stem narrower than ~2× the bevel (the
   hex key's sleeve) is modelled separately. Don't cut the neck out of the outline with a polygon: the
   cut's corners show as creases across the rounded bar. Instead give `roundedBar` smooth `edges` through
   the middle (the key's V becomes a parabola over |x| < 8) and grow the stem into the bar with
   `filletedSleeve` (a rolling fillet per half-plane, tucked just under the bar's surface). Where the
   visible model then departs from the trace (a dropped bump, a smoothed kink), add the traced outline
   as a hidden `footprint` so the pocket stays the SVG path.
7. **Match widths at the tip.** The key's tip is a knob cut from the hex itself (`hexKnob`): four
   loop cuts over one across-corners width, the end cap and the third loop scaled down on their own
   centres. The full rings keep the footprint width unchanged right up to the groove.
8. **Materials:** handle/sleeve use `gloss` (new, models.ts), shafts `black`. Add a `MatName` only when
   an existing one cannot match the photo.
9. **Print/decals** are textures on a plane (`keyPrint`): canvas → `CanvasTexture`, `MeshBasicMaterial`
   with `polygonOffset`, `depthWrite: false`, `deco`. Guard `typeof document === 'undefined'`. Keep text
   inside the plane (a glyph run that overflows is clipped). Shear the plane to follow bent parts.

## Pitfalls that actually happened

- **Inside-out geometry.** Hand-built `BufferGeometry` needs counter-clockwise winding seen from
  outside. Three culls back faces, so wrong winding renders as seeing through the top into the inside.
  After writing any custom mesh, run the numeric check (below), do not trust a top-down render, which
  looks fine either way.
- **Rotation sign:** `rotZ(φ)` maps +y to (−sin φ, cos φ); mirrored arms need opposite signs.
- **`lathe()` axis:** the profile is (r, z) with the axis on z; `rx = 90°` sends local +z to world −y.
- **`M()` takes a `MatName`**, not a material. For custom materials build the `THREE.Mesh` yourself.
- **`sed` on macOS** needs `-i ''`; prefer the Edit tool.
- **Dev server:** use the already-running one (see CLAUDE.md). Importing modules directly from the page
  (`await import('/src/features/systainer/catalog.ts')`, `three` from `/node_modules/.vite/deps/three.js`)
  lets you build an item and render it to a canvas on the landing page, where no dialog covers it.
  Dragging a tile into the dialog adds it to the (unsaved) insert; close the dialog without adding.

## Verification checklist

1. `npx tsc --noEmit -p .`
2. Render top-down, orthographic, on white, with the original outline drawn as a red `LineLoop` above
   the model: the model must sit inside the line everywhere.
3. Numeric winding check: for every triangle of each hand-built mesh, `normal · (centroid − meshCentre)`
   must be ≥ 0 (expect 0 bad of N). Only valid for roughly convex meshes (a handle, a sleeve): L-shaped
   bars and stepped lathes report false positives, so for those judge by an oblique render instead.
4. Render an oblique view to confirm rounded sections, flat caps, and no see-through faces.
5. Compare to the photo side by side (silhouette, print placement, materials).
6. Do not commit unless asked.

## Adding interior features (learned on the angle fence and support arm)

- **Interior holes and slots are safe** for the pocket: without `islands` the layout keeps outer
  boundaries only. Cut them with `boolean('difference', outline, holes)` before `extrudeOutline`.
  Features on the *edge* (the fence's square notch) change the footprint: skip them and say so, unless the user asks for them (they did for the fence).
- **Place photo features in outline coordinates** by matching landmarks (both bar ends, the junction
  of the sector edge) to get a rotation + scale, then convert each feature with that transform. Check
  handedness (pure rotation vs mirror) and check the result by rendering the model rotated to the
  photo's angle next to it.
- **White-on-white photos:** a plain threshold fails. Draw the image to a canvas and stretch levels
  (`out = (v - 238) * 18`) to see the plate edges, holes and shadows. Local image files open in the pane
  only as static snapshots; the same product image on the Shaper CDN can be scripted.
- **Arcs:** to sweep a slot between three points, find the circle through them, then choose the
  direction by testing whether the middle point lies within the counter-clockwise sweep.
- **Separate items stay separate:** parts shown in a photo that are their own catalogue items (the
  Lock Screw knob on the fence) are not folded into the item being restyled.
- **Different colours on faces vs sides:** `ExtrudeGeometry` (so `extrudeOutline`) has two material
  groups: 0 = the flat top/bottom faces, 1 = side walls *and the bevel*. Build the mesh yourself with a
  material array, e.g. `new THREE.Mesh(extrudeOutline(...), [mat('white'), mat('edgeblack')])` (angle
  fence). Hole and slot walls get the side colour too. `M()` only takes one material.
- **Tiny printed marks** (the fence's dot) are `deco` meshes a hair above the face, so they don't enter
  the pocket.

## Re-tracing an outline from a ShaperHub share (the hold-down clamp)

When a user says an outline is wrong and points at a Hub project:

- **Don't download the SVG** (the zip needs the user's login token, which we never touch). The share
  page's embedded data (`window.__remixContext`) lists each file's `blob` hash; the public thumbnail
  service renders it: `https://thumbnails.shapercdn.com/blobs/<blob>/<base64 of {"h":"1800","w":"1800","fit":"contain","bg":"ffffff"}>`.
  Open it as an image (fetch from another origin is blocked) and read pixels with a canvas there.
- **Scale from the insert itself:** `fit: contain` makes the insert outline fill the image width, so
  `px per mm = image width / insert width` (387.5 mm for SYS 1). Check it against a known part: the clamp
  lever came out 147.2 mm, the knob pocket 51 mm. The Hub's depth labels ("20MM", "28MM") are pocket
  depths, not sizes.
- **Trace by faces, not strokes:** treat grey pixels as strokes (blue label text is not grey), label the
  white regions between them by flood fill, pick the faces belonging to one part, union them, close small
  gaps, dilate by half a stroke, then chain pixel edges into a loop, resample, smooth, and
  Douglas-Peucker (≈0.3 px). Overlap between parts splits faces; join them back by x-range or seed.
- **Overlay to verify:** draw the traced loops on the crop. Rectangles and rounded squares are better
  stored as clean parametric shapes of the measured size than as ±0.2 mm staircase noise.
- **Outlines that hold no visible geometry** (the clamp's bolt channel, the knob's square): add them with
  `footprint(contours, z0, z1)` (catalog.ts), an invisible `hidden` mesh that counts for pockets and rest
  levels but is not drawn. Offsetting z0 between parts (lever at 8, knob at 0) makes the stepped pocket
  depths come out as the Hub labels them. Check with `posed()` + `pocketSteps()` from the page.
- **Assemblies keep their real axes.** Read what the photo shows *attached to what*: the clamp's knob is
  screwed onto the bolt, so lying down it shares the bolt's axis (along the plan's y) rather than lying
  flat beside it. The Hub's stepped pocket depths follow from that: set the pose `sink` so the pocket
  floors land where the Hub labels them (lever 20 mm), and make the invisible footprints symmetric about
  the shared axis so the flipped pose gets the same pockets. Measure part sizes from the photo against a
  known dimension (the 147.2 mm lever gave 1.9 px/mm: knob Ø47 × 18, sleeve Ø22 × 18).

## Thickness from a second Hub view (the support arm)

> The support arm's visible model is now the owner's Blender model (see "Using the owner's Blender
> model" below). The notes here about building the arm in code (slot, T-slot, block, knob) still hold
> as technique for other procedural items. Its pockets are now cut from that model too (the owner asked
> for them to fit it); the Hub's standing depths, bar 10 mm and post 50 mm, are kept.

When one Hub insert stores an item lying and another stores it standing, the two pockets are two
orthogonal views of the same part. Keep the lying outline as the plan; take the thickness (and any end
rounding) from the standing pocket. Measure it on the thumbnail render as above (stroke centres per
row). The arm came out 187.4 × 20.8 mm with r 4.9 ends, not the 12.5 mm the 13 mm lying pocket suggested.

- **Intersection of two extrusions:** extrude the lying outline with z slices (`extrudeOutline(..., steps)`),
  then `roundPlanEnds` clamps each vertex's x by the standing view's corner at that z. Normals via
  `toCreasedNormals`.
- **Watch the rest levels.** Pocket steps start at every downward face. Round parts at mid-thickness
  (the arm's pegs) add levels part-way up. The deepest step then takes the bottom few mm's silhouette,
  which is rounded in at the ends, so the lying pocket came out 0.4 mm short at each end. Parts that sit
  inside a hidden footprint are `deco`; let the footprint stand for them. Check `posed().rests` and the
  step extents against the outline from the page.
- **Hidden pane:** if the browser pane is hidden, screenshots come back blank. POST
  `canvas.toDataURL()` to a one-shot local receiver and read the PNG instead.
- **When the Hub pocket isn't the model's silhouette** (the arm's standing pocket: a bar 10 mm deep plus a
  wider square rectangle over the post 50 mm deep), give the pose `pockets`: the traced shapes in the
  posed frame, each with its floor as a height above the item's lowest point. `evaluate` uses them in place
  of the derived steps, and the shapes stay as the Hub draws them. Put the default sink where the item
  rests on its floor (the bar on 10 mm), so a deeper shape clears the rest of the item.
- **A feature that only one view shows** (the arm's through-slot and keyhole, seen only from above when it
  stands): build that part from the view that shows it. The bar is its plan (with the slot as a hole)
  extruded across its height, then trimmed to the outline's slanted far end. When the visible parts don't
  fill the outline any more (a narrower post block, round pins and collar), make them all `deco` and let
  one hidden footprint of the whole outline be the pocket.
- **Looking up an outline's edge at a height:** use only the edges near the end you are trimming. A long,
  nearly level edge (the bar's underside rises 0.01 mm over 150 mm) also crosses the line, far from the
  end, and the bar's bottom face got stretched across the slot. Raycast through openings to check.
- **Top-down photo of a standing item:** calibrate on the bar's width and its far end, not on raised
  parts. The post block and pin stand ~17 mm higher, and perspective makes them look bigger and further out.
- **A profile that changes through the height** (the arm's T-slot: a 9 mm slot in a 5 mm top lip, over a
  channel as wide as the keyhole): extrude one plan per layer and overlap the layers by two bevels. Then
  each layer's bevelled rim sits behind the other's straight wall, with no groove and no coplanar faces.
- **Concentric corners:** when a pocket's corner should follow the outer corner (the keyhole and the
  bar's far end), keep every wall the same thickness and put the outer radius at inner radius + wall,
  on the same centre. If the outline's end leans, stretch the plan along x per height rather than
  clipping it, so the arcs stay concentric.
- **Joining two parts built along different axes** (the arm's post block, extruded across the thickness
  from the side outline, and its bar, extruded up from the plan): clip the block's outline a stub past
  the joint (past the outline's fillets), and start the bar one bevel inside that stub. The block's side
  faces stay flat to stub − bevel, where the bar's side walls take over; the block's top wall runs to
  the stub's end, where the bar's inset top cap takes over. No seam, no groove. Read the outline before
  inventing parts: what looked like a notch for a collar was the block's upper face, 3.6 mm proud, with
  its own fillet into the bar.
- **Rounding edges seen from a third view** (the block's top edges, seen end-on): squash the top r of
  the part towards the corner rather than clamping vertices onto it. Clamping piles vertices from the
  side outline's own corners onto one line, and the slivers shade as a sawtooth. Keep r no bigger than
  that outline corner: past it the rounding runs onto a flat face with no vertices to bend.

## Using the owner's Blender model (the caliper, the support arm)

When the owner has modelled an item in Blender (`~/Documents/Blender/*.blend`), use it as the visible
model and keep the traced cut-outs:

- Export with a headless script in `scripts/` (`export-caliper-blend.py`, `export-support-arm-blend.py`)
  to a generated `*Mesh.ts` (Int16 positions in 0.01 mm, Uint16 indices, a part class per triangle).
  Export the visible objects only, evaluated (booleans and modifiers applied); skip hidden cutters and
  helper boxes. A Workbench render with the hidden objects' `hide_render` set shows what is visible.
- The .blend is metres displayed as mm: multiply by 1000. Work out its axes from the parts (pins,
  slot, which way is up) and map them into the outline's frame with a proper rotation (no mirror).
- Place it on the traced outline: centre its length and height on the outline's, then search a small
  shift that minimises the side silhouette falling outside the outline (rasterise both; the arm fit to
  3.6 mm² outside). Bake the offsets into the export script.
- By default make every visible part `deco` and keep the hidden traced footprint as the pocket, so the
  cut-outs stay the Hub's, and report where the model is bigger than the pocket.
- When the owner asks for the pockets to fit the model (the support arm), drop the hidden footprint
  and give each pose `pockets` built from the mesh (`armPose` in catalog.ts): turn and centre the
  triangles as `posed` does, take the body's `silhouette` (silhouette.ts) below each step's height
  plus the fit room (0.2 mm a side, about the Hub's own), and close concave corners tighter than a
  cutter (+1.5 then −1.5 mm). Don't follow turned hardware: the owner wants the pins and the knob in
  loose rounded boxes (0.8 mm room, 2 mm corners), the knob's box running level with the post's top
  and down to the bar's top edge so the notches beside it are cut out. Skip a box above the foam. The
  arm's model is tapered (21.4 mm thick at the bar's top edge, 24.2 mm at the post end), so lying it
  sits flush at 24.2 mm; standing, the post pocket is everything below the bar's underside and the bar
  pocket everything below the foam. Holes seen from above (the T-slot channel) are cut solid.
  Build such pockets lazily (a getter), so the catalogue doesn't union thousands of triangles on load.
