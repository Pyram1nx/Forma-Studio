# Notes for agents

## Dev server and browser

- **Do not start new localhost dev servers** (no `npm run dev`, `vite`, or `preview_start` that spawns one). A dev server is already running and open in the browser.
- To check or verify changes, use the browser (the built-in browser pane) and navigate to the already-open localhost tab. Use `tabs_context` to find it, then reload it if HMR hasn't picked up the change.
- If no localhost tab or server is reachable, tell the user instead of launching another one.

## Systainer catalogue models

- Restyling a catalogue item from a product photo? Read `docs/systainer-item-modelling.md` first. Key rule: the traced outline in `hubProfiles.ts` is never changed; the photo only drives styling.
