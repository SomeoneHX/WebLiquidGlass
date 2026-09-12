import { Animatable, MutatorMutex, awaitFrame, spring, subscribeTick } from './animation'
import { inspectDragGestures, type DragDelta, type DragPosition } from './drag-gestures'
import { VelocityTracker } from './velocity-tracker'

export interface DampedDragAnimationOptions {
  initialValue: number
  valueRange: [number, number]
  visibilityThreshold: number
  initialScale: number
  pressedScale: number
  onDragStarted?: (position: DragPosition) => void
  onDragStopped?: (animation: DampedDragAnimation) => void
  onDrag: (animation: DampedDragAnimation, size: { width: number; height: number }, delta: DragDelta) => void
}

/**
 * Port of `com.kyant.backdrop.catalog.utils.DampedDragAnimation`.
 *
 * This is the component that produces the catalog's signature *deformation*: while a
 * pointer is held down the dragged element squashes/stretches (`scaleX` / `scaleY`) and a
 * velocity-driven skew is layered on top. All of that is pure `GraphicsLayer` maths, so it
 * survives on API < 31 where neither RenderEffect nor AGSL shaders exist.
 */
export class DampedDragAnimation {
  private readonly valueAnimationSpec: ReturnType<typeof spring>
  private readonly velocityAnimationSpec: ReturnType<typeof spring>
  private readonly pressProgressAnimationSpec: ReturnType<typeof spring>
  private readonly scaleXAnimationSpec: ReturnType<typeof spring>
  private readonly scaleYAnimationSpec: ReturnType<typeof spring>

  private readonly valueAnimation: Animatable
  private readonly velocityAnimation: Animatable
  private readonly pressProgressAnimation: Animatable
  private readonly scaleXAnimation: Animatable
  private readonly scaleYAnimation: Animatable

  private readonly mutatorMutex = new MutatorMutex()
  private readonly velocityTracker = new VelocityTracker()

  readonly valueRange: [number, number]
  readonly pressedScale: number
  readonly initialScale: number

  constructor(private readonly options: DampedDragAnimationOptions) {
    const { visibilityThreshold, initialScale, initialValue, pressedScale, valueRange } = options
    this.valueRange = valueRange
    this.initialScale = initialScale
    this.pressedScale = pressedScale

    this.valueAnimationSpec = spring(1, 1000, visibilityThreshold)
    this.velocityAnimationSpec = spring(0.5, 300, visibilityThreshold * 10)
    this.pressProgressAnimationSpec = spring(1, 1000, 0.001)
    this.scaleXAnimationSpec = spring(0.6, 250, 0.001)
    this.scaleYAnimationSpec = spring(0.7, 250, 0.001)

    this.valueAnimation = new Animatable(initialValue)
    this.valueAnimation.onUpdate = () => this.updateVelocity()
    this.velocityAnimation = new Animatable(0)
    this.pressProgressAnimation = new Animatable(0)
    this.scaleXAnimation = new Animatable(initialScale)
    this.scaleYAnimation = new Animatable(initialScale)
  }

  get value(): number {
    return this.valueAnimation.value
  }

  get progress(): number {
    const [start, end] = this.valueRange
    return (this.value - start) / (end - start)
  }

  get targetValue(): number {
    return this.valueAnimation.targetValue
  }

  get pressProgress(): number {
    return this.pressProgressAnimation.value
  }

  get scaleX(): number {
    return this.scaleXAnimation.value
  }

  get scaleY(): number {
    return this.scaleYAnimation.value
  }

  get velocity(): number {
    return this.velocityAnimation.value
  }

  press(): void {
    this.velocityTracker.resetTracking()
    void this.pressProgressAnimation.animateTo(1, this.pressProgressAnimationSpec)
    void this.scaleXAnimation.animateTo(this.pressedScale, this.scaleXAnimationSpec)
    void this.scaleYAnimation.animateTo(this.pressedScale, this.scaleYAnimationSpec)
  }

  release(): void {
    void (async () => {
      await awaitFrame()
      if (this.value !== this.targetValue) {
        const [start, end] = this.valueRange
        const threshold = (end - start) * 0.025
        await new Promise<void>((resolve) => {
          const unsubscribe = subscribeTick(() => {
            if (Math.abs(this.value - this.targetValue) < threshold) {
              unsubscribe()
              resolve()
            }
          })
        })
      }
      void this.pressProgressAnimation.animateTo(0, this.pressProgressAnimationSpec)
      void this.scaleXAnimation.animateTo(this.initialScale, this.scaleXAnimationSpec)
      void this.scaleYAnimation.animateTo(this.initialScale, this.scaleYAnimationSpec)
    })()
  }

  updateValue(value: number): void {
    const targetValue = clampToRange(value, this.valueRange)
    void this.valueAnimation.animateTo(targetValue, this.valueAnimationSpec)
  }

  /** `updateVelocity()` — fed by the value animation on every frame. */
  private updateVelocity(): void {
    this.velocityTracker.addPosition(performanceNow(), { x: this.value, y: 0 })
    const [start, end] = this.valueRange
    const targetVelocity = this.velocityTracker.calculateVelocity().x / (end - start)
    void this.velocityAnimation.animateTo(targetVelocity, this.velocityAnimationSpec)
  }

  /** `animateToValue` — press, glide to the target, release. */
  animateToValue(value: number): void {
    void this.mutatorMutex.mutate(async () => {
      this.press()
      const targetValue = clampToRange(value, this.valueRange)
      void this.valueAnimation.animateTo(targetValue, this.valueAnimationSpec)
      if (this.velocity !== 0) {
        void this.velocityAnimation.animateTo(0, this.velocityAnimationSpec)
      }
      this.release()
    })
  }

  /**
   * Attaches the drag gesture. Returns a disposer. `hitTest` gates where a drag may start:
   * a pointerdown outside the gate neither presses nor begins a drag (clicks fall through to
   * the underlying controls) — used when the gesture is attached to a larger element than
   * the dragged visual, e.g. the bottom tabs' bar.
   */
  attach(
    element: HTMLElement,
    localPoint: (event: PointerEvent) => DragPosition = (event) => {
      const rect = element.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    },
    hitTest?: (position: DragPosition) => boolean
  ): () => void {
    return inspectDragGestures(
      element,
      {
        onDragStart: (down) => {
          this.options.onDragStarted?.(down)
          this.press()
        },
        onDragEnd: () => {
          this.options.onDragStopped?.(this)
          this.release()
        },
        onDragCancel: () => {
          this.options.onDragStopped?.(this)
          this.release()
        },
        onDrag: (delta) => {
          const size = { width: element.clientWidth, height: element.clientHeight }
          this.options.onDrag(this, size, delta)
        }
      },
      localPoint,
      hitTest
    )
  }
}

function clampToRange(value: number, range: [number, number]): number {
  const [start, end] = range
  return value < start ? start : value > end ? end : value
}

function performanceNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
