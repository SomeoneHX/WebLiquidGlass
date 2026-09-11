/**
 * Numeric helpers mirroring `androidx.compose.ui.util` + the Kotlin stdlib functions used
 * by the original Compose sources.
 */

export function lerp(start: number, stop: number, fraction: number): number {
  return start + (stop - start) * fraction
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** `offset.fastCoerceIn(0f, 1f)` */
export function coerceIn(value: number, min: number, max: number): number {
  return clamp(value, min, max)
}

export function coerceAtLeast(value: number, min: number): number {
  return value < min ? min : value
}

export function coerceAtMost(value: number, max: number): number {
  return value > max ? max : value
}

export function sign(value: number): number {
  if (value > 0) return 1
  if (value < 0) return -1
  return 0
}

export function abs(value: number): number {
  return Math.abs(value)
}

/** `(1f - exp(-abs(progress))) * progress.sign` */
export function easeOutExpoLike(progress: number): number {
  return (1 - Math.exp(-Math.abs(progress))) * sign(progress)
}

/** Compose `EaseIn` cubic bezier (0.32, 0, 0.67, 0). */
export function easeIn(t: number): number {
  const x1 = 0.32,
    y1 = 0,
    x2 = 0.67,
    y2 = 0
  // Solve for t given x (monotone, so a few Newton steps are plenty).
  let x = t
  for (let i = 0; i < 8; i++) {
    const xEst = cubicBezier(x1, x2, x)
    const dx = cubicBezierDerivative(x1, x2, x)
    if (Math.abs(dx) < 1e-6) break
    const delta = xEst - t
    x -= delta / dx
    if (Math.abs(delta) < 1e-6) break
  }
  x = clamp(x, 0, 1)
  return cubicBezier(y1, y2, x)
}

/** Compose `EaseOut` cubic bezier (0, 0, 0.58, 1). */
export function easeOut(t: number): number {
  const x1 = 0,
    y1 = 0,
    x2 = 0.58,
    y2 = 1
  let x = t
  for (let i = 0; i < 8; i++) {
    const xEst = cubicBezier(x1, x2, x)
    const dx = cubicBezierDerivative(x1, x2, x)
    if (Math.abs(dx) < 1e-6) break
    const delta = xEst - t
    x -= delta / dx
    if (Math.abs(delta) < 1e-6) break
  }
  x = clamp(x, 0, 1)
  return cubicBezier(y1, y2, x)
}

/** Cubic bezier with P0 = 0, P3 = 1 evaluated on one axis. */
function cubicBezier(p1: number, p2: number, t: number): number {
  const mt = 1 - t
  return 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t
}

function cubicBezierDerivative(p1: number, p2: number, t: number): number {
  const mt = 1 - t
  return 3 * mt * mt * p1 + 6 * mt * t * (p2 - p1) + 3 * t * t * (1 - p2)
}

/**
 * Compose `EaseOut.transform(abs(fraction))` — used for the bottom tab panel offset.
 * Also exposed as `easeOut`.
 */
export const EaseOut = { transform: easeOut }
export const EaseIn = { transform: easeIn }
