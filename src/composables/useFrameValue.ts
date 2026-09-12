import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

import { animationRevision } from '@/core/animation'

/**
 * Mirrors a value that is driven by the animation runtime into a Vue ref so it can be used
 * in templates (e.g. the slider fill width, the bottom-tabs indicator offset).
 *
 * The animation values are intentionally *outside* Vue's reactivity — they are plain JS
 * stepped by the shared frame loop — so `animationRevision` is the invalidation signal.
 *
 * The getter is evaluated **inside the watch source**, not inside the callback. That matters:
 * a `watch` source runs in an effect scope, so every reactive read the getter makes — a
 * `useElementMetrics` size, an exposed `GlassSurface.size`, a theme flag — registers as a
 * dependency and re-runs the source. Calling the getter in the callback instead would track
 * only `animationRevision`, and a value that is *also* a function of layout would then stay
 * frozen at its pre-layout reading until some animation happened to bump the revision.
 *
 * That was a real bug: `LiquidSlider` computes its thumb offset from the track width, which is
 * 0 until `measure()` runs in `onMounted`. The thumb rendered at `-size/2` (hanging off the
 * left edge, fill empty) and only jumped to its true position — dead centre at `value = 50` —
 * on the first press, because `press()` was the first thing to start a spring and bump the
 * revision. The value was never wrong, just never invalidated.
 */
export function useFrameValue<T>(getter: () => T): Ref<T> {
  const value = ref(getter()) as Ref<T>
  const stop = watch(
    () => {
      // Read the frame signal so a new frame re-runs the getter, and let the getter's own
      // reactive dependencies pile onto the same source.
      void animationRevision.value
      return getter()
    },
    (next) => {
      if (next !== value.value) value.value = next
    },
    { flush: 'post' }
  )
  onBeforeUnmount(stop)
  return value
}
