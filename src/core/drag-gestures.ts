/**
 * Port of `com.kyant.backdrop.catalog.utils.inspectDragGestures`.
 *
 * Notable properties preserved from the original:
 *  - the gesture is *not consumed*, so nested handlers (e.g. the magnifier's `draggable2D`
 *    and a parent scroll container) can still see the same pointer stream;
 *  - `onDragStart` receives the down position and fires immediately on pointer down;
 *  - `onDrag` is called once with a zero delta right after the down event.
 */

export interface DragDelta {
  x: number
  y: number
}

export interface DragPosition {
  x: number
  y: number
}

export interface DragCallbacks {
  onDragStart?: (down: DragPosition) => void
  onDragEnd?: () => void
  onDragCancel?: () => void
  onDrag: (delta: DragDelta, position: DragPosition) => void
}

/**
 * Attaches a drag inspector to `element`. Returns a disposer.
 *
 * @param localPoint converts a `PointerEvent` into element-local coordinates.
 */
export function inspectDragGestures(
  element: HTMLElement,
  callbacks: DragCallbacks,
  localPoint: (event: PointerEvent) => DragPosition
): () => void {
  let activeId: number | null = null
  let last: DragPosition = { x: 0, y: 0 }

  const down = (event: PointerEvent) => {
    if (activeId !== null) return
    activeId = event.pointerId
    const position = localPoint(event)
    last = position
    callbacks.onDragStart?.(position)
    callbacks.onDrag({ x: 0, y: 0 }, position)
  }

  const move = (event: PointerEvent) => {
    if (activeId !== event.pointerId) return
    const position = localPoint(event)
    const delta = { x: position.x - last.x, y: position.y - last.y }
    last = position
    callbacks.onDrag(delta, position)
  }

  const up = (event: PointerEvent) => {
    if (activeId !== event.pointerId) return
    activeId = null
    callbacks.onDragEnd?.()
  }

  const cancel = (event: PointerEvent) => {
    if (activeId !== event.pointerId) return
    activeId = null
    callbacks.onDragCancel?.()
  }

  // Pointer capture keeps the stream flowing even when the pointer leaves the element,
  // which mirrors Compose's behaviour of tracking the original pointer id.
  const downWithCapture = (event: PointerEvent) => {
    down(event)
    if (activeId !== null) {
      try {
        element.setPointerCapture(event.pointerId)
      } catch {
        /* ignore */
      }
    }
  }

  element.addEventListener('pointerdown', downWithCapture)
  element.addEventListener('pointermove', move)
  element.addEventListener('pointerup', up)
  element.addEventListener('pointercancel', cancel)

  return () => {
    element.removeEventListener('pointerdown', downWithCapture)
    element.removeEventListener('pointermove', move)
    element.removeEventListener('pointerup', up)
    element.removeEventListener('pointercancel', cancel)
  }
}
