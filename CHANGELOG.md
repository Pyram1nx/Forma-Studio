# Changelog

Each `## <version>` section becomes the release notes shown in the app's update prompt.

## Unreleased

- **Snapping** now behaves like Shaper Studio's. A moved selection lines up its left, right and centre
  (not just the anchor) with other shapes' bounding box and centre lines within 12 px, and grid lines
  within 6 px; whichever is nearest wins on each axis. Edge handles snap the dragged edge while
  resizing (corners don't), the draw tool snaps its points the same way, Shift locks a move to an
  axis or a 45° diagonal, and Ctrl (or Alt) holds snapping off. Guides now run between the two
  shapes. The Points, Midpoints, Edges and Origin targets stay as extra snap targets.

- **Files** are now saved as `.forma`. Older `.formastudio` and `.shaperstudio` files still open. The desktop app identifier is now `app.formastudio.desktop`.

- **Polygon** now starts as a pentagon on a 0.5 in circle with the size fields
  linked, always sits on a flat edge, and the side count is a − / + stepper (3 and up) that keeps
  the shape's stretch. Rounding a corner keeps the bounding box in place, the radius "+" opens the
  field with the presets list beside the panel, and the box joint channel under the pocket is now
  1.2 × the bit diameter deep.
- **Compass template** is now a rose of 2n facets with spokes to every
  tip and notch, tips rounded to the exact outer diameter, and limits between the
  outer diameter, inner diameter, tip radius and point count. The star centre stays put when the
  point count changes. Dragging a shape no longer snaps to every tiny step along a curve, so
  lining a shape up with a rounded one (or the origin) is easy.
- **Bit gallery** (route `/bits`, the home window's Bits page, and the studio menu): Shaper's full
  20-bit catalogue with product photos, specs and product links. Mark which bits you own
  (with quantity and your own notes), add bits that are not in the catalogue, and ask "what bit
  should I use?" for a cut. The Plan panel's bit library and 3D Carve suggest from the bits you
  own. Ownership is kept in this browser; photos load from Shaper's site (run
  `node scripts/fetch-bit-images.mjs` to keep local copies for offline use).
- **3D Carve**: models built from many touching pieces or with very fine detail (terrain and
  terraced exports, for example) no longer get cut too deep or lose parts of their outline. The
  model slicer now follows the mesh's own edges instead of snapping nearby points together, and
  heights that land exactly on a flat face no longer leave slivers.

## 0.1.0

- First desktop release for macOS, Windows and Linux.
- Save and open `.shaperstudio` files with the native file dialogs.
- Checks for updates when the app opens and asks before installing. Release notes are one click away.
- Optional accounts: create an account or sign in with email and password.
