import { onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'
import type { Rect, Size } from '@/core/geometry'

/**
 * Global layout revision. Bumped whenever something that changes where an element sits on
 * screen happens (scroll / resize / orientation change / font load) so that every glass
 * surface re-samples the wallpaper at its new position.
 */
export const layoutEpoch = ref(0)

export function bumpLayoutEpoch(): void {
  layoutEpoch.value++
}

if (typeof window !== 'undefined') {
  const onScroll = () => bumpLayoutEpoch()
  window.addEventListener('scroll', onScroll, { passive: true, capture: true })
  window.addEventListener('resize', onScroll, { passive: true })
  window.addEventListener('orientationchange', onScroll, { passive: true })
}

/** Tracks an element's untransformed local size and viewport rect. */
export function useElementMetrics(el: Ref<HTMLElement | null | undefined>) {
  const size = ref<Size>({ width: 0, height: 0 })
  const rect = ref<Rect>({ left: 0, top: 0, width: 0, height: 0 })
  const observer = shallowRef<ResizeObserver | null>(null)
  let frame = 0

  const measure = () => {
    const node = el.value
    if (!node) return
    const box = node.getBoundingClientRect()
    const width = node.clientWidth || box.width
    const height = node.clientHeight || box.height
    if (size.value.width !== width || size.value.height !== height) {
      size.value = { width, height }
    }
    const next: Rect = { left: box.left, top: box.top, width, height }
    const prev = rect.value
    if (
      prev.left !== next.left ||
      prev.top !== next.top ||
      prev.width !== next.width ||
      prev.height !== next.height
    ) {
      rect.value = next
    }
  }

  const scheduleMeasure = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      measure()
    })
  }

  onMounted(() => {
    if (typeof ResizeObserver !== 'undefined') {
      observer.value = new ResizeObserver(scheduleMeasure)
      if (el.value) observer.value.observe(el.value)
    }
    measure()
  })

  watch(el, (node, previous) => {
    if (previous && observer.value) observer.value.unobserve(previous)
    if (node && observer.value) observer.value.observe(node)
    scheduleMeasure()
  })

  watch(layoutEpoch, scheduleMeasure)

  onBeforeUnmount(() => {
    if (frame) cancelAnimationFrame(frame)
    observer.value?.disconnect()
    observer.value = null
  })

  return { size, rect, measure, scheduleMeasure }
}
