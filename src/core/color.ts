/** Minimal colour helpers — Compose's `Color` / `Color.lerp` equivalents. */

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

export function rgba(r: number, g: number, b: number, a = 1): Rgba {
  return { r, g, b, a }
}

/**
 * `Color(0xFF0088FF)` / `Color(0xFF0088FF).copy(alpha = 0.2f)`
 *
 * Kotlin's `Color(long)` always takes a full **ARGB** literal, so the alpha byte is
 * mandatory (`0xFF0088FF`, not `0x0088FF`). A 24-bit value is accepted here as shorthand
 * for an opaque colour rather than silently decoding to `alpha = 0` — a transparent
 * palette entry is invisible, which is a maddening failure to trace back to a literal.
 */
export function argb(value: number, alpha?: number): Rgba {
  const hasAlphaByte = value > 0xffffff
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
    a: alpha ?? (hasAlphaByte ? ((value >>> 24) & 0xff) / 255 : 1)
  }
}

export function withAlpha(color: Rgba, alpha: number): Rgba {
  return { ...color, a: alpha }
}

export function lerpColor(start: Rgba, stop: Rgba, fraction: number): Rgba {
  const t = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction
  return {
    r: start.r + (stop.r - start.r) * t,
    g: start.g + (stop.g - start.g) * t,
    b: start.b + (stop.b - start.b) * t,
    a: start.a + (stop.a - start.a) * t
  }
}

export function toCss(color: Rgba): string {
  const r = Math.round(color.r)
  const g = Math.round(color.g)
  const b = Math.round(color.b)
  return `rgba(${r}, ${g}, ${b}, ${round(color.a)})`
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

export const Colors = {
  Black: rgba(0, 0, 0, 1),
  White: rgba(255, 255, 255, 1)
}

/* Palette used across the catalog — byte-for-byte the `Color(0x…)` literals from the
 * Kotlin components (`LiquidSlider.kt`, `LiquidToggle.kt`, `LiquidBottomTabs.kt`, …). */
export const Palette = {
  blueLight: argb(0xff0088ff),
  blueDark: argb(0xff0091ff),
  greenLight: argb(0xff34c759),
  greenDark: argb(0xff30d158),
  orange: argb(0xffff8d28),
  trackLight: argb(0xff787878, 0.2),
  trackDark: argb(0xff787880, 0.36)
}
