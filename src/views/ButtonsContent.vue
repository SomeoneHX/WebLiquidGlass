<script setup lang="ts">
import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import LiquidButton from '@/components/LiquidButton.vue'

/**
 * `ButtonsContent` — four liquid buttons over the wallpaper.
 *
 * Degraded (API < 31): the transparent button is only its press wash + deformation, the
 * surface/tinted variants keep their solid fills (`onDrawSurface` is plain canvas drawing,
 * independent of RenderEffect).
 */
</script>

<template>
  <BackdropDemoScaffold v-slot="{ backdrop }">
    <div class="buttons">
      <LiquidButton :backdrop="backdrop">
        <span class="buttons__label buttons__label--on-paper">Transparent Liquid Button</span>
      </LiquidButton>
      <LiquidButton :backdrop="backdrop" surface-color="rgba(255, 255, 255, 0.3)">
        <span class="buttons__label buttons__label--on-paper">Surface Liquid Button</span>
      </LiquidButton>
      <LiquidButton :backdrop="backdrop" tint="#0088FF">
        <span class="buttons__label buttons__label--on-tint">Tinted Liquid Button</span>
      </LiquidButton>
      <LiquidButton :backdrop="backdrop" tint="#FF8D28">
        <span class="buttons__label buttons__label--on-tint">Tinted Liquid Button</span>
      </LiquidButton>
    </div>
  </BackdropDemoScaffold>
</template>

<style scoped>
.buttons {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.buttons__label {
  font-size: 15px;
}

.buttons__label--on-paper {
  color: #000000;
}

.buttons__label--on-tint {
  color: #ffffff;
}
</style>
