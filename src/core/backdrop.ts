import type { Size } from './geometry'
import { isRefractionSupported, type SdfSource } from './glass-filter'

/**
 * Port of `com.kyant.backdrop.BackdropEffectScope`, plus the `Backdrop` marker.
 *
 * ## How this differs from the Compose original
 *
 * On Android the effects block builds a `RenderEffect` chain and the backdrop is a bitmap the
 * library records itself. On the web neither is needed: `backdrop-filter` already samples
 * whatever is painted behind the element, so *there is no copy of the background anywhere*.
 * The effects block therefore stops being a renderer and becomes a **parameter collector** —
 * `GlassSurface` turns what it records into a CSS `backdrop-filter` value.
 *
 * | Kotlin | here |
 * | --- | --- |
 * | `blur(radius)` → `BlurEffect` | `blurRadius` → `backdrop-filter: blur()` |
 * | `vibrancy()` / `colorControls()` | `saturation` / `brightness` / `contrast` |
 * | `lens(h, a)` → AGSL refraction shader | `refraction` → SVG `feDisplacementMap` |
 * | `sdfTexture(h, a)` → `SdfShader` | `sdf` → `feDisplacementMap` over the decoded field, plus `mask-image` and a bevel multiplier |
 * | `runtimeShaderEffect` | no CSS twin — recorded, inert; specific shaders are re-expressed by hand (`AlphaMask`) |
 * | `innerShadow` (a RenderEffect) | still canvas-drawn, unchanged |
 *
 * The call sites keep writing 1:1 Kotlin, so the numbers in `views/` and `components/` still
 * read like the original.
 */

/** Extra px the filter needs outside the shape, from `BackdropEffectScopeImpl.padding`. */
export const effectPadding = (scope: BackdropEffectScope): number => scope.padding

export interface RefractionRequest {
  refractionHeight: number
  refractionAmount: number
  depthEffect: boolean
  chromaticAberration: boolean
}

/**
 * `SdfShader.apply(refractionHeight, lightAngle)` — refraction of a **baked** distance field
 * rather than of a rounded rect (the lock screen's clock face).
 *
 * Upstream the texture is a field of the `SdfShader` object and the call reads
 * `with(sdfShader) { apply() }`. There is no shader object to hold it here, so the decoded texture
 * arrives as an extra argument — the one place this port's signature is not 1:1 with Kotlin, and
 * it is flagged at the call site too.
 */
export interface SdfRequest {
  /** `apply(refractionHeight)` — the displacement scale, since the field itself is baked. */
  refractionHeight: number
  /** `apply(lightAngle)` — bevel light angle in degrees. */
  lightAngle: number
  texture: SdfSource
}

/**
 * A recorded `runtimeShaderEffect` request. The shader source itself has no CSS twin, but
 * its *uniforms* are recorded verbatim so specific shaders can be re-expressed with the
 * primitives CSS does have (see `AlphaMask` in `GlassSurface`).
 */
export interface RecordedShader {
  key: string
  floats: Map<string, number[]>
  colors: Map<string, string>
}

/** Uniform setters handed to a `runtimeShaderEffect { }` block — records for the web path. */
export interface RuntimeShaderUniforms {
  setFloatUniform(name: string, ...values: number[]): void
  setColorUniform(name: string, color: string | number): void
}

/**
 * Mutable scope handed to an `effects { ... }` block. Every setter is a plain recorder — the
 * guards mirror the ones the Kotlin build applies per API level, so an unsupported effect is
 * dropped at the same place in both implementations.
 */
export class BackdropEffectScope {
  size: Size = { width: 0, height: 0 }
  padding = 0

  /** `blur(radius)` — the largest radius wins, matching a chained `BlurEffect`. */
  blurRadius = 0
  brightness = 1
  contrast = 1
  saturation = 1
  /** `lens(...)`, or `null` when the platform cannot refract. */
  refraction: RefractionRequest | null = null
  /** `SdfShader.apply(...)` — baked-texture refraction, or `null` when not requested. */
  sdf: SdfRequest | null = null
  /** Recorded for the web re-expressions of specific shaders (`AlphaMask`). */
  readonly shaderRequests: RecordedShader[] = []

  reset(): void {
    this.padding = 0
    this.blurRadius = 0
    this.brightness = 1
    this.contrast = 1
    this.saturation = 1
    this.refraction = null
    this.sdf = null
    this.shaderRequests.length = 0
  }

  blur(radius: number): void {
    if (radius <= 0) return
    if (radius > this.blurRadius) this.blurRadius = radius
  }

  vibrancy(): void {
    this.colorControls(0, 1, 1.5, true)
  }

  colorControls(brightness = 0, contrast = 1, saturation = 1, vibrancy = false): void {
    if (brightness === 0 && contrast === 1 && saturation === 1) return
    this.brightness = 1 + brightness
    this.contrast = contrast
    this.saturation = saturation
    void vibrancy
  }

  opacity(alpha: number): void {
    // No backdrop-filter function for this; the surface wash already covers it.
    void alpha
  }

  lens(
    refractionHeight: number,
    refractionAmount: number,
    depthEffect = false,
    chromaticAberration = false
  ): void {
    // AGSL is API 33+ and `url()` in backdrop-filter is Chromium-only — same shape of guard.
    if (!isRefractionSupported()) return
    if (refractionHeight <= 0 || refractionAmount <= 0) return
    if (this.padding > 0) this.padding = Math.max(0, this.padding - refractionHeight)
    this.refraction = { refractionHeight, refractionAmount, depthEffect, chromaticAberration }
  }

  /**
   * Kept at the Kotlin signature so call sites stay 1:1. The AGSL source has no CSS twin —
   * `backdrop-filter` only accepts fixed filter functions — but the uniforms are recorded
   * and specific shaders get web re-expressions where CSS can match them (`AlphaMask` →
   * `mask-image` + background tint in `GlassSurface`).
   */
  runtimeShaderEffect(
    key: string,
    shaderString?: string,
    inputShaderName?: string,
    uniforms?: (scope: RuntimeShaderUniforms) => void
  ): void {
    void shaderString
    void inputShaderName
    const record: RecordedShader = { key, floats: new Map(), colors: new Map() }
    uniforms?.({
      setFloatUniform: (name, ...values) => record.floats.set(name, values),
      setColorUniform: (name, color) => record.colors.set(name, String(color))
    })
    this.shaderRequests.push(record)
  }

  /**
   * `SdfShader.apply(refractionHeight, lightAngle)`.
   *
   * The texture is an explicit third argument, and that is the only signature in this file that
   * is not 1:1 with Kotlin — upstream the texture is a field of the `SdfShader` receiver, and
   * there is no receiver to close over here.
   *
   * Unlike `runtimeShaderEffect`, this one *is* expressible: `feDisplacementMap` over a field
   * decoded from the same texture reproduces the displacement, the texture's alpha channel
   * reproduces `content.eval(...) * v.a` as a `mask-image`, and the bevel tail collapses into one
   * multiplier. So with a texture the request is live, and without one there is nothing to
   * record — a clock with no face is not a degraded clock, it is an empty screen.
   */
  sdfTexture(refractionHeight: number, lightAngle: number, texture?: SdfSource | null): void {
    if (!texture) return
    this.sdf = { refractionHeight, lightAngle, texture }
  }

  /** `backdrop-filter` value, e.g. `blur(8px) saturate(150%) brightness(1.05)`. */
  backdropFilterCss(): string {
    const parts: string[] = []
    if (this.blurRadius > 0) parts.push(`blur(${round(this.blurRadius)}px)`)
    if (this.saturation !== 1) parts.push(`saturate(${round(this.saturation * 100)}%)`)
    if (this.brightness !== 1) parts.push(`brightness(${round(this.brightness * 100)}%)`)
    if (this.contrast !== 1) parts.push(`contrast(${round(this.contrast * 100)}%)`)
    return parts.join(' ')
  }

  /**
   * Just the blur — the colour functions are split off for callers that move them into the SVG
   * filter instead.
   *
   * Two reasons to prefer the filter. `brightness` upstream is an **additive offset**
   * (`ColorFilter.kt`: `t = (0.5f − c·0.5f + brightness) · 255f`, i.e. it lands in the constant
   * column of the colour matrix), and CSS `brightness()` is a multiply — at `−0.1` that is 25.5 of
   * constant difference, which lifts every dark channel and greys out saturated glass. And a flat
   * wash drawn inside the filter only rides along with `saturate` / `contrast` if the matrix sits
   * *after* it, which CSS cannot arrange, because CSS runs its functions before `url(#…)`.
   *
   * See `RefractionSpec.colorControls`.
   */
  blurCss(): string {
    return this.blurRadius > 0 ? `blur(${round(this.blurRadius)}px)` : ''
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
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
  /**
   * The **style's own colour alpha** — `HighlightStyle.{Plain,Default,Ambient}.color`. All three
   * are `Color.White.copy(alpha = …)`, so the ring's hue is always white and only this number
   * varies: 0.38 for `Plain` and `Ambient`, 0.5 for `Default`.
   *
   * Distinct from {@link Highlight.alpha}, which is the *layer's* opacity. Upstream calls both
   * "alpha" and they multiply, so conflating them is the easy mistake — see `Ambient` below.
   */
  colorAlpha: number
  /**
   * `HighlightStyle.Default.angle` in degrees. Together with {@link Highlight.falloff} it drives
   * the directional modulation of the ring; see `highlight-map.ts`. `Plain` has no shader
   * upstream and ignores both.
   */
  angle: number
  /** `HighlightStyle.Default.falloff` — exponent on `|d|`. `ControlCenter` passes `2`. */
  falloff: number
  /**
   * `BlendMode.Plus` for the styles that declare it; `false` only for `Ambient`, which keeps
   * `DrawScope.DefaultBlendMode` (`HighlightStyle.kt:73`). Where the ring is *drawn* follows
   * from this — additive rings go to the `plus-lighter` canvas, this one stays on the overlay.
   */
  additive: boolean
}

/**
 * `HighlightStyle.Ambient.intensity` — the style's own colour alpha, independent of
 * `Highlight.alpha`. The two are easy to conflate because both are called "alpha" upstream.
 */
const AMBIENT_INTENSITY = 0.38

export const HighlightStyles = {
  Plain: (alpha = 1): Highlight => ({
    width: 0.5,
    blurRadius: 0.25,
    alpha,
    style: 'plain',
    colorAlpha: 0.38,
    angle: 45,
    falloff: 1,
    additive: true
  }),
  /**
   * `HighlightStyle.Default` — `White @ 0.5`, `angle = 45°`, `falloff = 1` (`HighlightStyle.kt:47-53`).
   *
   * The three arguments are `Highlight.alpha` (layer opacity), the light angle and the falloff
   * exponent. `angle`/`falloff` are not decoration: they are the uniforms of
   * `DefaultHighlightShaderString`, and dropping them is what made every ring uniform.
   */
  Default: (alpha = 1, angle = 45, falloff = 1): Highlight => ({
    width: 0.5,
    blurRadius: 0.25,
    alpha,
    style: 'default',
    colorAlpha: 0.5,
    angle,
    falloff,
    additive: true
  }),
  /**
   * `Highlight.Ambient.copy(alpha = progress)` — the call sites in `LiquidToggle` / `LiquidSlider`.
   *
   * `alpha` here is `Highlight.alpha` (the layer's opacity), **not** the style's colour alpha.
   * Kotlin keeps them apart: `HighlightStyle.Ambient.color` is `White @ 0.38` and
   * `Highlight.Ambient.alpha` is `1f`, so `.copy(alpha = progress)` yields `0.38 · progress`.
   * Feeding the same number into the colour as well squarifies it — `progress²` — which at full
   * press is 2.6× too strong and near zero is far too weak.
   */
  Ambient: (alpha = 1): Highlight => ({
    width: 0.5,
    blurRadius: 0.25,
    alpha,
    style: 'ambient',
    colorAlpha: AMBIENT_INTENSITY,
    angle: 45,
    falloff: 1,
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
 * `InnerShadow` is still rendered by the canvas decor pass, not by `backdrop-filter`: it is a
 * per-pixel effect over the surface, and `box-shadow: inset` only follows `border-radius`,
 * not the arbitrary shapes this library draws.
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
  color: string = 'rgba(0,0,0,0.15)',
  alpha = 1
): InnerShadow {
  return { radius, offsetX, offsetY, color, alpha }
}

/* -------------------------------------------------------------------------------------------- */
/* Backdrop                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * Port of `com.kyant.backdrop.Backdrop` — reduced to the one thing the web build still needs
 * from it: whether this surface should capture the page behind it.
 *
 * The Compose version is an interface with a `drawBackdrop(ctx, …)` that paints a bitmap the
 * library recorded. `backdrop-filter` does that capture natively, so the drawing half of the
 * contract is gone; `EmptyBackdrop()` (the scaffold's Back button, `emptyBackdrop()`) is the
 * only call site that ever opted out.
 */
export interface Backdrop {
  readonly samples: boolean
}

/** `rememberLayerBackdrop()` on the wallpaper — "sample the page". */
export const RootBackdrop: Backdrop = { samples: true }

/** `rememberEmptyBackdrop()` — a surface with a tint but no glass. */
export const EmptyBackdrop: Backdrop = { samples: false }
