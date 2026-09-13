<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import GlassSurface from './GlassSurface.vue'
import type { Backdrop, BackdropEffectScope, Highlight, Shadow } from '@/core/backdrop'
import { HighlightStyles, innerShadow } from '@/core/backdrop'
import { Colors, toCss, withAlpha } from '@/core/color'
import { Animatable, spring } from '@/core/animation'
import { DampedDragAnimation } from '@/core/damped-drag-animation'
import { EaseOut, coerceIn, sign } from '@/core/math'
import { dp, type LayerTransform } from '@/core/geometry'
import { Capsule } from '@/core/shapes'
import { InteractiveHighlight } from '@/core/interactive-highlight'
import { useElementMetrics } from '@/composables/useElementMetrics'
import { useFrameValue } from '@/composables/useFrameValue'

/**
 * `LiquidBottomTabs` — `app/src/commonMain/.../components/LiquidBottomTabs.kt`
 *
 * Two glass surfaces, indicator parameters matching the Kotlin original 1:1:
 *  1. the container — a 64 dp capsule washed 40 % white/black, tab row as content;
 *  2. the indicator — a sibling GlassSurface (never a child: `backdrop-filter` makes an
 *     element a backdrop root) with press-driven lens(10, 14, chromatic), highlight,
 *     shadow, inner shadow, squash + velocity skew, and the panel offset during drag.
 *
 * **Simplified vs the Kotlin original (by request):** the hidden accent-tinted row and its
 * recording (`tabsBackdrop`) are gone — no `captureOverlay` snapshot, no evenodd clip carving
 * the row under the pill. The lens simply refracts the *actual* bar content behind it, and
 * selection colour lives with the tab content (accent when selected) in `BottomTabsContent.vue`.
 */
const props = defineProps<{
  selectedIndex: number
  tabsCount: number
  isLightTheme: boolean
  backdrop: Backdrop
}>()

const emit = defineEmits<{ select: [index: number] }>()

const rootEl = ref<HTMLElement | null>(null)

const { size: rootSize } = useElementMetrics(rootEl)

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
  animation.animateToValue(index)
  emit('select', index)
})

const interactiveHighlight = new InteractiveHighlight({
  position: (size) => ({
    x: (animation.value + 0.5) * tabWidth.value + panelOffset.value,
    y: size.height / 2
  })
})

/** Container / indicator share the same squash + velocity skew (`layerBlock`). */
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
  const scale = 1 + (dp(16) / width) * progress
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
  // The lens is kept alive at rest (0.01 dp ≈ nothing) so the filter graph stays active even
  // when nothing refracts — `lens(10·p, 14·p, chromaticAberration = true)` upstream.
  scope.lens(Math.max(dp(10) * progress, 0.01), Math.max(dp(14) * progress, 0.01), false, true)
}

const indicatorInnerShadow = () => {
  const progress = animation.pressProgress
  return innerShadow(dp(8) * progress, 0, dp(8) * progress, 'rgba(0, 0, 0, 0.15)', progress)
}

function onContainerSurface(ctx: CanvasRenderingContext2D, size: { width: number; height: number }) {
  ctx.fillStyle = containerColor.value
  ctx.fillRect(0, 0, size.width, size.height)
}

/** Indicator surface: the 10 % wash fading out on press + the 3 % black deepen — nothing else. */
function onIndicatorSurface(
  ctx: CanvasRenderingContext2D,
  size: { width: number; height: number }
) {
  const progress = animation.pressProgress
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
  if (rootEl.value) {
    /*
     * The gestures live on the whole bar, gated to the indicator's cell: Chromium gives
     * pointer events to the TOPMOST element, so a `pointer-events: auto` indicator would
     * swallow clicks on the selected tab. With the indicator transparent to pointers, taps
     * land on the tabs underneath and the press/drag deformation still starts exactly at
     * the indicator's cell.
     */
    const inIndicatorCell = (position: { x: number; y: number }): boolean => {
      const left = dp(4) + indicatorTranslation.value
      return position.x >= left && position.x <= left + tabWidth.value
    }
    const detachDrag = animation.attach(rootEl.value, undefined, inIndicatorCell)
    const detachHighlight = interactiveHighlight.attach(rootEl.value, undefined, inIndicatorCell)
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
      class="liquid-bottom-tabs__indicator"
      :style="{ left: `${dp(4)}px`, width: `${tabWidth}px` }"
      :backdrop="backdrop"
      :shape="Capsule"
      :highlight="indicatorHighlight"
      :shadow="indicatorShadow"
      :effects="indicatorEffects"
      :inner-shadow="indicatorInnerShadow"
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
  /* Gestures are attached to this root (gated to the indicator's cell) — panning is ours. */
  touch-action: none;
}

.liquid-bottom-tabs__container {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 64px;
}

/* Transparent to pointers: taps fall through to the tabs underneath (see onMounted). */
.liquid-bottom-tabs__indicator {
  position: absolute;
  top: 4px;
  height: 56px;
  pointer-events: none;
  touch-action: none;
}
</style>
