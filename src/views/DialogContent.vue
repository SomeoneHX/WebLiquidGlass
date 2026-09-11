<script setup lang="ts">
import { computed } from 'vue'

import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import GlassSurface from '@/components/GlassSurface.vue'
import RippleSurface from '@/components/RippleSurface.vue'
import type { BackdropEffectScope, Highlight } from '@/core/backdrop'
import { HighlightStyles } from '@/core/backdrop'
import { LoremIpsum } from '@/core/assets'
import { dp } from '@/core/geometry'
import { RoundedRectangle } from '@/core/shapes'
import { useTheme } from '@/composables/backdrop-context'

/**
 * `DialogContent` — a dialog card over a dimmed wallpaper.
 *
 * The dim (`Modifier.drawWithContent` on the wallpaper) is part of the captured backdrop,
 * so the card samples the *dimmed* image — same as the Compose original.
 */
const { isLightTheme } = useTheme()

const dimColor = computed(() =>
  isLightTheme.value ? 'rgba(41, 41, 58, 0.23)' : 'rgba(18, 18, 18, 0.56)'
)
const contentColor = computed(() => (isLightTheme.value ? '#000000' : '#ffffff'))
const accentColor = computed(() => (isLightTheme.value ? '#0088FF' : '#0091FF'))
const containerColor = computed(() =>
  isLightTheme.value ? 'rgba(250, 250, 250, 0.6)' : 'rgba(18, 18, 18, 0.4)'
)
const cancelBackground = computed(() =>
  isLightTheme.value ? 'rgba(250, 250, 250, 0.12)' : 'rgba(18, 18, 18, 0.08)'
)

const shape = RoundedRectangle(dp(48))

const highlight = (): Highlight | null => HighlightStyles.Plain(1)

const effects = (scope: BackdropEffectScope): void => {
  scope.colorControls(isLightTheme.value ? 0.2 : 0, 1, 1.5)
  scope.blur(dp(isLightTheme.value ? 16 : 8))
  scope.lens(dp(24), dp(48), true)
}

function onDrawSurface(ctx: CanvasRenderingContext2D, size: { width: number; height: number }) {
  ctx.fillStyle = containerColor.value
  ctx.fillRect(0, 0, size.width, size.height)
}
</script>

<template>
  <BackdropDemoScaffold :dim-color="dimColor" v-slot="{ backdrop }">
    <GlassSurface
      class="dialog__card"
      content-class="dialog__body"
      :backdrop="backdrop"
      :shape="shape"
      :highlight="highlight"
      :effects="effects"
      :on-draw-surface="onDrawSurface"
    >
      <p class="dialog__title" :style="{ color: contentColor }">Dialog Title</p>
      <p
        class="dialog__text"
        :style="{
          color: contentColor,
          opacity: 0.68,
          mixBlendMode: isLightTheme ? 'normal' : 'plus-lighter'
        }"
      >
        {{ LoremIpsum }}
      </p>
      <div class="dialog__actions">
        <RippleSurface
          class="dialog__button"
          :style="{ background: cancelBackground }"
          :color="isLightTheme ? '#000' : '#fff'"
        >
          <span :style="{ color: contentColor }">Cancel</span>
        </RippleSurface>
        <RippleSurface
          class="dialog__button"
          :style="{ background: accentColor }"
          color="#ffffff"
        >
          <span style="color: #ffffff">Okay</span>
        </RippleSurface>
      </div>
    </GlassSurface>
  </BackdropDemoScaffold>
</template>

<style scoped>
.dialog__card {
  width: 100%;
}

.dialog__body {
  display: flex;
  flex-direction: column;
  padding: 40px;
  width: 100%;
}

.dialog__title {
  margin: 0;
  padding: 24px 28px 12px 28px;
  font-size: 24px;
  font-weight: 500;
}

.dialog__text {
  margin: 0;
  padding: 12px 24px;
  font-size: 15px;
  line-height: 1.4;
  max-height: 8em;
  overflow: hidden;
}

.dialog__actions {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 12px 24px 24px 24px;
}

.dialog__button {
  flex: 1 1 0;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  font-size: 16px;
  cursor: pointer;
}
</style>
