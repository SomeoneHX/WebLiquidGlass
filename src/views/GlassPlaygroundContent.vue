<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import GlassSurface from '@/components/GlassSurface.vue'
import LiquidButton from '@/components/LiquidButton.vue'
import LiquidSlider from '@/components/LiquidSlider.vue'
import type { Backdrop, BackdropEffectScope } from '@/core/backdrop'
import { CanvasBackdrop, HighlightStyles, combinedBackdrop } from '@/core/backdrop'
import { Animatable, OffsetAnimatable, spring } from '@/core/animation'
import { dp, type LayerTransform, type Size } from '@/core/geometry'
import { RoundedRectangle, type Shape } from '@/core/shapes'
import { inspectTransformGestures } from '@/core/transform-gestures'
import { useTheme } from '@/composables/backdrop-context'

/**
 * `GlassPlaygroundContent` — the interactive playground.
 *
 * Degraded (API < 31) this is the clearest demonstration of *what actually survives*: the
 * `vibrancy / blur / lens` block is entirely inert, so the 256 dp plate is pure
 * `layerBlock` work. Pan / pinch / rotate still translate, scale and rotate the glass over a
 * wallpaper that stays pinned to the screen — the deformation, not the refraction, is the
 * effect you see.
 *
 * The bottom sheet exports a backdrop (`exportedBackdrop = sheetBackdrop`) that the sliders
 * sample. On the web the export is modelled directly: the root wallpaper plus the sheet's
 * `Color.White.copy(alpha = 0.5f)` surface, which is all that is left of the sheet's
 * appearance once the effects are stripped out.
 */
const { isLightTheme } = useTheme()

const hero = ref<InstanceType<typeof GlassSurface> | null>(null)
const heroEl = computed(() => (hero.value?.el as HTMLElement | null) ?? null)

const isSheetExpanded = ref(true)

const cornerRadiusFraction = ref(0.5)
const blurRadiusDp = ref(0)
const refractionHeightFraction = ref(0.2)
const refractionAmountFraction = ref(0.2)
const chromaticAberration = ref(0)

/* ------------------------------------------------------------------- animation --------- */
const offsetAnimation = new OffsetAnimatable(0, 0)
const zoomAnimation = new Animatable(1)
const rotationAnimation = new Animatable(0)

function heroLayer(): LayerTransform {
  return {
    translationX: offsetAnimation.x.value,
    translationY: offsetAnimation.y.value,
    scaleX: zoomAnimation.value,
    scaleY: zoomAnimation.value,
    rotationZ: rotationAnimation.value,
    alpha: 1
  }
}

const heroShape = computed<Shape>(() =>
  RoundedRectangle((dp(256) / 2) * cornerRadiusFraction.value)
)

function heroEffects(scope: BackdropEffectScope): void {
  const size: Size | undefined = hero.value?.size
  const minDimension = size ? Math.min(size.width, size.height) : 0
  scope.vibrancy()
  scope.blur(dp(blurRadiusDp.value))
  scope.lens(
    refractionHeightFraction.value * minDimension * 0.5,
    refractionAmountFraction.value * minDimension,
    true,
    chromaticAberration.value > 0
  )
}

/* ----------------------------------------------------------------------- gesture ------- */
/** `Offset.rotateBy(angle)` — pan is rotated by the *new* rotation before being added. */
function rotateBy(offset: { x: number; y: number }, angle: number): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    x: offset.x * cos - offset.y * sin,
    y: offset.x * sin + offset.y * cos
  }
}

onMounted(() => {
  const node = heroEl.value
  if (!node) return
  const detach = inspectTransformGestures(node, ({ pan, zoom, rotate }) => {
    const currentOffset = offsetAnimation.value
    const currentZoom = zoomAnimation.value
    const currentRotation = rotationAnimation.value

    const targetZoom = currentZoom * zoom
    const targetRotation = currentRotation + rotate
    const rotated = rotateBy(pan, targetRotation)

    offsetAnimation.snapTo(
      currentOffset.x + rotated.x * targetZoom,
      currentOffset.y + rotated.y * targetZoom
    )
    zoomAnimation.snapTo(targetZoom)
    rotationAnimation.snapTo(targetRotation)
  })
  onBeforeUnmount(detach)
})

/* -------------------------------------------------------------------- sheet export ----- */
const sheetSurface = new CanvasBackdrop((ctx, dc) => {
  ctx.save()
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)'
  ctx.fillRect(0, 0, dc.size.width, dc.size.height)
  ctx.restore()
})

let cachedRoot: Backdrop | null = null
let cachedSheetBackdrop: Backdrop | null = null

/** `exportedBackdrop = sheetBackdrop` — the sliders sample the sheet, not the raw wallpaper. */
function sheetBackdropFor(root: Backdrop): Backdrop {
  if (cachedRoot !== root || !cachedSheetBackdrop) {
    cachedRoot = root
    cachedSheetBackdrop = combinedBackdrop(root, sheetSurface)
  }
  return cachedSheetBackdrop
}

/* ------------------------------------------------------------------------- sliders ----- */
interface Field {
  label: string
  value: () => number
  set: (value: number) => void
  range: [number, number]
  threshold: number
}

/**
 * Built once: each entry closes over its own ref, and the template reads `field.value()`
 * during render, which is what registers the reactive dependency (and therefore keeps the
 * slider in sync with the Reset button).
 */
const fields: Field[] = [
  {
    label: 'Corner radius',
    value: () => cornerRadiusFraction.value,
    set: (value) => (cornerRadiusFraction.value = value),
    range: [0, 1],
    threshold: 0.001
  },
  {
    label: 'Blur radius',
    value: () => blurRadiusDp.value,
    set: (value) => (blurRadiusDp.value = value),
    range: [0, 32],
    threshold: 0.01
  },
  {
    label: 'Refraction height',
    value: () => refractionHeightFraction.value,
    set: (value) => (refractionHeightFraction.value = value),
    range: [0, 1],
    threshold: 0.001
  },
  {
    label: 'Refraction amount',
    value: () => refractionAmountFraction.value,
    set: (value) => (refractionAmountFraction.value = value),
    range: [0, 1],
    threshold: 0.001
  },
  {
    label: 'Chromatic aberration',
    value: () => chromaticAberration.value,
    set: (value) => (chromaticAberration.value = value),
    range: [0, 1],
    threshold: 0.001
  }
]

function onFieldChange(index: number, value: number): void {
  fields[index]?.set(value)
}

/* --------------------------------------------------------------------- reset ----------- */
function reset(): void {
  void offsetAnimation.animateTo(0, 0, spring())
  void zoomAnimation.animateTo(1, spring())
  void rotationAnimation.animateTo(0, spring())
  cornerRadiusFraction.value = 0.5
  blurRadiusDp.value = 0
  refractionHeightFraction.value = 0.2
  refractionAmountFraction.value = 0.2
  chromaticAberration.value = 0
}

const sheetHighlight = () => HighlightStyles.Plain(1)
const heroHighlight = () => HighlightStyles.Plain(1)

function onSheetSurface(ctx: CanvasRenderingContext2D, size: Size): void {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)'
  ctx.fillRect(0, 0, size.width, size.height)
}

const sheetShape: Shape = RoundedRectangle(dp(32))

function sheetEffects(scope: BackdropEffectScope): void {
  scope.vibrancy()
  scope.blur(dp(4))
  scope.lens(dp(16), dp(32))
}
</script>

<template>
  <BackdropDemoScaffold v-slot="{ backdrop }">
    <div class="playground">
      <GlassSurface
        ref="hero"
        class="playground__hero"
        :backdrop="backdrop"
        :shape="heroShape"
        :highlight="heroHighlight"
        :effects="heroEffects"
        :layer-transform="heroLayer"
      />

      <GlassSurface
        v-if="isSheetExpanded"
        class="playground__sheet"
        content-class="playground__sheet-body"
        :backdrop="backdrop"
        :shape="sheetShape"
        :highlight="sheetHighlight"
        :effects="sheetEffects"
        :on-draw-surface="onSheetSurface"
      >
        <div v-for="(field, index) in fields" :key="field.label" class="playground__field">
          <span class="playground__label">{{ field.label }}</span>
          <LiquidSlider
            :value="field.value()"
            :value-range="field.range"
            :visibility-threshold="field.threshold"
            :is-light-theme="isLightTheme"
            :backdrop="sheetBackdropFor(backdrop)"
            @change="onFieldChange(index, $event)"
          />
        </div>
      </GlassSurface>

      <LiquidButton
        class="playground__button playground__button--start"
        :backdrop="backdrop"
        tint="#FF8D28"
        @click="isSheetExpanded = !isSheetExpanded"
      >
        <span class="playground__button-label">{{ isSheetExpanded ? '🔽' : '🔼' }}</span>
      </LiquidButton>

      <LiquidButton
        class="playground__button playground__button--end"
        :backdrop="backdrop"
        tint="#FF8D28"
        @click="reset"
      >
        <span class="playground__button-label">Reset</span>
      </LiquidButton>
    </div>
  </BackdropDemoScaffold>
</template>

<style scoped>
.playground {
  position: absolute;
  inset: 0;
}

/* `.padding(top = 48.dp).statusBarsPadding().size(256.dp).align(TopCenter)` */
.playground__hero {
  position: absolute;
  top: calc(48px + var(--safe-top));
  left: 50%;
  margin-left: -128px;
  width: 256px;
  height: 256px;
  touch-action: none;
  cursor: grab;
}

/* `.padding(16).padding(bottom = 72).navigationBarsPadding().padding(24).align(BottomCenter)` */
.playground__sheet {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: calc(72px + var(--safe-bottom));
}

.playground__sheet-body {
  flex-direction: column;
  gap: 16px;
  padding: 24px;
  width: 100%;
}

.playground__field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.playground__label {
  font-size: 16px;
}

.playground__button {
  position: absolute;
  bottom: calc(20px + var(--safe-bottom));
}

.playground__button--start {
  left: 20px;
}

.playground__button--end {
  right: 20px;
}

.playground__button-label {
  color: #ffffff;
  font-size: 15px;
}
</style>
