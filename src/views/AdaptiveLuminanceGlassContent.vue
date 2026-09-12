<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import GlassSurface from '@/components/GlassSurface.vue'
import type { BackdropEffectScope } from '@/core/backdrop'
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
/**
 * The lens layer is what carries the layer transform (`translate` / `scale` / `rotate`), so
 * its bounding rect is the plate's *on-screen* quad. The root element never moves — the
 * drag transform lives on the inner layers — and sampling at the root's rect read the same
 * wallpaper region forever (the value froze at whatever the centre of the screen is).
 * Kotlin had no such problem: `layer.record { drawBackdrop() }` recorded inside the draw
 * pass, at the transformed location by construction.
 */
const plateLensEl = computed(() => (plate.value?.lens as HTMLElement | null) ?? null)

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
const RETRY_DELAY_MS = 250
let sampleCanvas: HTMLCanvasElement | null = null

/** Average luminance of the wallpaper where the plate currently sits, or `null` if either is not ready. */
function readAverageLuminance(): number | null {
  const image = scaffold.value?.wallpaper ?? null
  const plateNode = plateLensEl.value ?? plateEl.value
  if (!image || !plateNode) return null
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
    return null
  }

  if (!sampleCanvas) {
    sampleCanvas = document.createElement('canvas')
    sampleCanvas.width = SAMPLE
    sampleCanvas.height = SAMPLE
  }
  const sctx = sampleCanvas.getContext('2d', { willReadFrequently: true })
  if (!sctx) return null

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
    return null
  }

  const data = sctx.getImageData(0, 0, SAMPLE, SAMPLE).data
  let sum = 0
  for (let i = 0; i < data.length; i += 4) {
    sum +=
      0.2126 * (data[i] / 255) + 0.7152 * (data[i + 1] / 255) + 0.0722 * (data[i + 2] / 255)
  }
  return sum / (SAMPLE * SAMPLE)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The Kotlin loop is **self-driving**:
 *
 * ```
 * while (isActive) { sample; contentColor.animateTo(tween 1s); luminance.animateTo(tween 1s) }
 * ```
 *
 * it re-samples the moment the 1 s tween settles, from composition to teardown, with no
 * external trigger. The first port instead sampled from `animationRevision` bumps, which
 * only exist *while some other animation is running*: at mount nothing ran, so the plate
 * sat at its initial `luminance = 1` state — `brightness(150%) contrast(0%)`, a flat grey
 * slab — and the text froze at "1.00" until the first drag happened to kick the loop. Once
 * running, the settle bumps of the loop's own tweens kept re-arming the 1 s gate, so
 * sampling never rested either.
 *
 * This loop is the faithful port: sample → animate both values for 1 s → repeat. The
 * retries only cover the wallpaper/plate not being measurable yet.
 */
let loopActive = false

async function samplingLoop(): Promise<void> {
  while (loopActive) {
    const average = readAverageLuminance()
    if (average === null) {
      await delay(RETRY_DELAY_MS)
      continue
    }
    await Promise.all([
      luminanceAnimation.animateTo(average, colorSpec),
      textMixAnimation.animateTo(average > 0.5 ? 0 : 1, colorSpec)
    ])
  }
}

onMounted(() => {
  loopActive = true
  void samplingLoop()
})

onBeforeUnmount(() => {
  loopActive = false
  // `stop()` resolves the pending `animateTo` promises, so the loop wakes up, sees
  // `loopActive == false` and exits instead of awaiting forever.
  luminanceAnimation.stop()
  textMixAnimation.stop()
})

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

/* `:deep()` — see DialogContent; the content div carries GlassSurface's scope id. */
.adaptive__plate :deep(.adaptive__content) {
  align-items: center;
  justify-content: center;
}

.adaptive__label {
  font-size: 16px;
  text-align: center;
}
</style>
