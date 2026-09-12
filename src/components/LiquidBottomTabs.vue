<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import GlassSurface from './GlassSurface.vue'
import type { Backdrop, BackdropEffectScope, Highlight, Shadow } from '@/core/backdrop'
import { HighlightStyles } from '@/core/backdrop'
import { Colors, Palette, toCss, withAlpha } from '@/core/color'
import { Animatable, spring } from '@/core/animation'
import { DampedDragAnimation } from '@/core/damped-drag-animation'
import { EaseOut, coerceIn, lerp, sign } from '@/core/math'
import { dp, type LayerTransform } from '@/core/geometry'
import { Capsule } from '@/core/shapes'
import { InteractiveHighlight } from '@/core/interactive-highlight'
import { useElementMetrics } from '@/composables/useElementMetrics'
import { useFrameValue } from '@/composables/useFrameValue'

/**
 * `LiquidBottomTabs` — `app/src/commonMain/.../components/LiquidBottomTabs.kt`
 *
 * Two glass surfaces:
 *  1. the container — a 64 dp capsule, its `onDrawSurface` washing it 40 % white/black, with
 *     the tab row as its content;
 *  2. the indicator — a sibling of the container (never a child: `backdrop-filter` makes an
 *     element a backdrop root, so a nested indicator would stop seeing the wallpaper). Being a
 *     sibling means it captures wallpaper *and* container for free.
 *
 * The Kotlin build kept a third, hidden accent-tinted row and recorded it into `tabsBackdrop`
 * so the indicator could sample solid accent. That recorded layer is gone; the same picture is
 * painted directly onto the indicator's surface instead.
 */
const props = defineProps<{
  selectedIndex: number
  tabsCount: number
  isLightTheme: boolean
  backdrop: Backdrop
}>()

const emit = defineEmits<{ select: [index: number] }>()

const rootEl = ref<HTMLElement | null>(null)
const indicator = ref<InstanceType<typeof GlassSurface> | null>(null)
const indicatorEl = computed(() => (indicator.value?.el as HTMLElement | null) ?? null)

const { size: rootSize } = useElementMetrics(rootEl)

const accent = computed(() => (props.isLightTheme ? Palette.blueLight : Palette.blueDark))
const containerColor = computed(() =>
  props.isLightTheme ? 'rgba(250, 250, 250, 0.4)' : 'rgba(18, 18, 18, 0.4)'
)

const tabWidth = computed(() => (rootSize.value.width - dp(8)) / props.tabsCount)
const maxWidth = computed(() => Math.max(1, rootSize.value.width))

const panelOffsetAnimation = new Animatable(0)
const panelOffset = useFrameValue(() => {
  const fraction = coerceIn(panelOffsetAnimation.value / maxWidth.value, -1, 1)
  return dp(4) * sign(fraction) * EaseOut.transform(Math.abs(fraction))
})

const currentIndex = ref(props.selectedIndex)
let didDragIndex = false

const animation = new DampedDragAnimation({
  initialValue: props.selectedIndex,
  valueRange: [0, Math.max(0, props.tabsCount - 1)],
  visibilityThreshold: 0.001,
  initialScale: 1,
  pressedScale: 78 / 56,
  onDragStopped: (self) => {
    const target = coerceIn(Math.round(self.targetValue), 0, props.tabsCount - 1)
    currentIndex.value = target
    self.animateToValue(target)
    void panelOffsetAnimation.animateTo(0, spring(1, 300, 0.5))
  },
  onDrag: (self, _size, delta) => {
    didDragIndex = delta.x !== 0
    self.updateValue(
      coerceIn(self.targetValue + (delta.x / tabWidth.value), 0, props.tabsCount - 1)
    )
    panelOffsetAnimation.snapTo(panelOffsetAnimation.value + delta.x)
  }
})

watch(
  () => props.selectedIndex,
  (index) => {
    currentIndex.value = index
  }
)

watch(currentIndex, (index) => {
  if (didDragIndex) didDragIndex = false
  animation.animateToValue(index)
  emit('select', index)
})

const interactiveHighlight = new InteractiveHighlight({
  position: (size) => ({
    x: (animation.value + 0.5) * tabWidth.value + panelOffset.value,
    y: size.height / 2
  })
})

/** Container / indicator share the same squash + velocity skew. */
function innerTransform(): LayerTransform {
  const velocity = animation.velocity / 10
  const scaleX = animation.scaleX / (1 - coerceIn(velocity * 0.75, -0.2, 0.2))
  const scaleY = animation.scaleY * (1 - coerceIn(velocity * 0.25, -0.2, 0.2))
  return { translationX: 0, translationY: 0, scaleX, scaleY, rotationZ: 0, alpha: 1 }
}

/**
 * Container: `graphicsLayer { translationX = panelOffset }` **then** `drawBackdrop` with a
 * press-driven scale. The translation is a position-only offset; the scale is the `layerBlock`.
 */
function containerTransform(): LayerTransform {
  const width = Math.max(1, rootSize.value.width)
  const progress = animation.pressProgress
  const scale = lerp(1, 1 + dp(16) / width, progress)
  return { translationX: 0, translationY: 0, scaleX: scale, scaleY: scale, rotationZ: 0, alpha: 1 }
}

function containerOffset(): { x: number; y: number } {
  return { x: panelOffset.value, y: 0 }
}

/** Indicator: `graphicsLayer { translationX = value * tabWidth + panelOffset }` then block. */
const indicatorTranslation = useFrameValue(
  () => animation.value * tabWidth.value + panelOffset.value
)

function indicatorOffset(): { x: number; y: number } {
  return { x: indicatorTranslation.value, y: 0 }
}

const containerHighlight = (): Highlight | null => HighlightStyles.Default(1)

const containerShadow = (): Shadow | null => null

const containerEffects = (scope: BackdropEffectScope): void => {
  scope.vibrancy()
  scope.blur(dp(8))
  scope.lens(dp(24), dp(24))
}

const indicatorHighlight = (): Highlight | null =>
  HighlightStyles.Default(animation.pressProgress)

const indicatorShadow = (): Shadow | null => ({
  ...defaultShadowSpec,
  alpha: animation.pressProgress
})

const defaultShadowSpec: Shadow = {
  radius: dp(24),
  offsetX: 0,
  offsetY: dp(24) / 6,
  color: toCss(withAlpha(Colors.Black, 0.1)),
  alpha: 1
}

const indicatorEffects = (scope: BackdropEffectScope): void => {
  const progress = animation.pressProgress
  scope.lens(dp(10) * progress, dp(14) * progress, false, true)
}

function onContainerSurface(ctx: CanvasRenderingContext2D, size: { width: number; height: number }) {
  ctx.fillStyle = containerColor.value
  ctx.fillRect(0, 0, size.width, size.height)
}

function onIndicatorSurface(
  ctx: CanvasRenderingContext2D,
  size: { width: number; height: number }
) {
  const progress = animation.pressProgress
  // Stands in for the recorded accent row the Kotlin indicator sampled (`tabsBackdrop`).
  ctx.fillStyle = toCss(accent.value)
  ctx.fillRect(0, 0, size.width, size.height)
  ctx.save()
  ctx.globalAlpha = 1 - progress
  ctx.fillStyle = props.isLightTheme ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.1)'
  ctx.fillRect(0, 0, size.width, size.height)
  ctx.restore()
  ctx.save()
  ctx.fillStyle = `rgba(0, 0, 0, ${0.03 * progress})`
  ctx.fillRect(0, 0, size.width, size.height)
  ctx.restore()
}

onMounted(() => {
  if (indicatorEl.value) {
    const detachDrag = animation.attach(indicatorEl.value)
    const detachHighlight = interactiveHighlight.attach(indicatorEl.value)
    onBeforeUnmount(() => {
      detachDrag()
      detachHighlight()
    })
  }
})
</script>

<template>
  <div ref="rootEl" class="liquid-bottom-tabs">
    <GlassSurface
      class="liquid-bottom-tabs__container"
      content-class="liquid-bottom-tabs__row"
      :backdrop="backdrop"
      :shape="Capsule"
      :highlight="containerHighlight"
      :shadow="containerShadow"
      :effects="containerEffects"
      :layer-transform="containerTransform"
      :offset="containerOffset"
      :on-draw-surface="onContainerSurface"
      :interactive-highlight="interactiveHighlight"
    >
      <slot name="tabs" />
    </GlassSurface>

    <GlassSurface
      ref="indicator"
      class="liquid-bottom-tabs__indicator"
      :style="{ left: `${dp(4)}px`, width: `${tabWidth}px` }"
      :backdrop="backdrop"
      :shape="Capsule"
      :highlight="indicatorHighlight"
      :shadow="indicatorShadow"
      :effects="indicatorEffects"
      :layer-transform="innerTransform"
      :offset="indicatorOffset"
      :on-draw-surface="onIndicatorSurface"
    />
  </div>
</template>

<style scoped>
.liquid-bottom-tabs {
  position: relative;
  width: 100%;
  height: 64px;
}

.liquid-bottom-tabs__container {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 64px;
}

.liquid-bottom-tabs__indicator {
  position: absolute;
  top: 4px;
  height: 56px;
  pointer-events: auto;
  touch-action: none;
}
</style>
