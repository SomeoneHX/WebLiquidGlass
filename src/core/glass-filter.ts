/**
 * SVG refraction filter for `backdrop-filter: url(#id)`.
 *
 * ## Why an SVG filter at all
 *
 * `backdrop-filter` samples whatever is painted *behind* the element, so the glass never
 * needs a copy of the wallpaper — the browser does the capture. Blur, saturation and
 * brightness map 1:1 onto CSS filter functions. Refraction does not: CSS has no
 * "shift every pixel by a vector field" primitive, so that one effect goes through an SVG
 * filter. `feDisplacementMap` reads a map where R = dx and G = dy (128 = no offset — the exact
 * zero point is 127.5; see the note at the neutral fill in `buildMap`) and shifts each pixel by
 * it.
 *
 * The map itself is generated on a canvas from the rounded-rect signed distance field —
 * the same construction as the AGSL `RoundedRectRefractionShaderString` the Android build
 * runs on API 33+, minus the SDF texture lookup.
 *
 * ## Chromatic aberration
 *
 * The AGSL dispersion shader (`RoundedRectRefractionWithDispersionShaderString`) samples
 * the backdrop 7 times along the refraction offset with spectral weights. `feDisplacementMap`
 * displaces every channel by the *same* vector, so the port bakes the spectral split into
 * three displacement maps — red `base·(1+i)`, green `base`, blue `base·(1−i)` where
 * `i = cx·cy/(hw·hh)` is the shader's `dispersionIntensity` (zero on the axes, strongest in
 * two opposite quadrants) — displaces a channel-isolated copy of the backdrop with each, and
 * re-adds the branches with `feComposite arithmetic`. Three taps instead of seven: the
 * cross-channel bleed of the middle spectral bands is dropped, which at a few px of
 * dispersion is visually indistinguishable, and white is conserved either way.
 *
 * The `chromaticAberration` uniform is a *boolean* upstream (`Lens.kt` passes a constant
 * `1f`), so the dispersion field depends only on geometry and bakes into the maps; the
 * animation knob stays `refractionAmount`, which every branch is linear in.
 *
 * ## Chromium-only
 *
 * `url()` inside `backdrop-filter` is a Chromium extension (Chrome / Edge 76+). Safari and
 * Firefox accept the declaration but paint nothing for it, so call sites must always keep a
 * plain `blur()` declaration in an *earlier* rule — see `GlassSurface.vue`. Everything else
 * the glass needs is plain CSS and works everywhere.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Room added around the element box. Displaced pixels sample outside the border box, and the
 * filter region clips anything it doesn't cover, so the region has to be larger than the
 * largest displacement we ever ask for (`max refractionAmount` in the catalog is 48 px).
 */
export const FILTER_PAD = 64

let root: SVGSVGElement | null = null
let sequence = 0

function svgRoot(): SVGSVGElement {
  if (!root) {
    root = document.createElementNS(SVG_NS, 'svg')
    root.setAttribute('width', '0')
    root.setAttribute('height', '0')
    root.setAttribute('aria-hidden', 'true')
    root.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none'
    document.body.appendChild(root)
  }
  return root
}

/* ------------------------------------------------------------------------------------------- */
/* Capability probe                                                                              */
/* ------------------------------------------------------------------------------------------- */

/**
 * `@supports (backdrop-filter: url(#x))` is not reliable: engines that parse `url()` but paint
 * nothing for it (WebKit) still report support. Feature-detecting it properly needs a paint
 * comparison, so the cheap and honest test is the engine itself — every Chromium build since
 * 76 implements it, and no other engine does.
 *
 * Memoised: `BackdropEffectScope.lens()` calls this once per frame per surface, and the answer
 * is a property of the engine, not of the call. Reading `navigator.userAgentData.brands` every
 * time showed up in the CPU profile of a plain scroll.
 */
let refractionSupported: boolean | null = null

export function isRefractionSupported(): boolean {
  if (refractionSupported !== null) return refractionSupported
  refractionSupported = detectRefractionSupport()
  return refractionSupported
}

function detectRefractionSupport(): boolean {
  if (typeof navigator === 'undefined') return false
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } })
    .userAgentData?.brands
  if (brands && brands.length > 0) {
    return brands.some((b) => /chromium|google chrome|microsoft edge|brave|opera/i.test(b.brand))
  }
  return /\b(Chrome|Chromium|Edg|OPR)\//.test(navigator.userAgent)
}

/* ------------------------------------------------------------------------------------------- */
/* Displacement map                                                                              */
/* ------------------------------------------------------------------------------------------- */

export interface RefractionSpec {
  /** Element border-box size in CSS px. */
  width: number
  height: number
  /** `[topLeft, topRight, bottomRight, bottomLeft]`, in CSS px. */
  cornerRadii: readonly number[]
  /** `refractionHeight` — how far in from the rim the bend reaches. */
  refractionHeight: number
  /** `depthEffect` — blend the centripetal direction into the gradient (Shaders.kt:117). */
  depthEffect?: boolean
  /** `chromaticAberration` — bake the spectral split, use the three-branch filter graph. */
  chromaticAberration?: boolean
}

/**
 * The `onDrawBackdrop { withTransform { scale(k, k) } }` magnification
 * (`MagnifierContent`): the captured backdrop is drawn at `k×` about the lens centre `c`,
 * i.e. each output pixel `p` samples the source at `q = c + (p − c) / k`. That is a
 * per-pixel displacement of `d(p) = q − p` — a **linear** field, which bakes into a
 * displacement map exactly like the refraction does. Chaining this map (fixed scale)
 * *before* the refraction map (animated scale) composes to `p + d_r(p) + d_zoom(p + d_r(p))`
 * — the exact original semantics of refracting the already-magnified backdrop.
 */
export interface BackdropZoom {
  /** The `scale(k, k)` factor, about the lens centre. */
  factor: number
}

/**
 * A static image composited *into* the captured backdrop before the effects chain run
 * (`additive`, alpha respected) — the CSS stand-in for the upstream "record a hidden layer
 * and sample it" pattern (the bottom tabs' accent row). `x`/`y` are element-local and cheap
 * to update per frame (the pill slides over a fixed strip); `url` only changes when the
 * strip's content does.
 */
export interface CaptureOverlay {
  url: string
  x: number
  y: number
  width: number
  height: number
}

interface MapEntry {
  url: string
  /** Largest encoded magnitude — the `feDisplacementMap` scale must be multiplied by it. */
  vmax: number
}

const mapCache = new Map<string, MapEntry>()
/**
 * Entries are keyed by `(round(width) × round(height), corner radii, round(refractionHeight),
 * flags, branch)`, and a single animated call site walks several `refractionHeight` values — a
 * Toggle press with chromatic aberration alone can want 6 geometries × 3 branches = 18 entries.
 * At 32 the cache evicted its own working set mid-gesture, so every press re-ran the whole
 * build + PNG encode instead of hitting. Raising the limit is pure caching: nothing about the
 * rendered result changes, only whether a rebuild happens. Entries are a few tens of kB each.
 */
const MAP_LIMIT = 96

/**
 * Neutral grey = "leave this pixel alone", as one 32-bit word instead of four byte writes per
 * pixel: the padded region is neutral everywhere except the thin rim band, so the whole bitmap
 * is a single `fill()` and only the band is ever overwritten. `image.data` is RGBA byte order, so
 * on a little-endian host byte 0 (R, the low byte) is 0x80 → 0xFF808080. Endianness is read once
 * rather than assumed.
 */
const NEUTRAL_WORD = (() => {
  const probe = new Uint8Array(4)
  new Uint32Array(probe.buffer)[0] = 0x01020304
  return probe[0] === 0x04 ? 0xff808080 : 0x808080ff
})()

function mapKey(spec: RefractionSpec, branch: 1 | 0 | -1): string {
  const r = spec.cornerRadii.map((v) => Math.round(v * 2) / 2).join(',')
  const flags = `${spec.depthEffect ? 1 : 0}${spec.chromaticAberration ? 1 : 0}`
  return `${Math.round(spec.width)}x${Math.round(spec.height)}|${r}|${Math.round(
    spec.refractionHeight
  )}|${flags}|${branch}`
}

/**
 * Rounded-rect SDF, negative inside. Exact while all four radii are equal, which is every
 * shape the catalog uses (a single radius, or `Capsule()`); with mixed radii it degrades to
 * a per-quadrant approximation.
 */
function sdf(
  x: number,
  y: number,
  w: number,
  h: number,
  tl: number,
  tr: number,
  br: number,
  bl: number
): number {
  const cx = w / 2
  const cy = h / 2
  const left = x < cx
  const top = y < cy
  const r = top ? (left ? tl : tr) : left ? bl : br
  const qx = Math.abs(x - cx) - (cx - r)
  const qy = Math.abs(y - cy) - (cy - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

/**
 * SDF used for the *gradient*, mirroring the shader: the corner radius there is
 * `min(radius * 1.5, min(halfSize))`. For a Capsule the two coincide; for a small radius on a
 * tall box they do not, and the bend fans out.
 */
function gradSdf(
  x: number,
  y: number,
  w: number,
  h: number,
  tl: number,
  tr: number,
  br: number,
  bl: number
): number {
  const cx = w / 2
  const cy = h / 2
  const left = x < cx
  const top = y < cy
  const r = Math.min((top ? (left ? tl : tr) : left ? bl : br) * 1.5, Math.min(cx, cy))
  const qx = Math.abs(x - cx) - (cx - r)
  const qy = Math.abs(y - cy) - (cy - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

/**
 * One reusable canvas for every map build.
 *
 * The builds used to allocate a fresh `<canvas>` each time and then encode it with
 * `toDataURL('image/png')` — a synchronous PNG encode on the main thread. Measured on a 168×152
 * bitmap (the Toggle thumb's map): ~1 ms on a warm canvas, ~7 ms on a freshly allocated one, and a
 * single press builds 18 maps, so the allocation was costing more than the encode.
 *
 * Nothing about the bitmap changes: every build fills the whole `ImageData`, `putImageData`
 * overwrites all of it (a resize clears the backing store anyway), and what reaches the filter is
 * the data URL, not the canvas element.
 */
let mapScratch: HTMLCanvasElement | null = null
/**
 * Returns the element, not the context: `ctx.canvas` is a back-reference a test double is not
 * obliged to model, and `scripts/refraction-probe.mjs` evaluates this file in Node against a stub
 * whose `getContext()` returns only `createImageData` / `putImageData`. Reaching for the element
 * we already hold keeps the core runnable outside a browser.
 */
function mapCanvas(width: number, height: number): HTMLCanvasElement {
  if (!mapScratch) mapScratch = document.createElement('canvas')
  if (mapScratch.width !== width || mapScratch.height !== height) {
    mapScratch.width = width
    mapScratch.height = height
  }
  return mapScratch
}

/**
 * One displacement-map bitmap. `branch` selects the spectral copy: `+1` red (`base·(1+i)`),
 * `0` green (`base`), `-1` blue (`base·(1−i)`). Encoded magnitudes are normalised to the
 * branch's own maximum so the 8-bit channel never clips (red/blue reach `2·base` at a sharp
 * corner); the lost factor is restored exactly by a per-branch `scale`.
 */
function buildMap(spec: RefractionSpec, branch: 1 | 0 | -1): MapEntry {
  const w = Math.max(1, Math.round(spec.width))
  const h = Math.max(1, Math.round(spec.height))
  const cw = w + FILTER_PAD * 2
  const ch = h + FILTER_PAD * 2
  const canvas = mapCanvas(cw, ch)
  const ctx = canvas.getContext('2d')
  if (!ctx) return { url: '', vmax: 1 }

  const image = ctx.createImageData(cw, ch)
  const data = image.data
  const [tl, tr, br, bl] = spec.cornerRadii
  const bezel = Math.max(0.5, spec.refractionHeight)
  const depth = spec.depthEffect ? 1 : 0
  const hw = w / 2
  const hh = h / 2
  const at = (x: number, y: number) => sdf(x, y, w, h, tl, tr, br, bl)
  const gradAt = (x: number, y: number) => gradSdf(x, y, w, h, tl, tr, br, bl)

  /** Rim pixels, collected in pass 1 and encoded in pass 2 once `vmax` is known. */
  const rim: { index: number; gx: number; gy: number; m: number }[] = []
  let vmax = 0

  // Neutral grey = "leave this pixel alone".
  //
  // The exact zero point is 127.5, not 128: `feDisplacementMap` reads the channel as
  // value/255 minus 0.5, so a uniform 128 leaves a constant +0.5 LSB on the whole map
  // (= +scale/510 px of sampling offset toward +x/+y, which reads as the lens drifting
  // up-left). It is left uncorrected on purpose.
  //
  // Measured against a linear-gradient backdrop (24 000 px averaged, ~0.02 px resolution),
  // what reaches the screen is a whole-pixel staircase, not a drift that grows with the
  // amount: 0 px up to scale 252, 1 px from 255 to 764, 2 px from 765 — and screenshots on
  // one plateau are byte-identical. A 1 px checkerboard backdrop keeps its full contrast at
  // every scale, so the offset is quantised to whole pixels with nearest-neighbour sampling
  // (Skia's raster path truncates: `srcX = x + SkScalarTruncToInt(displX)`); residue of this
  // size cannot survive. Dithering the neutral between 127 and 128 cancels the mean only
  // above scale 510 and converts an invisible whole-pixel offset into per-pixel ±1 px
  // sampling jitter — noise inside the region that is supposed to be an exact identity.
  new Uint32Array(data.buffer).fill(NEUTRAL_WORD)

  /**
   * Only the rim band is ever non-neutral, and evaluating the SDF is the expensive half of the
   * build (one `Math.hypot` per pixel, plus four more per rim pixel for the gradient). So the scan
   * walks only the rows and columns that can hold a rim pixel; the `fill()` above covers the rest.
   *
   * The bound comes from `sdf` itself. Writing `p = max(qy, 0)` and `q = max(qx, 0)`, it returns
   * `hypot(q, p) + min(max(qx,qy), 0) - r`, so a rim pixel (`-bezel <= d <= 0`) must satisfy
   * `r - bezel <= hypot(q, p) <= r`. Two consequences, and only these two are used:
   *
   *  - `p > r` → `d > 0`: the whole row is outside, and rows past the band are skipped outright
   *    (this is where most of the padding margin is discarded);
   *  - `p >= r - bezel` → the `q = 0` half satisfies the ring on its own, so the entire side is
   *    in play (`d` still lands wherever the SDF says, and the rim test below filters it);
   *  - otherwise the ring restricts `q` to `[sqrt((r-bezel)² - p²), sqrt(r² - p²)]`, i.e. a band
   *    `r - q` wide at each cap. When `p <= 0` that collapses to `x <= bezel`, the plain
   *    left/right cap.
   *
   * This is a **superset** of the rim: anything admitted here but rejected by the SDF is still
   * dropped by the same `d > 0 || d < -bezel` test, so the bitmap is bit-identical. The padded
   * margin is covered too — every pixel outside `[0, w] × [0, h]` has `p > r`, so the bound
   * excludes it and it keeps its neutral word.
   *
   * `centerX` is `w / 2`, so the side split has to be integral: `sdf` branches on `x < cx`, which
   * for integer `x` means `x <= ceil(cx) - 1` on the left.
   */
  const centerX = hw
  const centerY = hh
  const splitX = Math.ceil(centerX)

  for (let j = 0; j < ch; j++) {
    const y = j - FILTER_PAD
    const top = y < centerY
    const rowBase = j * cw

    for (let side = 0; side < 2; side++) {
      const onLeft = side === 0
      // Mirrors `sdf`'s own per-quadrant radius choice, so the bound uses the same `r` it does.
      const r = onLeft ? (top ? tl : bl) : top ? tr : br
      const p = Math.abs(y - centerY) - (centerY - r)
      if (p > r) continue

      let from: number
      let to: number
      if (p >= r - bezel) {
        from = onLeft ? 0 : splitX
        // `w + 1`, not `w`: at `x = w` the SDF is exactly `0`, which is still inside the rim test
        // (`d > 0` is what excludes), so the last column of the box belongs to the band. `x = -1`
        // needs no such care — there `d > 0` and the rim test drops it anyway.
        to = onLeft ? splitX : w + 1
      } else if (p <= 0) {
        // `q >= r - bezel` with `q = r - x` on the left → `x <= bezel`, and symmetrically.
        const edge = Math.floor(bezel) + 1
        if (onLeft) {
          from = 0
          to = Math.min(splitX, edge)
        } else {
          from = Math.max(splitX, w - edge)
          to = w + 1
        }
      } else {
        const inner = (r - bezel) * (r - bezel) - p * p
        const lo = inner > 0 ? Math.sqrt(inner) : 0
        const hi = Math.sqrt(Math.max(0, r * r - p * p))
        if (onLeft) {
          from = Math.max(0, Math.floor(r - hi))
          to = Math.min(splitX, Math.floor(r - lo) + 1)
        } else {
          from = Math.max(splitX, Math.ceil(w - r + lo))
          to = Math.min(w + 1, Math.floor(w - r + hi) + 1)
        }
      }

      for (let x = from; x < to; x++) {
        const index = (rowBase + x + FILTER_PAD) * 4
        const d = at(x, y)
        // Only the rim bends: drop everything outside the shape and everything deeper than
        // `bezel`, which skips the gradient work for the (large) flat centre.
        if (d > 0 || d < -bezel) continue

        // `circleMap` — the shader's `1 - sqrt(1 - x * x)`, a circular sagitta. It rises steeply
        // only as `x` leaves 0, so the bend stays in a thin band against the rim instead of
        // spreading across the whole bezel the way a smoothstep would.
        const t = Math.min(1, Math.max(0, 1 + d / bezel))
        const falloff = 1 - Math.sqrt(Math.max(0, 1 - t * t))

        let gx = gradAt(x + 1, y) - gradAt(x - 1, y)
        let gy = gradAt(x, y + 1) - gradAt(x, y - 1)
        let length = Math.hypot(gx, gy)
        if (length > 0) {
          gx /= length
          gy /= length
        }
        if (depth !== 0) {
          // `grad + depthEffect * normalize(centeredCoord)`, renormalised — the analytic
          // `gradSdRoundedRect` gradient is unit length, and so is this finite-difference one.
          const cx = x - hw
          const cy = y - hh
          const centreLength = Math.hypot(cx, cy)
          if (centreLength > 0) {
            gx += cx / centreLength
            gy += cy / centreLength
            length = Math.hypot(gx, gy)
            if (length > 0) {
              gx /= length
              gy /= length
            }
          }
        }

        // The shader's `dispersionIntensity` — `chromaticAberration` is baked as the constant 1.
        const dispersion = ((x - hw) * (y - hh)) / (hw * hh)
        const m = falloff * (1 + branch * dispersion)
        if (m > vmax) vmax = m
        rim.push({ index, gx, gy, m })
      }
    }
  }

  const k = vmax > 0 ? 127 / vmax : 0
  for (const pixel of rim) {
    if (pixel.m <= 0) continue
    const s = pixel.m * k
    // ⚠️ Inward. `lens()` passes `refractionAmount` with a *negated* sign and `gradient`
    // points outward, so in the shader `refractedCoord = coord + d * grad` lands farther
    // *inside* the shape: the rim shows content from deeper within, which is what squeezes
    // the backdrop at the edge. Sampling outward instead drags the surrounding wallpaper in
    // — a bright blue wedge appears wherever the backdrop just outside the rim is a
    // different colour than the backdrop under it.
    data[pixel.index] = clampByte(128 - pixel.gx * s)
    data[pixel.index + 1] = clampByte(128 - pixel.gy * s)
  }

  ctx.putImageData(image, 0, 0)
  return { url: canvas.toDataURL('image/png'), vmax: vmax > 0 ? vmax : 1 }
}

/** Displacement map for `spec` and spectral `branch`, memoised — identical shapes share one bitmap. */
function refractionMap(spec: RefractionSpec, branch: 1 | 0 | -1): MapEntry {
  const key = mapKey(spec, branch)
  const hit = mapCache.get(key)
  if (hit !== undefined) return hit
  const entry = buildMap(spec, branch)
  if (mapCache.size >= MAP_LIMIT) {
    const oldest = mapCache.keys().next().value
    if (oldest !== undefined) mapCache.delete(oldest)
  }
  if (entry.url) mapCache.set(key, entry)
  return entry
}

/**
 * The magnification displacement map: `d(p) = c + (p − c)/k − p` about the element centre,
 * neutral outside the box. Linear, so `vmax` is the largest corner magnitude; the
 * `feDisplacementMap` runs at a *fixed* `scale = 2·vmax` (the zoom does not participate in
 * the refraction's animation).
 */
function buildZoomMap(width: number, height: number, zoom: BackdropZoom): MapEntry {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const cw = w + FILTER_PAD * 2
  const ch = h + FILTER_PAD * 2
  const canvas = mapCanvas(cw, ch)
  const ctx = canvas.getContext('2d')
  if (!ctx) return { url: '', vmax: 1 }

  const image = ctx.createImageData(cw, ch)
  const data = image.data
  const k = zoom.factor
  const cx = w / 2
  const cy = h / 2

  // Corner magnitudes of the linear field, the largest of which sets the encoding range.
  let vmax = 0
  for (const [x, y] of [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h]
  ]) {
    const magnitude = Math.hypot(cx + (x - cx) / k - x, cy + (y - cy) / k - y)
    if (magnitude > vmax) vmax = magnitude
  }
  const s = vmax > 0 ? 127 / vmax : 0

  // Neutral grey — same 127.5-vs-128 zero point as `buildMap`, same deliberate choice, and the
  // same single-word fill: the field is only non-neutral inside the element box.
  new Uint32Array(data.buffer).fill(NEUTRAL_WORD)

  for (let y = 0; y < h; y++) {
    const rowBase = (y + FILTER_PAD) * cw + FILTER_PAD
    const dy = cy + (y - cy) / k - y
    for (let x = 0; x < w; x++) {
      const index = (rowBase + x) * 4
      data[index] = clampByte(128 + (cx + (x - cx) / k - x) * s)
      data[index + 1] = clampByte(128 + dy * s)
    }
  }

  ctx.putImageData(image, 0, 0)
  return { url: canvas.toDataURL('image/png'), vmax: vmax > 0 ? vmax : 1 }
}

function zoomMap(width: number, height: number, zoom: BackdropZoom): MapEntry {
  const key = `z|${Math.round(width)}x${Math.round(height)}|${zoom.factor}`
  const hit = mapCache.get(key)
  if (hit !== undefined) return hit
  const entry = buildZoomMap(width, height, zoom)
  if (mapCache.size >= MAP_LIMIT) {
    const oldest = mapCache.keys().next().value
    if (oldest !== undefined) mapCache.delete(oldest)
  }
  if (entry.url) mapCache.set(key, entry)
  return entry
}

/* ------------------------------------------------------------------------------------------- */
/* Filter element                                                                                */
/* ------------------------------------------------------------------------------------------- */

export interface GlassFilterHandle {
  /** Pass to `backdrop-filter: url(#id)`. */
  readonly id: string
  /**
   * `refractionHeight` / `refractionAmount` come straight from the `lens { }` block and change
   * every frame while a thumb is pressed, so the map is rebuilt only when the rim geometry
   * settles and the cheap knob — `scale` — is what animates. `zoom`, when given, rides its own
   * fixed-scale displacement stage ahead of the refraction chain; `overlay` is a static image
   * composited into the capture ahead of the same chain (so the effects refract it too).
   */
  update(
    spec: RefractionSpec,
    amount: number,
    zoom?: BackdropZoom | null,
    overlay?: CaptureOverlay | null
  ): void
  dispose(): void
}

function feImageElement(result: string): SVGFEImageElement {
  const el = document.createElementNS(SVG_NS, 'feImage')
  el.setAttribute('result', result)
  el.setAttribute('preserveAspectRatio', 'none')
  return el
}

function feDisplacementElement(input: string, map: string, result?: string): SVGFEDisplacementMapElement {
  const el = document.createElementNS(SVG_NS, 'feDisplacementMap')
  el.setAttribute('in', input)
  el.setAttribute('in2', map)
  el.setAttribute('xChannelSelector', 'R')
  el.setAttribute('yChannelSelector', 'G')
  el.setAttribute('scale', '0')
  if (result) el.setAttribute('result', result)
  return el
}

/** Keeps one channel (and the alpha) of its input — the branch splitter of the CA graph. */
function feChannelElement(input: string, channel: 'r' | 'g' | 'b', result: string): SVGFEColorMatrixElement {
  const el = document.createElementNS(SVG_NS, 'feColorMatrix')
  el.setAttribute('in', input)
  el.setAttribute('type', 'matrix')
  const row = channel === 'r' ? '1 0 0 0 0' : channel === 'g' ? '0 1 0 0 0' : '0 0 1 0 0'
  const zero = '0 0 0 0 0'
  const r = channel === 'r' ? row : zero
  const g = channel === 'g' ? row : zero
  const b = channel === 'b' ? row : zero
  // Alpha passes through: the backdrop behind the glass is opaque, so the re-addition's
  // alpha clamp at 1 reproduces the source alpha exactly.
  el.setAttribute('values', `${r}  ${g}  ${b}  0 0 0 1 0`)
  el.setAttribute('result', result)
  return el
}

/** `feComposite arithmetic` with `k2 = k3 = 1` — adds two premultiplied images. */
function feAddElement(a: string, b: string, result?: string): SVGFECompositeElement {
  const el = document.createElementNS(SVG_NS, 'feComposite')
  el.setAttribute('in', a)
  el.setAttribute('in2', b)
  el.setAttribute('operator', 'arithmetic')
  el.setAttribute('k1', '0')
  el.setAttribute('k2', '1')
  el.setAttribute('k3', '1')
  el.setAttribute('k4', '0')
  if (result) el.setAttribute('result', result)
  return el
}

/**
 * One filter per glass surface. The displacement *maps* are shared through
 * {@link refractionMap}; only the tiny `<filter>` element is per-surface, which is what
 * lets two thumbs animate to different refraction strengths at the same time. Surfaces
 * without chromatic aberration keep the two-primitive graph; asking for CA rebuilds it as
 * the eleven-primitive three-branch one.
 */
export function createGlassFilter(): GlassFilterHandle {
  const id = `lg-refract-${++sequence}`
  const filter = document.createElementNS(SVG_NS, 'filter')
  filter.setAttribute('id', id)
  filter.setAttribute('filterUnits', 'userSpaceOnUse')
  // Displacement reads outside the box; without this the shifted pixels get clipped at the rim.
  filter.setAttribute('x', String(-FILTER_PAD))
  filter.setAttribute('y', String(-FILTER_PAD))
  // The map stores linear displacement amounts, so it must not be colour-managed.
  filter.setAttribute('color-interpolation-filters', 'sRGB')

  let caMode: boolean | null = null
  let zoomMode: boolean | null = null
  let overlayMode: boolean | null = null
  let maps: SVGFEImageElement[] = []
  let displacements: SVGFEDisplacementMapElement[] = []
  let nodes: Element[] = []
  /** Per map node: the cache key its `href` was last set from — identical strings are skipped. */
  let mapKeys: (string | null)[] = []
  /** The stage that runs ahead of the refraction chain (the zoom), when present. */
  let zoomDisplacement: SVGFEDisplacementMapElement | null = null
  let zoomMapEl: SVGFEImageElement | null = null
  let zoomKey: string | null = null
  /** The capture overlay (static image composited into the capture), when present. */
  let overlayImageEl: SVGFEImageElement | null = null
  let lastOverlayUrl: string | null = null
  /** The overlay placement last written — `x`/`y` move every frame, `width`/`height` do not. */
  let lastOverlayPlacement = ''
  /**
   * Per displacement node: the `scale` string last written. `update()` runs on **every** redraw,
   * including every frame of a scroll, and a scroll changes none of the inputs `scale` is built
   * from — so the same string was being written to the same node again and again. Writing an
   * attribute on an SVG filter primitive marks the filter dirty, which is what makes it cheap to
   * write and expensive to have written. Skipping the identical write is the whole fix.
   */
  let lastScales: (string | null)[] = []

  function buildGraph(ca: boolean, zoom: boolean, overlay: boolean): void {
    while (filter.firstChild) filter.removeChild(filter.firstChild)
    maps = []
    displacements = []
    mapKeys = []
    nodes = []
    zoomDisplacement = null
    zoomMapEl = null
    zoomKey = null
    overlayImageEl = null
    lastOverlayUrl = null
    lastOverlayPlacement = ''
    lastScales = []

    // The zoom stage samples with its own fixed scale, and the refraction chain refracts the
    // already-magnified image — the original's `onDrawBackdrop`-then-effects order.
    let chainInput = 'SourceGraphic'
    if (zoom) {
      const zMap = feImageElement('zmap')
      const zDisp = feDisplacementElement('SourceGraphic', 'zmap', 'zoomed')
      zoomMapEl = zMap
      zoomDisplacement = zDisp
      nodes.push(zMap, zDisp)
      chainInput = 'zoomed'
    }

    // The capture overlay (e.g. the bottom tabs' accent strip) is composited into the capture
    // BEFORE the effects chain, so refraction and chromatic aberration bend it too.
    if (overlay) {
      const oImg = feImageElement('overlay')
      const oAdd = feAddElement(chainInput, 'overlay', 'composed')
      overlayImageEl = oImg
      nodes.push(oImg, oAdd)
      chainInput = 'composed'
    }

    if (!ca) {
      const map = feImageElement('map')
      const displace = feDisplacementElement(chainInput, 'map')
      maps.push(map)
      displacements.push(displace)
      mapKeys.push(null)
      nodes.push(map, displace)
    } else {
      const mapR = feImageElement('mapR')
      const mapG = feImageElement('mapG')
      const mapB = feImageElement('mapB')
      const srcR = feChannelElement(chainInput, 'r', 'srcR')
      const srcG = feChannelElement(chainInput, 'g', 'srcG')
      const srcB = feChannelElement(chainInput, 'b', 'srcB')
      const dispR = feDisplacementElement('srcR', 'mapR', 'dispR')
      const dispG = feDisplacementElement('srcG', 'mapG', 'dispG')
      const dispB = feDisplacementElement('srcB', 'mapB', 'dispB')
      const addRG = feAddElement('dispR', 'dispG', 'rg')
      const addRGB = feAddElement('rg', 'dispB')
      maps.push(mapR, mapG, mapB)
      displacements.push(dispR, dispG, dispB)
      mapKeys.push(null, null, null)
      nodes.push(mapR, mapG, mapB, srcR, srcG, srcB, dispR, dispG, dispB, addRG, addRGB)
    }
    filter.append(...nodes)

    // Primitive subregions must be explicit: the defaults are percentages of the element's
    // bounding box, which shifts and squeezes the `feImage` maps. `update()` only writes
    // them when the region size changes, so a mid-session graph rebuild (CA toggling)
    // would otherwise leave every primitive with the broken defaults.
    if (lastWidth !== 0) {
      for (const node of nodes) {
        node.setAttribute('x', String(-FILTER_PAD))
        node.setAttribute('y', String(-FILTER_PAD))
        node.setAttribute('width', String(lastWidth))
        node.setAttribute('height', String(lastHeight))
      }
    }
  }

  svgRoot().appendChild(filter)

  let lastMapKey = ''
  let lastWidth = 0
  let lastHeight = 0

  return {
    id,
    update(spec, amount, zoom, overlay) {
      const ca = !!spec.chromaticAberration
      const hasZoom = !!zoom && zoom.factor > 0 && zoom.factor !== 1
      const hasOverlay = !!overlay && !!overlay.url
      if (ca !== caMode || hasZoom !== zoomMode || hasOverlay !== overlayMode) {
        caMode = ca
        zoomMode = hasZoom
        overlayMode = hasOverlay
        buildGraph(ca, hasZoom, hasOverlay)
      }

      const width = Math.round(spec.width + FILTER_PAD * 2)
      const height = Math.round(spec.height + FILTER_PAD * 2)
      if (width !== lastWidth || height !== lastHeight) {
        lastWidth = width
        lastHeight = height
        filter.setAttribute('width', String(width))
        filter.setAttribute('height', String(height))
        for (const node of nodes) {
          node.setAttribute('x', String(-FILTER_PAD))
          node.setAttribute('y', String(-FILTER_PAD))
          node.setAttribute('width', String(width))
          node.setAttribute('height', String(height))
        }
        lastMapKey = ''
      }

      if (hasZoom && zoomDisplacement && zoomMapEl) {
        const key = `z|${Math.round(spec.width)}x${Math.round(spec.height)}|${zoom!.factor}`
        if (key !== zoomKey) {
          zoomKey = key
          const entry = zoomMap(spec.width, spec.height, zoom!)
          if (entry.url) zoomMapEl.setAttribute('href', entry.url)
          // Fixed scale — the magnification does not animate with the refraction amount.
          zoomDisplacement.setAttribute('scale', String(entry.vmax * 2))
        }
      }

      // One resolution per branch per update: `maps` and `displacements` are index-aligned with
      // `branches`, so the `href`s and the `scale`s are read off the same entries.
      const branches: (1 | 0 | -1)[] = ca ? [1, 0, -1] : [0]
      const entries = branches.map((branch) => refractionMap(spec, branch))

      const key = mapKey(spec, ca ? 1 : 0)
      if (key !== lastMapKey) {
        lastMapKey = key
        // Red and blue share the green branch's geometry, so one key guards all three hrefs.
        maps.forEach((map, index) => {
          const entry = entries[index]
          if (entry.url && mapKeys[index] !== key) {
            mapKeys[index] = key
            map.setAttribute('href', entry.url)
          }
        })
      }

      // The capture overlay's placement is element-local and moves per frame (the pill
      // slides over a fixed strip) — a cheap attribute write, no image rebuild. `href`
      // only changes when the strip's content does.
      if (hasOverlay && overlayImageEl && overlay) {
        const placement = `${overlay.x}|${overlay.y}|${overlay.width}|${overlay.height}`
        if (placement !== lastOverlayPlacement) {
          lastOverlayPlacement = placement
          overlayImageEl.setAttribute('x', String(overlay.x))
          overlayImageEl.setAttribute('y', String(overlay.y))
          overlayImageEl.setAttribute('width', String(overlay.width))
          overlayImageEl.setAttribute('height', String(overlay.height))
        }
        if (overlay.url !== lastOverlayUrl) {
          lastOverlayUrl = overlay.url
          overlayImageEl.setAttribute('href', overlay.url)
        }
      }

      // `amount` is the animation knob and changes independently of the map geometry. The map
      // encodes magnitudes normalised to `vmax`; the branch's own scale factor restores them.
      // `feDisplacementMap` offsets by `scale * (channel/255 - 0.5)`, so `amount * vmax` is that
      // branch's largest shift, px.
      //
      // Skipped when the value is unchanged. A scroll changes none of the inputs this is built
      // from, so the identical string used to be re-written to every node on every frame — and an
      // attribute write on a filter primitive dirties the filter, which is what turns a cheap
      // write into an expensive re-rasterisation.
      displacements.forEach((displace, index) => {
        const next = String(amount * 2 * entries[index].vmax)
        if (lastScales[index] === next) return
        lastScales[index] = next
        displace.setAttribute('scale', next)
      })
    },
    dispose() {
      filter.remove()
    }
  }
}
