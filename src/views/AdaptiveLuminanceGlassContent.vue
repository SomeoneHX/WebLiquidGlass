<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import GlassSurface from '@/components/GlassSurface.vue'
import type { BackdropEffectScope } from '@/core/backdrop'
import { HighlightStyles } from '@/core/backdrop'
import { Animatable, OffsetAnimatable, animationRevision, tween } from '@/core/animation'
import { dp, type LayerTransform, type Size } from '@/core/geometry'
import { lerp, sign } from '@/core/math'
import { RoundedRectangle, type Shape } from '@/core/shapes'
import { inspectTransformGestures } from '@/core/transform-gestures'
import { useFrameValue } from '@/composables/useFrameValue'
import { useTheme } from '@/composables/backdrop-context'

/**
 * `AdaptiveLuminanceGlassContent` — the glass whose *content* reacts to what is behind it.
 *
 * The adaptive part is a feedback loop, not a render effect:
 *
 * ```
 * onDrawBackdrop { drawBackdrop(); layer.record { drawBackdrop() } }
 * while (isActive) { averageLuminance(layer.toImageBitmap().scale(5, 5)); animateTo(...) }
 * ```
 *
 * so the label flips between black and white as the plate is dragged across the wallpaper.
 *
 * The loop is ported in full, but its **source** had to change. Kotlin could rasterise the
 * captured backdrop into a 5x5 bitmap; there is no captured backdrop here, so the wallpaper
 * `<img>` itself is sampled at the plate's position instead. Because the wallpaper uses
 * `object-fit: cover`, the drawn image is larger than its element and centred, so the mapping
 * from an element point back to source pixels has to undo that crop. This is the only place in
 * the port that reads background pixels at all, and it reads them to *drive a colour*, never to
 * paint itself.
 */
const { isLightTheme } = useTheme()

const scaffold = ref<InstanceType<typeof BackdropDemoScaffold> | null>(null)
const plate = ref<InstanceType<typeof GlassSurface> | null>(null)
const plateEl = computed(() => (plate.value?.el as HTMLElement | null) ?? null)

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

function sampleLuminance(): void {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  if (now - lastSample < SAMPLE_INTERVAL) return
  const image = scaffold.value?.wallpaper ?? null
  const plateNode = plateEl.value
  if (!image || !plateNode) return
  const imageRect = image.getBoundingClientRect()
  const rect = plateNode.getBoundingClientRect()
  if (
    imageRect.width <= 0 ||
    imageRect.height <= 0 ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    image.naturalWidth <= 0 ||
    image.naturalHeight <= 0
  ) {
    return
  }
  lastSample = now

  if (!sampleCanvas) {
    sampleCanvas = document.createElement('canvas')
    sampleCanvas.width = SAMPLE
    sampleCanvas.height = SAMPLE
  }
  const sctx = sampleCanvas.getContext('2d', { willReadFrequently: true })
  if (!sctx) return

  // `object-fit: cover` — undo the crop to get from element coordinates to source pixels.
  const scale = Math.max(
    imageRect.width / image.naturalWidth,
    imageRect.height / image.naturalHeight
  )
  const cropX = (image.naturalWidth * scale - imageRect.width) / 2
  const cropY = (image.naturalHeight * scale - imageRect.height) / 2
  const sx = (rect.left - imageRect.left + cropX) / scale
  const sy = (rect.top - imageRect.top + cropY) / scale
  const sw = rect.width / scale
  const sh = rect.height / scale

  sctx.setTransform(1, 0, 0, 1, 0, 0)
  sctx.clearRect(0, 0, SAMPLE, SAMPLE)
  try {
    sctx.drawImage(image, sx, sy, sw, sh, 0, 0, SAMPLE, SAMPLE)
  } catch {
    return
  }

  const data = sctx.getImageData(0, 0, SAMPLE, SAMPLE).data
  let sum = 0
  for (let i = 0; i < data.length; i += 4) {
    sum +=
      0.2126 * (data[i] / 255) + 0.7152 * (data[i + 1] / 255) + 0.0722 * (data[i + 2] / 255)
  }
  const average = sum / (SAMPLE * SAMPLE)

  void luminanceAnimation.animateTo(average, colorSpec)
  void textMixAnimation.animateTo(average > 0.5 ? 0 : 1, colorSpec)
}

/** The original sampled inside `onDrawBackdrop`; `animationRevision` is the equivalent tick. */
watch(() => animationRevision.value, () => sampleLuminance(), { flush: 'post' })

/* ----------------------------------------------------------------------- gesture ------- */
function rotateBy(offset: { x: number; y: number }, angle: number): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return { x: offset.x * cos - offset.y * sin, y: offset.x * sin + offset.y * cos }
}

onMounted(() => {
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
