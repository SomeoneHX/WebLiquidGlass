# WebLiquidGlass

> A faithful Web port of the Android `Kyant0/AndroidLiquidGlass` (Liquid Glass / Backdrop) **Web Liquid Glass** demo.

中文文档见 [`README.md`](./README.md)（用户脚本部分同样有完整中文版，见 [中文 §10](./README.md#10-用户脚本liquid-glass-refraction)）。

---

## 1. Overview

**WebLiquidGlass** is a Web port of the Android open-source project [`Kyant0/AndroidLiquidGlass`](https://github.com/Kyant0/AndroidLiquidGlass) — a customizable Liquid Glass effect library for Compose Multiplatform, whose *Web Liquid Glass* is a showcase of "liquid glass" UI.

The goal is not to *look* similar, but to **reproduce, effect-by-effect and pixel-by-pixel, what the original does on each control** — blur, refraction, deformation, highlights, ripple, spring animation — by substituting Kotlin/AGSL implementations with native browser capabilities:

- **Blur / saturation / brightness** → CSS `backdrop-filter` (`blur()` / `saturate()` / `brightness()`), 1:1 with upstream.
- **Refraction (displacement)** → a displacement map generated on a Canvas from a rounded-rect SDF, fed into an SVG `feDisplacementMap`, then chained into `backdrop-filter: url(#id)`.
- **Deformation** → driven directly by CSS `transform: scale()/translate()`. The browser performs the inverse-sampling automatically per the Filter Effects L2 spec, equivalent to Android's `InverseLayerScope`.
- **Highlights** → AGSL highlight shaders baked pixel-by-pixel on Canvas 2D (directional bevel/rim + additive blending).

Stack: **Vue 3 + TypeScript + Vite**, managed with `npm`. **Pure DOM + native browser tech; zero WebGL / zero GLSL.**

> ⚠️ Direction note: an earlier plan aimed for a "degraded" form (no blur, no refraction). That was **reversed** — the current build fully uses native CSS/SVG filters for both blur and refraction. This README describes the current build.

---

## 2. Relationship to the original

| Aspect | Android original (`Kyant0/AndroidLiquidGlass`) | This port |
| --- | --- | --- |
| Language | Kotlin + Compose + AGSL shaders | TypeScript + Vue 3 + Canvas 2D + CSS/SVG |
| Blur | `RenderEffect` (API ≥ 31) | CSS `backdrop-filter: blur()` |
| Refraction | `RuntimeShader` (same family as `feDisplacementMap`) | Canvas displacement map + SVG `feDisplacementMap` |
| Deformation | manual `InverseLayerScope` | CSS `transform` (browser inverts automatically) |
| Highlights | AGSL runtime shader + `BlendMode.Plus` | Canvas 2D bake + `mix-blend-mode: plus-lighter` |
| Shell | `CatalogDestination` state machine | `src/core/destinations.ts` + Vue component swap |

Every ported file **carries a top-of-file comment naming the Kotlin source it maps to**, for easy cross-referencing with upstream.

Source layout of the upstream `Kyant0/AndroidLiquidGlass` repo:
- Demo: `app/src/commonMain/kotlin/com/kyant/backdrop/catalog/`
- Library: `backdrop/src/commonMain/kotlin/com/kyant/backdrop/`

---

## 3. Technical approach & architecture

### 3.1 Layering: Vue shell + framework-agnostic core

Vue **only provides the shell**: the component tree, `props`, lifecycle, and one global invalidation signal. The real logic lives in `src/core/`, which is **framework-agnostic** — its only coupling to Vue is the `ref` in `src/core/animation.ts` (i.e. `animationRevision`).

> Consequently `src/core/` can be lifted into React / Svelte as-is; only the shell and that one `ref` need rewriting.

Do **not** introduce `vue-router` / `Pinia` / `<Transition>`: destination switching is a hand-written state machine and all deformation is driven by a hand-written `requestAnimationFrame` loop.

### 3.2 Glass rendering pipeline (GlassSurface)

Each `GlassSurface` is composed of **5 stacked layers**, bottom to top:

1. **shadow canvas** — drop shadow;
2. **lens div (empty node)** — carries only `backdrop-filter` + `clip-path`; **must never hold children** (a `backdrop-filter` establishes a backdrop root, which excludes descendants from the backdrop);
3. **overlay canvas** — surface wash + the non-additive `Ambient` highlight;
4. **additive canvas** — press highlight + `BlendMode.Plus` highlight rings, drawn with `mix-blend-mode: plus-lighter` for true **additive blending**;
5. **content** — the real DOM content.

Why split highlights across two canvases? Because **Canvas cannot do "addition"**. `globalCompositeOperation = 'lighter'` only affects *pixels already inside the canvas*; on a clean canvas there is no "ground" to add onto, so the browser composites it as `normal` anyway, yielding white-biased interpolation (`dst + a·(255−dst)`) rather than addition (`dst + a·255`). Anything upstream written as `BlendMode.Plus` must therefore be painted on the `plus-lighter` additive canvas.

### 3.3 Refraction filter (glass-filter.ts)

`backdrop-filter` only samples what is painted **behind** the element, so the glass needs **no copy of the wallpaper** — the browser captures it. Blur/saturation/brightness map 1:1 to CSS filter functions, but **refraction** has no CSS primitive ("shift every pixel by a vector field"), so it goes through an SVG filter:

- The displacement map is built on a Canvas from a rounded-rect **SDF** (isomorphic to Android's `RoundedRectRefractionShaderString`);
- `feDisplacementMap` reads a map where **R = dx, G = dy** (128 = no offset) and shifts each pixel by it;
- **Chromatic aberration**: the upstream shader samples the backdrop 7 times along the refraction offset with spectral weights. Here a **three-branch filter graph** is used instead — red `base·(1+i)`, green `base`, blue `base·(1−i)`, each displaced and re-added with `feComposite arithmetic` (3 taps instead of 7; white is conserved).

Maps are memoised by `(width × height × corner-radii × refraction-depth × chromatic?)`, so identical shapes share one bitmap; per frame only the cheap `feDisplacementMap` `scale` is updated to drive the animation.

### 3.4 Highlight system (highlight-map / interactive-highlight)

Upstream builds **AGSL shaders** for the `Default` / `Ambient` highlights via `paint.setRuntimeShader` — and Android's Paint modulates shader output by the *color alpha*, so the rim alpha = `styleColorAlpha · |⟨SDF outer normal, (cos angle, sin angle)⟩| ^ falloff`.

- Straight edges are constant `0.707`; each round cap is `1.0` on one side and **0 (gap) on the other**;
- `Highlight.angle` / `falloff` are uniforms of this formula, not decoration (`ControlCenterContent` passes `falloff = 2`); dropping them yields the wrong "uniform white ring per component" look;
- `Ambient` and `Default` differ only in color, and that difference **is semantic**: `Ambient`'s shader is `half4(t,t,t,1)·intensity`, and AGSL returns **premultiplied** values, so the `d<0` half is full-intensity black — combined with `SrcOver`, `d≥0` brightens and `d<0` darkens, making `Ambient` a **bevel rather than a rim**; `Default` is a uniform white stroke drawn with `Plus`.

See `src/core/highlight-map.ts`: pixel-by-pixel bake of the intensity field + cache, with `paintRing` multiplying the field into the stroke via `source-in`. **Order matters — blur geometry first, then multiply by the intensity map**; reset `scratch.filter` to `'none'` before multiplying or the field gets blurred.

The press highlight (`interactive-highlight.ts`) has two branches: when upstream `SDK_INT ≥ 33` it paints a `White@0.08·progress` flat fill **plus** a pointer-following radial glow (`createRadialGradient` expresses `smoothstep`); otherwise a single `0.25·progress` layer. The Web build paints **both branches**, and the pointer coordinate must be un-transformed via `localPointerPosition()` — `getBoundingClientRect()` returns the *transformed* box, so a naive `clientX - rect.left` gets multiplied by the stretch and the glow drifts off the finger.

### 3.5 Animation & invalidation

- `Animatable` and friends are **plain JS objects** stepped by a shared `rAF` loop;
- the DOM/canvas invalidation signal is `animationRevision` (`useFrameValue` wraps it into a Vue `ref`);
- **it must be a Vue `ref` (reactive)** — if it were a plain `number`, Vue would never mark dirty: the math runs but the DOM/canvas never updates a single frame, presenting as "nothing responds to clicks, no error".

### 3.6 Deformation & transform semantics

`layerBlock` and `offset` are merged into one CSS `transform`: `GlassSurface.currentCssTransform()` = `translate(offset)` + `layerTransformToCss(t)`.

**Key normative fact**: `backdrop-filter` + `transform` **does not magnify the background**. Per the Filter Effects Module Level 2:

- the rendering steps transform the element's border box into screen space and clip to it → sampling region = the transformed quad (`scale(1.5)` samples the enlarged region);
- the inverse transform is then applied to the interior content → net effect = content scale unchanged, only the sampling region grows; the background is "pinned" to the screen.

That is exactly liquid-glass semantics, not a magnifier. In other words, the `InverseLayerScope` inversion Android must do manually **is already done inside the browser**, so `transform: scale()` can be used directly for deformation (and it is a compositor-level operation, cheaper than mutating `width/height`).

---

## 4. Project structure

```
WebLiquidGlass/
├── index.html
├── package.json
├── vite.config.ts            # base:'./', alias '@'→'./src', dev bound to 127.0.0.1:5173
├── tsconfig.json
├── public/                   # wallpapers & static assets (loaded by useWallpaper)
├── userscript/
│   └── liquid-glass-refract.user.js   # ★ standalone userscript extracted from core/glass-filter.ts (see §10)
├── scripts/
│   └── stamp-userscript.mjs  # stamps the CI run number into the script's @version on release (see §10.6)
├── .github/workflows/deploy.yml       # Pages deploy: builds the demo + publishes the userscript
└── src/
    ├── main.ts               # createApp(App).mount('#app')
    ├── App.vue               # shell: destination state machine + theme + Back button + layout epoch
    ├── style.css             # globals, safe-area vars, light/dark theme, user-select:none
    ├── core/                 # ★ the framework-agnostic real core (portable to React/Svelte)
    │   ├── animation.ts       # shared rAF loop + animationRevision (ref)
    │   ├── backdrop.ts        # Backdrop reduced to { samples } — only Root/Empty
    │   ├── draw-backdrop.ts   # mirrors Compose drawBackdrop composition
    │   ├── glass-filter.ts    # refraction: Canvas SDF → feImage + feDisplacementMap (Chromium-only)
    │   ├── highlight-map.ts   # pixel-wise highlight intensity bake + cache (bevel/rim directionality)
    │   ├── interactive-highlight.ts  # press highlight two branches + pointer un-transform
    │   ├── destinations.ts    # CatalogDestination type (15 destinations)
    │   ├── math.ts / geometry.ts / shapes.ts
    │   ├── color.ts           # argb(0xff34c759) reads 8-digit ARGB
    │   ├── damped-drag-animation.ts / drag-gestures.ts / transform-gestures.ts
    │   ├── velocity-tracker.ts / progress-converter.ts
    │   └── assets.ts
    ├── components/
    │   ├── GlassSurface.vue   # the 5-layer glass container
    │   ├── LiquidButton.vue / LiquidToggle.vue / LiquidSlider.vue
    │   ├── LiquidBottomTabs.vue / LiquidBottomTab.vue
    │   ├── RippleSurface.vue  # ripple (depends on native @click)
    │   ├── BackdropDemoScaffold.vue
    │   └── FlightIcon.vue
    ├── composables/
    │   ├── useFrameValue.ts   # maps animationRevision into a reactive ref
    │   ├── useElementMetrics.ts  # layout epoch / getBoundingClientRect un-transform
    │   ├── useTap.ts / useWallpaper.ts / backdrop-context.ts
    └── views/                # 14 demo pages (the 14 non-Home destinations)
        ├── HomeContent.vue          # catalog grid
        ├── ButtonsContent.vue       # LiquidButton + ripple + glass
        ├── ToggleContent.vue        # toggle (thumb scaleY deform + bevel highlight)
        ├── SliderContent.vue        # slider (track + thumb)
        ├── BottomTabsContent.vue    # bottom tab bar (accent strip composited into capture)
        ├── DialogContent.vue        # glass dialog
        ├── LockScreenContent.vue    # media-style lock screen
        ├── ControlCenterContent.vue # iOS-style control center (shadow=null, vertical drag)
        ├── MagnifierContent.vue     # magnifier (backdrop zoom + refraction chain)
        ├── GlassPlaygroundContent.vue  # tunable glass playground
        ├── AdaptiveLuminanceGlassContent.vue  # luminance-adaptive glass
        ├── ProgressiveBlurContent.vue        # progressive blur
        └── ScrollContainerContent.vue / LazyScrollContainerContent.vue
```

---

## 5. Requirements & running

**Requires**: Node.js (developed/verified on Node 24) + `npm`.

```bash
# install dependencies
npm install

# start dev server (http://127.0.0.1:5173)
npm run dev

# type check (vue-tsc --noEmit)
npm run typecheck

# production build (vue-tsc then vite build; output in dist/)
npm run build

# preview the build (http://127.0.0.1:4173)
npm run preview

# userscript: syntax check / stage it into dist/ the way CI does (see §10.6)
npm run check:userscript
npm run stage:userscript
```

`density = 1`, so Kotlin `xx.dp` constants map 1:1 to CSS `px` with no conversion.

---

## 6. Porting conventions (hard rules)

1. **Animation values stay out of Vue reactivity**: `animationRevision` must be a `ref`; otherwise the whole page silently no-ops.
2. **`argb()` takes 8-digit ARGB** (`argb(0xff34c759)`); passing 6-digit hex yields alpha=0 (fully transparent).
3. **Omitting `highlight`/`shadow` ≠ disabling**: Kotlin defaults are `Highlight.Default` / `Shadow.Default`; default props must fall back to defaults (only ControlCenter explicitly passes `shadow = null`).
4. **Keep the 1:1 port**; any allowed deviation must be justified in a comment (e.g. ControlCenter's `onVerticalDrag` extension, Magnifier's Canvas 2D redraw passages).
5. **Add no decoration absent from the original**: the original is full-bleed with no phone bezel / back capsule (the top-left Back is the skiko `BackHandler`'s blue `LiquidButton`, already reproduced).
6. **Globally disable text selection**: `.app-root` uses `user-select:none` etc.; only `input/textarea/[contenteditable]` keep selection. Do **not** `preventDefault` selection in the gesture layer (it swallows the native `@click` that `RippleSurface` relies on).
7. **Paint both press-highlight branches**, and pass the **absolute local pointer coordinate** (not `offset`) as `highlightPosition()`'s second arg (upstream's lambda param is named `offset` but actually receives `positionAnimation.value`).
8. **For DOM glass, anything that "must not be sampled"**: either don't paint it there, or punch a hole yourself; overlaying a copy is useless — the original still leaks. Scaling a clipped capture layer changes shape, not color; don't drop it casually.
9. **Read state via animation values**, not the raw `fraction` (e.g. `LiquidToggle`'s `dampedDragAnimation.value`); reading state directly makes it "jump on click" instead of springing.

---

## 7. Browser compatibility

| Capability | Chromium (Chrome/Edge 76+) | Safari / Firefox |
| --- | --- | --- |
| `backdrop-filter: blur()/saturate()/brightness()` | ✅ | ✅ |
| `backdrop-filter: url(#svg)` (refraction) | ✅ | ❌ (declaration accepted, nothing painted) |
| `mix-blend-mode: plus-lighter` | ✅ | ⚠️ partial / needs fallback |

Refraction (`url()` inside `backdrop-filter`) is a **Chromium extension**. Therefore call sites **always keep an earlier plain `blur()` declaration** as the fallback; non-Chromium engines ignore `url()` and paint blur only. Chromatic-aberration capability is probed via `isRefractionSupported()` (UA sniff on `userAgentData.brands` or regex), because `@supports` mis-reports on engines that parse but don't paint.

---

## 8. Source mapping (excerpt)

| Web | Upstream Kotlin |
| --- | --- |
| `src/core/glass-filter.ts` | `Lens.kt` / `Shaders.kt` (refraction, `RoundedRectRefractionShaderString`, `…WithDispersionShaderString`) |
| `src/core/highlight-map.ts` | `HighlightStyle.kt` (AGSL `Ambient`/`Default` shaders) |
| `src/core/backdrop.ts` | `LayerBackdrop` family (reduced to Root/Empty) |
| `src/components/GlassSurface.vue` | Compose `Modifier` glass chain |
| `src/App.vue` | `MainContent.kt` + `BackHandler.kt` |
| `src/core/destinations.ts` | `CatalogDestination` |
| `src/core/animation.ts` | Compose `Animatable` / `InfiniteAnimationPolicy` |

---

## 9. Known limitations & future work

- Refraction is unavailable on non-Chromium browsers (degrades to plain blur).
- High-frequency filter maps are capped by a 32-entry LRU cache (`mapCache`).
- If a site's CSP restricts `img-src` (no `data:`), the `<feImage>` displacement maps are refused and it fails **completely silently** — see [§10](#10-userscript-liquid-glass-refraction).
- Headless environments (`--dump-dom`) starve `rAF`, so spring animations emit only a few frames — verify "is the animation running" by checking whether the inline transform changes over time, not by screenshots.
- Future: move `glass-filter` map generation into a Worker; add a WebGL refraction fallback for non-Chromium (if WebGL is permitted at that point).

---

## 10. Userscript (Liquid Glass Refraction)

`src/core/glass-filter.ts` is a **zero-dependency** module (the file contains not a single `import`), so it has been extracted into a directly installable userscript that turns **any element on any website** into a liquid-glass refracting lens.

### 10.1 Absolute URLs

It ships through this project's existing GitHub Pages workflow, so the script and the demo share one origin and one version — pushing to `main` syncs both:

| Purpose | Absolute URL |
| --- | --- |
| Script file (install / `@require` / `@updateURL`) | `https://someonehx.github.io/WebLiquidGlass/liquid-glass-refract.user.js` |
| Demo site (deploy root) | `https://someonehx.github.io/WebLiquidGlass/` |
| Source (in-repo, published with Pages) | `https://github.com/SomeoneHX/WebLiquidGlass/blob/main/userscript/liquid-glass-refract.user.js` |

> On the Pages side, `@version` is stamped by CI from the workflow run number (`0.2.<run_number>`), so every push produces a new version and installed copies update on the manager's next check. The in-repo file keeps a hand-written base version; `scripts/stamp-userscript.mjs` is the only place the two are allowed to diverge.

### 10.2 Three ways to include it

```js
// (1) Direct install (Tampermonkey / Violentmonkey): just open the script URL; @updateURL receives updates.

// (2) @require it from your own userscript:
// @require      https://someonehx.github.io/WebLiquidGlass/liquid-glass-refract.user.js
// @grant        none
// The API lands on window.LiquidGlassRefract (read it via unsafeWindow in sandboxed mode):
const { apply, unglassify } = window.LiquidGlassRefract
apply(document.querySelector('.header'), { blur: 12, refractionAmount: 30 })

// (3) Plain web page, straight <script src>:
// <script src="https://someonehx.github.io/WebLiquidGlass/liquid-glass-refract.user.js"></script>
```

The script **does nothing by default** (with no config it scans nothing and touches no element), so `@require`-ing it is safe; a second inclusion is ignored by its own load guard and will not double-bind listeners.

### 10.3 Configuration: assign `window.LiquidGlassRefractConfig` before the script runs

```js
window.LiquidGlassRefractConfig = {
  selectors: ['.header', 'nav'],     // selectors to auto-apply; empty = do nothing
  autoWatch: true,                   // follow SPA-inserted nodes with a MutationObserver (rAF-coalesced)
  hotkeys: { glassify: 'alt+shift+g', unglassify: 'alt+shift+u' },  // or false to disable
  defaults: { blur: 12, refractionHeight: 24 }   // merged into the default options
}
```

Hotkeys act on **the element currently under the cursor** (`document.elementFromPoint`, independent of focus); the combo string supports `alt` / `shift` / `ctrl` / `meta`.

### 10.4 API

| Method | Description |
| --- | --- |
| `apply(el, options?)` | Turn the element into a glass lens. Same function as `glassify`; `apply` is the public name |
| `glassify(el, options?)` | Same as above. Calling it again on the **same element** = update options (idempotent) |
| `unglassify(el)` | Undo: restore the previous inline styles, remove the `<filter>`, unregister the `ResizeObserver` |
| `applyAll()` | Sweep `selectors` immediately; returns the elements newly applied this pass |
| `isRefractionSupported()` | Engine probe (Chromium only) |
| `createGlassFilter()` | Low level: the SVG filter graph alone (`{ id, update(spec, amount, zoom?, overlay?), dispose() }`), you write the host |
| `activeCount()` | Number of live glass surfaces |
| `DEFAULTS` / `FILTER_PAD` / `config` / `version` | Default options, filter pad outset (64px), effective config, version |

Options accepted by `apply`:

| Option | Default | Meaning |
| --- | --- | --- |
| `blur` / `saturate` / `brightness` | `8` / `1.6` / `1.06` | Live in the same `backdrop-filter` as the refraction; they must come first, since a bare `url()` is silently ignored by Chromium |
| `refractionHeight` | `18` | How far in from the rim the bend reaches (px) |
| `refractionAmount` | `22` | Largest displacement at the rim (px); feeds `feDisplacementMap@scale` directly |
| `depthEffect` | `true` | Blend the centripetal direction into the bend gradient |
| `chromaticAberration` | `false` | Three-branch dispersion: 3 displacement maps + an 11-primitive filter graph |
| `maxArea` | `490000` | Area ceiling; above it the element is skipped with a warning (the SDF is per-pixel, per-branch, and janks the main thread on large elements) |

### 10.5 Before you use it

- **You must supply the tint yourself**: the script does not touch the element's own styles, so the element needs a translucent background (e.g. `background: rgba(255,255,255,.16)`) — otherwise you get the lens without the frosted colour;
- **Shape is `border-radius`**: the corner radius is read from computed style, so for a capsule write `border-radius: 50%` or a large radius; the displacement map is generated from the same geometry;
- **Chromium only**: Safari / Firefox drop the whole declaration containing `url()`; the script writes plain blur for those engines;
- **CSP is a hard gate**: if the page restricts `img-src` and disallows `data:`, the displacement maps are refused without an error (one `securitypolicyviolation` per `<feImage>`, but nothing in the console); the script detects this with a 1×1 PNG probe, degrades every surface to plain frosted glass, and `console.warn`s the reason. **What a refusal leaves on screen is pixel-identical to a plain `blur()` control** (measured 0 px of 57600), so what you lose is the lens itself plus the wasted SDF/PNG work — not a drawing error. Which sites actually hit this: see [§10.8](#108-measured-real-world-csp-spread);
- **Ancestors cut off the backdrop**: any ancestor with `filter` / `opacity < 1` / `mask` becomes a backdrop root, and the glass can only sample what is inside it;
- **Static lens**: this is the **filter layer** lifted out of `GlassSurface` — no drop shadow, highlights, press highlight, deformation, gestures or animation driver, so intensity changes require the caller to re-apply options.

### 10.6 Generating, checking and releasing

```bash
npm run check:userscript    # node --check syntax validation
npm run stage:userscript    # stamp and write dist/liquid-glass-refract.user.js the way CI does
npm run dev                 # verify in a browser (paste the script into a test page, see below)
```

To regenerate (when upstream `src/core/glass-filter.ts` changes), strip types with the project's own tsc — **never hand-copy the algorithm**:

```bash
./node_modules/.bin/tsc src/core/glass-filter.ts --target es2022 --module esnext --outDir /tmp/strip
# then drop the `export ` prefixes from /tmp/strip/glass-filter.js and splice it into section 1 of the script
```

Only **one line** in the script differs from the extraction source: `document.body || document.documentElement` in `svgRoot()`, so it can run before `<body>` exists (which is the case for `@require`).

### 10.7 Measured data (headless Chromium, 320×180 / r=28 / refractionHeight=22)

| Item | Result |
| --- | --- |
| Filter graph | 11 primitives, `scale 94.9 ｜ 52 ｜ 94.9`, `filterUnits=userSpaceOnUse`, `color-interpolation-filters=sRGB` |
| Displacement map | 448×308 (= element + `FILTER_PAD`×2), 17328 rim px of 137984, max deviation 111/127, `data:` URL ≈23 KB |
| Does refraction reach the screen | Changing only `refractionAmount` 0 → 34: 11995 px differ, maxdelta 77, diff bbox exactly the element box; differences are **entirely at inset ≤ 19px**, 0 px deeper than 20px, 0 px outside the box |
| CSP `img-src 'none'` | Maps refused (a `securitypolicyviolation` with `img-src`, one per map), `refractionAmount` 0→30 gives **0 px**; against a plain `blur()` control on the same page **0 px of 57600**, i.e. "frosted glass with no lens" |
| Inclusion idempotence | Including the script twice on one page: only 1 `<filter>`, hotkey log fires once |
| SPA follow-up | With `autoWatch: true`, a dynamically inserted matching node gets glass within one rAF |

---

### 10.8 Measured: real-world CSP spread

On 2026-09-12 we sampled the root-path response headers of ~70 sites, and ran the script's own probe (`new Image()` + a 1×1 `data:` PNG) in a real browser on four of them:

| Case | Sites (selection) | Lens |
| --- | --- | --- |
| `img-src` without `data:` | **stackoverflow.com** / serverfault.com / superuser.com (all `img-src 'self' https://challenges.cloudflare.com`), **pypi.org** | ❌ silent degrade |
| `img-src` with `data:` | github.com (`img-src 'self' data: blob: …`), gitlab.com, linear.app, vercel.com, nextjs.org (`img-src * blob: data:`), apple.com, www.icloud.com, atlassian.com, stripe.com, docs.qq.com, store.steampowered.com | ✅ |
| No CSP header on the root | developer.mozilla.org, news.ycombinator.com, google.com / youtube.com, x.com, reddit.com, npmjs.com, claude.ai, chatgpt.com, figma.com, notion.so, zhihu.com, bilibili.com, taobao.com, jd.com, weibo.com, douyin.com, slack.com, discord.com, twitch.tv, wikipedia.org | ✅ |

Real-browser probe results: `stackoverflow.com` → `data: refused`, `pypi.org` → `data: refused`, `github.com` → `data: loadable`, `developer.mozilla.org` → `data: loadable` — matching the header analysis.

Three reading notes:

- **`default-src` is `img-src`'s fallback**: a page that only sets `default-src 'self'` (no `img-src`) refuses the maps too; conversely github.com says `default-src 'none'` yet lets them through because of its explicit `img-src … data: …`.
- The table only reflects **root-path response headers**. A `<meta http-equiv="Content-Security-Policy">`, a policy sent only on some subpaths, or one added after an SPA route change will not show up — **the script's own probe is the authority** (it runs on the real page).
- A hit looks like "frosted glass, no lens" — it neither draws anything wrong nor reports an error. The single deciding question is whether that `data:` PNG can be decoded.

---

## ⚠️ Known Bugs (current build)

The following components are **known to contain bugs** in the current build; their glass deformation / capture compositing has **not** been verified pixel-correct against the upstream reference. **Do not use in production or rely on their appearance:**

- **Toggle (`LiquidToggle`)** — the thumb's glass deformation (`innerTransform` squash + velocity skew) and the "press-scaled track layer" punch-through (`trackInnerTransform` + `trackClipPath`) are among the most intricate glass effects in the catalog. The scaled track layer was once dropped under the wrong assumption that "a flat colour is scale-invariant" and has since been rebuilt, but it is **still flagged as buggy**; behaviour may diverge from the original (e.g. wrong track scaling / hole misalignment while pressed).
- **Bottom Tabs (`LiquidBottomTabs`)** — the indicator capsule composites a hidden accent-row snapshot into its glass capture via `captureOverlay`, and carves an evenodd black-row hole (`blackRowClip`) to keep the black glyphs from showing through. This "capture + clip" chain is fragile, and the **current implementation is flagged as buggy**; you may see misplaced accent content or the black row bleeding through.

> These two components are the priority fix targets.

---

## 🚧 Not yet implemented (current build)

The following components are **not yet complete** in the current build (key logic missing or only a skeleton in place); their glass effects differ substantially from the original, so **do not rely on their appearance:**

- **Lock screen / clock (`LockScreenContent`)** — the draggable lock-screen clock plate backed by an SDF texture. The original relies on the `clock_sdf` asset and `SdfShader`; this port has dropped the SDF-related capability, so the clock plate is not yet fully implemented.
- **Magnifier (`MagnifierContent`)** — the draggable lens over a paragraph, built on backdrop scaling + a refraction chain. The current implementation is incomplete; the lens's scaled sampling and refraction compositing do not yet match the original.
