import type { SdfSource } from './glass-filter'

/**
 * Decode a baked SDF texture into the RGBA texels `glass-filter` builds its maps from.
 *
 * This is the browser-side half of `SdfShader`, and it lives *outside* `glass-filter.ts` on
 * purpose: that module is framework-free and gets lifted verbatim into the userscript, where
 * "which image" is a question it has no way to answer. Here it is a plain `Image` plus a canvas
 * read-back, which is exactly the part that cannot travel.
 *
 * ## What the texels mean
 *
 * The channel layout is the shader's, not a guess (see `SdfShaderString`): `r` is a signed
 * distance (`sd = r/255·2 − 1`, negative inside the shape), `gb` the unit normal
 * (`normalize(gb/255·2 − 1)`), `a` the shape coverage. Reading it back through a canvas is
 * lossless for the pixels that matter and near-lossless for the ones that do not:
 *
 *  - a canvas stores premultiplied alpha, so a round trip through `drawImage` + `getImageData`
 *    is exact where `a = 255` — which is every pixel whose distance the shader reads — and can
 *    shift fully transparent pixels' RGB by a level or two, where the shader reads nothing.
 *    In between (the ~13 % anti-aliased rim) the normal is still read, so treat those as
 *    accurate to a couple of 8-bit steps rather than to the bit.
 *  - `colorSpaceConversion: 'none'` is requested explicitly: this is data, not a photograph, and
 *    an ICC transform would move channel values that are supposed to be coordinates.
 *
 * ## Mask vs map
 *
 * The displacement and bevel maps are built from these texels. The **shape mask** is not — the
 * lens element points `mask-image` straight at the original URL, so the browser samples the full
 * resolution texture itself and the glyph outlines stay as sharp as the asset. Decoding here only
 * feeds the fields, which are smooth by construction.
 */

const cache = new Map<string, Promise<SdfSource>>()

/** Memoised per URL: a view that mounts twice decodes once. */
export function loadSdfTexture(url: string): Promise<SdfSource> {
  const hit = cache.get(url)
  if (hit) return hit
  const pending = decode(url)
  cache.set(url, pending)
  // A transient failure must not be cached as permanent — a later mount should be able to retry.
  pending.catch(() => {
    if (cache.get(url) === pending) cache.delete(url)
  })
  return pending
}

async function decode(url: string): Promise<SdfSource> {
  const bitmap = await fetchBitmap(url)
  const width = bitmap.width
  const height = bitmap.height
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  // `willReadFrequently` because this canvas is read exactly once and never composited; without
  // it Chromium keeps the backing store on the GPU and the `getImageData` below pays a readback.
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('sdf-texture: no 2d context')
  ctx.drawImage(bitmap, 0, 0)
  if ('close' in bitmap) bitmap.close()
  const { data } = ctx.getImageData(0, 0, width, height)
  return { key: url, width, height, data }
}

/** `createImageBitmap` when available, an `<img>` otherwise — the option is a bonus, not a need. */
async function fetchBitmap(url: string): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await createImageBitmap(await response.blob(), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none'
      })
    } catch {
      // Fall through: a `file:` document cannot `fetch` its own assets, and neither can some
      // strict CSP setups. The `<img>` path needs no permission the page did not already grant.
    }
  }
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`sdf-texture: could not load ${url}`))
    image.src = url
  })
}
