<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import GlassSurface from './GlassSurface.vue'
import { FlightIconPath } from '@/core/assets'
import type { Backdrop, BackdropEffectScope, Highlight, Shadow } from '@/core/backdrop'
import { HighlightStyles, innerShadow } from '@/core/backdrop'
import { Colors, Palette, toCss, withAlpha } from '@/core/color'
import { Animatable, spring } from '@/core/animation'
import { DampedDragAnimation } from '@/core/damped-drag-animation'
import { EaseOut, coerceIn, lerp, sign } from '@/core/math'
import { dp, type LayerTransform } from '@/core/geometry'
import { Capsule } from '@/core/shapes'
import type { CaptureOverlay } from '@/core/glass-filter'
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
  // The lens is kept alive at rest (0.01 dp ≈ nothing) so the filter graph — and with it the
  // accent strip composited by `captureOverlay` — stays active even when nothing refracts.
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

/**
 * The indicator's surface washes only — the accent-tinted content (icon + label per cell)
 * reaches the pill through `captureOverlay`: a static snapshot of the hidden accent row
 * (`tabsBackdrop` + `ColorFilter.tint(accentColor)` upstream), composited into the pill's
 * capture inside the filter graph, so the pill's lens refraction and chromatic aberration
 * bend it exactly like the upstream sample.
 */
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

/**
 * Static snapshot of the hidden accent row: every cell's icon + label tinted accent. Only
 * regenerated when the strip's content or geometry changes (theme / width / tab count) —
 * never per frame, so the filter's `feImage` href stays stable while the pill slides.
 */
const accentSnapshot = ref<{ url: string; width: number; height: number } | null>(null)

function drawAccentSnapshot(): void {
  const w = Math.max(1, rootSize.value.width - dp(8))
  const h = dp(56)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w)
  canvas.height = Math.round(h)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const cell = w / props.tabsCount
  const accentCss = toCss(accent.value)
  const iconSize = dp(28)
  const labelSize = dp(12)
  const gap = dp(2)
  ctx.fillStyle = accentCss
  ctx.font = `${labelSize}px ${getComputedStyle(document.body).fontFamily}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < props.tabsCount; i++) {
    const cx = cell * i + cell / 2
    const contentHeight = iconSize + gap + labelSize
    const top = h / 2 - contentHeight / 2
    ctx.save()
    ctx.translate(cx - iconSize / 2, top)
    ctx.scale(iconSize / 960, iconSize / 960)
    ctx.fill(new Path2D(FlightIconPath))
    ctx.restore()
    ctx.fillText(`Tab ${i + 1}`, cx, top + iconSize + gap + labelSize / 2)
  }
  accentSnapshot.value = { url: canvas.toDataURL('image/png'), width: w, height: h }
}

watch(
  [() => props.isLightTheme, rootSize, () => props.tabsCount],
  () => drawAccentSnapshot(),
  { immediate: false }
)

/**
 * The snapshot's placement in the pill's local space: the strip is fixed to the bar, the pill
 * slides over it, so `x` tracks the indicator's translation per frame (cheap attribute write).
 */
const captureOverlay = useFrameValue<CaptureOverlay | null>(() => {
  const snap = accentSnapshot.value
  if (!snap) return null
  return {
    url: snap.url,
    x: -indicatorTranslation.value,
    y: 0,
    width: snap.width,
    height: snap.height
  }
})

function captureOverlayFn(): CaptureOverlay | null {
  return captureOverlay.value
}

/**
 * Evenodd clip that hides the black tab content wherever the pill currently is — including
 * while the pill is press-scaled (`scaleX/scaleY`, tracking `innerTransform`). Upstream the
 * indicator's sample = wallpaper + accent row ONLY (`tabsBackdrop` never recorded the black
 * row); without this, the pill's `backdrop-filter` capture would include the black glyphs,
 * ghosting against the accent copy painted on the surface.
 */
const blackRowClip = useFrameValue(() => {
  const rowW = Math.max(1, rootSize.value.width - dp(8))
  const sX = animation.scaleX
  const sY = animation.scaleY
  const cx = indicatorTranslation.value + tabWidth.value / 2
  const hw = (tabWidth.value / 2) * sX
  const hh = 28 * sY
  const l = cx - hw
  const t = 28 - hh
  const w = hw * 2
  const h = hh * 2
  const r = h / 2
  const n = (v: number) => Math.round(v * 100) / 100
  return (
    `path(evenodd, "M0 0 H ${rowW} V 56 H 0 Z ` +
    `M ${n(l + r)} ${n(t)} H ${n(l + w - r)} A ${n(r)} ${n(r)} 0 0 1 ${n(l + w)} ${n(t + r)} ` +
    `V ${n(t + h - r)} A ${n(r)} ${n(r)} 0 0 1 ${n(l + w - r)} ${n(t + h)} H ${n(l + r)} ` +
    `A ${n(r)} ${n(r)} 0 0 1 ${n(l)} ${n(t + h - r)} V ${n(t + r)} A ${n(r)} ${n(r)} 0 0 1 ${n(l + r)} ${n(t)} Z")`
  )
})

onMounted(() => {
  drawAccentSnapshot()
  if (rootEl.value) {
    /*
     * The gestures live on the whole bar, gated to the indicator's cell: Chromium gives
     * pointer events to the TOPMOST element, so a `pointer-events: auto` indicator would
     * swallow clicks on the selected tab (Compose dispatches to all overlapping handlers).
     * With the indicator transparent to pointers, taps land on the tabs underneath and the
     * press/drag deformation still starts exactly at the indicator's cell.
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
  <div ref="rootEl" class="liquid-bottom-tabs" :style="{ '--black-clip': blackRowClip }">
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
      :inner-shadow="indicatorInnerShadow"
      :layer-transform="innerTransform"
      :offset="indicatorOffset"
      :capture-overlay="captureOverlayFn"
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

/*
 * The black row is carved open wherever the pill is (evenodd capsule hole, per frame) — the
 * indicator's capture then sees wallpaper + wash only, and the accent content painted on the
 * pill's own surface stands in for the upstream `tabsBackdrop` recording. Without it the
 * black glyphs would show through the pill behind the painted accent content.
 */
.liquid-bottom-tabs :deep(.liquid-bottom-tabs__row) {
  clip-path: var(--black-clip, none);
}
</style>
