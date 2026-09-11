<script setup lang="ts">
import RippleSurface from '@/components/RippleSurface.vue'
import type { CatalogDestination } from '@/core/destinations'
import { useTheme } from '@/composables/backdrop-context'

/**
 * `HomeContent` — the plain list screen. Unlike every other destination it does **not** use
 * `BackdropDemoScaffold`, so there is no wallpaper: the list sits directly on the window
 * background, exactly like the Compose catalog.
 */
const emit = defineEmits<{ navigate: [destination: CatalogDestination] }>()

const { isLightTheme, toggle } = useTheme()

const sections: { subtitle: string; items: { label: string; destination: CatalogDestination }[] }[] =
  [
    {
      subtitle: 'Liquid glass components',
      items: [
        { label: 'Buttons', destination: 'Buttons' },
        { label: 'Toggle', destination: 'Toggle' },
        { label: 'Slider', destination: 'Slider' },
        { label: 'Bottom tabs', destination: 'BottomTabs' },
        { label: 'Dialog', destination: 'Dialog' }
      ]
    },
    {
      subtitle: 'System UIs',
      items: [
        { label: 'Lock screen (SDF texture)', destination: 'LockScreen' },
        { label: 'Control center', destination: 'ControlCenter' },
        { label: 'Magnifier', destination: 'Magnifier' }
      ]
    },
    {
      subtitle: 'Experiments',
      items: [
        { label: 'Glass playground', destination: 'GlassPlayground' },
        { label: 'Adaptive luminance glass', destination: 'AdaptiveLuminanceGlass' },
        { label: 'Progressive blur', destination: 'ProgressiveBlur' },
        { label: 'Scroll container', destination: 'ScrollContainer' },
        { label: 'Lazy scroll container', destination: 'LazyScrollContainer' }
      ]
    }
  ]
</script>

<template>
  <div class="home scroll-y fill-screen system-bars-padding display-cutout-padding no-select">
    <div class="home__header">
      <h1 class="home__title">Backdrop Catalog</h1>
      <button class="home__theme" type="button" @click="toggle()">
        {{ isLightTheme ? 'Light' : 'Dark' }}
      </button>
    </div>

    <div class="home__sections">
      <template v-for="section in sections" :key="section.subtitle">
        <p class="home__subtitle">{{ section.subtitle }}</p>
        <RippleSurface
          v-for="item in section.items"
          :key="item.destination"
          :color="isLightTheme ? '#000000' : '#ffffff'"
          class="home__item"
          @click="emit('navigate', item.destination)"
        >
          <span class="home__item-label">{{ item.label }}</span>
        </RippleSurface>
      </template>
    </div>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: 16px;
  background: var(--app-bg);
}

.home__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 40px 16px 0 16px;
}

.home__title {
  margin: 0;
  font-size: 28px;
  font-weight: 500;
}

.home__theme {
  border: none;
  background: rgba(127, 127, 127, 0.16);
  color: inherit;
  font: inherit;
  font-size: 13px;
  padding: 6px 12px;
  border-radius: 999px;
  cursor: pointer;
}

.home__sections {
  display: flex;
  flex-direction: column;
  padding-bottom: 24px;
}

.home__subtitle {
  margin: 0;
  padding: 24px 16px 8px 16px;
  color: #0088ff;
  font-size: 15px;
  font-weight: 500;
}

.home__item {
  cursor: pointer;
}

.home__item-label {
  display: block;
  width: 100%;
  padding: 16px;
  font-size: 17px;
}
</style>
