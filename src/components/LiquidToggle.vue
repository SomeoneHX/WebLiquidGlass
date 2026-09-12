<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import GlassSurface from './GlassSurface.vue'
import type { Backdrop, BackdropEffectScope, Highlight, Shadow } from '@/core/backdrop'
import { HighlightStyles } from '@/core/backdrop'
import { Colors, Palette, lerpColor, toCss, withAlpha } from '@/core/color'
import { DampedDragAnimation } from '@/core/damped-drag-animation'
import { coerceIn, lerp } from '@/core/math'
import { dp, type LayerTransform } from '@/core/geometry'
import { Capsule } from '@/core/shapes'

/**
 * `LiquidToggle` — `app/src/commonMain/.../components/LiquidToggle.kt`
 *
 * The track is a plain DOM capsule sitting *behind* the thumb, so the thumb's
 * `backdrop-filter` picks it up for free — there is no recorded track layer any more. The
 * Kotlin original additionally re-scaled that captured track by 0.75 while pressed; dropping
 * it costs nothing visually, because the track is a flat colour
 * (`lerpColor(trackColor, accent, fraction)`) and flat colour is scale-invariant.
 *
 * What still carries the deformation: `innerTransform` squashes the thumb through its
 * `layerBlock` (plus a velocity skew), and because the backdrop is captured by the browser
 * and inverse-transformed, the track seen through the thumb stays pinned to the screen while
 * the capsule stretches. `onDrawSurface` fades the white cover to 0 while pressed so the
 * track shows through.
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

const thumb = ref<InstanceType<typeof GlassSurface> | null>(null)
const thumbEl = computed(() => (thumb.value?.el as HTMLElement | null) ?? null)

const DRAG_WIDTH = dp(20)
const PADDING = dp(2)

const accent = computed(() => (props.isLightTheme ? Palette.greenLight : Palette.greenDark))
const trackColor = computed(() => (props.isLightTheme ? Palette.trackLight : Palette.trackDark))
const trackFill = computed(() => toCss(lerpColor(trackColor.value, accent.value, fraction.value)))

const fraction = ref(props.selected ? 1 : 0)
let didDrag = false

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

/** `layerBlock` — squash + velocity skew, applied to the thumb shape by the browser's capture. */
function innerTransform(): LayerTransform {
  const velocity = animation.velocity / 50
  const scaleX = animation.scaleX / (1 - coerceIn(velocity * 0.75, -0.2, 0.2))
  const scaleY = animation.scaleY * (1 - coerceIn(velocity * 0.25, -0.2, 0.2))
  return { translationX: 0, translationY: 0, scaleX, scaleY, rotationZ: 0, alpha: 1 }
}

/** Outer `graphicsLayer { translationX = lerp(padding, padding + dragWidth, fraction) }`. */
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
  <div class="liquid-toggle">
    <div class="liquid-toggle__track" :style="{ background: trackFill }" />
    <GlassSurface
      ref="thumb"
      class="liquid-toggle__thumb"
      :backdrop="backdrop"
      :shape="Capsule"
      :highlight="highlight"
      :shadow="shadow"
      :effects="effects"
      :layer-transform="innerTransform"
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
