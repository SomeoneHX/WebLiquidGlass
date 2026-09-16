/**
 * Kit barrel — productized controls built on the ported demo widgets.
 *
 * The catalog components (`LiquidButton`, `LiquidToggle`, `LiquidSlider`) are demos of the *port*:
 * they render `<div>`s whose only activation path is a pointer gesture, they demand a `backdrop`
 * marker and an `isLightTheme` flag on every call site, and they expose no `disabled`, no keyboard
 * handling, no ARIA and no form participation. The kit is the thin shell that adds all of that
 * without editing them, so the 1:1 fidelity of the port stays intact and re-syncable.
 *
 * ## Usage
 *
 * ```ts
 * // main.ts — the plugin form. NOT `app.use(() => provideGlass())`: `provide()` is only legal inside
 * // a component's setup(), so that shape is a silent no-op and every control quietly falls back to
 * // the default context.
 * import { GlassPlugin } from './glass/kit'
 * createApp(App).use(GlassPlugin, { theme: 'light' }).mount('#app')
 * ```
 *
 * ```vue
 * <script setup lang="ts">
 * const enabled = ref(false)
 * const volume = ref(30)
 * </script>
 *
 * <template>
 *   <GlassSwitch v-model="enabled" id="notifications" />
 *   <label for="notifications">Enable notifications</label>
 *   <GlassSlider v-model="volume" :min="0" :max="100" name="volume" />
 *   <GlassButton tint="#0088FF" @click="save">Save</GlassButton>
 *
 *   <GlassTabs v-model="tab" :count="3" aria-label="Sections">
 *     <template #tab="{ index }">{{ index + 1 }}</template>
 *   </GlassTabs>
 * </template>
 * ```
 *
 * ## The pattern, if you need a fourth control
 *
 * 1. **Decide who owns the pointer and who owns the state.** Never both. A native control that sits
 *    over the visual steals the gesture that produces the press animation; a visual that also fires
 *    activation doubles it when the two overlap (a `<label>` wrapper is the classic way to trigger
 *    that: it activates the input *and* the inner gesture runs).
 * 2. **Hide the native control, never `display: none`** (`.glass-control__native`), and give it
 *    `pointer-events: none` so it cannot become a hit target. Keyboard, `label[for]` and screen
 *    readers do not go through pointer events, so nothing is lost.
 * 3. **Funnel both paths into one `commit()`** that emits `update:modelValue`, and let the prop drive
 *    the visual. The ported controls are fully controlled (they `watch` their value prop), so the
 *    round trip is what animates the glass.
 * 4. **Quantise only what leaves the component, never what drives the visual.** A ported widget may
 *    derive its next value from its own current target (`LiquidSlider` emits
 *    `clampToRange(animation.targetValue + amount)`), and that target only advances when the value you
 *    hand back advances. Returning early on a value you decided not to emit therefore discards the
 *    pointer movement that produced it, and a slow drag dies while a fast flick looks fine — the whole
 *    story is in `GlassSlider`'s header. The same trap applies to any "reject and forget" filter.
 * 5. **Style `disabled` with a sibling wash, never `opacity`/`filter`** on an ancestor of the lens —
 *    either property makes that ancestor a backdrop root and the glass stops sampling the page.
 * 6. **Never express "unspecified" with a Boolean prop.** Vue coerces an absent Boolean prop to
 *    `false`, so `props.flag ?? contextValue` can never fall back — the control is silently pinned
 *    to whatever `false` means. Use a tri-state string (see `theme` on `GlassSwitch`/`GlassSlider`)
 *    or detect the key on the vnode; this exact mistake shipped once and made every control ignore
 *    the theme context while still looking perfectly fine.
 * 7. **Never guess a gesture phase with a timer.** "No updates for N ms means the drag ended" breaks
 *    on exactly the slow gesture it is meant to serve: the gaps exceed N, the visual gets yanked
 *    mid-drag, and any accumulated state is wiped. Listen for the real `pointerup`/`pointercancel` on
 *    your own wrapper instead — a captured pointer still bubbles its release from the ported element.
 *
 * ## Not covered yet
 *
 * - **Reduced motion for the glass itself.** `prefers-reduced-motion` is exposed on the context and
 *   honoured for the kit's own CSS, but the springs that move the thumb live in
 *   `core/animation.ts` and are shared with the demo. A proper opt-in belongs there, mirroring
 *   Compose's motion duration scale (`Animatable.animateTo` collapsing to `snapTo`), and it is a
 *   change to a ported file rather than to the kit.
 * - **Tab panels and disabled tabs.** `GlassTabs` covers the tablist itself (`role`, roving
 *   `tabindex`, arrows / `Home` / `End`); `aria-controls` + `role="tabpanel"` would need a panel
 *   concept the catalog does not have, and a `disabledIndices` prop would have to be skipped by the
 *   arrow walk rather than guessed at.
 * - **Dialogs.** The layout in `DialogContent` has no focus trap, no `Esc`, no focus restoration and
 *   no `inert` on the background — the largest remaining semantic gap in the catalog.
 * - **Size variants.** The ported controls derive their geometry from literal pixel constants, so
 *   sizes cannot be varied from outside without editing them.
 */
import './glass-controls.css'

export { default as GlassButton } from './GlassButton.vue'
export { default as GlassSwitch } from './GlassSwitch.vue'
export { default as GlassSlider } from './GlassSlider.vue'
export { default as GlassTabs } from './GlassTabs.vue'

export {
  GlassPlugin,
  provideGlass,
  useGlass,
  useGlassControlAttrs,
  useGlassControlDefaults
} from './context'
export type { GlassContext, GlassThemeOverride, GlassThemePreference, ProvideGlassOptions } from './context'

/* Re-exported so a consumer composing a one-off surface does not have to reach into two barrels. */
export { RootBackdrop, EmptyBackdrop } from '@/core/backdrop'
export type { Backdrop } from '@/core/backdrop'
export { Capsule, Rectangle, RoundedRectangle } from '@/core/shapes'
export { dp } from '@/core/geometry'
export { isRefractionSupported } from '@/core/glass-filter'
