import { onBeforeUnmount, onMounted, type Ref } from 'vue'

/**
 * `Modifier.clickable` equivalent: fires on a press/release that stayed inside a slop
 * radius, matching Compose's tap detection (important for the draggable components, where
 * a drag must not also register as a click).
 */
export function useTap(
  el: Ref<HTMLElement | null | undefined>,
  onTap: () => void,
  slop = 8
): void {
  let active = false
  let startX = 0
  let startY = 0

  const down = (event: PointerEvent) => {
    active = true
    startX = event.clientX
    startY = event.clientY
  }

  const up = (event: PointerEvent) => {
    if (!active) return
    active = false
    if (Math.hypot(event.clientX - startX, event.clientY - startY) <= slop) onTap()
  }

  const cancel = () => {
    active = false
  }

  onMounted(() => {
    const node = el.value
    if (!node) return
    node.addEventListener('pointerdown', down)
    node.addEventListener('pointerup', up)
    node.addEventListener('pointercancel', cancel)
  })

  onBeforeUnmount(() => {
    const node = el.value
    if (!node) return
    node.removeEventListener('pointerdown', down)
    node.removeEventListener('pointerup', up)
    node.removeEventListener('pointercancel', cancel)
  })
}
