<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import GlassSurface from './GlassSurface.vue'
import type { Backdrop, BackdropEffectScope, Highlight, Shadow } from '@/core/backdrop'
import { HighlightStyles, LayerBackdrop, ScaledBackdrop, combinedBackdrop } from '@/core/backdrop'
import { Colors, Palette, lerpColor, toCss, withAlpha } from '@/core/color'
import { DampedDragAnimation } from '@/core/damped-drag-animation'
import { coerceIn, lerp } from '@/core/math'
import { requestRedraw } from '@/core/animation'
import { dp, type LayerTransform } from '@/core/geometry'
import { Capsule } from '@/core/shapes'
import { useElementMetrics } from '@/composables/useElementMetrics'

/**
 * `LiquidToggle` — `app/src/commonMain/.../components/LiquidToggle.kt`
 *
 * Degraded (API < 31): `blur` / `lens` / `innerShadow` vanish. The track keeps its animated
 * colour, the thumb keeps its `scaleX/scaleY` squash plus the velocity skew, and — because
 * the track layer is recorded and re-scaled — the pressed thumb reveals the squashed track
 * colour behind it (`onDrawSurface` fades its white cover to 0 while pressed).
 *
 * Note the original has no `clickable`: a plain tap is handled by the drag gesture's
 * `onDragStopped` with `didDrag == false`, which flips the state. The gesture lives on the
 * 40x24 thumb, so only the thumb is interactive.
 */
const props = defineProps<{
  selected: boolean
  isLightTheme: boolean
  backdrop: Backdrop
}>()

const emit = defineEmits<{ select: [value: boolean] }>()

const rootEl = ref<HTMLElement | null>(null)
const thumb = ref<InstanceType<typeof GlassSurface> | null>(null)
const trackEl = ref<HTMLElement | null>(null)
const thumbEl = computed(() => (thumb.value?.el as HTMLElement | null) ?? null)

const DRAG_WIDTH = dp(20)
const PADDING = dp(2)

const { size: trackSize, rect: trackRect } = useElementMetrics(trackEl)

const accent = computed(() => (props.isLightTheme ? Palette.greenLight : Palette.greenDark))
const trackColor = computed(() => (props.isLightTheme ? Palette.trackLight : Palette.trackDark))
const trackFill = computed(() => toCss(lerpColor(trackColor.value, accent.value, fraction.value)))

const fraction = ref(props.selected ? 1 : 0)
let didDrag = false

const trackBackdrop = new LayerBackdrop()

const animation = new DampedDragAnimation({
  initialValue: fraction.value,
  valueRange: [0, 1],
  visibilityThreshold: 0.001,
  initialScale: 1,
  pressedScale: 1.5,
  onDragStopped: (self) => {
    if (didDrag) {
      fraction.value = self.targetValue >= 0.5 ? 1 : 0
      emit('select', fraction.value === 1)
      didDrag = false
    } else {
      fraction.value = props.selected ? 0 : 1
      emit('select', fraction.value === 1)
    }
  },
  onDrag: (_self, _size, delta) => {
    if (!didDrag) didDrag = delta.x !== 0
    fraction.value = coerceIn(fraction.value + delta.x / DRAG_WIDTH, 0, 1)
  }
})

watch(fraction, (value) => animation.updateValue(value))
watch(
  () => props.selected,
  (isSelected) => {
    const target = isSelected ? 1 : 0
    if (target !== fraction.value) {
      fraction.value = target
      animation.animateToValue(target)
    }
  }
)

const trackCapture = (ctx: CanvasRenderingContext2D, width: number, height: number): void => {
  ctx.save()
  Capsule.buildPath(ctx, width, height)
  ctx.clip()
  ctx.fillStyle = toCss(lerpColor(trackColor.value, accent.value, fraction.value))
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

const compositeBackdrop = combinedBackdrop(
  props.backdrop,
  new ScaledBackdrop(
    trackBackdrop,
    () => lerp(2 / 3, 0.75, animation.pressProgress),
    () => lerp(0, 0.75, animation.pressProgress)
  )
)

/** `layerBlock` — squash + velocity skew (this is the part inverted for the backdrop). */
function innerTransform(): LayerTransform {
  const velocity = animation.velocity / 50
  const scaleX = animation.scaleX / (1 - coerceIn(velocity * 0.75, -0.2, 0.2))
  const scaleY = animation.scaleY * (1 - coerceIn(velocity * 0.25, -0.2, 0.2))
  return { translationX: 0, translationY: 0, scaleX, scaleY, rotationZ: 0, alpha: 1 }
}

/**
 * Outer `graphicsLayer { translationX = lerp(padding, padding + dragWidth, fraction) }`.
 * It positions the thumb but is *not* inverted for the backdrop.
 */
function thumbOffset(): { x: number; y: number } {
  return { x: lerp(PADDING, PADDING + DRAG_WIDTH, fraction.value), y: 0 }
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
  scope.lens(dp(5) * progress, dp(10) * progress, false, true)
}

function onDrawSurface(ctx: CanvasRenderingContext2D, size: { width: number; height: number }) {
  ctx.fillStyle = `rgba(255, 255, 255, ${1 - animation.pressProgress})`
  ctx.fillRect(0, 0, size.width, size.height)
}

onMounted(() => {
  if (thumbEl.value) {
    const detach = animation.attach(thumbEl.value)
    onBeforeUnmount(detach)
  }
})
</script>

<template>
  <div ref="rootEl" class="liquid-toggle">
    <div ref="trackEl" class="liquid-toggle__track" :style="{ background: trackFill }" />
    <GlassSurface
      ref="thumb"
      class="liquid-toggle__thumb"
      :backdrop="compositeBackdrop"
      :shape="Capsule"
      :highlight="highlight"
      :shadow="shadow"
      :effects="effects"
      :layer-transform="innerTransform"
      :backdrop-transform="innerTransform"
      :offset="thumbOffset"
      :on-draw-surface="onDrawSurface"
    />
  </div>
</template>

<style scoped>
.liquid-toggle {
  position: relative;
  width: 64px;
  height: 28px;
}

.liquid-toggle__track {
  position: absolute;
  inset: 0;
  border-radius: 999px;
}

.liquid-toggle__thumb {
  position: absolute;
  left: 0;
  top: 2px;
  width: 40px;
  height: 24px;
}
</style>
