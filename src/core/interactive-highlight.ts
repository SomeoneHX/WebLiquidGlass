import { Animatable, OffsetAnimatable, spring } from './animation'
import { inspectDragGestures, type DragPosition } from './drag-gestures'
import { coerceIn } from './math'

export interface InteractiveHighlightOptions {
  /** `position(size, offset)` — only consulted by the AGSL-shader path. */
  position?: (
    size: { width: number; height: number },
    offset: { x: number; y: number }
  ) => { x: number; y: number }
}

/**
 * Port of `com.kyant.backdrop.catalog.utils.InteractiveHighlight`.
 *
 * On API < 31 `isRuntimeShaderSupported()` is false, so the shader branch is skipped and
 * the fallback is used: a flat additive white wash whose opacity follows the press
 * progress (`drawRect(White.copy(0.25f * progress), BlendMode.Plus)`).
 *
 * That still means the highlight reacts to the pointer — only the radial falloff is gone.
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

  /** `offset` — displacement of the pointer from the down position. */
  get offset(): { x: number; y: number } {
    return {
      x: this.positionAnimation.x.value - this.startPosition.x,
      y: this.positionAnimation.y.value - this.startPosition.y
    }
  }

  /** Local pointer position (used by the shader branch and by `LiquidBottomTabs`). */
  get pointerPosition(): { x: number; y: number } {
    return { x: this.positionAnimation.x.value, y: this.positionAnimation.y.value }
  }

  highlightPosition(size: { width: number; height: number }): { x: number; y: number } {
    const position = this.options.position?.(size, this.offset) ?? this.offset
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
    ctx.fillStyle = `rgba(255, 255, 255, ${0.25 * progress})`
    ctx.fillRect(0, 0, width, height)
    ctx.restore()
  }

  /** Attaches the pointer tracking. Returns a disposer. */
  attach(
    element: HTMLElement,
    localPoint: (event: PointerEvent) => DragPosition = (event) => {
      const rect = element.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }
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
      localPoint
    )
  }
}
