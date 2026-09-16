<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue'

import { GlassButton, GlassSlider, GlassSwitch, GlassTabs, useGlass, type GlassThemePreference } from '@/kit'
import { Palette, toCss } from '@/core/color'
import wallpaperLight from '@/assets/wallpaper_light.webp'

/**
 * Kit acceptance page. Two jobs: let a human feel the controls in a real browser, and put every
 * non-visual promise of the kit on screen so it can be checked without opening devtools.
 *
 * The readouts are not decoration — they are the part that cannot be eyeballed. `FormData` in
 * particular is the whole difference between a demo widget and a control: the demo components render
 * `<div>`s and contribute nothing to a form.
 */
const glass = useGlass()

const notifications = ref(false)
const volume = ref(30)
const brightness = ref(64)
const tab = ref(0)

const accent = computed(() => toCss(glass.isLightTheme.value ? Palette.blueLight : Palette.blueDark))
const saving = ref(false)
const submitted = ref<Record<string, string> | null>(null)
const formEl = useTemplateRef<HTMLFormElement>('form')

const themeOptions: GlassThemePreference[] = ['system', 'light', 'dark']

/** Names of the two inputs the form actually submits — computed from the live DOM, not assumed. */
function collectFormData(): void {
  const form = formEl.value
  if (!form) return
  submitted.value = Object.fromEntries(new FormData(form) as unknown as [string, string][])
}

function simulateSave(): void {
  saving.value = true
  window.setTimeout(() => (saving.value = false), 700)
}

const state = computed(() => ({
  'switch (v-model)': notifications.value,
  "slider step=10 (v-model)": volume.value,
  "slider step='any' (v-model)": brightness.value,
  'tabs (v-model)': tab.value,
  'button loading': saving.value
}))
</script>

<template>
  <div
    class="page"
    :data-tab-index="tab"
    :style="{ backgroundImage: `url(${wallpaperLight})` }"
  >
    <header class="head">
      <h1>Liquid Glass Kit — 验收台</h1>
      <p class="head__path">
        <code>/kit.html</code> · dev-only，不进 <code>index.html</code> 的构建产物 · 演示目录未改动
      </p>
    </header>

    <!--
      Kept as a plain translucent panel on purpose. An ancestor with `opacity < 1`, `filter`,
      `mask`/`clip-path`, `backdrop-filter` or `mix-blend-mode` would become a **backdrop root**
      (Filter Effects L2 § 3) and the glass would stop sampling the wallpaper. A plain
      `background` colour has no such effect.
    -->
    <main class="panel">
      <section class="row">
        <span class="row__label">主题上下文（插件提供）</span>
        <span class="row__value">
          preference = <b>{{ glass.themePreference.value }}</b> · isLightTheme =
          <b>{{ glass.isLightTheme.value }}</b>
        </span>
      </section>

      <div class="themes">
        <button
          v-for="option in themeOptions"
          :key="option"
          class="themes__button"
          :class="{ 'themes__button--active': glass.themePreference.value === option }"
          type="button"
          @click="glass.themePreference.value = option"
        >
          {{ option }}
        </button>
      </div>

      <!--
        A real form. `name` is what makes the native controls submit, and it is exactly what the
        ported demo widgets cannot do.
      -->
      <form ref="form" class="form" @submit.prevent="collectFormData">
        <div class="row">
          <!-- label is a SIBLING, never a wrapper: a wrapping label forwards activation on top of
               the ported gesture and fights it (see kit/index.ts) -->
          <label class="row__label" for="notifications">Enable notifications</label>
          <GlassSwitch id="notifications" v-model="notifications" name="notifications" />
        </div>

        <div class="row">
          <span class="row__label">Volume (step 10)</span>
          <span class="row__slider">
            <GlassSlider
              v-model="volume"
              :min="0"
              :max="100"
              :step="10"
              name="volume"
              aria-label="Volume"
            />
          </span>
        </div>

        <!-- No `step`: the default is `'any'`, i.e. continuous values exactly like the ported demo.
             Dropping the grid is also what removes every quantisation question — see the note in
             GlassSlider.vue about the ported component's accumulation. -->
        <div class="row">
          <label class="row__label" for="brightness">Brightness (continuous)</label>
          <span class="row__slider">
            <GlassSlider
              id="brightness"
              v-model="brightness"
              name="brightness"
              aria-label="Brightness"
            />
          </span>
        </div>

        <div class="stack">
          <GlassButton type="submit" tint="#0088FF">Submit form</GlassButton>
          <GlassButton surface-color="rgba(255, 255, 255, 0.3)" :loading="saving" @click="simulateSave">
            Loading state
          </GlassButton>
          <GlassButton disabled>Disabled</GlassButton>
        </div>
      </form>

      <!-- Tabs live outside the form on purpose: the ARIA tab pattern is navigation, not a form
           control, and it must not be submitted. -->
      <section class="tabs">
        <div class="row">
          <span class="row__label">Tabs (role=tablist)</span>
          <span class="row__value">← → Home End / 点或拖指示器</span>
        </div>
        <GlassTabs v-model="tab" :count="3" aria-label="Demo sections">
          <template #tab="{ index, selected }">
            <svg class="tab__icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="7" :fill="selected ? accent : 'currentColor'" />
            </svg>
            <span class="tab__label">Tab {{ index + 1 }}</span>
          </template>
        </GlassTabs>
      </section>

      <section class="readout">
        <h2>状态</h2>
        <pre>{{ JSON.stringify(state, null, 2) }}</pre>
        <h2>表单真正提交的内容（FormData）</h2>
        <pre>{{ submitted ? JSON.stringify(submitted, null, 2) : '点 Submit form 看看' }}</pre>
      </section>
    </main>

    <aside class="panel panel--notes">
      <h2>只能在这里（真浏览器）验的部分</h2>
      <ul>
        <li>
          <b>按压与拖动</b>：按住在开关拇指上左右拖，玻璃会挤压/回弹，松手回弹（拖动不过半不改变状态）。
        </li>
        <li>
          <b>按压时的折射</b>：静止时只有 <code>blur()</code>；按住时才挂上
          <code>url(#lg-refract-N)</code>——探针实测过按钮的静止态带滤镜，开关/滑块的透镜随按压进度缩放。
        </li>
        <li><b>键盘</b>：Tab 进开关 → Space 或 Enter 切换；滑块的 ←/→/Home/End/PageUp。</li>
        <li><b>焦点环</b>：用键盘聚焦（不要用鼠标点），视觉层会出现 2px 蓝色胶囊描边。</li>
        <li>
          <b>浏览器差异</b>：折射是 Chromium 扩展。Safari/Firefox 只剩模糊，且
          <code>site</code> 的 CSP 若禁 <code>data:</code> 会静默退化（README §10 有实测）。
        </li>
      </ul>
    </aside>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  padding: 40px 20px 64px;
  box-sizing: border-box;
  background-position: center;
  background-size: cover;
  background-attachment: fixed;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', sans-serif;
  color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
}

.head {
  text-align: center;
}

.head h1 {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 600;
}

.head__path {
  margin: 0;
  font-size: 13px;
  opacity: 0.9;
}

.panel {
  width: min(560px, 100%);
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 22px 24px;
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.14);
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.18);
}

.panel--notes {
  font-size: 13px;
  line-height: 1.55;
}

.panel h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  opacity: 0.85;
}

.panel ul {
  margin: 0;
  padding-left: 18px;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  font-size: 15px;
}

.row__label {
  flex: 0 0 auto;
}

.row__value {
  font-size: 13px;
  text-align: right;
  opacity: 0.95;
}

.row__slider {
  flex: 1 1 auto;
  display: flex;
  min-width: 0;
}

.themes {
  display: flex;
  gap: 8px;
}

.themes__button {
  flex: 1 1 0;
  padding: 7px 10px;
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  color: inherit;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.themes__button--active {
  background: rgba(255, 255, 255, 0.55);
  color: #111;
  text-shadow: none;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tabs {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tab__icon {
  width: 20px;
  height: 20px;
}

.tab__label {
  font-size: 11px;
}

.readout {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.readout pre {
  margin: 0;
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(0, 0, 0, 0.28);
  color: #fff;
  font-size: 12px;
  line-height: 1.5;
  text-shadow: none;
  overflow-x: auto;
}
</style>
