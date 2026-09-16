<script setup lang="ts">
/**
 * `GlassTabs` — `components/LiquidBottomTabs.vue` with the ARIA tab pattern bolted on.
 *
 * The ported bar is a pure visual: it slides its indicator on drag, emits `select(index)` when a tab
 * is tapped, and knows nothing about tabs as an accessibility concept — no `tablist`/`tab` roles, no
 * focus management, no keyboard. That is the whole gap this component fills, and it is the same split
 * as the rest of the kit: **the ported visual keeps the pointer, the kit owns semantics**.
 *
 * ```html
 * <GlassTabs v-model="tab" :count="3" aria-label="Sections">
 *   <template #tab="{ index, selected }">
 *     <FlightIcon />
 *     <span :style="{ color: selected ? accent : undefined }">Tab {{ index + 1 }}</span>
 *   </template>
 * </GlassTabs>
 * ```
 *
 * Design decisions worth knowing before extending this:
 *
 * - **Automatic activation.** Arrow keys move focus *and* selection, which is the pattern iOS-style
 *   segmented controls use and what the ported bar's own animation expects (the indicator follows
 *   `selectedIndex`). The alternative — manual activation (`Enter`/`Space` commits) — would make the
 *   bar lag the focus ring. `Enter`/`Space` still select, for a tab reached by `Tab`.
 * - **Roving tabindex.** Only the selected tab is in the tab order (`tabindex=0`), the rest are `-1`,
 *   so the whole bar is one tab stop and arrows move inside it. That is the ARIA authoring practice
 *   for a tablist, and it is also why this cannot be a plain slot: the kit has to render the tabs to
 *   own their `tabindex`.
 * - **`role="tablist"` lands on the ported bar's own root**, via attribute fallthrough, rather than on
 *   an extra wrapper — one less box to keep layout-neutral. `class`/`style` go to the wrapping
 *   `.glass-tabs` box instead, because that is what the host is positioning (see
 *   `useGlassControlAttrs`).
 * - **No `disabled` tabs and no panels in this version.** `aria-controls`/`role="tabpanel"` need a
 *   panel concept, and the catalog's tabs have none; a `disabledIndices` prop would have to be skipped
 *   by the arrow walk. Both are additive later and neither should be guessed at now.
 */
import { nextTick, ref } from 'vue'

import LiquidBottomTab from '@/components/LiquidBottomTab.vue'
import LiquidBottomTabs from '@/components/LiquidBottomTabs.vue'
import { useGlassControlAttrs, useGlassControlDefaults, type GlassThemeOverride } from './context'
import type { Backdrop } from '@/core/backdrop'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    /** Index of the selected tab. */
    modelValue?: number
    /** Number of tabs. The kit renders this many, so it must match the `#tab` slot's expectations. */
    count: number
    backdrop?: Backdrop
    /** Pin this instance to a palette. Omit to follow the ambient context (not a boolean — see
     * `useGlassControlDefaults`). */
    theme?: GlassThemeOverride
  }>(),
  { modelValue: 0 }
)

const emit = defineEmits<{
  'update:modelValue': [index: number]
  /** Fires for both activation paths (pointer and keyboard), like a native control's `change`. */
  change: [index: number]
}>()

const { backdrop, isLightTheme } = useGlassControlDefaults(props)
const { wrapperAttrs, controlAttrs } = useGlassControlAttrs()

const rootEl = ref<HTMLElement | null>(null)

/** The per-tab styles are the host's call — it owns the icon and the accent colour. */
defineSlots<{ tab?: (props: { index: number; selected: boolean }) => unknown }>()

/**
 * The single funnel for both activation paths, exactly like the other kit controls: the ported bar's
 * `select` (tap or indicator drag) and a tab's own `click` both arrive here and nowhere else.
 */
function commit(index: number, options: { focus?: boolean } = {}): void {
  if (index < 0 || index >= props.count) return
  if (index !== props.modelValue) {
    emit('update:modelValue', index)
    emit('change', index)
  }
  if (!options.focus) return
  // Focus follows selection for keyboard activation. Deferred to the next tick so the roving
  // `tabindex` has been patched first — focusing an element that is still `tabindex=-1` works, but
  // the attribute flip is what keeps `Tab` leaving the bar from the right place afterwards.
  void nextTick(() => {
    const tabs = rootEl.value?.querySelectorAll<HTMLElement>('[role="tab"]')
    tabs?.[index]?.focus()
  })
}

/**
 * `ArrowLeft`/`ArrowRight` wrap (a bar has no ends worth stopping at), `Home`/`End` jump. The keys
 * that are not ours are left alone — no `preventDefault` on anything unrecognised.
 */
function onTabKeydown(event: KeyboardEvent, index: number): void {
  const last = props.count - 1
  let next: number | null = null
  switch (event.key) {
    case 'ArrowRight':
      next = index === last ? 0 : index + 1
      break
    case 'ArrowLeft':
      next = index === 0 ? last : index - 1
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = last
      break
    case 'Enter':
    case ' ':
      next = index
      break
    default:
      return
  }
  // `Space` would otherwise scroll the page, and the arrows would scroll a scroll container.
  event.preventDefault()
  commit(next, { focus: true })
}
</script>

<template>
  <div ref="rootEl" v-bind="wrapperAttrs" class="glass-tabs">
    <!-- `role="tablist"` + `aria-label` … arrive through `controlAttrs` and land on the bar's root
         element, which is the closest element to the tabs themselves. -->
    <LiquidBottomTabs
      v-bind="controlAttrs"
      role="tablist"
      aria-orientation="horizontal"
      :selected-index="modelValue"
      :tabs-count="count"
      :is-light-theme="isLightTheme"
      :backdrop="backdrop"
      @select="commit"
    >
      <template #tabs>
        <!-- The tabs are rendered here rather than accepted as slot content: the roving `tabindex`,
             `aria-selected` and the keyboard map all have to live on the focusable element. -->
        <LiquidBottomTab
          v-for="index in count"
          :key="index"
          role="tab"
          :selected="modelValue === index - 1"
          :aria-selected="modelValue === index - 1"
          :tabindex="modelValue === index - 1 ? 0 : -1"
          @click="commit(index - 1)"
          @keydown="onTabKeydown($event, index - 1)"
        >
          <slot name="tab" :index="index - 1" :selected="modelValue === index - 1" />
        </LiquidBottomTab>
      </template>
    </LiquidBottomTabs>
  </div>
</template>
