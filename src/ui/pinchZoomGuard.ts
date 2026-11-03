// Keeps pinch-zoom inside the studio canvases. iOS Safari ignores user-scalable=no, so a
// two-finger pinch anywhere else would zoom the whole page. The canvases handle their own
// pinch through pointer events (touch-action: none), so they are left alone.
const CANVAS_SELECTOR = '.ui-viewport, .modeview__canvas, .c3d-viewer, .pp-main'

const inCanvas = (target: EventTarget | null) => target instanceof Element && target.closest(CANVAS_SELECTOR) !== null

export function installPinchZoomGuard() {
  // Safari's own pinch gesture. Blocking it stops page zoom; pointer events still fire.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend'] as const) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false })
  }
  // Two-finger moves outside the canvases would otherwise zoom the page.
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1 && !inCanvas(e.target)) e.preventDefault()
    },
    { passive: false },
  )
}
