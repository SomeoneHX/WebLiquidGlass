<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import LiquidButton from './LiquidButton.vue'
import { RootBackdrop } from '@/core/backdrop'
import type { Backdrop } from '@/core/backdrop'
import { inspectDragGestures } from '@/core/drag-gestures'
import { useWallpaper } from '@/composables/useWallpaper'
import wallpaperLight from '@/assets/wallpaper_light.webp'

/**
 * `BackdropDemoScaffold` — `app/src/androidMain/.../BackdropDemoScaffold.kt`
 *
 * A full-bleed wallpaper `<img>` with `object-fit: cover`, the destination content on top, and
 * the "Pick an image" liquid button pinned to the bottom.
 *
 * The Kotlin version wraps the wallpaper in a `Modifier.layerBackdrop(backdrop)` so it can be
 * recorded into a bitmap that every glass surface samples. None of that exists here: the
 * wallpaper is ordinary DOM, `backdrop-filter` captures it directly, and `RootBackdrop` is a
 * bare marker meaning "this surface does sample the page". The `dim` overlay works the same
 * way — it is simply painted above the image, exactly where the original drew it *before*
 * recording, so the glass picks it up either way.
 */
const props = defineProps<{
  /** Mirrors the `Modifier.drawWithContent { drawContent(); drawRect(dimColor) }` on the wallpaper. */
  dimColor?: string | null
  /**
   * Mirrors the `graphicsLayer { renderEffect = BlurEffect(...) }` on the wallpaper
   * (`ControlCenterContent`) — a CSS `filter` value applied to the wallpaper `<img>`.
   * In Compose the blur sits *inside* `Modifier.layerBackdrop(backdrop)`, so the recorded
   * backdrop — what every glass tile samples — is the blurred image while the tiles stay
   * sharp. `backdrop-filter` reproduces that exactly: it captures the wallpaper's painted
   * (filtered) result.
   */
  wallpaperFilter?: string | null
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

defineSlots<{ default?: (props: { backdrop: Backdrop }) => unknown }>()

const { src, setFromFile } = useWallpaper(wallpaperLight)

const wrapper = ref<HTMLElement | null>(null)
const imageEl = ref<HTMLImageElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

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

const wallpaperStyle = computed(() =>
  props.wallpaperFilter ? { filter: props.wallpaperFilter } : undefined
)

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

/**
 * `wallpaper` is exposed for `AdaptiveLuminanceGlassContent`, which samples the wallpaper's
 * pixels directly to derive the plate's luminance — the one destination that genuinely needs to
 * read the background, and the only surviving consumer of a "backdrop bitmap" in any form.
 */
defineExpose({ el: wrapper, backdrop: RootBackdrop, wallpaper: imageEl })
</script>

<template>
  <div ref="wrapper" class="scaffold" :style="rootStyle">
    <img
      ref="imageEl"
      class="scaffold__wallpaper"
      :src="src"
      :style="wallpaperStyle"
      alt=""
      draggable="false"
    />
    <div v-if="dimColor" class="scaffold__dim" :style="{ background: dimColor }" />

    <div class="scaffold__content">
      <slot :backdrop="RootBackdrop" />
    </div>

    <LiquidButton
      v-if="!hidePicker"
      class="scaffold__picker"
      :style="pickerStyle"
      :backdrop="RootBackdrop"
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
