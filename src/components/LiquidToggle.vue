<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import GlassSurface from './GlassSurface.vue'
import type { Backdrop, BackdropEffectScope, Highlight, Shadow } from '@/core/backdrop'
import { HighlightStyles } from '@/core/backdrop'
import { Colors, Palette, lerpColor, toCss, withAlpha } from '@/core/color'
import { DampedDragAnimation } from '@/core/damped-drag-animation'
import { coerceIn, lerp } from '@/core/math'
import { dp, type LayerTransform } from '@/core/geometry'
import { Capsule } from '@/core/shapes'
import { useFrameValue } from '@/composables/useFrameValue'

/**
 * `LiquidToggle` — `app/src/commonMain/.../components/LiquidToggle.kt`
 *
 * The track is a plain DOM capsule sitting *behind* the thumb, so the thumb's `backdrop-filter`
 * picks it up for free — there is no recorded track layer. But the recorded layer is not only
 * about *capture*: the Kotlin also composites it into the thumb's backdrop **scaled**
 * (`LiquidToggle.kt:145-156`), and that scale is a visible design element, not thickness.
 * An earlier revision of this port dropped it as "a flat colour is scale-invariant"; that is
 * wrong twice over — the recorded layer is `clip(Capsule())`, so scaling changes its *shape*,
 * and the scale runs from `scaleY = 0` (collapsed) to `0.75`, which is what makes the glass
 * look like it is being stretched over the track. See `trackInnerTransform` below for the
 * measurements and for how the DOM expresses it.
 *
 * What still carries the deformation: `innerTransform` squashes the thumb through its
 * `layerBlock` (plus a velocity skew), and because the backdrop is captured by the browser
 * and inverse-transformed, the track seen through the thumb stays pinned to the screen while
 * the capsule stretches. `onDrawSurface` fades the white cover to 0 while pressed so the
 * track shows through.
 *
 * Note the original has no `clickable`: a plain tap is handled by the drag gesture's
 * `onDragStopped` with `didDrag == false`, which flips the state. The gesture lives on the
 * 40x24 thumb, so only the thumb is interactive.
 */
const props = defineProps<{
  selected: boolean
  isLightTheme: boolean
  backdrop: Backdrop
}>()

const emit = defineEmits<{ select: [value: boolean] }>()

const thumb = ref<InstanceType<typeof GlassSurface> | null>(null)
const thumbEl = computed(() => (thumb.value?.el as HTMLElement | null) ?? null)

const DRAG_WIDTH = dp(20)
const PADDING = dp(2)

/* ------------------------------------------------------------------ geometry ---------- */
/** Density is 1, so these are the CSS px of the stylesheet below, verbatim. */
const TRACK_W = 64
const TRACK_H = 28
const TRACK_R = TRACK_H / 2
const THUMB_W = 40
const THUMB_H = 24
const THUMB_TOP = dp(2)
/** The thumb box's centre — the pivot every `graphicsLayer` scale in this component uses. */
const THUMB_CY = THUMB_TOP + THUMB_H / 2

/** `Capsule()` on the track itself, as the outer boundary for the clip below. */
const TRACK_OUTLINE = [
  `M${TRACK_R} 0`,
  `H${TRACK_W - TRACK_R}`,
  `A${TRACK_R} ${TRACK_R} 0 0 1 ${TRACK_W} ${TRACK_R}`,
  `A${TRACK_R} ${TRACK_R} 0 0 1 ${TRACK_W - TRACK_R} ${TRACK_H}`,
  `H${TRACK_R}`,
  `A${TRACK_R} ${TRACK_R} 0 0 1 0 ${TRACK_R}`,
  `A${TRACK_R} ${TRACK_R} 0 0 1 ${TRACK_R} 0`,
  'Z'
].join(' ')

const accent = computed(() => (props.isLightTheme ? Palette.greenLight : Palette.greenDark))
const trackColor = computed(() => (props.isLightTheme ? Palette.trackLight : Palette.trackDark))

const fraction = ref(props.selected ? 1 : 0)
let didDrag = false

const animation = new DampedDragAnimation({
  initialValue: fraction.value,
  valueRange: [0, 1],
  visibilityThreshold: 0.001,
  initialScale: 1,
  pressedScale: 1.5,
  onDragStopped: (self) => {
    if (didDrag) {
      fraction.value = self.targetValue >= 0.5 ? 1 : 0
      emit('select', fraction.value === 1)
      didDrag = false
    } else {
      fraction.value = props.selected ? 0 : 1
      emit('select', fraction.value === 1)
    }
  },
  onDrag: (_self, _size, delta) => {
    if (!didDrag) didDrag = delta.x !== 0
    fraction.value = coerceIn(fraction.value + delta.x / DRAG_WIDTH, 0, 1)
  }
})

watch(fraction, (value) => animation.updateValue(value))
watch(
  () => props.selected,
  (isSelected) => {
    const target = isSelected ? 1 : 0
    if (target !== fraction.value) {
      fraction.value = target
      animation.animateToValue(target)
    }
  }
)

/**
 * Track colour: `drawBehind { drawRect(lerp(trackColor, accentColor, fraction)) }` with the same
 * **animated** `fraction` as the thumb offset (`LiquidToggle.kt:126-127`). It has to be a frame
 * value for the same reason — the state jumps to 0/1 on release, the colour does not.
 */
const trackFill = useFrameValue(() =>
  toCss(lerpColor(trackColor.value, accent.value, animation.value))
)

/** `layerBlock` — squash + velocity skew, applied to the thumb shape by the browser's capture. */
function innerTransform(): LayerTransform {
  const velocity = animation.velocity / 50
  const scaleX = animation.scaleX / (1 - coerceIn(velocity * 0.75, -0.2, 0.2))
  const scaleY = animation.scaleY * (1 - coerceIn(velocity * 0.25, -0.2, 0.2))
  return { translationX: 0, translationY: 0, scaleX, scaleY, rotationZ: 0, alpha: 1 }
}

/**
 * Outer `graphicsLayer { translationX = lerp(padding, padding + dragWidth, fraction) }`.
 *
 * ⚠️ The `fraction` in that lambda is `dampedDragAnimation.value`, the **animated** value —
 * *not* the `fraction` state of the same name one screen up. `onDragStopped` snaps the state to
 * 0/1 the moment the gesture ends (upstream does too, `LiquidToggle.kt:79-84`), so reading the
 * state teleported the capsule to the far side while the spring was still travelling — visible
 * on a plain tap, where `animateToValue` is precisely what is supposed to carry it across.
 */
function thumbOffset(): { x: number; y: number } {
  return { x: lerp(PADDING, PADDING + DRAG_WIDTH, animation.value), y: 0 }
}

/* ------------------------------------------------------------------ track layer ------- */
/**
 * `rememberCombinedBackdrop(backdrop, rememberBackdrop(trackBackdrop) { … scale(…) { drawBackdrop() } })`
 * — `LiquidToggle.kt:145-156`.
 *
 * This is the part of the original that the port used to drop, and dropping it is **not** free:
 * the comment claimed "a flat-coloured track is scale-invariant", but the recorded track is a
 * *capsule* — `layerBackdrop` records the clipped, rounded shape, not an infinite plane — so
 * scaling it changes its size. That is the whole point of the layer: while the capsule is
 * pressed the track shrinks to 0.75 and the glass shows the background around it, which is what
 * makes the pinch read as "the glass is stretching over the track".
 *
 * Measured off a reference render (card = 176×76 CSS px, so 2 image px per CSS px), at full
 * press: the green inside the glass is 21 px tall, not the track's 28, and stops at x = 58.5.
 * Both fall out of one formula — `scale = 0.75`, pivot = the thumb's centre (42, 14):
 * `42 + (64 − 42) × 0.75 = 58.5` and `28 × 0.75 = 21`.
 *
 * The `scaleY` starts at **0**, so the layer is collapsed — invisible — whenever the toggle is
 * not being pressed. Only the real track is visible then, and only the pressed glass shows a
 * shrunk track.
 */
function trackInnerTransform(): string {
  const progress = animation.pressProgress
  const scaleX = lerp(2 / 3, 0.75, progress)
  const scaleY = lerp(0, 0.75, progress)
  const cx = THUMB_W / 2 + thumbOffset().x
  const cy = THUMB_CY
  // The pivot is baked into the transform because `scale()` alone pivots on the origin.
  return `translate(${cx}px, ${cy}px) scale(${scaleX}, ${scaleY}) translate(${-cx}px, ${-cy}px)`
}

/** Strings, not objects: `useFrameValue` compares by identity, so a fresh object would
 *  re-render on every frame even when nothing moved. */
const trackInnerTransformCss = useFrameValue(trackInnerTransform)

/**
 * The thumb's silhouette as a path, in track coordinates — a stadium whose corner radii are
 * elliptical because the thumb is scaled by `scaleX`/`scaleY` independently.
 *
 * Traced **counter-clockwise**: appended to the clockwise `TRACK_OUTLINE` as a second subpath,
 * the nonzero rule then subtracts it, so the two subpaths carve a hole.
 */
function thumbHolePath(offsetX: number, scaleX: number, scaleY: number): string {
  const cx = THUMB_W / 2 + offsetX
  const cy = THUMB_CY
  const hw = (THUMB_W / 2) * scaleX
  const hh = (THUMB_H / 2) * scaleY
  const rx = Math.min((THUMB_H / 2) * scaleX, hw)
  const ry = Math.min((THUMB_H / 2) * scaleY, hh)
  return [
    `M${cx + hw - rx} ${cy - hh}`,
    `H${cx - hw + rx}`,
    `A${rx} ${ry} 0 0 0 ${cx - hw + rx} ${cy + hh}`,
    `H${cx + hw - rx}`,
    `A${rx} ${ry} 0 0 0 ${cx + hw - rx} ${cy - hh}`,
    'Z'
  ].join(' ')
}

/**
 * The real track keeps its full size on screen, but is **punched out** under the thumb.
 *
 * Upstream the two are separate by construction: the glass's backdrop is hand-built as
 * `backdrop + scaled track`, so the *drawn* track never enters it — `layerBackdrop` records the
 * layer, and the thumb's `drawBackdrop` is handed a backdrop chain that leaves it out. Here the
 * glass samples the page itself, so the drawn track would leak into it at full size and the
 * pinch would be invisible. The hole is cut with the *same* offset and `layerBlock` the lens
 * uses (`GlassSurface.currentCssTransform`), so hole and glass coincide to sub-pixel.
 *
 * Only while pressed does the hole matter — at rest the thumb is opaque white
 * (`onDrawSurface`), so what is behind it is never seen.
 */
function trackClipPath(): string {
  const t = innerTransform()
  const hole = thumbHolePath(thumbOffset().x, t.scaleX, t.scaleY)
  return `path("${TRACK_OUTLINE} ${hole}")`
}

const trackClipCss = useFrameValue(trackClipPath)

const highlight = (): Highlight | null => {
  const base = HighlightStyles.Ambient(animation.pressProgress)
  return { ...base, width: base.width / 1.5, blurRadius: base.blurRadius / 1.5 }
}

const shadow = (): Shadow | null => ({
  radius: dp(4),
  offsetX: 0,
  offsetY: dp(4) / 6,
  color: toCss(withAlpha(Colors.Black, 0.05)),
  alpha: 1
})

const effects = (scope: BackdropEffectScope): void => {
  const progress = animation.pressProgress
  scope.blur(dp(8) * (1 - progress))
  scope.lens(dp(5) * progress, dp(10) * progress, false, true)
}

function onDrawSurface(ctx: CanvasRenderingContext2D, size: { width: number; height: number }) {
  ctx.fillStyle = `rgba(255, 255, 255, ${1 - animation.pressProgress})`
  ctx.fillRect(0, 0, size.width, size.height)
}

onMounted(() => {
  if (thumbEl.value) {
    const detach = animation.attach(thumbEl.value)
    onBeforeUnmount(detach)
  }
})
</script>

<template>
  <div class="liquid-toggle">
    <div class="liquid-toggle__track" :style="{ background: trackFill, clipPath: trackClipCss }" />
    <!-- The scaled copy the glass is supposed to see — see `trackInnerTransform`. Kept a
         *sibling* of the track, not a child: a child would inherit the track's clip-path, and
         at full press the copy's left cap reaches ~1.5 px past the hole (the hole is the thumb,
         `12`; the copy starts at `42 + (0 − 42) × 0.75 = 10.5`). Out here that overhang lands on
         the full-size track, which is the same green, so it is invisible. -->
    <div
      class="liquid-toggle__track-inner"
      :style="{ background: trackFill, transform: trackInnerTransformCss }"
    />
    <GlassSurface
      ref="thumb"
      class="liquid-toggle__thumb"
      :backdrop="backdrop"
      :shape="Capsule"
      :highlight="highlight"
      :shadow="shadow"
      :effects="effects"
      :layer-transform="innerTransform"
      :offset="thumbOffset"
      :on-draw-surface="onDrawSurface"
    />
  </div>
</template>

<style scoped>
.liquid-toggle {
  position: relative;
  width: 64px;
  height: 28px;
}

.liquid-toggle__track {
  position: absolute;
  inset: 0;
  border-radius: 999px;
}

.liquid-toggle__track-inner {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  /* The pivot is inside the transform string, so the element must not add its own. */
  transform-origin: 0 0;
  pointer-events: none;
}

.liquid-toggle__thumb {
  position: absolute;
  left: 0;
  top: 2px;
  width: 40px;
  height: 24px;
}
</style>
