<script setup lang="ts">
import { FlightIconPath } from '@/core/assets'

/**
 * `FlightIcon` — the Material Symbols "flight" glyph used as the placeholder for every
 * icon in the catalog (the original app also reuses this single vector everywhere).
 * Rendered with `currentColor` so a CSS `color` acts as the `ColorFilter.tint`.
 */
</script>

<template>
  <svg class="flight-icon" viewBox="0 0 960 960" xmlns="http://www.w3.org/2000/svg">
    <path :d="FlightIconPath" fill="currentColor" />
  </svg>
</template>

<style scoped>
.flight-icon {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
