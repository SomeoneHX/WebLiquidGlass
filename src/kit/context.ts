/**
 * Kit context — the plumbing every glass *control* needs, provided once.
 *
 * Why this exists: the ported demo components require `backdrop` on every call site and
 * `isLightTheme` on most of them. That is correct for a catalog — each destination is a
 * standalone page and `BackdropDemoScaffold` hands the marker down through its slot — and wrong
 * for an application, where a `<GlassSwitch>` nested three levels deep should not have to be
 * spoon-fed a marker and a theme flag, and where `useRootBackdrop()`'s
 * `throw new Error('RootBackdrop was not provided …')` turns a missing provider into a blank page.
 *
 * `provideGlass()` supplies both once; `useGlass()` **never throws**, falling back to a
 * page-wide default context, so a single control can be dropped into an existing app and work.
 *
 * Nuance worth keeping: `backdrop` is a *marker*, not an object with behaviour. `RootBackdrop`
 * means "sample whatever is painted behind me" and `EmptyBackdrop` means "draw the surface only,
 * never sample" (see `core/backdrop.ts`). A control that receives a custom marker cannot tell them
 * apart, and does not need to — it just forwards it.
 */
import {
  computed,
  inject,
  provide,
  ref,
  useAttrs,
  type App,
  type ComputedRef,
  type InjectionKey,
  type Plugin,
  type Ref
} from 'vue'

import { createThemeController } from '@/composables/backdrop-context'
import { RootBackdrop, type Backdrop } from '@/core/backdrop'

export type GlassThemePreference = 'system' | 'light' | 'dark'

/** Per-control override: omit to follow the context, which may itself be `'system'`. */
export type GlassThemeOverride = 'light' | 'dark'

export interface GlassContext {
  /** Forwarded to every surface. `RootBackdrop` unless a provider overrode it. */
  backdrop: Backdrop
  /** `isSystemInDarkTheme()`-equivalent, resolved: `preference` + the OS media query. */
  isLightTheme: ComputedRef<boolean>
  themePreference: Ref<GlassThemePreference>
  /** Mirrors the demo's light/dark switch; the ported control palettes already react to it. */
  toggleTheme: () => void
  /**
   * `prefers-reduced-motion`. The kit only uses it for its *own* additions (the button spinner and
   * the focus-ring transition). The springs that animate the glass itself live inside
   * `core/animation.ts` and are shared with the demo — see the note in `index.ts`.
   */
  reducedMotion: Ref<boolean>
}

export interface ProvideGlassOptions {
  /** Override the marker for a subtree (e.g. glass that must not sample the page: `EmptyBackdrop`). */
  backdrop?: Backdrop
  /** Pin the theme instead of following the OS. Omit to keep `'system'`. */
  theme?: GlassThemePreference
}

const GlassKey: InjectionKey<GlassContext> = Symbol('glassControls')

/** `matchMedia('(prefers-reduced-motion: reduce)')` as a live ref; no-op outside the browser. */
function useReducedMotion(): Ref<boolean> {
  const reduced = ref(false)
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    reduced.value = query.matches
    query.addEventListener('change', (event) => {
      reduced.value = event.matches
    })
  }
  return reduced
}

/**
 * Built on the demo's own `createThemeController`, deliberately: the ported controls pick their
 * palettes from `isLightTheme`, so a second, kit-local theme implementation could disagree with
 * the demo's when both are mounted on the same page.
 */
function createGlassContext(options: ProvideGlassOptions = {}): GlassContext {
  const theme = createThemeController()
  if (options.theme) theme.preference.value = options.theme
  return {
    backdrop: options.backdrop ?? RootBackdrop,
    isLightTheme: theme.isLightTheme,
    themePreference: theme.preference,
    toggleTheme: theme.toggle,
    reducedMotion: useReducedMotion()
  }
}

/**
 * Provided per call, so two independent trees on one page can differ. Application code calls this
 * once at the root; library code never calls it.
 */
export function provideGlass(options: ProvideGlassOptions = {}): GlassContext {
  const context = createGlassContext(options)
  provide(GlassKey, context)
  return context
}

/**
 * Lazily created, process-wide. A fallback context must be a singleton — one per `useGlass()`
 * call would register a fresh `matchMedia` listener per control.
 */
let fallbackContext: GlassContext | null = null

function defaultContext(): GlassContext {
  if (!fallbackContext) fallbackContext = createGlassContext()
  return fallbackContext
}

/**
 * Read the ambient glass context. Safe to call anywhere, including outside any provider and during
 * SSR (`matchMedia` and the media-query listener are guarded).
 */
export function useGlass(): GlassContext {
  return inject(GlassKey, null) ?? defaultContext()
}

/**
 * App-level plugin: `createApp(App).use(GlassPlugin, { theme: 'light' })`.
 *
 * The shape is not cosmetic. `provide()` may only be called inside a component's `setup()`, so the
 * tempting `app.use(() => provideGlass())` is a **silent no-op** — Vue warns once in dev, every
 * control falls back to the default context, and because that fallback has the same defaults the
 * mistake is invisible until the day the options actually matter. `app.provide()` is the app-level
 * equivalent and is injectable from every component; component-level `provideGlass()` still wins for
 * its own subtree.
 */
export const GlassPlugin: Plugin<[ProvideGlassOptions?]> = {
  install(app: App, options?: ProvideGlassOptions) {
    app.provide(GlassKey, createGlassContext(options ?? {}))
  }
}

/**
 * Resolves the props the ported controls demand, defaulting to the context. The kit controls take
 * both as *optional* props so a single instance can still be overridden in place (e.g. a switch over
 * a flat card, or a surface that must not sample the wallpaper).
 *
 * ⚠ `theme` is a tri-state string rather than the ported `isLightTheme` boolean, and that is load
 * bearing. Vue coerces a declared Boolean prop that was **not passed** to `false`, so
 * `props.isLightTheme ?? context.isLightTheme.value` can never fall back: "unspecified" arrives as
 * `false`, the `??` keeps it, and every control pins itself to the dark palette whatever the context
 * says. That was a real bug here — the acceptance page showed the context resolving to `light` while
 * the switch painted the dark track and the theme buttons did nothing. A string keeps "unspecified"
 * expressible; the ported components keep their own boolean prop, which is `required` there and so
 * never hits the coercion.
 */
export function useGlassControlDefaults(props: {
  backdrop?: Backdrop
  theme?: GlassThemeOverride
}): { backdrop: ComputedRef<Backdrop>; isLightTheme: ComputedRef<boolean> } {
  const glass = useGlass()
  return {
    backdrop: computed(() => props.backdrop ?? glass.backdrop),
    isLightTheme: computed(() => (props.theme ? props.theme === 'light' : glass.isLightTheme.value))
  }
}

/**
 * Splits fallthrough attributes between the two elements a kit control renders.
 *
 * `class`/`style` belong to the *wrapper* — that is what the host is positioning and sizing — while
 * everything else (`aria-*`, `id`, `name`, `form`, `required`, `autofocus`, `data-*`) belongs to the
 * hidden native control, because that is the element in the accessibility tree and in the form.
 * Putting `aria-label` on the wrapper instead would leave the actual control unnamed; putting
 * `class` on the hidden 1 px input would silently do nothing.
 *
 * Requires `defineOptions({ inheritAttrs: false })`, otherwise Vue applies the attributes a second
 * time to the root element.
 */
export function useGlassControlAttrs(): {
  wrapperAttrs: ComputedRef<Record<string, unknown>>
  controlAttrs: ComputedRef<Record<string, unknown>>
} {
  const attrs = useAttrs()
  return {
    wrapperAttrs: computed(() => ({ class: attrs.class, style: attrs.style })),
    // Built by omission rather than by rest-destructuring so the intent survives a stricter
    // `noUnusedLocals` setting, which flags the deliberately-discarded bindings.
    controlAttrs: computed(() => {
      const rest: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class' || key === 'style') continue
        rest[key] = value
      }
      return rest
    })
  }
}
