// ==UserScript==
// @name         Liquid Glass Refraction (backdrop-filter + feDisplacementMap)
// @name:zh-CN   液态玻璃折射（backdrop-filter + feDisplacementMap）
// @namespace    https://github.com/SomeoneHX/WebLiquidGlass
// @version      0.2.0
// @description  Liquid-glass refraction as a self-contained userscript: rounded-rect SDF -> displacement map -> SVG filter graph -> `backdrop-filter: url(#id)`. Extracted from WebLiquidGlass `src/core/glass-filter.ts`. Chromium only.
// @description:zh-CN  把任意元素变成液态玻璃折射透镜：圆角矩形 SDF → 位移图 → SVG 滤镜图 → backdrop-filter。提取自 WebLiquidGlass 的 src/core/glass-filter.ts，仅 Chromium。
// @author       SomeoneHX
// @license      Apache-2.0
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// @noframes
// @homepageURL  https://github.com/SomeoneHX/WebLiquidGlass
// @supportURL   https://github.com/SomeoneHX/WebLiquidGlass/issues
// @updateURL    https://someonehx.github.io/WebLiquidGlass/liquid-glass-refract.user.js
// @downloadURL  https://someonehx.github.io/WebLiquidGlass/liquid-glass-refract.user.js
// ==/UserScript==

/**
 * ==========================================================================================
 * Liquid Glass refraction, extracted for a userscript
 * ==========================================================================================
 *
 * Provenance: WebLiquidGlass `src/core/glass-filter.ts` (658 lines of TS, **zero imports** —
 * no Vue, no framework, no project module). Section 1 below is that file with the type
 * annotations stripped by `tsc` and the `export` keywords removed; not a single expression was
 * rewritten, so the displacement field is bit-identical to the demo's. The only edit at all is
 * one hardened line in `svgRoot()` (`document.body || document.documentElement`), so the script
 * also survives being executed before `<body>` exists — which is exactly what `@require` does.
 *
 * ## How to include it — three ways, one file
 *
 * 1. **Install** `https://someonehx.github.io/WebLiquidGlass/liquid-glass-refract.user.js` as a
 *    userscript. It is inert until it is configured (see below), then auto-updates through
 *    `@updateURL` because CI stamps a fresh `@version` on every deploy.
 * 2. **`@require`** the same URL from your own userscript — the API lands on
 *    `window.LiquidGlassRefract` (and, inside a sandboxed script, on `unsafeWindow`).
 * 3. **Plain `<script src>`** in a page, or copy Section 1 (the core, zero dependencies) into
 *    your own host and ignore everything below it.
 *
 * ## Configuration — assign `window.LiquidGlassRefractConfig` before the script runs
 *
 * ```js
 * window.LiquidGlassRefractConfig = {
 *   selectors: ['.header', 'nav'],          // apply on load; empty = nothing happens
 *   autoWatch: true,                        // MutationObserver, for SPA-inserted nodes
 *   hotkeys: { glassify: 'alt+shift+g', unglassify: 'alt+shift+u' },   // or `false`
 *   defaults: { blur: 12, refractionHeight: 24 }   // merged over DEFAULTS
 * }
 * ```
 *
 * Loading the file twice is a no-op (it checks for its own global and returns).
 *
 * What it generates, per glass surface:
 *   1. `buildMap()` rasterises the rounded-rect SDF on a canvas and encodes the rim bend into
 *      R = dx, G = dy (128 = no offset — the exact zero point is 127.5; see why it is left alone
 *      at the neutral fill in `buildMap`), one PNG per spectral branch.
 *   2. `createGlassFilter()` builds a `<filter>` in `userSpaceOnUse` units with explicit
 *      per-primitive subregions, holding `<feImage>` maps feeding `<feDisplacementMap>`.
 *   3. The host applies `backdrop-filter: <blur …> url(#id)` to the element.
 *
 * Costs to keep in mind: the SDF loop is one iteration per pixel of
 * `(w + 2*FILTER_PAD) x (h + 2*FILTER_PAD)` per branch, and `canvas.toDataURL('image/png')`
 * runs synchronously per map. Maps are memoised on rounded geometry (`MAP_LIMIT = 32`, FIFO),
 * so two elements of the same size share one bitmap.
 *
 * Chromium only. `url()` inside `backdrop-filter` is a Blink extension: Safari and Firefox
 * parse the declaration and then paint nothing for it, which is why the host writes the plain
 * blur on its own for non-Chromium engines instead of appending `url()` to it.
 *
 * ## Gates measured on a plain page (headless Chromium, control = `scale 0` vs `scale 60`)
 *
 * - Refraction reaches the screen. Two screenshots differing only in `refractionAmount` differ
 *   in 11 898 px, all inside the element box, and the difference is *entirely* inside `inset <= 19`
 *   (`refractionHeight` 22 minus the circular falloff's tail): 0 px differ deeper than 20 px in,
 *   0 px outside the box. So the filter is honoured and the bend really is rim-only.
 * - 448x308 map for a 320x180 card: 17 328 rim px of 137 984 total, max deviation 111/127,
 *   ~23 KB per `data:` URL.
 * - **`img-src` is a real gate.** With `<meta http-equiv="Content-Security-Policy"
 *   content="img-src 'none'">` each `<feImage>` map is refused (a `securitypolicyviolation` with
 *   `violatedDirective: "img-src"` fires per map), and toggling `refractionAmount` 0 -> 30 changes
 *   **zero** pixels. Measured against a blur-only control on the same page, the refused graph is
 *   **pixel-identical to plain frosted glass** (0 px of 57 600) — Chromium drops the unloadable
 *   reference and keeps the earlier functions in the list, so nothing is *broken*; just the lens
 *   is missing, and the SDF + PNG work is wasted. The failure is silent: no console error.
 *   `probeMapSupport()` below exists precisely because of this — it detects the refusal, stops
 *   paying for maps that cannot load, and warns once with the reason.
 */
/*
 * Two semicolons in this file are load-bearing, and neither shows up in a test of this file alone.
 *
 * The script is meant to be *concatenated*, not merely installed: `@require` splices it into
 * whatever the manager's wrapper already holds, and userscripts in the wild are routinely pasted
 * after other code. A statement that begins with `(` is exactly the token ASI will not separate
 * from a previous line — `someCall()` directly above would parse as
 * `someCall()(function () { ... })()`, calling the return value. The mirror image applies at the
 * other end: an unterminated `})()` swallows a following statement that starts with `(`.
 *
 * So the IIFE opens with `;` and the file closes with `;)`. If you moved either one, put it back.
 */
;(function () {
  'use strict'

  /* ==========================================================================================
   * 0. Load guard — including this file twice must not double every listener
   * ========================================================================================== */

  /** Where the API is published: the page window, plus `unsafeWindow` when sandboxed. */
  const PAGE =
    typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window

  /**
   * Must match the `@version` metadata line. CI rewrites **both** on every deploy (see
   * `.github/workflows/deploy.yml`), so the value a page sees always equals the version
   * Tampermonkey compares when it re-fetches `@updateURL`.
   */
  const VERSION = '0.2.0'

  // The guard must key off something this file is guaranteed to define — an API object without
  // a version would let a second include (a `@require` plus an install, say) overwrite the
  // global and orphan the first instance's registry.
  if (PAGE.LiquidGlassRefract && PAGE.LiquidGlassRefract.version) return

  /** Assign before this file runs to configure it. See the banner. */
  const CONFIG = Object.assign(
    {
      selectors: [],
      autoWatch: false,
      hotkeys: { glassify: 'alt+shift+g', unglassify: 'alt+shift+u' },
      defaults: {}
    },
    // `PAGE` first: a page script or an `@grant none` importer writes to the real window. The
    // second read covers a sandboxed importer that set the config on its own sandboxed `window`.
    PAGE.LiquidGlassRefractConfig || window.LiquidGlassRefractConfig || {}
  )

  /* ==========================================================================================
   * 1. The extracted core — `src/core/glass-filter.ts`, types stripped, verbatim otherwise
   * ========================================================================================== */

/**
 * SVG refraction filter for `backdrop-filter: url(#id)`.
 *
 * ## Why an SVG filter at all
 *
 * `backdrop-filter` samples whatever is painted *behind* the element, so the glass never
 * needs a copy of the wallpaper — the browser does the capture. Blur, saturation and
 * brightness map 1:1 onto CSS filter functions. Refraction does not: CSS has no
 * "shift every pixel by a vector field" primitive, so that one effect goes through an SVG
 * filter. `feDisplacementMap` reads a map where R = dx and G = dy (128 = no offset — the exact
 * zero point is 127.5; see the note at the neutral fill in `buildMap`) and shifts each pixel by
 * it.
 *
 * The map itself is generated on a canvas from the rounded-rect signed distance field —
 * the same construction as the AGSL `RoundedRectRefractionShaderString` the Android build
 * runs on API 33+, minus the SDF texture lookup.
 *
 * ## Chromatic aberration
 *
 * The AGSL dispersion shader (`RoundedRectRefractionWithDispersionShaderString`) samples
 * the backdrop 7 times along the refraction offset with spectral weights. `feDisplacementMap`
 * displaces every channel by the *same* vector, so the port bakes the spectral split into
 * three displacement maps — red `base·(1+i)`, green `base`, blue `base·(1−i)` where
 * `i = cx·cy/(hw·hh)` is the shader's `dispersionIntensity` (zero on the axes, strongest in
 * two opposite quadrants) — displaces a channel-isolated copy of the backdrop with each, and
 * re-adds the branches with `feComposite arithmetic`. Three taps instead of seven: the
 * cross-channel bleed of the middle spectral bands is dropped, which at a few px of
 * dispersion is visually indistinguishable, and white is conserved either way.
 *
 * The `chromaticAberration` uniform is a *boolean* upstream (`Lens.kt` passes a constant
 * `1f`), so the dispersion field depends only on geometry and bakes into the maps; the
 * animation knob stays `refractionAmount`, which every branch is linear in.
 *
 * ## SDF text (`SdfShader`)
 *
 * `LockScreenContent` refracts a *baked* field rather than a rounded rect. `clock_sdf` is a
 * 1599×515 texture whose channels are a signed distance, its unit normal and a coverage mask, and
 * the Android build hands it to a runtime shader. Nothing about the map format changes here — the
 * only difference is where the distance and its normal come from. `buildSdfMap` is `buildMap` with
 * a different field source and the same encoder, the same cache, the same `scale` knob.
 *
 * Two things the shader does that `feDisplacementMap` cannot, and what stands in for each:
 *
 *  - `content.eval(refractedCoord) * v.a` masks the result by the shape's coverage. The lens
 *    element already carries a `mask-image` for the `AlphaMask` shader, and this texture's alpha
 *    channel *is* a coverage mask, so the same mechanism takes it (`GlassSurface`).
 *  - the bevel tail is two `color *= 1 + k` applications. Both collapse into one multiplier
 *    `1 + α`, baked to an image and applied with `feComposite arithmetic k1 = k3 = 1` — see
 *    `buildBevelMap`.
 *
 * Decoding is not here: this module takes texels, never a URL, so it stays evaluable outside a
 * browser and liftable into the userscript unchanged.
 *
 * ## Chromium-only
 *
 * `url()` inside `backdrop-filter` is a Chromium extension (Chrome / Edge 76+). Safari and
 * Firefox accept the declaration but paint nothing for it, so call sites must always keep a
 * plain `blur()` declaration in an *earlier* rule — see `GlassSurface.vue`. Everything else
 * the glass needs is plain CSS and works everywhere.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';
/**
 * Room added around the element box. Displaced pixels sample outside the border box, and the
 * filter region clips anything it doesn't cover, so the region has to be larger than the
 * largest displacement we ever ask for (`max refractionAmount` in the catalog is 48 px).
 */
const FILTER_PAD = 64;
let root = null;
let sequence = 0;
function svgRoot() {
    if (!root) {
        root = document.createElementNS(SVG_NS, 'svg');
        root.setAttribute('width', '0');
        root.setAttribute('height', '0');
        root.setAttribute('aria-hidden', 'true');
        root.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
        // The one line of the extracted core that is not verbatim: `@require` scripts run before
        // `<body>` exists, so fall back to the document element instead of throwing.
        (document.body || document.documentElement).appendChild(root);
    }
    return root;
}
/* ------------------------------------------------------------------------------------------- */
/* Capability probe                                                                              */
/* ------------------------------------------------------------------------------------------- */
/**
 * `@supports (backdrop-filter: url(#x))` is not reliable: engines that parse `url()` but paint
 * nothing for it (WebKit) still report support. Feature-detecting it properly needs a paint
 * comparison, so the cheap and honest test is the engine itself — every Chromium build since
 * 76 implements it, and no other engine does.
 *
 * Memoised: `BackdropEffectScope.lens()` calls this once per frame per surface, and the answer
 * is a property of the engine, not of the call. Reading `navigator.userAgentData.brands` every
 * time showed up in the CPU profile of a plain scroll.
 */
let refractionSupported = null;
function isRefractionSupported() {
    if (refractionSupported !== null)
        return refractionSupported;
    refractionSupported = detectRefractionSupport();
    return refractionSupported;
}
function detectRefractionSupport() {
    if (typeof navigator === 'undefined')
        return false;
    const brands = navigator
        .userAgentData?.brands;
    if (brands && brands.length > 0) {
        return brands.some((b) => /chromium|google chrome|microsoft edge|brave|opera/i.test(b.brand));
    }
    return /\b(Chrome|Chromium|Edg|OPR)\//.test(navigator.userAgent);
}
const mapCache = new Map();
/**
 * Entries are keyed by `(round(width) × round(height), corner radii, round(refractionHeight),
 * flags, branch)`, and a single animated call site walks several `refractionHeight` values — a
 * Toggle press with chromatic aberration alone can want 6 geometries × 3 branches = 18 entries.
 * At 32 the cache evicted its own working set mid-gesture, so every press re-ran the whole
 * build + PNG encode instead of hitting. Raising the limit is pure caching: nothing about the
 * rendered result changes, only whether a rebuild happens. Entries are a few tens of kB each.
 */
const MAP_LIMIT = 96;
/**
 * Neutral grey = "leave this pixel alone", as one 32-bit word instead of four byte writes per
 * pixel: the padded region is neutral everywhere except the thin rim band, so the whole bitmap
 * is a single `fill()` and only the band is ever overwritten. `image.data` is RGBA byte order, so
 * on a little-endian host byte 0 (R, the low byte) is 0x80 → 0xFF808080. Endianness is read once
 * rather than assumed.
 */
const NEUTRAL_WORD = (() => {
    const probe = new Uint8Array(4);
    new Uint32Array(probe.buffer)[0] = 0x01020304;
    return probe[0] === 0x04 ? 0xff808080 : 0x808080ff;
})();
/**
 * Opaque black, for the bevel map's "no brightening" fill. Alpha must be 1 rather than 0:
 * `feComposite` composites premultiplied values, and a transparent pixel would make the whole
 * `map × color` term vanish instead of evaluating to zero. Endianness read the same way.
 */
const OPAQUE_BLACK_WORD = (() => {
    const probe = new Uint8Array(4);
    new Uint32Array(probe.buffer)[0] = 0x01020304;
    return probe[0] === 0x04 ? 0xff000000 : 0x000000ff;
})();
function mapKey(spec, branch) {
    // The SDF field is baked into the texture, so neither `refractionHeight` (a scale) nor
    // `lightAngle` (bevel only) can change it — only the box and the texture can. Keeping the
    // rounded-rect key shape here would rebuild the bitmap on every step of an animation that
    // is supposed to be a pure `scale` write.
    if (spec.sdf) {
        return `sdf|${Math.round(spec.width)}x${Math.round(spec.height)}|${spec.sdf.key}|${branch}`;
    }
    const r = spec.cornerRadii.map((v) => Math.round(v * 2) / 2).join(',');
    const flags = `${spec.depthEffect ? 1 : 0}${spec.chromaticAberration ? 1 : 0}`;
    return `${Math.round(spec.width)}x${Math.round(spec.height)}|${r}|${Math.round(spec.refractionHeight)}|${flags}|${branch}`;
}
/**
 * Rounded-rect SDF, negative inside. Exact while all four radii are equal, which is every
 * shape the catalog uses (a single radius, or `Capsule()`); with mixed radii it degrades to
 * a per-quadrant approximation.
 */
function sdf(x, y, w, h, tl, tr, br, bl) {
    const cx = w / 2;
    const cy = h / 2;
    const left = x < cx;
    const top = y < cy;
    const r = top ? (left ? tl : tr) : left ? bl : br;
    const qx = Math.abs(x - cx) - (cx - r);
    const qy = Math.abs(y - cy) - (cy - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
/**
 * SDF used for the *gradient*, mirroring the shader: the corner radius there is
 * `min(radius * 1.5, min(halfSize))`. For a Capsule the two coincide; for a small radius on a
 * tall box they do not, and the bend fans out.
 */
function gradSdf(x, y, w, h, tl, tr, br, bl) {
    const cx = w / 2;
    const cy = h / 2;
    const left = x < cx;
    const top = y < cy;
    const r = Math.min((top ? (left ? tl : tr) : left ? bl : br) * 1.5, Math.min(cx, cy));
    const qx = Math.abs(x - cx) - (cx - r);
    const qy = Math.abs(y - cy) - (cy - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function clampByte(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}
/**
 * One reusable canvas for every map build.
 *
 * The builds used to allocate a fresh `<canvas>` each time and then encode it with
 * `toDataURL('image/png')` — a synchronous PNG encode on the main thread. Measured on a 168×152
 * bitmap (the Toggle thumb's map): ~1 ms on a warm canvas, ~7 ms on a freshly allocated one, and a
 * single press builds 18 maps, so the allocation was costing more than the encode.
 *
 * Nothing about the bitmap changes: every build fills the whole `ImageData`, `putImageData`
 * overwrites all of it (a resize clears the backing store anyway), and what reaches the filter is
 * the data URL, not the canvas element.
 */
let mapScratch = null;
/**
 * Returns the element, not the context: `ctx.canvas` is a back-reference a test double is not
 * obliged to model, and `scripts/refraction-probe.mjs` evaluates this file in Node against a stub
 * whose `getContext()` returns only `createImageData` / `putImageData`. Reaching for the element
 * we already hold keeps the core runnable outside a browser.
 */
function mapCanvas(width, height) {
    if (!mapScratch)
        mapScratch = document.createElement('canvas');
    if (mapScratch.width !== width || mapScratch.height !== height) {
        mapScratch.width = width;
        mapScratch.height = height;
    }
    return mapScratch;
}
/**
 * One displacement-map bitmap. `branch` selects the spectral copy: `+1` red (`base·(1+i)`),
 * `0` green (`base`), `-1` blue (`base·(1−i)`). Encoded magnitudes are normalised to the
 * branch's own maximum so the 8-bit channel never clips (red/blue reach `2·base` at a sharp
 * corner); the lost factor is restored exactly by a per-branch `scale`.
 */
function buildMap(spec, branch) {
    const w = Math.max(1, Math.round(spec.width));
    const h = Math.max(1, Math.round(spec.height));
    const cw = w + FILTER_PAD * 2;
    const ch = h + FILTER_PAD * 2;
    const canvas = mapCanvas(cw, ch);
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return { url: '', vmax: 1 };
    const image = ctx.createImageData(cw, ch);
    const data = image.data;
    const [tl, tr, br, bl] = spec.cornerRadii;
    const bezel = Math.max(0.5, spec.refractionHeight);
    const depth = spec.depthEffect ? 1 : 0;
    const hw = w / 2;
    const hh = h / 2;
    const at = (x, y) => sdf(x, y, w, h, tl, tr, br, bl);
    const gradAt = (x, y) => gradSdf(x, y, w, h, tl, tr, br, bl);
    /** Rim pixels, collected in pass 1 and encoded in pass 2 once `vmax` is known. */
    const rim = [];
    let vmax = 0;
    // Neutral grey = "leave this pixel alone".
    //
    // The exact zero point is 127.5, not 128: `feDisplacementMap` reads the channel as
    // value/255 minus 0.5, so a uniform 128 leaves a constant +0.5 LSB on the whole map
    // (= +scale/510 px of sampling offset toward +x/+y, which reads as the lens drifting
    // up-left). It is left uncorrected on purpose.
    //
    // Measured against a linear-gradient backdrop (24 000 px averaged, ~0.02 px resolution),
    // what reaches the screen is a whole-pixel staircase, not a drift that grows with the
    // amount: 0 px up to scale 252, 1 px from 255 to 764, 2 px from 765 — and screenshots on
    // one plateau are byte-identical. A 1 px checkerboard backdrop keeps its full contrast at
    // every scale, so the offset is quantised to whole pixels with nearest-neighbour sampling
    // (Skia's raster path truncates: `srcX = x + SkScalarTruncToInt(displX)`); residue of this
    // size cannot survive. Dithering the neutral between 127 and 128 cancels the mean only
    // above scale 510 and converts an invisible whole-pixel offset into per-pixel ±1 px
    // sampling jitter — noise inside the region that is supposed to be an exact identity.
    new Uint32Array(data.buffer).fill(NEUTRAL_WORD);
    /**
     * Only the rim band is ever non-neutral, and evaluating the SDF is the expensive half of the
     * build (one `Math.hypot` per pixel, plus four more per rim pixel for the gradient). So the scan
     * walks only the rows and columns that can hold a rim pixel; the `fill()` above covers the rest.
     *
     * The bound comes from `sdf` itself. Writing `p = max(qy, 0)` and `q = max(qx, 0)`, it returns
     * `hypot(q, p) + min(max(qx,qy), 0) - r`, so a rim pixel (`-bezel <= d <= 0`) must satisfy
     * `r - bezel <= hypot(q, p) <= r`. Two consequences, and only these two are used:
     *
     *  - `p > r` → `d > 0`: the whole row is outside, and rows past the band are skipped outright
     *    (this is where most of the padding margin is discarded);
     *  - `p >= r - bezel` → the `q = 0` half satisfies the ring on its own, so the entire side is
     *    in play (`d` still lands wherever the SDF says, and the rim test below filters it);
     *  - otherwise the ring restricts `q` to `[sqrt((r-bezel)² - p²), sqrt(r² - p²)]`, i.e. a band
     *    `r - q` wide at each cap. When `p <= 0` that collapses to `x <= bezel`, the plain
     *    left/right cap.
     *
     * This is a **superset** of the rim: anything admitted here but rejected by the SDF is still
     * dropped by the same `d > 0 || d < -bezel` test, so the bitmap is bit-identical. The padded
     * margin is covered too — every pixel outside `[0, w] × [0, h]` has `p > r`, so the bound
     * excludes it and it keeps its neutral word.
     *
     * `centerX` is `w / 2`, so the side split has to be integral: `sdf` branches on `x < cx`, which
     * for integer `x` means `x <= ceil(cx) - 1` on the left.
     */
    const centerX = hw;
    const centerY = hh;
    const splitX = Math.ceil(centerX);
    for (let j = 0; j < ch; j++) {
        const y = j - FILTER_PAD;
        const top = y < centerY;
        const rowBase = j * cw;
        for (let side = 0; side < 2; side++) {
            const onLeft = side === 0;
            // Mirrors `sdf`'s own per-quadrant radius choice, so the bound uses the same `r` it does.
            const r = onLeft ? (top ? tl : bl) : top ? tr : br;
            const p = Math.abs(y - centerY) - (centerY - r);
            if (p > r)
                continue;
            let from;
            let to;
            if (p >= r - bezel) {
                from = onLeft ? 0 : splitX;
                // `w + 1`, not `w`: at `x = w` the SDF is exactly `0`, which is still inside the rim test
                // (`d > 0` is what excludes), so the last column of the box belongs to the band. `x = -1`
                // needs no such care — there `d > 0` and the rim test drops it anyway.
                to = onLeft ? splitX : w + 1;
            }
            else if (p <= 0) {
                // `q >= r - bezel` with `q = r - x` on the left → `x <= bezel`, and symmetrically.
                const edge = Math.floor(bezel) + 1;
                if (onLeft) {
                    from = 0;
                    to = Math.min(splitX, edge);
                }
                else {
                    from = Math.max(splitX, w - edge);
                    to = w + 1;
                }
            }
            else {
                const inner = (r - bezel) * (r - bezel) - p * p;
                const lo = inner > 0 ? Math.sqrt(inner) : 0;
                const hi = Math.sqrt(Math.max(0, r * r - p * p));
                if (onLeft) {
                    from = Math.max(0, Math.floor(r - hi));
                    to = Math.min(splitX, Math.floor(r - lo) + 1);
                }
                else {
                    from = Math.max(splitX, Math.ceil(w - r + lo));
                    to = Math.min(w + 1, Math.floor(w - r + hi) + 1);
                }
            }
            for (let x = from; x < to; x++) {
                const index = (rowBase + x + FILTER_PAD) * 4;
                const d = at(x, y);
                // Only the rim bends: drop everything outside the shape and everything deeper than
                // `bezel`, which skips the gradient work for the (large) flat centre.
                if (d > 0 || d < -bezel)
                    continue;
                // `circleMap` — the shader's `1 - sqrt(1 - x * x)`, a circular sagitta. It rises steeply
                // only as `x` leaves 0, so the bend stays in a thin band against the rim instead of
                // spreading across the whole bezel the way a smoothstep would.
                const t = Math.min(1, Math.max(0, 1 + d / bezel));
                const falloff = 1 - Math.sqrt(Math.max(0, 1 - t * t));
                let gx = gradAt(x + 1, y) - gradAt(x - 1, y);
                let gy = gradAt(x, y + 1) - gradAt(x, y - 1);
                let length = Math.hypot(gx, gy);
                if (length > 0) {
                    gx /= length;
                    gy /= length;
                }
                if (depth !== 0) {
                    // `grad + depthEffect * normalize(centeredCoord)`, renormalised — the analytic
                    // `gradSdRoundedRect` gradient is unit length, and so is this finite-difference one.
                    const cx = x - hw;
                    const cy = y - hh;
                    const centreLength = Math.hypot(cx, cy);
                    if (centreLength > 0) {
                        gx += cx / centreLength;
                        gy += cy / centreLength;
                        length = Math.hypot(gx, gy);
                        if (length > 0) {
                            gx /= length;
                            gy /= length;
                        }
                    }
                }
                // The shader's `dispersionIntensity` — `chromaticAberration` is baked as the constant 1.
                const dispersion = ((x - hw) * (y - hh)) / (hw * hh);
                const m = falloff * (1 + branch * dispersion);
                if (m > vmax)
                    vmax = m;
                rim.push({ index, gx, gy, m });
            }
        }
    }
    const k = vmax > 0 ? 127 / vmax : 0;
    for (const pixel of rim) {
        if (pixel.m <= 0)
            continue;
        const s = pixel.m * k;
        // ⚠️ Inward. `lens()` passes `refractionAmount` with a *negated* sign and `gradient`
        // points outward, so in the shader `refractedCoord = coord + d * grad` lands farther
        // *inside* the shape: the rim shows content from deeper within, which is what squeezes
        // the backdrop at the edge. Sampling outward instead drags the surrounding wallpaper in
        // — a bright blue wedge appears wherever the backdrop just outside the rim is a
        // different colour than the backdrop under it.
        data[pixel.index] = clampByte(128 - pixel.gx * s);
        data[pixel.index + 1] = clampByte(128 - pixel.gy * s);
    }
    ctx.putImageData(image, 0, 0);
    return { url: canvas.toDataURL('image/png'), vmax: vmax > 0 ? vmax : 1 };
}
/** Displacement map for `spec` and spectral `branch`, memoised — identical shapes share one bitmap. */
function refractionMap(spec, branch) {
    const key = mapKey(spec, branch);
    const hit = mapCache.get(key);
    if (hit !== undefined)
        return hit;
    const entry = spec.sdf ? buildSdfMap(spec, branch) : buildMap(spec, branch);
    if (mapCache.size >= MAP_LIMIT) {
        const oldest = mapCache.keys().next().value;
        if (oldest !== undefined)
            mapCache.delete(oldest);
    }
    if (entry.url)
        mapCache.set(key, entry);
    return entry;
}
/* ------------------------------------------------------------------------------------------- */
/* SDF texture field                                                                             */
/* ------------------------------------------------------------------------------------------- */
/**
 * Normal of the last {@link sdfIntensity} call. Sibling out-params rather than a tuple: this runs
 * once per texel of every map build and allocating a result object there is the one thing in the
 * loop that is not arithmetic.
 */
let sdfNx = 0;
let sdfNy = 0;
/**
 * One tap of a baked SDF texture, decoded exactly as `SdfShaderString` decodes it, with the
 * bilinear filtering the GPU would have done (`sdfTex.eval` samples texel centres, so the four
 * neighbours sit around `p − 0.5`; the border clamps rather than repeating, matching the
 * shader's own bounds check).
 *
 * Returns the shader's `intensity`, and `0` for every texel it discards with
 * `if (v.a <= 0.0) return half4(0.0)` — outside the shape there is nothing to bend and, for the
 * bevel map, nothing to light. The normal comes back through {@link sdfNx} / {@link sdfNy}.
 *
 * The `<< 2` and `/ 255` are the shader's `* 2.0 − 1.0` remap; `a < 255` is its
 * `if (v.a < 1.0) sd = 0.0`, which is what puts the *maximum* bend on the anti-aliased boundary
 * rather than a vanishing one.
 */
function sdfIntensity(sdf, tx, ty) {
    const x0 = Math.floor(tx);
    const y0 = Math.floor(ty);
    const fx = tx - x0;
    const fy = ty - y0;
    const lastX = sdf.width - 1;
    const lastY = sdf.height - 1;
    const ax = x0 < 0 ? 0 : x0 > lastX ? lastX : x0;
    const bx = x0 + 1 < 0 ? 0 : x0 + 1 > lastX ? lastX : x0 + 1;
    const ay = y0 < 0 ? 0 : y0 > lastY ? lastY : y0;
    const by = y0 + 1 < 0 ? 0 : y0 + 1 > lastY ? lastY : y0 + 1;
    const src = sdf.data;
    const rowA = ay * sdf.width;
    const rowB = by * sdf.width;
    const i00 = (rowA + ax) << 2;
    const i10 = (rowA + bx) << 2;
    const i01 = (rowB + ax) << 2;
    const i11 = (rowB + bx) << 2;
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    const a = src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11;
    // `smoothstep(0.5, 1.0, v.a)` is zero at or below half coverage, and `if (v.a < 1.0) sd = 0.0`
    // makes the partial band the *strongest* bend — so outside the shape stop here, and inside the
    // ramp take `sd = 0` (intensity 1) rather than interpolating a distance that is not meaningful
    // at a sub-texel edge.
    if (a <= 127.5)
        return 0;
    const r = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
    const g = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
    const b = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
    const sd = a < 254.5 ? 0 : (r / 255) * 2 - 1;
    let nx = (g / 255) * 2 - 1;
    let ny = (b / 255) * 2 - 1;
    const length = Math.hypot(nx, ny);
    if (length > 0) {
        nx /= length;
        ny /= length;
    }
    else {
        nx = 0;
        ny = 0;
    }
    sdfNx = nx;
    sdfNy = ny;
    // `circleMap(1.0 - min(1.0, -sd * 1.5))` — the band is the *inside* of the shape within
    // `1/1.5 = 2/3` of the distance range, which is the same rim-band-on-the-inside shape the
    // rounded-rect map produces from its own `bezel`.
    const t = 1 - Math.min(1, Math.max(0, -sd * 1.5));
    return 1 - Math.sqrt(Math.max(0, 1 - t * t));
}
/**
 * The displacement map for a baked SDF texture — same bitmap format, same encoder, different
 * source for the signed distance than {@link buildMap}.
 *
 * The scan is the straight one, unlike `buildMap`'s rim-band bound: the shape is whatever the
 * texture says it is, so there is no axis-aligned band to derive from an SDF. What makes it cheap
 * anyway is that the padded margin is skipped outright (`x < 0 || x >= w` needs no tap at all) and
 * that the field is only non-neutral where `intensity > 0` — a thin band inside the glyph edges.
 * The whole build is memoised on `(box, texture)`, and for a clock face neither ever changes.
 */
function buildSdfMap(spec, branch) {
    const sdf = spec.sdf;
    const w = Math.max(1, Math.round(spec.width));
    const h = Math.max(1, Math.round(spec.height));
    const cw = w + FILTER_PAD * 2;
    const ch = h + FILTER_PAD * 2;
    const canvas = mapCanvas(cw, ch);
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return { url: '', vmax: 1 };
    const image = ctx.createImageData(cw, ch);
    const data = image.data;
    new Uint32Array(data.buffer).fill(NEUTRAL_WORD);
    const hw = w / 2;
    const hh = h / 2;
    const texW = sdf.width;
    const texH = sdf.height;
    /** Non-neutral texels, encoded in pass 2 once `vmax` is known — same two-pass shape as `buildMap`. */
    const rim = [];
    let vmax = 0;
    for (let j = 0; j < ch; j++) {
        const y = j - FILTER_PAD;
        if (y < 0 || y >= h)
            continue;
        // `p = coord / size * sdfTexSize` with `coord` a pixel *centre*, then down to the texel-centre
        // convention `eval` uses.
        const ty = ((y + 0.5) / h) * texH - 0.5;
        const rowBase = j * cw;
        for (let i = 0; i < cw; i++) {
            const x = i - FILTER_PAD;
            if (x < 0 || x >= w)
                continue;
            const tx = ((x + 0.5) / w) * texW - 0.5;
            const intensity = sdfIntensity(sdf, tx, ty);
            if (intensity <= 0)
                continue;
            // `dispersionIntensity` — same element-space field as the rounded-rect map, so a
            // chromatic-aberration call site behaves identically on this path. The catalog's clock
            // does not ask for it, but the branch is carried rather than ignored.
            const dispersion = ((x - hw) * (y - hh)) / (hw * hh);
            const m = intensity * (1 + branch * dispersion);
            if (m > vmax)
                vmax = m;
            rim.push({ index: (rowBase + i) * 4, gx: sdfNx, gy: sdfNy, m });
        }
    }
    const k = vmax > 0 ? 127 / vmax : 0;
    for (const pixel of rim) {
        if (pixel.m <= 0)
            continue;
        const s = pixel.m * k;
        // Same `128 − g·s` encoder as `buildMap`, so the same "inward" sense reaches the filter:
        // the shader's `coord − intensity · refractionHeight · normal` moves the sample *into* the
        // shape along the outward normal, which is the negative of it.
        data[pixel.index] = clampByte(128 - pixel.gx * s);
        data[pixel.index + 1] = clampByte(128 - pixel.gy * s);
    }
    ctx.putImageData(image, 0, 0);
    return { url: canvas.toDataURL('image/png'), vmax: vmax > 0 ? vmax : 1 };
}
/**
 * The bevel light, baked into a single **multiplier** image.
 *
 * The shader's tail is
 *
 * ```
 * color.rgb *= 1 + 0.5·intensity·clamp(dot(normal,  lightDir), 0, 1);
 * color.rgb *= 1 + 0.5·clamp(dot(normal, -lightDir), 0, 1)·min(1, smoothstep(1, 0, |intensity−0.25|·6));
 * ```
 *
 * which is two multiplications and therefore two `color × (1 + k)` applications. Both collapse
 * into one factor `1 + α`, and then into a single `feComposite arithmetic` with `k1 = k3 = 1`:
 *
 * ```
 * k1·map·color + k3·color = color·(1 + α)
 * ```
 *
 * That is the whole reason this is expressible without `feBlend`-ing two images and without ever
 * having a copy of the backdrop. `α = 0.5·intensity·front + 0.5·back·band` never exceeds `0.5`
 * (the two `clamp`s are the positive and negative parts of one dot product, so they cannot both
 * be non-zero), which is what keeps the 8-bit encoding from clipping.
 *
 * `intensity` and the normal come from the texture alone, so this depends on the box, the texture
 * and the light angle — not on `refractionHeight`, which only scales the bend.
 */
function buildBevelMap(spec) {
    const sdf = spec.sdf;
    const angle = (((spec.sdfLightAngle ?? 45) * Math.PI) / 180) % (Math.PI * 2);
    const lx = Math.cos(angle);
    const ly = Math.sin(angle);
    const w = Math.max(1, Math.round(spec.width));
    const h = Math.max(1, Math.round(spec.height));
    const cw = w + FILTER_PAD * 2;
    const ch = h + FILTER_PAD * 2;
    const canvas = mapCanvas(cw, ch);
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return { url: '', vmax: 1 };
    const image = ctx.createImageData(cw, ch);
    const data = image.data;
    // Opaque black = "no brightening". The alpha has to stay 1: `feComposite` works on
    // premultiplied values, and a transparent map would contribute nothing at all rather than a
    // zero multiplier — the two are the same here, but only by accident of `k3 = 1`.
    new Uint32Array(data.buffer).fill(OPAQUE_BLACK_WORD);
    const texW = sdf.width;
    const texH = sdf.height;
    for (let j = 0; j < ch; j++) {
        const y = j - FILTER_PAD;
        if (y < 0 || y >= h)
            continue;
        const ty = ((y + 0.5) / h) * texH - 0.5;
        const rowBase = j * cw;
        for (let i = 0; i < cw; i++) {
            const x = i - FILTER_PAD;
            if (x < 0 || x >= w)
                continue;
            const intensity = sdfIntensity(sdf, ((x + 0.5) / w) * texW - 0.5, ty);
            if (intensity <= 0)
                continue;
            const dot = sdfNx * lx + sdfNy * ly;
            const front = dot > 0 ? (dot > 1 ? 1 : dot) : 0;
            const back = dot < 0 ? (dot < -1 ? 1 : -dot) : 0;
            // `smoothstep(1, 0, |intensity − 0.25|·6)` — reversed edges, so it is 1 at
            // `intensity = 0.25` and falls to 0 by `0.417`.
            const t = Math.max(0, Math.min(1, 1 - Math.abs(intensity - 0.25) * 6));
            const band = Math.min(1, t * t * (3 - 2 * t));
            const alpha = 0.5 * intensity * front + 0.5 * back * band;
            if (alpha <= 0)
                continue;
            const index = (rowBase + i) * 4;
            const value = clampByte(alpha * 255);
            data[index] = value;
            data[index + 1] = value;
            data[index + 2] = value;
        }
    }
    ctx.putImageData(image, 0, 0);
    return { url: canvas.toDataURL('image/png'), vmax: 1 };
}
/** Memoised on `(box, texture, light angle)` — the light angle is the only free parameter. */
function bevelMap(spec) {
    if (!spec.sdf)
        return { url: '', vmax: 1 };
    const key = `bevel|${Math.round(spec.width)}x${Math.round(spec.height)}|${spec.sdf.key}|${spec.sdfLightAngle ?? 45}`;
    const hit = mapCache.get(key);
    if (hit !== undefined)
        return hit;
    const entry = buildBevelMap(spec);
    if (mapCache.size >= MAP_LIMIT) {
        const oldest = mapCache.keys().next().value;
        if (oldest !== undefined)
            mapCache.delete(oldest);
    }
    if (entry.url)
        mapCache.set(key, entry);
    return entry;
}
/**
 * The magnification displacement map: `d(p) = c + (p − c)/k − p` about the element centre,
 * neutral outside the box. Linear, so `vmax` is the largest corner magnitude; the
 * `feDisplacementMap` runs at a *fixed* `scale = 2·vmax` (the zoom does not participate in
 * the refraction's animation).
 */
function buildZoomMap(width, height, zoom) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const cw = w + FILTER_PAD * 2;
    const ch = h + FILTER_PAD * 2;
    const canvas = mapCanvas(cw, ch);
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return { url: '', vmax: 1 };
    const image = ctx.createImageData(cw, ch);
    const data = image.data;
    const k = zoom.factor;
    const cx = w / 2;
    const cy = h / 2;
    // Corner magnitudes of the linear field, the largest of which sets the encoding range.
    let vmax = 0;
    for (const [x, y] of [
        [0, 0],
        [w, 0],
        [0, h],
        [w, h]
    ]) {
        const magnitude = Math.hypot(cx + (x - cx) / k - x, cy + (y - cy) / k - y);
        if (magnitude > vmax)
            vmax = magnitude;
    }
    const s = vmax > 0 ? 127 / vmax : 0;
    // Neutral grey — same 127.5-vs-128 zero point as `buildMap`, same deliberate choice, and the
    // same single-word fill: the field is only non-neutral inside the element box.
    new Uint32Array(data.buffer).fill(NEUTRAL_WORD);
    for (let y = 0; y < h; y++) {
        const rowBase = (y + FILTER_PAD) * cw + FILTER_PAD;
        const dy = cy + (y - cy) / k - y;
        for (let x = 0; x < w; x++) {
            const index = (rowBase + x) * 4;
            data[index] = clampByte(128 + (cx + (x - cx) / k - x) * s);
            data[index + 1] = clampByte(128 + dy * s);
        }
    }
    ctx.putImageData(image, 0, 0);
    return { url: canvas.toDataURL('image/png'), vmax: vmax > 0 ? vmax : 1 };
}
function zoomMap(width, height, zoom) {
    const key = `z|${Math.round(width)}x${Math.round(height)}|${zoom.factor}`;
    const hit = mapCache.get(key);
    if (hit !== undefined)
        return hit;
    const entry = buildZoomMap(width, height, zoom);
    if (mapCache.size >= MAP_LIMIT) {
        const oldest = mapCache.keys().next().value;
        if (oldest !== undefined)
            mapCache.delete(oldest);
    }
    if (entry.url)
        mapCache.set(key, entry);
    return entry;
}
function feImageElement(result) {
    const el = document.createElementNS(SVG_NS, 'feImage');
    el.setAttribute('result', result);
    el.setAttribute('preserveAspectRatio', 'none');
    return el;
}
function feDisplacementElement(input, map, result) {
    const el = document.createElementNS(SVG_NS, 'feDisplacementMap');
    el.setAttribute('in', input);
    el.setAttribute('in2', map);
    el.setAttribute('xChannelSelector', 'R');
    el.setAttribute('yChannelSelector', 'G');
    el.setAttribute('scale', '0');
    if (result)
        el.setAttribute('result', result);
    return el;
}
/** Keeps one channel (and the alpha) of its input — the branch splitter of the CA graph. */
function feChannelElement(input, channel, result) {
    const el = document.createElementNS(SVG_NS, 'feColorMatrix');
    el.setAttribute('in', input);
    el.setAttribute('type', 'matrix');
    const row = channel === 'r' ? '1 0 0 0 0' : channel === 'g' ? '0 1 0 0 0' : '0 0 1 0 0';
    const zero = '0 0 0 0 0';
    const r = channel === 'r' ? row : zero;
    const g = channel === 'g' ? row : zero;
    const b = channel === 'b' ? row : zero;
    // Alpha passes through: the backdrop behind the glass is opaque, so the re-addition's
    // alpha clamp at 1 reproduces the source alpha exactly.
    el.setAttribute('values', `${r}  ${g}  ${b}  0 0 0 1 0`);
    el.setAttribute('result', result);
    return el;
}
/** `feComposite arithmetic` with `k2 = k3 = 1` — adds two premultiplied images. */
function feAddElement(a, b, result) {
    const el = document.createElementNS(SVG_NS, 'feComposite');
    el.setAttribute('in', a);
    el.setAttribute('in2', b);
    el.setAttribute('operator', 'arithmetic');
    el.setAttribute('k1', '0');
    el.setAttribute('k2', '1');
    el.setAttribute('k3', '1');
    el.setAttribute('k4', '0');
    if (result)
        el.setAttribute('result', result);
    return el;
}
/**
 * `out = map·color + color` — `feComposite arithmetic` with `k1 = k3 = 1`, i.e. the shader's
 * `color.rgb *= 1 + α` with `α` pre-baked into `map`. See `buildBevelMap`: both bevel terms of
 * `SdfShaderString` collapse into that one multiplier, so the whole lighting model costs one
 * `feImage` and one `feComposite` rather than a blend chain.
 */
function feMultiplyElement(map, color) {
    const el = document.createElementNS(SVG_NS, 'feComposite');
    el.setAttribute('in', map);
    el.setAttribute('in2', color);
    el.setAttribute('operator', 'arithmetic');
    el.setAttribute('k1', '1');
    el.setAttribute('k2', '0');
    el.setAttribute('k3', '1');
    el.setAttribute('k4', '0');
    return el;
}
/** `feFlood` — a flat colour over a region, the no-bitmap stand-in for `drawRect(color)`. */
function feFloodElement(result) {
    const el = document.createElementNS(SVG_NS, 'feFlood');
    el.setAttribute('result', result);
    return el;
}
/**
 * `feComposite operator="over"` — plain source-over, `src + dst·(1 − src.a)`.
 *
 * Not the `k2 = k3 = 1` addition used for the capture overlay: a translucent wash is an alpha
 * composite, and adding it would brighten by `alpha` regardless of what is underneath instead of
 * covering it by `alpha`.
 */
function feOverElement(src, dst, result) {
    const el = document.createElementNS(SVG_NS, 'feComposite');
    el.setAttribute('in', src);
    el.setAttribute('in2', dst);
    el.setAttribute('operator', 'over');
    el.setAttribute('result', result);
    return el;
}
/** `feColorMatrix type="matrix"` — the carrier for {@link RefractionSpec.colorControls}. */
function feColorMatrixElement(result) {
    const el = document.createElementNS(SVG_NS, 'feColorMatrix');
    el.setAttribute('type', 'matrix');
    el.setAttribute('result', result);
    // Restated here even though `<filter>` sets it and primitives inherit: a colour matrix's
    // coefficients are defined on **sRGB** values, and under linear-light interpolation the same
    // numbers mean something else entirely — the saturation expansion lands on a different curve and
    // the glass comes out drained. The Kotlin `ColorMatrixColorFilter` is an sRGB operation too.
    el.setAttribute('color-interpolation-filters', 'sRGB');
    return el;
}
/**
 * `colorControls` exactly as `ColorFilter.kt` builds it: one 4×5 matrix, coefficients taken
 * verbatim from `colorControlsColorFilter`.
 *
 * `feColorMatrix` operates on non-premultiplied colour, which is also what the Kotlin `ColorMatrix`
 * sees, so the translation is direct. The only change is that `t` stays normalised rather than
 * being multiplied by 255:
 *
 * ```
 * Kotlin:  t = (0.5f - c * 0.5f + brightness) * 255f
 * here:    t =   0.5  - c * 0.5  + brightness
 * ```
 *
 * `brightness` is the upstream value, not `1 + brightness`. Getting that wrong is invisible at
 * `brightness = 0` and a 25-level constant shift at `-0.1`.
 *
 * `toFixed` rather than bare numbers, so the string is stable across calls — `update()` skips the
 * write when it is unchanged, and float-formatting noise would defeat that.
 */
function feColorControlsValues(brightness, contrast, saturation) {
    const invSat = 1 - saturation;
    const lr = 0.213 * invSat;
    const lg = 0.715 * invSat;
    const lb = 0.072 * invSat;
    const c = contrast;
    const t = 0.5 - c * 0.5 + brightness;
    const cr = c * lr;
    const cg = c * lg;
    const cb = c * lb;
    const cs = c * saturation;
    const fmt = (v) => v.toFixed(6);
    const row = (r, g, b) => `${fmt(r)} ${fmt(g)} ${fmt(b)} 0 ${fmt(t)}`;
    return [row(cr + cs, cg, cb), row(cr, cg + cs, cb), row(cr, cg, cb + cs), '0 0 0 1 0'].join('  ');
}
/**
 * One filter per glass surface. The displacement *maps* are shared through
 * {@link refractionMap}; only the tiny `<filter>` element is per-surface, which is what
 * lets two thumbs animate to different refraction strengths at the same time. Surfaces
 * without chromatic aberration keep the two-primitive graph; asking for CA rebuilds it as
 * the eleven-primitive three-branch one.
 */
function createGlassFilter() {
    const id = `lg-refract-${++sequence}`;
    const filter = document.createElementNS(SVG_NS, 'filter');
    filter.setAttribute('id', id);
    filter.setAttribute('filterUnits', 'userSpaceOnUse');
    // Displacement reads outside the box; without this the shifted pixels get clipped at the rim.
    filter.setAttribute('x', String(-FILTER_PAD));
    filter.setAttribute('y', String(-FILTER_PAD));
    // The map stores linear displacement amounts, so it must not be colour-managed.
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    let caMode = null;
    let zoomMode = null;
    let overlayMode = null;
    let bevelMode = null;
    let washMode = null;
    let colorMode = null;
    let gainMode = null;
    let maps = [];
    let displacements = [];
    let nodes = [];
    /** Per map node: the cache key its `href` was last set from — identical strings are skipped. */
    let mapKeys = [];
    /** The stage that runs ahead of the refraction chain (the zoom), when present. */
    let zoomDisplacement = null;
    let zoomMapEl = null;
    let zoomKey = null;
    /** The capture overlay (static image composited into the capture), when present. */
    let overlayImageEl = null;
    let lastOverlayUrl = null;
    /** The overlay placement last written — `x`/`y` move every frame, `width`/`height` do not. */
    let lastOverlayPlacement = '';
    /** The bevel multiplier map (`SdfShader` only), and the key its `href` was set from. */
    let bevelImageEl = null;
    let bevelKey = null;
    /** The `feFlood` carrying the `onDrawBackdrop` wash, and the colour it was last set from. */
    let washFloodEl = null;
    let washKey = null;
    /** The backdrop-gain matrix, and the `values` string it was last built from. */
    let gainMatrixEl = null;
    let gainValues = null;
    /** The `colorControls` matrix, and the `values` string it was last built from. */
    let colorMatrixEl = null;
    let colorValues = null;
    /**
     * Per displacement node: the `scale` string last written. `update()` runs on **every** redraw,
     * including every frame of a scroll, and a scroll changes none of the inputs `scale` is built
     * from — so the same string was being written to the same node again and again. Writing an
     * attribute on an SVG filter primitive marks the filter dirty, which is what makes it cheap to
     * write and expensive to have written. Skipping the identical write is the whole fix.
     */
    let lastScales = [];
    function buildGraph(ca, zoom, overlay, gain, wash, color, bevel) {
        while (filter.firstChild)
            filter.removeChild(filter.firstChild);
        maps = [];
        displacements = [];
        mapKeys = [];
        nodes = [];
        zoomDisplacement = null;
        zoomMapEl = null;
        zoomKey = null;
        overlayImageEl = null;
        lastOverlayUrl = null;
        lastOverlayPlacement = '';
        bevelImageEl = null;
        bevelKey = null;
        washFloodEl = null;
        washKey = null;
        gainMatrixEl = null;
        gainValues = null;
        colorMatrixEl = null;
        colorValues = null;
        lastScales = [];
        // The gain undoes a page-level scrim the destination painted behind the plate (see
        // `RefractionSpec.backdropGain`). It has to come first, and it has to be its own primitive:
        // the wash below is an alpha composite, so it cannot scale the backdrop and still be a
        // correct `over`, and the colour matrix further down is the shader's own `colorControls`.
        let chainInput = 'SourceGraphic';
        if (gain) {
            const matrix = feColorMatrixElement('gained');
            gainMatrixEl = matrix;
            nodes.push(matrix);
            chainInput = 'gained';
        }
        // The wash goes on next: upstream it is part of the recorded layer the render effect is
        // attached to, so it enters the shader's `content` input exactly like the backdrop does.
        // Anything drawn after it — the zoom, the refraction — therefore acts on `backdrop + wash`.
        if (wash) {
            const flood = feFloodElement('wash');
            const over = feOverElement('wash', chainInput, 'washed');
            washFloodEl = flood;
            nodes.push(flood, over);
            chainInput = 'washed';
        }
        // `colorControls` next, so it sees `backdrop + wash` exactly as the render effect does — that
        // is what makes `saturate(1.5)` put the colour back into a wash-desaturated glyph instead of
        // arriving too early to touch it.
        if (color) {
            const matrix = feColorMatrixElement('tinted');
            colorMatrixEl = matrix;
            nodes.push(matrix);
            chainInput = 'tinted';
        }
        // The zoom stage samples with its own fixed scale, and the refraction chain refracts the
        // already-magnified image — the original's `onDrawBackdrop`-then-effects order.
        if (zoom) {
            const zMap = feImageElement('zmap');
            const zDisp = feDisplacementElement('SourceGraphic', 'zmap', 'zoomed');
            zoomMapEl = zMap;
            zoomDisplacement = zDisp;
            nodes.push(zMap, zDisp);
            chainInput = 'zoomed';
        }
        // The capture overlay (e.g. the bottom tabs' accent strip) is composited into the capture
        // BEFORE the effects chain, so refraction and chromatic aberration bend it too.
        if (overlay) {
            const oImg = feImageElement('overlay');
            const oAdd = feAddElement(chainInput, 'overlay', 'composed');
            overlayImageEl = oImg;
            nodes.push(oImg, oAdd);
            chainInput = 'composed';
        }
        // The refraction chain's last stage has to be *named* for the bevel to reach it: a filter
        // primitive can address an earlier one only via `result`, and the graph's implicit output is
        // not addressable by name. Without a bevel every name is left off, so the existing graphs are
        // byte-for-byte what they were.
        const refracted = bevel ? 'refracted' : undefined;
        if (!ca) {
            const map = feImageElement('map');
            const displace = feDisplacementElement(chainInput, 'map', refracted);
            maps.push(map);
            displacements.push(displace);
            mapKeys.push(null);
            nodes.push(map, displace);
        }
        else {
            const mapR = feImageElement('mapR');
            const mapG = feImageElement('mapG');
            const mapB = feImageElement('mapB');
            const srcR = feChannelElement(chainInput, 'r', 'srcR');
            const srcG = feChannelElement(chainInput, 'g', 'srcG');
            const srcB = feChannelElement(chainInput, 'b', 'srcB');
            const dispR = feDisplacementElement('srcR', 'mapR', 'dispR');
            const dispG = feDisplacementElement('srcG', 'mapG', 'dispG');
            const dispB = feDisplacementElement('srcB', 'mapB', 'dispB');
            const addRG = feAddElement('dispR', 'dispG', 'rg');
            const addRGB = feAddElement('rg', 'dispB', refracted);
            maps.push(mapR, mapG, mapB);
            displacements.push(dispR, dispG, dispB);
            mapKeys.push(null, null, null);
            nodes.push(mapR, mapG, mapB, srcR, srcG, srcB, dispR, dispG, dispB, addRG, addRGB);
        }
        // `SdfShader`'s bevel, applied to the refracted result and therefore last in the graph.
        if (bevel) {
            const bevelImage = feImageElement('bevel');
            const bevelMultiply = feMultiplyElement('bevel', 'refracted');
            bevelImageEl = bevelImage;
            nodes.push(bevelImage, bevelMultiply);
        }
        filter.append(...nodes);
        // Primitive subregions must be explicit: the defaults are percentages of the element's
        // bounding box, which shifts and squeezes the `feImage` maps. `update()` only writes
        // them when the region size changes, so a mid-session graph rebuild (CA toggling)
        // would otherwise leave every primitive with the broken defaults.
        if (lastWidth !== 0) {
            for (const node of nodes) {
                // The flood is the one primitive whose region is *not* the padded box — see below.
                if (node === washFloodEl)
                    continue;
                node.setAttribute('x', String(-FILTER_PAD));
                node.setAttribute('y', String(-FILTER_PAD));
                node.setAttribute('width', String(lastWidth));
                node.setAttribute('height', String(lastHeight));
            }
            applyWashRegion();
        }
    }
    /**
     * The wash covers the element box only.
     *
     * Upstream it is painted into a layer recorded at the element's own size, so a `drawRect` there
     * fills exactly the box. Letting the flood take the padded filter region instead would put 25 %
     * white outside the shape, where `feDisplacementMap` samples it and drags it inward across the
     * rim — a bright fringe around every glyph edge.
     */
    function applyWashRegion() {
        if (!washFloodEl)
            return;
        washFloodEl.setAttribute('x', '0');
        washFloodEl.setAttribute('y', '0');
        washFloodEl.setAttribute('width', String(Math.max(0, lastWidth - FILTER_PAD * 2)));
        washFloodEl.setAttribute('height', String(Math.max(0, lastHeight - FILTER_PAD * 2)));
    }
    svgRoot().appendChild(filter);
    let lastMapKey = '';
    let lastWidth = 0;
    let lastHeight = 0;
    return {
        id,
        update(spec, amount, zoom, overlay) {
            const ca = !!spec.chromaticAberration;
            const hasZoom = !!zoom && zoom.factor > 0 && zoom.factor !== 1;
            const hasOverlay = !!overlay && !!overlay.url;
            const hasBevel = !!spec.sdf;
            const hasWash = !!spec.wash;
            const hasColor = !!spec.colorControls;
            const gain = spec.backdropGain != null && spec.backdropGain > 0 && spec.backdropGain !== 1
                ? spec.backdropGain
                : null;
            const hasGain = gain !== null;
            if (ca !== caMode ||
                hasZoom !== zoomMode ||
                hasOverlay !== overlayMode ||
                hasBevel !== bevelMode ||
                hasWash !== washMode ||
                hasColor !== colorMode ||
                hasGain !== gainMode) {
                caMode = ca;
                zoomMode = hasZoom;
                overlayMode = hasOverlay;
                bevelMode = hasBevel;
                washMode = hasWash;
                colorMode = hasColor;
                gainMode = hasGain;
                buildGraph(ca, hasZoom, hasOverlay, hasGain, hasWash, hasColor, hasBevel);
            }
            const width = Math.round(spec.width + FILTER_PAD * 2);
            const height = Math.round(spec.height + FILTER_PAD * 2);
            if (width !== lastWidth || height !== lastHeight) {
                lastWidth = width;
                lastHeight = height;
                filter.setAttribute('width', String(width));
                filter.setAttribute('height', String(height));
                for (const node of nodes) {
                    if (node === washFloodEl)
                        continue;
                    node.setAttribute('x', String(-FILTER_PAD));
                    node.setAttribute('y', String(-FILTER_PAD));
                    node.setAttribute('width', String(width));
                    node.setAttribute('height', String(height));
                }
                applyWashRegion();
                lastMapKey = '';
            }
            if (hasZoom && zoomDisplacement && zoomMapEl) {
                const key = `z|${Math.round(spec.width)}x${Math.round(spec.height)}|${zoom.factor}`;
                if (key !== zoomKey) {
                    zoomKey = key;
                    const entry = zoomMap(spec.width, spec.height, zoom);
                    if (entry.url)
                        zoomMapEl.setAttribute('href', entry.url);
                    // Fixed scale — the magnification does not animate with the refraction amount.
                    zoomDisplacement.setAttribute('scale', String(entry.vmax * 2));
                }
            }
            // One resolution per branch per update: `maps` and `displacements` are index-aligned with
            // `branches`, so the `href`s and the `scale`s are read off the same entries.
            const branches = ca ? [1, 0, -1] : [0];
            const entries = branches.map((branch) => refractionMap(spec, branch));
            const key = mapKey(spec, ca ? 1 : 0);
            if (key !== lastMapKey) {
                lastMapKey = key;
                // Red and blue share the green branch's geometry, so one key guards all three hrefs.
                maps.forEach((map, index) => {
                    const entry = entries[index];
                    if (entry.url && mapKeys[index] !== key) {
                        mapKeys[index] = key;
                        map.setAttribute('href', entry.url);
                    }
                });
            }
            // The capture overlay's placement is element-local and moves per frame (the pill
            // slides over a fixed strip) — a cheap attribute write, no image rebuild. `href`
            // only changes when the strip's content does.
            if (hasOverlay && overlayImageEl && overlay) {
                const placement = `${overlay.x}|${overlay.y}|${overlay.width}|${overlay.height}`;
                if (placement !== lastOverlayPlacement) {
                    lastOverlayPlacement = placement;
                    overlayImageEl.setAttribute('x', String(overlay.x));
                    overlayImageEl.setAttribute('y', String(overlay.y));
                    overlayImageEl.setAttribute('width', String(overlay.width));
                    overlayImageEl.setAttribute('height', String(overlay.height));
                }
                if (overlay.url !== lastOverlayUrl) {
                    lastOverlayUrl = overlay.url;
                    overlayImageEl.setAttribute('href', overlay.url);
                }
            }
            // The wash colour. Flat at every call site that uses it, so the two attributes are written
            // once — but still guarded, because an attribute write on a filter primitive dirties the
            // whole graph and this one runs on every redraw.
            if (hasWash && washFloodEl && spec.wash) {
                const key = `${spec.wash.color}|${spec.wash.alpha}`;
                if (key !== washKey) {
                    washKey = key;
                    washFloodEl.setAttribute('flood-color', spec.wash.color);
                    washFloodEl.setAttribute('flood-opacity', String(spec.wash.alpha));
                }
            }
            // The backdrop gain. A diagonal matrix, and a very short string — skipped when unchanged
            // like every other write here.
            if (hasGain && gainMatrixEl && gain != null) {
                const g = gain;
                const values = `${g} 0 0 0 0  0 ${g} 0 0 0  0 0 ${g} 0 0  0 0 0 1 0`;
                if (values !== gainValues) {
                    gainValues = values;
                    gainMatrixEl.setAttribute('values', values);
                }
            }
            // The colour matrix. Rebuilt from the three uniforms and skipped when unchanged — the same
            // guard the other stages use, and the reason the values string is formatted deterministically.
            if (hasColor && colorMatrixEl && spec.colorControls) {
                const cc = spec.colorControls;
                const values = feColorControlsValues(cc.brightness, cc.contrast, cc.saturation);
                if (values !== colorValues) {
                    colorValues = values;
                    colorMatrixEl.setAttribute('values', values);
                }
            }
            // The bevel multiplier. Static for a given box, texture and light angle — a clock face
            // changes none of the three, so this writes its `href` once and then never again.
            if (hasBevel && bevelImageEl && spec.sdf) {
                const key = `bevel|${Math.round(spec.width)}x${Math.round(spec.height)}|${spec.sdf.key}|${spec.sdfLightAngle ?? 45}`;
                if (key !== bevelKey) {
                    bevelKey = key;
                    const entry = bevelMap(spec);
                    if (entry.url)
                        bevelImageEl.setAttribute('href', entry.url);
                }
            }
            // The animation knob. `lens()` animates `refractionAmount`; `SdfShader` has no such
            // parameter — its `apply(refractionHeight)` *is* the displacement scale, because the field
            // being scaled is baked into the texture. Either way this is the only input that changes
            // while a call site animates, and it lands as a plain `scale` attribute.
            //
            // Skipped when the value is unchanged. A scroll changes none of the inputs this is built
            // from, so the identical string used to be re-written to every node on every frame — and an
            // attribute write on a filter primitive dirties the filter, which is what turns a cheap
            // write into an expensive re-rasterisation.
            const scaleBase = spec.sdf ? spec.refractionHeight : amount;
            displacements.forEach((displace, index) => {
                const next = String(scaleBase * 2 * entries[index].vmax);
                if (lastScales[index] === next)
                    return;
                lastScales[index] = next;
                displace.setAttribute('scale', next);
            });
        },
        dispose() {
            filter.remove();
        }
    };
}

/* ==========================================================================================
 * 2. Userscript host — the piece the project does not ship
 *
 * The core below (`createGlassFilter`) only *builds the SVG filter graph*. Everything that
 * turns a page element into glass is host policy, and in the project that policy lives in
 * `src/components/GlassSurface.vue` inside a four-layer Vue component (shadow canvas / lens /
 * overlay canvas / additive canvas + content). A userscript does not need those four layers:
 * putting `backdrop-filter` on the element itself is enough, because the element's own
 * background is composited *over* the filtered backdrop — the classic frosted-glass model.
 * So the host here is ~100 lines: geometry, feature gate, resize, teardown.
 * ========================================================================================== */

const DEFAULTS = Object.assign({
  /** CSS filter functions that run before the refraction in the same `backdrop-filter`. */
  blur: 8,
  saturate: 1.6,
  brightness: 1.06,
  /** `refractionHeight` — how far in from the rim the bend reaches, in CSS px. */
  refractionHeight: 18,
  /** `refractionAmount` — the largest pixel shift at the rim. Baked into `feDisplacementMap@scale`. */
  refractionAmount: 22,
  /** `depthEffect` — blend the centripetal direction into the bend gradient. */
  depthEffect: true,
  /**
   * `chromaticAberration` — the three-branch spectral graph. Costs three displacement maps
   * AND an 11-primitive filter graph per surface, so it stays off by default here.
   */
  chromaticAberration: false,
  /** Reject maps above this many pixels — the SDF runs per pixel, per branch. */
  maxArea: 700 * 700
}, CONFIG.defaults)

/** Whether the data-URL maps were refused — reported once, after the first glass surface. */
let warnedFallback = false
const hosts = new WeakMap()
/** Same hosts, iterable — needed to re-paint everything once the map probe resolves. */
const liveHosts = new Set()
let svgRootMovedTo = null

/** 1x1 transparent PNG. Any data-URL image works; this one is 68 bytes. */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/**
 * `img-src` gates the `<feImage>` maps, and when it refuses them the failure is **silent**:
 * no console error, the blur still applies, only the lens is missing (measured: with
 * `img-src 'none'`, changing `refractionAmount` 0 -> 30 changes zero pixels). So the refusal is
 * detected once with a throwaway image load and every surface degrades to plain frosted glass.
 * The detection itself costs one blocked request, which is the point — it is the only signal.
 *
 * @returns {Promise<boolean>} `true` when data-URL maps can be loaded on this page.
 */
let mapSupport = null
function probeMapSupport() {
  if (mapSupport !== null) return Promise.resolve(mapSupport)
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve((mapSupport = true))
    img.onerror = () => resolve((mapSupport = false))
    img.src = TINY_PNG
  })
}

/** Drop the lens from every live surface — what a refused map support leaves behind. */
function degradeAll() {
  for (const host of liveHosts) host.degrade()
}

function isShadowScope(node) {
  return typeof ShadowRoot !== 'undefined' && node instanceof ShadowRoot
}

/**
 * `url(#id)` resolves inside the *tree* that holds the element. If the target lives in a
 * shadow root, the shared `<svg>` has to move into that root — the core keeps one module-level
 * root, so this only holds for one tree scope at a time.
 */
function ensureFilterScope(rootNode) {
  if (svgRootMovedTo === rootNode) return
  if (isShadowScope(rootNode)) {
    const anyFilter = document.querySelector('svg > filter[id^="lg-refract-"]')
    if (anyFilter && anyFilter.parentNode) rootNode.appendChild(anyFilter.parentNode)
  }
  svgRootMovedTo = rootNode
}

/** `borderRadius` from the computed style → `[tl, tr, br, bl]` in px (percentages fall back). */
function readCornerRadii(el) {
  const style = getComputedStyle(el)
  const parts = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius']
  return parts.map((prop) => {
    const value = parseFloat(style[prop])
    return Number.isFinite(value) ? value : 0
  })
}

function buildBackdropValue(opts) {
  const base = []
  if (opts.blur > 0) base.push(`blur(${opts.blur}px)`)
  if (opts.saturate !== 1) base.push(`saturate(${opts.saturate})`)
  if (opts.brightness !== 1) base.push(`brightness(${opts.brightness})`)
  return base.join(' ')
}

/**
 * Turn `el` into a refraction-glass surface.
 *
 * @param {Element} el
 * @param {object} [options] any subset of {@link DEFAULTS}
 * @returns {{id: string|null, spec: object} | null}
 */
function glassify(el, options) {
  if (!(el instanceof Element)) return null
  const opts = Object.assign({}, DEFAULTS, options)

  const rect = el.getBoundingClientRect()
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  if (width < 2 || height < 2) return null
  if (width * height > opts.maxArea) {
    console.warn(
      `[liquid-glass] ${width}x${height} exceeds maxArea=${opts.maxArea}; the SDF map is built ` +
        'per pixel per branch, so this element is skipped. Raise maxArea deliberately if you accept the cost.'
    )
    return null
  }

  const base = buildBackdropValue(opts)
  const supported = isRefractionSupported()

  // Non-Chromium engines drop the whole declaration when it contains `url()`, so the plain
  // functions must be written on their own. Writing them first and appending `url()` after is
  // only meaningful when the value lands in a stylesheet; here we branch on the engine probe.
  // `mapSupport === false` is the same situation for a different reason: the page's CSP refuses
  // the `data:` maps, so `url()` would be a filter graph that renders as a no-op.
  if (!supported || mapSupport === false) {
    if (!warnedFallback) {
      warnedFallback = true
      console.warn(
        !supported
          ? '[liquid-glass] no `url()` support in backdrop-filter (Chromium only) — plain blur fallback.'
          : '[liquid-glass] the page CSP refuses `data:` images, so the displacement maps cannot load — plain blur fallback.'
      )
    }
    el.style.backdropFilter = base
    el.style.setProperty('-webkit-backdrop-filter', base)
    return { id: null, spec: null }
  }

  // First surface on this page: find out whether the maps are loadable at all.
  if (mapSupport === null) {
    probeMapSupport().then((ok) => {
      if (!ok) degradeAll()
    })
  }

  const existing = hosts.get(el)
  if (existing) {
    existing.update(opts)
    return { id: existing.filter.id, spec: existing.spec() }
  }

  const filter = createGlassFilter()
  ensureFilterScope(el.getRootNode())

  const host = {
    el,
    filter,
    opts,
    degraded: false,
    previous: {
      backdropFilter: el.style.backdropFilter,
      webkitBackdropFilter: el.style.getPropertyValue('-webkit-backdrop-filter')
    },
    spec() {
      const box = el.getBoundingClientRect()
      return {
        width: Math.round(box.width),
        height: Math.round(box.height),
        cornerRadii: readCornerRadii(el),
        refractionHeight: host.opts.refractionHeight,
        depthEffect: host.opts.depthEffect,
        chromaticAberration: host.opts.chromaticAberration
      }
    },
    paint() {
      // A surface whose maps were refused must never re-acquire the `url()` reference — the
      // probe resolves asynchronously, so a call that arrives afterwards would undo `degrade()`.
      if (host.degraded) return
      const spec = host.spec()
      filter.update(spec, host.opts.refractionAmount)
      // ⚠ A bare `backdrop-filter: url(#id)` is silently ignored by Chromium — the reference is
      // only honoured when a fixed filter function precedes it. The project appends `blur(0px)`
      // as a no-op prefix for the same reason; here `base` is empty only if every knob is off.
      const value = `${base || 'blur(0px)'} url(#${filter.id})`
      el.style.backdropFilter = value
      el.style.setProperty('-webkit-backdrop-filter', value)
    },
    update(next) {
      host.opts = Object.assign({}, host.opts, next)
      host.paint()
    },
    /** Leave the surface as plain frosted glass — the maps turned out to be unreachable. */
    degrade() {
      host.degraded = true
      el.style.backdropFilter = base
      el.style.setProperty('-webkit-backdrop-filter', base)
      host.filter.dispose()
      host.observer.disconnect()
      liveHosts.delete(host)
      if (!warnedFallback) {
        warnedFallback = true
        console.warn(
          '[liquid-glass] the page CSP refuses `data:` images, so the displacement maps cannot ' +
            'load — every surface falls back to plain frosted glass. A `blob:` map would need ' +
            '`img-src blob:` instead; sites that allow neither cannot show the lens.'
        )
      }
    },
    destroy() {
      host.observer.disconnect()
      host.filter.dispose()
      liveHosts.delete(host)
      el.style.backdropFilter = host.previous.backdropFilter
      if (host.previous.webkitBackdropFilter) {
        el.style.setProperty('-webkit-backdrop-filter', host.previous.webkitBackdropFilter)
      } else {
        el.style.removeProperty('-webkit-backdrop-filter')
      }
      hosts.delete(el)
      el.removeAttribute('data-liquid-glass')
    },
    observer: null
  }

  host.observer = new ResizeObserver(() => host.paint())
  host.observer.observe(el)
  hosts.set(el, host)
  liveHosts.add(host)
  el.setAttribute('data-liquid-glass', 'on')
  host.paint()
  return { id: filter.id, spec: host.spec() }
}

function unglassify(el) {
  const host = hosts.get(el)
  if (host) host.destroy()
}

/* ==========================================================================================
 * 3. Wiring — configuration-driven, inert until configured
 *
 * Nothing here runs on its own: with no `selectors` and hotkeys left on their defaults, the
 * only thing this section does is publish the API and track the pointer. That is what makes the
 * file safe to `@require` from another userscript — the import has no visible effect until the
 * importer asks for one.
 * ========================================================================================== */

/** `['.hdr', 'nav']` → `'.hdr,nav'`; an empty list disables the sweep entirely. */
function selectorList() {
  const list = Array.isArray(CONFIG.selectors) ? CONFIG.selectors : []
  return list.filter((s) => typeof s === 'string' && s.trim()).join(',')
}

/** Apply to every element currently matching `CONFIG.selectors`. Idempotent per element. */
function applyAll() {
  const selector = selectorList()
  if (!selector) return []
  const applied = []
  for (const el of document.querySelectorAll(selector)) {
    if (el.hasAttribute('data-liquid-glass')) continue
    if (glassify(el)) applied.push(el)
  }
  return applied
}

/**
 * Keep up with a SPA. Mutations are coalesced into one rAF: a framework re-render can deliver
 * hundreds of records, and each `applyAll` walks the selector list.
 */
let watchScheduled = false
function startWatching() {
  if (!selectorList()) return
  const schedule = () => {
    if (watchScheduled) return
    watchScheduled = true
    requestAnimationFrame(() => {
      watchScheduled = false
      applyAll()
    })
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  return observer
}

/* ------------------------------------------------------------------ hotkeys ------- */

/** `'alt+shift+g'` → `{ alt: true, shift: true, key: 'g' }`. Unknown tokens are ignored. */
function parseCombo(combo) {
  if (typeof combo !== 'string') return null
  const parts = combo.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean)
  const key = parts.pop()
  if (!key) return null
  return {
    key,
    alt: parts.includes('alt'),
    shift: parts.includes('shift'),
    ctrl: parts.includes('ctrl') || parts.includes('control'),
    meta: parts.includes('meta') || parts.includes('cmd')
  }
}

let lastPointer = { x: 0, y: 0 }
PAGE.addEventListener(
  'pointermove',
  (event) => {
    lastPointer = { x: event.clientX, y: event.clientY }
  },
  { passive: true, capture: true }
)

function bindHotkeys(spec) {
  const glassCombo = parseCombo(spec && spec.glassify)
  const unglassCombo = parseCombo(spec && spec.unglassify)
  if (!glassCombo && !unglassCombo) return
  PAGE.addEventListener('keydown', (event) => {
    const pressed = event.key.toLowerCase()
    const combo = glassCombo && pressed === glassCombo.key ? glassCombo
      : unglassCombo && pressed === unglassCombo.key ? unglassCombo
      : null
    if (!combo) return
    if (!!event.altKey !== combo.alt || !!event.shiftKey !== combo.shift) return
    if (!!event.ctrlKey !== combo.ctrl || !!event.metaKey !== combo.meta) return
    // The target is the element under the cursor, resolved through the page, not through
    // `event.target` — a hotkey fires wherever focus happens to be.
    const target = document.elementFromPoint(lastPointer.x, lastPointer.y)
    if (!target) return
    event.preventDefault()
    if (combo === glassCombo) {
      const result = glassify(target)
      console.log('[liquid-glass]', result ? `filter #${result.id}` : 'refused', target)
    } else {
      unglassify(target)
      console.log('[liquid-glass] removed', target)
    }
  })
}

/* ------------------------------------------------------------------ publish -------- */

const api = {
  version: VERSION,
  /** Public spelling of `glassify` — the name to use in READMEs and other people's code. */
  apply: glassify,
  glassify,
  unglassify,
  applyAll,
  isRefractionSupported,
  createGlassFilter,
  FILTER_PAD,
  DEFAULTS,
  config: CONFIG,
  /** How many surfaces are live right now (not counting ones that degraded). */
  activeCount: () => liveHosts.size
}

// Both scopes: `PAGE` is the real window (or `unsafeWindow`), and the sandbox `window` gets the
// same object so a requiring script with grants can read it without `unsafeWindow`.
PAGE.LiquidGlassRefract = api
window.LiquidGlassRefract = api
// Historical name, kept so the earlier snippets in the project's docs keep working.
PAGE.__liquidGlass = api
window.__liquidGlass = api

if (document.readyState === 'loading') {
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      applyAll()
      if (CONFIG.autoWatch) startWatching()
    },
    { once: true }
  )
} else {
  applyAll()
  if (CONFIG.autoWatch) startWatching()
}
bindHotkeys(CONFIG.hotkeys)
})();
