# WebLiquidGlass

> 一个把 Android `Kyant0/AndroidLiquidGlass`（Liquid Glass / Backdrop）的 **Web Liquid Glass** 移植到 Web 的项目。

英文文档见 [`README.en.md`](./README.en.md)。

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
        ├── BottomTabsContent.vue    # 底部标签栏（accent 条叠加捕获）
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
- 无头环境（`--dump-dom`）会饿死 `rAF`，弹簧动画只出极少帧——验证动画是否在跑应读 inline transform 是否随时间变化，而非看截图。
- 后续可探索：把 `glass-filter` 的位移图生成移到 Worker、对非 Chromium 增加 WebGL 折射 fallback（若届时允许引入 WebGL）。

---

## ⚠️ 已知 Bug（当前构建）

以下组件在当前构建中**已知存在问题**，其玻璃形变 / 捕获合成尚未达到与原版一致的像素级正确度，**请勿用于生产或依赖其表现**：

- **Toggle（开关，`LiquidToggle`）** —— 拇指玻璃的形变（`innerTransform` 的 squash + 速度倾斜）与"按压缩小轨道层"的挖洞合成（`trackInnerTransform` + `trackClipPath`）是全目录最复杂的玻璃效果之一。该组件的缩放轨道层曾被误判"纯色缩放不变"而整体丢弃，当前虽已重做，但**仍被标记为存在 bug**，表现可能偏离原版（如按压时轨道缩放 / 挖洞错位）。
- **Bottom Tabs（底部标签栏，`LiquidBottomTabs`）** —— 指示器胶囊通过 `captureOverlay` 把隐藏的 accent 行快照合成进玻璃捕获，并用 evenodd 黑行挖洞（`blackRowClip`）避免黑色字形透出。这套"捕获 + 裁剪"合成链路很脆弱，**当前实现被标记为存在 bug**，可能出现 accent 内容错位或黑行穿帮。

> 这两个组件是后续重点修复对象。

---

## 🚧 尚未完成（当前构建）

以下组件在当前构建中**尚未完成**（关键逻辑缺失或仅搭出骨架），玻璃效果与原版差距较大，**请勿依赖其表现**：

- **Lock screen / 时钟（`LockScreenContent`）** —— 锁屏可拖拽的 SDF 时钟盘。原版的时钟纹理依赖 `clock_sdf` 资源与 `SdfShader`，当前移植已移除 SDF 相关能力，时钟盘尚未实现完整效果。
- **Magnifier / 放大镜（`MagnifierContent`）** —— 段落上方可拖拽的透镜，依赖 backdrop 缩放 + 折射链，当前实现尚未完成，透镜的缩放采样与折射合成未达原版表现。
