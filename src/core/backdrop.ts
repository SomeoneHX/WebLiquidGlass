import type { LayerTransform, Rect, Size } from './geometry'

/**
 * Port of `com.kyant.backdrop.BackdropEffectScope`.
 *
 * ## Degraded mode (the target of this port)
 *
 * The web build reproduces the catalog exactly as it renders on **Android 12 and below**
 * (`Build.VERSION.SDK_INT < 31`), where the library reports:
 *
 * ```kotlin
 * isRenderEffectSupported()  = SDK_INT >= Build.VERSION_CODES.S          // false
 * isRuntimeShaderSupported() = SDK_INT >= Build.VERSION_CODES.TIRAMISU   // false
 * ```
 *
 * Because `DrawBackdropNode.updateEffects()` bails out on the first flag and
 * `BackdropEffectScopeImpl.apply()` never runs, **every effect registered here becomes a
 * no-op** and the render effect / padding stay untouched:
 *
 * | effect | degraded behaviour |
 * | --- | --- |
 * | `blur` | no-op |
 * | `lens` (refraction) | no-op (`isRuntimeShaderSupported` guard) |
 * | `vibrancy` / `colorControls` / `colorFilter` / `opacity` | no-op (`isRenderEffectSupported` guard) |
 * | `runtimeShaderEffect` / SDF texture | no-op |
 * | `innerShadow` | not drawn at all (explicit guard in `InnerShadowNode.draw`) |
 *
 * Everything that is *not* a RenderEffect survives — that is the point of this build:
 * `layerBlock` deformation, `onDrawBackdrop`, `onDrawSurface`, `Highlight` (stroke +
 * `BlurMaskFilter`), `Shadow`, the interactive press highlight and ripples.
 *
 * The calls are still kept in the port so the source stays a 1:1 mirror of the Kotlin
 * catalog and so the "full" (API 33+) pipeline is a matter of flipping these two flags
 * plus implementing the effect list.
 */
export const isRenderEffectSupported = false
export const isRuntimeShaderSupported = false

export type EffectKind =
  | 'blur'
  | 'lens'
  | 'vibrancy'
  | 'colorControls'
  | 'opacity'
  | 'colorFilter'
  | 'runtimeShader'
  | 'sdfTexture'

export interface EffectRequest {
  kind: EffectKind
  args: Record<string, unknown>
}

/** Mutable scope handed to an `effects { ... }` block. */
export class BackdropEffectScope {
  size: Size = { width: 0, height: 0 }
  padding = 0
  /** Recorded for inspection — nothing in this build consumes it. */
  readonly requests: EffectRequest[] = []

  reset(): void {
    this.padding = 0
    this.requests.length = 0
  }

  blur(radius: number): void {
    if (!isRenderEffectSupported || radius <= 0) return
    this.requests.push({ kind: 'blur', args: { radius } })
  }

  lens(
    refractionHeight: number,
    refractionAmount: number,
    depthEffect = false,
    chromaticAberration = false
  ): void {
    if (!isRuntimeShaderSupported) return
    if (refractionHeight <= 0 || refractionAmount <= 0) return
    if (this.padding > 0) this.padding = Math.max(0, this.padding - refractionHeight)
    this.requests.push({
      kind: 'lens',
      args: { refractionHeight, refractionAmount, depthEffect, chromaticAberration }
    })
  }

  vibrancy(): void {
    if (!isRenderEffectSupported) return
    this.colorControls(0, 1, 1.5, true)
  }

  colorControls(brightness = 0, contrast = 1, saturation = 1, vibrancy = false): void {
    if (!isRenderEffectSupported) return
    if (brightness === 0 && contrast === 1 && saturation === 1) return
    this.requests.push({
      kind: vibrancy ? 'vibrancy' : 'colorControls',
      args: { brightness, contrast, saturation }
    })
  }

  opacity(alpha: number): void {
    if (!isRenderEffectSupported) return
    this.requests.push({ kind: 'opacity', args: { alpha } })
  }

  runtimeShaderEffect(
    key: string,
    shaderString: string,
    inputShaderName?: string,
    uniforms?: (scope: {
      setFloatUniform: (name: string, ...values: number[]) => void
      setColorUniform: (name: string, color: string | number) => void
    }) => void
  ): void {
    if (!isRuntimeShaderSupported) return
    this.requests.push({
      kind: 'runtimeShader',
      args: { key, shaderString, inputShaderName, uniforms }
    })
  }

  /** `SdfShader.apply()` — the lock-screen clock texture. */
  sdfTexture(refractionHeight: number, lightAngle: number): void {
    if (!isRuntimeShaderSupported) return
    this.requests.push({ kind: 'sdfTexture', args: { refractionHeight, lightAngle } })
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Highlight / Shadow / InnerShadow                                                              */
/* -------------------------------------------------------------------------------------------- */

export type HighlightStyleKind = 'plain' | 'default' | 'ambient'

export interface Highlight {
  /** Stroke width in px. */
  width: number
  blurRadius: number
  alpha: number
  style: HighlightStyleKind
  color: string
  /** `lighter` for the additive styles, `source-over` for ambient. */
  additive: boolean
}

export const HighlightStyles = {
  Plain: (alpha = 1): Highlight => ({
    width: 0.5,
    blurRadius: 0.25,
    alpha,
    style: 'plain',
    color: 'rgba(255,255,255,0.38)',
    additive: true
  }),
  Default: (alpha = 1, angle = 45, falloff = 1): Highlight => {
    void angle
    void falloff
    return {
      width: 0.5,
      blurRadius: 0.25,
      alpha,
      style: 'default',
      color: 'rgba(255,255,255,0.5)',
      additive: true
    }
  },
  Ambient: (alpha = 0.38): Highlight => ({
    width: 0.5,
    blurRadius: 0.25,
    alpha,
    style: 'ambient',
    color: `rgba(255,255,255,${alpha})`,
    additive: false
  })
}

export interface Shadow {
  radius: number
  offsetX: number
  offsetY: number
  color: string
  alpha: number
}

export const DefaultShadow: Shadow = {
  radius: 24,
  offsetX: 0,
  offsetY: 4,
  color: 'rgba(0,0,0,0.1)',
  alpha: 1
}

export function shadow(
  radius = 24,
  offsetX = 0,
  offsetY = radius / 6,
  color = 'rgba(0,0,0,0.1)',
  alpha = 1
): Shadow {
  return { radius, offsetX, offsetY, color, alpha }
}

/**
 * `InnerShadow` is declared for API parity but **never drawn** in this build: the Kotlin
 * `InnerShadowNode.draw()` starts with `if (!isRenderEffectSupported()) return`.
 */
export interface InnerShadow {
  radius: number
  offsetX: number
  offsetY: number
  color: string
  alpha: number
}

export function innerShadow(
  radius = 24,
  offsetX = 0,
  offsetY = radius,
  color = 'rgba(0,0,0,0.15)',
  alpha = 1
): InnerShadow {
  return { radius, offsetX, offsetY, color, alpha }
}

/* -------------------------------------------------------------------------------------------- */
/* Backdrop                                                                                      */
/* -------------------------------------------------------------------------------------------- */

export interface BackdropDrawContext {
  /** Local (untransformed) size of the element the backdrop is drawn for. */
  size: Size
  /** Viewport rect of that element, *before* `layerTransform` is applied. */
  elementRect: Rect
  /** The `layerBlock` in force; coordinates-dependent backdrops must invert it. */
  layerTransform: LayerTransform
  density: number
  /** Current animation frame index (see `frameCounter`). */
  frame: number
}

/**
 * Port of `com.kyant.backdrop.Backdrop`.
 *
 * `draw` is invoked with the canvas already translated to the element's top-left corner in
 * **untransformed local space**, with the shape clip already installed.
 */
export interface Backdrop {
  readonly coordinatesDependent: boolean
  draw(ctx: CanvasRenderingContext2D, dc: BackdropDrawContext): void
}

export class CanvasBackdrop implements Backdrop {
  readonly coordinatesDependent = false

  constructor(private readonly onDraw: (ctx: CanvasRenderingContext2D, dc: BackdropDrawContext) => void) {}

  draw(ctx: CanvasRenderingContext2D, dc: BackdropDrawContext): void {
    this.onDraw(ctx, dc)
  }
}

/**
 * Port of `LayerBackdrop`.
 *
 * The layer keeps an offscreen canvas of the content that was recorded under it plus the
 * viewport rect that content occupies (Compose's `LayerCoordinates`). When a surface draws
 * the backdrop it re-projects that canvas so the content appears *pinned to the screen*
 * while the glass shape deforms over it — this is what makes the deformation readable.
 */
export class LayerBackdrop implements Backdrop {
  readonly coordinatesDependent = true

  private canvas: HTMLCanvasElement | null = null
  private rect: Rect | null = null
  private captureFn: ((ctx: CanvasRenderingContext2D, width: number, height: number) => void) | null =
    null
  private captureSize: Size = { width: 0, height: 0 }
  /** Dynamic layers re-capture once per animation frame (their content animates). */
  dynamic = false
  private capturedFrame = -1
  private dirty = true

  /** Configures the recorded content (its size is the layer's pixel size). */
  configure(
    width: number,
    height: number,
    capture: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
    dynamic = false
  ): void {
    this.captureFn = capture
    this.dynamic = dynamic
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas = document.createElement('canvas')
      this.canvas.width = w
      this.canvas.height = h
      this.dirty = true
    }
    this.captureSize = { width: w, height: h }
  }

  /** `layerBackdrop`'s `onGloballyPositioned` — where the recorded content sits. */
  setRect(rect: Rect | null): void {
    if (
      this.rect &&
      rect &&
      this.rect.left === rect.left &&
      this.rect.top === rect.top &&
      this.rect.width === rect.width &&
      this.rect.height === rect.height
    ) {
      return
    }
    this.rect = rect
  }

  get layerRect(): Rect | null {
    return this.rect
  }

  get layerSize(): Size {
    return this.captureSize
  }

  invalidate(): void {
    this.dirty = true
  }

  /** Re-records the layer when needed. Called lazily from `draw`. */
  ensureCaptured(frame: number): void {
    if (!this.canvas || !this.captureFn) return
    if (!this.dynamic) {
      if (!this.dirty) return
    } else if (this.capturedFrame === frame) {
      return
    }
    this.dirty = false
    this.capturedFrame = frame
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.filter = 'none'
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, this.captureSize.width, this.captureSize.height)
    ctx.clip()
    this.captureFn(ctx, this.captureSize.width, this.captureSize.height)
    ctx.restore()
  }

  draw(ctx: CanvasRenderingContext2D, dc: BackdropDrawContext): void {
    if (!this.canvas || !this.rect) return
    this.ensureCaptured(dc.frame)
    const t = dc.layerTransform
    const w = dc.size.width
    const h = dc.size.height
    ctx.save()
    // Inverse of the element's layer transform — keeps the recorded content screen-fixed.
    ctx.translate(w / 2, h / 2)
    ctx.scale(1 / t.scaleX, 1 / t.scaleY)
    if (t.rotationZ !== 0) ctx.rotate((-t.rotationZ * Math.PI) / 180)
    ctx.translate(-w / 2 - t.translationX, -h / 2 - t.translationY)
    // `LayerBackdrop`'s `layerCoordinates.localPositionOf(coordinates)` is the *drawing*
    // element's origin expressed in the *recorded layer's* local space, i.e.
    // `elementRect - layerRect`; the Kotlin source then draws the layer at `-offset`.
    // So the translation is `layerRect - elementRect` — get this backwards and the bitmap
    // lands off the element entirely (nothing is drawn, which is invisible in degraded mode
    // because there is no blur to give the missing sample away).
    ctx.translate(this.rect.left - dc.elementRect.left, this.rect.top - dc.elementRect.top)
    ctx.drawImage(this.canvas, 0, 0)
    ctx.restore()
  }
}

export class CombinedBackdrop implements Backdrop {
  readonly coordinatesDependent: boolean

  constructor(private readonly backdrops: Backdrop[]) {
    this.coordinatesDependent = backdrops.some((b) => b.coordinatesDependent)
  }

  draw(ctx: CanvasRenderingContext2D, dc: BackdropDrawContext): void {
    for (const backdrop of this.backdrops) backdrop.draw(ctx, dc)
  }
}

/**
 * `rememberBackdrop(trackBackdrop) { scale(scaleX, scaleY) { drawBackdrop() } }`
 * — wraps a backdrop in a `DrawScope.scale` (pivot defaults to the element centre).
 */
export class ScaledBackdrop implements Backdrop {
  readonly coordinatesDependent = true

  constructor(
    private readonly inner: Backdrop,
    private readonly scaleX: () => number,
    private readonly scaleY: () => number
  ) {}

  draw(ctx: CanvasRenderingContext2D, dc: BackdropDrawContext): void {
    const sx = this.scaleX()
    const sy = this.scaleY()
    if (sx === 0 || sy === 0) return
    const cx = dc.size.width / 2
    const cy = dc.size.height / 2
    ctx.save()
    ctx.translate(cx, cy)
    ctx.scale(sx, sy)
    ctx.translate(-cx, -cy)
    this.inner.draw(ctx, dc)
    ctx.restore()
  }
}

export const EmptyBackdrop: Backdrop = {
  coordinatesDependent: false,
  draw: () => {}
}

export function combinedBackdrop(...backdrops: Backdrop[]): Backdrop {
  return new CombinedBackdrop(backdrops)
}
