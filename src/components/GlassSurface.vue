<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { animationRevision } from '@/core/animation'
import { DefaultShadow, HighlightStyles } from '@/core/backdrop'
import type {
  Backdrop,
  BackdropDrawContext,
  BackdropEffectScope,
  Highlight,
  Shadow
} from '@/core/backdrop'
import { drawBackdrop } from '@/core/draw-backdrop'
import { identityTransform, layerTransformToCss, type LayerTransform, type Size } from '@/core/geometry'
import type { InteractiveHighlight } from '@/core/interactive-highlight'
import type { Shape } from '@/core/shapes'
import { layoutEpoch, useElementMetrics } from '@/composables/useElementMetrics'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  /** The backdrop the glass samples. */
  backdrop: Backdrop
  shape: Shape
  /** The `layerBlock` — deformation: translation / scale / rotation / alpha. */
  layerTransform?: () => LayerTransform
  /**
   * The `layerBlock` whose inverse the backdrop applies. Defaults to `layerTransform`;
   * components that position themselves with a *separate* outer `graphicsLayer` (the
   * toggle thumb, the bottom-tabs indicator, …) pass only the inner block here.
   */
  backdropTransform?: () => LayerTransform
  /**
   * A position-only translation applied by a *separate* outer `graphicsLayer` (the slider
   * thumb, the bottom-tabs indicator, …). Unlike `layerTransform` it is **not** inverted
   * when the backdrop is sampled — the surface genuinely moved, so it must sample the
   * region it now covers.
   */
  offset?: () => { x: number; y: number }
  /** `effects { ... }` — recorded but inert in the degraded (API < 31) build. */
  effects?: (scope: BackdropEffectScope) => void
  /** `highlight = { ... }`; defaults to `Highlight.Default` when omitted. Pass `() => null` to disable. */
  highlight?: () => Highlight | null
  /** `shadow = { ... }`; defaults to `Shadow.Default` when omitted. Pass `() => null` to disable. */
  shadow?: () => Shadow | null
  /** `onDrawSurface = { drawRect(...) }` */
  onDrawSurface?: (ctx: CanvasRenderingContext2D, size: Size) => void
  /** `onDrawBackdrop = { drawBackdrop -> ... }` */
  onDrawBackdrop?: (
    ctx: CanvasRenderingContext2D,
    draw: () => void,
    dc: BackdropDrawContext
  ) => void
  /** Drives the press wash + (in the full build) the radial highlight. */
  interactiveHighlight?: InteractiveHighlight | null
  /** Extra class on the clip/transform layer that wraps the slot. */
  contentClass?: string
}>()

const rootEl = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const { size, rect } = useElementMetrics(rootEl)

/**
 * The animation values live outside Vue's reactivity (they are plain JS objects that are
 * stepped by the shared frame loop), so the transform is pulled fresh on every read and
 * `animationRevision` is the signal that invalidates the DOM style + canvas.
 */
function currentTransform(): LayerTransform {
  return props.layerTransform?.() ?? identityTransform
}

function currentOffset(): { x: number; y: number } {
  return props.offset?.() ?? { x: 0, y: 0 }
}

/**
 * `drawBackdrop`'s library defaults. A call site that omits `highlight` / `shadow` gets
 * `Highlight.Default` (0.5 dp inner ring) and `Shadow.Default` (24 dp blur, 4 dp down,
 * 10 % black) — *not* "nothing". In the catalog only `ControlCenterContent` opts out of the
 * shadow (it passes `shadow = null`), and nothing opts out of the highlight.
 */
function currentHighlight(): Highlight | null {
  return props.highlight ? props.highlight() : HighlightStyles.Default()
}

function currentShadow(): Shadow | null {
  return props.shadow ? props.shadow() : DefaultShadow
}

/** The canvas is enlarged so that shadows can spill outside the element box. */
const overflow = computed(() => {
  void animationRevision.value
  const shadow = currentShadow()
  if (!shadow) return 0
  return Math.ceil(
    2 * shadow.radius + Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY)) + 2
  )
})

/**
 * The canvas box is shifted by `offset` together with the content, so the glass and the
 * content travel as one unit. `drawBackdrop` therefore draws at its local origin.
 */
const canvasStyle = computed(() => {
  void animationRevision.value
  const margin = overflow.value
  const offset = currentOffset()
  return {
    left: `${-margin + offset.x}px`,
    top: `${-margin + offset.y}px`,
    width: `calc(100% + ${margin * 2}px)`,
    height: `calc(100% + ${margin * 2}px)`
  }
})

const contentStyle = computed(() => {
  void animationRevision.value
  const t = currentTransform()
  const offset = currentOffset()
  const shapeTransform = layerTransformToCss(t)
  // The outer `graphicsLayer { translationX = … }` is position-only: it is prepended here
  // instead of being folded into the (backdrop-inverted) `layerTransform`.
  const transform =
    offset.x !== 0 || offset.y !== 0
      ? `translate(${offset.x}px, ${offset.y}px)` +
        (shapeTransform === 'none' ? '' : ` ${shapeTransform}`)
      : shapeTransform
  const width = size.value.width
  const height = size.value.height
  const style: Record<string, string> = {
    transform,
    transformOrigin: 'center'
  }
  if (t.alpha !== 1) style.opacity = String(t.alpha)
  if (width > 0 && height > 0) style.clipPath = props.shape.clipPath(width, height)
  return style
})

let pending = 0

/**
 * Viewport culling. `LazyScrollContainer` renders 100 surfaces, so anything off-screen
 * releases its backing store entirely instead of holding a GPU texture.
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

function redraw() {
  const canvas = canvasEl.value
  const width = size.value.width
  const height = size.value.height
  if (!canvas || width <= 0 || height <= 0) return

  if (!isVisible()) {
    if (canvas.width !== 0) {
      canvas.width = 0
      canvas.height = 0
    }
    return
  }

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const margin = overflow.value
  const totalWidth = width + margin * 2
  const totalHeight = height + margin * 2
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
  const offset = currentOffset()
  drawBackdrop(ctx, {
    backdrop: props.backdrop,
    shape: props.shape,
    size: { width, height },
    elementRect: {
      left: rect.value.left + offset.x,
      top: rect.value.top + offset.y,
      width,
      height
    },
    layerTransform: currentTransform(),
    backdropLayerTransform: props.backdropTransform ? props.backdropTransform() : undefined,
    effects: props.effects,
    highlight: currentHighlight(),
    shadow: currentShadow(),
    onDrawSurface: props.onDrawSurface,
    onDrawBackdrop: props.onDrawBackdrop,
    interactiveHighlight: props.interactiveHighlight ?? null
  })
  ctx.restore()
}

function scheduleRedraw() {
  if (pending) return
  pending = requestAnimationFrame(() => {
    pending = 0
    redraw()
  })
}

/**
 * Drawn synchronously from a `flush: 'post'` watcher rather than through
 * `requestAnimationFrame`. The animation loop bumps `animationRevision` from inside its own
 * rAF callback, and Vue flushes the pending jobs on the microtask that follows — still
 * within the same frame, before paint. Redrawing here keeps the canvas glass in lockstep
 * with the DOM content; deferring to yet another rAF would leave the glass one frame behind
 * the content while dragging.
 */
watch([size, rect, layoutEpoch, () => animationRevision.value], redraw, { flush: 'post' })

watch(size, scheduleRedraw, { immediate: true, flush: 'post' })

onBeforeUnmount(() => {
  if (pending) cancelAnimationFrame(pending)
})

defineExpose({ el: rootEl, canvas: canvasEl, redraw, scheduleRedraw, size })
</script>

<template>
  <div ref="rootEl" class="glass-surface" v-bind="$attrs">
    <canvas ref="canvasEl" class="glass-surface__canvas" :style="canvasStyle" aria-hidden="true" />
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

.glass-surface__canvas {
  position: absolute;
  pointer-events: none;
  display: block;
}

.glass-surface__content {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  box-sizing: border-box;
}
</style>
