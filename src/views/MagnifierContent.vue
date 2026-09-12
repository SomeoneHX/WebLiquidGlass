<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import GlassSurface from '@/components/GlassSurface.vue'
import type { BackdropEffectScope } from '@/core/backdrop'
import { innerShadow } from '@/core/backdrop'
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
 * The magnification is the `onDrawBackdrop { withTransform { scale(1.5) } }` re-expressed as
 * a **zoom displacement stage** in the filter graph (`backdrop-zoom`): the captured backdrop
 * sampled at `c + (p − c)/1.5` is a per-pixel displacement of `d(p) = q − p`, a linear field
 * baked into its own map. Chained *ahead* of the refraction maps (which keep their animated
 * scale) it composes to the exact upstream semantics — refracting the already-magnified
 * backdrop. The `InnerShadow(16.dp)` rides the overlay canvas.
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
  left: `calc(50% + ${cursorOffset.value.x}px)`,
  top: `calc(50% + ${cursorOffset.value.y - dp(80)}px)`
}))

/**
 * The magnification: `onDrawBackdrop { withTransform { scale(1.5f, 1.5f) } }` — a 1.5×
 * centre zoom re-expressed as a zoom displacement stage in the filter graph (`backdrop-zoom`).
 * The upstream `translate(top = -80f.dp)` offset is dropped: it shifted the zoom's sampling
 * pivot below the lens, and keeping every sample inside the capture element's own region is
 * the only behaviour Chromium guarantees.
 */
const backdropZoom = () => ({ factor: 1.5 })

/** `innerShadow = { InnerShadow(radius = 16f.dp) }` */
const lensInnerShadow = () => innerShadow(dp(16))

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
        :inner-shadow="lensInnerShadow"
        :backdrop-zoom="backdropZoom"
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

/*
 * The lens is positioned with `left`/`top`, NOT a CSS `transform`: Chromium silently
 * disables a `backdrop-filter: url(#…)` whose element sits inside a transformed ancestor
 * (the capture degrades to the untransformed backdrop), while plain `blur` keeps working —
 * which is why every other surface (transforms all `none` at rest) never exposed this.
 * A pure translation is exactly equivalent to moving `left`/`top`.
 */
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
