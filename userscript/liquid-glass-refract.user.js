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
 *      R = dx, G = dy (128 = no offset), one PNG per spectral branch.
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
(function () {
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
 * filter. `feDisplacementMap` reads a map where R = dx and G = dy (128 = no offset) and
 * shifts each pixel by it.
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
 */
function isRefractionSupported() {
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
const MAP_LIMIT = 32;
function mapKey(spec, branch) {
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
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
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
    for (let j = 0; j < ch; j++) {
        const y = j - FILTER_PAD;
        for (let i = 0; i < cw; i++) {
            const index = (j * cw + i) * 4;
            // Neutral grey = "leave this pixel alone".
            data[index] = 128;
            data[index + 1] = 128;
            data[index + 2] = 128;
            data[index + 3] = 255;
            const x = i - FILTER_PAD;
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
    const entry = buildMap(spec, branch);
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
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
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
    for (let j = 0; j < ch; j++) {
        const y = j - FILTER_PAD;
        for (let i = 0; i < cw; i++) {
            const x = i - FILTER_PAD;
            const index = (j * cw + i) * 4;
            data[index] = 128;
            data[index + 1] = 128;
            data[index + 2] = 128;
            data[index + 3] = 255;
            if (x < 0 || x >= w || y < 0 || y >= h)
                continue;
            const dx = cx + (x - cx) / k - x;
            const dy = cy + (y - cy) / k - y;
            data[index] = clampByte(128 + dx * s);
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
    function buildGraph(ca, zoom, overlay) {
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
        // The zoom stage samples with its own fixed scale, and the refraction chain refracts the
        // already-magnified image — the original's `onDrawBackdrop`-then-effects order.
        let chainInput = 'SourceGraphic';
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
        if (!ca) {
            const map = feImageElement('map');
            const displace = feDisplacementElement(chainInput, 'map');
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
            const addRGB = feAddElement('rg', 'dispB');
            maps.push(mapR, mapG, mapB);
            displacements.push(dispR, dispG, dispB);
            mapKeys.push(null, null, null);
            nodes.push(mapR, mapG, mapB, srcR, srcG, srcB, dispR, dispG, dispB, addRG, addRGB);
        }
        filter.append(...nodes);
        // Primitive subregions must be explicit: the defaults are percentages of the element's
        // bounding box, which shifts and squeezes the `feImage` maps. `update()` only writes
        // them when the region size changes, so a mid-session graph rebuild (CA toggling)
        // would otherwise leave every primitive with the broken defaults.
        if (lastWidth !== 0) {
            for (const node of nodes) {
                node.setAttribute('x', String(-FILTER_PAD));
                node.setAttribute('y', String(-FILTER_PAD));
                node.setAttribute('width', String(lastWidth));
                node.setAttribute('height', String(lastHeight));
            }
        }
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
            if (ca !== caMode || hasZoom !== zoomMode || hasOverlay !== overlayMode) {
                caMode = ca;
                zoomMode = hasZoom;
                overlayMode = hasOverlay;
                buildGraph(ca, hasZoom, hasOverlay);
            }
            const width = Math.round(spec.width + FILTER_PAD * 2);
            const height = Math.round(spec.height + FILTER_PAD * 2);
            if (width !== lastWidth || height !== lastHeight) {
                lastWidth = width;
                lastHeight = height;
                filter.setAttribute('width', String(width));
                filter.setAttribute('height', String(height));
                for (const node of nodes) {
                    node.setAttribute('x', String(-FILTER_PAD));
                    node.setAttribute('y', String(-FILTER_PAD));
                    node.setAttribute('width', String(width));
                    node.setAttribute('height', String(height));
                }
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
            const key = mapKey(spec, ca ? 1 : 0);
            if (key !== lastMapKey) {
                lastMapKey = key;
                // Red and blue share the green branch's geometry, so one key guards all three hrefs.
                const branches = ca ? [1, 0, -1] : [0];
                maps.forEach((map, index) => {
                    const entry = refractionMap(spec, branches[index]);
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
                overlayImageEl.setAttribute('x', String(overlay.x));
                overlayImageEl.setAttribute('y', String(overlay.y));
                overlayImageEl.setAttribute('width', String(overlay.width));
                overlayImageEl.setAttribute('height', String(overlay.height));
                if (overlay.url !== lastOverlayUrl) {
                    lastOverlayUrl = overlay.url;
                    overlayImageEl.setAttribute('href', overlay.url);
                }
            }
            // Set every frame — `amount` is the animation knob and changes independently of the
            // map geometry. The map encodes magnitudes normalised to `vmax`; the branch's own
            // scale factor restores them. `feDisplacementMap` offsets by
            // `scale * (channel/255 - 0.5)`, so `amount * vmax` is that branch's largest shift, px.
            const branches = ca ? [1, 0, -1] : [0];
            displacements.forEach((displace, index) => {
                const entry = refractionMap(spec, branches[index]);
                displace.setAttribute('scale', String(amount * 2 * entry.vmax));
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
})()
