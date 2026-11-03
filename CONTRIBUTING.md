# Contributing to Forma Studio

Thanks for helping. Bug reports, ideas, documentation fixes and code are all welcome.

## Reporting bugs and suggesting features

Open an [issue](https://github.com/Pyram1nx/Forma-Studio/issues/new/choose). For a bug, say what you did, what happened, and what you expected. A screenshot or an SVG that reproduces it helps a lot.

## Setting up

You need Node.js 22 (see `.nvmrc`).

```bash
git clone https://github.com/<your-username>/Forma-Studio.git
cd Forma-Studio
npm ci
npm run dev
```

The studio opens at `/studio`, the account view at `/account`, and the home page at `/`. The desktop app needs Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/); build it with `npm run tauri dev`.

## Sending a change

1. Fork the repository and create a branch from `main`.
2. Make your change. Keep it focused: one fix or feature per pull request.
3. Run the checks:
   ```bash
   npm run lint
   npm test
   npm run build
   ```
4. Add or update tests in `tests/` when you change behavior.
5. Open a pull request against `main` and fill in the template.

The checks also run on every pull request. A change is merged once they pass and the maintainer has reviewed it. Nobody pushes to `main` directly.

## Style

Follow the code around your change: naming, comments and structure. Prefer small, readable functions, and keep comments for the why, not the what.

## Releases

Releases and deployments are made by the maintainer only. A pull request cannot publish a release, and the release workflow refuses to run for anyone else.

## Conduct

Be kind and assume good faith. See the [Code of Conduct](CODE_OF_CONDUCT.md).

By contributing you agree that your work is released under the [GNU AGPL-3.0](LICENSE).
