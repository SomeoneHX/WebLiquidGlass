import { computed, inject, provide, ref, type ComputedRef, type InjectionKey, type Ref } from 'vue'
import type { Backdrop } from '@/core/backdrop'

export const RootBackdropKey: InjectionKey<Backdrop> = Symbol('rootBackdrop')

/** The catalog's root wallpaper layer shared by every destination. */
export function useRootBackdrop(): Backdrop {
  const backdrop = inject(RootBackdropKey, null)
  if (!backdrop) throw new Error('RootBackdrop was not provided — wrap the tree in BackdropDemoScaffold')
  return backdrop
}

export function provideRootBackdrop(backdrop: Backdrop): void {
  provide(RootBackdropKey, backdrop)
}

export interface ThemeController {
  isLightTheme: ComputedRef<boolean>
  preference: Ref<'system' | 'light' | 'dark'>
  toggle: () => void
}

export const ThemeKey: InjectionKey<ThemeController> = Symbol('theme')

export function createThemeController(): ThemeController {
  const preference = ref<'system' | 'light' | 'dark'>('system')
  const systemDark = ref(false)

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    systemDark.value = query.matches
    query.addEventListener('change', (event) => {
      systemDark.value = event.matches
    })
  }

  const isDark = computed(() => {
    if (preference.value === 'dark') return true
    if (preference.value === 'light') return false
    return systemDark.value
  })

  const isLightTheme = computed(() => !isDark.value)

  const toggle = () => {
    preference.value = isDark.value ? 'light' : 'dark'
  }

  return { isLightTheme, preference, toggle }
}

export const ThemeProviderKey = ThemeKey

export function useTheme(): ThemeController {
  const theme = inject(ThemeKey, null)
  if (!theme) throw new Error('Theme was not provided')
  return theme
}
