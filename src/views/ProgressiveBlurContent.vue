<script setup lang="ts">
import { computed, ref } from 'vue'

import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import GlassSurface from '@/components/GlassSurface.vue'
import type { BackdropEffectScope } from '@/core/backdrop'
import { dp } from '@/core/geometry'
import { Rectangle } from '@/core/shapes'
import { useTheme } from '@/composables/backdrop-context'

/**
 * `ProgressiveBlurContent` — the alpha-masked progressive blur.
 *
 * Degraded (API < 31): **both** effects are gone. `blur(4.dp)` is a RenderEffect and the
 * `AlphaMask` AGSL shader is a `RuntimeShader`, so on this build the plane is simply the
 * unmodified wallpaper rectangle with the label on top — the gradient is entirely absent.
 * It is the starkest "before/after" in the catalog, which is why it is worth porting as-is.
 *
 * The shader source and its uniforms are kept verbatim so that enabling the full (API 33+)
 * path only requires switching the effect pipeline on.
 */
const { isLightTheme } = useTheme()

const plate = ref<InstanceType<typeof GlassSurface> | null>(null)

const contentColor = computed(() => (isLightTheme.value ? '#000000' : '#ffffff'))
const tintColor = computed(() => (isLightTheme.value ? '#ffffff' : '#808080'))

const ALPHA_MASK_SHADER = `
    uniform shader content;
    
    uniform float2 size;
    layout(color) uniform half4 tint;
    uniform float tintIntensity;
    
    half4 main(float2 coord) {
        float blurAlpha = smoothstep(size.y, size.y * 0.5, coord.y);
        float tintAlpha = smoothstep(size.y, size.y * 0.5, coord.y);
        return mix(content.eval(coord) * blurAlpha, tint * tintAlpha, tintIntensity);
    }`

function effects(scope: BackdropEffectScope): void {
  const size = plate.value?.size ?? { width: 0, height: 0 }
  scope.blur(dp(4))
  scope.runtimeShaderEffect('AlphaMask', ALPHA_MASK_SHADER, 'content', (uniforms) => {
    uniforms.setFloatUniform('size', size.width, size.height)
    uniforms.setColorUniform('tint', tintColor.value)
    uniforms.setFloatUniform('tintIntensity', 0.8)
  })
}
</script>

<template>
  <BackdropDemoScaffold v-slot="{ backdrop }">
    <div class="progressive">
      <div class="progressive__column">
        <GlassSurface
          ref="plate"
          class="progressive__plane"
          :backdrop="backdrop"
          :shape="Rectangle"
          :highlight="() => null"
          :shadow="() => null"
          :effects="effects"
        >
          <span class="progressive__label" :style="{ color: contentColor }">
            alpha-masked progressive blur
          </span>
        </GlassSurface>
      </div>
    </div>
  </BackdropDemoScaffold>
</template>

<style scoped>
.progressive {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.progressive__column {
  display: flex;
  flex-direction: column;
  gap: 16px;
  align-items: center;
  width: 100%;
}

.progressive__plane {
  width: 100%;
  height: 128px;
}

.progressive__label {
  font-size: 16px;
}
</style>
