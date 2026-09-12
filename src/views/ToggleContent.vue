<script setup lang="ts">
import { computed, ref } from 'vue'

import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import LiquidToggle from '@/components/LiquidToggle.vue'
import { useTheme } from '@/composables/backdrop-context'

/**
 * `ToggleContent` — a toggle over the wallpaper, and one on a solid card.
 *
 * The Kotlin version gives the card's toggle a `rememberCanvasBackdrop { drawRect(backgroundColor) }`
 * so it samples a flat colour instead of the wallpaper. Here the card is an ordinary DOM box
 * with that colour as its CSS background, which the toggle's `backdrop-filter` picks up on its
 * own — same result, no second backdrop.
 */
const { isLightTheme } = useTheme()

const selected = ref(false)

const cardBackground = computed(() => (isLightTheme.value ? '#FFFFFF' : '#121212'))
</script>

<template>
  <BackdropDemoScaffold v-slot="{ backdrop }">
    <div class="toggle-page">
      <LiquidToggle
        class="toggle-page__standalone"
        :selected="selected"
        :is-light-theme="isLightTheme"
        :backdrop="backdrop"
        @select="selected = $event"
      />

      <div class="toggle-page__card" :style="{ background: cardBackground }">
        <LiquidToggle
          class="toggle-page__card-toggle"
          :selected="selected"
          :is-light-theme="isLightTheme"
          :backdrop="backdrop"
          @select="selected = $event"
        />
      </div>
    </div>
  </BackdropDemoScaffold>
</template>

<style scoped>
.toggle-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.toggle-page__standalone {
  margin: 0 32px;
}

.toggle-page__card {
  margin: 24px;
  padding: 24px;
  border-radius: 32px;
}

/* `modifier = Modifier.padding(horizontal = 32f.dp)` on the card's toggle. */
.toggle-page__card-toggle {
  margin: 0 32px;
}
</style>
