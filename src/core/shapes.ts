/**
 * Shape abstraction mirroring `com.kyant.shapes` / `androidx.compose.ui.graphics.Shape`.
 *
 * A shape is resolved against the element's local (untransformed) box. The deformation
 * applied later via `layerBlock` transforms the whole clipped region, exactly like a
 * Compose `GraphicsLayer` with `clip = true`.
 */
export interface Shape {
  /** Builds the outline path in local coordinates (origin = element top-left). */
  buildPath(ctx: CanvasRenderingContext2D, width: number, height: number): void
  /** Same outline as a CSS `path()` string, for `clip-path` on the DOM content layer. */
  clipPath(width: number, height: number): string
  /** `[topLeft, topRight, bottomRight, bottomLeft]` — used by the refraction/lens effect. */
  cornerRadii(width: number, height: number): [number, number, number, number]
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  tl: number,
  tr: number,
  br: number,
  bl: number
): void {
  const w = width
  const h = height
  ctx.moveTo(tl, 0)
  ctx.lineTo(w - tr, 0)
  if (tr > 0) ctx.arcTo(w, 0, w, tr, tr)
  ctx.lineTo(w, h - br)
  if (br > 0) ctx.arcTo(w, h, w - br, h, br)
  ctx.lineTo(bl, h)
  if (bl > 0) ctx.arcTo(0, h, 0, h - bl, bl)
  ctx.lineTo(0, tl)
  if (tl > 0) ctx.arcTo(0, 0, tl, 0, tl)
  ctx.closePath()
}

function roundRectString(width: number, height: number, r: number): string {
  const w = width
  const h = height
  const rr = Math.min(r, Math.min(w, h) / 2)
  if (rr <= 0) return `M0 0 H${w} V${h} H0 Z`
  return [
    `M${rr} 0`,
    `H${w - rr}`,
    `A${rr} ${rr} 0 0 1 ${w} ${rr}`,
    `V${h - rr}`,
    `A${rr} ${rr} 0 0 1 ${w - rr} ${h}`,
    `H${rr}`,
    `A${rr} ${rr} 0 0 1 0 ${h - rr}`,
    `V${rr}`,
    `A${rr} ${rr} 0 0 1 ${rr} 0`,
    'Z'
  ].join(' ')
}

class RoundedRectShape implements Shape {
  constructor(private readonly radius: number | 'capsule') {}

  private resolved(width: number, height: number): number {
    const max = Math.min(width, height) / 2
    if (this.radius === 'capsule') return max
    return Math.min(this.radius, max)
  }

  buildPath(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const r = this.resolved(width, height)
    ctx.beginPath()
    roundRectPath(ctx, width, height, r, r, r, r)
  }

  clipPath(width: number, height: number): string {
    return `path("${roundRectString(width, height, this.resolved(width, height))}")`
  }

  cornerRadii(width: number, height: number): [number, number, number, number] {
    const r = this.resolved(width, height)
    return [r, r, r, r]
  }
}

/** `Capsule()` — stadium shape, fully rounded on the short axis. */
export const Capsule: Shape = new RoundedRectShape('capsule')

/** `RoundedRectangle(radius)` */
export function RoundedRectangle(radius: number): Shape {
  return new RoundedRectShape(radius)
}

/** `Rectangle` / `RectangleShape` */
export const Rectangle: Shape = {
  buildPath(ctx, width, height) {
    ctx.beginPath()
    ctx.rect(0, 0, width, height)
  },
  clipPath(width, height) {
    return `path("M0 0 H${width} V${height} H0 Z")`
  },
  cornerRadii() {
    return [0, 0, 0, 0]
  }
}
