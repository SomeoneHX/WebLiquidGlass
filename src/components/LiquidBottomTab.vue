<script setup lang="ts">
/**
 * `RowScope.LiquidBottomTab` — a capsule-clipped, weight-1 clickable tab whose content is a
 * centred column with a 2 dp gap. Content colour (accent when selected) is set by the caller
 * via inherited `color` — see `BottomTabsContent.vue`.
 */
defineProps<{ selected?: boolean }>()

const emit = defineEmits<{ click: [] }>()
</script>

<template>
  <div
    class="liquid-bottom-tab"
    :class="{ 'liquid-bottom-tab--selected': selected }"
    @click="emit('click')"
  >
    <slot />
  </div>
</template>

<style scoped>
.liquid-bottom-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  flex: 1 1 0;
  min-width: 0;
  height: 100%;
  border-radius: 999px;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
</style>
