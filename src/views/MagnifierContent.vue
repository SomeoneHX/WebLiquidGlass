<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'

import BackdropDemoScaffold from '@/components/BackdropDemoScaffold.vue'
import GlassSurface from '@/components/GlassSurface.vue'
import type { Backdrop, BackdropEffectScope } from '@/core/backdrop'
import { LayerBackdrop, combinedBackdrop } from '@/core/backdrop'
import { requestRedraw } from '@/core/animation'
import { LoremIpsum } from '@/core/assets'
import { dp, type Size } from '@/core/geometry'
import { inspectDragGestures } from '@/core/drag-gestures'
import { Capsule } from '@/core/shapes'
import { bumpLayoutEpoch, layoutEpoch, useElementMetrics } from '@/composables/useElementMetrics'
import { useTheme } from '@/composables/backdrop-context'

/**
 * `MagnifierContent` — the draggable magnifier.
 *
 * This is one of the destinations that still *does* something on API < 31: `lens` is a
 * no-op and `InnerShadow` is skipped entirely, but `onDrawBackdrop` — which re-draws the
 * sampled backdrop scaled 1.5x about the lens centre and shifted up by 80 dp — is plain
 * `DrawScope` work. So the liquid lens loses its refraction yet keeps its magnification.
 *
 * Port note: the recorded `contentBackdrop` / `cursorBackdrop` layers are painted into
 * offscreen canvases here (a DOM node cannot be captured to a 2D context without pulling in
 * a rasterizer). The paragraph is re-rendered with the *computed* CSS font and line-height,
 * so the canvas copy lines up with the DOM copy it magnifies.
 */
const { isLightTheme } = useTheme()

const contentColor = computed(() => (isLightTheme.value ? '#000000' : '#ffffff'))
const accentColor = computed(() => (isLightTheme.value ? '#0088FF' : '#0091FF'))
const backgroundColor = computed(() => (isLightTheme.value ? '#ffffff' : '#121212'))

const cursorOffset = ref({ x: 0, y: 0 })

/* ------------------------------------------------------------------------ layers ------- */
const scaffold = ref<InstanceType<typeof BackdropDemoScaffold> | null>(null)
const rootBackdrop = shallowRef<Backdrop | null>(null)

const contentBackdrop = new LayerBackdrop()
const cursorBackdrop = new LayerBackdrop()

const combined = computed(() => {
  const root = rootBackdrop.value
  return root
    ? combinedBackdrop(root, contentBackdrop, cursorBackdrop)
    : combinedBackdrop(contentBackdrop, cursorBackdrop)
})

onMounted(() => {
  rootBackdrop.value = scaffold.value?.backdrop ?? null
})

const textEl = ref<HTMLElement | null>(null)
const paragraphEl = ref<HTMLElement | null>(null)
const cursorEl = ref<HTMLElement | null>(null)
const lens = ref<InstanceType<typeof GlassSurface> | null>(null)

const textMetrics = useElementMetrics(textEl)
const cursorMetrics = useElementMetrics(cursorEl)

/** Greedy word wrap matching the browser's line breaking well enough for a lens copy. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate
    } else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines
}

/**
 * Paints the paragraph (rounded 32 dp card + text) into the recorded layer. The DOM copy is
 * drawn on top by the browser; this canvas copy is what the magnifier samples.
 */
function captureContent(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const paragraph = paragraphEl.value
  if (!paragraph) return
  void width
  void height
  const style = window.getComputedStyle(paragraph)
  const paragraphRect = paragraph.getBoundingClientRect()
  const hostRect = textEl.value?.getBoundingClientRect()
  const offsetX = hostRect ? paragraphRect.left - hostRect.left : 0
  const offsetY = hostRect ? paragraphRect.top - hostRect.top : 0
  const boxWidth = paragraphRect.width
  const boxHeight = paragraphRect.height
  const radius = Number.parseFloat(style.borderTopLeftRadius) || 0

  ctx.save()
  ctx.beginPath()
  ctx.moveTo(offsetX + radius, offsetY)
  ctx.arcTo(offsetX + boxWidth, offsetY, offsetX + boxWidth, offsetY + boxHeight, radius)
  ctx.arcTo(offsetX + boxWidth, offsetY + boxHeight, offsetX, offsetY + boxHeight, radius)
  ctx.arcTo(offsetX, offsetY + boxHeight, offsetX, offsetY, radius)
  ctx.arcTo(offsetX, offsetY, offsetX + boxWidth, offsetY, radius)
  ctx.closePath()
  ctx.fillStyle = style.backgroundColor
  ctx.fill()
  ctx.clip()

  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0
  const paddingRight = Number.parseFloat(style.paddingRight) || 0
  const paddingTop = Number.parseFloat(style.paddingTop) || 0
  ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  ctx.fillStyle = style.color
  ctx.textBaseline = 'top'
  const lineHeight = Number.parseFloat(style.lineHeight)
  const fontSize = Number.parseFloat(style.fontSize)
  const step = Number.isFinite(lineHeight) ? lineHeight : fontSize * 1.2
  const maxWidth = Math.max(1, boxWidth - paddingLeft - paddingRight)
  const lines = wrapText(ctx, paragraph.textContent ?? '', maxWidth)

  let y = offsetY + paddingTop
  for (const line of lines) {
    ctx.fillText(line, offsetX + paddingLeft, y)
    y += step
  }
  ctx.restore()
}

const cursorCapture = (ctx: CanvasRenderingContext2D, width: number, height: number): void => {
  ctx.save()
  Capsule.buildPath(ctx, width, height)
  ctx.clip()
  ctx.fillStyle = accentColor.value
  ctx.fillRect(0, 0, width, height)
  ctx.restore()
}

/**
 * The recorded content only needs re-painting when the box *size* or the colours change; a
 * move is handled by `setRect` alone (the recorded bitmap is already correct), which keeps a
 * per-frame drag from re-rasterising the paragraph every frame.
 */
watch(
  [textMetrics.size, contentColor, backgroundColor],
  () => {
    const { width, height } = textMetrics.size.value
    if (width <= 0 || height <= 0) return
    contentBackdrop.configure(width, height, captureContent)
    contentBackdrop.setRect(textMetrics.rect.value)
    contentBackdrop.invalidate()
    requestRedraw()
  },
  { immediate: true, flush: 'post' }
)

watch(
  [cursorMetrics.size, accentColor],
  () => {
    const { width, height } = cursorMetrics.size.value
    if (width <= 0 || height <= 0) return
    cursorBackdrop.configure(width, height, cursorCapture)
    cursorBackdrop.setRect(cursorMetrics.rect.value)
    cursorBackdrop.invalidate()
    requestRedraw()
  },
  { immediate: true, flush: 'post' }
)

watch(
  [textMetrics.rect, cursorMetrics.rect, layoutEpoch],
  () => {
    if (textMetrics.rect.value.width > 0) contentBackdrop.setRect(textMetrics.rect.value)
    if (cursorMetrics.rect.value.width > 0) cursorBackdrop.setRect(cursorMetrics.rect.value)
    requestRedraw()
  },
  { immediate: true, flush: 'post' }
)

/* ----------------------------------------------------------------------- gesture ------- */
onMounted(() => {
  const node = cursorEl.value
  if (!node) return
  const detach = inspectDragGestures(
    node,
    {
      onDrag: (delta) => {
        cursorOffset.value = {
          x: cursorOffset.value.x + delta.x,
          y: cursorOffset.value.y + delta.y
        }
        // The cursor and the lens are moved with a CSS `transform`, which does *not* fire
        // `ResizeObserver` — bumping the layout epoch is what makes every affected rect
        // (the cursor layer, the lens, the recorded paragraph) re-measure.
        bumpLayoutEpoch()
      }
    },
    (event) => ({ x: event.clientX, y: event.clientY })
  )
  onBeforeUnmount(detach)
})

/* ---------------------------------------------------------------------- rendering ------ */
const cursorStyle = computed(() => ({
  transform: `translate(${cursorOffset.value.x}px, ${cursorOffset.value.y}px)`,
  background: accentColor.value
}))

const lensStyle = computed(() => ({
  transform: `translate(${cursorOffset.value.x}px, ${cursorOffset.value.y - dp(80)}px)`
}))

function effects(scope: BackdropEffectScope): void {
  scope.lens(dp(8), dp(24), true, true)
}

/** `withTransform({ scale(1.5, 1.5); translate(top = -80.dp) }, drawBackdrop)` */
function onDrawBackdrop(ctx: CanvasRenderingContext2D, draw: () => void): void {
  const size: Size | undefined = lens.value?.size
  if (!size || size.width <= 0 || size.height <= 0) {
    draw()
    return
  }
  const cx = size.width / 2
  const cy = size.height / 2
  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(1.5, 1.5)
  ctx.translate(-cx, -cy)
  ctx.translate(0, -dp(80))
  draw()
  ctx.restore()
}
</script>

<template>
  <BackdropDemoScaffold ref="scaffold">
    <div class="magnifier">
      <div ref="textEl" class="magnifier__text">
        <p
          ref="paragraphEl"
          class="magnifier__paragraph"
          :style="{ background: backgroundColor, color: contentColor }"
        >
          {{ LoremIpsum }}
        </p>
      </div>

      <div ref="cursorEl" class="magnifier__cursor" :style="cursorStyle" />

      <GlassSurface
        ref="lens"
        class="magnifier__lens"
        :style="lensStyle"
        :backdrop="combined"
        :shape="Capsule"
        :effects="effects"
        :on-draw-backdrop="onDrawBackdrop"
      />
    </div>
  </BackdropDemoScaffold>
</template>

<style scoped>
.magnifier {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* `padding(24).clip(RoundedRectangle(32)).background(...).padding(24)` */
.magnifier__text {
  padding: 24px;
  max-width: 100%;
}

.magnifier__paragraph {
  margin: 0;
  padding: 24px;
  border-radius: 32px;
  font-size: 16px;
  line-height: 1.2;
  opacity: 0.9;
}

.magnifier__cursor {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 4px;
  height: 24px;
  margin-left: -2px;
  margin-top: -12px;
  border-radius: 999px;
  touch-action: none;
  cursor: grab;
}

.magnifier__lens {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 128px;
  height: 96px;
  margin-left: -64px;
  margin-top: -48px;
  pointer-events: none;
}
</style>
