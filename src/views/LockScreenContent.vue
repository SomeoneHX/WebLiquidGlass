<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'

import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import GlassSurface from '@/components/GlassSurface.vue'
import type { BackdropEffectScope } from '@/core/backdrop'
import type { SdfSource } from '@/core/glass-filter'
import { loadSdfTexture } from '@/core/sdf-texture'
import { dp } from '@/core/geometry'
import { Rectangle } from '@/core/shapes'
import { inspectDragGestures } from '@/core/drag-gestures'
import clockSdf from '@/assets/clock_sdf.webp'

/**
 * `LockScreenContent` — the draggable SDF clock plate.
 *
 * The 25 % white wash stays where the Kotlin build put it: **inside** the effects chain, via
 * `backdropWash` rather than `onDrawSurface`. `DrawBackdropModifier` records the backdrop and the
 * wash into one graphics layer and attaches the render effect to that layer, so the shader's
 * `content.eval(...) * v.a` cuts the wash to the glyphs along with everything else. Drawn on the
 * surface instead it becomes a lit rectangle over the whole 400×129 box.
 *
 * The 2D drag is a position-only offset, so the plate samples the region it actually covers.
 *
 * The 30 % black scrim on `.lock` is **not** part of the plate's backdrop upstream: it is the
 * background of the `Column` that `LockScreenContent` builds, while the recorded layer is the
 * wallpaper `Image` alone. The plate therefore refracts the raw wallpaper and sits in a dimmed
 * screen, which is what makes the face read as light through glass. `backdrop-scrim` declares the
 * scrim so the filter can subtract it again — without it the glyphs are dimmed twice and the
 * plate collapses into a flat tint on the wallpaper.
 *
 * The face is a **baked SDF texture** — `clock_sdf`, 1599×515, the static glyphs "12:45" rather
 * than a running clock — driving `SdfShader.apply(48.dp, 45f)`. The Android build runs that as an
 * AGSL runtime shader over a backdrop it recorded itself; here the same field is decoded into a
 * displacement map, the texture's alpha channel doubles as the shape mask, and the shader's bevel
 * tail collapses into one multiplier image. See § "SDF text" in `glass-filter.ts` for the three
 * substitutions and why each is exact rather than approximate.
 */
const plate = ref<InstanceType<typeof GlassSurface> | null>(null)
const plateEl = computed(() => (plate.value?.el as HTMLElement | null) ?? null)
const dragOffset = ref({ x: 0, y: 0 })

/**
 * The decoded field, fetched once on mount.
 *
 * It cannot be awaited inside `effects { }` — that block runs on every frame, synchronously, and
 * is not allowed to be the thing that waits for an image. So it takes whatever has been decoded
 * so far, and until that resolves the plate is plain blurred glass carrying its wash and its drag,
 * gaining the face the moment the decode lands. `loadSdfTexture` memoises per URL, so a remount
 * costs nothing, and a failure leaves the plate as it was rather than throwing on a frame.
 */
const sdfTexture = shallowRef<SdfSource | null>(null)
let decodeCancelled = false

onMounted(() => {
  loadSdfTexture(clockSdf)
    .then((texture) => {
      if (decodeCancelled) return
      sdfTexture.value = texture
      // Nothing in the redraw watcher knows about this ref — a texture arriving is not a size
      // change, a layout epoch or an animation tick, so the plate has to be told.
      plate.value?.scheduleRedraw()
    })
    .catch(() => undefined)
})

onBeforeUnmount(() => {
  decodeCancelled = true
})

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
  // `SdfShader.apply(48.dp, 45f)`. The texture is a third argument because there is no `SdfShader`
  // object here to close over it — the one signature in the port that is not 1:1 with Kotlin.
  scope.sdfTexture(dp(48), 45, sdfTexture.value)
}

/** `onDrawBackdrop { drawBackdrop(); drawRect(White.copy(0.25f)) }` */
const plateWash = () => ({ r: 255, g: 255, b: 255, alpha: 0.25 })

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
          :backdrop-wash="plateWash"
          :backdrop-scrim="0.3"
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
