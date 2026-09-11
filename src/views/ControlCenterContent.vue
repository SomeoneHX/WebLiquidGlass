<script setup lang="ts">
import { computed } from 'vue'

import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import FlightIcon from '@/components/FlightIcon.vue'
import GlassSurface from '@/components/GlassSurface.vue'
import type { BackdropEffectScope, Highlight } from '@/core/backdrop'
import { HighlightStyles } from '@/core/backdrop'
import { Animatable, spring } from '@/core/animation'
import { dp, type LayerTransform, type Size } from '@/core/geometry'
import { easeIn } from '@/core/math'
import { DefaultProgressConverter } from '@/core/progress-converter'
import { RoundedRectangle, type Shape } from '@/core/shapes'
import { VelocityTracker } from '@/core/velocity-tracker'
import { useFrameValue } from '@/composables/useFrameValue'
import { useTheme } from '@/composables/backdrop-context'

/**
 * `ControlCenterContent` — the draggable control-centre sheet.
 *
 * Degraded (API < 31):
 *  - `vibrancy` / `lens` are no-ops, so each tile is the wallpaper behind a 5 % black wash
 *    (`onDrawSurface`) plus its highlight ring;
 *  - the sheet-level `graphicsLayer { renderEffect = BlurEffect(4dp * progress) }` is a
 *    no-op, but the `drawWithContent { drawRect(dimColor * progress) }` around the wallpaper
 *    is **not** — the dim is baked into the captured layer, exactly as in the original.
 *
 * What survives is the whole point of the port: the vertical drag drives `progress`, which
 * feeds `layerBlock` (translate/scale/alpha), the spacer heights and the dim, so the sheet
 * still springs open and closed.
 */
const { isLightTheme } = useTheme()

const itemSpacing = dp(16)
const itemSize = dp(68)
const itemTwoSpanSize = itemSize * 2 + itemSpacing
const itemShape: Shape = RoundedRectangle(itemSize / 2)

const innerItemSize = dp(56)
const innerIconSize = innerItemSize * 0.8

const accentColor = computed(() => (isLightTheme.value ? '#0088FF' : '#0091FF'))
const containerColor = 'rgba(0, 0, 0, 0.05)'
const inactiveItemColor = 'rgba(255, 255, 255, 0.2)'

const MAX_DRAG_HEIGHT = 1000

/* ------------------------------------------------------------------- animation --------- */
/**
 * `enterProgressAnimation` is *unclamped* (it can go below 0 / above 1 and drives the
 * spacers); `safeEnterProgressAnimation` is clamped and drives alpha/dim. Both are
 * `Animatable(1f)` so the sheet starts fully open.
 */
const enterProgress = new Animatable(1)
const safeEnterProgress = new Animatable(1)

const progress = useFrameValue(() => {
  const p = enterProgress.value
  if (p < 0) return DefaultProgressConverter.convert(p)
  if (p <= 1) return p
  return 1 + DefaultProgressConverter.convert(p - 1)
})

const safeProgress = useFrameValue(() => safeEnterProgress.value)

function overshoot(): number {
  return Math.max(progress.value - 1, 0)
}

/**
 * `Modifier.layout { height = itemSpacing + 32.dp * (progress - 1).coerceAtLeast(0) }`
 * — the spacers literally grow as the sheet is pulled down.
 */
const spacerHeight = useFrameValue(() => `${itemSpacing + dp(32) * overshoot()}px`)
const smallSpacerHeight = useFrameValue(() => `${itemSpacing + dp(16) * overshoot()}px`)

/** `Modifier.drawWithContent { drawContent(); drawRect(dimColor.copy(alpha * progress)) }` */
const dimColor = computed(() => `rgba(0, 0, 0, ${0.4 * safeProgress.value})`)

function glassLayer(): LayerTransform {
  const p = progress.value
  const safe = safeEnterProgress.value
  const damp = 1 + 0.1 * overshoot()
  return {
    translationX: 0,
    translationY: -dp(48) * (1 - p),
    scaleX: 1 / damp,
    scaleY: 1 / damp,
    rotationZ: 0,
    alpha: easeIn(safe)
  }
}

const glassHighlight = (): Highlight | null => HighlightStyles.Default(1, 45, 2)

const glassEffects = (scope: BackdropEffectScope): void => {
  const p = safeEnterProgress.value
  scope.vibrancy()
  scope.lens(dp(24) * p, dp(48) * p, true)
}

function onGlassSurface(ctx: CanvasRenderingContext2D, size: Size): void {
  ctx.fillStyle = containerColor
  ctx.fillRect(0, 0, size.width, size.height)
}

/* ----------------------------------------------------------------------- gesture ------- */
const tracker = new VelocityTracker()

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function onVerticalDrag(deltaY: number): void {
  const target = enterProgress.value + deltaY / MAX_DRAG_HEIGHT
  enterProgress.snapTo(target)
  safeEnterProgress.snapTo(Math.min(1, Math.max(0, target)))
  tracker.addPosition(nowMs(), { x: 0, y: target * MAX_DRAG_HEIGHT })
}

function onVerticalDragEnd(): void {
  const velocity = tracker.calculateVelocity().y
  tracker.resetTracking()
  const target = velocity < 0 ? 0 : velocity > 0 ? 1 : enterProgress.value < 0.5 ? 0 : 1
  void enterProgress.animateTo(
    target,
    target > 0.5 ? spring(0.5, 300, 0.5 / MAX_DRAG_HEIGHT) : spring(1, 300, 0.01),
    velocity / MAX_DRAG_HEIGHT
  )
  void safeEnterProgress.animateTo(target, spring(1, 300, 0.01))
}

/* ------------------------------------------------------------------------- layout ------ */
const capStyle = { width: `${innerItemSize}px`, height: `${innerItemSize}px` }
const iconStyle = { width: `${innerIconSize}px`, height: `${innerIconSize}px` }

const size1 = { width: `${itemSize}px`, height: `${itemSize}px` }
const size2 = { width: `${itemTwoSpanSize}px`, height: `${itemTwoSpanSize}px` }
const size2x1 = { width: `${itemTwoSpanSize}px`, height: `${itemSize}px` }
const size1x2 = { width: `${itemSize}px`, height: `${itemTwoSpanSize}px` }
</script>

<template>
  <BackdropDemoScaffold
    v-slot="{ backdrop }"
    :dim-color="dimColor"
    :on-vertical-drag="onVerticalDrag"
    :on-vertical-drag-end="onVerticalDragEnd"
  >
    <div class="cc">
      <!-- Row 1: 2x2 with four inner capsules, plus an empty 2x2 -->
      <div class="cc__row cc__row--tight">
        <GlassSurface
          class="cc__tile"
          :style="size2"
          :backdrop="backdrop"
          :shape="itemShape"
          :highlight="glassHighlight"
          :shadow="() => null"
          :effects="glassEffects"
          :layer-transform="glassLayer"
          :on-draw-surface="onGlassSurface"
        >
          <span
            class="cc__cap cc__cap--top-start"
            :style="{ ...capStyle, background: inactiveItemColor }"
          >
            <span class="cc__cap-icon" :style="iconStyle"><FlightIcon /></span>
          </span>
          <span
            class="cc__cap cc__cap--top-end"
            :style="{ ...capStyle, background: accentColor }"
          >
            <span class="cc__cap-icon" :style="iconStyle"><FlightIcon /></span>
          </span>
          <span
            class="cc__cap cc__cap--bottom-start"
            :style="{ ...capStyle, background: accentColor }"
          >
            <span class="cc__cap-icon" :style="iconStyle"><FlightIcon /></span>
          </span>
        </GlassSurface>

        <GlassSurface
          class="cc__tile"
          :style="size2"
          :backdrop="backdrop"
          :shape="itemShape"
          :highlight="glassHighlight"
          :shadow="() => null"
          :effects="glassEffects"
          :layer-transform="glassLayer"
          :on-draw-surface="onGlassSurface"
        />
      </div>

      <div class="cc__spacer" :style="{ height: spacerHeight }" />

      <!-- Row 2: 2x1 / 1x2 cross -->
      <div class="cc__row">
        <div class="cc__column">
          <div class="cc__row cc__row--tight">
            <GlassSurface
              class="cc__tile"
              :style="size1"
              :backdrop="backdrop"
              :shape="itemShape"
              :highlight="glassHighlight"
              :shadow="() => null"
              :effects="glassEffects"
              :layer-transform="glassLayer"
              :on-draw-surface="onGlassSurface"
            >
              <span class="cc__cap cc__cap--fill">
                <span class="cc__cap-icon" :style="iconStyle"><FlightIcon /></span>
              </span>
            </GlassSurface>
            <GlassSurface
              class="cc__tile"
              :style="size1"
              :backdrop="backdrop"
              :shape="itemShape"
              :highlight="glassHighlight"
              :shadow="() => null"
              :effects="glassEffects"
              :layer-transform="glassLayer"
              :on-draw-surface="onGlassSurface"
            >
              <span class="cc__cap cc__cap--fill">
                <span class="cc__cap-icon" :style="iconStyle"><FlightIcon /></span>
              </span>
            </GlassSurface>
          </div>

          <div class="cc__spacer" :style="{ height: smallSpacerHeight }" />

          <GlassSurface
            class="cc__tile"
            :style="size2x1"
            :backdrop="backdrop"
            :shape="itemShape"
            :highlight="glassHighlight"
            :shadow="() => null"
            :effects="glassEffects"
            :layer-transform="glassLayer"
          />
        </div>

        <div class="cc__row cc__row--tight">
          <GlassSurface
            class="cc__tile"
            :style="size1x2"
            :backdrop="backdrop"
            :shape="itemShape"
            :highlight="glassHighlight"
            :shadow="() => null"
            :effects="glassEffects"
            :layer-transform="glassLayer"
            :on-draw-surface="onGlassSurface"
          />
          <GlassSurface
            class="cc__tile"
            :style="size1x2"
            :backdrop="backdrop"
            :shape="itemShape"
            :highlight="glassHighlight"
            :shadow="() => null"
            :effects="glassEffects"
            :layer-transform="glassLayer"
            :on-draw-surface="onGlassSurface"
          />
        </div>
      </div>

      <div class="cc__spacer" :style="{ height: spacerHeight }" />

      <!-- Row 3: mirror of row 2 -->
      <div class="cc__row cc__row--tight">
        <GlassSurface
          class="cc__tile"
          :style="size2"
          :backdrop="backdrop"
          :shape="itemShape"
          :highlight="glassHighlight"
          :shadow="() => null"
          :effects="glassEffects"
          :layer-transform="glassLayer"
          :on-draw-surface="onGlassSurface"
        />

        <div class="cc__column">
          <div class="cc__row cc__row--tight">
            <GlassSurface
              class="cc__tile"
              :style="size1"
              :backdrop="backdrop"
              :shape="itemShape"
              :highlight="glassHighlight"
              :shadow="() => null"
              :effects="glassEffects"
              :layer-transform="glassLayer"
              :on-draw-surface="onGlassSurface"
            >
              <span class="cc__cap cc__cap--fill">
                <span class="cc__cap-icon" :style="iconStyle"><FlightIcon /></span>
              </span>
            </GlassSurface>
            <GlassSurface
              class="cc__tile"
              :style="size1"
              :backdrop="backdrop"
              :shape="itemShape"
              :highlight="glassHighlight"
              :shadow="() => null"
              :effects="glassEffects"
              :layer-transform="glassLayer"
              :on-draw-surface="onGlassSurface"
            >
              <span class="cc__cap cc__cap--fill">
                <span class="cc__cap-icon" :style="iconStyle"><FlightIcon /></span>
              </span>
            </GlassSurface>
          </div>

          <div class="cc__spacer" :style="{ height: smallSpacerHeight }" />

          <div class="cc__row cc__row--tight">
            <GlassSurface
              class="cc__tile"
              :style="size1"
              :backdrop="backdrop"
              :shape="itemShape"
              :highlight="glassHighlight"
              :shadow="() => null"
              :effects="glassEffects"
              :layer-transform="glassLayer"
              :on-draw-surface="onGlassSurface"
            >
              <span class="cc__cap cc__cap--fill">
                <span class="cc__cap-icon" :style="iconStyle"><FlightIcon /></span>
              </span>
            </GlassSurface>
          </div>
        </div>
      </div>
    </div>
  </BackdropDemoScaffold>
</template>

<style scoped>
/* `Column(padding(top = 80.dp), horizontalAlignment = CenterHorizontally)` */
.cc {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 80px;
  pointer-events: none;
}

.cc__row {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 16px;
}

.cc__column {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.cc__spacer {
  flex: 0 0 auto;
}

.cc__tile {
  flex: 0 0 auto;
}

/* The inner 56 dp capsule sits at the tile's `padding(16.dp)` inset. */
.cc__cap {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
}

.cc__cap--top-start {
  left: 16px;
  top: 16px;
}

.cc__cap--top-end {
  right: 16px;
  top: 16px;
}

.cc__cap--bottom-start {
  left: 16px;
  bottom: 16px;
}

.cc__cap--fill {
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}

.cc__cap-icon {
  display: block;
  color: #ffffff;
}
</style>
