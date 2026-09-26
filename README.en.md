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

The same chain also carries the refraction of a **baked SDF texture** (the lock-screen clock): there the displacement map is not derived from a rounded-rect analytically but decoded from the texture's `r` / `gb` channels, and the shape cut is a `mask-image` off the texture's alpha channel. See §9.

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
        ├── BottomTabsContent.vue    # bottom tab bar (glass indicator refracting the bar content)
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

# refraction probes (the first two are pure Node, zero dependencies; the last two use a real Chromium, `probe:fidelity` needs `npm run dev`)
npm run probe:map         # encoder model: the 8-bit ladder of the displacement map (§10.10)
npm run probe:band        # rim-band shortcut vs a full scan, byte for byte (§10.12)
npm run probe:render      # sampler: a phase ruler measures where samples actually land (§10.10)
npm run probe:fidelity    # render fingerprint of 13 destinations, for A/B across a change (§10.12)
```

`density = 1`, so Kotlin `xx.dp` constants map 1:1 to CSS `px` with no conversion.

The three browser-driving modes (`probe:render` / `probe:fidelity` / `probe:perf`) find their own
Chromium — newest-first through the version caches of `~/.agent-browser`, playwright and puppeteer —
or take one via `CHROME_PATH`.

---

## 6. Browser compatibility

| Capability | Chromium (Chrome/Edge 76+) | Safari / Firefox |
| --- | --- | --- |
| `backdrop-filter: blur()/saturate()/brightness()` | ✅ | ✅ |
| `backdrop-filter: url(#svg)` (refraction) | ✅ | ❌ (declaration accepted, nothing painted) |
| `mix-blend-mode: plus-lighter` | ✅ | ⚠️ partial / needs fallback |

Refraction (`url()` inside `backdrop-filter`) is a **Chromium extension**. Therefore call sites **always keep an earlier plain `blur()` declaration** as the fallback; non-Chromium engines ignore `url()` and paint blur only. Chromatic-aberration capability is probed via `isRefractionSupported()` (UA sniff on `userAgentData.brands` or regex), because `@supports` mis-reports on engines that parse but don't paint.

---

## 7. Source mapping (excerpt)

| Web | Upstream Kotlin |
| --- | --- |
| `src/core/glass-filter.ts` | `Lens.kt` / `Shaders.kt` (refraction, `RoundedRectRefractionShaderString`, `…WithDispersionShaderString`) |
| `src/core/sdf-texture.ts` | `SdfShader.kt` + `SdfShaderString` (the lock-screen clock's baked SDF texture; see §9) |
| `src/core/highlight-map.ts` | `HighlightStyle.kt` (AGSL `Ambient`/`Default` shaders) |
| `src/core/backdrop.ts` | `LayerBackdrop` family (reduced to Root/Empty) |
| `src/components/GlassSurface.vue` | Compose `Modifier` glass chain |
| `src/App.vue` | `MainContent.kt` + `BackHandler.kt` |
| `src/core/destinations.ts` | `CatalogDestination` |
| `src/core/animation.ts` | Compose `Animatable` / `InfiniteAnimationPolicy` |

---

## 8. Known limitations & future work

- Refraction is unavailable on non-Chromium browsers (degrades to plain blur).
- High-frequency filter maps are capped by a 96-entry LRU cache (`mapCache`).
- If a site's CSP restricts `img-src` (no `data:`), the `<feImage>` displacement maps are refused and it fails **completely silently** — see [§10](#10-userscript-liquid-glass-refraction).
- Headless environments (`--dump-dom`) starve `rAF`, so spring animations emit only a few frames — verify "is the animation running" by checking whether the inline transform changes over time, not by screenshots.
- **Large-area glass is still expensive, and the cost sits in one place**: every glass surface maintains its own filter graph for `backdrop-filter` (SDF → displacement map → `feImage` + `feDisplacementMap`), and **only the `url(#…)` displacement graph spends frame time** — drop it and 20 surfaces go from 8.5 fps to 63 fps, the same speed as hiding every glass layer. The constraint is therefore the **count and area of refractive surfaces on screen**, not JS or layout; measurements, definition and the waste already removed are in [§11](#11-performance).
- Upstream's `colorControls` `brightness` is **additive** (it lands in the colour matrix's constant term, `t = (0.5 − 0.5c + brightness)·255`) while CSS `brightness()` is **multiplicative**; CSS `contrast(0.75)` carries a constant of 31.875 against upstream's 6.375, so mid-grey reads about 6% bright. The clock plate now implements it exactly in the filter with `feColorMatrix` (see §9); **every other page still uses the CSS form**.
- Future: move `glass-filter` map generation into a Worker; add a WebGL refraction fallback for non-Chromium (if WebGL is permitted at that point).

---

## 9. The clock plate: refracting a baked SDF texture (`LockScreenContent`)

The "12:45" on the original lock screen is not text — it is a **baked SDF texture** (`clock_sdf`, 1599×515) pushed on screen by `SdfShader.apply(48.dp, 45f)`. Channel conventions (authority: the AGSL source `SdfShaderString`; every number below was measured):

| Channel | Meaning | Measured |
| --- | --- | --- |
| `r` | signed distance `sd = r/255·2 − 1`, neutral 128 outside the shape | 33.6% inside |
| `gb` | unit normal `normalize(gb/255·2 − 1)` | mean `\|n\|` after remap = **1.005** |
| `a` | shape mask `smoothstep(0.5, 1, a)` | 54.7% clear / 31.2% opaque / 14.1% soft edge |

The shader only acts where `sd < 0` (inside): `intensity = circleMap(1 − min(1, −sd·1.5))` is 1 at the boundary and decays to 0 by `sd = −0.667`, so the effective refraction band is **R ∈ (42.5, 127.5)** — structurally the same rim band as `lens()`, only the shape is no longer an analytic rounded rectangle.

The web side is **three exact substitutions, not an approximation** (decoding in `src/core/sdf-texture.ts`; the filter branch is `spec.sdf` in `glass-filter.ts`):

| Upstream shader | Web | Why it holds |
| --- | --- | --- |
| `content.eval(refractedCoord)` | `feDisplacementMap` reading a displacement map **decoded from the texture** | the bitmap is the very same format `lens()` uses — only the source of `sd` and the normal changed |
| `content.eval(...) * v.a` | `mask-image: url(clock_sdf.webp)` on the lens | the texture's alpha channel **is** `v.a`; pointing at the original asset keeps the glyph outlines at full resolution |
| two `color.rgb *= 1 + k` terms | one `α` multiplier image + `feComposite arithmetic k1=1 k3=1` | `k1·map·color + k3·color = color·(1+α)`; both terms collapse into a single `1+α`, the cross term is identically 0, so `α ∈ [0, 0.5]` never clips |

The 25% white in `onDrawBackdrop` is a `feFlood` + `feComposite operator="over"` (`GlassSurface`'s `backdropWash`) and **has to stay inside the filter graph**: upstream it is recorded into the same graphics layer, so the shader's `* v.a` cuts it to the glyphs. Routed through `onDrawSurface` instead, it becomes a white rectangle over the whole 400×129 box.

### 9.1 Page-level scrims: `backdropScrim`

The 30% black that dims the whole screen (`Column(Modifier.background(Black.copy(0.3f)))`) is **not** in the backdrop the plate samples: `BackdropDemoScaffold` puts `layerBackdrop(backdrop)` on the wallpaper `Image` alone, the scrim is its sibling painted afterwards, and `LayerBackdropNode.draw()` records only that one `drawContent()`. So upstream the glyphs refract the **raw wallpaper** (bright) while everything around them is dimmed — that is where the "light through engraved glass" comes from.

`backdrop-filter` samples **everything physically behind**, scrim included, so the glyphs get dimmed twice and the plate collapses into a flat tint lying on the wallpaper. Since the contamination is one constant multiplication (`rgba(0,0,0,a)` over `W` gives `(1−a)·W`), it can be divided back out after sampling: `GlassSurface`'s `backdropScrim` → `RefractionSpec.backdropGain = 1/(1−a)` → one **stand-alone** diagonal `feColorMatrix` at the head of the chain.

- It has to be **first**: the contamination is at the input of the blur, and blur is linear (`blur((1−a)·W) = (1−a)·blur(W)`), so undoing it after the blur is still exact.
- It has to be **stand-alone**: the wash is an `over` composite (matching it would need a coefficient of `0.75/0.7 > 1`, which `over` cannot express), and the colour matrix further down carries `colorControls`.
- **Nothing clips**: the scrim has already pushed values down to `≤ 178.5`, and `× 1/0.7` lands exactly back at `≤ 255`; the only residue is the scrim's own 8-bit quantisation (`≤ 0.7` code values).
- Only a declaring destination produces that primitive (`hasGain` is part of the graph-shape cache key), so the other 12 destinations gain no primitive at all.

> ⚠️ **The counter-example** is `ControlCenterContent`'s `dimColor`, whose meaning is the opposite: upstream that dim lives in `drawWithContent { drawContent(); drawRect(dimColor) }`, **inside** `layerBackdrop`, and the glass is *supposed* to sample it.

### 9.2 Known differences

- The clock is a **static face** (upstream bakes exactly this "12:45" texture; it was never a running clock). Making it tick is a matter of amortisation: at second-hand rates (once a second) the cost is about **0.13 ms per frame** and can be ignored; per-frame animation (rolling digits) costs about **468 ms per second** and is not viable — replacing an `feImage` `href` re-rasterises the whole filter graph.
- `colorControls` only goes into the filter (`feColorMatrix`) on this SDF path. **Every other page still uses the CSS multiplicative `brightness`**, which differs from upstream's additive semantics by a constant 25.5 — see [§8](#8-known-limitations--future-work).
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

The script **does nothing by default** (with no config it scans nothing and touches no element), so `@require`-ing it is safe; a second inclusion is ignored by its own load guard and will not double-bind listeners. It is also **concatenation-safe** — a semicolon guards each end, for the reasons in §10.6.

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
npm run check:userscript    # syntax + concatenation safety + version agreement (see below)
npm run stage:userscript    # stamp and write dist/liquid-glass-refract.user.js the way CI does
npm run dev                 # verify in a browser (paste the script into a test page, see below)
```

To regenerate (when upstream `src/core/glass-filter.ts` changes), strip types with the project's own tsc — **never hand-copy the algorithm**:

```bash
./node_modules/.bin/tsc src/core/glass-filter.ts --target es2022 --module esnext --outDir /tmp/strip
```

There are exactly two post-processing steps: drop the **leading** `export ` prefixes (three of them: `FILTER_PAD` / `isRefractionSupported` / `createGlassFilter`), and the `svgRoot()` line below.

**Do not hard-code the line range of section 1** — locate it with the same markers the probe uses: from the nearest preceding `/*` before `/** SVG refraction filter for`, to the nearest preceding `/*` before `* 2. Userscript host`. Before splicing, run **invariant checks** (no surviving leading `export `, the documented `svgRoot()` deviation present, `NEUTRAL_WORD` / `buildMap` / `createGlassFilter` present) and refuse to write if any fails.

Afterwards, always run: `npm run check:userscript` + `npm run probe:band` + `npm run probe:render`.

⚠️ **The core must not depend on `ctx.canvas`**: `probe:map` evaluates section 1 in Node against a fake DOM whose canvas `getContext()` provides **only** `createImageData` / `putImageData`, with **no `canvas` back-reference** — `ctx.canvas.toDataURL(...)` kills `npm run probe:map` outright (`TypeError: ... reading 'toDataURL'`). Return the **element itself** from the helper instead of going through `ctx`.

Only **one line** inside section 1 differs from the extraction source: `document.body || document.documentElement` in `svgRoot()`, so it can run before `<body>` exists (which is the case for `@require`).

**Concatenation safety rests on two semicolons**, both in the hand-maintained head/tail outside section 1, so re-syncing never touches them:

- **Front**: the whole script is one IIFE and its first token is `(` — precisely the token ASI will *not* separate from the line above. If the preceding line is `someCall()`, the two parse as `someCall()(function () { … })()`, calling the return value. The file therefore opens with `;(function () {`.
- **Back**: the closing `})()` must be terminated, or a statement following it that begins with `(` is absorbed into it.

Both merges are **syntactically valid** — `node --check`, and any parser, cannot tell them apart; only the source text can. `npm run check:userscript` (`scripts/check-userscript.mjs`) therefore asserts those two spots **textually**, and checks that `@version` and `const VERSION` agree.

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

### 10.9 The displacement zero point: why the content shifts up-left

`feDisplacementMap` computes `scale × (value/255 − 0.5)`, so the exact zero point is **127.5** — which an 8-bit channel cannot express. Writing 128 leaves a constant **+0.5 LSB = +`scale/510` px** on the whole map, sampling toward (+x, +y): the sample point lands right and below, so the lens content, background included, reads as shifted **up-left**. Skia's raster path is literally that expression (`src/effects/imagefilters/SkDisplacementMapImageFilter.cpp`):

```cpp
const SkVector scaleForColor = SkVector::Make(scale.fX * Inv8bit, scale.fY * Inv8bit);
const SkVector scaleAdj = SkVector::Make(SK_ScalarHalf - scale.fX * SK_ScalarHalf, ...);
SkScalar displX = scaleForColor.fX * ex.getX(*displPtr) + scaleAdj.fX;  // = scale × (v/255 − 0.5) + 0.5
const int srcX = x + SkScalarTruncToInt(displX);                        // truncation, integer fetch
```

**For that constant to reach the screen it first has to survive the rasteriser's rounding.** Measured with a linear-gradient backdrop, 24 000 px averaged (~0.02 px resolution), on the script in this repo (`scale = 2 × amount`):

| amount | ≤126 | 127 | 128 … 382 | 383 … |
| --- | --- | --- | --- | --- |
| Constant term (theory) | ≤0.494 | 0.498 | 0.502 … 1.498 | 1.502 … |
| Measured shift | **0.000 px** | 0.63 px (knife edge, some pixels only) | **1.01 px** | **2.02 px** |

The staircase strides 255 in `amount` (510 in scale), and screenshots inside one plateau are **byte-identical** (scale 255 and 764 render alike; the jump to 2 px starts at 765) — the result is a **whole-pixel staircase**, not a sub-pixel drift that grows with `amount`. Two independent checks say this chain does not interpolate: a 1 px checkerboard backdrop keeps its contrast at every scale (std 110.42 / p2p 255), and screenshots at integer shifts are byte-identical. A residue in the sub-pixel range produces no visible change, but the offset itself does not vanish: at `amount ≤ 126` the lens interior is pixel-identical, and once `amount` passes 127 **the whole interior translates by one whole pixel and stays there**. No component in the catalog reaches that, **the playground does** — see §10.11.

> A fidelity fact that matters far more than the zero point: Chromium **quantises the displacement to whole pixels and does not interpolate the sample**, whereas the Android original samples at float coordinates — `float2 refractedCoord = coord + d * grad; return content.eval(refractedCoord);` (`RoundedRectRefractionShaderString` in `backdrop/src/commonMain/kotlin/com/kyant/backdrop/internal/Shaders.kt`). The original has neither a zero-point bias nor a quantised field; on the web the rasteriser only moves whole pixels. That is the real fidelity ceiling of this port, and it has nothing to do with the 0.5 LSB term. (§10.10 turns "in this environment" into **"on a real GPU too"**: headless runs through ANGLE Metal on an AMD Radeon RX 570, not a software rasteriser.)

### 10.10 Reproducing the measurement: the lattice is 1 device pixel, the rim cliff is `amount × √(2/bezel)`

Everything above is reproducible with one dependency-free script — CDP over the built-in `WebSocket`, PNG decoded with the built-in `zlib` — which evaluates the core **as committed inside the userscript**, with no second copy of the implementation:

```bash
node scripts/refraction-probe.mjs map                    # encoder: the 8-bit ladder per catalog spec
node scripts/refraction-probe.mjs render --dpr=1         # sampler: real Chromium, s(x) from a phase ruler
node scripts/refraction-probe.mjs render --dpr=2         # the same page at 2x density
node scripts/refraction-probe.mjs render --bg=checker --blur=1   # pre-displacement blur vs the rim seam
```

The sampler mode swaps the backdrop for a ruler that rises linearly in device px — `(3x) mod 256`, an exactly integral slope, phase-staggered per row so the sawtooth resets land on a different column on every row and the per-column median discards them — which makes each output column's sample position recoverable. `amount = 32, refractionHeight = 18`:

| dpr | integer offsets walking inward from the rim (device px, one entry per plateau) | plateaus | largest adjacent jump |
| --- | --- | --- | --- |
| 1 | 32@0 21@1 17@2 14@3 12@4 10@5 8@6 7@7 5@8 4@9 3@10 2@12 1@13 0@16 | 14 | **11.00 px = 11.00 CSS px** |
| 2 | 48 59 48 41 37 33 30 28 25 23 21 19 17 16 14 13 11 10 9 8 7 6 5 4 3 2 1 0 | 28 | **11.00 px = 5.50 CSS px** |

Every plateau lands **exactly** on the integer device-pixel lattice (residual 0.000 px; at `amount = 0` the whole map is a zero displacement and matches the lens-free reference pixel for pixel): the sample is rounded to a whole device pixel, not interpolated. **Plateau count scales with `amount × dpr` and each step shrinks accordingly** — the one free improvement a high-density display gives you. The leading three columns at dpr 2 (48 / 59 / 48) are not plateaus: the displacement map itself is a **CSS-pixel**-resolution bitmap, bilinearly upscaled at a non-integer scale, so the cliff is smeared across the outermost two device columns; at dpr 1 the map and the device grid coincide, so the outermost column reads a clean `amount`.

The bezel height is the only geometric knob that shrinks the cliff (`amount = 32`):

| refractionHeight | 6 | 12 | 18 | 24 | 48 |
| --- | --- | --- | --- | --- | --- |
| first step (measured) | 18.00 | 13.00 | 11.00 | 9.00 | 7.00 |
| plateaus (measured) | 7 | 11 | 14 | 17 | 19 |
| `amount·√(2/bezel)` | 18.5 | 12.8 | 10.5 | 9.1 | 6.5 |

Because `circleMap`'s `1−√(1−t²)` has infinite slope at `t→1`, the outermost column always takes the **whole** `amount` while its neighbour takes only `falloff(−1) = 1−√(2/bezel − 1/bezel²)`; the difference is the cliff. The original AGSL has the same cliff (sampling continuously just draws a line between two samples `amount` apart), so **this is not a web error — it is the design of `Shaders.kt`**, and `refractionHeight` is a 1:1 Kotlin parameter, so changing it is a deliberate divergence.

A `blur` ahead of the displacement is the only lever that lowers visibility without touching the geometry. On a 1-device-px checkerboard at `amount = 14/32`, measuring the first rim column against the last column outside:

| Pre-displacement blur | 0 px | 0.5 px | 1 px | 2 px | 4 px |
| --- | --- | --- | --- | --- | --- |
| Rim seam contrast (levels) | 127.5 | 84.8 | 64.0 | 64.0 | 64.0 |
| Backdrop texture outside the lens (control) | 255.0 | 255.0 | 255.0 | 255.0 | 255.0 |

That control row is the invariant: `blur` only touches the backdrop *behind* the element, so the checkerboard outside the lens keeps full contrast. One pixel therefore captures most of the benefit and it saturates after that — which is the opposite of what three animated components do: `LiquidToggle` / `LiquidSlider` use `blur(dp(8) × (1 − progress))`, so **at full press the blur is zero exactly when the lens is strongest**, the worst cell of the grid.

### 10.11 The whole pixel you can actually see in the playground

`GlassPlaygroundContent` drives `refractionAmountFraction × minDimension` on a `256 × 256` hero card, so `amount` reaches **256** and `scale = 2 × amount` crosses the 255 knife edge at **fraction 0.5** — the zero-point offset of §10.9 is plainly visible there:

```
$ node scripts/refraction-probe.mjs render --probe=shift --bg=noise \
    --size=256x256 --radius=128 --lens=300,120 --bezel=25.6 --depth \
    --amounts=0,120,127,128,255,382,512
amount | scale | neutral bias | predicted | sample offset | content shift | rms
     0 |    0.0 |  0.0000 px |   0 px | (  0,   0) | (  0,   0) | 0.00
   120 |  240.0 |  0.4706 px |   0 px | (  0,   0) | (  0,   0) | 0.00
   127 |  254.0 |  0.4980 px |   0 px | (  1,   1) | ( -1,  -1) | 0.00
   128 |  256.0 |  0.5020 px |   1 px | (  1,   1) | ( -1,  -1) | 0.00
   255 |  510.0 |  1.0000 px |   1 px | (  1,   1) | ( -1,  -1) | 0.00
   382 |  764.0 |  1.4980 px |   1 px | (  2,   2) | ( -2,  -2) | 0.00
   512 | 1024.0 |  2.0078 px |   2 px | (  2,   2) | ( -2,  -2) | 0.00
```

`sample offset` is where each output pixel reads from, so **the content moves to (−1, −1) — up and left**; `rms 0.00` means the lens interior is **byte-identical** to the backdrop translated by one pixel: no blur, no interpolation, a rigid whole-pixel copy. The knife edges land at `amount 127` and `382` (one channel earlier than the ideal 127.5 / 382.5, which is the rasteriser's own rounding — 0.002 LSB). As a picture: at `amount 0` all nine cells are `(0,0) rms 0.0`; at `amount 128` the **four interior cells all flip to `(1,1) rms 0.0`**, and only the edge cells keep a high `rms` of 80–90 — there the displacement field genuinely varies, so a "rigid shift" is meaningless.

So "it looks smooth" and "it is arithmetic on a whole-pixel lattice" are both true: the slider has exactly **three states, 0 → 1 → 2 px**, and **a rigid 1 px step of everything at once has no visible edge** — especially while you are dragging the slider. The impression of a continuously growing pull comes from the rim band (the `rms` 80–90 cells): there the content is pushed outward, growing linearly with `amount`, and on the bottom-right side that reads as being dragged toward the bottom-right corner.

### 10.12 Regression checks: `probe:band` and `probe:fidelity`

§10.10 and §10.11 answer "what does the refraction **look like**". This section answers "**did a change quietly alter it**". The reason is direct: every "same output, less work" optimisation in `glass-filter.ts` — a displacement map that only scans the rim band, writes that are skipped when the value is unchanged, decoration canvases that are not repainted while scrolling — is a claim about **equality**, and no screenshot can substantiate one.

```bash
npm run probe:band        # pure Node, zero dependencies, no browser and no dev server; usable as a CI gate
npm run probe:fidelity    # needs `npm run dev` first; a render fingerprint of 13 destinations × 7 fields
```

**`band`**: `buildMap` no longer walks the whole padded region, only the rows and columns its SDF bound admits. That bound is a product of **reasoning**, and reasoning can be wrong — a band that is too tight silently drops real rim pixels, the refraction goes subtly wrong, and nothing else in the repo notices (the map still encodes, the filter still runs, the tests still pass). So it is checked against a **full scan**: `sdf` / `gradSdf` / `clampByte` come from the shipped core (exposed by `loadCore`), i.e. the oracle re-states **only the part under test — the loop structure** — and not the maths. The neutral word is likewise **read back out of the shipped bitmap** rather than re-declared, so changing it cannot make the two implementations agree on the wrong answer.

12 geometries × spectral branches, compared byte for byte. There are two easy ways to get that bound wrong, and the script's comments carry one of each:

| Mistake | Consequence |
| --- | --- |
| Using `d ≥ max(qx,qy) − r` as a lower bound | the inequality holds, but it does not imply `max ≥ r − bezel` → **the diagonals just outside a rounded corner are dropped** |
| An exclusive upper bound `to = w` on the right edge | `d` is exactly 0 at `x = w`, and 0 is inside the rim test → **the last column is dropped** |

Re-inject the second one and `band` reports `NO` immediately, naming the first differing pixel as `x = 1408, y = 32` — the test has teeth, and it localises.

**`fidelity`**: fingerprints 7 fields on all 13 destinations — `feImage` href hashes, primitive boxes, `feDisplacementMap[scale]`, `<filter>` regions, computed lens styles, decoration-canvas CSS box + transform + blend + display, and the surface count. Record, change one thing, compare:

```bash
node scripts/refraction-probe.mjs fidelity --write=/tmp/base.json
# ...make one change...
node scripts/refraction-probe.mjs fidelity --baseline=/tmp/base.json   # exit 1 on any mismatch
```

Two honest boundaries:

- It is an **A/B tool, not a gate**. The fingerprint covers the **bytes** of the displacement maps, so repeat runs of one build agree exactly (verified), but it is tied to the renderer version — a browser update legitimately changes it. Hence "record a baseline → change one thing → compare", not a constant assertion in CI.
- The canvas field **excludes `canvas.width/height`**. Those two values are the **culling state**: an off-screen surface has released its backing store, and which surfaces are off screen at the sampling instant depends on how far the frame loop had got — observed for real as a disagreement between two runs of the same build on the 102-surface screen. The CSS box, transform, blend mode and display value are layout-driven and do not move with culling, so they catch a compositing change without also catching the clock. The live-canvas count is printed as information and is **not** compared.

`fidelity` starts a **fresh browser per destination**: reusing one tab stops the renderer answering `Runtime.evaluate` altogether after the third or fourth screen (reproducible by hand, by mounting and unmounting a few glass screens). Cold start is a couple of seconds, negligible next to a fingerprinted screen. A destination that fails is recorded, skipped, and makes the exit code non-zero — **a skipped destination is not a pass**.

## 11. Performance

One command reproduces every number below (needs `npm run dev` first):

```bash
npm run probe:perf
```

The definition: the 20 full-width glass rows of `ScrollContainer`, scrolled **one step per animation
frame**, 30 frames. That definition is load-bearing — the scroll only advances when a frame is
produced, **so the time the scroll takes is the frame budget**. Measured as "frames in a time window"
instead, a slow build spends the whole window scrolling while a fast one finishes early and idles,
which flatters the wrong side. Three passes per state, median reported, spread printed too.

Test machine: **Intel Xeon E3-1230 v2 (8 threads) + AMD Radeon RX 570**, headless Chromium on
macOS 15.7.5 — the same ANGLE Metal rasteriser `probe:render` prints.

| state | fps (3 passes) | scroll took | main thread | filter attr writes | canvas ops |
| --- | --- | --- | --- | --- | --- |
| as shipped | **8.5** (6.9–9.2) | 3531 ms | 2.9% | **0** | 154 |
| `url(#…)` dropped, `blur/saturate/brightness` kept | **63** (62–63.1) | 476 ms | 17.1% | 0 | 154 |
| every glass layer hidden | **63** (62.9–63.7) | 476 ms | 13.3% | 0 | 154 |

Two things fall straight out of it:

1. **The entire frame cost is the SVG displacement graph.** Dropping `url(#…)` runs at exactly the
   same speed as hiding the glass layers (63 = 63, both 476 ms) — plain
   `blur() saturate() brightness()` is **essentially free** at this size and count.
2. **Low fps next to low main-thread time means rasterisation, not JS.** The shipped row uses 2.9% of
   the main thread and still only manages 8.5 fps, while the two 63 fps rows report *higher* main-thread
   shares (in the teens) because their wall clock is short and the same JS is divided by a smaller
   denominator. Any guess of the form "the JS must be too slow" is settled by those two columns.

(§10.10 / §10.11 describe what the refraction **looks like**; this section describes what it **costs**.
Same probe.)

### 11.1 Doing only what a frame needs

This chain only ever does "same output, less of it" — **nothing is degraded**: refraction stays
fully active while scrolling.

| Where | What it does |
| --- | --- |
| `glassFilter.update()` | remembers the last `feDisplacementMap[scale]` per node and skips a same-value write — a scroll changes none of its inputs (the `fe writes = 0` column above). A filter-primitive write dirties the filter |
| `buildMap` | scans only the rows and columns the bound admits, with one `Uint32Array.fill` for the neutral word; a full-scan oracle over 12 geometries is §10.12 |
| `MAP_LIMIT` | 96 (one chromatic-aberration press asks for 18 entries, so 32 evicted its own working set) |
| `isRefractionSupported()` | memoised |
| `GlassSurface` style writes | transform / clip-path / mask gradient / `backdrop-filter` skipped when unchanged |
| the three decoration canvases | skipped unless the paint signature moved (the `canvas ops = 154` / 30 frames column) |

**The other cost**, in the same command's second scene: holding a `Toggle` for 1.5 s rebuilds 15–18
displacement maps, of which **63–80 ms is inside `canvas.toDataURL`** — a synchronous PNG encode on
the main thread. It is spread across the dozen frames of the press animation, so frame rate does not
show it (and §10.12's `fidelity` is unaffected), but it is the one place on that screen that comes
close to a visible hitch. Lowering it further is a trade-off either way: move the encode off the
frame (`OffscreenCanvas.convertToBlob` + `URL.createObjectURL`, writing `href` when it resolves —
but `blob:` is accepted by fewer CSPs than `data:`, which costs the userscript usable sites), or
pre-generate a ladder per `refractionHeight`.

### 11.2 What is not solved

The `url(#…)` displacement map is re-rasterised by the browser every frame, and **that scale is not
negotiable**: 8.5 fps is the current price, 63 fps is the price of not refracting. The count and area
of refractive surfaces on screen is therefore a hard budget. `FILTER_PAD` (a global 64) makes the
filter region larger than the element itself — a 1408×160 row is rasterised as 1536×288 — so
shrinking it per surface buys some back, but not a different order of magnitude.

Any further headroom on this carrier comes from **rasterising less** (fewer refractive surfaces on
screen, or smaller ones), not from faster JS. The other obvious route — dropping `backdrop-filter`
and painting the backdrop yourself — would recover the magnitude, but it requires the application to
know what the backdrop *is*, and the entire point of `backdrop` is refracting what is **genuinely
behind** it (§3.3), not the application's own wallpaper; it also does not carry over to the
userscript's arbitrary-site case.

---

## ⚠️ Caveats (host page constraints)

These are not implementation defects in this library but inherent constraints of `backdrop-filter` and `mix-blend-mode` in browsers. If the host page violates them, the glass is "still there but no longer refracting" — check these first when debugging.

### A glass surface must not sit inside a `position: fixed` container

The `additive` layer uses `mix-blend-mode: plus-lighter` (the CSS twin of `BlendMode.Plus`). `mix-blend-mode` needs an isolated group to define what it blends with, and the boundary of that group is its **nearest stacking context ancestor** — which is also a backdrop root, so `backdrop-filter` can sample no further than it.

`position: fixed` **always** creates a stacking context, independently of `z-index`. Once a glass surface is wrapped in a `fixed` container, its `lens` can only sample that container's own contents (the glass itself), and the `url()` refraction stops working.

- Symptom: the glass keeps its CSS blur but loses the edge bend; the `LiquidBottomTabs` indicator degenerates into a flat grey pill.
- Fix: to pin the glass to the viewport, use `position: absolute` inside a container that does not scroll and does not itself create a stacking context — and do not give it a `z-index`, which would create one again.

### A glass ancestor must not clip with rounded corners

An ancestor with `overflow: hidden` (or `clip`) combined with a non-zero `border-radius` makes Chromium skip the SVG-filter half of `backdrop-filter`, and the `lens` samples nothing. A square clip is not affected: setting the radius to 0 while keeping the clip restores it.

### Nested glass belongs in a sibling layer of the surface

`GlassSurface`'s content layer carries the shape's `clip-path`, and a clipped ancestor cuts off a nested glass's backdrop capture. Put the inner glass alongside the outer surface, layered on top (which is how the `LiquidBottomTabs` indicator does it), or under an ancestor that does not clip.

---

## ⚠️ Known Bugs (current build)

The following components are **known to contain bugs** in the current build; they do not match the upstream reference. **Do not use in production or rely on their appearance:**

- **Toggle (`LiquidToggle`)** — while pressed, the thumb's glass is meant to see a *scaled copy* of the track, so the real track drawn underneath is punched out along the thumb's outline (`trackClipPath` subtracts a reversed `thumbHolePath` from `TRACK_OUTLINE` under the nonzero rule). The hole is a `clip-path` and its edge is anti-aliased: partially covered pixels still carry track colour, the glass samples them along with everything else, and a ring of residue is left along the thumb's edge.

> This component is the priority fix target.

---

## 🚧 Not yet implemented (current build)

The following components are **not yet complete** in the current build; their glass does not match the original, so **do not rely on their appearance:**

- **Magnifier (`MagnifierContent`)** — the lens magnifies what sits **behind the lens itself** (`backdrop-zoom` takes 1.5× about the lens centre), whereas the original magnifies the region **around the cursor**: the lens floats 80 dp above the cursor, and `withTransform { scale(1.5f); translate(top = -80f.dp.toPx()) }` inside `onDrawBackdrop` lands the magnified content on the cursor — the magnified cursor included. `backdrop-filter` only samples pixels inside the element's own rect, so what the web build shows under the lens is a different piece of content.
