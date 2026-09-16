<script setup lang="ts">
/**
 * `GlassSlider` — `components/LiquidSlider.vue` with range-input semantics bolted on.
 *
 * Same split as `GlassSwitch`: the ported visual keeps the pointer (its own drag on the thumb, plus
 * the track-tap-to-jump gesture the demo added), while a visually hidden native
 * `<input type="range">` owns the value, the keyboard and the form entry. That buys the whole native
 * keyboard contract for free — arrows step, `PageUp`/`PageDown` step by 10 %, `Home`/`End` jump to the
 * ends — none of which the ported component has, because it only ever listened for `pointerdown`.
 *
 * ## The accumulation trap (read this before adding any filtering to `commit`)
 *
 * The ported slider computes its next value from **its own current target**:
 *
 * ```
 * onDrag: (self, _size, delta) => emit('change', clampToRange(animation.targetValue + amount))
 * ```
 *
 * and that target only advances when the `value` prop we hand back advances. A consumer that *drops*
 * an emitted value therefore does not merely round it — it also discards the pointer movement that
 * produced it, and every later event is measured again from the unmoved target. That is a real bug
 * this kit shipped: quantising to a step grid and returning early when the rounded value matched the
 * current one made a slow drag dead on arrival (a few px per event, each rounding back), while a fast
 * flick crossed a whole step per event and felt fine. A headless probe measured a 36 px drag leaving
 * the model at `30 -> 30`.
 *
 * So: **the visual is always driven with the continuous value**, and only what leaves the component is
 * quantised (see `commit`). The ported component always sees a target that moved; the model still
 * lands on the grid.
 *
 * ```html
 * <GlassSlider v-model="volume" :min="0" :max="100" :step="10" name="volume" />
 * ```
 *
 * Strictly controlled, like the rest of the kit: `v-model` is required.
 */
import { computed, ref, watch } from 'vue'

import LiquidSlider from '@/components/LiquidSlider.vue'
import { useGlassControlAttrs, useGlassControlDefaults, type GlassThemeOverride } from './context'
import { coerceIn } from '@/core/math'
import type { Backdrop } from '@/core/backdrop'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    modelValue?: number
    min?: number
    max?: number
    /**
     * `'any'` (the default) emits continuous values, exactly like the ported demo. A number snaps the
     * *model* to that grid and is handed to the native input, so the keyboard and a screen reader use
     * the same grid. The visual stays continuous while dragging either way — see the header note.
     */
    step?: number | 'any'
    disabled?: boolean
    name?: string
    /**
     * The ported spring settles within this distance of the target. Defaults to one ten-thousandth of
     * the range, which reproduces the demo's `0.01` for its `[0, 100]` slider, without hardcoding a
     * value that would be wrong for a `[0, 1]` one.
     */
    visibilityThreshold?: number
    backdrop?: Backdrop
    /** Pin this instance to a palette. Omit to follow the ambient context (not a boolean — see
     * `useGlassControlDefaults`). */
    theme?: GlassThemeOverride
  }>(),
  { modelValue: 0, min: 0, max: 100, step: 'any', disabled: false }
)

const emit = defineEmits<{
  'update:modelValue': [value: number]
  /** Fires for both activation paths, like a native range input's `change`. */
  change: [value: number]
}>()

const { backdrop, isLightTheme } = useGlassControlDefaults(props)
const { wrapperAttrs, controlAttrs } = useGlassControlAttrs()

/**
 * `LiquidSlider` takes its bounds as a tuple, not two numbers — and the tuple has to be a real
 * `[number, number]` for the template type-check, which an inline array literal is not.
 */
const valueRange = computed<[number, number]>(() => [props.min, props.max])

const numericStep = computed(() => (props.step === 'any' ? 0 : Math.abs(props.step)))

const threshold = computed(() => props.visibilityThreshold ?? (props.max - props.min) / 10000)

/** Snap to the step grid, then clamp, tolerating floating-point drift (`0.30000000000000004`). */
function quantize(value: number): number {
  const step = numericStep.value
  const clamped = coerceIn(value, props.min, props.max)
  if (step <= 0) return clamped
  const snapped = props.min + Math.round((clamped - props.min) / step) * step
  // Only clean up the artefact the multiplication introduces; `'any'` values are returned untouched.
  return coerceIn(Number(snapped.toFixed(10)), props.min, props.max)
}

/**
 * What the ported component is driven with: the **continuous** value, so its `targetValue` keeps
 * accumulating pointer movement. It is deliberately not the model, and the two may differ by up to
 * half a step while a drag is in flight.
 */
const visual = ref(props.modelValue)

function commit(raw: number): void {
  if (props.disabled) return
  // Advance the visual first, and unconditionally — dropping this is what froze slow drags.
  visual.value = coerceIn(raw, props.min, props.max)
  const next = quantize(raw)
  if (next === props.modelValue) return
  emit('update:modelValue', next)
  emit('change', next)
}

/** Keyboard / screen reader path. A native range input reports `value` as a string. */
function onNativeInput(event: Event): void {
  commit(Number((event.target as HTMLInputElement).value))
}

/** Pointer path — the visual's drag and its track tap both arrive here, raw and unquantised. */
function onVisualChange(raw: number): void {
  commit(raw)
}

/**
 * Keep the visual in step when the model changes from outside (a programmatic `v-model` write, the
 * keyboard path, a reset). Values that came back from our own emit are ignored on purpose: during a
 * drag `quantize(visual) === modelValue` already holds, so the thumb is never yanked back onto the
 * grid mid-gesture.
 */
watch(
  () => props.modelValue,
  (value) => {
    if (quantize(visual.value) !== value) visual.value = value
  }
)

/**
 * Drag release → settle the visual onto the grid, which is what a native stepped slider shows at
 * rest.
 *
 * ⚠ Deliberately **not** a timer. The first attempt at this used a short idle timeout as a "drag
 * ended" proxy, and it re-broke the very bug it was meant to polish: a slow drag has gaps longer than
 * the timeout, so the visual was snapped back onto the grid *between* events, wiping the accumulated
 * movement every time. A 36 px drag left the model at `30 -> 30` again, with the input log proving all
 * six `pointermove` events had been delivered — the value was being thrown away by the timer, not by
 * the gesture.
 *
 * The wrapper sees the real release: `inspectDragGestures` captures the pointer on the thumb, and a
 * captured `pointerup` still bubbles up from that element. No guesswork, no timer, nothing to clean
 * up on unmount.
 */
function snapVisualToGrid(): void {
  if (numericStep.value <= 0) return
  visual.value = quantize(visual.value)
}
</script>

<template>
  <span
    v-bind="wrapperAttrs"
    class="glass-control glass-slider"
    :class="{ 'glass-control--disabled': disabled }"
    @pointerup="snapVisualToGrid"
    @pointercancel="snapVisualToGrid"
  >
    <input
      v-bind="controlAttrs"
      class="glass-control__native"
      type="range"
      :value="modelValue"
      :min="min"
      :max="max"
      :step="typeof step === 'number' ? String(step) : 'any'"
      :name="name"
      :disabled="disabled"
      @input="onNativeInput"
    />
    <LiquidSlider
      class="glass-control__visual"
      :value="visual"
      :value-range="valueRange"
      :visibility-threshold="threshold"
      :is-light-theme="isLightTheme"
      :backdrop="backdrop"
      @change="onVisualChange"
    />
  </span>
</template>
