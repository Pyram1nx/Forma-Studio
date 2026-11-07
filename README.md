# Forma Studio

A lightweight, fully client-side design studio for the Shaper Origin, inspired by
Shaper Tools' Studio (Design / Plan / Review modes), with two extras:

- **3D Carve:** drop in an STL / OBJ / GLB model, pick a bit from the gallery, and
  it slices the model into layers. For each layer it calculates the cut depth and the
  bit-compensated offset, so V-bits, ball noses and bull noses leave the model's
  surface instead of gouging it.
- **Paper Scan:** photograph a sketch on paper, pick the paper size, and the
  page is flattened and the pen lines are vectorised into **real-size** paths.

Everything runs on your computer. Designs, presets and your bit kit are saved in the
browser (they survive closing it), and as `.forma` files whenever you choose. The editor
works fully without an account; an optional account (email and password) syncs designs and
settings across devices.

## Features

| Area | What you get |
| --- | --- |
| Design | Pen tool, Make Shape (circle, ellipse, rectangle, rounded rect, polygon, triangle + 14 templates), text to outlines (IBM Plex Sans or your own font), SVG import (hidden layers skipped, local `<use>` resolved, unsupported content reported), move / scale / rotate / anchor, smart-alignment snapping, Offset (open paths are stroked), ShapeShifter (union, subtract, intersect, exclude), mirror, duplicate (copies get their own groups), z-order, lock / unlock all. Units (in or mm) are set per design in the settings menu, and new designs start in the last unit you chose. |
| Plan | Cut type (on line, guide, inside, pocket, outside), depth, offset, bit diameter (⅛ ¼ ½ presets + bit library: owned bits first, with a suggestion for the current cut and a link into the bit gallery), live tool-width preview. The cut path can be shown for every shape (Cut path display setting), drawn as marching cut paths. Units are also switchable here. |
| Review | Depth-shaded material preview |
| Files | Autosave + Open Recent (browser storage), **Save / Open `.forma` files on your computer** (writes back to the same file in Chrome / Edge), Export SVG for Origin. New, Open, Import and Open Recent ask before discarding unsaved changes. |
| 3D Carve | STL/OBJ/GLB/GLTF, units + up-axis + fit-to-size, Shaper's real catalogue of 20 bits (`docs/research/shaper-bits.json`, including the 3 that come in the box), step-down / layers / stock / margin, per-layer contour (guide) + compensated toolpath (on line) + pocket region (pocket), optional through-cut. Stage bits default to what you own in the **bit gallery** |
| Bits | **Bit gallery** (route `/bits`, the home window, the studio menu): every Shaper bit with photo, specs and product link, plus your own additions. Mark what you own (quantity, notes) and Plan and 3D Carve suggest the best bit for each cut from the ones you have. Kept in this browser; product photos stay on Shaper's CDN (`scripts/fetch-bit-images.mjs` fetches local, git-ignored copies) |
| Paper Scan | Camera or photo upload, automatic paper corner detection with draggable corners, A3/A4/A5/Letter/Legal/Tabloid/custom, lighting correction, adaptive ink threshold, centerline or outline tracing, stroke-width estimate |

### How cuts are encoded in the SVG

Exported SVGs are real size (`width`/`height` in mm) and use Shaper's conventions.
Cut type is encoded both as fill/stroke colour and as `shaper:cutType`, and depth is
written as `shaper:cutDepth`. Guides are blue strokes.

Cut offsets are **baked into the exported geometry**: outside grows the shape by the
offset, inside and pocket shrink it, and on-line moves closed paths outward. The
exported path is the path the bit edge follows, so no offset attribute is needed. The
3D Carve toolpaths follow the same rule, since they are the exact path the bit centre
must take for the chosen bit.

### 3D Carve maths (short version)

The model is sliced at sampled depths. For a layer with tip depth `dᵢ`, `S(d)` is the
slice of the model that must remain at depth `d`, and `reach(h)` is the bit's cutting
radius at height `h` above its tip. The bit centre must stay outside everything that
is still standing above it. Taking every sampled depth `δ ≤ dᵢ`:

```
Forbiddenᵢ = ⋃ over sampled δ ≤ dᵢ of  offset(S(δ), reach(dᵢ − δ))
```

For a flat end mill this reduces to "offset by the radius". For a V-bit or ball nose
the flank is accounted for at every sampled height in the layer. The boundary of
`Forbiddenᵢ` is exported as an *on-line* toolpath. The pocket region is

```
pocketᵢ = stock − offset(Forbiddenᵢ, −r_top) − S(dᵢ)
```

where `r_top` is the bit's reach at the top of the layer, so the pocket never removes
material that has to stay. Layers are cut shallow first.

## Develop

Requires Node 22 (see `.nvmrc`).

```bash
npm install
npm run dev
```

```bash
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build locally
npm test           # unit tests (vitest): geometry, editor state, SVG and project file I/O
```

## Desktop app (macOS, Windows, Linux)

The editor also ships as a native app built with [Tauri](https://tauri.app). The Rust
shell lives in `src-tauri/`.

```bash
npm install
npm run tauri dev       # run the desktop app with hot reload
npm run tauri build     # build an installer for this machine
```

Building needs Rust 1.90 or newer (`rustup update stable`). On Linux, install the
WebKitGTK packages listed in the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

### Home window

The desktop app opens to a home window. It lists the designs saved on this device
(newest first, with a thumbnail), starts new designs, and has the account page. Opening
a design, or using **Designs** in the studio's app menu, shows the studio in its own
window. A design that is already open in the studio is switched to in place. In a
browser the same screens are pages: `/` is the home page, `/account` the account and saved
designs, and `/studio` the editor.

### Releases and updates

- Pushing a tag such as `v0.2.0` runs `.github/workflows/release.yml`. It builds macOS
  (Apple Silicon and Intel), Windows and Linux, and publishes a GitHub Release.
- The release notes come from the matching `## <version>` section of `CHANGELOG.md`.
- The app checks the latest release every time it opens. If there is a newer version it
  shows the release notes on request and asks before downloading and installing.
- Update packages are signed with a Tauri updater key. The private key is stored only as
  the `TAURI_SIGNING_PRIVATE_KEY` repository secret. The public key is in
  `src-tauri/tauri.conf.json`.
- Before a release, bump `version` in `src-tauri/tauri.conf.json` and `package.json`,
  and add a changelog section.

### Saving and accounts

Designs are saved in the browser's IndexedDB as you work; presets, the bit kit and other
settings in localStorage. Each browser keeps a space for "no account" and one per account:
signing in shows the account's designs, signing out shows this device's own designs again,
and nothing mixes. Signed in, a background sync keeps devices in step and never drops a
version when a design changed on two devices. See `src/storage/` and
[docs/deployment.md](docs/deployment.md).

Accounts are optional. A build has them when `VITE_API_URL` is set (`/api` on Vercel, where
`api/` and `server/` run as Vercel Functions on Neon Postgres). Without it, accounts are off
and everything else works. To try accounts locally, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Project layout

```
src/
  model/        document types, factories
  geometry/     clipper offset/booleans, SVG path parser, primitives, templates
  state/        zustand store (document, selection, view, undo/redo)
  editor/       canvas, chrome, panels, popovers, text dialog, app menu
  io/           save/open/autosave, SVG export/import (sanitised), text outlines
  storage/      local storage spaces (IndexedDB designs, settings) and account sync
  features/
    carve3d/    3D model loading, slicer, bit gallery, carve planner
    paper/      paper detection, homography, ink mask, centerline/outline tracing
  home/         home window: saved designs and account page
  account/      sign in, account page, sync status
  styles/       design tokens + component styles
src-tauri/      Tauri desktop shell (Rust): window, native file dialogs, updater
api/            Vercel Functions (thin wrappers around server/app.js)
server/         accounts and sync API: routing, auth, Postgres (Neon) and in-memory stores
docs/research/  design notes
```

Forma Studio is an independent project and is not affiliated with, endorsed by, or sponsored by Shaper Tools. "Shaper" and "Shaper Origin" are trademarks of Shaper Tools.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Fork the repository, make
your change on a branch, and open a pull request. Releases are made by the maintainer only.

## Licence

[AGPL-3.0](LICENSE). You are free to use, modify and share it, but anyone who distributes it or runs a modified version as a hosted service must publish their complete source under the same license. For a commercial license without those terms, contact the author.
