<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import GlassSurface from '@/components/GlassSurface.vue'
import type { BackdropEffectScope } from '@/core/backdrop'
import { LoremIpsum } from '@/core/assets'
import { dp } from '@/core/geometry'
import { inspectDragGestures } from '@/core/drag-gestures'
import { Capsule } from '@/core/shapes'
import { bumpLayoutEpoch } from '@/composables/useElementMetrics'
import { useTheme } from '@/composables/backdrop-context'

/**
 * `MagnifierContent` — the draggable lens over a paragraph and a cursor.
 *
 * The paragraph and the cursor are ordinary DOM sitting behind the lens, so the lens'
 * `backdrop-filter` captures them — and the wallpaper — by itself. The Kotlin build needed two
 * recorded layers (`contentBackdrop`, `cursorBackdrop`) plus a hand-rasterised copy of the
 * paragraph for exactly that; none of it is needed now.
 *
 * ⚠ Known gap — magnification. The original `onDrawBackdrop` re-drew the captured backdrop at
 * 1.5× about the lens centre, which is what makes the text look magnified. `backdrop-filter`
 * alone cannot do that: a `transform: scale()` on the lens *widens the sampled region* instead
 * of enlarging it, because the spec inverts the transform before sampling (Filter Effects L2
 * § 2.1). Restoring it means adding a **zoom term** to the displacement map — a displacement
 * proportional to the distance from the centre, which `feDisplacementMap` expresses fine — and
 * that is not wired up yet, so the lens currently refracts without magnifying.
 */
const { isLightTheme } = useTheme()

const contentColor = computed(() => (isLightTheme.value ? '#000000' : '#ffffff'))
const accentColor = computed(() => (isLightTheme.value ? '#0088FF' : '#0091FF'))
const backgroundColor = computed(() => (isLightTheme.value ? '#ffffff' : '#121212'))

const cursorOffset = ref({ x: 0, y: 0 })
const cursorEl = ref<HTMLElement | null>(null)

onMounted(() => {
  const node = cursorEl.value
  if (!node) return
  const detach = inspectDragGestures(
    node,
    {
      onDrag: (delta) => {
        cursorOffset.value = {
          x: cursorOffset.value.x + delta.x,
          y: cursorOffset.value.y + delta.y
        }
        // The lens and cursor are moved with a CSS `transform`, which does not fire
        // `ResizeObserver`; re-measuring keeps every glass surface's cull test honest.
        bumpLayoutEpoch()
      }
    },
    (event) => ({ x: event.clientX, y: event.clientY })
  )
  onBeforeUnmount(detach)
})

const cursorStyle = computed(() => ({
  transform: `translate(${cursorOffset.value.x}px, ${cursorOffset.value.y}px)`,
  background: accentColor.value
}))

const lensStyle = computed(() => ({
  transform: `translate(${cursorOffset.value.x}px, ${cursorOffset.value.y - dp(80)}px)`
}))

function effects(scope: BackdropEffectScope): void {
  scope.lens(dp(8), dp(24), true, true)
}
</script>

<template>
  <BackdropDemoScaffold v-slot="{ backdrop }">
    <div class="magnifier">
      <div class="magnifier__text">
        <p
          class="magnifier__paragraph"
          :style="{ background: backgroundColor, color: contentColor }"
        >
          {{ LoremIpsum }}
        </p>
      </div>

      <div ref="cursorEl" class="magnifier__cursor" :style="cursorStyle" />

      <GlassSurface
        class="magnifier__lens"
        :style="lensStyle"
        :backdrop="backdrop"
        :shape="Capsule"
        :effects="effects"
      />
    </div>
  </BackdropDemoScaffold>
</template>

<style scoped>
.magnifier {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* `padding(24).clip(RoundedRectangle(32)).background(...).padding(24)` */
.magnifier__text {
  padding: 24px;
  max-width: 100%;
}

.magnifier__paragraph {
  margin: 0;
  padding: 24px;
  border-radius: 32px;
  font-size: 16px;
  line-height: 1.2;
  opacity: 0.9;
}

.magnifier__cursor {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 4px;
  height: 24px;
  margin-left: -2px;
  margin-top: -12px;
  border-radius: 999px;
  touch-action: none;
  cursor: grab;
}

.magnifier__lens {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 128px;
  height: 96px;
  margin-left: -64px;
  margin-top: -48px;
  pointer-events: none;
}
</style>
