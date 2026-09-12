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
 * The sheet-level effects on the wallpaper (`graphicsLayer { renderEffect =
 * BlurEffect(4dp * progress) }` + `drawWithContent { drawRect(dimColor * progress) }`) both
 * live *inside* `Modifier.layerBackdrop(backdrop)` upstream, so the recorded backdrop — what
 * every tile samples — is the blurred and dimmed wallpaper while the tiles stay sharp. The
 * web port forwards a CSS `filter: blur()` for the wallpaper (its `backdrop-filter` capture
 * sees the painted, filtered result — same semantics) and paints the dim as before.
 *
 * The vertical drag drives `progress`, which feeds `layerBlock` (translate/scale/alpha), the
 * spacer heights, the wallpaper blur and the dim, so the sheet still springs open and closed.
 */
const { isLightTheme } = useTheme()

const itemSpacing = dp(16)
const itemSize = dp(68)
const itemTwoSpanSize = itemSize * 2 + itemSpacing
const itemShape: Shape = RoundedRectangle(itemSize / 2)

const innerItemSize = dp(56)

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

/** `graphicsLayer { renderEffect = BlurEffect(4f.dp.toPx() * progress) }` on the wallpaper. */
const wallpaperFilter = computed(() =>
  safeProgress.value > 0 ? `blur(${(dp(4) * safeProgress.value).toFixed(2)}px)` : null
)

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
const iconStyle = capStyle

const size1 = { width: `${itemSize}px`, height: `${itemSize}px` }
const size2 = { width: `${itemTwoSpanSize}px`, height: `${itemTwoSpanSize}px` }
const size2x1 = { width: `${itemTwoSpanSize}px`, height: `${itemSize}px` }
const size1x2 = { width: `${itemSize}px`, height: `${itemTwoSpanSize}px` }
</script>

<template>
  <BackdropDemoScaffold
    v-slot="{ backdrop }"
    :dim-color="dimColor"
    :wallpaper-filter="wallpaperFilter"
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
  /* Compose `Column` defaults to Start on the cross axis — row 3's single tile lines up
   * under the *left* tile of the row above (row 2's column is full-width, unaffected). */
  align-items: flex-start;
}

.cc__spacer {
  flex: 0 0 auto;
}

.cc__tile {
  flex: 0 0 auto;
}

/*
 * The inner 56 dp capsule sits at the tile's `padding(16.dp)` inset. `scale(0.8f)` in the
 * original applies *after* `clip`/`background` — it shrinks the whole capsule (background
 * + glyph) around its centre while the layout box stays 56 dp, so the visible capsule is
 * 44.8 dp and the glyph fills it.
 */
.cc__cap {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  transform: scale(0.8);
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
