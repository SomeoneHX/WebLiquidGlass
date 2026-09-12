import type { Highlight, Shadow } from './backdrop'
import {
  identityTransform,
  type LayerTransform,
  type Size
} from './geometry'
import { highlightMap } from './highlight-map'
import type { InteractiveHighlight } from './interactive-highlight'
import type { Shape } from './shapes'

/**
 * The canvas half of a glass surface.
 *
 * ## What moved out of here
 *
 * This file used to *paint the backdrop*: it asked a `Backdrop` to draw a recorded bitmap into
 * the clipped region, then layered the surface wash and the highlight on top. The bitmap is
 * gone — `backdrop-filter` captures what is behind the element itself, so the glass no longer
 * holds a copy of the wallpaper anywhere.
 *
 * What is left is genuinely decorative and has no CSS equivalent for arbitrary shapes:
 *
 * - **shadow** — a blurred silhouette with the shape carved back out, which `filter:
 *   drop-shadow()` cannot express for a `clip-path` outline
 * - **surface wash** — `onDrawSurface`, a plain rect over the glass
 * - **highlight** — a sub-pixel inner stroke, blurred
 * - **interactive highlight** — the press sheen
 *
 * They are split into **three** passes because two things sit between them: the backdrop layer
 * has to be underneath the lot, and the additive decorations have to be composited by CSS
 * rather than by the canvas (see {@link drawGlassAdditive}). In the Compose original the whole
 * thing was one `drawBackdrop` modifier chain; here the backdrop is a DOM layer, so it takes a
 * canvas on either side of the lens plus one more for the additive half.
 */
export interface GlassDecorOptions {
  shape: Shape
  size: Size
  /** The canvas box is the element box grown by this much on every side. */
  margin: number
  layerTransform?: LayerTransform
}

export interface GlassShadowOptions extends GlassDecorOptions {
  shadow?: Shadow | null
}

/**
 * Normal-alpha pass: `onDrawSurface` plus the rings that stay `SrcOver`.
 *
 * `HighlightStyle.Ambient` is the only ring carried here — it declares
 * `blendMode = DrawScope.DefaultBlendMode` (`HighlightStyle.kt:73`), unlike `Plain` and
 * `Default`, which are `BlendMode.Plus` and therefore belong to {@link drawGlassAdditive}.
 */
export interface GlassOverlayOptions extends GlassDecorOptions {
  highlight?: Highlight | null
  onDrawSurface?: (ctx: CanvasRenderingContext2D, size: Size) => void
}

/** Additive pass: everything upstream draws with `BlendMode.Plus`. */
export interface GlassAdditiveOptions extends GlassDecorOptions {
  highlight?: Highlight | null
  interactiveHighlight?: InteractiveHighlight | null
}

/** Pooled scratch surfaces, keyed by pixel size, so per-frame draws don't thrash. */
const scratchPool = new Map<string, HTMLCanvasElement>()
const SCRATCH_POOL_LIMIT = 24

function obtainScratch(width: number, height: number): CanvasRenderingContext2D | null {
  const w = Math.max(1, Math.ceil(width))
  const h = Math.max(1, Math.ceil(height))
  const key = `${w}x${h}`
  let canvas = scratchPool.get(key)
  if (!canvas) {
    if (scratchPool.size >= SCRATCH_POOL_LIMIT) {
      const oldest = scratchPool.keys().next().value
      if (oldest !== undefined) scratchPool.delete(oldest)
    }
    canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    scratchPool.set(key, canvas)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.filter = 'none'
  return ctx
}

/**
 * Shadow pass — drawn *behind* the backdrop layer, never clipped to the shape (the blur has to
 * spill outside it).
 *
 * `ctx` is expected to be in element-local coordinates, i.e. the caller has already applied
 * the DPR scale and translated by `margin`.
 */
export function drawGlassShadow(
  ctx: CanvasRenderingContext2D,
  options: GlassShadowOptions
): void {
  const { shape, size, shadow: shadowSpec = null } = options
  if (!shadowSpec || shadowSpec.alpha <= 0) return

  const layerTransform = options.layerTransform ?? identityTransform
  const width = size.width
  const height = size.height
  const r = shadowSpec.radius
  const scratchMargin = r * 2
  const scratch = obtainScratch(
    width + scratchMargin * 2 + Math.abs(shadowSpec.offsetX),
    height + scratchMargin * 2 + Math.abs(shadowSpec.offsetY)
  )
  if (!scratch) return

  // Blurred silhouette, offset by the shadow offset.
  scratch.save()
  scratch.translate(scratchMargin, scratchMargin)
  scratch.shadowColor = shadowSpec.color
  // `BlurMaskFilter(radius)` behaves like a Gaussian with sigma ~= radius / 2,
  // and canvas `shadowBlur` is 2 * sigma.
  scratch.shadowBlur = r * 2
  scratch.shadowOffsetX = shadowSpec.offsetX
  scratch.shadowOffsetY = shadowSpec.offsetY
  scratch.fillStyle = 'rgba(0, 0, 0, 1)'
  shape.buildPath(scratch, width, height)
  scratch.fill()
  scratch.restore()

  // Carve the original silhouette back out — `ShadowMaskPaint` in the Kotlin source.
  scratch.save()
  scratch.translate(scratchMargin, scratchMargin)
  scratch.globalCompositeOperation = 'destination-out'
  scratch.shadowBlur = 0
  scratch.shadowOffsetX = 0
  scratch.shadowOffsetY = 0
  scratch.fillStyle = 'rgba(0, 0, 0, 1)'
  shape.buildPath(scratch, width, height)
  scratch.fill()
  scratch.restore()

  ctx.save()
  ctx.globalAlpha = layerTransform.alpha * shadowSpec.alpha
  // `layerBlock` is *not* applied here. A canvas has hard edges, so deforming its contents
  // clips anything that travels past the box — the canvas would have to carry a margin as
  // large as the largest possible drag, on every surface. `GlassSurface` puts the transform on
  // the canvas *element* instead, exactly like the lens and content layers.
  //
  // `ctx` is already in element-local space; the scratch bitmap's origin sits `scratchMargin`
  // above/left of it.
  ctx.translate(-scratchMargin, -scratchMargin)
  if (scratch.canvas) ctx.drawImage(scratch.canvas, 0, 0)
  ctx.restore()
}

/** `HighlightNode.configurePaint` — a ring the caller actually asked for. */
function hasRing(highlight: Highlight | null): highlight is Highlight {
  return !!highlight && highlight.alpha > 0 && highlight.width > 0
}

/**
 * `HighlightNode.configurePaint` — a stroked outline, blurred, clipped back to the shape so only
 * the inner half of the stroke survives (`canvas.clipOutline` upstream, the shape clip here).
 *
 * There are **two** rings upstream, and which one you get is decided by
 * `HighlightStyle.createShader`:
 *
 * - `Plain` returns `null` — and so does every style below API 33 — so
 *   `paint.setRuntimeShader(null)` leaves an ordinary stroke: uniform white at the style's own
 *   colour alpha.
 * - `Default` and `Ambient` return an AGSL shader, and `paint.setRuntimeShader` installs it as
 *   the paint's shader. Android modulates a shader by the paint colour, so the ring's alpha
 *   collapses to `styleColorAlpha · |⟨normal, light⟩| ^ falloff` — **directional**, 0.707 along
 *   the straight edges, up to 1.0 on one diagonal of each cap and 0 on the other.
 *
 * The port used to draw the uniform stroke for all three, which is why every surface carried an
 * even white rim: at the cardinals that is `0.5` against the correct `0.354`, ~1.4× too strong,
 * and it never breaks on the diagonals. The modulated path bakes the field into a cached image
 * (`highlight-map.ts`) and multiplies it into the stroke with `source-in`, which reproduces
 * `color · intensity` with the stroke's own antialiasing and blur left intact.
 *
 * `Default` and `Ambient` differ only in *colour*, and that difference is load-bearing:
 *
 * - `Default` returns `color · intensity` with `color = style.color.copy(alpha = 1)` — i.e.
 *   premultiplied **white** everywhere. It rides the `Plus` blend, where the zero half adds
 *   nothing, so the ring is a glow that fades out around the caps.
 * - `Ambient` returns `half4(t, t, t, 1) · intensity` with `t = step(0, d)`. AGSL hands back
 *   **premultiplied** values, so the `d < 0` half is `(0, 0, 0, intensity)` — opaque **black**
 *   at that alpha, not merely absent. Composed with `DrawScope.DefaultBlendMode` (`SrcOver`,
 *   `HighlightStyle.kt:73`) the two halves do opposite things:
 *
 *     ```
 *     dst' = src + dst · (1 − intensity)     src = (t·I, t·I, t·I, I)
 *     d ≥ 0 →  dst + I·(1 − dst)          lerp towards white  — the bevel's lit edge
 *     d < 0 →  dst · (1 − I)              multiply down        — the bevel's shaded edge
 *     ```
 *
 *   That is a **bevel**, not a rim, which is why `Ambient` — used by exactly the two pressed
 *   shapes, `LiquidToggle` and `LiquidSlider` — must not go down the additive path. Drawing it
 *   as a uniform white stroke not only missed the shading, it inverted the effect on half the
 *   boundary.
 */
function paintRing(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  width: number,
  height: number,
  margin: number,
  highlight: Highlight,
  baseAlpha: number
): void {
  const maxWidth = Math.min(highlight.width, Math.min(width, height) / 2)
  const lineWidth = Math.ceil(maxWidth) * 2

  // `createShader()` returned null: a plain, uniform stroke. This is `Plain`, and also every
  // style on a device without runtime shaders — the same fallback Android takes.
  if (highlight.style === 'plain') {
    ctx.save()
    ctx.globalAlpha = highlight.alpha * baseAlpha * highlight.colorAlpha
    if (highlight.blurRadius > 0) ctx.filter = `blur(${highlight.blurRadius}px)`
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = lineWidth
    shape.buildPath(ctx, width, height)
    ctx.stroke()
    ctx.restore()
    return
  }

  const totalWidth = width + margin * 2
  const totalHeight = height + margin * 2
  const matrix = ctx.getTransform()
  const dpr = matrix.a || 1
  const pixelWidth = Math.max(1, Math.round(totalWidth * dpr))
  const pixelHeight = Math.max(1, Math.round(totalHeight * dpr))
  const scratch = obtainScratch(pixelWidth, pixelHeight)
  if (!scratch) return

  // 1) Ring geometry, opaque white — the colour arrives in the next step. Same 2 px stroke
  //    clipped to its inner half, same BlurMaskFilter equivalent.
  scratch.setTransform(dpr, 0, 0, dpr, margin * dpr, margin * dpr)
  scratch.strokeStyle = '#fff'
  if (highlight.blurRadius > 0) scratch.filter = `blur(${highlight.blurRadius}px)`
  scratch.lineWidth = lineWidth
  shape.buildPath(scratch, width, height)
  scratch.stroke()

  // 2) Modulate. `source-in` keeps the source's colour and multiplies the alphas, so the map's
  //    per-pixel `intensity` scales the stroke's coverage. The blur must not be re-applied to
  //    the map — that would smear the field instead of the geometry, which is the opposite of
  //    what `Paint.blur()` does (it is a mask filter: blurred coverage, per-pixel colour).
  //
  //    The map carries the *colour* too: white for `Default`, and white-vs-black across `d = 0`
  //    for `Ambient` — see the doc comment above for why the black half is not a no-op there.
  scratch.filter = 'none'
  scratch.setTransform(1, 0, 0, 1, 0, 0)
  scratch.globalCompositeOperation = 'source-in'
  scratch.drawImage(
    highlightMap({
      width,
      height,
      margin,
      cornerRadii: shape.cornerRadii(width, height),
      angle: highlight.angle,
      falloff: highlight.falloff,
      variant: highlight.style
    }),
    0,
    0,
    pixelWidth,
    pixelHeight
  )

  // 3) Back into the caller's local space. The scratch spans the whole canvas box, so it is
  //    drawn from `-margin` and then clipped by whatever clip the caller already set.
  ctx.save()
  ctx.globalAlpha = highlight.alpha * baseAlpha * highlight.colorAlpha
  ctx.translate(-margin, -margin)
  ctx.drawImage(scratch.canvas, 0, 0, totalWidth, totalHeight)
  ctx.restore()
}

/**
 * Overlay pass — the surface wash and the **non-additive** ring, clipped to the shape and drawn
 * on top of the backdrop layer under ordinary alpha compositing.
 */
export function drawGlassOverlay(
  ctx: CanvasRenderingContext2D,
  options: GlassOverlayOptions
): void {
  const { shape, size, highlight = null, onDrawSurface } = options
  const layerTransform = options.layerTransform ?? identityTransform
  const width = size.width
  const height = size.height
  const ring = hasRing(highlight) && !highlight.additive ? highlight : null
  if (!onDrawSurface && !ring) return

  ctx.save()
  ctx.globalAlpha = layerTransform.alpha
  // No `applyLayerTransform` — the shape clip and the surface wash stay in element-local
  // space, and the whole canvas is deformed by the CSS transform on its element. Transforming
  // the contents instead would clip the wash at the canvas edge, which is what left a square
  // wedge of tint behind while the capsule stretched.
  shape.buildPath(ctx, width, height)
  ctx.clip()

  if (onDrawSurface) onDrawSurface(ctx, size)
  if (ring) paintRing(ctx, shape, width, height, options.margin, ring, layerTransform.alpha)

  ctx.restore()
}

/**
 * Additive pass — the press sheen and the `BlendMode.Plus` rings. This canvas is composited by
 * `mix-blend-mode: plus-lighter` (set in `GlassSurface`), which is the CSS spelling of
 * `BlendMode.Plus`.
 *
 * Why it needs its own layer: `globalCompositeOperation = 'lighter'` only blends against what is
 * *already inside the bitmap*, and this bitmap starts empty — so on its own it just accumulates
 * the flat pass and the glow and hands the browser a semi-transparent white layer. The browser
 * then composites that layer with plain alpha, i.e. a **lerp towards white**:
 *
 * ```
 * normal:       dst + a·(255 − dst)      // a third of the lift once dst is bright
 * plus-lighter: dst + a·255              // what BlendMode.Plus does
 * ```
 *
 * Measured on a synthetic `rgb(60, 200, 250)` base with white at `a = 0.23`: normal gives
 * `105, 213, 251`, `plus-lighter` gives `119, 255, 255`, and pure addition predicts
 * `118.7, 258.7, 308.7`. The gap is the whole bug — on a bright backdrop the lerp throws away
 * most of the highlight, which is why the port's press sheen read as a washed-out shimmer
 * instead of the original's blown-out white.
 *
 * `lighter` is still set on the context so the two passes add to each other correctly inside the
 * bitmap; the composite that reaches the screen is the CSS one.
 */
export function drawGlassAdditive(
  ctx: CanvasRenderingContext2D,
  options: GlassAdditiveOptions
): void {
  const { shape, size, highlight = null, interactiveHighlight = null } = options
  const layerTransform = options.layerTransform ?? identityTransform
  const width = size.width
  const height = size.height
  const ring = hasRing(highlight) && highlight.additive ? highlight : null
  if (!interactiveHighlight && !ring) return

  ctx.save()
  ctx.globalAlpha = layerTransform.alpha
  ctx.globalCompositeOperation = 'lighter'
  shape.buildPath(ctx, width, height)
  ctx.clip()

  if (interactiveHighlight) interactiveHighlight.draw(ctx, width, height)
  if (ring) paintRing(ctx, shape, width, height, options.margin, ring, layerTransform.alpha)

  ctx.restore()
}

/** Convenience helper for `onDrawSurface = { drawRect(color) }` call sites. */
export function fillRect(
  ctx: CanvasRenderingContext2D,
  color: string,
  width: number,
  height: number
): void {
  ctx.save()
  ctx.fillStyle = color
  ctx.fillRect(0, 0, width, height)
  ctx.restore()
}
