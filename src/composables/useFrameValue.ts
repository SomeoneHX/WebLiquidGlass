import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

import { animationRevision } from '@/core/animation'

/**
 * Mirrors a value that is driven by the animation runtime into a Vue ref so it can be used
 * in templates (e.g. the slider fill width, the bottom-tabs indicator offset).
 *
 * The animation values are intentionally *outside* Vue's reactivity — they are plain JS
 * stepped by the shared frame loop — so `animationRevision` is the invalidation signal.
 */
export function useFrameValue<T>(getter: () => T): Ref<T> {
  const value = ref(getter()) as Ref<T>
  const stop = watch(
    () => animationRevision.value,
    () => {
      const next = getter()
      if (next !== value.value) value.value = next
    },
    { flush: 'post' }
  )
  onBeforeUnmount(stop)
  return value
}
