/**
 * A tiny animation runtime mirroring `androidx.compose.animation.core`.
 *
 * Compose animates every catalog component with spring physics, so the spring solver
 * here is a faithful port of the damped-harmonic-oscillator solution Compose uses
 * (`stiffness` => omega0 = sqrt(stiffness), `dampingRatio` => zeta).
 *
 * A single global `requestAnimationFrame` loop drives every running animation; it only
 * ticks while at least one animation is running, which keeps static screens completely
 * idle (important: the catalog has up to 100 list items on screen).
 */

import { ref } from 'vue'

export type Easing = (fraction: number) => number

export const LinearEasing: Easing = (t) => t

/** Compose's default `tween` easing: cubic-bezier(0.4, 0, 0.2, 1). */
export const FastOutSlowInEasing: Easing = (t) => cubicBezier(0.4, 0, 0.2, 1, t)

function cubicBezier(x1: number, y1: number, x2: number, y2: number, t: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  let x = t
  for (let i = 0; i < 8; i++) {
    const xEst = bezierAxis(x1, x2, x)
    const dx = bezierAxisDerivative(x1, x2, x)
    if (Math.abs(dx) < 1e-6) break
    const delta = xEst - t
    x -= delta / dx
    if (Math.abs(delta) < 1e-6) break
  }
  x = x < 0 ? 0 : x > 1 ? 1 : x
  return bezierAxis(y1, y2, x)
}

function bezierAxis(p1: number, p2: number, t: number): number {
  const mt = 1 - t
  return 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t
}

function bezierAxisDerivative(p1: number, p2: number, t: number): number {
  const mt = 1 - t
  return 3 * mt * mt * p1 + 6 * mt * t * (p2 - p1) + 3 * t * t * (1 - p2)
}

export interface AnimationSpec {
  readonly kind: 'spring' | 'tween'
  /** Returns true when the animation has settled. */
  isAt(value: number, target: number, velocity: number): boolean
  /** Steps the simulation forward by `dtSeconds`, returning the new value/velocity. */
  step(value: number, target: number, velocity: number, dtSeconds: number): [number, number]
}

interface SpringOptions {
  dampingRatio: number
  stiffness: number
  visibilityThreshold: number
}

/** `spring(dampingRatio, stiffness, visibilityThreshold)` */
export function spring(
  dampingRatio = 1,
  stiffness = 1500,
  visibilityThreshold = 0.01
): AnimationSpec {
  return new SpringSpec({ dampingRatio, stiffness, visibilityThreshold })
}

/** `tween(durationMillis, easing)` */
export function tween(durationMillis = 300, easing: Easing = FastOutSlowInEasing): AnimationSpec {
  return new TweenSpec(durationMillis, easing)
}

class SpringSpec implements AnimationSpec {
  readonly kind = 'spring' as const
  private readonly w0: number
  private readonly zeta: number
  private readonly threshold: number

  constructor(options: SpringOptions) {
    this.w0 = Math.sqrt(options.stiffness)
    this.zeta = options.dampingRatio
    this.threshold = options.visibilityThreshold
  }

  isAt(value: number, target: number, velocity: number): boolean {
    const x = value - target
    // Spring specs in Compose settle on the distance threshold; we additionally require
    // a small velocity so the visual stop matches the Android feel.
    return Math.abs(x) <= this.threshold && Math.abs(velocity) <= this.threshold * 25
  }

  step(value: number, target: number, velocity: number, dt: number): [number, number] {
    const x0 = value - target
    const v0 = velocity
    const { w0, zeta } = this
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta)
      const a = x0
      const b = (v0 + zeta * w0 * x0) / wd
      const e = Math.exp(-zeta * w0 * dt)
      const cos = Math.cos(wd * dt)
      const sin = Math.sin(wd * dt)
      const x = e * (a * cos + b * sin)
      const v = e * (-zeta * w0 * (a * cos + b * sin) + (-a * wd * sin + b * wd * cos))
      return [target + x, v]
    }
    if (zeta === 1) {
      const e = Math.exp(-w0 * dt)
      const c = v0 + w0 * x0
      const x = e * (x0 + c * dt)
      const v = e * (c - w0 * (x0 + c * dt))
      return [target + x, v]
    }
    // Over-damped: two real roots.
    const s = w0 * Math.sqrt(zeta * zeta - 1)
    const r1 = -zeta * w0 + s
    const r2 = -zeta * w0 - s
    const c1 = (v0 - x0 * r2) / (r1 - r2)
    const c2 = x0 - c1
    let x = c1 * Math.exp(r1 * dt) + c2 * Math.exp(r2 * dt)
    // Over-damped springs must not cross the target.
    if (x0 !== 0 && Math.sign(x) !== Math.sign(x0)) x = 0
    const v = c1 * r1 * Math.exp(r1 * dt) + c2 * r2 * Math.exp(r2 * dt)
    return [target + x, v]
  }
}

class TweenSpec implements AnimationSpec {
  readonly kind = 'tween' as const

  constructor(
    private readonly durationMillis: number,
    private readonly easing: Easing
  ) {}

  isAt(value: number, target: number): boolean {
    return Math.abs(value - target) < 1e-4
  }

  step(value: number, target: number, _velocity: number, dt: number): [number, number] {
    const from = this.start ?? value
    if (this.start === undefined) this.start = value
    this.elapsed += dt * 1000
    const fraction = Math.min(1, this.elapsed / this.durationMillis)
    const eased = this.easing(fraction)
    const next = fraction >= 1 ? target : from + (target - from) * eased
    return [next, 0]
  }

  private start: number | undefined
  private elapsed = 0

  reset(): void {
    this.start = undefined
    this.elapsed = 0
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Global frame loop                                                                             */
/* -------------------------------------------------------------------------------------------- */

export type TickListener = (dtSeconds: number) => void

const listeners = new Set<TickListener>()
let rafHandle = 0
let lastTimestamp = 0

/** Incremented once per animation frame; used to de-duplicate per-frame work. */
export const frameCounter = { value: 0 }

function loop(timestamp: number): void {
  const dt = lastTimestamp === 0 ? 1 / 60 : Math.min(0.05, (timestamp - lastTimestamp) / 1000)
  lastTimestamp = timestamp
  frameCounter.value++
  // Copy so listeners can unsubscribe during the tick.
  for (const listener of Array.from(listeners)) listener(dt)
  if (listeners.size > 0) {
    rafHandle = requestAnimationFrame(loop)
  } else {
    rafHandle = 0
    lastTimestamp = 0
  }
}

/** True while at least one animation is running. */
export function isTicking(): boolean {
  return listeners.size > 0
}

/** Registers `listener` to be called on every animation frame while running. */
export function subscribeTick(listener: TickListener): () => void {
  listeners.add(listener)
  if (rafHandle === 0) {
    if (typeof requestAnimationFrame === 'function') rafHandle = requestAnimationFrame(loop)
  }
  return () => {
    listeners.delete(listener)
  }
}

/** `awaitFrame()` — waits for the next animation frame. */
export function awaitFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 16)
  })
}

/* -------------------------------------------------------------------------------------------- */
/* Animatable                                                                                    */
/* -------------------------------------------------------------------------------------------- */

export interface AnimationState {
  /** A monotonically increasing revision, bumped whenever the value changes. */
  readonly revision: number
}

/**
 * Shared revision that every `Animatable` bumps — used to invalidate canvases.
 *
 * This *must* be backed by a Vue `ref`. Vue's `computed`/`watch` only re-evaluate when a
 * **reactive** dependency is read, so a plain `{ value: n }` counter would silently freeze
 * every consumer: the spring solver would keep ticking, but `contentStyle`, `useFrameValue`
 * and `GlassSurface`'s redraw watcher would never see a change and the DOM would stay at
 * its initial (identity) state — the whole UI looks unresponsive to clicks.
 */
const revisionRef = ref(0)

export const animationRevision = {
  get value(): number {
    return revisionRef.value
  },
  bump(): void {
    revisionRef.value++
  }
}

/**
 * Asks every glass surface to re-render on the next frame. Used for state that lives
 * outside the animation runtime (raw pointer offsets, theme switches, …).
 */
export function requestRedraw(): void {
  animationRevision.bump()
}

export class MutatorMutex {
  private locked = false

  async mutate<T>(block: () => Promise<T>): Promise<T | undefined> {
    if (this.locked) return undefined
    this.locked = true
    try {
      return await block()
    } finally {
      this.locked = false
    }
  }
}

export type AnimatableKey = string | number | symbol

/**
 * `Animatable` for a single float. Supports spring/tween specs, `snapTo`, `animateTo`
 * and `stop`, plus an `onUpdate` callback (the Compose version reports velocity changes
 * via `block`).
 */
export class Animatable {
  private _value: number
  private _targetValue: number
  private velocity = 0
  private spec: AnimationSpec | null = null
  private unsubscribe: (() => void) | null = null
  /** Called on every value change — mirrors the `block` of `Animatable.animateTo`. */
  onUpdate: ((value: number, velocity: number) => void) | null = null
  /** Arbitrary key so parallel animations on the same value can cancel each other. */
  readonly key: AnimatableKey

  constructor(initialValue: number, key: AnimatableKey = 'default') {
    this._value = initialValue
    this._targetValue = initialValue
    this.key = key
  }

  get value(): number {
    return this._value
  }

  get targetValue(): number {
    return this._targetValue
  }

  get currentVelocity(): number {
    return this.velocity
  }

  snapTo(value: number): void {
    this.stop()
    this.setValue(value)
    this._targetValue = value
    this.velocity = 0
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.spec = null
  }

  /** `animateTo(target, spec)` — resolves once the animation settles. */
  animateTo(target: number, spec: AnimationSpec, initialVelocity?: number): Promise<void> {
    this.stop()
    this._targetValue = target
    if (initialVelocity !== undefined) this.velocity = initialVelocity
    this.spec = spec
    if (spec.kind === 'tween') (spec as TweenSpec).reset()

    return new Promise<void>((resolve) => {
      this.unsubscribe = subscribeTick((dt) => {
        const spec = this.spec
        if (!spec) {
          resolve()
          return
        }
        const [nextValue, nextVelocity] = spec.step(
          this._value,
          this._targetValue,
          this.velocity,
          dt
        )
        this.velocity = nextVelocity
        const settled = spec.isAt(nextValue, this._targetValue, nextVelocity)
        this.setValue(settled ? this._targetValue : nextValue)
        if (settled) {
          this.velocity = 0
          this.stop()
          resolve()
        }
      })
    })
  }

  private setValue(value: number): void {
    if (value === this._value) return
    this._value = value
    animationRevision.bump()
    this.onUpdate?.(value, this.velocity)
  }}

/** `Animatable(Offset.Zero, Offset.VectorConverter)` — animates x and y independently. */
export class OffsetAnimatable {
  readonly x: Animatable
  readonly y: Animatable

  constructor(x = 0, y = 0) {
    this.x = new Animatable(x)
    this.y = new Animatable(y)
  }

  get value(): { x: number; y: number } {
    return { x: this.x.value, y: this.y.value }
  }

  get targetValue(): { x: number; y: number } {
    return { x: this.x.targetValue, y: this.y.targetValue }
  }

  snapTo(x: number, y: number): void {
    this.x.snapTo(x)
    this.y.snapTo(y)
  }

  stop(): void {
    this.x.stop()
    this.y.stop()
  }

  async animateTo(x: number, y: number, spec: AnimationSpec): Promise<void> {
    await Promise.all([this.x.animateTo(x, spec), this.y.animateTo(y, spec)])
  }
}
