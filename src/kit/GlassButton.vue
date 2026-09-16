<script setup lang="ts">
/**
 * `GlassButton` — `components/LiquidButton.vue` with real button semantics bolted on.
 *
 * The ported controls are **demo widgets**, not form controls: `LiquidButton` renders a `<div>`
 * whose only activation path is a pointer gesture (`useTap`), so it has no keyboard activation, no
 * `disabled`, no form participation and no `:focus-visible`. Everything a host application needs
 * from a button is missing.
 *
 * The fix is a shell, not a rewrite. Two facts make that possible:
 *
 * 1. `useTap` only *listens* on `pointerdown`/`pointerup` — it never calls `stopPropagation`. A
 *    click inside the visual therefore still bubbles to the native `<button>` that wraps it, so the
 *    native element can own activation while the ported gesture keeps owning the press animation.
 * 2. The ported visuals are entirely driven by the `interactiveHighlight` instance they create
 *    internally, so they do not need to know who is listening for clicks.
 *
 * The same shell also covers what `LiquidButton` cannot express: `type`, `disabled`, `loading`,
 * `aria-busy`, and a focus ring that follows the capsule (see `glass-controls.css`).
 *
 * Two honest caveats, both inherent to wrapping rather than editing the ported component:
 *
 * - **HTML validity.** `<button>`'s content model is phrasing content, and `LiquidButton`'s root is
 *   a `<div>`. Browsers render and behave correctly and the accessible name still resolves, but a
 *   strict validator will complain. Making this valid requires giving `GlassSurface` a `tag` prop so
 *   the surface can *be* the button; that is a change to a ported file, so it is not done here.
 * - **`isInteractive` is read once.** `LiquidButton` evaluates `props.isInteractive` at setup time
 *   to decide whether to construct its `InteractiveHighlight`, so flipping it later has no effect on
 *   that instance. `disabled` is therefore enforced by the shell: the native attribute blocks
 *   activation, and `.glass-control--disabled` cuts pointer events off the visual so no press
 *   animation can start.
 */
import { computed } from 'vue'

import LiquidButton from '@/components/LiquidButton.vue'
import { useGlassControlDefaults } from './context'
import type { Backdrop } from '@/core/backdrop'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    /** Native button type. Defaults to `button` so it never submits a form by accident. */
    type?: 'button' | 'submit' | 'reset'
    disabled?: boolean
    /** Disables interaction and renders a spinner in front of the label. */
    loading?: boolean
    /** `LiquidButton`'s `tint` — painted through `BlendMode.Hue` then a 0.75 alpha pass. */
    tint?: string | null
    /** `LiquidButton`'s `surfaceColor` — a second, plain-alpha fill over the tint. */
    surfaceColor?: string | null
    /** Override the ambient context for this instance (e.g. a surface that must not sample). */
    backdrop?: Backdrop
  }>(),
  { type: 'button', disabled: false, loading: false, tint: null, surfaceColor: null }
)

const emit = defineEmits<{ click: [event: MouseEvent] }>()

/**
 * Only the backdrop is resolved: `LiquidButton` takes no theme prop (its tint and surface colours
 * are handed to it by the caller), so there is deliberately no `isLightTheme` here — accepting one
 * and silently ignoring it would be worse than not having it.
 */
const { backdrop } = useGlassControlDefaults(props)

const disabled = computed(() => props.disabled || props.loading)

/**
 * Only the native click is surfaced. `LiquidButton`'s own `@click` (from `useTap`) is deliberately
 * not subscribed — listening to both would emit twice for a single press.
 */
function onClick(event: MouseEvent): void {
  if (disabled.value) return
  emit('click', event)
}
</script>

<template>
  <button
    v-bind="$attrs"
    class="glass-control glass-button"
    :class="{ 'glass-control--disabled': disabled }"
    :type="type"
    :disabled="disabled"
    :aria-busy="props.loading || undefined"
    @click="onClick"
  >
    <LiquidButton
      class="glass-control__visual"
      :backdrop="backdrop"
      :is-interactive="!disabled"
      :tint="tint"
      :surface-color="surfaceColor"
    >
      <span v-if="loading" class="glass-button__spinner" aria-hidden="true" />
      <span class="glass-button__label"><slot /></span>
    </LiquidButton>
  </button>
</template>
