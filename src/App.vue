<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch, watchEffect } from 'vue'

import AdaptiveLuminanceGlassContent from '@/views/AdaptiveLuminanceGlassContent.vue'
import BottomTabsContent from '@/views/BottomTabsContent.vue'
import ButtonsContent from '@/views/ButtonsContent.vue'
import ControlCenterContent from '@/views/ControlCenterContent.vue'
import DialogContent from '@/views/DialogContent.vue'
import GlassPlaygroundContent from '@/views/GlassPlaygroundContent.vue'
import HomeContent from '@/views/HomeContent.vue'
import LazyScrollContainerContent from '@/views/LazyScrollContainerContent.vue'
import LockScreenContent from '@/views/LockScreenContent.vue'
import MagnifierContent from '@/views/MagnifierContent.vue'
import ProgressiveBlurContent from '@/views/ProgressiveBlurContent.vue'
import ScrollContainerContent from '@/views/ScrollContainerContent.vue'
import SliderContent from '@/views/SliderContent.vue'
import ToggleContent from '@/views/ToggleContent.vue'

import LiquidButton from '@/components/LiquidButton.vue'
import { EmptyBackdrop } from '@/core/backdrop'
import type { CatalogDestination } from '@/core/destinations'
import { ThemeKey, createThemeController } from '@/composables/backdrop-context'
import { bumpLayoutEpoch } from '@/composables/useElementMetrics'

/**
 * `MainContent` — `app/src/commonMain/.../MainContent.kt`
 *
 * The catalog shell: a single `destination` state that swaps the visible screen, the ripple
 * colour provided through `LocalIndication`, and a back handler that returns to Home.
 *
 * Port notes:
 *  - the original exposes the back affordance twice, and so does this port:
 *    `androidMain`'s `BackHandler` delegates to the system back gesture — here the browser
 *    Back button (`popstate`) plus `Escape` — while `skikoMain`'s `BackHandler`
 *    (`app/src/skikoMain/.../utils/BackHandler.kt`) draws a real liquid button in the
 *    top-left, which is what `.app-back` below reproduces;
 *  - switching destinations bumps the global layout epoch so every freshly mounted
 *    `GlassSurface` re-measures and re-samples the wallpaper at its real position.
 */
const theme = createThemeController()
provide(ThemeKey, theme)

const isDark = computed(() => !theme.isLightTheme.value)

/**
 * The theme lives on `<html>`, not on the app container: the custom properties then reach
 * `body` as well, so the area behind the app (overscroll, safe areas) matches the theme
 * instead of showing a hard-coded colour.
 */
watchEffect(() => {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', isDark.value)
})

const destination = ref<CatalogDestination>('Home')

const views = {
  Home: HomeContent,
  Buttons: ButtonsContent,
  Toggle: ToggleContent,
  Slider: SliderContent,
  BottomTabs: BottomTabsContent,
  Dialog: DialogContent,
  LockScreen: LockScreenContent,
  ControlCenter: ControlCenterContent,
  Magnifier: MagnifierContent,
  GlassPlayground: GlassPlaygroundContent,
  AdaptiveLuminanceGlass: AdaptiveLuminanceGlassContent,
  ProgressiveBlur: ProgressiveBlurContent,
  ScrollContainer: ScrollContainerContent,
  LazyScrollContainer: LazyScrollContainerContent
} as const

const currentView = computed(() => views[destination.value])

function navigate(next: CatalogDestination): void {
  if (next === destination.value) return
  destination.value = next
  if (next !== 'Home') {
    window.history.pushState({ destination: next }, '')
  }
}

function goHome(): void {
  if (destination.value === 'Home') return
  destination.value = 'Home'
}

function onPopState(): void {
  goHome()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') goHome()
}

watch(destination, () => bumpLayoutEpoch())

onMounted(() => {
  window.addEventListener('popstate', onPopState)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('popstate', onPopState)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="app-root">
    <component :is="currentView" @navigate="navigate" />

    <!--
      `BackHandler` — `app/src/skikoMain/.../utils/BackHandler.kt`

      Drawn only while a destination other than Home is open (`enabled`): an opaque
      `LiquidButton` tinted `Color(0xFF0088FF)` over `emptyBackdrop()`, so it is a flat
      blue capsule rather than a glass one.
    -->
    <LiquidButton
      v-if="destination !== 'Home'"
      class="app-back"
      :backdrop="EmptyBackdrop"
      tint="#0088FF"
      @click="goHome"
    >
      <span class="app-back__label">Back</span>
    </LiquidButton>
  </div>
</template>

<style scoped>
/*
 * `Modifier.padding(8.dp).safeDrawingPadding().height(48.dp)` with no `align`: the Box's
 * default TopStart puts it in the corner, and the padding wraps the safe-area insets so
 * the capsule clears the status bar / notch.
 */
.app-back {
  position: absolute;
  top: calc(8px + var(--safe-top));
  left: calc(8px + var(--safe-left));
  z-index: 20;
}

/* `BasicText("Back", Modifier.padding(horizontal = 8.dp), TextStyle(White, 16.sp))` */
.app-back__label {
  padding: 0 8px;
  font-size: 16px;
  color: #ffffff;
}
</style>
