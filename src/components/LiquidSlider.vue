<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import GlassSurface from './GlassSurface.vue'
import type { Backdrop, BackdropEffectScope, Highlight, Shadow } from '@/core/backdrop'
import { HighlightStyles, LayerBackdrop, ScaledBackdrop, combinedBackdrop } from '@/core/backdrop'
import { Colors, Palette, toCss, withAlpha } from '@/core/color'
import { DampedDragAnimation } from '@/core/damped-drag-animation'
import { coerceIn, lerp } from '@/core/math'
import { requestRedraw } from '@/core/animation'
import { dp, type LayerTransform } from '@/core/geometry'
import { Capsule } from '@/core/shapes'
import { useElementMetrics } from '@/composables/useElementMetrics'
import { useFrameValue } from '@/composables/useFrameValue'

/**
 * `LiquidSlider` — `app/src/commonMain/.../components/LiquidSlider.kt`
 *
 * Degraded (API < 31): the track fill and the thumb still animate, and the thumb still
 * squashes/stretches with drag velocity; only the blur/refraction/inner-shadow layers are
 * missing.
 *
 * Modifier order in the original:
 * ```
 * graphicsLayer { translationX = -w/2 + trackWidth * progress   }   // position only
 *   pointerInput { inspectDragGestures }                            // the drag
 *     drawBackdrop(layerBlock = { scaleX/scaleY + velocity skew })   // the deformation
 * ```
 * The `translationX` lives *outside* `drawBackdrop`, so it is a genuine position change:
 * the thumb must end up sampling the wallpaper region it actually covers. That is exactly
 * what the `offset` prop on `GlassSurface` expresses, while the scale stays in
 * `layerTransform` (and is therefore inverted for the backdrop, which is what makes the
 * squash readable — the image behind stays put while the capsule stretches).
 */
const props = defineProps<{
  value: number
  valueRange: [number, number]
  visibilityThreshold: number
  isLightTheme: boolean
  backdrop: Backdrop
}>()

const emit = defineEmits<{ change: [value: number] }>()

const rootEl = ref<HTMLElement | null>(null)
const thumb = ref<InstanceType<typeof GlassSurface> | null>(null)
const trackEl = ref<HTMLElement | null>(null)

const { size: rootSize } = useElementMetrics(rootEl)
const { size: trackSize, rect: trackRect } = useElementMetrics(trackEl)

const accent = computed(() => (props.isLightTheme ? Palette.blueLight : Palette.blueDark))
const trackColor = computed(() => (props.isLightTheme ? Palette.trackLight : Palette.trackDark))

const trackWidth = computed(() => rootSize.value.width)

let didDrag = false

const trackBackdrop = new LayerBackdrop()

function rangeDelta(): number {
  return props.valueRange[1] - props.valueRange[0]
}

function clampToRange(value: number): number {
  return coerceIn(value, props.valueRange[0], props.valueRange[1])
}

const animation = new DampedDragAnimation({
  initialValue: props.value,
  valueRange: props.valueRange,
  visibilityThreshold: props.visibilityThreshold,
  initialScale: 1,
  pressedScale: 1.5,
  onDragStopped: (self) => {
    if (didDrag) emit('change', self.targetValue)
  },
  onDrag: (_self, _size, delta) => {
    if (!didDrag) didDrag = delta.x !== 0
    const width = trackWidth.value
    if (width <= 0) return
    const amount = rangeDelta() * (delta.x / width)
    emit('change', clampToRange(animation.targetValue + amount))
  }
})

watch(
  () => props.value,
  (value) => {
    if (animation.targetValue !== value) animation.updateValue(value)
  }
)

/* ------------------------------------------------------------------ track tap --------- */
/** `detectTapGestures { position -> ... }` — resolves on tap-up, within touch slop. */
let tapStart: { x: number; y: number; id: number } | null = null

function onTrackPointerDown(event: PointerEvent) {
  tapStart = { x: event.clientX, y: event.clientY, id: event.pointerId }
}

function onTrackPointerUp(event: PointerEvent) {
  const start = tapStart
  tapStart = null
  if (!start || start.id !== event.pointerId) return
  const slop = 8
  if (Math.abs(event.clientX - start.x) > slop || Math.abs(event.clientY - start.y) > slop) return
  const rect = trackEl.value?.getBoundingClientRect()
  if (!rect || rect.width <= 0) return
  const positionX = event.clientX - rect.left
  const target = clampToRange(props.valueRange[0] + rangeDelta() * (positionX / rect.width))
  animation.animateToValue(target)
  emit('change', target)
}

/* ------------------------------------------------------------------ rendering --------- */
const fillWidth = useFrameValue(() => `${(trackWidth.value * animation.progress).toFixed(2)}px`)

/** `(-size.width / 2 + trackWidth * progress).coerceIn(-size.width / 4, trackWidth - size.width * 3 / 4)` */
const thumbOffset = useFrameValue(() => {
  const width = thumb.value?.size.width ?? dp(40)
  const width0 = trackWidth.value
  const raw = -width / 2 + width0 * animation.progress
  return Math.round(coerceIn(raw, -width / 4, width0 - (width * 3) / 4) * 100) / 100
})

function thumbOffsetVector(): { x: number; y: number } {
  return { x: thumbOffset.value, y: 0 }
}

const trackCapture = (ctx: CanvasRenderingContext2D, width: number, height: number): void => {
  ctx.save()
  Capsule.buildPath(ctx, width, height)
  ctx.clip()
  ctx.fillStyle = toCss(trackColor.value)
  ctx.fillRect(0, 0, width, height)
  ctx.restore()
}

watch(
  [trackSize, trackRect],
  () => {
    const { width, height } = trackSize.value
    if (width <= 0 || height <= 0) return
    trackBackdrop.configure(width, height, trackCapture, true)
    trackBackdrop.setRect(trackRect.value)
    // The recorded track just became available — the thumb has to re-sample it.
    requestRedraw()
  },
  { immediate: true, flush: 'post' }
)

/**
 * `rememberCombinedBackdrop(backdrop, rememberBackdrop(trackBackdrop) { scale(...) { drawBackdrop() } })`
 * — the track's own 6 dp fill is part of what the thumb samples, scaled for the press.
 */
const compositeBackdrop = combinedBackdrop(
  props.backdrop,
  new ScaledBackdrop(
    trackBackdrop,
    () => lerp(2 / 3, 1, animation.pressProgress),
    () => lerp(0, 1, animation.pressProgress)
  )
)

/** `layerBlock = { scaleX/scaleY + velocity skew }` — the whole deformation. */
function layerTransform(): LayerTransform {
  const velocity = animation.velocity / 10
  const scaleX = animation.scaleX / (1 - coerceIn(velocity * 0.75, -0.2, 0.2))
  const scaleY = animation.scaleY * (1 - coerceIn(velocity * 0.25, -0.2, 0.2))
  return { translationX: 0, translationY: 0, scaleX, scaleY, rotationZ: 0, alpha: 1 }
}

const highlight = (): Highlight | null => {
  const base = HighlightStyles.Ambient(animation.pressProgress)
  return { ...base, width: base.width / 1.5, blurRadius: base.blurRadius / 1.5 }
}

const shadow = (): Shadow | null => ({
  radius: dp(4),
  offsetX: 0,
  offsetY: dp(4) / 6,
  color: toCss(withAlpha(Colors.Black, 0.05)),
  alpha: 1
})

const effects = (scope: BackdropEffectScope): void => {
  const progress = animation.pressProgress
  scope.blur(dp(8) * (1 - progress))
  scope.lens(dp(10) * progress, dp(14) * progress, false, true)
}

function onDrawSurface(ctx: CanvasRenderingContext2D, size: { width: number; height: number }) {
  ctx.fillStyle = `rgba(255, 255, 255, ${1 - animation.pressProgress})`
  ctx.fillRect(0, 0, size.width, size.height)
}

onMounted(() => {
  const el = thumb.value?.el as HTMLElement | null
  if (el) {
    const detach = animation.attach(el)
    onBeforeUnmount(detach)
  }
})
</script>

<template>
  <div ref="rootEl" class="liquid-slider">
    <div
      ref="trackEl"
      class="liquid-slider__track"
      @pointerdown="onTrackPointerDown"
      @pointerup="onTrackPointerUp"
      @pointercancel="tapStart = null"
    >
      <div class="liquid-slider__fill" :style="{ width: fillWidth, background: toCss(accent) }" />
    </div>
    <GlassSurface
      ref="thumb"
      class="liquid-slider__thumb"
      :backdrop="compositeBackdrop"
      :shape="Capsule"
      :highlight="highlight"
      :shadow="shadow"
      :effects="effects"
      :layer-transform="layerTransform"
      :offset="thumbOffsetVector"
      :on-draw-surface="onDrawSurface"
    />
  </div>
</template>

<style scoped>
.liquid-slider {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  height: 24px;
}

.liquid-slider__track {
  position: absolute;
  left: 0;
  right: 0;
  top: 9px;
  height: 6px;
  border-radius: 999px;
  background: rgba(120, 120, 120, 0.2);
  overflow: hidden;
  touch-action: none;
}

.liquid-slider__fill {
  height: 100%;
  border-radius: 999px;
}

.liquid-slider__thumb {
  position: absolute;
  left: 0;
  top: 0;
  width: 40px;
  height: 24px;
}
</style>
