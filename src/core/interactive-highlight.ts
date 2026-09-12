import { Animatable, OffsetAnimatable, spring } from './animation'
import { inspectDragGestures, type DragPosition } from './drag-gestures'
import { coerceIn } from './math'

export interface InteractiveHighlightOptions {
  /**
   * `position(size, offset)` — the lambda upstream names its second parameter `offset`, but
   * what it receives is the **absolute local pointer position**, not the displacement. Kept
   * under the same name so the two files stay greppable against each other.
   */
  position?: (
    size: { width: number; height: number },
    offset: { x: number; y: number }
  ) => { x: number; y: number }
}

/** `drawRect(White.copy(0.08f * progress), BlendMode.Plus)` — the flat pass under the glow. */
const WASH_ALPHA = 0.08
/** `setColorUniform("color", White.copy(0.15f * progress))` — peak alpha of the glow. */
const GLOW_ALPHA = 0.15
/** `setFloatUniform("radius", size.minDimension * 1.5f)`. */
const GLOW_RADIUS_SCALE = 1.5
/** `smoothstep(radius, radius * 0.5, dist)` saturates to 1 below half the radius. */
const GLOW_CORE_SCALE = 0.5
/** Stops used to resolve the `smoothstep` falloff; the curve is smooth, 10 is plenty. */
const GLOW_STOPS = 10

/**
 * Reads a client point in the element's **untransformed local space**.
 *
 * `getBoundingClientRect()` reports the *transformed* box, so the obvious
 * `clientX - rect.left` is multiplied by however far the surface is currently stretched.
 * That matters here because the glow is drawn into a canvas that is CSS-transformed by the
 * very same `layerBlock`: a stretched coordinate would drift away from the finger exactly
 * while the finger is moving.
 *
 * Mapping through the box centre and dividing the scale back out cancels the transform
 * exactly — including its translation, because the canvas is displaced by that translation
 * again on the way to the screen. Rotation is not handled (no call site rotates), and would
 * degenerate to the naive mapping rather than return something meaningless.
 */
export function localPointerPosition(
  element: HTMLElement,
  clientX: number,
  clientY: number
): DragPosition {
  const rect = element.getBoundingClientRect()
  const width = element.offsetWidth || rect.width
  const height = element.offsetHeight || rect.height
  if (width <= 0 || height <= 0) return { x: clientX - rect.left, y: clientY - rect.top }
  const scaleX = rect.width / width || 1
  const scaleY = rect.height / height || 1
  return {
    x: (clientX - (rect.left + rect.width / 2)) / scaleX + width / 2,
    y: (clientY - (rect.top + rect.height / 2)) / scaleY + height / 2
  }
}

/**
 * Port of `com.kyant.backdrop.catalog.utils.InteractiveHighlight`.
 *
 * Upstream has two branches. On API ≥ 33 (`isRuntimeShaderSupported()`) it draws a flat
 * `White @ 0.08·progress` pass **plus** an AGSL radial glow at the pointer:
 *
 * ```glsl
 * float dist = distance(coord, position);
 * float intensity = smoothstep(radius, radius * 0.5, dist);
 * return color * intensity;               // color = White @ 0.15·progress
 * ```
 *
 * Below that it falls back to a single flat `White @ 0.25·progress`. The two add up to the
 * same energy (0.08 + 0.15 ≈ 0.25) — the shader branch just moves part of it into a falloff
 * that tracks the finger.
 *
 * The port used to implement only the fallback, because the shader branch was treated as
 * unreachable. It is not: `createRadialGradient` expresses `smoothstep` directly, so the
 * full branch is available on every engine. That is what this class draws now.
 */
export class InteractiveHighlight {
  private readonly pressProgressAnimationSpec = spring(0.5, 300, 0.001)
  private readonly positionAnimationSpec = spring(0.5, 300, 0.01)

  private readonly pressProgressAnimation = new Animatable(0)
  private readonly positionAnimation = new OffsetAnimatable(0, 0)

  private startPosition: DragPosition = { x: 0, y: 0 }

  constructor(private readonly options: InteractiveHighlightOptions = {}) {}

  get pressProgress(): number {
    return this.pressProgressAnimation.value
  }

  /** `offset` — displacement of the pointer from the down position. Drives the deformation. */
  get offset(): { x: number; y: number } {
    return {
      x: this.positionAnimation.x.value - this.startPosition.x,
      y: this.positionAnimation.y.value - this.startPosition.y
    }
  }

  /** Local pointer position — where the radial glow is centred. */
  get pointerPosition(): { x: number; y: number } {
    return { x: this.positionAnimation.x.value, y: this.positionAnimation.y.value }
  }

  highlightPosition(size: { width: number; height: number }): { x: number; y: number } {
    const position = this.options.position?.(size, this.pointerPosition) ?? this.pointerPosition
    return {
      x: coerceIn(position.x, 0, size.width),
      y: coerceIn(position.y, 0, size.height)
    }
  }

  /** Draws the press highlight into the already shape-clipped canvas. */
  draw(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const progress = this.pressProgress
    if (progress <= 0) return

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'

    // Flat pass. Always full-bleed, so it reads as the surface brightening as a whole.
    ctx.fillStyle = `rgba(255, 255, 255, ${WASH_ALPHA * progress})`
    ctx.fillRect(0, 0, width, height)

    // Radial pass — the part that follows the finger.
    const radius = Math.min(width, height) * GLOW_RADIUS_SCALE
    if (radius > 0) {
      const position = this.highlightPosition({ width, height })
      const core = radius * GLOW_CORE_SCALE
      const peak = GLOW_ALPHA * progress
      const gradient = ctx.createRadialGradient(position.x, position.y, core, position.x, position.y, radius)
      for (let i = 0; i <= GLOW_STOPS; i++) {
        const t = i / GLOW_STOPS
        // `smoothstep(radius, radius * 0.5, dist)` read from the outside in: `1 - t` is how
        // far the sample sits from the inner edge, in units of the falloff band.
        const u = 1 - t
        gradient.addColorStop(t, `rgba(255, 255, 255, ${peak * u * u * (3 - 2 * u)})`)
      }
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, width, height)
    }

    ctx.restore()
  }

  /** Attaches the pointer tracking. Returns a disposer. `hitTest` gates where a press may start. */
  attach(
    element: HTMLElement,
    localPoint: (event: PointerEvent) => DragPosition = (event) =>
      localPointerPosition(element, event.clientX, event.clientY),
    hitTest?: (position: DragPosition) => boolean
  ): () => void {
    return inspectDragGestures(
      element,
      {
        onDragStart: (down) => {
          this.startPosition = down
          void this.pressProgressAnimation.animateTo(1, this.pressProgressAnimationSpec)
          this.positionAnimation.snapTo(down.x, down.y)
        },
        onDragEnd: () => {
          void this.pressProgressAnimation.animateTo(0, this.pressProgressAnimationSpec)
          void this.positionAnimation.animateTo(
            this.startPosition.x,
            this.startPosition.y,
            this.positionAnimationSpec
          )
        },
        onDragCancel: () => {
          void this.pressProgressAnimation.animateTo(0, this.pressProgressAnimationSpec)
          void this.positionAnimation.animateTo(
            this.startPosition.x,
            this.startPosition.y,
            this.positionAnimationSpec
          )
        },
        onDrag: (_delta, position) => {
          this.positionAnimation.snapTo(position.x, position.y)
        }
      },
      localPoint,
      hitTest
    )
  }
}
