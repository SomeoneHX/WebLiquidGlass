<script setup lang="ts">
/**
 * `GlassSwitch` — `components/LiquidToggle.vue` with checkbox semantics bolted on.
 *
 * The design constraint that shapes this component: `LiquidToggle` **cannot** be used as a passive
 * visual inside a `<label>`, because its own pointer gesture would fire *in addition to* the label's
 * native activation and the switch would toggle twice, ending up where it started. It also exposes
 * no `interactive: false` switch to turn that gesture off (unlike `LiquidButton`'s `isInteractive`).
 *
 * So the roles are split instead of fighting:
 *
 * - the **visual layer owns the pointer**. Its gesture is the only thing that animates the press,
 *   the squash and the thumb travel; nothing here intercepts it.
 * - the **native `<input type="checkbox">` owns state, keyboard and forms**. It is visually hidden,
 *   sized 1 px and `pointer-events: none`, so it can never be a hit target — which is exactly why
 *   the gesture is not shadowed and why there is no double activation.
 *
 * Both activation paths meet at the same emit: the input's `change` (Space, screen reader, an
 * external `<label for>`, programmatic `.click()`) and the visual's `select` (tap or drag on the
 * thumb) both end in `emit('update:modelValue', …)`. `LiquidToggle` is fully controlled — it watches
 * `props.selected` and animates to it — so the round trip back through the prop is what makes the
 * thumb move, precisely as the demo's `ToggleContent` does it.
 *
 * ```html
 * <GlassSwitch v-model="enabled" id="notifications" />
 * <label for="notifications">Enable notifications</label>
 * ```
 *
 * Strictly controlled: this component does not keep internal state, so `v-model` (or `:model-value`
 * plus a listener) is required. An uncontrolled mode is deliberately not offered — a switch whose
 * visual state can drift from its form value is worse than a loud requirement.
 *
 * Known limitation, inherited: the hit area is the ported 40×24 thumb, not the whole 64×28 capsule.
 * That is upstream behaviour (`animation.attach(thumbEl)`), kept for visual fidelity. Use an external
 * `<label for>` when a larger target is needed — it activates the native input with no overlay and
 * therefore costs nothing in gesture fidelity.
 */
import LiquidToggle from '@/components/LiquidToggle.vue'
import { useGlassControlAttrs, useGlassControlDefaults, type GlassThemeOverride } from './context'
import type { Backdrop } from '@/core/backdrop'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    modelValue?: boolean
    disabled?: boolean
    /** Submitted with the form when the switch is on. Mirrors the native `value` attribute. */
    value?: string
    /** `name` for form submission. Without it the control is valid HTML but not submitted. */
    name?: string
    backdrop?: Backdrop
    /**
     * Pin this instance to a palette. Omit to follow the ambient context. Deliberately not a
     * boolean: see `useGlassControlDefaults` for what a missing Boolean prop does here.
     */
    theme?: GlassThemeOverride
  }>(),
  { modelValue: false, disabled: false, value: 'on' }
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** Fires for both activation paths, like a native checkbox's `change`. */
  change: [value: boolean]
}>()

const { backdrop, isLightTheme } = useGlassControlDefaults(props)
const { wrapperAttrs, controlAttrs } = useGlassControlAttrs()

function commit(value: boolean): void {
  if (props.disabled || value === props.modelValue) return
  emit('update:modelValue', value)
  emit('change', value)
}

/** Keyboard / screen reader / `<label for>` path — the browser has already flipped `checked`. */
function onNativeChange(event: Event): void {
  commit((event.target as HTMLInputElement).checked)
}

/**
 * Pointer path. The payload from `LiquidToggle` is used as the intent, but the *value* is emitted —
 * never written straight to the DOM — so the prop stays the single source of truth and the two paths
 * cannot disagree.
 *
 * `Enter` is added on top of the native set: a checkbox toggles on `Space`, but browsers leave
 * `Enter` unhandled, and a control that looks like a button is expected to respond to both.
 */
function onVisualSelect(value: boolean): void {
  commit(value)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return
  event.preventDefault()
  commit(!props.modelValue)
}
</script>

<template>
  <span
    v-bind="wrapperAttrs"
    class="glass-control glass-switch"
    :class="{ 'glass-control--disabled': disabled }"
  >
    <!-- No explicit `aria-checked`: the input's own `checked` property is already exposed, and a
         second, hand-maintained copy of the state in the accessibility tree is a drift risk. -->
    <input
      v-bind="controlAttrs"
      class="glass-control__native"
      type="checkbox"
      role="switch"
      :checked="modelValue"
      :value="value"
      :name="name"
      :disabled="disabled"
      @change="onNativeChange"
      @keydown="onKeydown"
    />
    <LiquidToggle
      class="glass-control__visual"
      :selected="modelValue"
      :is-light-theme="isLightTheme"
      :backdrop="backdrop"
      @select="onVisualSelect"
    />
  </span>
</template>
