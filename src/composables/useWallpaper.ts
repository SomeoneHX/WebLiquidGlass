import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'

import type { Rect } from '@/core/geometry'

/**
 * Loads the catalog wallpaper (and any user-picked replacement) and exposes a
 * `ContentScale.Crop` painter plus the source rectangle it maps onto.
 */
export function useWallpaper(defaultSrc: string) {
  const image = shallowRef<HTMLImageElement | null>(null)
  const src = ref(defaultSrc)
  const objectUrl = ref<string | null>(null)
  const ready = ref(false)

  function load(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const element = new Image()
      element.crossOrigin = 'anonymous'
      element.onload = () => resolve(element)
      element.onerror = reject
      element.src = url
    })
  }

  async function apply(url: string) {
    try {
      const loaded = await load(url)
      image.value = loaded
      ready.value = true
    } catch {
      ready.value = false
    }
  }

  function setFromFile(file: File) {
    if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
    const url = URL.createObjectURL(file)
    objectUrl.value = url
    src.value = url
    void apply(url)
  }

  onMounted(() => void apply(src.value))

  watch(src, (value) => {
    if (value !== defaultSrc) void apply(value)
  })

  onBeforeUnmount(() => {
    if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
  })

  return { image, src, ready, setFromFile }
}

/**
 * `drawImage` with `ContentScale.Crop` semantics into a `width x height` target.
 */
export function drawCover(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width: number; height: number },
  target: Rect | { width: number; height: number },
  dx = 0,
  dy = 0
): void {
  const sourceWidth = image.naturalWidth ?? image.width
  const sourceHeight = image.naturalHeight ?? image.height
  if (!sourceWidth || !sourceHeight) return
  const scale = Math.max(target.width / sourceWidth, target.height / sourceHeight)
  const drawWidth = sourceWidth * scale
  const drawHeight = sourceHeight * scale
  const offsetX = dx + (target.width - drawWidth) / 2
  const offsetY = dy + (target.height - drawHeight) / 2
  ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight)
}
