<script setup lang="ts">
import { computed, ref } from 'vue'

import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import LiquidSlider from '@/components/LiquidSlider.vue'
import { CanvasBackdrop } from '@/core/backdrop'
import { Colors, toCss } from '@/core/color'
import { useTheme } from '@/composables/backdrop-context'

/** `SliderContent` — a slider over the wallpaper, and one on a solid card. */
const { isLightTheme } = useTheme()

const value = ref(50)

const backgroundColor = computed(() => (isLightTheme.value ? Colors.White : Colors.Black))
const cardBackground = computed(() => (isLightTheme.value ? '#FFFFFF' : '#121212'))

const cardBackdrop = computed(
  () =>
    new CanvasBackdrop((ctx, dc) => {
      ctx.fillStyle = toCss(backgroundColor.value)
      ctx.fillRect(0, 0, dc.size.width, dc.size.height)
    })
)
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
            :backdrop="cardBackdrop"
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
