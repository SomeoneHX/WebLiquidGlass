# WebLiquidGlass

> 一个把 Android `Kyant0/AndroidLiquidGlass`（Liquid Glass / Backdrop）的 **Web Liquid Glass** 移植到 Web 的项目。

英文文档见 [`README.en.md`](./README.en.md)（用户脚本部分同样有完整英文版，见 [English §10](./README.en.md#10-userscript-liquid-glass-refraction)）。

---

## 1. 项目简介

**WebLiquidGlass** 是 Android 开源项目 [`Kyant0/AndroidLiquidGlass`](https://github.com/Kyant0/AndroidLiquidGlass)（一个面向 Compose Multiplatform 的可定制液态玻璃效果库，其 *Web Liquid Glass* 是一套液态玻璃演示集）的网页移植版。

目标不是"看起来像"，而是**逐效果、逐像素地 1:1 还原**原版在每个控件上做的事——模糊、折射、形变、高光、涟漪、弹簧动画——只是把 Kotlin/AGSL 的实现换成浏览器原生能力：

- **模糊 / 饱和 / 亮度**：直接用 CSS `backdrop-filter` 的 `blur()` / `saturate()` / `brightness()`，与上游一一对应；
- **折射（displacement）**：用 Canvas 2D 按圆角矩形 SDF 生成位移图，喂给 SVG `feDisplacementMap`，再拼进 `backdrop-filter: url(#id)`；
- **形变（deformation）**：直接用 CSS `transform: scale()/translate()` 驱动，浏览器按 Filter Effects L2 规范自动完成"反演采样"，等价于 Android 的 `InverseLayerScope`；
- **高光（highlight）**：Canvas 2D 逐像素烘焙 AGSL 高光 shader 的强度场（含方向性 bevel/rim 与加法混合）。

技术栈：**Vue 3 + TypeScript + Vite**，仅用 `npm` 管理。**纯 DOM + 浏览器原生技术，零 WebGL / 零 GLSL。**

> ⚠️ 方向说明：早期版本曾计划做"降级形态"（无模糊、无折射）。该方向已被**推翻**——当前实现完整使用浏览器 CSS / SVG 滤镜实现模糊与折射。本 README 描述的就是当前这一版。

---

## 2. 与原版的关系

| 维度 | Android 原版（`Kyant0/AndroidLiquidGlass`） | 本移植版 |
| --- | --- | --- |
| 语言 | Kotlin + Compose + AGSL shader | TypeScript + Vue 3 + Canvas 2D + CSS/SVG |
| 模糊 | `RenderEffect`（API ≥ 31） | CSS `backdrop-filter: blur()` |
| 折射 | `RuntimeShader`（`feDisplacementMap` 同族） | Canvas 生成的位移图 + SVG `feDisplacementMap` |
| 形变 | `InverseLayerScope` 手动反演 | CSS `transform`（浏览器自动反演） |
| 高光 | `AGSL` runtime shader + `BlendMode.Plus` | Canvas 2D 烘焙 + `mix-blend-mode: plus-lighter` |
| 演示承载 | `CatalogDestination` 状态机 | `src/core/destinations.ts` + Vue 组件切换 |

每个移植文件的**顶部注释都标注了它对应的 Kotlin 源文件路径**，便于对照上游实现。

上游仓库 `Kyant0/AndroidLiquidGlass` 的源码布局：
- Demo：`app/src/commonMain/kotlin/com/kyant/backdrop/catalog/`
- 库：`backdrop/src/commonMain/kotlin/com/kyant/backdrop/`

---

## 3. 技术路线与架构

### 3.1 分层：Vue 外壳 + 框架无关的 core

Vue **只承担外壳**：组件树、`props`、生命周期，以及一个全局失效信号。真正的核心逻辑全在 `src/core/` 里，是**框架无关的**——它与 Vue 唯一的耦合是 `src/core/animation.ts` 里的那个 `ref`（即 `animationRevision`）。

> 因此 `src/core/` 可以原样搬到 React / Svelte 等其它框架，只需重写外壳与那一个 `ref`。

**不要**引入 `vue-router` / `Pinia` / `<Transition>`：页面的"目的地"切换是手写状态机，所有形变都由手写 `requestAnimationFrame` 循环驱动。

### 3.2 玻璃渲染管线（GlassSurface）

每个 `GlassSurface` 由 5 层组成，**从下到上**：

1. **shadow canvas** —— 投影（drop shadow）；
2. **lens div（空节点）** —— 只承载 `backdrop-filter` + `clip-path`，**永远不能有子节点**（因为 `backdrop-filter` 会创建 backdrop root，子节点会被排除在 backdrop 之外）；
3. **overlay canvas** —— surface wash（表面染色）+ 非加法的 `Ambient` 高光；
4. **additive canvas** —— 按压高光 + 走 `BlendMode.Plus` 的高光环，使用 `mix-blend-mode: plus-lighter` 实现真正的**加法混合**；
5. **content** —— 真实 DOM 内容。

为什么高光要拆成两个画布？因为 **Canvas 做不到"加法"**。`globalCompositeOperation = 'lighter'` 只对*画布内部已有像素*生效；一张干净画布没有"底"可加，最终仍被浏览器按 `normal` 叠上去，结果是朝白的插值（`dst + a·(255−dst)`），而不是加法（`dst + a·255`）。所以凡是上游写 `BlendMode.Plus` 的东西，都必须画在带 `plus-lighter` 的 additive 画布上。

### 3.3 折射滤镜（glass-filter.ts）

`backdrop-filter` 只能采样元素**背后**已绘制的内容，所以玻璃**不需要**自己保存一份壁纸副本——浏览器替你抓取。模糊/饱和/亮度能 1:1 映射到 CSS 滤镜函数，但**折射**没有对应的 CSS 原语（"按向量场移动每个像素"），于是走 SVG 滤镜：

- 位移图在 Canvas 上按圆角矩形 **SDF** 生成（与 Android `RoundedRectRefractionShaderString` 同构）；
- `feDisplacementMap` 读取一张图，其中 **R = dx、G = dy**（128 = 不偏移），据此移动每个像素；
- **色散（chromatic aberration）**：上游 shader 沿折射偏移采样 7 次、带频谱权重。这里改用**三分支滤镜图**——红 `base·(1+i)`、绿 `base`、蓝 `base·(1−i)`，分别位移后 `feComposite arithmetic` 相加（3 次采样而非 7 次，白光守恒）。

位移图按 `(宽×高×圆角×折射深度×是否色散)` 做键缓存，相同形状共享一张位图；每帧只改最便宜的 `feDisplacementMap` 的 `scale` 来驱动动画。

### 3.4 高光系统（highlight-map / interactive-highlight）

上游给 `Default` / `Ambient` 高光建了 **AGSL shader** 并用 `paint.setRuntimeShader` —— 而 Android 的 Paint 会用*颜色 alpha* 调制 shader 输出，于是高光环 alpha = `样式颜色alpha · |⟨SDF外法线, (cos angle, sin angle)⟩| ^ falloff`。

- 直边恒为 `0.707`，圆帽一侧为 `1.0`、另一侧为 **0（高光断开）**；
- `Highlight.angle` / `falloff` 是这条公式的 uniform，不是装饰（`ControlCenterContent` 传 `falloff = 2`），随手丢掉会得到"每个组件一圈均匀白边"的错误效果；
- `Ambient` 与 `Default` 只差颜色，而那个差别**有语义**：`Ambient` 的 shader 是 `half4(t,t,t,1)·intensity`，AGSL 返回**预乘**值，于是 `d<0` 那半边是满强度黑——配 `SrcOver` 后 `d≥0` 提亮、`d<0` 压暗，所以 `Ambient` 是 **bevel（斜面）而不是 rim（描边）**；而 `Default` 是均匀白描边、`Plus` 混合。

实现见 `src/core/highlight-map.ts`：逐像素烘焙强度场 + 缓存，`paintRing` 用 `source-in` 把强度图乘进描边。**顺序要求先模糊几何、后乘强度图**，乘图前必须把 `scratch.filter` 复位为 `'none'`，否则会把场糊掉。

按压高光（`interactive-highlight.ts`）有两个分支：上游 `SDK_INT ≥ 33` 时画 `White@0.08·progress` 的平面铺底**加**跟随指针的径向光晕（`createRadialGradient` 即可表达 `smoothstep`）；否则单层 `0.25·progress`。Web 端两个分支**都要画**，且指针坐标必须用 `localPointerPosition()` 反解 CSS 变换（`getBoundingClientRect()` 给的是变换后的盒子，朴素 `clientX - rect.left` 会被拉伸量乘一遍，光点会漂离手指）。

### 3.5 动画与失效信号

- `Animatable` 等动画值是**普通 JS 对象**，由共享 `rAF` 循环步进；
- DOM / canvas 的失效信号是 `animationRevision`（`useFrameValue` 把它封装成 Vue `ref`）；
- **它必须是 Vue `ref`（响应式）**——一旦是普通 `number`，Vue 永不置脏，数学照算但 DOM/canvas 一帧都不更新，表现就是"所有控件点了没反应且无任何报错"。

### 3.6 形变与 transform 语义

`layerBlock` 与 `offset` 已合并成同一个 CSS `transform`：`GlassSurface.currentCssTransform()` = `translate(offset)` + `layerTransformToCss(t)`。

**关键规范事实**：`backdrop-filter` + `transform` **不会放大背景**。依据 Filter Effects Module Level 2：

- 渲染步骤会把元素 border box 变换到屏幕空间再裁剪 → 采样区 = 变换后的四边形（`scale(1.5)` 就取放大后的区域）；
- 随后对内部内容施加*逆变换* → 净效果 = 内容尺度不变、只是采样范围变大，背景被"钉"在屏幕上。

这正是液态玻璃的语义，而不是放大镜。换言之，Android 需要手动做的 `InverseLayerScope` 反演，**浏览器内部已经做了**，所以 `transform: scale()` 可以直接当形变用（且是合成层操作，性能优于改 `width/height`）。

---

## 4. 目录结构

```
WebLiquidGlass/
├── index.html
├── package.json
├── vite.config.ts            # base:'./'，别名 '@'→'./src'，dev 绑定 127.0.0.1:5173
├── tsconfig.json
├── public/                   # 壁纸等静态资源（useWallpaper 加载）
├── userscript/
│   └── liquid-glass-refract.user.js   # ★ 从 core/glass-filter.ts 提取的独立用户脚本（见 §10）
├── scripts/
│   └── stamp-userscript.mjs  # 发布时把 run number 打进脚本 @version（见 §10.6）
├── .github/workflows/deploy.yml       # Pages 部署：构建 Demo + 同步发布用户脚本
└── src/
    ├── main.ts               # createApp(App).mount('#app')
    ├── App.vue               # 外壳：destination 状态机 + 主题 + Back 按钮 + 布局 epoch
    ├── style.css             # 全局样式、安全区变量、明暗主题、user-select:none
    ├── core/                 # ★ 框架无关的真正主体（可搬到 React/Svelte）
    │   ├── animation.ts       # 共享 rAF 循环 + animationRevision(ref)
    │   ├── backdrop.ts        # Backdrop 退化为 { samples } —— 仅 RootBackdrop / EmptyBackdrop
    │   ├── draw-backdrop.ts   # 镜像 Compose drawBackdrop 的合成
    │   ├── glass-filter.ts    # 折射：Canvas SDF → feImage + feDisplacementMap（Chromium 专属）
    │   ├── highlight-map.ts   # 高光强度场逐像素烘焙 + 缓存（bevel/rim 方向性）
    │   ├── interactive-highlight.ts  # 按压高光两分支 + 指针坐标反解
    │   ├── destinations.ts    # CatalogDestination 类型（15 个目的地）
    │   ├── math.ts / geometry.ts / shapes.ts   # 数学与几何
    │   ├── color.ts           # argb(0xff34c759) 取 8 位 ARGB
    │   ├── damped-drag-animation.ts / drag-gestures.ts / transform-gestures.ts
    │   ├── velocity-tracker.ts / progress-converter.ts
    │   └── assets.ts
    ├── components/
    │   ├── GlassSurface.vue   # 5 层玻璃容器
    │   ├── LiquidButton.vue / LiquidToggle.vue / LiquidSlider.vue
    │   ├── LiquidBottomTabs.vue / LiquidBottomTab.vue
    │   ├── RippleSurface.vue  # 涟漪（依赖原生 @click）
    │   ├── BackdropDemoScaffold.vue
    │   └── FlightIcon.vue
    ├── composables/
    │   ├── useFrameValue.ts   # 把 animationRevision 映射成响应式 ref
    │   ├── useElementMetrics.ts  # 布局 epoch / getBoundingClientRect 反解
    │   ├── useTap.ts / useWallpaper.ts / backdrop-context.ts
    └── views/                # 14 个演示页（对应 14 个非 Home 目的地）
        ├── HomeContent.vue          # 目录网格
        ├── ButtonsContent.vue       # LiquidButton + 涟漪 + 玻璃
        ├── ToggleContent.vue        # 开关（thumb scaleY 形变 + bevel 高光）
        ├── SliderContent.vue        # 滑块（轨道 + thumb）
        ├── BottomTabsContent.vue    # 底部标签栏（玻璃指示器透镜折射条内内容）
        ├── DialogContent.vue        # 玻璃对话框
        ├── LockScreenContent.vue    # 媒体风格锁屏
        ├── ControlCenterContent.vue # iOS 风格控制中心（shadow=null，纵向拖拽）
        ├── MagnifierContent.vue     # 放大镜（backdrop 缩放 + 折射链）
        ├── GlassPlaygroundContent.vue  # 参数可调的玻璃实验台
        ├── AdaptiveLuminanceGlassContent.vue  # 亮度自适应玻璃
        ├── ProgressiveBlurContent.vue        # 渐进式模糊
        └── ScrollContainerContent.vue / LazyScrollContainerContent.vue
```

---

## 5. 环境要求与运行

**要求**：Node.js（本项目在 Node 24 下开发验证）+ `npm`。

```bash
# 安装依赖
npm install

# 启动开发服务器（http://127.0.0.1:5173）
npm run dev

# 类型检查（vue-tsc --noEmit）
npm run typecheck

# 生产构建（先 vue-tsc 再 vite build，产物在 dist/）
npm run build

# 预览构建产物（http://127.0.0.1:4173）
npm run preview

# 用户脚本：语法校验 / 按 CI 的方式打版到 dist/（详见 §10.6）
npm run check:userscript
npm run stage:userscript

# 折射探针（前两条纯 Node 零依赖；后两条用真实 Chromium，`probe:fidelity` 需要先 npm run dev）
npm run probe:map         # 编码层模型：位移图的 8 位阶梯（§10.10）
npm run probe:band        # 边缘带捷径 vs 全扫描，逐字节对照（§10.12）
npm run probe:render      # 采样层：相位标尺测出真实取样位置（§10.10）
npm run probe:fidelity    # 13 个目的地的渲染指纹，用于改动前后 A/B（§10.12）
```

`density = 1`，所以 Kotlin 里的 `xx.dp` 常量 1:1 映射成 CSS `px`，不做任何换算。

---

## 6. 移植约定（硬规则）

1. **动画值不进 Vue 响应式**：`animationRevision` 必须是 `ref`；否则整页静默失效。
2. **`argb()` 收 8 位 ARGB**（`argb(0xff34c759)`），传 6 位 hex 会得到 alpha=0 全透明。
3. **不传 `highlight`/`shadow` ≠ 关闭**：Kotlin 缺省 = `Highlight.Default` / `Shadow.Default`；缺省 prop 必须回落到默认值（只有 ControlCenter 显式传 `shadow = null`）。
4. **保持 1:1 移植**，允许的偏离必须在注释里写明理由（如 ControlCenter 的 `onVerticalDrag` 扩展、Magnifier 的 Canvas 2D 重绘段落）。
5. **不要加原版没有的装饰**：原版全屏铺满、无手机边框/返回胶囊（左上角的 Back 是 skiko 版 `BackHandler` 画出的蓝色 `LiquidButton`，已还原）。
6. **全局禁止文字选中**：`.app-root` 上 `user-select:none` 等；只有 `input/textarea/[contenteditable]` 保留可选。手势层**不要**用 `preventDefault` 挡选择（会吞掉 `RippleSurface` 依赖的原生 `@click`）。
7. **按压高光两个分支都要画**，`highlightPosition()` 的第二实参传**指针绝对局部坐标**而非 `offset`（上游 lambda 形参虽叫 `offset`，实际传的是 `positionAnimation.value`）。
8. **DOM 玻璃里"不该被采样到的东西"**：要么别画在那里，要么自己挖洞；叠一份副本上去没用，原件照样会漏（缩放一个被 clip 过的录制层改变的是形状不是颜色，别随手丢）。
9. **状态 `fraction` 只读、屏幕位置取动画值**（如 `LiquidToggle` 的 `dampedDragAnimation.value`）；直接读状态会导致"点一下瞬移"而非弹簧滑动。

---

## 7. 浏览器兼容性

| 能力 | Chromium（Chrome/Edge 76+） | Safari / Firefox |
| --- | --- | --- |
| `backdrop-filter: blur()/saturate()/brightness()` | ✅ | ✅ |
| `backdrop-filter: url(#svg)`（折射） | ✅ | ❌（声明被接受但不绘制） |
| `mix-blend-mode: plus-lighter` | ✅ | ⚠️ 部分/需降级 |

折射（`url()` 进 `backdrop-filter`）是 **Chromium 扩展**。因此调用点**永远保留一条更早的 `blur()` 声明**作为降级；非 Chromium 引擎会忽略 `url()` 而只画模糊。色散能力通过 `isRefractionSupported()` 探测 UA 判断（`userAgentData.brands` 或 UA 正则），因为 `@supports` 在会解析但不绘制的引擎上会误报。

---

## 8. 源码对照表（节选）

| Web | 上游 Kotlin |
| --- | --- |
| `src/core/glass-filter.ts` | `Lens.kt` / `Shaders.kt`（折射、`RoundedRectRefractionShaderString`、`RoundedRectRefractionWithDispersionShaderString`） |
| `src/core/highlight-map.ts` | `HighlightStyle.kt`（AGSL `Ambient/Default` shader） |
| `src/core/backdrop.ts` | `LayerBackdrop` 体系（已退化为 Root/Empty） |
| `src/components/GlassSurface.vue` | Compose `Modifier` 玻璃链 |
| `src/App.vue` | `MainContent.kt` + `BackHandler.kt` |
| `src/core/destinations.ts` | `CatalogDestination` |
| `src/core/animation.ts` | Compose `Animatable` / `InfiniteAnimationPolicy` |

---

## 9. 已知限制与后续方向

- 折射在非 Chromium 浏览器上不可用（已降级为纯模糊）。
- 部分高频滤镜图有 32 张上限的 LRU 缓存（`mapCache`）。
- 站点若用 CSP 限制 `img-src`（不允许 `data:`），`<feImage>` 的位移图会被拒绝且**完全静默**——详见 [§10](#10-用户脚本liquid-glass-refraction)。
- 无头环境（`--dump-dom`）会饿死 `rAF`，弹簧动画只出极少帧——验证动画是否在跑应读 inline transform 是否随时间变化，而非看截图。
- **大面积玻璃当前存在性能问题**：每个玻璃表面都要为 `backdrop-filter` 维护一份独立的滤镜图（SDF → 位移图 → `feImage` + `feDisplacementMap`），捕获与合成开销随表面尺寸和数量线性增长。同屏多块大面积玻璃（如多个底部横条、全尺寸面板）会在中低端设备上明显掉帧；当前不建议在真实产品里铺大面积玻璃，后续方向见上一条（Worker 化位移图生成、跨表面共享）。
- 后续可探索：把 `glass-filter` 的位移图生成移到 Worker、对非 Chromium 增加 WebGL 折射 fallback（若届时允许引入 WebGL）。

---

## 10. 用户脚本（Liquid Glass Refraction）

`src/core/glass-filter.ts` 是**零依赖**模块（整个文件没有一个 `import`），因此被单独提取成了一个可直接安装的用户脚本，用于把**任意网站上的任意元素**变成液态玻璃折射透镜。

### 10.1 绝对路径

发布走本项目既有的 GitHub Pages 工作流，脚本与 Demo 同源同版本，推送到 `main` 即自动同步：

| 用途 | 绝对路径 |
| --- | --- |
| 脚本文件（安装 / `@require` / `@updateURL`） | `https://someonehx.github.io/WebLiquidGlass/liquid-glass-refract.user.js` |
| Demo 站点（部署根） | `https://someonehx.github.io/WebLiquidGlass/` |
| 源码（仓库内，随 Pages 一起发布） | `https://github.com/SomeoneHX/WebLiquidGlass/blob/main/userscript/liquid-glass-refract.user.js` |

> Pages 侧的 `@version` 由 CI 按 workflow run number 自动打版（`0.2.<run_number>`），因此每次推送都会产生一个新版本，安装过的人会在管理器下次检查时自动更新。仓库内的文件保留手写的基础版本号，`scripts/stamp-userscript.mjs` 是两者唯一允许不一致的地方。

### 10.2 三种引入方式

```js
// ① 直接安装（Tampermonkey / Violentmonkey）：打开上面的脚本地址即可，@updateURL 会自动接收更新

// ② 在你自己的用户脚本里 @require 它：
// @require      https://someonehx.github.io/WebLiquidGlass/liquid-glass-refract.user.js
// @grant        none
// 脚本执行后 API 落在 window.LiquidGlassRefract（沙箱模式下用 unsafeWindow 读取）：
const { apply, unglassify } = window.LiquidGlassRefract
apply(document.querySelector('.header'), { blur: 12, refractionAmount: 30 })

// ③ 普通网页里直接用 <script src>：
// <script src="https://someonehx.github.io/WebLiquidGlass/liquid-glass-refract.user.js"></script>
```

脚本**默认不做任何事**（没有配置就不扫描、不修改任何元素），所以 `@require` 进来是安全的；重复引入会被自身的加载守卫忽略，不会重复绑监听。

### 10.3 配置：在执行脚本前赋值 `window.LiquidGlassRefractConfig`

```js
window.LiquidGlassRefractConfig = {
  selectors: ['.header', 'nav'],     // 自动应用的选择器；留空 = 什么都不做
  autoWatch: true,                   // 用 MutationObserver 跟进 SPA 动态插入的节点（rAF 合并）
  hotkeys: { glassify: 'alt+shift+g', unglassify: 'alt+shift+u' },  // 或 false 关闭
  defaults: { blur: 12, refractionHeight: 24 }   // 合并进默认参数
}
```

热键作用于**鼠标当前指向的元素**（`document.elementFromPoint`，不依赖焦点），组合键串支持 `alt` / `shift` / `ctrl` / `meta`。

### 10.4 API

| 方法 | 说明 |
| --- | --- |
| `apply(el, options?)` | 把元素变成玻璃透镜。与 `glassify` 同一函数，公开名用 `apply` |
| `glassify(el, options?)` | 同上。对**同一元素**重复调用 = 更新参数（幂等） |
| `unglassify(el)` | 撤销：恢复此前的 inline 样式、移除 `<filter>`、注销 `ResizeObserver` |
| `applyAll()` | 立即按 `selectors` 扫描一遍，返回本次新应用的元素数组 |
| `isRefractionSupported()` | 引擎探针（Chromium 才行） |
| `createGlassFilter()` | 低层：只拿 SVG 滤镜图（`{ id, update(spec, amount, zoom?, overlay?), dispose() }`），自己写宿主 |
| `activeCount()` | 当前存活的玻璃面数量 |
| `DEFAULTS` / `FILTER_PAD` / `config` / `version` | 默认参数、滤镜外扩内边距（64px）、生效配置、版本号 |

`apply` 的参数：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `blur` / `saturate` / `brightness` | `8` / `1.6` / `1.06` | 与折射同处一条 `backdrop-filter`；也必须靠前者，裸 `url()` 会被 Chromium 静默忽略 |
| `refractionHeight` | `18` | 从边缘向内多深开始弯曲（px） |
| `refractionAmount` | `22` | 边缘最大位移（px），直接进 `feDisplacementMap@scale` |
| `depthEffect` | `true` | 把向心方向混进弯折梯度 |
| `chromaticAberration` | `false` | 三分支色散：3 张位移图 + 11 段滤镜图 |
| `maxArea` | `490000` | 面积上限，超过则跳过并 warn（SDF 逐像素逐分支，大元素会卡主线程） |

### 10.5 使用前须知

- **必须自己给 tint**：脚本不改元素自身样式，元素需要有半透明背景（如 `background: rgba(255,255,255,.16)`），否则只有透镜没有磨砂色；
- **形状即 `border-radius`**：圆角从 computed style 读取，想要胶囊就写 `border-radius: 50%` 或大圆角，位移图按同一几何生成；
- **仅 Chromium**：Safari / Firefox 会把带 `url()` 的整条声明丢掉，脚本对这类引擎只写纯模糊；
- **CSP 是硬门槛**：页面若限制 `img-src` 不允许 `data:`，位移图会被拒且不报错（每个 `<feImage>` 触发一次 `securitypolicyviolation`，但控制台不会有任何报错），脚本用 1×1 PNG 探针检出后整体降级为纯磨砂并 `console.warn` 原因。**被拒时最终上屏结果与纯 `blur()` 控制组逐像素相同**（实测 0 px / 57600），所以损失的是"透镜"本身与那份被浪费的 SDF/PNG 计算，而不是画面画错；哪些站点会命中见 [§10.8](#108-实测真实站点的-csp-分布)；
- **祖先元素会截断 backdrop**：任何带 `filter` / `opacity < 1` / `mask` 的祖先都会成为 backdrop root，玻璃只能采到它内部的内容；
- **静态透镜**：这是从 `GlassSurface` 抽出的**滤镜层**，不含投影 / 高光 / 按压高光 / 形变 / 手势 / 动画驱动，强度变化需要调用方自己重设参数。

### 10.6 生成、校验与发布

```bash
npm run check:userscript    # node --check 语法校验
npm run stage:userscript    # 本地按 CI 的方式打版输出到 dist/liquid-glass-refract.user.js
npm run dev                 # 浏览器里验证（把脚本粘进测试页即可，见下）
```

重新生成（若上游 `src/core/glass-filter.ts` 改动）——用项目自带 tsc 剥类型，**不要手抄算法**：

```bash
./node_modules/.bin/tsc src/core/glass-filter.ts --target es2022 --module esnext --outDir /tmp/strip
```

后处理只有两步：去掉**行首**的 `export ` 前缀（旧版恰好 3 处：`FILTER_PAD` / `isRefractionSupported` / `createGlassFilter`），以及下面那一行 `svgRoot()`。

**定位第 1 段不要写死行号**，用与探针相同的标记：从 `/** SVG refraction filter for` 之前最近的 `/*`，到 `* 2. Userscript host` 之前最近的 `/*`。拼接前先断言"旧块 == 对 HEAD 跑一遍同样流程的结果"，不等就拒绝写入——变换一旦有多余或遗漏，第一步就被拦下。

改完必须跑：`npm run check:userscript` + `npm run probe:band` + `npm run probe:render`。

⚠️ **核心不许依赖 `ctx.canvas`**：`probe:map` 会在 Node 里用一套假 DOM 求值第 1 段，其假 canvas 的 `getContext()` 只提供 `createImageData` / `putImageData`，**没有 `canvas` 反向引用**。曾经为了复用画布写成 `ctx.canvas.toDataURL(...)`，直接把 `npm run probe:map` 打挂（`TypeError: ... reading 'toDataURL'`）。正确做法是让 helper 返回**元素本身**，而不是绕道 `ctx`。

脚本内只有**一行**与提取源不同：`svgRoot()` 里 `document.body || document.documentElement`，以便在 `<body>` 存在之前执行（`@require` 就是这种情况）。

### 10.7 实测数据（无头 Chromium，320×180 / r=28 / refractionHeight=22）

| 项 | 结果 |
| --- | --- |
| 滤镜图 | 11 个 primitive，`scale 94.9 ｜ 52 ｜ 94.9`，`filterUnits=userSpaceOnUse`、`color-interpolation-filters=sRGB` |
| 位移图 | 448×308（= 元素 + `FILTER_PAD`×2），rim 17328 / 137984 px，最大偏差 111/127，`data:` URL ≈23 KB |
| 折射是否上屏 | 仅把 `refractionAmount` 从 0 改到 34：11995 px 不同、maxdelta 77、差异 bbox 恰为元素框；差异**全在 inset ≤ 19px**，≥20px 深 0 px、框外 0 px |
| CSP `img-src 'none'` | 位移图被拒（`securitypolicyviolation: img-src`，每个 map 一次），`refractionAmount` 0→30 **0 px 差异**；与同页纯 `blur()` 控制组相比 **0 px / 57600**，即"只剩磨砂、没有透镜" |
| 引入幂等 | 同一页引入两次：只有 1 个 `<filter>`、热键日志只出现 1 次 |
| SPA 跟进 | `autoWatch: true` 下动态插入的匹配节点在一个 rAF 后自动上玻璃 |

---

### 10.8 实测：真实站点的 CSP 分布

2026-09-12 抽查约 70 个站点的根路径响应头，并在其中 4 个站点上用真实浏览器跑了脚本同款探针（`new Image()` + 1×1 `data:` PNG）：

| 情况 | 站点（节选） | 透镜 |
| --- | --- | --- |
| `img-src` 不含 `data:` | **stackoverflow.com** / serverfault.com / superuser.com（均为 `img-src 'self' https://challenges.cloudflare.com`）、**pypi.org** | ❌ 静默降级 |
| `img-src` 含 `data:` | github.com（`img-src 'self' data: blob: …`）、gitlab.com、linear.app、vercel.com、nextjs.org（`img-src * blob: data:`）、apple.com、www.icloud.com、atlassian.com、stripe.com、docs.qq.com、store.steampowered.com | ✅ |
| 根路径无 CSP 头 | developer.mozilla.org、news.ycombinator.com、google.com / youtube.com、x.com、reddit.com、npmjs.com、claude.ai、chatgpt.com、figma.com、notion.so、zhihu.com、bilibili.com、taobao.com、jd.com、weibo.com、douyin.com、slack.com、discord.com、twitch.tv、wikipedia.org | ✅ |

真站探针结果（浏览器内实测）：`stackoverflow.com` → `data: 被拒`、`pypi.org` → `data: 被拒`、`github.com` → `data: 可加载`、`developer.mozilla.org` → `data: 可加载`——与头部结论一致。

三点判读说明：

- **`default-src` 是 `img-src` 的兜底**：只写 `default-src 'self'` 而没写 `img-src` 的页面同样会拒；反之 `github.com` 写着 `default-src 'none'` 却因为显式 `img-src … data: …` 而放行。
- 上表只看**根路径响应头**。`<meta http-equiv="Content-Security-Policy">` 形式、只对部分子路径下发的 CSP、以及 SPA 路由切换后新增的策略都看不到——**以脚本自己的探针为准**（它就在真实页面上跑）。
- 命中时的表现是"磨砂正常、透镜没有"，不会画错也不会报错；判断依据只有一个：位移图那张 `data:` PNG 能不能被解码。

### 10.9 位移的零点与量化：为什么中性值是 128 而不是 127.5

`feDisplacementMap` 的偏移是 `scale × (value/255 − 0.5)`，精确零点落在 **127.5**，8 位通道表达不了它。写 128 时整幅位移图带一个常数项 **+0.5 LSB = +`scale/510` px**，取样方向朝 (+x, +y)，看起来就是透镜里的内容（含背景）整体往左上偏。Skia 的光栅实现就是这条式子（`src/effects/imagefilters/SkDisplacementMapImageFilter.cpp`）：

```cpp
const SkVector scaleForColor = SkVector::Make(scale.fX * Inv8bit, scale.fY * Inv8bit);
const SkVector scaleAdj = SkVector::Make(SK_ScalarHalf - scale.fX * SK_ScalarHalf, ...);
SkScalar displX = scaleForColor.fX * ex.getX(*displPtr) + scaleAdj.fX;  // = scale × (v/255 − 0.5) + 0.5
const int srcX = x + SkScalarTruncToInt(displX);                        // 截断 + 整数取样
```

**但它落不到屏上。** 线性渐变背景 + 2.4 万像素平均（位移分辨率 ≈0.02 px）实测本仓库脚本（`scale = 2 × amount`）：

| amount | ≤126 | 127 | 128 … 382 | 383 … |
| --- | --- | --- | --- | --- |
| 常数项（理论） | ≤0.494 | 0.498 | 0.502 … 1.498 | 1.502 … |
| 实测位移 | **0.000 px** | 0.63 px（刀口，仅部分像素） | **1.01 px** | **2.02 px** |

台阶步长 255（按 scale 折算 510），且同一台阶内的截图**逐字节相同**（scale 255 与 764 渲染一致，765 起跳到 2 px）——渲染结果是**整像素阶梯**，不是随 amount 线性增长的亚像素漂移。两条独立证据说明这条链没有插值：1 px 棋盘背景在任何 scale 下对比度都不变（std 110.42 / p2p 255）；整数位移的截图逐字节相同。亚像素量级的残差落不了屏——但**"落不了屏"不等于"偏移看不见"**：`amount ≤ 126` 时透镜内部与背景逐像素相同，`amount` 越过 127 之后**整个内部会整体平移 1 个整像素并从此保持**。目录里没有任何组件能到这个量级，**游乐场能**——见 §10.11。

**因此没有采用"抖动中性点"的修法**（在 127/128 之间棋盘抖动，让均值落在 127.5）。实测：

| 配置 | 均值位移 | 奇 / 偶像素 |
| --- | --- | --- |
| 纯 128 @ scale 255 | +1.00 px | 均匀（+1.00 / +1.00） |
| 抖动 127/128 @ scale 255 | +0.50 px | 偶 **0** / 奇 **+1.00** —— 只抵消一半 |
| 抖动 127/128 @ scale 510 | −0.003 px | 偶 **−1.00** / 奇 **+1.00** —— 均值归零，代价是全场 ±1 px 棋盘 |

即抖动把"看不见的整像素偏移"换成"逐像素 ±1 px 取样抖动"，而落点正是**玻璃内部**——那里本该是严格恒等，是整块玻璃最不该出现噪声的地方。另外 `clampByte` 是 `Math.round`（round-half-up），写成 `clampByte(128 + (±0.5))` 得到的是 {128, 129}、均值 **128.5**：实测偏置翻倍（scale 510 下 1.999 px vs 0.999 px）。真要抖动，基数必须是 `127.5`。

> 一个比零点项重要得多的保真度事实：本环境下 Chromium 把位移**量化到整像素、取样不插值**，而 Android 原版的 AGSL 是在浮点坐标上取样的——`float2 refractedCoord = coord + d * grad; return content.eval(refractedCoord);`（`backdrop/src/commonMain/kotlin/com/kyant/backdrop/internal/Shaders.kt` 的 `RoundedRectRefractionShaderString`）。原版既无零点偏差、位移场也是连续的；web 端受光栅器限制只能整像素跳。这才是这次移植的真实保真度上限，与 0.5 LSB 的零点项无关。（§10.10 的探针把这条从"本环境如此"坐实为**真 GPU 上同样如此**：headless 走的是 ANGLE Metal / AMD Radeon RX 570，不是软件光栅器。）

### 10.10 复现测量：量化口径是 1 设备像素，坑口高度 = `amount × √(2/bezel)`

上一节的结论可以用 `scripts/refraction-probe.mjs` 一条命令复现，它不加任何依赖（CDP 走内置 `WebSocket`，PNG 用内置 `zlib` 解），并且**直接求值已提交的用户脚本里那段核心**，不复制第二份实现：

```bash
node scripts/refraction-probe.mjs map                    # 编码层：位移图的 8 位阶梯 + 各目录参数下的整数偏移阶梯
node scripts/refraction-probe.mjs render --dpr=1         # 采样层：真实 Chromium，相位标尺测出 s(x)
node scripts/refraction-probe.mjs render --dpr=2         # 同一页面在 2 倍密度下
node scripts/refraction-probe.mjs render --bg=checker --blur=1   # 位移前 blur 对边缘接缝的 A/B
```

采样层把背景换成按设备像素线性上升的"标尺"（`(3x) mod 256`，斜率处处恰为整数级/设备像素；相位逐行错开，锯齿复位列由逐列中位数丢掉），于是每个输出列的取样位置都能反解出来。`amount = 32, refractionHeight = 18` 实测：

| dpr | 沿边框向内的整数偏移（设备 px，每项是段起点） | 段数 | 相邻最大跳 |
| --- | --- | --- | --- |
| 1 | 32@0 21@1 17@2 14@3 12@4 10@5 8@6 7@7 5@8 4@9 3@10 2@12 1@13 0@16 | 14 | **11.00 px = 11.00 CSS px** |
| 2 | 48 59 48 41 37 33 30 28 25 23 21 19 17 16 14 13 11 10 9 8 7 6 5 4 3 2 1 0 | 28 | **11.00 px = 5.50 CSS px** |

每一段都**精确**落在整数设备像素上（残差 0.000 px；`amount = 0` 时全图零位移且与无透镜参考逐像素一致），即取样被舍入到整数设备像素，而非插值。**段数与 `amount × dpr` 一起翻倍、每段跳幅随之减半**——这是高密度屏唯一的"免费"改善。dpr 2 的头三列（48 / 59 / 48）不是平台段：位移图本身是 **CSS 像素**分辨率的位图，在非整数缩放下被双线性放大，坑口会被抹到最外约 2 个设备列上；dpr 1 时图与设备栅格对齐，所以最外一列读到的是干净的 `amount`。

边框高度是唯一能压坑口的几何旋钮（`amount = 32`，实测首跳 = 平台段数）：

| refractionHeight | 6 | 12 | 18 | 24 | 48 |
| --- | --- | --- | --- | --- | --- |
| 首跳（实测） | 18.00 | 13.00 | 11.00 | 9.00 | 7.00 |
| 段数（实测） | 7 | 11 | 14 | 17 | 19 |
| `amount·√(2/bezel)` | 18.5 | 12.8 | 10.5 | 9.1 | 6.5 |

因为 `circleMap` 的 `1−√(1−t²)` 在 `t→1` 处斜率无穷，最外一列取样点必然吃到**整个** `amount`，紧邻一列只吃到 `falloff(−1) = 1−√(2/bezel − 1/bezel²)`——两者之差就是坑口。这条在原版 AGSL 里同样存在（连续取样也只是把两个相距 `amount` 的取样点连起来），所以**它不是 web 的误差，是 `Shaders.kt` 的设计**。`refractionHeight` 是 1:1 照搬 Kotlin 的参数，改它属于有意偏离原版。

位移前的 `blur` 是唯一不碰几何、却能降低可见度的杠杆。1 设备像素棋盘背景、`amount = 14/32`，量边缘一列与外侧相邻一列的对比度：

| 位移前 blur | 0 px | 0.5 px | 1 px | 2 px | 4 px |
| --- | --- | --- | --- | --- | --- |
| 边缘接缝对比度（级） | 127.5 | 84.8 | 64.0 | 64.0 | 64.0 |
| 透镜外部的背景纹理（对照） | 255.0 | 255.0 | 255.0 | 255.0 | 255.0 |

外面那行是不变量：`blur` 只作用于元素**背后**的背景，透镜外的棋盘纹理始终满对比。所以 1 px 就能拿到大部分收益、再往上饱和——这与目录里三个动画部件的写法正好相反：`LiquidToggle` / `LiquidSlider` 是 `blur(dp(8) × (1 − progress))`，**按下到最深处时 blur 归零、透镜同时最强**，恰好落在最差的一格。

### 10.11 游乐场里能看见的那个整像素：中性 128 的偏置什么时候才够得着

§10.9 一度写过"`amount ≤ 126` 时透镜内部逐像素不变（默认 22 就是整个可用范围）"——**这句只对目录成立，游乐场不成立**。`GlassPlaygroundContent` 的旋钮是 `refractionAmountFraction × minDimension`，hero 卡是 `256 × 256`，所以 `amount` 一路到 **256**，`scale = 2 × amount` 在 **fraction 0.5** 就跨过 255 这条刀口。于是那个"落不了屏"的偏置，在游乐场里是**看得见的**：

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

`sample offset` 是"这个输出像素从哪读"，所以**内容往 (−1, −1) 跑，即左上**；`rms 0.00` 表示透镜内部与"整体平移 1 px 后的背景"**逐字节相同**——不是模糊、不是插值，是刚性整像素搬运。刀口在 `amount 127` 与 `382`（实测比理想的 127.5 / 382.5 早一个通道，属光栅器自己的取整，量级 0.002 LSB）。把它压成画像：`amount 0` 时 3×3 全格 `(0,0) rms 0.0`；`amount 128` 时**内部四格全变 `(1,1) rms 0.0`**，只有贴边的格子 `rms 80–90`（那里位移场本身在变，"刚性平移"没有意义）。

所以"看起来是平滑的"和"算术上是整像素"可以同时成立：整个滑块行程里只有 **0 → 1 → 2 三个状态**，而**整体一起跳 1 px 是看不出台阶的**——尤其在你正拖着滑块的时候。真正在"越拉越偏"的那种连续感，来自边框带（rms 80–90 的那些格子），那圈内容被往外推、幅度随 `amount` 线性增长，右下角那一侧看起来就是往右下角被拽。

| 修法 | 实测结果 | 取舍 |
| --- | --- | --- |
| **B 通道当遮罩**：把"边框/内部"编进没用到的 B，`feColorMatrix` 取 alpha + `feComposite in` 切出边框 + `feComposite over` 压回 `SourceGraphic` | 内部在**任意** `amount` 下逐像素恒等 | 每个表面多 3 个原语；改动落在 `glass-filter.ts` 的图构建里 |
| `feOffset` 反向补偿（§10.9 提过的备选） | **否决**。`bias = 1.0000` 时确实抵消（rms 0.00）；`bias = 0.502` 时残留 0.5 px 且内部被插值成相邻像素的 50/50 混合（噪声背景下 rms **69/255**） | 拿"1 px 整跳"换"0.5 px 模糊"，不值；但它证明了一件有用的事——**`feOffset` 是这条链里唯一能亚像素定位的原语** |
| 把 `refractionAmount` 夹到 `2·amount·vmax < 255` | 内部恒定，一行改动 | 等于给游乐场的探索范围封顶 |

### 10.12 回归验证：`probe:band` 与 `probe:fidelity`

§10.10 / §10.11 的两条口径回答"折射**看起来**是什么"，这一节的两条回答"**改动有没有偷偷改变它**"。加它们的原因很直接：`glass-filter.ts` 里所有"同输出、少做事"的优化——只扫描边缘带的位移图、跳过同值写入、滚动时不重绘装饰画布——都是关于**等价性**的断言，而没有任何一张截图能证明它们。

```bash
npm run probe:band        # 纯 Node、零依赖、不需要浏览器也不需要 dev server；可直接当 CI 门禁
npm run probe:fidelity    # 需要先 `npm run dev`；13 个目的地 × 7 个字段的渲染指纹
```

**`band`**：`buildMap` 不再遍历整个 padded 区域，只走它的 SDF 边界允许的行列。这条边界是**推理**的产物，而推理会错——带取窄了就会静默丢掉真实边缘像素，折射微妙地失真，而仓库里其它任何东西都发现不了（图照编、滤镜照跑、测试照过）。所以它拿一个**全扫描**做对照：`sdf` / `gradSdf` / `clampByte` 都取自已提交的核心（由 `loadCore` 暴露），即**只重述被测试的那部分——循环结构**，不重述数学。中性灰也一样，是**从已提交的位图里读回来**的，不是另写一遍常量，所以改了中性值也不会让两边在错误答案上"达成一致"。

12 种几何 × 光谱分支逐字节比对。两个历史上的真 bug 都写进了脚本注释，也正是这个检查抓出来的：

| 错误 | 后果 |
| --- | --- |
| 用 `d ≥ max(qx,qy) − r` 当下界 | 该不等式成立，但推不出 `max ≥ r − bezel` → **漏掉圆角外侧的对角线** |
| 右边界用排他上界 `to = w` | `x = w` 处 `d` 恰为 0，而 0 在边缘测试之内 → **漏掉最后一列** |

把第二条重新注回脚本，`band` 立刻报 `NO` 并指出首个差异像素是 `x = 1408, y = 32`——测试有效，且能定位。

**`fidelity`**：对 13 个目的地采 7 个字段——`feImage` 的 href 哈希、图元盒、`feDisplacementMap[scale]`、`<filter>` 区域、lens 计算样式、装饰画布的 CSS 盒 + transform + blend + display、表面数。先记录，改一处，再比对：

```bash
node scripts/refraction-probe.mjs fidelity --write=/tmp/base.json
# ...改一处...
node scripts/refraction-probe.mjs fidelity --baseline=/tmp/base.json   # 有不一致则 exit 1
```

两条诚实的边界：

- 它是 **A/B 工具而非门禁**。指纹覆盖位移图的**字节**，同一构建重复跑完全一致（已验证），但它绑在渲染器版本上——浏览器升级后合理变化。所以用法是"记录基线 → 改一处 → 比对"，不是在 CI 里当恒定断言。
- 画布字段**不含 `canvas.width/height`**。那两个值是**剔除状态**：视口外的面已释放 backing store，而采样瞬间哪些面在视口外取决于帧循环跑到哪里——这被实测到过：同一构建两次运行，102 面的那一页报了不一致。CSS 盒、transform、blend、display 由布局决定、不随剔除移动，所以它们能抓到合成变化而不会连时钟一起抓。活跃画布数作为信息单独打印，**不参与比对**。

`fidelity` 每个目的地起一个**全新浏览器**：复用同一个标签页会在第三、四个页面之后让渲染进程彻底停止应答 `Runtime.evaluate`（手工挂载/卸载几个玻璃页也能复现）。冷启动两秒，相对一页指纹可以忽略。某个目的地失败会被记录、跳过，并让退出码非零——**跳过的目的地不算通过**。

---

## ⚠️ 已知 Bug（当前构建）

以下组件在当前构建中**已知存在问题**，其玻璃形变 / 捕获合成尚未达到与原版一致的像素级正确度，**请勿用于生产或依赖其表现**：

- **Toggle（开关，`LiquidToggle`）** —— 拇指玻璃的形变（`innerTransform` 的 squash + 速度倾斜）与"按压缩小轨道层"的挖洞合成（`trackInnerTransform` + `trackClipPath`）是全目录最复杂的玻璃效果之一。该组件的缩放轨道层曾被误判"纯色缩放不变"而整体丢弃，当前虽已重做，但**仍被标记为存在 bug**，表现可能偏离原版（如按压时轨道缩放 / 挖洞错位）。

> 该组件是后续重点修复对象。

---

## 🚧 尚未完成（当前构建）

以下组件在当前构建中**尚未完成**（关键逻辑缺失或仅搭出骨架），玻璃效果与原版差距较大，**请勿依赖其表现**：

- **Lock screen / 时钟（`LockScreenContent`）** —— 锁屏可拖拽的 SDF 时钟盘。原版的时钟纹理依赖 `clock_sdf` 资源与 `SdfShader`，当前移植已移除 SDF 相关能力，时钟盘尚未实现完整效果。
- **Magnifier / 放大镜（`MagnifierContent`）** —— 段落上方可拖拽的透镜，依赖 backdrop 缩放 + 折射链，当前实现尚未完成，透镜的缩放采样与折射合成未达原版表现。
