<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import GlassSurface from '@/components/GlassSurface.vue'
import type { Backdrop, BackdropDrawContext, BackdropEffectScope } from '@/core/backdrop'
import { HighlightStyles } from '@/core/backdrop'
import { Animatable, OffsetAnimatable, tween } from '@/core/animation'
import { dp, type LayerTransform, type Size } from '@/core/geometry'
import { lerp, sign } from '@/core/math'
import { RoundedRectangle, type Shape } from '@/core/shapes'
import { inspectTransformGestures } from '@/core/transform-gestures'
import { useFrameValue } from '@/composables/useFrameValue'
import { useTheme } from '@/composables/backdrop-context'

/**
 * `AdaptiveLuminanceGlassContent` — the glass whose *content* reacts to what is behind it.
 *
 * Degraded (API < 31) the glass itself is inert: `colorControls`, `blur` and `lens` are all
 * RenderEffect / RuntimeShader work and therefore gone. But the adaptive part is **not** an
 * effect — it is a feedback loop:
 *
 * ```
 * onDrawBackdrop { drawBackdrop(); layer.record { drawBackdrop() } }
 * while (isActive) { averageLuminance(layer.toImageBitmap().scale(5, 5)); animateTo(...) }
 * ```
 *
 * so the label keeps flipping between black and white as the plate is dragged over dark and
 * light parts of the wallpaper. That is ported in full: the sampled backdrop is re-rendered
 * into a 5 x 5 canvas, read back with `getImageData`, and the average Rec. 709 luma drives a
 * 1 s tween — the same cadence as the original, whose `animateTo(tween(1000))` is awaited
 * before the next sample.
 */
const { isLightTheme } = useTheme()

const scaffold = ref<InstanceType<typeof BackdropDemoScaffold> | null>(null)
const plate = ref<InstanceType<typeof GlassSurface> | null>(null)
const plateEl = computed(() => (plate.value?.el as HTMLElement | null) ?? null)

let rootBackdrop: Backdrop | null = null

/* ------------------------------------------------------------------- animation --------- */
const luminanceAnimation = new Animatable(isLightTheme.value ? 1 : 0)
/** 0 == `Color.Black`, 1 == `Color.White` — `Color.lerp` is a per-channel sRGB lerp. */
const textMixAnimation = new Animatable(isLightTheme.value ? 0 : 1)
const colorSpec = tween(1000)

const luminance = useFrameValue(() => luminanceAnimation.value)
const textMix = useFrameValue(() => textMixAnimation.value)

const luminanceText = computed(() => (Math.round(luminance.value * 100) / 100).toFixed(2))
const textColor = computed(() => {
  const channel = Math.round(Math.min(1, Math.max(0, textMix.value)) * 255)
  return `rgb(${channel}, ${channel}, ${channel})`
})

const offsetAnimation = new OffsetAnimatable(0, 0)
const zoomAnimation = new Animatable(1)
const rotationAnimation = new Animatable(0)

function plateLayer(): LayerTransform {
  return {
    translationX: offsetAnimation.x.value,
    translationY: offsetAnimation.y.value,
    scaleX: zoomAnimation.value,
    scaleY: zoomAnimation.value,
    rotationZ: rotationAnimation.value,
    alpha: 1
  }
}

function plateEffects(scope: BackdropEffectScope): void {
  const raw = luminanceAnimation.value * 2 - 1
  const l = sign(raw) * raw * raw
  scope.colorControls(
    l > 0 ? lerp(0.1, 0.5, l) : lerp(0.1, -0.2, -l),
    l > 0 ? lerp(1, 0, l) : 1,
    1.5
  )
  scope.blur(l > 0 ? lerp(dp(8), dp(16), l) : lerp(dp(8), dp(2), -l))
  const size: Size | undefined = plate.value?.size
  const minDimension = size ? Math.min(size.width, size.height) : 0
  scope.lens(dp(24), minDimension / 2, true)
}

/* ---------------------------------------------------------------------- sampling ------- */
const SAMPLE = 5
const SAMPLE_INTERVAL = 1000
let sampleCanvas: HTMLCanvasElement | null = null
let lastSample = 0

function sampleLuminance(dc: BackdropDrawContext): void {
  if (!rootBackdrop) return
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  if (now - lastSample < SAMPLE_INTERVAL) return
  lastSample = now

  if (!sampleCanvas) {
    sampleCanvas = document.createElement('canvas')
    sampleCanvas.width = SAMPLE
    sampleCanvas.height = SAMPLE
  }
  const sctx = sampleCanvas.getContext('2d', { willReadFrequently: true })
  if (!sctx) return
  const scaleX = SAMPLE / Math.max(1, dc.size.width)
  const scaleY = SAMPLE / Math.max(1, dc.size.height)

  sctx.setTransform(1, 0, 0, 1, 0, 0)
  sctx.clearRect(0, 0, SAMPLE, SAMPLE)
  sctx.save()
  sctx.scale(scaleX, scaleY)
  // Maps the element's viewport rect onto the 0..5 sample box.
  sctx.translate(-dc.elementRect.left, -dc.elementRect.top)
  rootBackdrop.draw(sctx, dc)
  sctx.restore()

  const data = sctx.getImageData(0, 0, SAMPLE, SAMPLE).data
  let sum = 0
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255
    const g = data[i + 1] / 255
    const b = data[i + 2] / 255
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const average = sum / (SAMPLE * SAMPLE)

  void luminanceAnimation.animateTo(average, colorSpec)
  void textMixAnimation.animateTo(average > 0.5 ? 0 : 1, colorSpec)
}

/** `onDrawBackdrop = { drawBackdrop -> drawBackdrop(); layer.record { drawBackdrop() } }` */
function onDrawBackdrop(
  _ctx: CanvasRenderingContext2D,
  draw: () => void,
  dc: BackdropDrawContext
): void {
  draw()
  sampleLuminance(dc)
}

/* ----------------------------------------------------------------------- gesture ------- */
function rotateBy(offset: { x: number; y: number }, angle: number): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return { x: offset.x * cos - offset.y * sin, y: offset.x * sin + offset.y * cos }
}

onMounted(() => {
  rootBackdrop = scaffold.value?.backdrop ?? null
  const node = plateEl.value
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

const shape: Shape = RoundedRectangle(dp(24))
const highlight = () => HighlightStyles.Plain(1)
</script>

<template>
  <BackdropDemoScaffold ref="scaffold" v-slot="{ backdrop }">
    <div class="adaptive">
      <GlassSurface
        ref="plate"
        class="adaptive__plate"
        content-class="adaptive__content"
        :backdrop="backdrop"
        :shape="shape"
        :highlight="highlight"
        :effects="plateEffects"
        :layer-transform="plateLayer"
        :on-draw-backdrop="onDrawBackdrop"
      >
        <span class="adaptive__label" :style="{ color: textColor }">
          luminance:<br />{{ luminanceText }}
        </span>
      </GlassSurface>
    </div>
  </BackdropDemoScaffold>
</template>

<style scoped>
.adaptive {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.adaptive__plate {
  width: 160px;
  height: 160px;
  touch-action: none;
  cursor: grab;
}

.adaptive__content {
  align-items: center;
  justify-content: center;
}

.adaptive__label {
  font-size: 16px;
  text-align: center;
}
</style>
