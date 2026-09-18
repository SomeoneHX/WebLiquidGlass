<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { animationRevision } from '@/core/animation'
import { BackdropEffectScope, DefaultShadow, HighlightStyles } from '@/core/backdrop'
import type { Backdrop, Highlight, InnerShadow, Shadow } from '@/core/backdrop'
import { drawGlassAdditive, drawGlassOverlay, drawGlassShadow } from '@/core/draw-backdrop'
import { createGlassFilter, type BackdropZoom, type CaptureOverlay, type GlassFilterHandle } from '@/core/glass-filter'
import { identityTransform, layerTransformToCss, type LayerTransform, type Size } from '@/core/geometry'
import type { InteractiveHighlight } from '@/core/interactive-highlight'
import type { Shape } from '@/core/shapes'
import { layoutEpoch, useElementMetrics } from '@/composables/useElementMetrics'

/**
 * One glass surface, in four stacked pieces.
 *
 * ```
 * shadow canvas     blurred silhouette, spills outside the box, not clipped
 * lens layer  <-    backdrop-filter: blur() saturate() … url(#refraction)
 * overlay canvas    surface wash (onDrawSurface), ambient highlight ring
 * additive canvas   press sheen + `BlendMode.Plus` rings — mix-blend-mode: plus-lighter
 * content           the slot
 * ```
 *
 * The lens layer is the important change from the earlier build. It is a **plain, empty DOM
 * element** whose only job is `backdrop-filter`; the browser captures whatever is behind it,
 * so nothing here ever holds a copy of the wallpaper. That also means the browser does the
 * inverse-transform step itself (Filter Effects L2 § 2.1) — a `scale()` on this element
 * widens the sampled region instead of magnifying the background, which is exactly the
 * liquid-glass deformation, with no manual counter-transform.
 *
 * Three canvases rather than one because two things have to sit between them: the backdrop layer
 * has to be *under* every decoration, and the additive half cannot be composited by the canvas
 * at all — `BlendMode.Plus` only exists as CSS `mix-blend-mode: plus-lighter`. See
 * `drawGlassAdditive`. In Compose the whole thing was a single `drawBackdrop` modifier chain.
 *
 * Nothing may ever be nested inside the lens layer: `backdrop-filter` makes the element a
 * backdrop root, so descendants would stop sampling the page.
 */

const OVERLAY_MARGIN = 2

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  /** Marker only — `EmptyBackdrop` means "draw the surface, don't sample the page". */
  backdrop: Backdrop
  shape: Shape
  /** The `layerBlock` — deformation: translation / scale / rotation / alpha. */
  layerTransform?: () => LayerTransform
  /**
   * A position-only translation applied by an *separate* outer `graphicsLayer` (the slider
   * thumb, the bottom-tabs indicator, …). Folded into the same CSS transform as
   * `layerTransform`: the browser inverts the whole thing when sampling, so a moved surface
   * correctly samples the region it now covers.
   */
  offset?: () => { x: number; y: number }
  /** `effects { ... }` — turned into a CSS `backdrop-filter` value. */
  effects?: (scope: BackdropEffectScope) => void
  /** `highlight = { ... }`; defaults to `Highlight.Default` when omitted. Pass `() => null` to disable. */
  highlight?: () => Highlight | null
  /** `shadow = { ... }`; defaults to `Shadow.Default` when omitted. Pass `() => null` to disable. */
  shadow?: () => Shadow | null
  /** `onDrawSurface = { drawRect(...) }` */
  onDrawSurface?: (ctx: CanvasRenderingContext2D, size: Size) => void
  /**
   * `onDrawBackdrop { drawBackdrop(); drawRect(color) }` — a flat wash drawn **into** the captured
   * backdrop, ahead of the effects chain. Channels are 0–255.
   *
   * Deliberately not `onDrawSurface`. `DrawBackdropModifier` is explicit about the order: the
   * backdrop layer is recorded by `recordBackdropBlock`, the render effect is attached to that
   * same layer, and `onDrawSurface` runs in `ContentDrawScope.draw()` *after* `drawBackdropLayer()`.
   * So `onDrawBackdrop` draws inside the shader and `onDrawSurface` draws outside it — only the
   * first gets cut to the shape by `content.eval(...) * v.a`. Routing the clock's wash through
   * `onDrawSurface` put a lit rectangle over the whole box, which is what the screen showed.
   */
  backdropWash?: () => { r: number; g: number; b: number; alpha: number } | null
  /**
   * Alpha of a black scrim the destination painted **behind** this surface, if any.
   *
   * Upstream this is invisible: a surface samples a `LayerBackdrop`, and the destinations that
   * dim their own content (`Lock screen`) do it in a sibling of the wallpaper recording, so the
   * dimming never reaches the plate. The browser has no such separation — `backdrop-filter`
   * samples everything painted behind, scrim included — so the destination has to declare it and
   * the filter undoes it with a `1 / (1 - scrim)` gain. See `RefractionSpec.backdropGain`.
   */
  backdropScrim?: number
  /** `innerShadow { }` — defaults to null, unlike `highlight` / `shadow`. */
  innerShadow?: () => InnerShadow | null
  /**
   * The `onDrawBackdrop { withTransform { scale; translate } }` magnification — the captured
   * backdrop is drawn at `factor×` with the translate applied, before the effects chain
   * refracts it (the upstream draw-then-refract order).
   */
  backdropZoom?: () => BackdropZoom | null
  /** A static image composited into the captured backdrop before the effects chain — the CSS
   * stand-in for the upstream "record a hidden layer and sample it" pattern. */
  captureOverlay?: () => CaptureOverlay | null
  /** Drives the press wash. */
  interactiveHighlight?: InteractiveHighlight | null
  /** Extra class on the clip/transform layer that wraps the slot. */
  contentClass?: string
}>()

const rootEl = ref<HTMLElement | null>(null)
const lensEl = ref<HTMLElement | null>(null)
const shadowCanvasEl = ref<HTMLCanvasElement | null>(null)
const overlayCanvasEl = ref<HTMLCanvasElement | null>(null)
const additiveCanvasEl = ref<HTMLCanvasElement | null>(null)
const { size, rect } = useElementMetrics(rootEl)

/** Reused across frames — `effects { }` is evaluated once per frame, not once per mount. */
const effectScope = new BackdropEffectScope()
let glassFilter: GlassFilterHandle | null = null

onMounted(() => {
  glassFilter = createGlassFilter()
})

onBeforeUnmount(() => {
  glassFilter?.dispose()
  glassFilter = null
})

/**
 * The animation values live outside Vue's reactivity (they are plain JS objects that are
 * stepped by the shared frame loop), so everything is pulled fresh on every read and
 * `animationRevision` is the signal that invalidates the DOM style + canvases.
 */
function currentTransform(): LayerTransform {
  return props.layerTransform?.() ?? identityTransform
}

function currentOffset(): { x: number; y: number } {
  return props.offset?.() ?? { x: 0, y: 0 }
}

/** `offset` first, then the `layerBlock` — one transform, inverted as a whole by the browser. */
function currentCssTransform(): string {
  const t = currentTransform()
  const o = currentOffset()
  const parts: string[] = []
  if (o.x !== 0 || o.y !== 0) parts.push(`translate(${o.x}px, ${o.y}px)`)
  const shape = layerTransformToCss(t)
  if (shape !== 'none') parts.push(shape)
  return parts.length ? parts.join(' ') : 'none'
}

/**
 * `drawBackdrop`'s library defaults. A call site that omits `highlight` / `shadow` gets
 * `Highlight.Default` (0.5 px inner ring) and `Shadow.Default` (24 px blur, 4 px down,
 * 10 % black) — *not* "nothing". Only `ControlCenterContent` opts out of the shadow.
 */
function currentHighlight(): Highlight | null {
  return props.highlight ? props.highlight() : HighlightStyles.Default()
}

function currentShadow(): Shadow | null {
  return props.shadow ? props.shadow() : DefaultShadow
}

/** The shadow canvas is enlarged so the blur can spill outside the element box. */
const overflow = computed(() => {
  void animationRevision.value
  const shadow = currentShadow()
  if (!shadow) return 0
  return Math.ceil(
    2 * shadow.radius + Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY)) + 2
  )
})

/**
 * Both canvas boxes ride the *same* CSS transform as the lens and the content, so a
 * `layerBlock` deformation moves all four layers as one.
 *
 * The transform deliberately does **not** live inside the canvas: a canvas has hard edges, so
 * deforming its contents clips whatever travels past the box. Applying the `layerBlock` there
 * left the tint as a square wedge parked in place while the capsule stretched around it. Doing
 * it in CSS also means the margin only has to cover what the *drawing* spills (a blur, an
 * outline), not the largest possible drag.
 *
 * `center` is correct because both boxes are grown evenly around the element.
 */
const shadowBoxStyle = computed(() => {
  void animationRevision.value
  const margin = overflow.value
  return {
    left: `${-margin}px`,
    top: `${-margin}px`,
    width: `calc(100% + ${margin * 2}px)`,
    height: `calc(100% + ${margin * 2}px)`,
    transform: currentCssTransform(),
    transformOrigin: 'center'
  }
})

const overlayBoxStyle = computed(() => decorationBoxStyle())
const additiveBoxStyle = computed(() => decorationBoxStyle())

/** Both decoration canvases are the element box grown by `OVERLAY_MARGIN` on every side. */
function decorationBoxStyle() {
  void animationRevision.value
  return {
    left: `${-OVERLAY_MARGIN}px`,
    top: `${-OVERLAY_MARGIN}px`,
    width: `calc(100% + ${OVERLAY_MARGIN * 2}px)`,
    height: `calc(100% + ${OVERLAY_MARGIN * 2}px)`,
    transform: currentCssTransform(),
    transformOrigin: 'center'
  }
}

/**
 * The lens rides a **reactive** binding rather than `applyLensStyle`, and that is the whole point.
 *
 * `applyLensStyle` runs from `redraw`, which is triggered by size, layout epoch or
 * `animationRevision`. A drag changes none of the three — it writes the `offset` prop, and the
 * three canvases plus the content pick that up through their computed boxes while the lens, whose
 * transform was written imperatively, never moved. The clock's wash slid across the screen and the
 * refraction stayed put.
 *
 * Everything else about the lens (`backdrop-filter`, the mask, the clip path) still comes from
 * `applyLensStyle`, because those have to be re-derived from an `effects { }` block that reads
 * non-reactive state on every frame.
 */
const lensBoxStyle = computed(() => {
  void animationRevision.value
  const style: Record<string, string> = { transformOrigin: 'center' }
  const transform = currentCssTransform()
  if (transform !== 'none') style.transform = transform
  const alpha = currentTransform().alpha
  if (alpha !== 1) style.opacity = String(alpha)
  return style
})

const contentStyle = computed(() => {
  void animationRevision.value
  const t = currentTransform()
  const width = size.value.width
  const height = size.value.height
  const style: Record<string, string> = {
    transform: currentCssTransform(),
    transformOrigin: 'center'
  }
  if (t.alpha !== 1) style.opacity = String(t.alpha)
  if (width > 0 && height > 0) style.clipPath = props.shape.clipPath(width, height)
  return style
})

/**
 * The lens layer. `backdrop-filter` is written twice on purpose: the plain declaration always
 * sticks, and the `url()` one is appended after it. Engines that cannot use an SVG filter as a
 * backdrop *drop the whole declaration* rather than failing gracefully, so leaving the first
 * write in place is what keeps Safari and Firefox on a plain blur.
 */
/**
 * Web re-expression of the catalog's `AlphaMask` runtime shader (`ProgressiveBlurContent`):
 *
 * ```
 * blurAlpha = tintAlpha = smoothstep(size.y, size.y * 0.5, coord.y)
 * out = mix(content·blurAlpha, tint·tintAlpha, tintIntensity)
 * ```
 *
 * One element carries all of it: `backdrop-filter: blur()` for the content, the tint as the
 * element background at `tintIntensity` alpha, and the smoothstep ramp as a `mask-image`.
 * In premultiplied terms the mask multiplies the whole element by `blurAlpha`, so the output
 * is `blurAlpha·(tintIntensity·tint + (1−tintIntensity)·content)` — exactly the shader's mix.
 * The gradient stops sample the smoothstep curve (`t = 2(1−y/h)`, `t²(3−2t)`); a linear ramp
 * would be visibly more "kinked" at the midpoint.
 */
const ALPHA_MASK_GRADIENT = (() => {
  const stops: string[] = ['black 0%', 'black 50%']
  for (let i = 1; i < 10; i++) {
    const t = 1 - i / 10 // t = 2(1 − y/h) for y ∈ [h/2, h]
    const alpha = t * t * (3 - 2 * t)
    stops.push(`rgba(0, 0, 0, ${alpha.toFixed(3)}) ${(50 + i * 5).toFixed(1)}%`)
  }
  return `linear-gradient(to bottom, ${stops.join(', ')})`
})()

/** `#rrggbb` / `#aarrggbb` → `rgba(r, g, b, alpha)`; anything else passes through untouched. */
function withAlpha(color: string, alpha: number): string {
  const hex = color.replace('#', '')
  const rgb =
    hex.length === 6
      ? hex
      : hex.length === 8 && (hex.startsWith('ff') || hex.startsWith('FF'))
        ? hex.slice(2)
        : null
  if (!rgb || !/^[0-9a-fA-F]{6}$/.test(rgb)) return color
  const r = parseInt(rgb.slice(0, 2), 16)
  const g = parseInt(rgb.slice(2, 4), 16)
  const b = parseInt(rgb.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Stable identity for a `Shape` object, so it can take part in a string signature. */
const shapeIds = new WeakMap<object, number>()
let shapeIdSeq = 0
function shapeIdOf(shape: Shape): number {
  let id = shapeIds.get(shape)
  if (id === undefined) {
    id = ++shapeIdSeq
    shapeIds.set(shape, id)
  }
  return id
}

/**
 * Style writes, de-duplicated.
 *
 * `applyLensStyle()` runs on every redraw — including every frame of a scroll — and most of what
 * it writes is unchanged each time: the transform only moves when a `layerBlock` deforms, the
 * `clip-path` only changes with the size, the `backdrop-filter` only when `effects { }` reads a
 * different value. An identical declaration still costs a style invalidation, so the last value is
 * remembered and the write is skipped. `''` means "not set" and removes the property.
 */
let lastStyle: Record<string, string | undefined> = {}
function setStyle(el: HTMLElement, property: string, value: string): void {
  if (lastStyle[property] === value) return
  lastStyle[property] = value
  if (value) el.style.setProperty(property, value)
  else el.style.removeProperty(property)
}

/** `Shape.clipPath` builds a path string; the result only depends on the shape and the box. */
let clipShape: Shape | null = null
let clipKey = ''
let clipValue = ''
function clipPathFor(shape: Shape, width: number, height: number): string {
  const key = `${width}x${height}`
  if (clipShape !== shape || clipKey !== key) {
    clipShape = shape
    clipKey = key
    clipValue = shape.clipPath(width, height)
  }
  return clipValue
}

/**
 * Everything the three decoration canvases are painted from, as one string.
 *
 * They are drawn in **element-local** space and none of their inputs is a function of where the
 * surface sits on the viewport, so a viewport move — which is every frame of a scroll — must not
 * repaint them. `animationRevision` is part of the signature because it is the project's contract
 * for "state that an `effects { }` / highlight / `onDrawSurface` closure reads has changed" (see
 * the file header): every `Animatable` bumps it, and `InteractiveHighlight` — the only decoration
 * whose drawing depends on hidden mutable state — is built entirely out of `Animatable`s.
 */
function paintSignature(): string {
  const t = currentTransform()
  const o = currentOffset()
  const h = currentHighlight()
  const s = currentShadow()
  const inner = props.innerShadow?.() ?? null
  const parts: string[] = [
    String(animationRevision.value),
    `${size.value.width}x${size.value.height}`,
    String(shapeIdOf(props.shape)),
    `t${t.translationX},${t.translationY},${t.scaleX},${t.scaleY},${t.rotationZ},${t.alpha}`,
    `o${o.x},${o.y}`,
    h
      ? `h${h.style},${h.width},${h.blurRadius},${h.alpha},${h.colorAlpha},${h.angle},${h.falloff},${h.additive}`
      : 'h-',
    s ? `s${s.radius},${s.offsetX},${s.offsetY},${s.color},${s.alpha}` : 's-',
    inner ? `i${inner.radius},${inner.offsetX},${inner.offsetY},${inner.color},${inner.alpha}` : 'i-',
    props.onDrawSurface ? 'wash' : '-',
    props.interactiveHighlight ? 'press' : '-',
    props.captureOverlay?.() ? 'capture' : '-',
    props.backdropZoom?.() ? 'zoom' : '-'
  ]
  return parts.join('|')
}

function applyLensStyle(): void {
  const el = lensEl.value
  const width = size.value.width
  const height = size.value.height
  if (!el || width <= 0 || height <= 0) return

  setStyle(el, 'clip-path', clipPathFor(props.shape, width, height))

  if (!props.backdrop.samples) {
    setStyle(el, 'backdrop-filter', '')
    setStyle(el, '-webkit-backdrop-filter', '')
    return
  }

  effectScope.reset()
  effectScope.size = { width, height }
  props.effects?.(effectScope)

  // `SdfShader`'s colour work moves inside the filter (see `RefractionSpec.colorControls`), so the
  // CSS side keeps only the blur — leaving the functions here as well would apply them twice.
  const sdf = effectScope.sdf
  const base = sdf ? effectScope.blurCss() : effectScope.backdropFilterCss()

  // `AlphaMask` runtime shader → mask + tint on this same element (see the gradient above).
  //
  // `SdfShader` wants the same property for its own reason: the shader ends with
  // `content.eval(refractedCoord) * v.a`, so the *shape's own coverage* masks the refracted
  // backdrop — and the SDF texture's alpha channel is exactly that coverage. Pointing the browser
  // at the original asset rather than at a decoded copy is deliberate: the mask is sampled at
  // full resolution, so the glyph outlines stay as sharp as the source, while the fields that go
  // through a canvas (distance, normal) are smooth by construction and lose nothing.
  //
  // One property, two sources, and they are mutually exclusive in practice, so this is a plain
  // either/or rather than a composition.
  const alphaMask = effectScope.shaderRequests.find((r) => r.key === 'AlphaMask')
  if (alphaMask) {
    const intensity = alphaMask.floats.get('tintIntensity')?.[0] ?? 0.8
    const tint = alphaMask.colors.get('tint')
    setStyle(el, '-webkit-mask-image', ALPHA_MASK_GRADIENT)
    setStyle(el, 'mask-image', ALPHA_MASK_GRADIENT)
    setStyle(el, 'background-color', tint ? withAlpha(tint, intensity) : '')
  } else if (sdf) {
    const url = `url("${sdf.texture.key}")`
    setStyle(el, '-webkit-mask-image', url)
    setStyle(el, 'mask-image', url)
    // The shader maps the whole element onto the whole texture (`p = coord / size * sdfTexSize`),
    // so the mask has to stretch to the box rather than sit at its intrinsic size and tile.
    setStyle(el, '-webkit-mask-size', '100% 100%')
    setStyle(el, 'mask-size', '100% 100%')
    setStyle(el, '-webkit-mask-repeat', 'no-repeat')
    setStyle(el, 'mask-repeat', 'no-repeat')
    setStyle(el, 'background-color', '')
  } else {
    setStyle(el, '-webkit-mask-image', '')
    setStyle(el, 'mask-image', '')
    setStyle(el, '-webkit-mask-size', '')
    setStyle(el, 'mask-size', '')
    setStyle(el, '-webkit-mask-repeat', '')
    setStyle(el, 'mask-repeat', '')
    setStyle(el, 'background-color', '')
  }

  const refraction = effectScope.refraction
  if ((!refraction && !sdf) || !glassFilter) {
    setStyle(el, 'backdrop-filter', base)
    setStyle(el, '-webkit-backdrop-filter', base)
    return
  }

  // The wash, read once. It goes in raw: the filter composites it ahead of `colorControls`, so the
  // colour matrix treats it exactly as the upstream layer does — including `saturate`, which is
  // what keeps the glyphs tinted instead of washed out.
  const wash = props.backdropWash?.() ?? null

  glassFilter.update(
    {
      width,
      height,
      cornerRadii: props.shape.cornerRadii(width, height),
      // On the SDF path this is the *displacement scale* rather than a rebuild trigger — the
      // field it scales is baked into the texture (see `RefractionSpec.sdf`).
      refractionHeight: refraction?.refractionHeight ?? sdf!.refractionHeight,
      depthEffect: refraction?.depthEffect,
      chromaticAberration: refraction?.chromaticAberration,
      sdf: sdf?.texture ?? null,
      sdfLightAngle: sdf?.lightAngle,
      wash: wash ? { color: `rgb(${wash.r}, ${wash.g}, ${wash.b})`, alpha: wash.alpha } : null,
      // A scrim only ever darkens, so the compensation only ever brightens — and `1 / (1 - a)`
      // recovers the wallpaper exactly, because `rgba(0,0,0,a)` over `W` is `(1 - a)·W`.
      backdropGain:
        props.backdropScrim != null && props.backdropScrim > 0
          ? 1 / (1 - Math.min(props.backdropScrim, 0.999))
          : undefined,
      // Must travel together with the `blurCss()` base above — one without the other either drops
      // the colour work or applies it twice.
      colorControls: sdf
        ? {
            // Upstream value, not `1 + brightness`: `BackdropEffectScope` stores the CSS
            // multiplier, and the matrix wants the additive form.
            brightness: effectScope.brightness - 1,
            contrast: effectScope.contrast,
            saturation: effectScope.saturation
          }
        : null
    },
    refraction?.refractionAmount ?? 0,
    props.backdropZoom?.() ?? null,
    props.captureOverlay?.() ?? null
  )
  // ⚠ A bare `backdrop-filter: url(#id)` is silently ignored by Chromium — the reference is
  // only honoured when a fixed filter function precedes it — so an empty base still gets a
  // no-op `blur(0px)` prefix (the magnifier lens has no blur/vibrancy of its own; without
  // the prefix its entire filter graph never runs, with no console error).
  const value = `${base || 'blur(0px)'} url(#${glassFilter.id})`
  setStyle(el, 'backdrop-filter', value)
  setStyle(el, '-webkit-backdrop-filter', value)
}

/**
 * Viewport culling. `LazyScrollContainer` renders 100 surfaces, so anything off-screen
 * releases its backing store and its filter instead of holding a GPU texture.
 */
function isVisible(): boolean {
  const r = rect.value
  if (r.width <= 0 || r.height <= 0) return false
  const vw = typeof window === 'undefined' ? 0 : window.innerWidth
  const vh = typeof window === 'undefined' ? 0 : window.innerHeight
  const margin = 96
  return (
    r.left + r.width > -margin &&
    r.left < vw + margin &&
    r.top + r.height > -margin &&
    r.top < vh + margin
  )
}

/** Sizes a canvas for `margin` of overdraw and hands back a DPR-scaled, local-space context. */
function paintCanvas(
  canvas: HTMLCanvasElement | null,
  margin: number,
  paint: (ctx: CanvasRenderingContext2D) => void
): void {
  if (!canvas) return
  const width = size.value.width
  const height = size.value.height
  const totalWidth = width + margin * 2
  const totalHeight = height + margin * 2
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const pixelWidth = Math.max(1, Math.round(totalWidth * dpr))
  const pixelHeight = Math.max(1, Math.round(totalHeight * dpr))
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, totalWidth, totalHeight)
  ctx.save()
  ctx.translate(margin, margin)
  paint(ctx)
  ctx.restore()
}

function redraw() {
  const width = size.value.width
  const height = size.value.height
  if (width <= 0 || height <= 0) return

  const visible = isVisible()
  const transform = currentTransform()

  applyLensStyle()

  if (!visible) {
    for (const canvas of [
      shadowCanvasEl.value,
      overlayCanvasEl.value,
      additiveCanvasEl.value
    ]) {
      if (canvas && canvas.width !== 0) {
        canvas.width = 0
        canvas.height = 0
      }
    }
    // The backing stores are gone, so whenever this surface comes back it must paint in full.
    lastPaintSignature = null
    lastPaintedVisible = false
    return
  }

  // The lens style above is cheap (every write in it is skipped when unchanged); the three canvas
  // paints are not, and a scroll changes nothing they depend on. See `paintSignature`.
  const signature = paintSignature()
  if (visible === lastPaintedVisible && signature === lastPaintSignature) return
  lastPaintSignature = signature
  lastPaintedVisible = true

  paintCanvas(shadowCanvasEl.value, overflow.value, (ctx) => {
    drawGlassShadow(ctx, {
      shape: props.shape,
      size: { width, height },
      margin: overflow.value,
      layerTransform: transform,
      shadow: currentShadow()
    })
  })

  paintCanvas(overlayCanvasEl.value, OVERLAY_MARGIN, (ctx) => {
    drawGlassOverlay(ctx, {
      shape: props.shape,
      size: { width, height },
      margin: OVERLAY_MARGIN,
      layerTransform: transform,
      highlight: currentHighlight(),
      onDrawSurface: props.onDrawSurface,
      innerShadow: props.innerShadow?.() ?? null
    })
  })

  paintCanvas(additiveCanvasEl.value, OVERLAY_MARGIN, (ctx) => {
    drawGlassAdditive(ctx, {
      shape: props.shape,
      size: { width, height },
      margin: OVERLAY_MARGIN,
      layerTransform: transform,
      highlight: currentHighlight(),
      interactiveHighlight: props.interactiveHighlight ?? null
    })
  })
}

/** Signature of the last full canvas paint, and whether that paint was for a visible surface. */
let lastPaintSignature: string | null = null
let lastPaintedVisible = false

function scheduleRedraw() {
  if (pending) return
  pending = requestAnimationFrame(() => {
    pending = 0
    redraw()
  })
}

let pending = 0

/**
 * Drawn synchronously from a `flush: 'post'` watcher rather than through `requestAnimationFrame`.
 * The animation loop bumps `animationRevision` from inside its own rAF callback, and Vue flushes
 * the pending jobs on the microtask that follows — still within the same frame, before paint.
 */
watch([size, rect, layoutEpoch, () => animationRevision.value], redraw, { flush: 'post' })

watch(size, scheduleRedraw, { immediate: true, flush: 'post' })

onBeforeUnmount(() => {
  if (pending) cancelAnimationFrame(pending)
})

defineExpose({ el: rootEl, lens: lensEl, redraw, scheduleRedraw, size })
</script>

<template>
  <div ref="rootEl" class="glass-surface" v-bind="$attrs">
    <canvas
      ref="shadowCanvasEl"
      class="glass-surface__shadow"
      :style="shadowBoxStyle"
      aria-hidden="true"
    />
    <div ref="lensEl" class="glass-surface__lens" :style="lensBoxStyle" aria-hidden="true" />
    <canvas
      ref="overlayCanvasEl"
      class="glass-surface__overlay"
      :style="overlayBoxStyle"
      aria-hidden="true"
    />
    <canvas
      ref="additiveCanvasEl"
      class="glass-surface__additive"
      :style="additiveBoxStyle"
      aria-hidden="true"
    />
    <div class="glass-surface__content" :class="contentClass" :style="contentStyle">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.glass-surface {
  position: relative;
  display: inline-flex;
  box-sizing: border-box;
}

.glass-surface__shadow,
.glass-surface__overlay,
.glass-surface__additive {
  position: absolute;
  pointer-events: none;
  display: block;
}

/*
 * The CSS twin of Compose's `BlendMode.Plus`, and the reason this layer exists at all: a canvas
 * cannot add to what is behind it. `globalCompositeOperation: 'lighter'` only blends inside the
 * bitmap, and the browser then composites the result with plain alpha — a lerp towards white
 * that sheds most of the highlight over a bright backdrop.
 *
 * Engines that do not know `plus-lighter` drop the declaration and fall back to `normal`, which
 * is exactly the previous behaviour; nothing breaks, it just stays flat.
 */
.glass-surface__additive {
  mix-blend-mode: plus-lighter;
}

/* Empty by design — this element exists only to carry `backdrop-filter`. */
.glass-surface__lens {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.glass-surface__content {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  box-sizing: border-box;
}
</style>
