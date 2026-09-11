<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import LiquidButton from './LiquidButton.vue'
import { LayerBackdrop } from '@/core/backdrop'
import { requestRedraw } from '@/core/animation'
import { inspectDragGestures } from '@/core/drag-gestures'
import { layoutEpoch, useElementMetrics } from '@/composables/useElementMetrics'
import { drawCover, useWallpaper } from '@/composables/useWallpaper'
import wallpaperLight from '@/assets/wallpaper_light.webp'

/**
 * `BackdropDemoScaffold` — `app/src/androidMain/.../BackdropDemoScaffold.kt`
 *
 * A full-bleed wallpaper with `ContentScale.Crop`, the captured `LayerBackdrop`, the
 * destination content on top, and the "Pick an image" liquid button pinned to the bottom.
 */
const props = defineProps<{
  /**
   * Mirrors the `Modifier.drawWithContent { drawContent(); drawRect(dimColor) }` the
   * original applies to the wallpaper <em>before</em> the layer is recorded, so the dim
   * is part of the captured backdrop (see `DialogContent`).
   */
  dimColor?: string | null
  hidePicker?: boolean
  /**
   * Port extension for `ControlCenterContent`, where the original puts a
   * `draggable(Orientation.Vertical)` on the wallpaper `Image` itself. In Compose that
   * gesture sits *behind* the content and still hit-tests; in the DOM a sibling overlay
   * would swallow it, so the scaffold forwards the vertical drag instead.
   */
  onVerticalDrag?: (deltaY: number) => void
  /** Fired once the pointer is released/cancelled (after `onVerticalDrag`). */
  onVerticalDragEnd?: () => void
}>()

/** Every destination receives the captured wallpaper layer through the default slot. */
defineSlots<{ default?: (props: { backdrop: LayerBackdrop }) => unknown }>()

const { image, src, ready, setFromFile } = useWallpaper(wallpaperLight)

const wallpaper = new LayerBackdrop()

const wrapper = ref<HTMLElement | null>(null)
const imageEl = ref<HTMLImageElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const imageMetrics = useElementMetrics(imageEl)

const capture = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): void => {
  const bitmap = image.value
  if (bitmap && ready.value) drawCover(ctx, bitmap, { width, height })
  if (props.dimColor) {
    ctx.fillStyle = props.dimColor
    ctx.fillRect(0, 0, width, height)
  }
}

/**
 * The wallpaper only needs re-recording when its *content* changes (resize, dim change, or
 * the image finishing decoding). A pure position change is handled by `setRect`, so a scroll
 * or a per-frame drag does not force a full re-render of the bitmap.
 *
 * The decode case is why `image` is compared by identity: the very first capture runs while
 * the bitmap is still `null`, so it records an empty layer, and without a re-capture on
 * decode the wallpaper layer stays blank *forever* — every glass surface then samples
 * nothing. `ready` alone is not enough either, because picking a replacement image swaps
 * `image` while `ready` stays `true`.
 */
let lastWidth = 0
let lastHeight = 0
let lastDim: string | null = null
let lastImage: HTMLImageElement | null = null
let everConfigured = false

watch(
  [imageMetrics.size, imageMetrics.rect, image, ready, layoutEpoch, () => props.dimColor],
  () => {
    const { width, height } = imageMetrics.size.value
    if (width <= 0 || height <= 0) return
    const dim = props.dimColor ?? null
    const decoded = image.value
    const contentChanged =
      !everConfigured ||
      width !== lastWidth ||
      height !== lastHeight ||
      dim !== lastDim ||
      decoded !== lastImage
    lastWidth = width
    lastHeight = height
    lastDim = dim
    lastImage = decoded
    everConfigured = true
    wallpaper.configure(width, height, capture)
    wallpaper.setRect(imageMetrics.rect.value)
    if (contentChanged) wallpaper.invalidate()
    // The recorded layer changed — force every glass surface to re-sample it.
    requestRedraw()
  },
  { immediate: true, flush: 'post' }
)

function pickImage() {
  fileInput.value?.click()
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) setFromFile(file)
  input.value = ''
}

const pickerStyle = computed(() => ({
  marginBottom: 'calc(16px + var(--safe-bottom))'
}))

const dragEnabled = computed(() => typeof props.onVerticalDrag === 'function')

/** `draggable` owns the pointer, so the scroller must not also pan. */
const rootStyle = computed(() => (dragEnabled.value ? { touchAction: 'none' } : undefined))

onMounted(() => {
  const node = wrapper.value
  if (!node || !dragEnabled.value) return
  const detach = inspectDragGestures(
    node,
    {
      onDrag: (delta) => props.onVerticalDrag?.(delta.y),
      onDragEnd: () => props.onVerticalDragEnd?.(),
      onDragCancel: () => props.onVerticalDragEnd?.()
    },
    (event) => ({ x: event.clientX, y: event.clientY })
  )
  onBeforeUnmount(detach)
})

onBeforeUnmount(() => {
  wallpaper.setRect(null)
})

defineExpose({ el: wrapper, backdrop: wallpaper })
</script>

<template>
  <div ref="wrapper" class="scaffold" :style="rootStyle">
    <img ref="imageEl" class="scaffold__wallpaper" :src="src" alt="" draggable="false" />
    <div v-if="dimColor" class="scaffold__dim" :style="{ background: dimColor }" />

    <div class="scaffold__content">
      <slot :backdrop="wallpaper" />
    </div>

    <LiquidButton
      v-if="!hidePicker"
      class="scaffold__picker"
      :style="pickerStyle"
      :backdrop="wallpaper"
      tint="#0088FF"
      @click="pickImage"
    >
      <span class="scaffold__picker-label">Pick an image</span>
    </LiquidButton>

    <input
      ref="fileInput"
      class="scaffold__file"
      type="file"
      accept="image/*"
      @change="onFileChange"
    />
  </div>
</template>

<style scoped>
.scaffold {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.scaffold__wallpaper {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  user-select: none;
}

.scaffold__dim {
  position: absolute;
  inset: 0;
}

.scaffold__content {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.scaffold__picker {
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  height: 56px;
}

.scaffold__picker-label {
  font-size: 16px;
  color: #ffffff;
  padding: 0 8px;
}

.scaffold__file {
  display: none;
}
</style>
