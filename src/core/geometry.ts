/**
 * Geometry primitives.
 *
 * Compose works in `dp` / `px` pairs and resolves everything through a `Density`.
 * On the web we work directly in CSS pixels (`px`) and keep a single `density` value
 * (1 means 1 CSS px === 1 dp, which is what the demo screenshots assume). Every
 * dimension in the port is written in CSS px using the same numbers as the original
 * `xx.dp` constants, so `density = 1`.
 */

export const density = 1

/** `12f.dp.toPx()` */
export function dp(value: number): number {
  return value * density
}

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** Viewport-space rectangle (CSS px), as produced by `getBoundingClientRect()`. */
export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export function rectRight(r: Rect): number {
  return r.left + r.width
}

export function rectBottom(r: Rect): number {
  return r.top + r.height
}

/**
 * The `GraphicsLayerScope` properties the catalog actually animates.
 * `transformOrigin` is always the centre for every ported call site except
 * `AdaptiveLuminanceGlassContent`, which explicitly sets (0.5, 0.5) anyway.
 */
export interface LayerTransform {
  translationX: number
  translationY: number
  scaleX: number
  scaleY: number
  rotationZ: number
  alpha: number
}

export const identityTransform: LayerTransform = {
  translationX: 0,
  translationY: 0,
  scaleX: 1,
  scaleY: 1,
  rotationZ: 0,
  alpha: 1
}

/**
 * Applies a `layerBlock` transform around the centre of a `width x height` box.
 * Matches `GraphicsLayer` semantics: `T(centre + translation) · R · S · T(-centre)`.
 */
export function applyLayerTransform(
  ctx: CanvasRenderingContext2D,
  t: LayerTransform,
  width: number,
  height: number
): void {
  const cx = width / 2
  const cy = height / 2
  ctx.translate(cx + t.translationX, cy + t.translationY)
  if (t.rotationZ !== 0) ctx.rotate((t.rotationZ * Math.PI) / 180)
  ctx.scale(t.scaleX, t.scaleY)
  ctx.translate(-cx, -cy)
}

/** Inverse of {@link applyLayerTransform}. */
export function applyInverseLayerTransform(
  ctx: CanvasRenderingContext2D,
  t: LayerTransform,
  width: number,
  height: number
): void {
  const cx = width / 2
  const cy = height / 2
  ctx.translate(cx, cy)
  ctx.scale(1 / t.scaleX, 1 / t.scaleY)
  if (t.rotationZ !== 0) ctx.rotate((-t.rotationZ * Math.PI) / 180)
  ctx.translate(-cx - t.translationX, -cy - t.translationY)
}

/** CSS equivalent of {@link applyLayerTransform} (transform-origin: center). */
export function layerTransformToCss(t: LayerTransform): string {
  const parts: string[] = []
  if (t.translationX !== 0 || t.translationY !== 0) {
    parts.push(`translate(${t.translationX}px, ${t.translationY}px)`)
  }
  if (t.rotationZ !== 0) parts.push(`rotate(${t.rotationZ}deg)`)
  if (t.scaleX !== 1 || t.scaleY !== 1) parts.push(`scale(${t.scaleX}, ${t.scaleY})`)
  return parts.length ? parts.join(' ') : 'none'
}
