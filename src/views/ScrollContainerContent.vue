<script setup lang="ts">
import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import GlassSurface from '@/components/GlassSurface.vue'
import type { BackdropEffectScope } from '@/core/backdrop'
import { dp } from '@/core/geometry'
import { RoundedRectangle, type Shape } from '@/core/shapes'

/**
 * `ScrollContainerContent` — 20 rounded glass boxes inside a plain `verticalScroll`.
 *
 * Each row is the wallpaper seen through a 32 dp rounded rectangle plus its highlight ring.
 * `vibrancy()` / `blur()` / `lens()` all end up in `backdrop-filter`, so the rows are real
 * glass (`core/glass-filter.ts`). Scrolling keeps working, and the wallpaper stays pinned to
 * the screen while the rows travel over it — that re-sampling is now the browser's job.
 */
const COUNT = 20

const shape: Shape = RoundedRectangle(dp(32))

function effects(scope: BackdropEffectScope): void {
  scope.vibrancy()
  scope.lens(dp(16), dp(32))
}
</script>

<template>
  <BackdropDemoScaffold v-slot="{ backdrop }">
    <div class="scroll-demo scroll-y fill-screen system-bars-padding display-cutout-padding">
      <div class="scroll-demo__pad">
        <GlassSurface
          v-for="index in COUNT"
          :key="index"
          class="scroll-demo__box"
          :backdrop="backdrop"
          :shape="shape"
          :effects="effects"
        />
      </div>
    </div>
  </BackdropDemoScaffold>
</template>

<style scoped>
.scroll-demo {
  position: absolute;
  inset: 0;
}

/* `Column(verticalScroll, padding(16), spacedBy(16))` */
.scroll-demo__pad {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

.scroll-demo__box {
  height: 160px;
  width: 100%;
}
</style>
