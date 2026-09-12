/**
 * SVG refraction filter for `backdrop-filter: url(#id)`.
 *
 * ## Why an SVG filter at all
 *
 * `backdrop-filter` samples whatever is painted *behind* the element, so the glass never
 * needs a copy of the wallpaper — the browser does the capture. Blur, saturation and
 * brightness map 1:1 onto CSS filter functions. Refraction does not: CSS has no
 * "shift every pixel by a vector field" primitive, so that one effect goes through an SVG
 * filter. `feDisplacementMap` reads a map where R = dx and G = dy (128 = no offset) and
 * shifts each pixel by it.
 *
 * The map itself is generated on a canvas from the rounded-rect signed distance field —
 * the same construction as the AGSL `RoundedRectRefractionShaderString` the Android build
 * runs on API 33+, minus the SDF texture lookup.
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
 */
export function isRefractionSupported(): boolean {
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
}

const mapCache = new Map<string, string>()
const MAP_LIMIT = 32

function mapKey(spec: RefractionSpec): string {
  const r = spec.cornerRadii.map((v) => Math.round(v * 2) / 2).join(',')
  return `${Math.round(spec.width)}x${Math.round(spec.height)}|${r}|${Math.round(spec.refractionHeight)}`
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
 * `gradSdRoundedRect` — the shader takes its gradient from a *different* shape than the one it
 * uses for depth: the corner radius there is `min(radius * 1.5, min(halfSize))`. For a Capsule
 * the two coincide; for a small radius on a tall box they do not, and the bend fans out.
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

function buildMap(spec: RefractionSpec): string {
  const w = Math.max(1, Math.round(spec.width))
  const h = Math.max(1, Math.round(spec.height))
  const cw = w + FILTER_PAD * 2
  const ch = h + FILTER_PAD * 2
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''

  const image = ctx.createImageData(cw, ch)
  const data = image.data
  const [tl, tr, br, bl] = spec.cornerRadii
  const bezel = Math.max(0.5, spec.refractionHeight)
  const at = (x: number, y: number) => sdf(x, y, w, h, tl, tr, br, bl)
  const gradAt = (x: number, y: number) => gradSdf(x, y, w, h, tl, tr, br, bl)

  for (let j = 0; j < ch; j++) {
    const y = j - FILTER_PAD
    for (let i = 0; i < cw; i++) {
      const index = (j * cw + i) * 4
      // Neutral grey = "leave this pixel alone".
      data[index] = 128
      data[index + 1] = 128
      data[index + 2] = 128
      data[index + 3] = 255

      const x = i - FILTER_PAD
      const d = at(x, y)
      // Only the rim bends: drop everything outside the shape and everything deeper than
      // `bezel`, which skips the gradient work for the (large) flat centre.
      if (d > 0 || d < -bezel) continue

      // `circleMap` — the shader's `1 - sqrt(1 - x * x)`, a circular sagitta. It rises steeply
      // only as `x` leaves 0, so the bend stays in a thin band against the rim instead of
      // spreading across the whole bezel the way a smoothstep would.
      const t = Math.min(1, Math.max(0, 1 + d / bezel))
      const falloff = 1 - Math.sqrt(Math.max(0, 1 - t * t))

      const gx = gradAt(x + 1, y) - gradAt(x - 1, y)
      const gy = gradAt(x, y + 1) - gradAt(x, y - 1)
      const length = Math.hypot(gx, gy) || 1

      // ⚠️ Inward. `lens()` passes `refractionAmount` with a *negated* sign and `gradient`
      // points outward, so in the shader `refractedCoord = coord + d * grad` lands farther
      // *inside* the shape: the rim shows content from deeper within, which is what squeezes
      // the backdrop at the edge. Sampling outward instead drags the surrounding wallpaper in
      // — a bright blue wedge appears wherever the backdrop just outside the rim is a
      // different colour than the backdrop under it.
      data[index] = 128 - (gx / length) * falloff * 127
      data[index + 1] = 128 - (gy / length) * falloff * 127
    }
  }

  ctx.putImageData(image, 0, 0)
  return canvas.toDataURL('image/png')
}

/** Displacement map for `spec`, memoised — identical shapes share one bitmap. */
export function refractionMapUrl(spec: RefractionSpec): string {
  const key = mapKey(spec)
  const hit = mapCache.get(key)
  if (hit !== undefined) return hit
  const url = buildMap(spec)
  if (mapCache.size >= MAP_LIMIT) {
    const oldest = mapCache.keys().next().value
    if (oldest !== undefined) mapCache.delete(oldest)
  }
  if (url) mapCache.set(key, url)
  return url
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
   * settles and the cheap knob — `scale` — is what animates.
   */
  update(spec: RefractionSpec, amount: number): void
  dispose(): void
}

/**
 * One filter per glass surface. The displacement *map* is shared through
 * {@link refractionMapUrl}; only the tiny `<filter>` element is per-surface, which is what
 * lets two thumbs animate to different refraction strengths at the same time.
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

  const map = document.createElementNS(SVG_NS, 'feImage')
  map.setAttribute('result', 'map')
  map.setAttribute('preserveAspectRatio', 'none')

  const displace = document.createElementNS(SVG_NS, 'feDisplacementMap')
  displace.setAttribute('in', 'SourceGraphic')
  displace.setAttribute('in2', 'map')
  displace.setAttribute('xChannelSelector', 'R')
  displace.setAttribute('yChannelSelector', 'G')
  displace.setAttribute('scale', '0')

  filter.append(map, displace)
  svgRoot().appendChild(filter)

  let lastMapKey = ''
  let lastWidth = 0
  let lastHeight = 0

  return {
    id,
    update(spec, amount) {
      const width = Math.round(spec.width + FILTER_PAD * 2)
      const height = Math.round(spec.height + FILTER_PAD * 2)
      if (width !== lastWidth || height !== lastHeight) {
        lastWidth = width
        lastHeight = height
        filter.setAttribute('width', String(width))
        filter.setAttribute('height', String(height))
        for (const node of [map, displace]) {
          node.setAttribute('x', String(-FILTER_PAD))
          node.setAttribute('y', String(-FILTER_PAD))
          node.setAttribute('width', String(width))
          node.setAttribute('height', String(height))
        }
        lastMapKey = ''
      }

      const key = mapKey(spec)
      if (key !== lastMapKey) {
        lastMapKey = key
        map.setAttribute('href', refractionMapUrl(spec))
      }

      // `feDisplacementMap` offsets by `scale * (channel/255 - 0.5)`, so half the scale is the
      // largest shift. `refractionAmount` is that largest shift, in px.
      displace.setAttribute('scale', String(amount * 2))
    },
    dispose() {
      filter.remove()
    }
  }
}
