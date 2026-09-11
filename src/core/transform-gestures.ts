/**
 * Port of `androidx.compose.foundation.gestures.detectTransformGestures`.
 *
 * Tracks one or more pointers and reports the change in centroid (pan), mean span (zoom)
 * and mean angle (rotation) since the previous event. Matches the parts of the Compose
 * behaviour the catalog relies on:
 *
 *  - the gesture only starts once the accumulated movement passes the touch slop;
 *  - adding/removing a pointer re-baselines the span/angle instead of emitting a jump;
 *  - `rotate` is in **degrees**, `zoom` is a multiplier (`1` == no change).
 */
export interface TransformGestureEvent {
  centroid: { x: number; y: number }
  pan: { x: number; y: number }
  zoom: number
  rotate: number
}

function centroidOf(points: { x: number; y: number }[]): { x: number; y: number } {
  let x = 0
  let y = 0
  for (const point of points) {
    x += point.x
    y += point.y
  }
  return { x: x / points.length, y: y / points.length }
}

function spanOf(points: { x: number; y: number }[]): number {
  let sum = 0
  let count = 0
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      sum += Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y)
      count++
    }
  }
  return count === 0 ? 0 : sum / count
}

function angleOf(points: { x: number; y: number }[]): number {
  if (points.length < 2) return 0
  return (Math.atan2(points[1].y - points[0].y, points[1].x - points[0].x) * 180) / Math.PI
}

export function inspectTransformGestures(
  element: HTMLElement,
  onGesture: (event: TransformGestureEvent) => void,
  slop = 8
): () => void {
  const pointers = new Map<number, { x: number; y: number }>()
  let pastCentroid = { x: 0, y: 0 }
  let pastSpan = 0
  let pastAngle = 0
  let started = false

  const reset = () => {
    const points = Array.from(pointers.values())
    if (points.length === 0) {
      pastCentroid = { x: 0, y: 0 }
      pastSpan = 0
      pastAngle = 0
      started = false
      return
    }
    pastCentroid = centroidOf(points)
    pastSpan = spanOf(points)
    pastAngle = angleOf(points)
  }

  const down = (event: PointerEvent) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    reset()
    try {
      element.setPointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
  }

  const move = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const points = Array.from(pointers.values())
    const centroid = centroidOf(points)
    const span = spanOf(points)
    const angle = angleOf(points)

    const pan = { x: centroid.x - pastCentroid.x, y: centroid.y - pastCentroid.y }
    if (!started) {
      if (Math.hypot(pan.x, pan.y) * 2 < slop && points.length < 2) return
      started = true
    }

    const zoom = pastSpan > 0 ? span / pastSpan : 1
    let rotate = angle - pastAngle
    if (rotate > 180) rotate -= 360
    if (rotate < -180) rotate += 360
    if (points.length < 2) rotate = 0

    pastCentroid = centroid
    pastSpan = span
    pastAngle = angle
    onGesture({ centroid, pan, zoom, rotate })
  }

  const up = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return
    reset()
    try {
      element.releasePointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
  }

  element.addEventListener('pointerdown', down)
  element.addEventListener('pointermove', move)
  element.addEventListener('pointerup', up)
  element.addEventListener('pointercancel', up)

  return () => {
    element.removeEventListener('pointerdown', down)
    element.removeEventListener('pointermove', move)
    element.removeEventListener('pointerup', up)
    element.removeEventListener('pointercancel', up)
  }
}
