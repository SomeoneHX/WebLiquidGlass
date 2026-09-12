/**
 * The highlight ring's intensity map — `internal/Shaders.kt:161-204`.
 *
 * `HighlightStyle.Default` and `HighlightStyle.Ambient` are not plain strokes upstream. Both
 * build an AGSL shader (`HighlightStyle.kt:52-70`, `:80-99`) and hand it to the paint through
 * `paint.setRuntimeShader(shader)` (`HighlightModifier.kt:155-164`). Android modulates a
 * shader by the paint colour, so with `paint.color = style.color` the ring's alpha becomes
 *
 * ```
 * d         = dot(gradSdRoundedRect(centeredCoord, halfSize, gradRadius), (cos angle, sin angle))
 * intensity = |d| ^ falloff
 * alpha     = styleColorAlpha · intensity
 * ```
 *
 * `gradSdRoundedRect` is the SDF's **outward unit normal**, so `|d|` is `|cos(θ − angle)|` of
 * the boundary direction: the ring is *directional*, not uniform. At the default 45° that is
 * 0.707 along the straight edges (their normals sit at 45° to the light), 1.0 at one diagonal
 * of each cap, and **0** at the other — where the highlight visibly breaks. Drawing a uniform
 * stroke instead is what put an even white rim around every surface.
 *
 * Chromium cannot run AGSL, but it does not have to approximate here: the field depends only on
 * `(size, corner radii, angle, falloff)`, i.e. it is a static image. It is rasterised once into
 * a canvas and cached, the same trick `glass-filter.ts` uses for the refraction displacement map.
 */
export type HighlightMapVariant = 'default' | 'ambient'

export interface HighlightMapSpec {
  /** Element size in CSS px — the shape occupies `(0, 0) … (width, height)`. */
  width: number
  height: number
  /** The map covers the whole canvas box, i.e. the element grown by `margin` on every side. */
  margin: number
  cornerRadii: [number, number, number, number]
  /** `HighlightStyle.Default.angle`, in degrees. */
  angle: number
  falloff: number
  variant: HighlightMapVariant
}

const CACHE_LIMIT = 24
const cache = new Map<string, HTMLCanvasElement>()

/**
 * `gradSdRoundedRect` — `Shaders.kt:40-48`, verbatim. `x`/`y` are relative to the shape's centre.
 *
 * Outside the corner boxes the direction runs to the nearest corner point; inside the "core"
 * (the cross left after the corners are cut away) it is axis-aligned. Both branches return a
 * unit vector, which is what makes `|d|` a pure cosine.
 */
function outwardNormal(
  x: number,
  y: number,
  halfWidth: number,
  halfHeight: number,
  radius: number
): [number, number] {
  const cx = Math.abs(x) - (halfWidth - radius)
  const cy = Math.abs(y) - (halfHeight - radius)
  if (cx >= 0 || cy >= 0) {
    const nx = Math.max(cx, 0)
    const ny = Math.max(cy, 0)
    const length = Math.hypot(nx, ny) || 1
    return [Math.sign(x) * (nx / length), Math.sign(y) * (ny / length)]
  }
  // `step(cornerCoord.y, cornerCoord.x)` — 1 when x >= y, 0 otherwise.
  const onX = cx >= cy
  return [Math.sign(x) * (onX ? 1 : 0), Math.sign(y) * (onX ? 0 : 1)]
}

function build(spec: HighlightMapSpec): HTMLCanvasElement {
  const { width, height, margin, cornerRadii, angle, falloff, variant } = spec
  const totalWidth = Math.max(1, Math.round(width + margin * 2))
  const totalHeight = Math.max(1, Math.round(height + margin * 2))

  const canvas = document.createElement('canvas')
  canvas.width = totalWidth
  canvas.height = totalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas

  const halfWidth = width / 2
  const halfHeight = height / 2
  // Faithful to upstream: `radiusAt(coord, cornerRadii)` is fed *un-centred* coordinates
  // (`Shaders.kt:173`), and it only returns `radii.y` on the very first row — every other pixel
  // resolves to `radii.z`. Every shape in this port uses a single radius, so it makes no
  // difference; the note is here so the next reader does not "fix" it into a discrepancy.
  const radius = cornerRadii[2]
  const gradRadius = Math.min(radius * 1.5, Math.min(halfWidth, halfHeight))

  const radians = (angle * Math.PI) / 180
  const lightX = Math.cos(radians)
  const lightY = Math.sin(radians)

  const image = ctx.createImageData(totalWidth, totalHeight)
  const data = image.data

  for (let j = 0; j < totalHeight; j++) {
    const y = j - margin - halfHeight
    for (let i = 0; i < totalWidth; i++) {
      const x = i - margin - halfWidth
      const [gx, gy] = outwardNormal(x, y, halfWidth, halfHeight, gradRadius)
      const d = gx * lightX + gy * lightY
      const intensity = Math.min(1, Math.max(0, Math.pow(Math.abs(d), falloff)))

      const index = (j * totalWidth + i) * 4
      // `Default` returns `color * intensity` — white all the way round.
      // `Ambient` returns `half4(t, t, t, 1) * intensity` with `t = step(0, d)`, i.e. a
      // premultiplied white on the lit half and premultiplied black on the other. Not wired up
      // yet — see `paintRing` in `draw-backdrop.ts` for why.
      const lit = variant === 'default' || d >= 0
      const level = lit ? 255 : 0
      data[index] = level
      data[index + 1] = level
      data[index + 2] = level
      // `putImageData` is unpremultiplied, which is exactly how the stroke colour should land.
      data[index + 3] = Math.round(intensity * 255)
    }
  }

  ctx.putImageData(image, 0, 0)
  return canvas
}

/** Cached rasterisation of the ring's directional intensity for one shape + style. */
export function highlightMap(spec: HighlightMapSpec): HTMLCanvasElement {
  const key = [
    Math.round(spec.width),
    Math.round(spec.height),
    Math.round(spec.margin),
    spec.cornerRadii.map((r) => Math.round(r * 100) / 100).join(','),
    Math.round(spec.angle * 100) / 100,
    Math.round(spec.falloff * 100) / 100,
    spec.variant
  ].join('|')

  const cached = cache.get(key)
  if (cached) return cached

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  const canvas = build(spec)
  cache.set(key, canvas)
  return canvas
}
