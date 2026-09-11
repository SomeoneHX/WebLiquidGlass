<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import GlassSurface from '@/components/GlassSurface.vue'
import type { BackdropEffectScope } from '@/core/backdrop'
import { dp } from '@/core/geometry'
import { Rectangle } from '@/core/shapes'
import { inspectDragGestures } from '@/core/drag-gestures'
import clockSdf from '@/assets/clock_sdf.webp'

/**
 * `LockScreenContent` — the draggable SDF clock plate.
 *
 * Degraded (API < 31): `colorControls`, `blur` and the SDF refraction shader are all gone,
 * so the plate is the wallpaper with a 25 % white wash on top. The 2D drag still works, and
 * because the drag is a position-only translation the plate keeps sampling the image region
 * it actually covers.
 */
const plate = ref<InstanceType<typeof GlassSurface> | null>(null)
const plateEl = computed(() => (plate.value?.el as HTMLElement | null) ?? null)
const dragOffset = ref({ x: 0, y: 0 })

/**
 * This screen uses `Modifier.drawPlainBackdrop`, not `drawBackdrop`. `drawPlainBackdrop`
 * has no `highlight` / `shadow` parameters at all — unlike `drawBackdrop`, which defaults
 * them to `Highlight.Default` / `Shadow.Default` — so both must be disabled explicitly.
 */
const noHighlight = () => null
const noShadow = () => null

const effects = (scope: BackdropEffectScope): void => {
  scope.colorControls(-0.1, 0.75, 1.5)
  scope.blur(dp(2))
  scope.sdfTexture(dp(48), 45)
}

function onDrawBackdrop(ctx: CanvasRenderingContext2D, draw: () => void): void {
  draw()
  const size = plate.value?.size
  if (!size) return
  ctx.fillStyle = 'rgba(255, 255, 255, 0.25)'
  ctx.fillRect(0, 0, size.width, size.height)
}

const offset = () => dragOffset.value

onMounted(() => {
  if (!plateEl.value) return
  const detach = inspectDragGestures(
    plateEl.value,
    {
      onDrag: (delta) => {
        dragOffset.value = {
          x: dragOffset.value.x + delta.x,
          y: dragOffset.value.y + delta.y
        }
      }
    },
    (event) => ({ x: event.clientX, y: event.clientY })
  )
  onBeforeUnmount(detach)
})

void clockSdf
</script>

<template>
  <BackdropDemoScaffold v-slot="{ backdrop }">
    <div class="lock">
      <div class="lock__half">
        <GlassSurface
          ref="plate"
          class="lock__plate"
          content-class="lock__plate-content"
          :backdrop="backdrop"
          :shape="Rectangle"
          :highlight="noHighlight"
          :shadow="noShadow"
          :effects="effects"
          :offset="offset"
          :on-draw-backdrop="onDrawBackdrop"
        />
      </div>
      <div class="lock__half" />
    </div>
  </BackdropDemoScaffold>
</template>

<style scoped>
.lock {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: rgba(0, 0, 0, 0.3);
}

.lock__half {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.lock__plate {
  margin: 0 48px;
  max-width: 400px;
  width: 100%;
  aspect-ratio: 1599 / 515;
  cursor: grab;
  touch-action: none;
}
</style>
