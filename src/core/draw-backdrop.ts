import {
  BackdropEffectScope,
  type Backdrop,
  type BackdropDrawContext,
  type Highlight,
  type InnerShadow,
  type Shadow
} from './backdrop'
import { frameCounter } from './animation'
import {
  applyLayerTransform,
  identityTransform,
  type LayerTransform,
  type Rect,
  type Size
} from './geometry'
import type { InteractiveHighlight } from './interactive-highlight'
import type { Shape } from './shapes'

export interface DrawBackdropOptions {
  backdrop: Backdrop
  shape: Shape
  size: Size
  /**
   * Viewport rect the element's local (0,0) maps to. Position-only translations applied by
   * an outer `graphicsLayer` are already folded in here, which is what keeps a dragged
   * surface sampling the backdrop region it actually covers.
   */
  elementRect: Rect
  /** Full transform applied to the drawn output (shape, content, shadow, highlight). */
  layerTransform?: LayerTransform
  /**
   * Subset of `layerTransform` whose inverse the backdrop applies (`layerBlock`).
   * Defaults to `layerTransform`.
   */
  backdropLayerTransform?: LayerTransform
  density?: number
  /** `effects { ... }` block — evaluated for parity, a no-op in the degraded build. */
  effects?: (scope: BackdropEffectScope) => void
  highlight?: Highlight | null
  shadow?: Shadow | null
  /** Accepted for API parity; never drawn (see `InnerShadowNode`'s supported check). */
  innerShadow?: InnerShadow | null
  onDrawBackdrop?: (
    ctx: CanvasRenderingContext2D,
    drawBackdrop: () => void,
    dc: BackdropDrawContext
  ) => void
  onDrawSurface?: (ctx: CanvasRenderingContext2D, size: Size) => void
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
 * Renders one glass surface.
 *
 * Mirrors the modifier order produced by `Modifier.drawBackdrop(...)`:
 *
 * ```
 * graphicsLayer(layerBlock)                 <- outer: transforms everything below
 *   InnerShadowElement                      <- disabled on API < 31
 *   ShadowElement                           <- drawn first (behind), not clipped
 *   HighlightElement                        <- drawn last (on top), clipped to the outline
 *   DrawBackdropElement                     <- clip to shape, backdrop, surface, content
 * ```
 */
export function drawBackdrop(
  ctx: CanvasRenderingContext2D,
  options: DrawBackdropOptions
): void {
  const {
    backdrop,
    shape,
    size,
    elementRect,
    density = 1,
    effects,
    highlight = null,
    shadow: shadowSpec = null,
    onDrawBackdrop,
    onDrawSurface,
    interactiveHighlight = null
  } = options
  const layerTransform = options.layerTransform ?? identityTransform
  const width = size.width
  const height = size.height

  ctx.save()
  // NOTE: `options.offset` (the position-only outer `graphicsLayer` translation) is
  // deliberately *not* applied here. The caller moves the surface itself — both the canvas
  // box and the content div — by that amount, so this canvas' local origin already *is* the
  // moved position. Translating again would double it, and since the backing store only
  // covers the element box, the glass would be drawn outside it and clipped away.
  // `elementRect` still carries the offset, so backdrop sampling stays correct.
  const baseAlpha = layerTransform.alpha
  ctx.globalAlpha = baseAlpha

  // 1. shadow ---------------------------------------------------------------------------
  if (shadowSpec && shadowSpec.alpha > 0) {
    drawShadow(ctx, shape, width, height, shadowSpec, layerTransform, baseAlpha)
  }

  // 2. clipped glass ---------------------------------------------------------------------
  ctx.save()
  applyLayerTransform(ctx, layerTransform, width, height)
  shape.buildPath(ctx, width, height)
  ctx.clip()

  // 2a. effects — recorded but never applied in degraded mode.
  if (effects) {
    const scope = new BackdropEffectScope()
    scope.size = size
    scope.reset()
    effects(scope)
  }

  // 2b. backdrop ------------------------------------------------------------------------
  const dc: BackdropDrawContext = {
    size,
    elementRect,
    layerTransform,
    density,
    frame: frameCounter.value
  }
  const drawBackdropContent = () => backdrop.draw(ctx, dc)
  if (onDrawBackdrop) onDrawBackdrop(ctx, drawBackdropContent, dc)
  else drawBackdropContent()

  // 2c. surface -------------------------------------------------------------------------
  if (onDrawSurface) onDrawSurface(ctx, size)

  // 2d. interactive press highlight -----------------------------------------------------
  if (interactiveHighlight) interactiveHighlight.draw(ctx, width, height)

  // 3. highlight ring (on top of everything, clipped to the outline) ---------------------
  if (highlight && highlight.alpha > 0 && highlight.width > 0) {
    ctx.save()
    const maxWidth = Math.min(highlight.width, Math.min(width, height) / 2)
    ctx.globalAlpha = highlight.alpha * baseAlpha
    ctx.globalCompositeOperation = highlight.additive ? 'lighter' : 'source-over'
    if (highlight.blurRadius > 0) ctx.filter = `blur(${highlight.blurRadius}px)`
    ctx.strokeStyle = highlight.color
    ctx.lineWidth = Math.ceil(maxWidth) * 2
    shape.buildPath(ctx, width, height)
    ctx.stroke()
    ctx.restore()
  }

  ctx.restore()
  ctx.restore()
}

function drawShadow(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  width: number,
  height: number,
  shadow: Shadow,
  layerTransform: LayerTransform,
  baseAlpha: number
): void {
  const r = shadow.radius
  const margin = r * 2
  const scratchWidth = width + margin * 2 + Math.abs(shadow.offsetX)
  const scratchHeight = height + margin * 2 + Math.abs(shadow.offsetY)
  const offscreen = obtainScratch(scratchWidth, scratchHeight)
  if (!offscreen) return

  // Blurred silhouette, offset by the shadow offset.
  offscreen.save()
  offscreen.translate(margin, margin)
  offscreen.shadowColor = shadow.color
  // `BlurMaskFilter(radius)` behaves like a Gaussian with sigma ~= radius / 2,
  // and canvas `shadowBlur` is 2 * sigma.
  offscreen.shadowBlur = r * 2
  offscreen.shadowOffsetX = shadow.offsetX
  offscreen.shadowOffsetY = shadow.offsetY
  offscreen.fillStyle = 'rgba(0, 0, 0, 1)'
  shape.buildPath(offscreen, width, height)
  offscreen.fill()
  offscreen.restore()

  // Carve the original silhouette back out — `ShadowMaskPaint` in the Kotlin source.
  offscreen.save()
  offscreen.translate(margin, margin)
  offscreen.globalCompositeOperation = 'destination-out'
  offscreen.shadowBlur = 0
  offscreen.shadowOffsetX = 0
  offscreen.shadowOffsetY = 0
  offscreen.fillStyle = 'rgba(0, 0, 0, 1)'
  shape.buildPath(offscreen, width, height)
  offscreen.fill()
  offscreen.restore()

  ctx.save()
  ctx.globalAlpha = baseAlpha * shadow.alpha
  applyLayerTransform(ctx, layerTransform, width, height)
  ctx.translate(-margin, -margin)
  if (offscreen.canvas) ctx.drawImage(offscreen.canvas, 0, 0)
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
