#!/usr/bin/env node
/**
 * Vendor the framework-free part of this repo into another project — no npm publish, no build step.
 *
 *     node scripts/vendor-liquid-glass.mjs <targetDir> [--with-kit]
 *
 * e.g. from the repo root:
 *     node scripts/vendor-liquid-glass.mjs ../my-app/src/glass --with-kit
 *
 * `--with-kit` also copies `src/kit/` — the productized controls (GlassButton / GlassSwitch /
 * GlassSlider) that add native semantics on top of the demo widgets. Without it you get the ported
 * visuals plus the `core` engine and write your own shell; with it the controls are ready to use.
 *
 * What it does
 * ------------
 * 1. Copies `src/core/**` (17 files, zero deps, zero framework), the composables the glass
 *    components need, and the glass components themselves.
 * 2. Rewrites every `@/...` specifier into a **relative** path. The vendored tree therefore has no
 *    alias requirement at all, and — more importantly — cannot collide with the host project's own
 *    `@` alias, which is the single biggest reason a "just copy the folder" attempt fails.
 * 3. Emits three extra files that are *not* optional:
 *      glass.css   — the shared layout rules that live in this repo's global `style.css` rather
 *                    than in the components' own scoped blocks. `LiquidBottomTabs` has NO scoped
 *                    rule for `.liquid-bottom-tabs__row`; without this file the tab row is 0-tall.
 *      index.ts    — barrel re-export so call sites read `import { LiquidButton } from './glass'`.
 *      USAGE.md    — the recipe + the platform caveats, kept next to the code.
 * 4. Verifies its own output: every rewritten specifier must resolve to a file it just wrote.
 *
 * Dropped on purpose (demo-only, would drag the catalog in): `destinations.ts`, `assets.ts`,
 * `BackdropDemoScaffold.vue`, `FlightIcon.vue`, `useWallpaper.ts`, and `views/`.
 * If the host needs `RootBackdrop`, it comes from `core/backdrop` — a bare marker, no provider.
 *
 * Re-run this after pulling upstream changes: it overwrites, it does not merge. Keep the target
 * directory free of hand edits, or put host-specific glue in a separate file.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(REPO_ROOT, 'src')

/* ------------------------------------------------------------------ what gets copied -------- */

/** `src/core/**` minus the two demo-only modules. Order is irrelevant; it is copied verbatim. */
const CORE_FILES = [
  'animation.ts',
  'backdrop.ts',
  'color.ts',
  'damped-drag-animation.ts',
  'drag-gestures.ts',
  'draw-backdrop.ts',
  'geometry.ts',
  'glass-filter.ts',
  'highlight-map.ts',
  'interactive-highlight.ts',
  'math.ts',
  'progress-converter.ts',
  'shapes.ts',
  'transform-gestures.ts',
  'velocity-tracker.ts'
]

/**
 * `backdrop-context.ts` is needed by the kit: `kit/context.ts` reuses the demo's
 * `createThemeController()` rather than growing a second, possibly-disagreeing theme implementation.
 */
const COMPOSABLE_FILES = ['useElementMetrics.ts', 'useFrameValue.ts', 'useTap.ts', 'backdrop-context.ts']

/** Every one of these depends only on `core/` + the composables above. */
const COMPONENT_FILES = [
  'GlassSurface.vue',
  'LiquidButton.vue',
  'LiquidToggle.vue',
  'LiquidSlider.vue',
  'LiquidBottomTabs.vue',
  'LiquidBottomTab.vue',
  'RippleSurface.vue'
]

/**
 * The productized control layer (`--with-kit`). These stack the demo widgets and add the native
 * semantics the demo widgets lack; they import `@/components/*` and `@/composables/*`, both of which
 * the rewriter resolves into the same vendored tree.
 */
const KIT_FILES = [
  'context.ts',
  'GlassButton.vue',
  'GlassSwitch.vue',
  'GlassSlider.vue',
  'GlassTabs.vue',
  'glass-controls.css',
  'index.ts'
]

/* ------------------------------------------------------------------ output scaffolding ------- */

/**
 * Lifted from `src/style.css`. The demo keeps these un-scoped because they have to reach into a
 * `GlassSurface`'s internal content wrapper from outside its own scope.
 */
const GLASS_CSS = `/*
 * Liquid Glass — shared layout rules the vendored components rely on.
 *
 * These are NOT in the components' own <style scoped> blocks: they target GlassSurface's internal
 * content wrapper, which carries GlassSurface's scope id rather than the caller's, so they lived in
 * this repo's global stylesheet. Import this file once in the host app.
 *
 * Load-bearing details:
 *  - \`.glass-surface__content { align-items: center }\` — LiquidToggle / LiquidSlider pass no
 *    \`content-class\`, so this is the only rule aligning their slotted content.
 *  - \`.liquid-bottom-tabs__row\` — LiquidBottomTabs never declares this class itself; without it
 *    the row collapses to zero height.
 */
.glass-surface__content {
  align-items: center;
}

.liquid-button__content {
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 16px;
  width: 100%;
  height: 100%;
  white-space: nowrap;
  font-size: 15px;
}

.liquid-bottom-tabs__row {
  align-items: center;
  padding: 4px;
  width: 100%;
  height: 100%;
}
`

const BARREL = `/**
 * Barrel for the vendored Liquid Glass tree — generated by WebLiquidGlass/scripts/vendor-liquid-glass.mjs.
 *
 * \`backdrop\` is the only thing every surface needs and nothing provides for you: pass
 * \`RootBackdrop\` (sample the page behind the element) or \`EmptyBackdrop\` (draw the surface only).
 */
export { default as GlassSurface } from './components/GlassSurface.vue'
export { default as LiquidButton } from './components/LiquidButton.vue'
export { default as LiquidToggle } from './components/LiquidToggle.vue'
export { default as LiquidSlider } from './components/LiquidSlider.vue'
export { default as LiquidBottomTabs } from './components/LiquidBottomTabs.vue'
export { default as LiquidBottomTab } from './components/LiquidBottomTab.vue'
export { default as RippleSurface } from './components/RippleSurface.vue'

export { RootBackdrop, EmptyBackdrop, BackdropEffectScope, HighlightStyles, DefaultShadow, shadow, innerShadow } from './core/backdrop'
export type { Backdrop, Highlight, Shadow, InnerShadow } from './core/backdrop'
export { Capsule, Rectangle, RoundedRectangle } from './core/shapes'
export type { Shape } from './core/shapes'
export { dp, layerTransformToCss, identityTransform } from './core/geometry'
export type { LayerTransform, Size } from './core/geometry'
export { argb, Colors, Palette, withAlpha, toCss } from './core/color'
export { Animatable, spring, tween, requestRedraw } from './core/animation'
export { InteractiveHighlight } from './core/interactive-highlight'
export { isRefractionSupported } from './core/glass-filter'
export { clamp, lerp } from './core/math'
`

const USAGE = `# Vendored Liquid Glass

Copied from \`WebLiquidGlass\` by \`scripts/vendor-liquid-glass.mjs\`. **Do not hand-edit** — re-running
the script overwrites everything here. Put host-specific glue in a sibling file.

## Wire it up

\`\`\`ts
// main.ts — once
import './glass/glass.css'
\`\`\`

\`\`\`vue
<script setup lang="ts">
import { LiquidButton, LiquidToggle, RootBackdrop, dp } from './glass'

const enabled = ref(false)
</script>

<template>
  <!-- backdrop is required and has no default; RootBackdrop = "sample the page behind me" -->
  <LiquidButton :backdrop="RootBackdrop" tint="#0088FF" @click="save">Save</LiquidButton>

  <LiquidToggle
    :backdrop="RootBackdrop"
    :is-light-theme="isLightTheme"
    :selected="enabled"
    @select="enabled = $event"
  />
</template>
\`\`\`

\`backdrop\` is a **marker constant**, not reactive state: \`RootBackdrop\` means "sample the page behind
me", \`EmptyBackdrop\` means "draw the surface, never sample". Reaching for \`provide\`/\`inject\` in a
non-kit setup buys nothing — the ported widgets take it as a prop because that is how the catalog
drives them, so import the constant and pass the same value at every call site.

__KIT_SECTION__## Where the glass samples from

A surface samples **whatever the browser has painted behind it**. There is no wallpaper copy and no
backdrop recording layer, so:

- it refracts the host page's real background — the feature you want;
- but an ancestor with \`filter\`, \`opacity < 1\`, \`mask\`/\`clip-path\`, \`backdrop-filter\`,
  \`mix-blend-mode\`, or a \`will-change\` of those becomes a **backdrop root** (Filter Effects L2 §3)
  and the glass will only see inside it. A fade-in wrapper (\`opacity: 0 → 1\`) around the glass is
  the classic way to end up with a surface that shows nothing once the animation lands at 1.
  \`transform\`, \`z-index\` and \`isolation: isolate\` do **not** trigger this — \`scale()\` is safe.
- the lens layer is empty by design and must stay empty: a child would sit outside the backdrop root.

## Platform caveats (verified, not theoretical)

| | |
|---|---|
| Refraction | Chromium only. Safari / Firefox accept the declaration and draw plain blur, which is why every call site keeps an earlier \`blur()\` in the same \`backdrop-filter\` value. Probe with \`isRefractionSupported()\` (UA-based: engines that parse-but-do-not-paint make \`@supports\` lie). |
| CSP | If the host page's \`img-src\` (or its \`default-src\` fallback) forbids \`data:\`, the \`<feImage>\` displacement map is rejected **silently** and the surface renders pixel-identical to a plain \`blur()\` — no error, no warning. Measured on Stack Overflow / ServerFault / SuperUser / PyPI. |
| \`plus-lighter\` | Needed for the press highlight. Engines without it drop the declaration and the surface stays flat; nothing breaks. |
| Performance | Each surface owns its own filter graph (SDF → displacement map → \`feImage\` + \`feDisplacementMap\`). Dozens of large surfaces at once will drop frames on mid-range hardware. Prefer small controls, avoid full-screen panes. |
| SSR | \`core/\` touches no DOM at import time (the refraction probe guards \`typeof navigator\`), but \`GlassSurface\` builds DOM + an SVG filter on mount. In Nuxt, wrap glass in \`<ClientOnly>\`. |

## Requirements

Vue >= 3.3 (the components use \`defineOptions\`; \`<script setup>\` + TS), Vite + \`@vitejs/plugin-vue\`
(or any bundler that compiles SFCs). No other runtime dependency — \`core/\` imports nothing at all.

## Re-sync after upstream changes

\`\`\`sh
cd /path/to/WebLiquidGlass
node scripts/vendor-liquid-glass.mjs /path/to/this-project/src/glass
\`\`\`
`

/** Only spliced in with `--with-kit`; the base document describes the ported widgets alone. */
const KIT_SECTION = `## Controls (vendored with \`--with-kit\`)

\`kit/\` holds the productized controls. Each one is a **shell** around a ported widget: the visual keeps
the pointer gesture that produces the press animation, while a visually hidden native control owns
state, keyboard, ARIA and form entry. Nothing in \`components/\` was modified, so re-syncing stays cheap.

\`\`\`ts
// main.ts — optional. Provide once and every kit control finds the marker and the theme itself;
// without it each control falls back to a page-wide default context instead of throwing.
// Use the plugin: \`provide()\` is only legal inside a component's setup(), so the tempting
// \`app.use(() => provideGlass())\` is a silent no-op.
import { GlassPlugin } from './glass/kit'
createApp(App).use(GlassPlugin).mount('#app')
\`\`\`

\`\`\`vue
<script setup lang="ts">
import { GlassButton, GlassSwitch, GlassSlider } from './glass/kit'

const enabled = ref(false)
const volume = ref(30)
</script>

<template>
  <!-- the switch is a real checkbox: role="switch", form value, Space/Enter, focus-visible -->
  <GlassSwitch v-model="enabled" id="notifications" />
  <label for="notifications">Enable notifications</label>

  <!-- the slider is a real range input: arrows / Home / End / PageUp, snapped to step -->
  <GlassSlider v-model="volume" :min="0" :max="100" :step="1" name="volume" />

  <GlassButton tint="#0088FF" @click="save">Save</GlassButton>
</template>
\`\`\`

All three are **strictly controlled** (\`v-model\` is required) and all three are disabled with
\`disabled\`, which both blocks activation and paints a sibling wash over the glass. Size variants are
not offered: the ported geometry is literal pixels and changing it means editing the ported component.

\`GlassTabs\` renders the tabs itself from a \`count\` and a \`#tab\` slot (\`role="tablist"\` + roving
tabindex + arrows / Home / End, automatic activation). It has no disabled tabs and no tab panels yet.

\`GlassSlider\` takes \`step\` as \`number | 'any'\`, defaulting to \`'any'\` (continuous values, exactly
like the ported demo). A number snaps the *model* to that grid while the visual stays continuous
during the drag and settles on release; quantising the visual instead would break the ported
component's drag accumulation (see \`GlassSlider\`'s header).

The switch and slider also take \`theme="light" | "dark"\` to pin one instance to a palette; omit it to
follow the context. It is a string rather than the ported \`isLightTheme\` boolean on purpose — Vue
coerces an absent Boolean prop to \`false\`, which would make "unspecified" indistinguishable from
"explicitly dark" and pin every control regardless of the context.

`

/* ------------------------------------------------------------------ copy + rewrite ----------- */

const IMPORT_SPECIFIER = /(from\s+|import\s*\(\s*)(['"])@\/([^'"]+)\2/g

/** `@/core/x` → relative to the file doing the importing. Returns the file plus a change count. */
function rewriteAliases(source, sourcePath, vendorRoot) {
  let changed = 0
  const out = source.replace(IMPORT_SPECIFIER, (match, prefix, quote, rest) => {
    const absolute = join(vendorRoot, rest)
    let specifier = relative(dirname(sourcePath), absolute).split(sep).join('/')
    if (!specifier.startsWith('.')) specifier = `./${specifier}`
    changed++
    return `${prefix}${quote}${specifier}${quote}`
  })
  return { source: out, changed }
}

/** Every relative specifier in `source` must land on a file we are about to write. */
function unresolvedSpecifiers(source, sourcePath, written) {
  const missing = []
  const re = /(?:from\s+|import\s*\(\s*)(['"])(\.[^'"]+)\1/g
  let match
  while ((match = re.exec(source)) !== null) {
    const base = resolve(dirname(sourcePath), match[2])
    const candidates = [base, `${base}.ts`, `${base}.vue`, join(base, 'index.ts')]
    if (!candidates.some((candidate) => written.has(candidate))) missing.push(match[2])
  }
  return missing
}

/**
 * Verification works on code only. The vendored files carry usage snippets inside doc comments
 * (`import { GlassSwitch } from './glass/kit'` and friends), which are not imports and must not be
 * resolved — a real specifier that survived the rewrite would still be caught.
 *
 * The `(^|[^:])` guard keeps `https://` inside a string from being mistaken for a line comment.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/* ------------------------------------------------------------------ main --------------------- */

const args = process.argv.slice(2)
const withKit = args.includes('--with-kit')
const target = args.find((arg) => !arg.startsWith('-'))
if (!target) {
  console.error('usage: node scripts/vendor-liquid-glass.mjs <targetDir> [--with-kit]')
  console.error('  e.g. node scripts/vendor-liquid-glass.mjs ../my-app/src/glass --with-kit')
  process.exit(2)
}

const vendorRoot = resolve(process.cwd(), target)
if (vendorRoot === SRC || vendorRoot.startsWith(`${SRC}${sep}`)) {
  console.error(`refusing to write inside this repo's src/: ${vendorRoot}`)
  process.exit(2)
}

const plan = [
  ...CORE_FILES.map((name) => ({ from: join(SRC, 'core', name), to: join(vendorRoot, 'core', name) })),
  ...COMPOSABLE_FILES.map((name) => ({
    from: join(SRC, 'composables', name),
    to: join(vendorRoot, 'composables', name)
  })),
  ...COMPONENT_FILES.map((name) => ({
    from: join(SRC, 'components', name),
    to: join(vendorRoot, 'components', name)
  })),
  ...(withKit
    ? KIT_FILES.map((name) => ({ from: join(SRC, 'kit', name), to: join(vendorRoot, 'kit', name) }))
    : [])
]

for (const entry of plan) {
  if (!existsSync(entry.from)) {
    console.error(`missing source file: ${entry.from}`)
    process.exit(1)
  }
}

// A stale file from an older revision would silently be imported by a stale barrel, so the
// directory is rebuilt rather than merged. It only ever contains generated output — see USAGE.md.
if (existsSync(vendorRoot)) {
  rmSync(vendorRoot, { recursive: true, force: true })
  console.log(`cleared ${relative(process.cwd(), vendorRoot)}`)
}
mkdirSync(vendorRoot, { recursive: true })

const written = new Set(plan.map((entry) => entry.to))
const files = []
let rewrites = 0

for (const entry of plan) {
  const original = readFileSync(entry.from, 'utf8')
  const { source, changed } = rewriteAliases(original, entry.to, vendorRoot)
  rewrites += changed
  mkdirSync(dirname(entry.to), { recursive: true })
  writeFileSync(entry.to, source)
  files.push({ path: entry.to, bytes: Buffer.byteLength(source), rewrites: changed })
}

const extras = [
  ['glass.css', GLASS_CSS],
  ['index.ts', BARREL],
  ['USAGE.md', USAGE.replace('__KIT_SECTION__', withKit ? KIT_SECTION : '')]
]
for (const [name, contents] of extras) {
  writeFileSync(join(vendorRoot, name), contents)
}

/* ---- verify --------------------------------------------------------------------------------- */

const problems = []
for (const file of files) {
  const code = stripComments(readFileSync(file.path, 'utf8'))
  if (/(?:from\s+|import\s*\(\s*)['"]@\//.test(code)) {
    problems.push(`${relative(vendorRoot, file.path)}: an '@/' specifier survived the rewrite`)
  }
  for (const missing of unresolvedSpecifiers(code, file.path, written)) {
    problems.push(`${relative(vendorRoot, file.path)}: unresolved import ${missing}`)
  }
}

const report = [
  `\nvendored ${files.length} files + 3 generated (glass.css, index.ts, USAGE.md) -> ${vendorRoot}`,
  `rewrote ${rewrites} alias specifiers to relative paths`
]
for (const file of files) {
  report.push(`  ${relative(vendorRoot, file.path).padEnd(38)} ${String(file.bytes).padStart(6)} B`)
}
console.log(report.join('\n'))

if (problems.length > 0) {
  console.error(`\n✗ ${problems.length} problem(s):`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log('\n✓ every import inside the vendored tree resolves; no alias required by the host')
