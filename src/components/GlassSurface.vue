<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { animationRevision } from '@/core/animation'
import { BackdropEffectScope, DefaultShadow, HighlightStyles } from '@/core/backdrop'
import type { Backdrop, Highlight, InnerShadow, Shadow } from '@/core/backdrop'
import { drawGlassAdditive, drawGlassOverlay, drawGlassShadow } from '@/core/draw-backdrop'
import { createGlassFilter, type BackdropZoom, type GlassFilterHandle } from '@/core/glass-filter'
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
  /** `innerShadow { }` — defaults to null, unlike `highlight` / `shadow`. */
  innerShadow?: () => InnerShadow | null
  /**
   * The `onDrawBackdrop { withTransform { scale; translate } }` magnification — the captured
   * backdrop is drawn at `factor×` with the translate applied, before the effects chain
   * refracts it (the upstream draw-then-refract order).
   */
  backdropZoom?: () => BackdropZoom | null
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

function applyLensStyle(): void {
  const el = lensEl.value
  const width = size.value.width
  const height = size.value.height
  if (!el || width <= 0 || height <= 0) return

  const transform = currentCssTransform()
  el.style.transform = transform === 'none' ? '' : transform
  el.style.transformOrigin = 'center'
  const alpha = currentTransform().alpha
  el.style.opacity = alpha === 1 ? '' : String(alpha)
  el.style.clipPath = props.shape.clipPath(width, height)

  if (!props.backdrop.samples) {
    el.style.backdropFilter = ''
    el.style.removeProperty('-webkit-backdrop-filter')
    return
  }

  effectScope.reset()
  effectScope.size = { width, height }
  props.effects?.(effectScope)

  const base = effectScope.backdropFilterCss()

  // `AlphaMask` runtime shader → mask + tint on this same element (see the gradient above).
  const alphaMask = effectScope.shaderRequests.find((r) => r.key === 'AlphaMask')
  if (alphaMask) {
    const intensity = alphaMask.floats.get('tintIntensity')?.[0] ?? 0.8
    const tint = alphaMask.colors.get('tint')
    el.style.setProperty('-webkit-mask-image', ALPHA_MASK_GRADIENT)
    el.style.setProperty('mask-image', ALPHA_MASK_GRADIENT)
    el.style.backgroundColor = tint ? withAlpha(tint, intensity) : ''
  } else {
    el.style.removeProperty('-webkit-mask-image')
    el.style.removeProperty('mask-image')
    el.style.backgroundColor = ''
  }

  const refraction = effectScope.refraction
  if (!refraction || !glassFilter) {
    el.style.backdropFilter = base
    el.style.setProperty('-webkit-backdrop-filter', base)
    return
  }

  glassFilter.update(
    {
      width,
      height,
      cornerRadii: props.shape.cornerRadii(width, height),
      refractionHeight: refraction.refractionHeight,
      depthEffect: refraction.depthEffect,
      chromaticAberration: refraction.chromaticAberration
    },
    refraction.refractionAmount,
    props.backdropZoom?.() ?? null
  )
  // ⚠ A bare `backdrop-filter: url(#id)` is silently ignored by Chromium — the reference is
  // only honoured when a fixed filter function precedes it — so an empty base still gets a
  // no-op `blur(0px)` prefix (the magnifier lens has no blur/vibrancy of its own; without
  // the prefix its entire filter graph never runs, with no console error).
  const value = `${base || 'blur(0px)'} url(#${glassFilter.id})`
  el.style.backdropFilter = value
  el.style.setProperty('-webkit-backdrop-filter', value)
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
    return
  }

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
    <div ref="lensEl" class="glass-surface__lens" aria-hidden="true" />
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
