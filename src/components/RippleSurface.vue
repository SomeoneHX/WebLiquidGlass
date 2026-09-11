<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/** `Modifier.ripple(...)` — the Material bounded ripple used by plain `clickable`. */
withDefaults(
  defineProps<{
    color?: string
    bounded?: boolean
    alpha?: number
  }>(),
  { color: '#000000', bounded: true, alpha: 0.1 }
)

interface RippleInstance {
  id: number
  x: number
  y: number
  radius: number
  state: 'in' | 'out'
}

const host = ref<HTMLElement | null>(null)
const ripples = ref<RippleInstance[]>([])
let nextId = 1

function localPoint(event: PointerEvent) {
  const rect = host.value?.getBoundingClientRect()
  if (!rect) return { x: 0, y: 0 }
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function furthestCornerDistance(x: number, y: number): number {
  const node = host.value
  if (!node) return 0
  const width = node.clientWidth
  const height = node.clientHeight
  return Math.max(
    Math.hypot(x, y),
    Math.hypot(width - x, y),
    Math.hypot(x, height - y),
    Math.hypot(width - x, height - y)
  )
}

function onPointerDown(event: PointerEvent) {
  const { x, y } = localPoint(event)
  const id = nextId++
  ripples.value = [
    ...ripples.value.filter((r) => r.state !== 'out'),
    { id, x, y, radius: furthestCornerDistance(x, y), state: 'in' }
  ]
}

function onPointerUp() {
  ripples.value = ripples.value.map((r) => (r.state === 'in' ? { ...r, state: 'out' } : r))
  window.setTimeout(() => {
    ripples.value = ripples.value.filter((r) => r.state !== 'out')
  }, 320)
}

onMounted(() => {
  const node = host.value
  if (!node) return
  node.addEventListener('pointerdown', onPointerDown)
  node.addEventListener('pointerup', onPointerUp)
  node.addEventListener('pointercancel', onPointerUp)
  node.addEventListener('pointerleave', onPointerUp)
})

onBeforeUnmount(() => {
  const node = host.value
  if (!node) return
  node.removeEventListener('pointerdown', onPointerDown)
  node.removeEventListener('pointerup', onPointerUp)
  node.removeEventListener('pointercancel', onPointerUp)
  node.removeEventListener('pointerleave', onPointerUp)
})
</script>

<template>
  <div ref="host" class="ripple-host">
    <div class="ripple-host__content"><slot /></div>
    <span class="ripple-host__clip" :class="{ 'ripple-host__clip--bounded': bounded }">
      <span
        v-for="ripple in ripples"
        :key="ripple.id"
        class="ripple-host__wave"
        :class="`ripple-host__wave--${ripple.state}`"
        :style="{
          left: `${ripple.x}px`,
          top: `${ripple.y}px`,
          width: `${ripple.radius * 2}px`,
          height: `${ripple.radius * 2}px`,
          background: color,
          opacity: ripple.state === 'in' ? alpha : 0
        }"
      />
    </span>
  </div>
</template>

<style scoped>
.ripple-host {
  position: relative;
  overflow: hidden;
}

.ripple-host__content {
  position: relative;
  z-index: 1;
}

.ripple-host__clip {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.ripple-host__wave {
  position: absolute;
  border-radius: 50%;
  transform: translate(-50%, -50%) scale(0);
  transition:
    transform 300ms cubic-bezier(0.2, 0, 0, 1),
    opacity 300ms linear;
}

.ripple-host__wave--in {
  transform: translate(-50%, -50%) scale(1);
}

.ripple-host__wave--out {
  transform: translate(-50%, -50%) scale(1);
  transition: opacity 150ms linear;
}
</style>
