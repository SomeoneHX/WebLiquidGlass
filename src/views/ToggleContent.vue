<script setup lang="ts">
import { computed, ref } from 'vue'

import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import LiquidToggle from '@/components/LiquidToggle.vue'
import { CanvasBackdrop } from '@/core/backdrop'
import { Colors, toCss } from '@/core/color'
import { useTheme } from '@/composables/backdrop-context'

/** `ToggleContent` — a toggle over the wallpaper, and one on a solid card. */
const { isLightTheme } = useTheme()

const selected = ref(false)

const backgroundColor = computed(() => (isLightTheme.value ? Colors.White : Colors.Black))
const cardBackground = computed(() => (isLightTheme.value ? '#FFFFFF' : '#121212'))

/**
 * `rememberCanvasBackdrop { drawRect(backgroundColor) }` — a coordinate independent backdrop
 * that simply paints the element's box, so the toggle inside the card samples a flat colour.
 */
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
          :backdrop="cardBackdrop"
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
