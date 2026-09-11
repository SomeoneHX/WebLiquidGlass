<script setup lang="ts">
import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import GlassSurface from '@/components/GlassSurface.vue'
import type { BackdropEffectScope } from '@/core/backdrop'
import { dp } from '@/core/geometry'
import { RoundedRectangle, type Shape } from '@/core/shapes'

/**
 * `LazyScrollContainerContent` — 100 items in a `LazyColumn`.
 *
 * Degraded (API < 31): the glass itself is just the wallpaper in a rounded rect (see
 * `ScrollContainerContent`). The interesting part of this port is the *laziness*: Compose
 * only composes the visible window, and on the web there is no equivalent — so instead every
 * `GlassSurface` implements **viewport culling**. Off-screen rows release their backing
 * store (`canvas.width = 0`) and re-acquire it when they scroll back into view, which keeps
 * a 100-row list from holding 100 GPU textures.
 */
const COUNT = 100

const shape: Shape = RoundedRectangle(dp(32))

function effects(scope: BackdropEffectScope): void {
  scope.vibrancy()
  scope.lens(dp(16), dp(32))
}
</script>

<template>
  <BackdropDemoScaffold v-slot="{ backdrop }">
    <div class="lazy-demo scroll-y fill-screen">
      <div class="lazy-demo__pad">
        <div class="lazy-demo__inset" />
        <GlassSurface
          v-for="index in COUNT"
          :key="index"
          class="lazy-demo__box"
          :backdrop="backdrop"
          :shape="shape"
          :effects="effects"
        />
        <div class="lazy-demo__inset" />
      </div>
    </div>
  </BackdropDemoScaffold>
</template>

<style scoped>
.lazy-demo {
  position: absolute;
  inset: 0;
}

/* `LazyColumn(contentPadding = 16.dp, spacedBy(16.dp))` */
.lazy-demo__pad {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

/* `Spacer(windowInsetsTopHeight(systemBars))` / bottom */
.lazy-demo__inset {
  flex: 0 0 auto;
  height: var(--safe-top);
}

.lazy-demo__inset:last-child {
  height: var(--safe-bottom);
}

.lazy-demo__box {
  height: 160px;
  width: 100%;
}
</style>
