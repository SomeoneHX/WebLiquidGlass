<script setup lang="ts">
import { computed, ref } from 'vue'

import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import LiquidSlider from '@/components/LiquidSlider.vue'
import { useTheme } from '@/composables/backdrop-context'

/**
 * `SliderContent` — a slider over the wallpaper, and one on a solid card.
 *
 * Same story as `ToggleContent`: the card's slider used a `rememberCanvasBackdrop` to sample a
 * flat colour, but the card is already a DOM box with that colour as its background, so the
 * thumb's `backdrop-filter` samples it directly.
 */
const { isLightTheme } = useTheme()

const value = ref(50)

const cardBackground = computed(() => (isLightTheme.value ? '#FFFFFF' : '#121212'))
</script>

<template>
  <BackdropDemoScaffold v-slot="{ backdrop }">
    <div class="slider-page">
      <div class="slider-page__row">
        <LiquidSlider
          :value="value"
          :value-range="[0, 100]"
          :visibility-threshold="0.01"
          :is-light-theme="isLightTheme"
          :backdrop="backdrop"
          @change="value = $event"
        />
      </div>

      <div class="slider-page__card" :style="{ background: cardBackground }">
        <div class="slider-page__row">
          <LiquidSlider
            :value="value"
            :value-range="[0, 100]"
            :visibility-threshold="0.01"
            :is-light-theme="isLightTheme"
            :backdrop="backdrop"
            @change="value = $event"
          />
        </div>
      </div>
    </div>
  </BackdropDemoScaffold>
</template>

<style scoped>
.slider-page {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 16px;
  width: 100%;
}

.slider-page__row {
  padding: 0 32px;
}

.slider-page__card {
  margin: 24px;
  padding: 24px;
  border-radius: 32px;
}
</style>
