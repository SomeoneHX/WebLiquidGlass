<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import GlassSurface from './GlassSurface.vue'
import type { Backdrop, BackdropEffectScope, Highlight, Shadow } from '@/core/backdrop'
import { HighlightStyles, DefaultShadow } from '@/core/backdrop'
import { dp, identityTransform, type LayerTransform, type Size } from '@/core/geometry'
import { InteractiveHighlight } from '@/core/interactive-highlight'
import { lerp } from '@/core/math'
import { Capsule } from '@/core/shapes'
import { useTap } from '@/composables/useTap'

/**
 * `LiquidButton` — `app/src/commonMain/.../components/LiquidButton.kt`
 *
 * `vibrancy / blur / lens` go through `backdrop-filter` (see `GlassSurface`), so the capsule
 * genuinely samples and refracts the wallpaper. The tint stays canvas work because upstream
 * it is too: `onDrawSurface` paints it with `BlendMode.Hue`, a paint effect rather than a
 * RenderEffect.
 *
 * What is specific to this component is the deformation and the press light. Dragging inside
 * the button translates and stretches it (through `tanh` damping), and the radial highlight
 * from `InteractiveHighlight` follows the pointer across it.
 */
const props = withDefaults(
  defineProps<{
    backdrop: Backdrop
    isInteractive?: boolean
    /** `Color(0xFF0088FF)` etc — painted with `BlendMode.Hue` then a 0.75 alpha pass. */
    tint?: string | null
    /** `surfaceColor = Color.White.copy(0.3f)` */
    surfaceColor?: string | null
  }>(),
  { isInteractive: true, tint: null, surfaceColor: null }
)

const emit = defineEmits<{ click: [] }>()

const surface = ref<InstanceType<typeof GlassSurface> | null>(null)
const element = computed(() => (surface.value?.el as HTMLElement | null) ?? null)

const interactiveHighlight = props.isInteractive ? new InteractiveHighlight() : null

const shape = Capsule

const highlight = (): Highlight | null => HighlightStyles.Default(1)

const shadow = (): Shadow | null => DefaultShadow

const effects = (scope: BackdropEffectScope): void => {
  scope.vibrancy()
  scope.blur(dp(2))
  scope.lens(dp(12), dp(24))
}

function layerTransform(): LayerTransform {
  const size = surface.value?.size
  if (!props.isInteractive || !interactiveHighlight || !size) return identityTransform
  const { width, height } = size
  if (width <= 0 || height <= 0) return identityTransform

  const progress = interactiveHighlight.pressProgress
  const scale = lerp(1, 1 + dp(4) / height, progress)

  const maxOffset = Math.min(width, height)
  const initialDerivative = 0.05
  const offset = interactiveHighlight.offset
  const translationX = maxOffset * Math.tanh((initialDerivative * offset.x) / maxOffset)
  const translationY = maxOffset * Math.tanh((initialDerivative * offset.y) / maxOffset)

  const maxDragScale = dp(4) / height
  const offsetAngle = Math.atan2(offset.y, offset.x)
  const maxDimension = Math.max(width, height)
  const scaleX =
    scale +
    maxDragScale *
      Math.abs((Math.cos(offsetAngle) * offset.x) / maxDimension) *
      Math.min(width / height, 1)
  const scaleY =
    scale +
    maxDragScale *
      Math.abs((Math.sin(offsetAngle) * offset.y) / maxDimension) *
      Math.min(height / width, 1)

  return { translationX, translationY, scaleX, scaleY, rotationZ: 0, alpha: 1 }
}

function onDrawSurface(ctx: CanvasRenderingContext2D, size: Size): void {
  if (props.tint) {
    ctx.save()
    ctx.globalCompositeOperation = 'hue'
    ctx.fillStyle = props.tint
    ctx.fillRect(0, 0, size.width, size.height)
    ctx.restore()
    ctx.save()
    ctx.globalAlpha = 0.75
    ctx.fillStyle = props.tint
    ctx.fillRect(0, 0, size.width, size.height)
    ctx.restore()
  }
  if (props.surfaceColor) {
    ctx.save()
    ctx.fillStyle = props.surfaceColor
    ctx.fillRect(0, 0, size.width, size.height)
    ctx.restore()
  }
}

useTap(element, () => emit('click'))

onMounted(() => {
  if (interactiveHighlight && element.value) {
    const detach = interactiveHighlight.attach(element.value)
    onBeforeUnmount(detach)
  }
})
</script>

<template>
  <GlassSurface
    ref="surface"
    class="liquid-button"
    content-class="liquid-button__content"
    :backdrop="backdrop"
    :shape="shape"
    :highlight="highlight"
    :shadow="shadow"
    :effects="effects"
    :layer-transform="layerTransform"
    :on-draw-surface="onDrawSurface"
    :interactive-highlight="interactiveHighlight"
  >
    <slot />
  </GlassSurface>
</template>

<style scoped>
.liquid-button {
  height: 48px;
}

.liquid-button :deep(.liquid-button__content) {
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 16px;
  width: 100%;
  height: 100%;
  white-space: nowrap;
}
</style>
