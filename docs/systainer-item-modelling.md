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
6. **Split what is too thin to bevel.** A neck/stem narrower than ~2× the bevel (the hex key's sleeve)
   is cut out of the outline and modelled separately (a `lathe`). Close the cut with a straight V/line
   so the rounding has a clean edge; a rectangular notch leaves "wing" artefacts.
7. **Match widths at the tip.** A ball end uses the hex's circumradius (`2 / cos 30°`) so the footprint
   width is unchanged to the tip.
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
