// Grey-level morphology on 8-bit images: separable square min / max filters
// (monotonic deque, O(n) whatever the radius) and the closing built from them.
// Shared by sheet detection (erase pen strokes before looking for edges) and
// ink extraction (paper background that follows hard shadow edges).

/**
 * Sliding min / max over the window [i - r, i + r] (clipped) along one line of
 * `src`, starting at `off` with `stride`. Monotonic deque, O(n).
 */
function minMax1D(src: Uint8Array, dst: Uint8Array, off: number, stride: number, n: number, r: number, max: boolean, dq: Int32Array) {
  let head = 0
  let tail = 0
  let next = 0
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + r)
    while (next <= hi) {
      const v = src[off + next * stride]
      if (max) while (tail > head && src[off + dq[tail - 1] * stride] <= v) tail--
      else while (tail > head && src[off + dq[tail - 1] * stride] >= v) tail--
      dq[tail++] = next++
    }
    while (dq[head] < i - r) head++
    dst[off + i * stride] = src[off + dq[head] * stride]
  }
}

/** Grey-level dilation (`max`) or erosion with a (2r+1)² square; separable, O(n). */
export function morph(src: Uint8Array, w: number, h: number, r: number, max: boolean): Uint8Array {
  const tmp = new Uint8Array(w * h)
  const out = new Uint8Array(w * h)
  const dq = new Int32Array(Math.max(w, h))
  for (let y = 0; y < h; y++) minMax1D(src, tmp, y * w, 1, w, r, max, dq)
  for (let x = 0; x < w; x++) minMax1D(tmp, out, x, w, h, r, max, dq)
  return out
}

/**
 * Grey-level closing: erases dark features thinner than 2r+1 px — pen strokes,
 * handwriting — while a convex bright shape (the sheet) keeps its exact edges.
 */
export function closeGray(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return morph(morph(src, w, h, r, true), w, h, r, false)
}
